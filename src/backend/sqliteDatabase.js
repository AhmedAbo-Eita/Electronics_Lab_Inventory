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
      mpn TEXT NOT NULL,
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
      role TEXT DEFAULT 'user',
      can_delete_all INTEGER DEFAULT 0,
      can_modify_inventory INTEGER DEFAULT 1,
      can_manage_database INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS saved_boms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      boards_count INTEGER NOT NULL DEFAULT 1,
      items_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_saved_boms_name ON saved_boms(name);

    CREATE TABLE IF NOT EXISTS saved_bom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id INTEGER NOT NULL,
      mpn TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      component_type TEXT DEFAULT '',
      value TEXT DEFAULT '',
      footprint TEXT DEFAULT '',
      customer_code TEXT DEFAULT '',
      FOREIGN KEY (bom_id) REFERENCES saved_boms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_saved_bom_items_bom ON saved_bom_items(bom_id);
    CREATE INDEX IF NOT EXISTS idx_saved_bom_items_mpn ON saved_bom_items(mpn);
  `;
  db.run(schemaSql);

  // Schema migrations for role & permissions
  try { db.run("ALTER TABLE lab_users ADD COLUMN role TEXT DEFAULT 'user';"); } catch {}
  try { db.run("ALTER TABLE lab_users ADD COLUMN can_delete_all INTEGER DEFAULT 0;"); } catch {}
  try { db.run("ALTER TABLE lab_users ADD COLUMN can_modify_inventory INTEGER DEFAULT 1;"); } catch {}
  try { db.run("ALTER TABLE lab_users ADD COLUMN can_manage_database INTEGER DEFAULT 0;"); } catch {}
  try { db.run("ALTER TABLE saved_boms ADD COLUMN boards_count INTEGER DEFAULT 1;"); } catch {}
  try { db.run("ALTER TABLE saved_boms ADD COLUMN items_count INTEGER DEFAULT 0;"); } catch {}
  try { db.run("ALTER TABLE saved_boms ADD COLUMN created_by TEXT DEFAULT '';"); } catch {}

  // Schema migration: allow duplicate MPNs across different locations/rows
  try {
    const tableSql = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='lab_inventory';");
    if (tableSql && tableSql.length > 0 && tableSql[0].values.length > 0) {
      const sqlText = String(tableSql[0].values[0][0] || '');
      if (sqlText.includes('mpn TEXT NOT NULL UNIQUE') || sqlText.includes('UNIQUE(mpn)') || sqlText.includes('UNIQUE (mpn)')) {
        db.run(`
          CREATE TABLE lab_inventory_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mpn TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            component_type TEXT DEFAULT '',
            value TEXT DEFAULT '',
            footprint TEXT DEFAULT '',
            location TEXT DEFAULT '',
            customer_code TEXT DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO lab_inventory_v2 (id, mpn, quantity, component_type, value, footprint, location, customer_code, updated_at)
            SELECT id, mpn, quantity, component_type, value, footprint, location, customer_code, updated_at FROM lab_inventory;
          DROP TABLE lab_inventory;
          ALTER TABLE lab_inventory_v2 RENAME TO lab_inventory;
          CREATE INDEX IF NOT EXISTS idx_inventory_mpn ON lab_inventory(mpn);
          CREATE INDEX IF NOT EXISTS idx_inventory_type ON lab_inventory(component_type);
        `);
      }
    }
  } catch (migErr) {
    console.warn('SQLite inventory migration notice:', migErr.message);
  }
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

  const stmt = activeDb.prepare('SELECT id, username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database, last_login, last_failed_login, created_at FROM lab_users WHERE username = ? COLLATE NOCASE LIMIT 1;');
  stmt.bind([clean]);
  let user = null;
  if (stmt.step()) {
    const row = stmt.get();
    const isRootAdmin = String(row[1]).toLowerCase() === 'admin';
    user = {
      id: row[0],
      username: row[1],
      email: row[2],
      passwordHash: row[3],
      role: isRootAdmin ? 'admin' : (row[4] || 'user'),
      canDeleteAll: isRootAdmin ? 1 : (row[5] ? 1 : 0),
      canModifyInventory: isRootAdmin ? 1 : (row[6] !== undefined && row[6] !== null ? (row[6] ? 1 : 0) : 1),
      canManageDatabase: isRootAdmin ? 1 : (row[7] ? 1 : 0),
      lastLogin: row[8],
      lastFailedLogin: row[9],
      createdAt: row[10]
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

  const stmt = activeDb.prepare('SELECT id, username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database, last_login, last_failed_login, created_at FROM lab_users WHERE email = ? COLLATE NOCASE LIMIT 1;');
  stmt.bind([clean]);
  let user = null;
  if (stmt.step()) {
    const row = stmt.get();
    const isRootAdmin = String(row[1]).toLowerCase() === 'admin';
    user = {
      id: row[0],
      username: row[1],
      email: row[2],
      passwordHash: row[3],
      role: isRootAdmin ? 'admin' : (row[4] || 'user'),
      canDeleteAll: isRootAdmin ? 1 : (row[5] ? 1 : 0),
      canModifyInventory: isRootAdmin ? 1 : (row[6] !== undefined && row[6] !== null ? (row[6] ? 1 : 0) : 1),
      canManageDatabase: isRootAdmin ? 1 : (row[7] ? 1 : 0),
      lastLogin: row[8],
      lastFailedLogin: row[9],
      createdAt: row[10]
    };
  }
  stmt.free();
  return user;
}

/**
 * Creates a new user record in SQLite.
 */
async function createUser({ username, email, passwordHash, role = 'user', canDeleteAll = 0, canModifyInventory = 1, canManageDatabase = 0 }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanUser = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const isRootAdmin = cleanUser.toLowerCase() === 'admin';
  const cleanRole = isRootAdmin ? 'admin' : String(role || 'user').trim().toLowerCase();
  const cleanDeleteAll = isRootAdmin ? 1 : (canDeleteAll ? 1 : 0);
  const cleanModify = isRootAdmin ? 1 : (canModifyInventory ? 1 : 0);
  const cleanManageDb = isRootAdmin ? 1 : (canManageDatabase ? 1 : 0);

  try {
    const insertStmt = activeDb.prepare(`
      INSERT INTO lab_users (username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'));
    `);
    insertStmt.run([cleanUser, cleanEmail, passwordHash, cleanRole, cleanDeleteAll, cleanModify, cleanManageDb]);
    insertStmt.free();
    flushToDisk(activeDb);
    return {
      ok: true,
      user: {
        username: cleanUser,
        email: cleanEmail,
        role: cleanRole,
        canDeleteAll: cleanDeleteAll,
        canModifyInventory: cleanModify,
        canManageDatabase: cleanManageDb
      }
    };
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
 * Retrieves all registered users with their roles and permissions.
 * @param {boolean} [includePasswordHash=false]
 */
async function getAllUsers(includePasswordHash = false) {
  if (!activeDb) await initSQLiteDatabase();
  const sql = includePasswordHash
    ? 'SELECT id, username, email, role, can_delete_all, can_modify_inventory, can_manage_database, last_login, created_at, password_hash FROM lab_users ORDER BY id ASC;'
    : 'SELECT id, username, email, role, can_delete_all, can_modify_inventory, can_manage_database, last_login, created_at FROM lab_users ORDER BY id ASC;';
  const stmt = activeDb.prepare(sql);
  const users = [];
  while (stmt.step()) {
    const row = stmt.get();
    const isRootAdmin = String(row[1]).toLowerCase() === 'admin';
    const u = {
      id: row[0],
      username: row[1],
      email: row[2],
      role: isRootAdmin ? 'admin' : (row[3] || 'user'),
      canDeleteAll: isRootAdmin ? 1 : (row[4] ? 1 : 0),
      canModifyInventory: isRootAdmin ? 1 : (row[5] !== undefined && row[5] !== null ? (row[5] ? 1 : 0) : 1),
      canManageDatabase: isRootAdmin ? 1 : (row[6] ? 1 : 0),
      lastLogin: row[7],
      createdAt: row[8]
    };
    if (includePasswordHash) {
      u.passwordHash = row[9];
    }
    users.push(u);
  }
  stmt.free();
  return users;
}

/**
 * Updates permissions (can_delete_all, can_modify_inventory, role) for a user.
 */
async function updateUserPermissions(username, { role, canDeleteAll, canModifyInventory, canManageDatabase } = {}) {
  if (!activeDb) await initSQLiteDatabase();
  const clean = String(username || '').trim();
  if (!clean) return { ok: false, error: 'Username is required.' };

  const isRootAdmin = clean.toLowerCase() === 'admin';
  const existing = await getUserByUsername(clean);

  let newRole = 'user';
  if (isRootAdmin) {
    newRole = 'admin';
  } else if (role) {
    newRole = String(role).trim().toLowerCase();
  } else {
    newRole = existing && existing.role ? existing.role : 'user';
  }
  const newCanDelete = isRootAdmin ? 1 : (canDeleteAll !== undefined ? (canDeleteAll ? 1 : 0) : (existing && existing.canDeleteAll ? 1 : 0));
  const newCanModify = isRootAdmin ? 1 : (canModifyInventory !== undefined ? (canModifyInventory ? 1 : 0) : (existing && existing.canModifyInventory ? 1 : 0));
  const newCanManageDb = isRootAdmin ? 1 : (canManageDatabase !== undefined ? (canManageDatabase ? 1 : 0) : (existing && existing.canManageDatabase ? 1 : 0));

  try {
    const stmt = activeDb.prepare(
      `UPDATE lab_users SET role = ?, can_delete_all = ?, can_modify_inventory = ?, can_manage_database = ? WHERE username = ? COLLATE NOCASE;`
    );
    stmt.run([newRole, newCanDelete, newCanModify, newCanManageDb, clean]);
    stmt.free();
    flushToDisk(activeDb);
    return {
      ok: true,
      user: {
        username: clean,
        role: newRole,
        canDeleteAll: newCanDelete,
        canModifyInventory: newCanModify,
        canManageDatabase: newCanManageDb
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Inserts a new inventory change audit record.
 */
async function insertAuditLog({ username, actionType, mpn = '', changeDetails }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanUser = (typeof username === 'string' && username.trim()) ? username.trim() : 'Anonymous';
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

/**
 * Saves or updates a project BOM and its items in SQLite.
 *
 * @param {Object} params
 * @param {string} params.name Project/Board name
 * @param {number} params.boardsCount Multiplier (boards to build)
 * @param {Array} params.items Component rows [{ mpn, quantity, componentType, value, footprint, customerCode }]
 * @param {string} params.username User who saved the BOM
 * @returns {Promise<{ ok: boolean, bomId?: number, name?: string, itemsCount?: number, error?: string }>}
 */
async function saveBomProject({ name, boardsCount = 1, items = [], username = '' }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    return { ok: false, error: 'BOM Project name cannot be empty.' };
  }
  const count = Math.max(1, Number(boardsCount) || 1);
  const author = String(username || '').trim();
  const validItems = Array.isArray(items) ? items.filter(it => it && it.mpn && String(it.mpn).trim()) : [];

  try {
    activeDb.run('BEGIN TRANSACTION;');

    let bomId = null;
    const findStmt = activeDb.prepare('SELECT id FROM saved_boms WHERE name = ? COLLATE NOCASE LIMIT 1;');
    findStmt.bind([cleanName]);
    if (findStmt.step()) {
      bomId = findStmt.get()[0];
    }
    findStmt.free();

    if (bomId) {
      const updateStmt = activeDb.prepare(`
        UPDATE saved_boms
        SET boards_count = ?, items_count = ?, created_by = CASE WHEN ? != '' THEN ? ELSE created_by END, updated_at = datetime('now')
        WHERE id = ?;
      `);
      updateStmt.run([count, validItems.length, author, author, bomId]);
      updateStmt.free();

      const delStmt = activeDb.prepare('DELETE FROM saved_bom_items WHERE bom_id = ?;');
      delStmt.run([bomId]);
      delStmt.free();
    } else {
      const insertStmt = activeDb.prepare(`
        INSERT INTO saved_boms (name, boards_count, items_count, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'));
      `);
      insertStmt.run([cleanName, count, validItems.length, author]);
      insertStmt.free();

      const idRes = activeDb.exec('SELECT last_insert_rowid();');
      if (idRes && idRes.length > 0 && idRes[0].values.length > 0) {
        bomId = idRes[0].values[0][0];
      }
    }

    if (!bomId) {
      throw new Error('Failed to obtain BOM project ID.');
    }

    if (validItems.length > 0) {
      const itemStmt = activeDb.prepare(`
        INSERT INTO saved_bom_items (bom_id, mpn, quantity, component_type, value, footprint, customer_code)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `);
      for (const it of validItems) {
        itemStmt.run([
          bomId,
          String(it.mpn || '').trim(),
          Math.max(1, Number(it.quantity) || 1),
          it.componentType || it.type || '',
          it.value || '',
          it.footprint || '',
          it.customerCode || it.designator || ''
        ]);
      }
      itemStmt.free();
    }

    activeDb.run('COMMIT;');
    flushToDisk(activeDb);

    return {
      ok: true,
      bomId,
      name: cleanName,
      boardsCount: count,
      itemsCount: validItems.length,
      author
    };
  } catch (err) {
    try { activeDb.run('ROLLBACK;'); } catch {}
    return { ok: false, error: err.message };
  }
}

/**
 * Retrieves the summary list of all saved BOM projects in SQLite.
 *
 * @returns {Promise<{ ok: boolean, list: Array, error?: string }>}
 */
async function getSavedBomsList() {
  if (!activeDb) await initSQLiteDatabase();
  try {
    const res = activeDb.exec(`
      SELECT id, name, boards_count, items_count, created_by, created_at, updated_at
      FROM saved_boms
      ORDER BY updated_at DESC;
    `);
    if (!res || res.length === 0) {
      return { ok: true, list: [] };
    }
    const list = res[0].values.map(r => ({
      id: r[0],
      name: r[1],
      boardsCount: r[2],
      boards_count: r[2],
      itemsCount: r[3],
      items_count: r[3],
      createdBy: r[4] || 'Admin',
      created_by: r[4] || 'Admin',
      createdAt: r[5],
      created_at: r[5],
      updatedAt: r[6],
      updated_at: r[6]
    }));
    return { ok: true, list };
  } catch (err) {
    return { ok: false, list: [], error: err.message };
  }
}

/**
 * Retrieves a single saved BOM project with its component items.
 *
 * @param {string|number} nameOrId
 * @returns {Promise<{ ok: boolean, bom?: Object, items?: Array, error?: string }>}
 */
async function getSavedBom(nameOrId) {
  if (!activeDb) await initSQLiteDatabase();
  try {
    let bom = null;
    let bomId = null;

    if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId).trim())) {
      const stmt = activeDb.prepare('SELECT id, name, boards_count, items_count, created_by, created_at, updated_at FROM saved_boms WHERE id = ? LIMIT 1;');
      stmt.bind([Number(nameOrId)]);
      if (stmt.step()) {
        const r = stmt.get();
        bomId = r[0];
        bom = { id: r[0], name: r[1], boardsCount: r[2], itemsCount: r[3], createdBy: r[4], createdAt: r[5], updatedAt: r[6] };
      }
      stmt.free();
    } else {
      const stmt = activeDb.prepare('SELECT id, name, boards_count, items_count, created_by, created_at, updated_at FROM saved_boms WHERE name = ? COLLATE NOCASE LIMIT 1;');
      stmt.bind([String(nameOrId).trim()]);
      if (stmt.step()) {
        const r = stmt.get();
        bomId = r[0];
        bom = { id: r[0], name: r[1], boardsCount: r[2], itemsCount: r[3], createdBy: r[4], createdAt: r[5], updatedAt: r[6] };
      }
      stmt.free();
    }

    if (!bom || !bomId) {
      return { ok: false, error: `Saved BOM '${nameOrId}' not found.` };
    }

    const items = [];
    const itemStmt = activeDb.prepare(`
      SELECT id, mpn, quantity, component_type, value, footprint, customer_code
      FROM saved_bom_items
      WHERE bom_id = ?
      ORDER BY id ASC;
    `);
    itemStmt.bind([bomId]);
    while (itemStmt.step()) {
      const r = itemStmt.get();
      items.push({
        id: r[0],
        mpn: r[1] || '',
        quantity: Math.max(1, Number(r[2]) || 1),
        componentType: r[3] || '',
        type: r[3] || '',
        value: r[4] || '',
        footprint: r[5] || '',
        customerCode: r[6] || ''
      });
    }
    itemStmt.free();

    return { ok: true, bom, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Deletes a saved BOM and all associated items from SQLite.
 *
 * @param {string|number} nameOrId
 * @returns {Promise<{ ok: boolean, bomName?: string, error?: string }>}
 */
async function deleteSavedBom(nameOrId) {
  if (!activeDb) await initSQLiteDatabase();
  try {
    let bomId = null;
    let bomName = '';

    if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId).trim())) {
      const stmt = activeDb.prepare('SELECT id, name FROM saved_boms WHERE id = ? LIMIT 1;');
      stmt.bind([Number(nameOrId)]);
      if (stmt.step()) {
        const r = stmt.get();
        bomId = r[0];
        bomName = r[1];
      }
      stmt.free();
    } else {
      const stmt = activeDb.prepare('SELECT id, name FROM saved_boms WHERE name = ? COLLATE NOCASE LIMIT 1;');
      stmt.bind([String(nameOrId).trim()]);
      if (stmt.step()) {
        const r = stmt.get();
        bomId = r[0];
        bomName = r[1];
      }
      stmt.free();
    }

    if (!bomId) {
      return { ok: false, error: `Saved BOM '${nameOrId}' not found.` };
    }

    activeDb.run('BEGIN TRANSACTION;');
    const delItems = activeDb.prepare('DELETE FROM saved_bom_items WHERE bom_id = ?;');
    delItems.run([bomId]);
    delItems.free();

    const delBom = activeDb.prepare('DELETE FROM saved_boms WHERE id = ?;');
    delBom.run([bomId]);
    delBom.free();

    activeDb.run('COMMIT;');
    flushToDisk(activeDb);

    return { ok: true, bomName };
  } catch (err) {
    try { activeDb.run('ROLLBACK;'); } catch {}
    return { ok: false, error: err.message };
  }
}

/**
 * Returns all saved BOMs with items (for sync).
 */
async function getAllSavedBomsWithItems() {
  if (!activeDb) await initSQLiteDatabase();
  const listRes = await getSavedBomsList();
  if (!listRes.ok) return [];
  const fullList = [];
  for (const b of listRes.list) {
    const detail = await getSavedBom(b.id);
    if (detail.ok) {
      fullList.push({
        ...b,
        items: detail.items || []
      });
    }
  }
  return fullList;
}

/**
 * Bulk writes/merges an array of BOM projects with items (for sync).
 */
async function saveAllBomsWithItems(bomsWithItems = []) {
  if (!activeDb) await initSQLiteDatabase();
  for (const b of bomsWithItems) {
    await saveBomProject({
      name: b.name,
      boardsCount: b.boardsCount || b.boards_count || 1,
      items: b.items || [],
      username: b.createdBy || b.created_by || ''
    });
  }
  return { ok: true };
}

/**
 * Upserts a user from remote MySQL into local SQLite.
 */
async function saveUserFromRemote({ username, email, passwordHash, role = 'user', canDeleteAll = 0, canModifyInventory = 1, canManageDatabase = 0 }) {
  if (!activeDb) await initSQLiteDatabase();
  const cleanUser = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanUser) return { ok: false };

  const isRootAdmin = cleanUser.toLowerCase() === 'admin';
  const cleanRole = isRootAdmin ? 'admin' : String(role || 'user').trim().toLowerCase();
  const cleanDeleteAll = isRootAdmin ? 1 : (canDeleteAll ? 1 : 0);
  const cleanModify = isRootAdmin ? 1 : (canModifyInventory ? 1 : 0);
  const cleanManageDb = isRootAdmin ? 1 : (canManageDatabase ? 1 : 0);

  try {
    const existing = await getUserByUsername(cleanUser);
    if (existing) {
      const updateStmt = activeDb.prepare(`
        UPDATE lab_users
        SET email = ?, password_hash = ?, role = ?, can_delete_all = ?, can_modify_inventory = ?, can_manage_database = ?
        WHERE username = ? COLLATE NOCASE;
      `);
      updateStmt.run([cleanEmail, passwordHash || existing.passwordHash, cleanRole, cleanDeleteAll, cleanModify, cleanManageDb, cleanUser]);
      updateStmt.free();
    } else {
      const insertStmt = activeDb.prepare(`
        INSERT INTO lab_users (username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'));
      `);
      insertStmt.run([cleanUser, cleanEmail, passwordHash || '', cleanRole, cleanDeleteAll, cleanModify, cleanManageDb]);
      insertStmt.free();
    }
    flushToDisk(activeDb);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Inserts an audit log entry from remote MySQL if not already present.
 */
async function saveAuditLogFromRemote({ username, actionType, mpn = '', changeDetails, changedAt }) {
  if (!activeDb) await initSQLiteDatabase();
  try {
    const findStmt = activeDb.prepare(`
      SELECT id FROM inventory_audit_log
      WHERE username = ? AND action_type = ? AND mpn = ? AND change_details = ?
      LIMIT 1;
    `);
    findStmt.bind([String(username), String(actionType), String(mpn), String(changeDetails)]);
    let exists = false;
    if (findStmt.step()) {
      exists = true;
    }
    findStmt.free();

    if (!exists) {
      const insStmt = activeDb.prepare(`
        INSERT INTO inventory_audit_log (username, action_type, mpn, change_details, changed_at)
        VALUES (?, ?, ?, ?, ?);
      `);
      insStmt.run([
        String(username || 'Admin'),
        String(actionType || 'UNKNOWN').toUpperCase(),
        String(mpn || ''),
        String(changeDetails || ''),
        changedAt || new Date().toISOString().replace('T', ' ').slice(0, 19)
      ]);
      insStmt.free();
      flushToDisk(activeDb);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Inserts a batch of audit log entries from remote MySQL in a single transaction.
 */
async function saveAuditLogsBatchFromRemote(records = []) {
  if (!activeDb) await initSQLiteDatabase();
  if (!Array.isArray(records) || records.length === 0) return { ok: true, count: 0 };

  try {
    activeDb.run('BEGIN TRANSACTION;');

    const findStmt = activeDb.prepare(`
      SELECT id FROM inventory_audit_log
      WHERE username = ? AND action_type = ? AND mpn = ? AND change_details = ?
      LIMIT 1;
    `);

    const insStmt = activeDb.prepare(`
      INSERT INTO inventory_audit_log (username, action_type, mpn, change_details, changed_at)
      VALUES (?, ?, ?, ?, ?);
    `);

    let insertedCount = 0;
    for (const r of records) {
      if (!r) continue;
      const u = String(r.username || 'Admin');
      const a = String(r.actionType || r.action_type || 'UNKNOWN').toUpperCase();
      const m = String(r.mpn || '');
      const d = String(r.changeDetails || r.change_details || '');
      const at = r.changedAt || r.changed_at || new Date().toISOString().replace('T', ' ').slice(0, 19);

      findStmt.bind([u, a, m, d]);
      const exists = findStmt.step();
      findStmt.reset();

      if (!exists) {
        insStmt.run([u, a, m, d, at]);
        insertedCount++;
      }
    }

    findStmt.free();
    insStmt.free();

    activeDb.run('COMMIT;');
    if (insertedCount > 0) {
      flushToDisk(activeDb);
    }
    return { ok: true, count: insertedCount };
  } catch (err) {
    try { activeDb.run('ROLLBACK;'); } catch {}
    return { ok: false, error: err.message };
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
  getAuditLogs,
  getAllUsers,
  updateUserPermissions,
  saveBomProject,
  getSavedBomsList,
  getSavedBom,
  deleteSavedBom,
  getAllSavedBomsWithItems,
  saveAllBomsWithItems,
  saveUserFromRemote,
  saveAuditLogFromRemote,
  saveAuditLogsBatchFromRemote
};

