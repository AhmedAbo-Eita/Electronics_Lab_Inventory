/**
 * ============================================================================
 * Local SQLite Database Manager (Offline-First Storage Engine)
 * ============================================================================
 * Provides a self-contained, embedded SQLite3 database (`data/lab_inventory.db`)
 * using WebAssembly-backed SQLite (sql.js).
 *
 * Benefits:
 *   - Zero background services or daemon setup needed (works on any user PC).
 *   - Real SQL relational engine with tables, indexes, and transactions.
 *   - 100% compatible with DBeaver, SQLiteStudio, and command-line tools.
 *   - Completely independent of CSV files.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const initSqlJs = require('sql.js');

let SQL_ENGINE = null;
let activeDb = null;

/**
 * Standard starter inventory seeded into a fresh SQLite database on first launch.
 */
const DEFAULT_STARTER_COMPONENTS = [
  { mpn: '1N4148W-7-F', quantity: 110, componentType: 'Diode', value: '100V 300mA Fast Switching', footprint: 'SOD-123', location: 'Cabinet D - Bin 03', customerCode: 'DIO-4148' },
  { mpn: '2N2222A', quantity: 50, componentType: 'Transistor', value: '40V 600mA NPN', footprint: 'SOT-23', location: 'Cabinet B - Bin 05', customerCode: 'BJT-001' },
  { mpn: 'AMS1117-3.3', quantity: 45, componentType: 'IC', value: '3.3V 1A LDO Regulator', footprint: 'SOT-223', location: 'Cabinet A - Bin 04', customerCode: 'REG-003' },
  { mpn: 'AO3400A', quantity: 60, componentType: 'MOSFET', value: '30V 5.7A N-Channel', footprint: 'SOT-23', location: 'Cabinet B - Bin 02', customerCode: 'MOS-002' },
  { mpn: 'B2B-XH-A(LF)(SN)', quantity: 0, componentType: 'Connector', value: '2-Pin JST-XH 2.5mm', footprint: 'TH-2P', location: 'Cabinet J - Bin 01', customerCode: 'CON-XH2' },
  { mpn: 'CH340G', quantity: 8, componentType: 'IC', value: 'USB to UART Bridge', footprint: 'SOP-16', location: 'Cabinet A - Bin 09', customerCode: 'USB-005' },
  { mpn: 'CL10B104KB8NNNC', quantity: 320, componentType: 'Capacitor', value: '100nF 50V', footprint: '0603', location: 'Rack C - Drawer 01', customerCode: 'CAP-100N' },
  { mpn: 'CL21A106KAYNNNE', quantity: 75, componentType: 'Capacitor', value: '10uF 25V', footprint: '0805', location: 'Rack C - Drawer 04', customerCode: 'CAP-10U' },
  { mpn: 'ESP32-WROOM-32E', quantity: 15, componentType: 'IC', value: 'Wi-Fi + BT SoC Module', footprint: 'SMD-38', location: 'Cabinet A - Bin 02', customerCode: 'MOD-002' },
  { mpn: 'IRFZ44NPBF', quantity: 18, componentType: 'MOSFET', value: '55V 49A N-Channel', footprint: 'TO-220', location: 'Cabinet B - Bin 01', customerCode: 'MOS-001' },
  { mpn: 'LM358DR', quantity: 32, componentType: 'IC', value: 'Dual Op-Amp', footprint: 'SOP-8', location: 'Cabinet A - Bin 06', customerCode: 'AMP-004' },
  { mpn: 'RC0603FR-0710KL', quantity: 250, componentType: 'Resistor', value: '10k', footprint: '0603', location: 'Rack R - Drawer 01', customerCode: 'RES-10K' },
  { mpn: 'RC0603FR-074K7L', quantity: 180, componentType: 'Resistor', value: '4.7k', footprint: '0603', location: 'Rack R - Drawer 02', customerCode: 'RES-4K7' },
  { mpn: 'RC0805FR-07330RL', quantity: 95, componentType: 'Resistor', value: '330R', footprint: '0805', location: 'Rack R - Drawer 05', customerCode: 'RES-330R' },
  { mpn: 'SRN4018-4R7M', quantity: 6, componentType: 'Inductor', value: '4.7uH 2.5A', footprint: 'SMD', location: 'Cabinet L - Bin 02', customerCode: 'IND-4U7' },
  { mpn: 'SS34', quantity: 40, componentType: 'Diode', value: '40V 3A Schottky', footprint: 'SMA', location: 'Cabinet D - Bin 01', customerCode: 'DIO-SS34' },
  { mpn: 'STM32F103C8T6', quantity: 24, componentType: 'IC', value: '32-bit ARM Cortex-M3 MCU', footprint: 'LQFP-48', location: 'Cabinet A - Bin 01', customerCode: 'MCU-001' }
];

