/**
 * ============================================================================
 * Authentication & Password Encryption Service
 * ============================================================================
 * Handles user authentication, registration, session state, and cryptographic
 * password hashing using Node.js built-in `crypto.scryptSync` + random 16-byte salt.
 *
 * Password storage format: `<16-byte-hex-salt>:<64-byte-hex-hash>`
 * Comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
 */

const crypto = require('crypto');
const sqliteDb = require('./sqliteDatabase');
const appSettings = require('./appSettings');

let currentSessionUser = null;

/**
 * Hashes a plaintext password using a cryptographically secure random salt and scrypt.
 * @param {string} password
 * @returns {string} Salted hash string in format `<salt>:<hash>`
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plaintext password against a stored `<salt>:<hash>` string.
 * @param {string} candidatePassword
 * @param {string} storedHash
 * @returns {boolean}
 */
function verifyPassword(candidatePassword, storedHash) {
  try {
    if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
      return false;
    }
    const [salt, key] = storedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(String(candidatePassword), salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch (err) {
    console.error('Password verification error:', err.message);
    return false;
  }
}

/**
 * Validates email string format.
 */
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email || '').trim().toLowerCase());
}

/**
 * Registers a new user account with encrypted password storage.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.email
 * @param {string} params.password
 * @returns {Promise<{ ok: boolean, user?: Object, error?: string }>}
 */
async function registerUser({ username, email, password }) {
  const cleanUser = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');

  if (!cleanUser || cleanUser.length < 3) {
    return { ok: false, error: 'Username must be at least 3 characters long.' };
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (!cleanPass || cleanPass.length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters long.' };
  }

  // Check uniqueness
  const existingUser = await sqliteDb.getUserByUsername(cleanUser);
  if (existingUser) {
    return { ok: false, error: `Username '${cleanUser}' is already taken.` };
  }

  const existingEmail = await sqliteDb.getUserByEmail(cleanEmail);
  if (existingEmail) {
    return { ok: false, error: `Email '${cleanEmail}' is already registered.` };
  }

  const passwordHash = hashPassword(cleanPass);
  const isRootAdmin = cleanUser.toLowerCase() === 'admin';
  const role = isRootAdmin ? 'admin' : 'user';
  const canDeleteAll = isRootAdmin ? 1 : 0;
  const canModifyInventory = 1;

  const result = await sqliteDb.createUser({
    username: cleanUser,
    email: cleanEmail,
    passwordHash,
    role,
    canDeleteAll,
    canModifyInventory
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to create user account.' };
  }

  // Push new user to MySQL online if configured and online
  try {
    const mysqlClient = require('./mysqlClient');
    const cfg = mysqlClient.loadConfig();
    if (cfg && cfg.enabled) {
      const check = await mysqlClient.testConnection();
      if (check.online) {
        await mysqlClient.pushUserToRemote({
          username: cleanUser,
          email: cleanEmail,
          passwordHash,
          role,
          canDeleteAll,
          canModifyInventory,
          canManageDatabase: isRootAdmin ? 1 : 0
        });
      }
    }
  } catch (mysqlErr) {
    console.warn('MySQL user registration push notice:', mysqlErr.message);
  }

  currentSessionUser = {
    username: cleanUser,
    email: cleanEmail,
    role,
    canDeleteAll: Boolean(canDeleteAll),
    canModifyInventory: Boolean(canModifyInventory),
    lastLogin: null,
    lastFailedLogin: null
  };

  return { ok: true, user: currentSessionUser };
}

/**
 * Authenticates a user, tracks last_login on success and last_failed_login on failure.
 *
 * @param {Object} params
 * @param {string} params.username Username or Email
 * @param {string} params.password
 * @returns {Promise<{ ok: boolean, user?: Object, error?: string }>}
 */
async function loginUser({ username, password }) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');

  if (!cleanUser) {
    return { ok: false, error: 'Please enter your username or email.' };
  }
  if (!cleanPass) {
    return { ok: false, error: 'Please enter your password.' };
  }

  // Lookup by username or email
  let user = await sqliteDb.getUserByUsername(cleanUser);
  if (!user && cleanUser.includes('@')) {
    user = await sqliteDb.getUserByEmail(cleanUser);
  }

  // If account not found in local SQLite, check if it exists in remote MySQL (e.g. after rebuild / fresh database)
  if (!user) {
    try {
      const mysqlClient = require('./mysqlClient');
      const cfg = mysqlClient.loadConfig();
      if (cfg && cfg.enabled) {
        const check = await mysqlClient.testConnection();
        if (check.online) {
          const remUser = await mysqlClient.fetchRemoteUser(cleanUser);
          if (remUser) {
            await sqliteDb.saveUserFromRemote(remUser);
            user = await sqliteDb.getUserByUsername(remUser.username);
          }
        }
      }
    } catch (remErr) {
      console.warn('Remote MySQL user fetch notice:', remErr.message);
    }
  }

  if (!user) {
    return { ok: false, error: 'Account not found. Please check your username or register.' };
  }

  const isMatch = verifyPassword(cleanPass, user.passwordHash);
  if (!isMatch) {
    // Log failed attempt timestamp in database
    await sqliteDb.updateUserLoginFailure(user.username);
    return { ok: false, error: 'Incorrect password. Failed attempt logged in database.' };
  }

  // Preserve previous login timestamps to display to user upon login
  const previousLastLogin = user.lastLogin;
  const previousLastFailed = user.lastFailedLogin;

  // Update success timestamp in database
  await sqliteDb.updateUserLoginSuccess(user.username);

  const isRootAdmin = String(user.username).toLowerCase() === 'admin';
  const userRole = isRootAdmin ? 'admin' : (user.role || 'user');
  const canDeleteAll = isRootAdmin ? true : Boolean(user.canDeleteAll);
  const canModifyInventory = isRootAdmin ? true : Boolean(user.canModifyInventory ?? 1);
  const canManageDatabase = isRootAdmin ? true : Boolean(user.canManageDatabase);

  currentSessionUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: userRole,
    canDeleteAll,
    canModifyInventory,
    canManageDatabase,
    lastLogin: previousLastLogin,
    lastFailedLogin: previousLastFailed
  };

  const settings = appSettings.loadSettings();
  if (settings && settings.autoLogin) {
    appSettings.saveSettings({ autoLoginUsername: user.username });
  }

  return { ok: true, user: currentSessionUser };
}

