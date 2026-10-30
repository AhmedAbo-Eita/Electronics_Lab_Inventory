/**
 * ============================================================================
 * MySQL Client & Two-Way Sync Engine
 * ============================================================================
 * Provides connection pooling, automatic remote table creation, and
 * synchronization between local offline storage and remote MySQL server.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const mysql = require('mysql2/promise');

// File path for saving MySQL connection configuration
function getConfigPath() {
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

  const dataDir = path.join(baseDir, 'data');
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      // Fallback to userData if baseDir not writable
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'mysql_config.json');
      }
      return path.join(baseDir, 'mysql_config.json');
    }
  }
  return path.join(dataDir, 'mysql_config.json');
}

const DEFAULT_CONFIG = {
  enabled: false,
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: 'lab_inventory_db',
  connectTimeout: 4000
};

let currentConfig = null;
let pool = null;
let lastSyncTime = null;

/**
 * Loads current MySQL configuration from disk.
 */
function loadConfig() {
  if (currentConfig) return currentConfig;
  const cfgPath = getConfigPath();
  try {
    if (fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      currentConfig = { ...DEFAULT_CONFIG, ...data };
      return currentConfig;
    }
  } catch (err) {
    console.warn('Could not read mysql_config.json:', err.message);
  }
  currentConfig = { ...DEFAULT_CONFIG };
  return currentConfig;
}

/**
 * Saves MySQL configuration to disk.
 */
function saveConfig(newConfig) {
  currentConfig = { ...DEFAULT_CONFIG, ...newConfig };
  const cfgPath = getConfigPath();
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(currentConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save mysql_config.json:', err.message);
  }
  resetPool();
  return currentConfig;
}

let remoteTablesEnsured = false;

/**
 * Closes and resets the connection pool.
 */
function resetPool() {
  remoteTablesEnsured = false;
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
}

/**
 * Gets or creates the MySQL connection pool.
 */
function getPool(customConfig = null) {
  if (customConfig) {
    return mysql.createPool({
      host: customConfig.host || 'localhost',
      port: Number(customConfig.port) || 3306,
      user: customConfig.user || 'root',
      password: customConfig.password || '',
      database: customConfig.database || 'lab_inventory_db',
      connectTimeout: customConfig.connectTimeout || 5000,
      waitForConnections: true,
      connectionLimit: 4,
      multipleStatements: true
    });
  }

  if (!pool) {
    const cfg = loadConfig();
    pool = mysql.createPool({
      host: cfg.host,
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: cfg.connectTimeout || 5000,
      waitForConnections: true,
      connectionLimit: 4,
      multipleStatements: true
    });
  }
  return pool;
}

/**
 * Tests connection to MySQL server with given or saved config.
 */
async function testConnection(customConfig = null) {
  let targetPool = null;
  let isTemp = false;
  try {
    if (customConfig) {
      targetPool = getPool(customConfig);
      isTemp = true;
    } else {
      const cfg = loadConfig();
      if (!cfg.enabled) {
        return { online: false, message: 'MySQL is disabled (working offline).' };
      }
      targetPool = getPool();
    }

    const conn = await targetPool.getConnection();
    await conn.ping();
    conn.release();

    if (isTemp) {
      await targetPool.end().catch(() => {});
    }

    return { online: true, message: 'Successfully connected to MySQL database!' };
  } catch (err) {
    if (isTemp && targetPool) {
      await targetPool.end().catch(() => {});
    }
    return { online: false, message: err.message, code: err.code };
  }
}

/**
 * Ensures the tables exist on the remote database.
 */