/**
 * Resolves the writable directory for SQLite database storage.
 */
function getDatabasePaths() {
  let baseDir;
  if (app && app.isPackaged) {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      baseDir = process.env.PORTABLE_EXECUTABLE_DIR;
    } else {
      baseDir = path.dirname(process.execPath);
    }
  } else if (app && typeof app.getAppPath === 'function') {
    baseDir = app.getAppPath();
  } else {
    baseDir = process.cwd();
  }

  let dataDirPath = path.join(baseDir, 'data');
  try {
    if (!fs.existsSync(dataDirPath)) {
      fs.mkdirSync(dataDirPath, { recursive: true });
    }
    fs.accessSync(dataDirPath, fs.constants.W_OK);
  } catch {
    if (app && typeof app.getPath === 'function') {
      dataDirPath = path.join(app.getPath('userData'), 'data');
    }
    if (!fs.existsSync(dataDirPath)) {
      fs.mkdirSync(dataDirPath, { recursive: true });
    }
  }

  const dbFilePath = path.join(dataDirPath, 'lab_inventory.db');
  return { dataDirPath, dbFilePath };
}

/**
 * Initializes the sql.js WebAssembly engine.
 */
async function getSqlEngine() {
  if (SQL_ENGINE) return SQL_ENGINE;
  const wasmPath = path.join(require.resolve('sql.js'), '../sql-wasm.wasm');
  const wasmBinary = fs.readFileSync(wasmPath);
  SQL_ENGINE = await initSqlJs({ wasmBinary });
  return SQL_ENGINE;
}

/**
 * Ensures the `lab_inventory` table exists with proper indexes.
 */
function ensureSchema(db) {
  const schemaSql = `
    CREATE TABLE IF NOT EXISTS lab_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mpn TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 0,
      component_type TEXT DEFAULT '',
      value TEXT DEFAULT '',
      footprint TEXT DEFAULT '',
      location TEXT DEFAULT '',
      customer_code TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_mpn ON lab_inventory(mpn);
    CREATE INDEX IF NOT EXISTS idx_inventory_type ON lab_inventory(component_type);

    CREATE TABLE IF NOT EXISTS lab_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      last_login DATETIME DEFAULT NULL,
      last_failed_login DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON lab_users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON lab_users(email);

    CREATE TABLE IF NOT EXISTS inventory_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action_type TEXT NOT NULL,
      mpn TEXT DEFAULT '',
      change_details TEXT NOT NULL,
      changed_at DATETIME NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON inventory_audit_log(changed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_username ON inventory_audit_log(username);
    CREATE INDEX IF NOT EXISTS idx_audit_mpn ON inventory_audit_log(mpn);
  `;
  db.run(schemaSql);
}

/**
 * Saves current SQLite in-memory database to disk.
 */
function flushToDisk(db) {
  const { dbFilePath } = getDatabasePaths();
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbFilePath, buffer);
}

/**
 * Seeds default starter components into a fresh database.
 */
function seedStarterComponents(db) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO lab_inventory
      (mpn, quantity, component_type, value, footprint, location, customer_code, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  db.run('BEGIN TRANSACTION;');
  for (const c of DEFAULT_STARTER_COMPONENTS) {
    insertStmt.run([
      c.mpn,
      c.quantity,
      c.componentType,
      c.value,
      c.footprint,
      c.location,
      c.customerCode
    ]);
  }
  db.run('COMMIT;');
  insertStmt.free();
  flushToDisk(db);
}

