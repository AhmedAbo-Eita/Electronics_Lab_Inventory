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

  return { ok: true, user: currentSessionUser };
}

/**
 * Returns the currently authenticated user in this session, or null if logged out.
 */
function getCurrentUser() {
  return currentSessionUser;
}

/**
 * Clears current session user on logout.
 */
function logoutUser() {
  currentSessionUser = null;
  return { ok: true };
}

module.exports = {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  getCurrentUser,
  logoutUser
};
