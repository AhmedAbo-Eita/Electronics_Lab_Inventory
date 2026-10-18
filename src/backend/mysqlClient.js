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

/**
 * Closes and resets the connection pool.
 */
function resetPool() {
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
      connectTimeout: customConfig.connectTimeout || 4000,
      waitForConnections: true,
      connectionLimit: 4
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
      connectTimeout: cfg.connectTimeout || 4000,
      waitForConnections: true,
      connectionLimit: 4
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
 * Ensures the `lab_inventory` table exists on the remote database.
 */
async function ensureRemoteTable() {
  const p = getPool();
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS \`lab_inventory\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`mpn\` VARCHAR(120) NOT NULL UNIQUE,
      \`quantity\` INT NOT NULL DEFAULT 0,
      \`component_type\` VARCHAR(80) DEFAULT '',
      \`value\` VARCHAR(80) DEFAULT '',
      \`footprint\` VARCHAR(80) DEFAULT '',
      \`location\` VARCHAR(120) DEFAULT '',
      \`customer_code\` VARCHAR(80) DEFAULT '',
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`deleted_at\` TIMESTAMP NULL DEFAULT NULL,
      INDEX \`idx_mpn\` (\`mpn\`),
      INDEX \`idx_type\` (\`component_type\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS \`lab_users\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`username\` VARCHAR(80) NOT NULL UNIQUE,
      \`email\` VARCHAR(120) NOT NULL UNIQUE,
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`last_login\` DATETIME NULL DEFAULT NULL,
      \`last_failed_login\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_username\` (\`username\`),
      INDEX \`idx_email\` (\`email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
  `;
  await p.query(createTableSql);
}

/**
 * Fetches all active inventory components from MySQL.
 */
async function fetchRemoteInventory() {
  await ensureRemoteTable();
  const p = getPool();
  const [rows] = await p.query(
    'SELECT mpn, quantity, component_type, value, footprint, location, customer_code, updated_at FROM `lab_inventory` WHERE deleted_at IS NULL ORDER BY mpn ASC'
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
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0
  }));
}

/**
 * Upserts a batch of components into MySQL.
 */
async function pushComponentsToRemote(components) {
  if (!components || components.length === 0) return { insertedOrUpdated: 0 };
  await ensureRemoteTable();
  const p = getPool();

  const sql = `
    INSERT INTO \`lab_inventory\`
      (\`mpn\`, \`quantity\`, \`component_type\`, \`value\`, \`footprint\`, \`location\`, \`customer_code\`, \`updated_at\`, \`deleted_at\`)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      \`quantity\` = VALUES(\`quantity\`),
      \`component_type\` = VALUES(\`component_type\`),
      \`value\` = VALUES(\`value\`),
      \`footprint\` = VALUES(\`footprint\`),
      \`location\` = VALUES(\`location\`),
      \`customer_code\` = VALUES(\`customer_code\`),
      \`updated_at\` = CURRENT_TIMESTAMP,
      \`deleted_at\` = NULL;
  `;

  const values = components.map(c => [
    c.mpn,
    Number(c.quantity) || 0,
    c.componentType || c.type || '',
    c.value || '',
    c.footprint || '',
    c.location || '',
    c.customerCode || '',
    new Date(),
    null
  ]);

  const [result] = await p.query(sql, [values]);
  return { insertedOrUpdated: result.affectedRows };
}

/**
 * Synchronizes local components list with remote MySQL server.
 * Uses MPN as the unique key. If remote has newer/different parts, merges them in.
 *
 * @param {Array} localComponents Local component list
 * @returns {Promise<{ ok: boolean, message: string, mergedComponents?: Array, lastSyncTime?: string }>}
 */
async function sync(localComponents = []) {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    return { ok: false, message: 'MySQL sync is disabled in settings.' };
  }

  const check = await testConnection();
  if (!check.online) {
    return { ok: false, message: `Offline: ${check.message}` };
  }

  try {
    // 1. Fetch remote rows from MySQL
    const remoteComponents = await fetchRemoteInventory();

    // 2. Build map of local components
    const componentMap = new Map();
    for (const comp of localComponents) {
      if (!comp.mpn) continue;
      componentMap.set(comp.mpn.toUpperCase(), { ...comp });
    }

    // 3. Merge remote components (add if not present locally)
    let addedFromRemote = 0;
    for (const rem of remoteComponents) {
      const key = rem.mpn.toUpperCase();
      if (!componentMap.has(key)) {
        componentMap.set(key, {
          mpn: rem.mpn,
          quantity: rem.quantity,
          componentType: rem.componentType,
          value: rem.value,
          footprint: rem.footprint,
          location: rem.location,
          customerCode: rem.customerCode
        });
        addedFromRemote++;
      }
    }

    const mergedList = Array.from(componentMap.values());

    // 4. Push full merged inventory back to MySQL to ensure total parity
    await pushComponentsToRemote(mergedList);

    // 5. Persist merged components to local SQLite database
    try {
      const sqliteDb = require('./sqliteDatabase');
      await sqliteDb.saveAllComponents(mergedList);
    } catch (sqliteErr) {
      console.warn('Could not update SQLite during sync:', sqliteErr.message);
    }

    lastSyncTime = new Date().toLocaleTimeString();
    return {
      ok: true,
      message: `Sync complete! Synced ${mergedList.length} items (${addedFromRemote} new from server).`,
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
  sync,
  getStatus
};