/**
 * Initializes and loads the persistent SQLite database.
 *
 * @returns {Promise<{ ok: boolean, db: Object, path: string, count: number }>}
 */
async function initSQLiteDatabase() {
  const SQL = await getSqlEngine();
  const { dbFilePath } = getDatabasePaths();

  if (fs.existsSync(dbFilePath)) {
    try {
      const fileBuffer = fs.readFileSync(dbFilePath);
      activeDb = new SQL.Database(fileBuffer);
      ensureSchema(activeDb);
    } catch (err) {
      console.warn('Could not read existing SQLite database, creating new one:', err.message);
      activeDb = new SQL.Database();
      ensureSchema(activeDb);
      seedStarterComponents(activeDb);
    }
  } else {
    activeDb = new SQL.Database();
    ensureSchema(activeDb);
    seedStarterComponents(activeDb);
  }

  // Get total count
  const countRes = activeDb.exec('SELECT COUNT(*) AS total FROM lab_inventory;');
  const total = countRes[0]?.values[0][0] || 0;

  return { ok: true, db: activeDb, path: dbFilePath, count: total };
}

/**
 * Gets all components from SQLite.
 *
 * @returns {Promise<{ ok: boolean, list: Array, path: string, error?: string }>}
 */
async function getAllComponents() {
  if (!activeDb) {
    await initSQLiteDatabase();
  }

  const { dbFilePath } = getDatabasePaths();
  try {
    const res = activeDb.exec(`
      SELECT mpn, quantity, component_type, value, footprint, location, customer_code, updated_at
      FROM lab_inventory
      ORDER BY mpn ASC;
    `);

    if (!res.length) {
      return { ok: true, list: [], path: dbFilePath };
    }

    const rows = res[0].values.map(v => ({
      mpn: String(v[0] || ''),
      quantity: Number(v[1]) || 0,
      type: String(v[2] || ''),
      componentType: String(v[2] || ''),
      value: String(v[3] || ''),
      footprint: String(v[4] || ''),
      location: String(v[5] || ''),
      customerCode: String(v[6] || ''),
      updatedAt: String(v[7] || '')
    }));

    return { ok: true, list: rows, path: dbFilePath };
  } catch (err) {
    return { ok: false, list: [], path: dbFilePath, error: err.message };
  }
}

/**
 * Saves full components list to SQLite and flushes to disk.
 *
 * @param {Array} components
 * @returns {Promise<{ ok: boolean, path: string, error?: string }>}
 */
