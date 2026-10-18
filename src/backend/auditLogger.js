/**
 * ============================================================================
 * Inventory Change Audit Logger
 * ============================================================================
 * Records and tracks every inventory modification (Add, Edit, Delete, Import,
 * Clear, Stock Step, BOM Deduct, Save, Revert) along with who made the change
 * and the exact date and time.
 *
 * Persisted in `inventory_audit_log` inside `data/lab_inventory.db` (SQLite)
 * and optionally synced to remote MySQL.
 */

const sqliteDb = require('./sqliteDatabase');
const authService = require('./authService');
const mysqlClient = require('./mysqlClient');

/**
 * Formats diff between two component objects into a readable text summary.
 *
 * @param {Object} oldComp
 * @param {Object} newComp
 * @returns {string} Human-readable diff summary
 */
function diffComponent(oldComp, newComp) {
  if (!oldComp) {
    return `Created part: Qty ${newComp.quantity || 0}, Loc: ${newComp.location || 'N/A'}, Type: ${newComp.type || 'N/A'}`;
  }

  const changes = [];
  if (oldComp.quantity !== newComp.quantity) {
    const diff = newComp.quantity - oldComp.quantity;
    const sign = diff > 0 ? `+${diff}` : `${diff}`;
    changes.push(`Qty: ${oldComp.quantity} → ${newComp.quantity} (${sign})`);
  }
  if (oldComp.location !== newComp.location) {
    changes.push(`Loc: '${oldComp.location || 'N/A'}' → '${newComp.location || 'N/A'}'`);
  }
  if (oldComp.value !== newComp.value) {
    changes.push(`Value: '${oldComp.value || 'N/A'}' → '${newComp.value || 'N/A'}'`);
  }
  if (oldComp.footprint !== newComp.footprint) {
    changes.push(`Footprint: '${oldComp.footprint || 'N/A'}' → '${newComp.footprint || 'N/A'}'`);
  }
  if (oldComp.type !== newComp.type && oldComp.componentType !== newComp.componentType) {
    changes.push(`Type: '${oldComp.type || oldComp.componentType || 'N/A'}' → '${newComp.type || newComp.componentType || 'N/A'}'`);
  }
  if (oldComp.customerCode !== newComp.customerCode) {
    changes.push(`Customer Code: '${oldComp.customerCode || 'N/A'}' → '${newComp.customerCode || 'N/A'}'`);
  }

  return changes.length > 0 ? changes.join(' | ') : 'No field changes detected';
}

/**
 * Records an inventory change in the audit log.
 *
 * @param {Object} params
 * @param {string} [params.username] Username override (defaults to current session user)
 * @param {string} params.actionType 'ADD' | 'EDIT' | 'DELETE' | 'STOCK_STEP' | 'IMPORT' | 'CLEAR_ALL' | 'BOM_DEDUCT' | 'REVERT' | 'SAVE'
 * @param {string} [params.mpn] Component MPN or batch identifier
 * @param {string} params.changeDetails Human readable description
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function logChange({ username, actionType, mpn = '', changeDetails }) {
  const currentUser = authService.getCurrentUser();
  const effectiveUser = username || (currentUser ? currentUser.username : 'Anonymous');

  const res = await sqliteDb.insertAuditLog({
    username: effectiveUser,
    actionType: String(actionType || 'UNKNOWN').toUpperCase(),
    mpn: String(mpn || '').trim(),
    changeDetails: String(changeDetails || '').trim()
  });

  // Optional: push to MySQL if connected
  try {
    const status = await mysqlClient.getStatus();
    if (status.enabled && status.connected) {
      const pool = mysqlClient.getPool();
      if (pool) {
        await pool.query(
          'INSERT INTO `inventory_audit_log` (`username`, `action_type`, `mpn`, `change_details`, `changed_at`) VALUES (?, ?, ?, ?, NOW())',
          [effectiveUser, actionType, mpn, changeDetails]
        );
      }
    }
  } catch (err) {
    // Non-fatal if MySQL audit sync fails
    console.warn('MySQL audit sync notice:', err.message);
  }

  return res;
}

/**
 * Retrieves audit log records with optional search filter and limit.
 */
async function getHistory({ limit = 100, search = '', action = '' } = {}) {
  return sqliteDb.getAuditLogs({ limit, search, action });
}

module.exports = {
  diffComponent,
  logChange,
  getHistory
};