async function ensureRemoteTable() {
  if (remoteTablesEnsured) return;
  const p = getPool();
  
  await p.query(`
    CREATE TABLE IF NOT EXISTS \`lab_inventory\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`mpn\` VARCHAR(120) NOT NULL,
      \`quantity\` INT NOT NULL DEFAULT 0,
      \`component_type\` VARCHAR(80) DEFAULT '',
      \`value\` VARCHAR(80) DEFAULT '',
      \`footprint\` VARCHAR(80) DEFAULT '',
      \`location\` VARCHAR(120) DEFAULT '',
      \`customer_code\` VARCHAR(80) DEFAULT '',
      \`min_stock\` INT NOT NULL DEFAULT 10,
      \`unit_price\` DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
      \`datasheet_url\` VARCHAR(500) DEFAULT '',
      \`supplier_part_no\` VARCHAR(120) DEFAULT '',
      \`supplier\` VARCHAR(80) DEFAULT '',
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`deleted_at\` TIMESTAMP NULL DEFAULT NULL,
      INDEX \`idx_mpn\` (\`mpn\`),
      INDEX \`idx_type\` (\`component_type\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`lab_users\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`username\` VARCHAR(80) NOT NULL UNIQUE,
      \`email\` VARCHAR(120) NOT NULL UNIQUE,
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`role\` VARCHAR(30) DEFAULT 'user',
      \`can_delete_all\` TINYINT(1) DEFAULT 0,
      \`can_modify_inventory\` TINYINT(1) DEFAULT 1,
      \`can_manage_database\` TINYINT(1) DEFAULT 0,
      \`last_login\` DATETIME NULL DEFAULT NULL,
      \`last_failed_login\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_username\` (\`username\`),
      INDEX \`idx_email\` (\`email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`inventory_audit_log\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`username\` VARCHAR(80) NOT NULL,
      \`action_type\` VARCHAR(50) NOT NULL,
      \`mpn\` VARCHAR(120) DEFAULT '',
      \`change_details\` TEXT NOT NULL,
      \`changed_at\` DATETIME NOT NULL,
      INDEX \`idx_changed_at\` (\`changed_at\`),
      INDEX \`idx_username\` (\`username\`),
      INDEX \`idx_mpn\` (\`mpn\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`saved_boms\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(150) NOT NULL UNIQUE,
      \`boards_count\` INT NOT NULL DEFAULT 1,
      \`items_count\` INT NOT NULL DEFAULT 0,
      \`created_by\` VARCHAR(80) DEFAULT '',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`deleted_at\` TIMESTAMP NULL DEFAULT NULL,
      INDEX \`idx_saved_boms_name\` (\`name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS \`saved_bom_items\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`bom_id\` INT NOT NULL,
      \`mpn\` VARCHAR(120) NOT NULL,
      \`quantity\` INT NOT NULL DEFAULT 1,
      \`component_type\` VARCHAR(80) DEFAULT '',
      \`value\` VARCHAR(80) DEFAULT '',
      \`footprint\` VARCHAR(80) DEFAULT '',
      \`customer_code\` VARCHAR(255) DEFAULT '',
      INDEX \`idx_bom_items_bom_id\` (\`bom_id\`),
      INDEX \`idx_bom_items_mpn\` (\`mpn\`),
      FOREIGN KEY (\`bom_id\`) REFERENCES \`saved_boms\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try { await p.query('ALTER TABLE `lab_inventory` DROP INDEX `mpn`;'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` DROP INDEX `idx_mpn_unique`;'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` ADD COLUMN `min_stock` INT NOT NULL DEFAULT 10;'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` ADD COLUMN `unit_price` DECIMAL(10,4) NOT NULL DEFAULT 0.0000;'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` ADD COLUMN `datasheet_url` VARCHAR(500) DEFAULT \'\';'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` ADD COLUMN `supplier_part_no` VARCHAR(120) DEFAULT \'\';'); } catch {}
  try { await p.query('ALTER TABLE `lab_inventory` ADD COLUMN `supplier` VARCHAR(80) DEFAULT \'\';'); } catch {}
  try { await p.query('ALTER TABLE `lab_users` ADD COLUMN `role` VARCHAR(30) DEFAULT \'user\';'); } catch {}
  try { await p.query('ALTER TABLE `lab_users` ADD COLUMN `can_delete_all` TINYINT(1) DEFAULT 0;'); } catch {}
  try { await p.query('ALTER TABLE `lab_users` ADD COLUMN `can_modify_inventory` TINYINT(1) DEFAULT 1;'); } catch {}
  try { await p.query('ALTER TABLE `lab_users` ADD COLUMN `can_manage_database` TINYINT(1) DEFAULT 0;'); } catch {}
  try { await p.query('ALTER TABLE `saved_boms` ADD COLUMN `boards_count` INT NOT NULL DEFAULT 1;'); } catch {}
  try { await p.query('ALTER TABLE `saved_boms` ADD COLUMN `items_count` INT NOT NULL DEFAULT 0;'); } catch {}
  try { await p.query('ALTER TABLE `saved_boms` ADD COLUMN `created_by` VARCHAR(80) DEFAULT \'\';'); } catch {}
  remoteTablesEnsured = true;
}

/**
 * Fetches all active inventory components from MySQL.
 */
async function fetchRemoteInventory() {
  await ensureRemoteTable();
  const p = getPool();
  const [rows] = await p.query(
    'SELECT mpn, quantity, component_type, value, footprint, location, customer_code, updated_at, min_stock, unit_price, datasheet_url, supplier_part_no, supplier FROM `lab_inventory` WHERE deleted_at IS NULL ORDER BY mpn ASC'
  );
  return rows.map(r => ({
    mpn: r.mpn || '',
    quantity: Number(r.quantity) || 0,
    type: r.component_type || '',
    componentType: r.component_type || '',
    value: r.value || '',
    footprint: r.footprint || '',
    location: r.location || '',
    customerCode: r.customer_code || '',
    minStock: r.min_stock !== undefined && r.min_stock !== null ? Number(r.min_stock) : 10,
    unitPrice: r.unit_price !== undefined && r.unit_price !== null ? Number(r.unit_price) : 0.0,
    datasheetUrl: r.datasheet_url || '',
    supplierPartNo: r.supplier_part_no || '',
    supplier: r.supplier || '',
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0
  }));
}

/**
 * Upserts a batch of components into MySQL.
 */
async function pushComponentsToRemote(components) {
  if (!components || components.length === 0) return { insertedOrUpdated: 0 };
  const valid = components.filter(c => c && c.mpn && String(c.mpn).trim() !== '');
  if (valid.length === 0) return { insertedOrUpdated: 0 };

  await ensureRemoteTable();
  const p = getPool();

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM `lab_inventory`;');

    const sql = `
      INSERT INTO \`lab_inventory\`
        (\`mpn\`, \`quantity\`, \`component_type\`, \`value\`, \`footprint\`, \`location\`, \`customer_code\`, \`min_stock\`, \`unit_price\`, \`datasheet_url\`, \`supplier_part_no\`, \`supplier\`, \`updated_at\`, \`deleted_at\`)
      VALUES ?;
    `;

    const values = valid.map(c => [
      String(c.mpn).trim(),
      Number(c.quantity) || 0,
      c.componentType || c.type || '',
      c.value || '',
      c.footprint || '',
      c.location || '',
      c.customerCode || '',
      c.minStock !== undefined && c.minStock !== null ? Number(c.minStock) : 10,
      c.unitPrice !== undefined && c.unitPrice !== null ? Number(c.unitPrice) : 0.0,
      c.datasheetUrl || '',
      c.supplierPartNo || c.supplierPn || '',
      c.supplier || '',
      new Date(),
      null
    ]);

    const [result] = await conn.query(sql, [values]);
    await conn.commit();
    return { insertedOrUpdated: result.affectedRows };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Upserts a user into remote MySQL database.
 */
async function pushUserToRemote(user) {
  if (!user || !user.username) return { ok: false };
  const check = await testConnection();
  if (!check.online) return { ok: false, offline: true };
  await ensureRemoteTable();
  const p = getPool();
  try {
    await p.query(`
      INSERT INTO \`lab_users\` (\`username\`, \`email\`, \`password_hash\`, \`role\`, \`can_delete_all\`, \`can_modify_inventory\`, \`can_manage_database\`, \`created_at\`)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        \`email\` = VALUES(\`email\`),
        \`password_hash\` = IF(VALUES(\`password_hash\`) != '', VALUES(\`password_hash\`), \`password_hash\`),
        \`role\` = VALUES(\`role\`),
        \`can_delete_all\` = VALUES(\`can_delete_all\`),
        \`can_modify_inventory\` = VALUES(\`can_modify_inventory\`),
        \`can_manage_database\` = VALUES(\`can_manage_database\`);
    `, [
      String(user.username).trim(),
      String(user.email || '').trim().toLowerCase(),
      user.passwordHash || user.password_hash || '',
      user.role || 'user',
      user.canDeleteAll || user.can_delete_all ? 1 : 0,
      user.canModifyInventory !== undefined ? (user.canModifyInventory ? 1 : 0) : 1,
      user.canManageDatabase || user.can_manage_database ? 1 : 0
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fetches a single user record from remote MySQL.
 */
async function fetchRemoteUser(identifier) {
  const clean = String(identifier || '').trim();
  if (!clean) return null;
  const check = await testConnection();
  if (!check.online) return null;
  await ensureRemoteTable();
  const p = getPool();
  try {
    const [rows] = await p.query(
      'SELECT id, username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database FROM `lab_users` WHERE username = ? OR email = ? LIMIT 1;',
      [clean, clean.toLowerCase()]
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      username: r.username,
      email: r.email,
      passwordHash: r.password_hash,
      role: r.role || 'user',
      canDeleteAll: Boolean(r.can_delete_all),
      canModifyInventory: Boolean(r.can_modify_inventory),
      canManageDatabase: Boolean(r.can_manage_database)
    };
  } catch (err) {
    console.warn('fetchRemoteUser notice:', err.message);
    return null;
  }
}

/**
 * Fetches all user records from remote MySQL.
 */
async function fetchRemoteUsers() {
  const check = await testConnection();
  if (!check.online) return [];
  await ensureRemoteTable();
  const p = getPool();
  try {
    const [rows] = await p.query(
      'SELECT id, username, email, password_hash, role, can_delete_all, can_modify_inventory, can_manage_database, last_login, created_at FROM `lab_users` ORDER BY id ASC;'
    );
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      email: r.email,
      passwordHash: r.password_hash,
      role: r.role || 'user',
      canDeleteAll: r.can_delete_all ? 1 : 0,
      canModifyInventory: r.can_modify_inventory ? 1 : 0,
      canManageDatabase: r.can_manage_database ? 1 : 0,
      lastLogin: r.last_login,
      createdAt: r.created_at
    }));
  } catch (err) {
    console.warn('fetchRemoteUsers notice:', err.message);
    return [];
  }
}

/**
 * Pushes a single audit log entry to remote MySQL.
 */
async function pushAuditRecordToRemote({ username, actionType, mpn, changeDetails, changedAt }) {
  const check = await testConnection();
  if (!check.online) return { ok: false, offline: true };
  await ensureRemoteTable();
  const p = getPool();
  try {
    await p.query(
      'INSERT INTO `inventory_audit_log` (`username`, `action_type`, `mpn`, `change_details`, `changed_at`) VALUES (?, ?, ?, ?, ?);',
      [
        String(username || 'Admin').trim(),
        String(actionType || 'UNKNOWN').toUpperCase(),
        String(mpn || '').trim(),
        String(changeDetails || '').trim(),
        changedAt ? new Date(changedAt) : new Date()
      ]
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Pushes a batch of audit log records to remote MySQL in a single query.
 */
async function pushAuditBatchToRemote(records = []) {
  if (!Array.isArray(records) || records.length === 0) return { ok: true, count: 0 };
  const check = await testConnection();
  if (!check.online) return { ok: false, offline: true };
  await ensureRemoteTable();
  const p = getPool();

  try {
    // Fetch recent 1000 remote logs to deduplicate
    const [existing] = await p.query(
      'SELECT username, action_type, mpn, change_details FROM `inventory_audit_log` ORDER BY id DESC LIMIT 1000;'
    );
    const existingSet = new Set(
      existing.map(r => `${String(r.username).trim()}|${String(r.action_type).trim().toUpperCase()}|${String(r.mpn || '').trim()}|${String(r.change_details || '').trim()}`)
    );

    const valuesToInsert = [];
    for (const r of records) {
      if (!r) continue;
      const u = String(r.username || 'Admin').trim();
      const a = String(r.actionType || r.action_type || 'UNKNOWN').trim().toUpperCase();
      const m = String(r.mpn || '').trim();
      const d = String(r.changeDetails || r.change_details || '').trim();
      const key = `${u}|${a}|${m}|${d}`;
      if (!existingSet.has(key)) {
        existingSet.add(key);
        const at = r.changedAt || r.changed_at ? new Date(r.changedAt || r.changed_at) : new Date();
        valuesToInsert.push([u, a, m, d, at]);
      }
    }

    if (valuesToInsert.length > 0) {
      await p.query(
        'INSERT INTO `inventory_audit_log` (`username`, `action_type`, `mpn`, `change_details`, `changed_at`) VALUES ?;',
        [valuesToInsert]
      );
    }

    return { ok: true, count: valuesToInsert.length };
  } catch (err) {
    console.warn('pushAuditBatchToRemote notice:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Fetches audit log records from remote MySQL.
 */
async function fetchRemoteAuditLogs(limit = 500) {
  const check = await testConnection();
  if (!check.online) return [];
  await ensureRemoteTable();
  const p = getPool();
  try {
    const [rows] = await p.query(
      'SELECT id, username, action_type, mpn, change_details, changed_at FROM `inventory_audit_log` ORDER BY id DESC LIMIT ?;',
      [Number(limit) || 500]
    );
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      actionType: r.action_type,
      action_type: r.action_type,
      mpn: r.mpn,
      changeDetails: r.change_details,
      change_details: r.change_details,
      changedAt: r.changed_at ? new Date(r.changed_at).toISOString().replace('T', ' ').slice(0, 19) : '',
      changed_at: r.changed_at ? new Date(r.changed_at).toISOString().replace('T', ' ').slice(0, 19) : ''
    }));
  } catch (err) {
    console.warn('fetchRemoteAuditLogs notice:', err.message);
    return [];
  }
}

/**
 * Upserts a project BOM and its items to remote MySQL database.
 */
async function pushBomToRemote({ name, boardsCount = 1, items = [], username = '' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { ok: false, error: 'BOM project name cannot be empty.' };

  const check = await testConnection();
  if (!check.online) {
    return { ok: false, offline: true, error: check.message };
  }

  await ensureRemoteTable();
  const p = getPool();
  const count = Math.max(1, Number(boardsCount) || 1);
  const author = String(username || '').trim() || 'Admin';
  const validItems = Array.isArray(items) ? items.filter(it => it && it.mpn && String(it.mpn).trim()) : [];

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(`
      INSERT INTO \`saved_boms\` (\`name\`, \`boards_count\`, \`items_count\`, \`created_by\`, \`deleted_at\`)
      VALUES (?, ?, ?, ?, NULL)
      ON DUPLICATE KEY UPDATE
        \`boards_count\` = VALUES(\`boards_count\`),
        \`items_count\` = VALUES(\`items_count\`),
        \`created_by\` = CASE WHEN VALUES(\`created_by\`) != '' THEN VALUES(\`created_by\`) ELSE \`created_by\` END,
        \`deleted_at\` = NULL,
        \`updated_at\` = CURRENT_TIMESTAMP;
    `, [cleanName, count, validItems.length, author]);

    const [rows] = await conn.query('SELECT id FROM `saved_boms` WHERE `name` = ? LIMIT 1;', [cleanName]);
    if (!rows || rows.length === 0) {
      throw new Error('Failed to retrieve remote BOM ID.');
    }
    const bomId = rows[0].id;

    await conn.query('DELETE FROM `saved_bom_items` WHERE `bom_id` = ?;', [bomId]);

    if (validItems.length > 0) {
      const values = validItems.map(it => [
        bomId,
        String(it.mpn || '').trim(),
        Math.max(1, Number(it.quantity) || 1),
        it.componentType || it.type || '',
        it.value || '',
        it.footprint || '',
        it.customerCode || it.designator || ''
      ]);
      await conn.query(`
        INSERT INTO \`saved_bom_items\` (\`bom_id\`, \`mpn\`, \`quantity\`, \`component_type\`, \`value\`, \`footprint\`, \`customer_code\`)
        VALUES ?;
      `, [values]);
    }

    await conn.commit();
    return { ok: true, bomId, name: cleanName, itemsCount: validItems.length };
  } catch (err) {
    await conn.rollback().catch(() => {});
    return { ok: false, error: err.message };
  } finally {
    conn.release();
  }
}

/**
 * Deletes a BOM project from remote MySQL database.
 */
async function deleteBomFromRemote(name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { ok: false, error: 'Project name cannot be empty.' };

  const check = await testConnection();
  if (!check.online) {
    return { ok: false, offline: true, error: check.message };
  }

  await ensureRemoteTable();
  const p = getPool();
  try {
    await p.query('DELETE FROM `saved_boms` WHERE `name` = ?;', [cleanName]);
    return { ok: true, name: cleanName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fetches all saved BOM projects and their items from remote MySQL.
 */
async function fetchRemoteBoms() {
  await ensureRemoteTable();
  const p = getPool();
  const [bomRows] = await p.query(
    'SELECT id, name, boards_count, items_count, created_by, created_at, updated_at FROM `saved_boms` WHERE deleted_at IS NULL ORDER BY updated_at DESC;'
  );

  const list = [];
  for (const b of bomRows) {
    const [itemRows] = await p.query(
      'SELECT id, mpn, quantity, component_type, value, footprint, customer_code FROM `saved_bom_items` WHERE bom_id = ? ORDER BY id ASC;',
      [b.id]
    );
    list.push({
      id: b.id,
      name: b.name,
      boardsCount: b.boards_count,
      boards_count: b.boards_count,
      itemsCount: b.items_count,
      items_count: b.items_count,
      createdBy: b.created_by || 'Admin',
      created_by: b.created_by || 'Admin',
      createdAt: b.created_at,
      created_at: b.created_at,
      updatedAt: b.updated_at,
      updated_at: b.updated_at,
      items: itemRows.map(it => ({
        id: it.id,
        mpn: it.mpn || '',
        quantity: Math.max(1, Number(it.quantity) || 1),
        componentType: it.component_type || '',
        type: it.component_type || '',
        value: it.value || '',
        footprint: it.footprint || '',
        customerCode: it.customer_code || ''
      }))
    });
  }
  return list;
}

/**
 * Synchronizes local components list with remote MySQL server.
 * Uses MPN as the unique key. If remote has newer/different parts, merges them in.
 *
 * @param {Array} localComponents Local component list
 * @returns {Promise<{ ok: boolean, message: string, mergedComponents?: Array, lastSyncTime?: string }>}
 */
async function sync(localComponents = [], mode = 'merge') {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    return { ok: false, message: 'MySQL sync is disabled in settings.' };
  }

  const check = await testConnection();
  if (!check.online) {
    return { ok: false, message: `Offline: ${check.message}` };
  }

  const sqliteDb = require('./sqliteDatabase');
  const p = getPool();

  try {
    if (mode === 'push') {
      // Overwrite Cloud: replace active cloud inventory with local components
      await ensureRemoteTable();
      await p.query('UPDATE `lab_inventory` SET `deleted_at` = CURRENT_TIMESTAMP WHERE `deleted_at` IS NULL;');
      await pushComponentsToRemote(localComponents);

      let bomsSyncedCount = 0;
      try {
        const localBoms = await sqliteDb.getAllSavedBomsWithItems();
        for (const lb of localBoms) {
          await pushBomToRemote(lb);
        }
        bomsSyncedCount = localBoms.length;
      } catch (bomErr) {
        console.warn('BOM push notice:', bomErr.message);
      }

      lastSyncTime = new Date().toLocaleTimeString();
      const bomMsg = bomsSyncedCount > 0 ? ` and ${bomsSyncedCount} BOM projects` : '';

      // Sync Users (Push to cloud)
      try {
        const localUsers = await sqliteDb.getAllUsers(true);
        for (const u of localUsers) {
          await pushUserToRemote(u);
        }
      } catch (userErr) {
        console.warn('User push notice:', userErr.message);
      }

      // Sync Audit Logs (Push to cloud)
      try {
        const localLogs = await sqliteDb.getAuditLogs({ limit: 1000 });
        await pushAuditBatchToRemote(localLogs.rows || []);
      } catch (logErr) {
        console.warn('Audit history push notice:', logErr.message);
      }

      return {
        ok: true,
        message: `Cloud database overwritten with local inventory (${localComponents.length} items${bomMsg}, users & history).`,
        mergedComponents: localComponents,
        lastSyncTime
      };
    }

    // Fetch remote components for 'pull' and 'merge'
    const remoteComponents = await fetchRemoteInventory();

    if (mode === 'pull') {
      // Overwrite Local: replace local inventory with cloud database
      await sqliteDb.saveAllComponents(remoteComponents);

      let bomsSyncedCount = 0;
      try {
        const remBoms = await fetchRemoteBoms();
        await sqliteDb.saveAllBomsWithItems(remBoms);
        bomsSyncedCount = remBoms.length;
      } catch (bomErr) {
        console.warn('BOM pull notice:', bomErr.message);
      }

      // Sync Users (Pull from cloud)
      try {
        const remUsers = await fetchRemoteUsers();
        for (const ru of remUsers) {
          await sqliteDb.saveUserFromRemote(ru);
        }
      } catch (userErr) {
        console.warn('User pull notice:', userErr.message);
      }

      // Sync Audit Logs (Pull from cloud)
      try {
        const remLogs = await fetchRemoteAuditLogs(1000);
        await sqliteDb.saveAuditLogsBatchFromRemote(remLogs);
      } catch (logErr) {
        console.warn('Audit history pull notice:', logErr.message);
      }

      lastSyncTime = new Date().toLocaleTimeString();
      const bomMsg = bomsSyncedCount > 0 ? ` and ${bomsSyncedCount} BOM projects` : '';
      return {
        ok: true,
        message: `Local inventory overwritten with cloud database (${remoteComponents.length} items${bomMsg}, users & history).`,
        mergedComponents: remoteComponents,
        lastSyncTime
      };
    }

    // Default: 'merge' (Bidirectional smart merge)
    const componentMap = new Map();
    for (const comp of localComponents) {
      if (!comp || !comp.mpn) continue;
      componentMap.set(String(comp.mpn).trim().toUpperCase(), { ...comp });
    }

    let addedFromRemote = 0;
    for (const rem of remoteComponents) {
      if (!rem || !rem.mpn) continue;
      const key = String(rem.mpn).trim().toUpperCase();
      if (!componentMap.has(key)) {
        componentMap.set(key, {
          mpn: rem.mpn,
          quantity: rem.quantity,
          componentType: rem.componentType,
          value: rem.value,
          footprint: rem.footprint,
          location: rem.location,
          customerCode: rem.customerCode,
          minStock: rem.minStock !== undefined ? rem.minStock : 10,
          unitPrice: rem.unitPrice !== undefined ? rem.unitPrice : 0.0,
          datasheetUrl: rem.datasheetUrl || '',
          supplierPartNo: rem.supplierPartNo || '',
          supplier: rem.supplier || ''
        });
        addedFromRemote++;
      }
    }

    const mergedList = Array.from(componentMap.values());
    await pushComponentsToRemote(mergedList);

    try {
      await sqliteDb.saveAllComponents(mergedList);
    } catch (sqliteErr) {
      console.warn('Could not update SQLite during sync:', sqliteErr.message);
    }

    let bomsSyncedCount = 0;
    try {
      const localBoms = await sqliteDb.getAllSavedBomsWithItems();
      const remBoms = await fetchRemoteBoms();
      const localMap = new Map(localBoms.map(b => [String(b.name).toLowerCase(), b]));
      for (const rb of remBoms) {
        if (!localMap.has(String(rb.name).toLowerCase())) {
          await sqliteDb.saveBomProject(rb);
          localMap.set(String(rb.name).toLowerCase(), rb);
        }
      }
      const finalBoms = await sqliteDb.getAllSavedBomsWithItems();
      for (const b of finalBoms) {
        await pushBomToRemote(b);
      }
      bomsSyncedCount = finalBoms.length;
    } catch (bomErr) {
      console.warn('BOM merge notice:', bomErr.message);
    }

    // Sync Users (Bidirectional merge)
    try {
      const localUsers = await sqliteDb.getAllUsers(true);
      const remUsers = await fetchRemoteUsers();
      const localUserMap = new Map(localUsers.map(u => [String(u.username).toLowerCase(), u]));
      for (const ru of remUsers) {
        if (!localUserMap.has(String(ru.username).toLowerCase())) {
          await sqliteDb.saveUserFromRemote(ru);
          localUserMap.set(String(ru.username).toLowerCase(), ru);
        }
      }
      for (const lu of localUsers) {
        await pushUserToRemote(lu);
      }
    } catch (userErr) {
      console.warn('User merge notice:', userErr.message);
    }

    // Sync Audit Logs (Bidirectional merge)
    try {
      const remLogs = await fetchRemoteAuditLogs(500);
      await sqliteDb.saveAuditLogsBatchFromRemote(remLogs);
      const localLogs = await sqliteDb.getAuditLogs({ limit: 500 });
      await pushAuditBatchToRemote(localLogs.rows || []);
    } catch (logErr) {
      console.warn('Audit history merge notice:', logErr.message);
    }

    lastSyncTime = new Date().toLocaleTimeString();
    const bomMsg = bomsSyncedCount > 0 ? `, ${bomsSyncedCount} BOM projects` : '';
    return {
      ok: true,
      message: `Sync complete! Synced ${mergedList.length} items (${addedFromRemote} new from server)${bomMsg}, users & history.`,
      mergedComponents: mergedList,
      lastSyncTime
    };
  } catch (err) {
    return { ok: false, message: `Sync failed: ${err.message}` };
  }
}

function getStatus() {
  const cfg = loadConfig();
  return {
    enabled: Boolean(cfg.enabled),
    host: cfg.host,
    database: cfg.database,
    lastSyncTime: lastSyncTime || 'Never'
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  testConnection,
  ensureRemoteTable,
  fetchRemoteInventory,
  pushComponentsToRemote,
  pushBomToRemote,
  deleteBomFromRemote,
  fetchRemoteBoms,
  pushUserToRemote,
  fetchRemoteUser,
  fetchRemoteUsers,
  pushAuditRecordToRemote,
  pushAuditBatchToRemote,
  fetchRemoteAuditLogs,
  sync,
  getStatus
};
