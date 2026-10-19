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
  const result = await sqliteDb.createUser({
    username: cleanUser,
    email: cleanEmail,
    passwordHash
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to create user account.' };
  }

  currentSessionUser = {
    username: cleanUser,
    email: cleanEmail,
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

  currentSessionUser = {
    username: user.username,
    email: user.email,
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
      currentSessionUser = {
        username: user.username,
        email: user.email,
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
 * Clears current session user on logout and disables auto-login.
 */
function logoutUser() {
  currentSessionUser = null;
  appSettings.saveSettings({ autoLogin: false, autoLoginUsername: '' });
  return { ok: true };
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

  return { ok: true, message: 'Password has been updated in database.' };
}

module.exports = {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  getCurrentUser,
  logoutUser,
  changeUserEmail,
  changeUserPassword
};