/**
 * Returns the currently authenticated user in this session, or restores auto-login if enabled.
 */
async function getCurrentUser() {
  if (currentSessionUser) {
    return currentSessionUser;
  }
  const settings = appSettings.loadSettings();
  if (settings && settings.autoLogin && settings.autoLoginUsername) {
    const user = await sqliteDb.getUserByUsername(settings.autoLoginUsername);
    if (user) {
      const isRootAdmin = String(user.username).toLowerCase() === 'admin';
      const userRole = isRootAdmin ? 'admin' : (user.role || 'user');
      const canDeleteAll = isRootAdmin ? true : Boolean(user.canDeleteAll);
      const canModifyInventory = isRootAdmin ? true : Boolean(user.canModifyInventory ?? 1);
      const canManageDatabase = isRootAdmin ? true : Boolean(user.canManageDatabase);

      currentSessionUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: userRole,
        canDeleteAll,
        canModifyInventory,
        canManageDatabase,
        lastLogin: user.lastLogin,
        lastFailedLogin: user.lastFailedLogin
      };
      await sqliteDb.updateUserLoginSuccess(user.username);
      return currentSessionUser;
    }
  }
  return null;
}

/**
 * Synchronously returns the currently cached session user, or null if not yet authenticated.
 */
function getCurrentUserSync() {
  return currentSessionUser;
}

/**
 * Clears current session user on logout and disables auto-login.
 */