async function saveAllComponents(components = []) {
  if (!activeDb) {
    await initSQLiteDatabase();
  }

  const { dbFilePath } = getDatabasePaths();
  try {
    activeDb.run('BEGIN TRANSACTION;');
    activeDb.run('DELETE FROM lab_inventory;');

    const insertStmt = activeDb.prepare(`
      INSERT INTO lab_inventory
        (mpn, quantity, component_type, value, footprint, location, customer_code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (const c of components) {
      if (!c.mpn) continue;
      insertStmt.run([
        c.mpn,
        Number(c.quantity) || 0,
        c.componentType || c.type || '',
        c.value || '',
        c.footprint || '',
        c.location || '',
        c.customerCode || ''
      ]);
    }

    activeDb.run('COMMIT;');
    insertStmt.free();
    flushToDisk(activeDb);

    return { ok: true, path: dbFilePath };
  } catch (err) {
    try { activeDb.run('ROLLBACK;'); } catch {}
    return { ok: false, path: dbFilePath, error: err.message };
  }
}

/**
 * Imports component rows from an external SQLite (.db / .sqlite) database file.
 *
 * @param {string} externalFilePath
 * @returns {Promise<{ ok: boolean, list: Array, baseName?: string, error?: string }>}
 */
async function importFromExternalDbFile(externalFilePath) {
  try {
    const SQL = await getSqlEngine();
    const fileBuffer = fs.readFileSync(externalFilePath);
    const extDb = new SQL.Database(fileBuffer);

    let res = [];
    try {
      res = extDb.exec(`
        SELECT mpn, quantity, component_type, value, footprint, location, customer_code
        FROM lab_inventory
        ORDER BY mpn ASC;
      `);
    } catch {
      // Fallback: check if bom_availability_report table exists
      res = extDb.exec(`
        SELECT mpn, qty_per_board, component_type, value, footprint, lab_location, customer_code
        FROM bom_availability_report
        ORDER BY mpn ASC;
      `);
    }

    extDb.close();

    if (!res.length) {
      return { ok: true, list: [], baseName: path.basename(externalFilePath, path.extname(externalFilePath)) };
    }

    const rows = res[0].values.map(v => ({
      mpn: String(v[0] || ''),
      quantity: Number(v[1]) || 0,
      type: String(v[2] || ''),
      componentType: String(v[2] || ''),
      value: String(v[3] || ''),
      footprint: String(v[4] || ''),
      location: String(v[5] || ''),
      customerCode: String(v[6] || '')
    }));

    return {
      ok: true,
      list: rows,
      baseName: path.basename(externalFilePath, path.extname(externalFilePath))
    };
  } catch (err) {
    return { ok: false, list: [], error: 'Invalid SQLite database file or missing lab_inventory table: ' + err.message };
  }
}

/**
 * Exports a component list to an external SQLite (.db) database file.
 *
 * @param {string} targetFilePath
 * @param {Array} components
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
async function exportToExternalDbFile(targetFilePath, components = []) {
  try {
    const SQL = await getSqlEngine();
    const outDb = new SQL.Database();
    ensureSchema(outDb);

    outDb.run('BEGIN TRANSACTION;');
    const insertStmt = outDb.prepare(`
      INSERT OR REPLACE INTO lab_inventory
        (mpn, quantity, component_type, value, footprint, location, customer_code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (const c of components) {
      if (!c.mpn) continue;
      insertStmt.run([
        c.mpn,
        Number(c.quantity) || 0,
        c.componentType || c.type || '',
        c.value || '',
        c.footprint || '',
        c.location || '',
        c.customerCode || ''
      ]);
    }
    outDb.run('COMMIT;');
    insertStmt.free();

    const data = outDb.export();
    fs.writeFileSync(targetFilePath, Buffer.from(data));
    outDb.close();

    return { ok: true, path: targetFilePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Exports a starter SQLite template database (.db) file.
 *
 * @param {string} targetFilePath
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
async function exportTemplateDbFile(targetFilePath) {
  return exportToExternalDbFile(targetFilePath, DEFAULT_STARTER_COMPONENTS);
}

/**
 * Exports a BOM Availability & Shortage Report to a standalone SQLite (.db) file.
 *
 * @param {string} targetFilePath
 * @param {string} boardName
 * @param {number} boardsCount
 * @param {Array} analysisItems
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
async function exportBomReportToDbFile(targetFilePath, boardName, boardsCount, analysisItems = []) {
  try {
    const SQL = await getSqlEngine();
    const outDb = new SQL.Database();

    outDb.run(`
      CREATE TABLE IF NOT EXISTS bom_availability_report (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_name TEXT,
        boards_count INTEGER,
        mpn TEXT,
        component_type TEXT,
        value TEXT,
        footprint TEXT,
        customer_code TEXT,
        qty_per_board INTEGER,
        total_required INTEGER,
        available_in_lab INTEGER,
        shortage INTEGER,
        lab_location TEXT,
        availability_status TEXT,
        exported_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Also include standard lab_inventory table so this .db can be re-imported as a BOM DB
    ensureSchema(outDb);

    outDb.run('BEGIN TRANSACTION;');
    const reportStmt = outDb.prepare(`
      INSERT INTO bom_availability_report
        (board_name, boards_count, mpn, component_type, value, footprint, customer_code, qty_per_board, total_required, available_in_lab, shortage, lab_location, availability_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const invStmt = outDb.prepare(`
      INSERT OR REPLACE INTO lab_inventory
        (mpn, quantity, component_type, value, footprint, location, customer_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const effectiveBoard = (boardName || '').trim() || 'Untitled_Board';
    for (const item of analysisItems) {
      const bc = item.bomComponent || {};
      reportStmt.run([
        effectiveBoard,
        Number(boardsCount) || 1,
        bc.mpn || '',
        bc.type || bc.componentType || '',
        bc.value || '',
        bc.footprint || '',
        bc.customerCode || '',
        Number(bc.quantity) || 1,
        Number(item.totalRequired) || 0,
        Number(item.availableInLab) || 0,
        Number(item.shortage) || 0,
        item.labLocation || '',
        item.statusText || ''
      ]);

      if (bc.mpn) {
        invStmt.run([
          bc.mpn,
          Number(bc.quantity) || 1,
          bc.type || bc.componentType || '',
          bc.value || '',
          bc.footprint || '',
          item.labLocation || '',
          bc.customerCode || ''
        ]);
      }
    }

    outDb.run('COMMIT;');
    reportStmt.free();
    invStmt.free();

    const data = outDb.export();
    fs.writeFileSync(targetFilePath, Buffer.from(data));
    outDb.close();

    return { ok: true, path: targetFilePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Retrieves a user record by username.
 */
async function getUserByUsername(username) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  if (!clean) return null;

  const stmt = activeDb.prepare('SELECT id, username, email, password_hash, last_login, last_failed_login, created_at FROM lab_users WHERE username = ? COLLATE NOCASE LIMIT 1;');
  stmt.bind([clean]);
  let user = null;
  if (stmt.step()) {
    const row = stmt.get();
    user = {
      id: row[0],
      username: row[1],
      email: row[2],
      passwordHash: row[3],
      lastLogin: row[4],
      lastFailedLogin: row[5],
      createdAt: row[6]
    };
  }
  stmt.free();
  return user;
}

/**
 * Retrieves a user record by email.
 */
async function getUserByEmail(email) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;

  const stmt = activeDb.prepare('SELECT id, username, email, password_hash, last_login, last_failed_login, created_at FROM lab_users WHERE email = ? COLLATE NOCASE LIMIT 1;');
  stmt.bind([clean]);
  let user = null;
  if (stmt.step()) {
    const row = stmt.get();
    user = {
      id: row[0],
      username: row[1],
      email: row[2],
      passwordHash: row[3],
      lastLogin: row[4],
      lastFailedLogin: row[5],
      createdAt: row[6]
    };
  }
  stmt.free();
  return user;
}

/**
 * Creates a new user record in SQLite.
 */
async function createUser({ username, email, passwordHash }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanUser = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();

  try {
    const insertStmt = activeDb.prepare(`
      INSERT INTO lab_users (username, email, password_hash, created_at)
      VALUES (?, ?, ?, datetime('now', 'localtime'));
    `);
    insertStmt.run([cleanUser, cleanEmail, passwordHash]);
    insertStmt.free();
    flushToDisk(activeDb);
    return { ok: true, user: { username: cleanUser, email: cleanEmail } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Updates last_login timestamp upon successful login.
 */
async function updateUserLoginSuccess(username) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  if (!clean) return;

  activeDb.run(
    `UPDATE lab_users SET last_login = datetime('now', 'localtime') WHERE username = ? COLLATE NOCASE;`,
    [clean]
  );
  flushToDisk(activeDb);
}

/**
 * Updates last_failed_login timestamp upon failed password attempt.
 */
async function updateUserLoginFailure(username) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  if (!clean) return;

  activeDb.run(
    `UPDATE lab_users SET last_failed_login = datetime('now', 'localtime') WHERE username = ? COLLATE NOCASE;`,
    [clean]
  );
  flushToDisk(activeDb);
}

/**
 * Updates a user's registered email address.
 * @param {string} username
 * @param {string} newEmail
 */
async function updateUserEmail(username, newEmail) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  const cleanEmail = String(newEmail || '').trim().toLowerCase();
  if (!clean || !cleanEmail) {
    return { ok: false, error: 'Username and new email are required.' };
  }

  try {
    const stmt = activeDb.prepare(
      `UPDATE lab_users SET email = ? WHERE username = ? COLLATE NOCASE;`
    );
    stmt.run([cleanEmail, clean]);
    stmt.free();
    flushToDisk(activeDb);
    return { ok: true, email: cleanEmail };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Updates a user's password hash.
 * @param {string} username
 * @param {string} newPasswordHash
 */
async function updateUserPassword(username, newPasswordHash) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  if (!clean || !newPasswordHash) {
    return { ok: false, error: 'Username and new password hash are required.' };
  }

  try {
    const stmt = activeDb.prepare(
      `UPDATE lab_users SET password_hash = ? WHERE username = ? COLLATE NOCASE;`
    );
    stmt.run([newPasswordHash, clean]);
    stmt.free();
    flushToDisk(activeDb);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Inserts a new inventory change audit record.
 */
async function insertAuditLog({ username, actionType, mpn = '', changeDetails }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanUser = String(username || 'Anonymous').trim();
  const cleanType = String(actionType || 'UNKNOWN').trim().toUpperCase();
  const cleanMpn = String(mpn || '').trim();
  const cleanDetails = String(changeDetails || '').trim();

  try {
    const stmt = activeDb.prepare(`
      INSERT INTO inventory_audit_log (username, action_type, mpn, change_details, changed_at)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'));
    `);
    stmt.run([cleanUser, cleanType, cleanMpn, cleanDetails]);
    stmt.free();
    flushToDisk(activeDb);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Retrieves recent inventory audit records with optional search filter.
 */
async function getAuditLogs({ limit = 100, search = '', action = '' } = {}) {
  if (!activeDb) await initSQLiteDatabase();
  const maxLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 500);
  const term = String(search || '').trim().toLowerCase();
  const act = String(action || '').trim().toUpperCase();

  try {
    let sql = `
      SELECT id, username, action_type, mpn, change_details, changed_at
      FROM inventory_audit_log
    `;
    const conditions = [];
    let params = [];

    if (term) {
      conditions.push(`(LOWER(username) LIKE ? OR LOWER(action_type) LIKE ? OR LOWER(mpn) LIKE ? OR LOWER(change_details) LIKE ?)`);
      const like = `%${term}%`;
      params.push(like, like, like, like);
    }

    if (act) {
      conditions.push(`UPPER(action_type) = ?`);
      params.push(act);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY id DESC LIMIT ${maxLimit};`;

    let rows = [];
    if (params.length > 0) {
      const stmt = activeDb.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) {
        const r = stmt.get();
        rows.push({
          id: r[0],
          username: r[1],
          actionType: r[2],
          action_type: r[2],
          mpn: r[3],
          changeDetails: r[4],
          change_details: r[4],
          changedAt: r[5],
          changed_at: r[5]
        });
      }
      stmt.free();
    } else {
      const res = activeDb.exec(sql);
      if (res && res.length > 0) {
        rows = res[0].values.map(r => ({
          id: r[0],
          username: r[1],
          actionType: r[2],
          action_type: r[2],
          mpn: r[3],
          changeDetails: r[4],
          change_details: r[4],
          changedAt: r[5],
          changed_at: r[5]
        }));
      }
    }

    return { ok: true, rows, logs: rows };
  } catch (err) {
    return { ok: false, rows: [], logs: [], error: err.message };
  }
}

module.exports = {
  getDatabasePaths,
  initSQLiteDatabase,
  getAllComponents,
  saveAllComponents,
  importFromExternalDbFile,
  exportToExternalDbFile,
  exportTemplateDbFile,
  exportBomReportToDbFile,
  getUserByUsername,
  getUserByEmail,
  createUser,
  updateUserLoginSuccess,
  updateUserLoginFailure,
  updateUserEmail,
  updateUserPassword,
  insertAuditLog,
  getAuditLogs
};