function logoutUser() {
  currentSessionUser = null;
  appSettings.saveSettings({ autoLogin: false, autoLoginUsername: '' });
  return { ok: true };
}

/**
 * Ensures the default Administrator account (admin / 1234) exists in the database.
 */
async function ensureAdminUser() {
  try {
    const existing = await sqliteDb.getUserByUsername('admin');
    if (!existing) {
      const passwordHash = hashPassword('1234');
      await sqliteDb.createUser({
        username: 'admin',
        email: 'admin@lab.local',
        passwordHash,
        role: 'admin',
        canDeleteAll: 1,
        canModifyInventory: 1,
        canManageDatabase: 1
      });
      console.log('Seeded default administrator account (admin / 1234).');
    } else {
      const isMatch = verifyPassword('1234', existing.passwordHash);
      if (!isMatch) {
        const passwordHash = hashPassword('1234');
        await sqliteDb.updateUserPassword('admin', passwordHash);
      }
      await sqliteDb.updateUserPermissions('admin', {
        role: 'admin',
        canDeleteAll: 1,
        canModifyInventory: 1,
        canManageDatabase: 1
      });
    }
  } catch (err) {
    console.warn('Notice ensuring admin account:', err.message);
  }
}

/**
 * Returns all users if the currently authenticated user is an administrator.
 */
async function getAllUsers() {
  const user = await getCurrentUser();
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  if (!isAdmin) {
    return { ok: false, error: 'Unauthorized: Only administrator can view user permissions.' };
  }
  const users = await sqliteDb.getAllUsers();
  return { ok: true, users };
}

/**
 * Updates permissions for a specific user.
 */
async function updateUserPermissions({ targetUsername, permissions } = {}) {
  const user = await getCurrentUser();
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  if (!isAdmin) {
    return { ok: false, error: 'Unauthorized: Only administrator can modify user permissions.' };
  }
  if (!targetUsername) {
    return { ok: false, error: 'Target username is required.' };
  }

  const res = await sqliteDb.updateUserPermissions(targetUsername, permissions);
  if (res.ok && currentSessionUser && currentSessionUser.username.toLowerCase() === targetUsername.toLowerCase()) {
    currentSessionUser.role = res.user.role;
    currentSessionUser.canDeleteAll = Boolean(res.user.canDeleteAll);
    currentSessionUser.canModifyInventory = Boolean(res.user.canModifyInventory);
    currentSessionUser.canManageDatabase = Boolean(res.user.canManageDatabase);
  }

  if (res.ok) {
    try {
      const mysqlClient = require('./mysqlClient');
      const cfg = mysqlClient.loadConfig();
      if (cfg && cfg.enabled) {
        const fullUser = await sqliteDb.getUserByUsername(targetUsername);
        if (fullUser) {
          await mysqlClient.pushUserToRemote(fullUser);
        }
      }
    } catch (pushErr) {
      console.warn('MySQL permission push notice:', pushErr.message);
    }
  }

  return res;
}

/**
 * Updates a user's email address after verifying their current password against the database.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.newEmail
 * @param {string} params.currentPassword
 * @returns {Promise<{ ok: boolean, email?: string, error?: string }>}
 */
async function changeUserEmail({ username, newEmail, currentPassword }) {
  let cleanUser = String(username || '').trim();
  if (!cleanUser && currentSessionUser) {
    cleanUser = currentSessionUser.username;
  }

  const cleanEmail = String(newEmail || '').trim().toLowerCase();
  const cleanPass = String(currentPassword || '');

  if (!cleanUser) {
    return { ok: false, error: 'Please sign into your account first.' };
  }
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (!cleanPass) {
    return { ok: false, error: 'Please enter your current password to verify your identity.' };
  }

  // 1. Check user exists in database
  const user = await sqliteDb.getUserByUsername(cleanUser);
  if (!user) {
    return { ok: false, error: 'User account not found in database.' };
  }

  if (user.email.toLowerCase() === cleanEmail) {
    return { ok: false, error: 'The new email address matches your current email.' };
  }

  // 2. Check if new email is taken by another account
  const existingWithEmail = await sqliteDb.getUserByEmail(cleanEmail);
  if (existingWithEmail && existingWithEmail.username.toLowerCase() !== cleanUser.toLowerCase()) {
    return { ok: false, error: `Email '${cleanEmail}' is already registered to another account.` };
  }

  // 3. Verify current password against encrypted hash in database
  const isMatch = verifyPassword(cleanPass, user.passwordHash);
  if (!isMatch) {
    return { ok: false, error: 'Incorrect current password. Verification with database failed.' };
  }

  // 4. Update in database
  const updateRes = await sqliteDb.updateUserEmail(cleanUser, cleanEmail);
  if (!updateRes.ok) {
    return { ok: false, error: updateRes.error || 'Failed to update email address in database.' };
  }

  if (currentSessionUser && currentSessionUser.username.toLowerCase() === cleanUser.toLowerCase()) {
    currentSessionUser.email = cleanEmail;
  }

  try {
    const mysqlClient = require('./mysqlClient');
    const cfg = mysqlClient.loadConfig();
    if (cfg && cfg.enabled) {
      const fullUser = await sqliteDb.getUserByUsername(cleanUser);
      if (fullUser) {
        await mysqlClient.pushUserToRemote(fullUser);
      }
    }
  } catch (pushErr) {
    console.warn('MySQL email push notice:', pushErr.message);
  }

  return { ok: true, email: cleanEmail, message: 'Email address successfully updated in database.' };
}

/**
 * Updates a user's password after verifying their current password against the database.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.currentPassword
 * @param {string} params.newPassword
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function changeUserPassword({ username, currentPassword, newPassword }) {
  let cleanUser = String(username || '').trim();
  if (!cleanUser && currentSessionUser) {
    cleanUser = currentSessionUser.username;
  }

  const cleanCurrentPass = String(currentPassword || '');
  const cleanNewPass = String(newPassword || '');

  if (!cleanUser) {
    return { ok: false, error: 'Please sign into your account first.' };
  }
  if (!cleanCurrentPass) {
    return { ok: false, error: 'Please enter your current password.' };
  }
  if (!cleanNewPass || cleanNewPass.length < 4) {
    return { ok: false, error: 'New password must be at least 4 characters long.' };
  }
  if (cleanCurrentPass === cleanNewPass) {
    return { ok: false, error: 'New password must be different from current password.' };
  }

  // 1. Query user from database
  const user = await sqliteDb.getUserByUsername(cleanUser);
  if (!user) {
    return { ok: false, error: 'User account not found in database.' };
  }

  // 2. Verify current password with encrypted database record
  const isMatch = verifyPassword(cleanCurrentPass, user.passwordHash);
  if (!isMatch) {
    return { ok: false, error: 'Incorrect current password. Verification with database failed.' };
  }

  // 3. Generate new salt + scrypt hash and update database
  const newHash = hashPassword(cleanNewPass);
  const updateRes = await sqliteDb.updateUserPassword(cleanUser, newHash);
  if (!updateRes.ok) {
    return { ok: false, error: updateRes.error || 'Failed to update password in database.' };
  }

  try {
    const mysqlClient = require('./mysqlClient');
    const cfg = mysqlClient.loadConfig();
    if (cfg && cfg.enabled) {
      const fullUser = await sqliteDb.getUserByUsername(cleanUser);
      if (fullUser) {
        await mysqlClient.pushUserToRemote(fullUser);
      }
    }
  } catch (pushErr) {
    console.warn('MySQL password push notice:', pushErr.message);
  }

  return { ok: true, message: 'Password has been updated in database.' };
}

module.exports = {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  getCurrentUser,
  getCurrentUserSync,
  logoutUser,
  ensureAdminUser,
  getAllUsers,
  updateUserPermissions,
  changeUserEmail,
  changeUserPassword
};
