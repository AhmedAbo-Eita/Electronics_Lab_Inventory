/**
 * ============================================================================
 * Backend IPC Handler Registry (Pure Database Edition)
 * ============================================================================
 * Centralizes all Inter-Process Communication (IPC) handlers for:
 *   - Local SQLite database operations (`data/lab_inventory.db`)
 *   - Remote MySQL synchronization
 *   - Window state controls & native message boxes
 */

const { ipcMain, dialog, app, shell } = require('electron');
const path = require('path');
const sqliteDb = require('./sqliteDatabase');
const mysqlClient = require('./mysqlClient');
const spreadsheetHelper = require('./spreadsheetHelper');
const authService = require('./authService');
const auditLogger = require('./auditLogger');
const appSettings = require('./appSettings');
const updaterService = require('./updaterService');

/**
 * Registers all application IPC handlers.
 *
 * @param {Object} context App context dependencies
 * @param {() => Electron.BrowserWindow | null} context.getMainWindow Getter for main window
 * @param {(dirty: boolean) => void} context.setDirtyState Callback to update unsaved dirty state
 * @param {() => boolean} context.getDirtyState Getter for unsaved dirty state
 * @param {() => void} context.setForceClose Callback to set forceClose flag
 */
function registerIpcHandlers({ getMainWindow, setDirtyState, getDirtyState, setForceClose }) {
  // --------------------------------------------------------------------------
  // 1. Local SQLite Database Operations
  // --------------------------------------------------------------------------

  /**
   * Initializes and loads all inventory items from the local SQLite database.
   */
  ipcMain.handle('db:init-and-load', async () => {
    try {
      await authService.ensureAdminUser();
      const res = await sqliteDb.getAllComponents();
      return {
        ok: res.ok,
        list: res.list || [],
        path: res.path,
        error: res.error
      };
    } catch (err) {
      return { ok: false, list: [], error: err.message };
    }
  });

  /**
   * Saves updated inventory directly to SQLite database file (`data/lab_inventory.db`).
   */
  ipcMain.handle('db:save', async (_event, components) => {
    try {
      const currentUser = await authService.getCurrentUser();
      if (currentUser) {
        const isAdmin = currentUser.role === 'admin' || String(currentUser.username).toLowerCase() === 'admin';
        if (!isAdmin && !currentUser.canModifyInventory) {
          return { ok: false, error: 'Permission denied: Your account has explore-only access and cannot modify the database.' };
        }
        if (Array.isArray(components) && components.length === 0) {
          if (!isAdmin && !currentUser.canDeleteAll) {
            return { ok: false, error: 'Permission denied: You do not have permission to delete all inventory data.' };
          }
        }
      }
      const res = await sqliteDb.saveAllComponents(components);
      if (res.ok) {
        setDirtyState(false);
      }
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Opens a native dialog to import components from an Excel (.xlsx / .xls), CSV, or SQLite (.db) file.
   */
  ipcMain.handle('db:import-file', async (_event, title = 'Import Inventory (Excel / CSV / DB)') => {
    const win = getMainWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title,
      filters: [
        { name: 'Excel & CSV Spreadsheets (*.xlsx, *.csv, *.xls)', extensions: ['xlsx', 'csv', 'xls'] },
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'SQLite Database (*.db, *.sqlite)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = filePaths[0];
    const ext = path.extname(selectedPath).toLowerCase();

    if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') {
      return sqliteDb.importFromExternalDbFile(selectedPath);
    } else {
      return spreadsheetHelper.readInventorySpreadsheet(selectedPath);
    }
  });

  /**
   * Opens a native dialog to export inventory to an Excel (.xlsx), CSV, or SQLite (.db) file.
   */
  ipcMain.handle('db:export-file', async (_event, { title, defaultPath, components }) => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: title || 'Export Inventory (Excel / CSV / DB)',
      defaultPath: defaultPath || 'My_Lab_Inventory.xlsx',
      filters: [
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'SQLite Database (*.db)', extensions: ['db', 'sqlite'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.db' || ext === '.sqlite') {
      return sqliteDb.exportToExternalDbFile(filePath, components);
    } else {
      return spreadsheetHelper.writeInventorySpreadsheet(filePath, components);
    }
  });

  /**
   * Opens a native dialog to save a clean starter template (Excel .xlsx, CSV, or SQLite .db).
   */
  ipcMain.handle('db:export-template', async () => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Inventory Template (Excel / CSV / DB)',
      defaultPath: 'Lab_Inventory_Template.xlsx',
      filters: [
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'SQLite Database (*.db)', extensions: ['db'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.db') {
      return sqliteDb.exportTemplateDbFile(filePath);
    } else {
      return spreadsheetHelper.writeTemplateSpreadsheet(filePath);
    }
  });

  /**
   * Opens a native dialog to import a BOM from Excel (.xlsx / .xls), CSV, or SQLite (.db).
   */
  ipcMain.handle('db:import-bom', async (_event, title = 'Import BOM (Excel / CSV / DB)') => {
    const win = getMainWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title,
      filters: [
        { name: 'BOM Files (*.xlsx, *.csv, *.xls)', extensions: ['xlsx', 'csv', 'xls'] },
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'SQLite Database (*.db, *.sqlite)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = filePaths[0];
    const ext = path.extname(selectedPath).toLowerCase();

    if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') {
      return sqliteDb.importFromExternalDbFile(selectedPath);
    } else {
      return spreadsheetHelper.readBomSpreadsheet(selectedPath);
    }
  });

  /**
   * Opens a native dialog to export BOM Availability & Shortage Report as Excel (.xlsx), CSV, or SQLite (.db).
   */
  ipcMain.handle('db:export-bom-report', async (_event, { defaultPath, boardName, boardsCount, analysisItems }) => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export BOM Availability Report',
      defaultPath: defaultPath || `${boardName || 'Board'}_Availability_Report.xlsx`,
      filters: [
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'SQLite Database (*.db)', extensions: ['db', 'sqlite'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.db' || ext === '.sqlite') {
      return sqliteDb.exportBomReportToDbFile(filePath, boardName, boardsCount, analysisItems);
    } else {
      return spreadsheetHelper.writeBomReportSpreadsheet(filePath, boardName, boardsCount, analysisItems);
    }
  });

  /**
   * Opens a native dialog to export an Assembly Component Pick / Kitting List as Excel (.xlsx) or CSV.
   */
  ipcMain.handle('db:export-assembly-list', async (_event, { defaultPath, boardName, boardsCount, analysisItems }) => {
    const win = getMainWindow();
    const safeBoard = (boardName || 'Board').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const safeCount = Math.max(1, Number(boardsCount) || 1);

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export Assembly Pick List',
      defaultPath: defaultPath || `${safeBoard}_Assembly_List_${safeCount}boards.xlsx`,
      filters: [
        { name: 'Excel Workbook (*.xlsx)', extensions: ['xlsx'] },
        { name: 'CSV (Comma delimited) (*.csv)', extensions: ['csv'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    return spreadsheetHelper.writeAssemblyPickListSpreadsheet(filePath, boardName, boardsCount, analysisItems);
  });

  // --------------------------------------------------------------------------
  // BOM Project Saving & Management (Local SQLite & Online MySQL)
  // --------------------------------------------------------------------------

  /**
   * Saves or updates a complete BOM project in SQLite and pushes to remote MySQL if online.
   */
  ipcMain.handle('bom:save-project', async (_event, { name, boardsCount, items }) => {
    try {
      const currentUser = await authService.getCurrentUser();
      if (currentUser) {
        const isAdmin = currentUser.role === 'admin' || String(currentUser.username).toLowerCase() === 'admin';
        if (!isAdmin && !currentUser.canModifyInventory) {
          return { ok: false, error: 'Permission denied: Your account cannot modify database projects.' };
        }
      }

      const author = currentUser ? currentUser.username : 'Admin';
      const localRes = await sqliteDb.saveBomProject({
        name,
        boardsCount,
        items,
        username: author
      });

      if (!localRes.ok) {
        return localRes;
      }

      // Check if remote MySQL is enabled and attempt push
      let syncedOnline = false;
      let onlineError = null;
      const cfg = mysqlClient.loadConfig();
      if (cfg && cfg.enabled) {
        try {
          const test = await mysqlClient.testConnection();
          if (test.online) {
            const pushRes = await mysqlClient.pushBomToRemote({
              name,
              boardsCount,
              items,
              username: author
            });
            if (pushRes && pushRes.ok) {
              syncedOnline = true;
            } else {
              onlineError = pushRes.error || 'Failed to sync to online database.';
            }
          } else {
            onlineError = test.message;
          }
        } catch (err) {
          onlineError = err.message;
        }
      }

      // Audit log (non-fatal)
      try {
        const syncTag = syncedOnline ? ' [Local & Online MySQL]' : ' [Local SQLite]';
        await auditLogger.logChange({
          username: author,
          actionType: 'BOM_SAVE',
          mpn: name,
          changeDetails: `Saved BOM project '${name}' (${(items || []).length} parts, ${boardsCount || 1} boards)${syncTag}`
        });
      } catch (auditErr) {
        console.warn('Audit log notice on BOM_SAVE:', auditErr.message);
      }

      return {
        ok: true,
        name: localRes.name,
        bomId: localRes.bomId,
        boardsCount: localRes.boardsCount,
        itemsCount: localRes.itemsCount,
        syncedOnline,
        onlineError
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Retrieves the list of all saved BOM projects from SQLite.
   */
  ipcMain.handle('bom:list-saved', async () => {
    try {
      return await sqliteDb.getSavedBomsList();
    } catch (err) {
      return { ok: false, list: [], error: err.message };
    }
  });

  /**
   * Loads a saved BOM project with its component items.
   */
  ipcMain.handle('bom:load-project', async (_event, name) => {
    try {
      return await sqliteDb.getSavedBom(name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Deletes a saved BOM project from local SQLite and remote MySQL.
   */
  ipcMain.handle('bom:delete-project', async (_event, name) => {
    try {
      const currentUser = await authService.getCurrentUser();
      if (currentUser) {
        const isAdmin = currentUser.role === 'admin' || String(currentUser.username).toLowerCase() === 'admin';
        if (!isAdmin && !currentUser.canModifyInventory) {
          return { ok: false, error: 'Permission denied: Your account cannot delete BOM projects.' };
        }
      }

      const res = await sqliteDb.deleteSavedBom(name);
      if (res.ok) {
        const cfg = mysqlClient.loadConfig();
        if (cfg && cfg.enabled) {
          try {
            await mysqlClient.deleteBomFromRemote(name);
          } catch {}
        }

        const author = currentUser ? currentUser.username : 'Admin';
        try {
          await auditLogger.logChange({
            username: author,
            actionType: 'BOM_DELETE',
            mpn: name,
            changeDetails: `Deleted BOM project '${name}' from database`
          });
        } catch (auditErr) {
          console.warn('Audit log notice on BOM_DELETE:', auditErr.message);
        }
      }
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Performs an immediate sync of BOM projects between local SQLite and remote MySQL.
   */
  ipcMain.handle('bom:sync-remote', async () => {
    try {
      const componentsRes = await sqliteDb.getAllComponents();
      return await mysqlClient.sync(componentsRes.list || [], 'merge');
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // --------------------------------------------------------------------------
  // 2. Application & Dirty State
  // --------------------------------------------------------------------------

  /**
   * Updates the dirty (unsaved modifications) state and window title (* indicator).
   */
  ipcMain.handle('app:set-dirty', (_event, isDirty) => {
    setDirtyState(Boolean(isDirty));
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.setTitle(Boolean(isDirty) ? 'Lab Inventory *' : 'Lab Inventory');
    }
    return true;
  });

  /**
   * Allows the frontend to bypass the unsaved changes prompt and close immediately.
   */
  ipcMain.handle('app:confirm-force-close', () => {
    setForceClose();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  /**
   * Displays native message / confirmation box to the user.
   */
  ipcMain.handle('dialog:message', async (_event, options) => {
    const win = getMainWindow();
    return dialog.showMessageBox(win, options);
  });

  // --------------------------------------------------------------------------
  // 3. Online Database & Remote MySQL Synchronization
  // --------------------------------------------------------------------------

  /**
   * Retrieves current MySQL connectivity and sync status.
   */
  ipcMain.handle('mysql:get-status', async () => {
    const status = mysqlClient.getStatus();
    const test = await mysqlClient.testConnection();
    return {
      ...status,
      online: test.online,
      message: test.message
    };
  });

  /**
   * Returns current stored MySQL configuration.
   */
  ipcMain.handle('mysql:get-config', async () => {
    const user = await authService.getCurrentUser();
    const isAllowed = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin' || user.canManageDatabase);
    if (!isAllowed) {
      return { ok: false, error: 'Unauthorized: Permission to view database configuration is required.' };
    }
    return mysqlClient.loadConfig();
  });

  /**
   * Saves new MySQL connection configuration.
   */
  ipcMain.handle('mysql:save-config', async (_event, newConfig) => {
    const user = await authService.getCurrentUser();
    const isAllowed = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin' || user.canManageDatabase);
    if (!isAllowed) {
      return { ok: false, error: 'Unauthorized: Permission to manage database is required.' };
    }
    const updated = mysqlClient.saveConfig(newConfig);
    return { ok: true, config: updated };
  });

  /**
   * Tests connection with provided credentials without saving.
   */
  ipcMain.handle('mysql:test-connection', async (_event, customConfig) => {
    const user = await authService.getCurrentUser();
    const isAllowed = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin' || user.canManageDatabase);
    if (!isAllowed) {
      return { online: false, message: 'Unauthorized: Permission to manage database is required.' };
    }
    return mysqlClient.testConnection(customConfig);
  });

  /**
   * Triggers bidirectional sync between local SQLite and remote MySQL.
   */
  ipcMain.handle('mysql:sync-now', async (_event, localComponents, mode = 'merge') => {
    const result = await mysqlClient.sync(localComponents, mode);
    return result;
  });

  // --------------------------------------------------------------------------
  // 4. User Authentication & Encrypted Account Management
  // --------------------------------------------------------------------------

  ipcMain.handle('auth:register', async (_event, payload) => {
    return authService.registerUser(payload);
  });

  ipcMain.handle('auth:login', async (_event, credentials) => {
    return authService.loginUser(credentials);
  });

  ipcMain.handle('auth:get-current-user', async () => {
    return authService.getCurrentUser();
  });

  ipcMain.handle('auth:logout', () => {
    return authService.logoutUser();
  });

  ipcMain.handle('auth:update-email', async (_event, payload) => {
    return authService.changeUserEmail(payload);
  });

  ipcMain.handle('auth:update-password', async (_event, payload) => {
    return authService.changeUserPassword(payload);
  });

  ipcMain.handle('users:get-all', async () => {
    return authService.getAllUsers();
  });

  ipcMain.handle('users:update-permissions', async (_event, payload) => {
    const res = await authService.updateUserPermissions(payload);
    if (res && res.ok && payload && payload.permissions) {
      const adminUser = authService.getCurrentUserSync();
      const adminName = adminUser ? adminUser.username : 'admin';
      await auditLogger.logChange({
        username: adminName,
        actionType: 'PERMISSIONS',
        mpn: payload.targetUsername,
        changeDetails: `Updated permissions for ${payload.targetUsername}: Delete All=${payload.permissions.canDeleteAll ? 'YES' : 'NO'}, Modify=${payload.permissions.canModifyInventory ? 'YES' : 'NO'}`
      });
    }
    return res;
  });

  // --------------------------------------------------------------------------
  // 5. Application Preferences & Startup Settings
  // --------------------------------------------------------------------------

  ipcMain.handle('app:get-settings', () => {
    return appSettings.loadSettings();
  });

  ipcMain.handle('app:save-settings', (_event, newSettings) => {
    return appSettings.saveSettings(newSettings);
  });

  ipcMain.handle('app:get-auto-start', () => {
    return appSettings.getAutoStart();
  });

  ipcMain.handle('app:set-auto-start', (_event, openAtLogin) => {
    return appSettings.setAutoStart(openAtLogin);
  });

  // --------------------------------------------------------------------------
  // 6. Application Updates & GitHub Repository Release Engine
  // --------------------------------------------------------------------------

  ipcMain.handle('app:check-for-updates', async (_event, options) => {
    return updaterService.checkForUpdates(options);
  });

  ipcMain.handle('app:download-update', async (event, payload) => {
    return updaterService.downloadReleaseAsset(payload, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('app:update-download-progress', progress);
      }
    });
  });

  ipcMain.handle('app:open-downloaded-file', (_event, filePath) => {
    return updaterService.openDownloadedFile(filePath);
  });

  ipcMain.handle('app:run-installer', (_event, filePath) => {
    return updaterService.runInstaller(filePath);
  });

  ipcMain.handle('app:open-external', (_event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: 'Invalid URL' };
  });

  ipcMain.handle('app:get-system-info', () => {
    return {
      appName: 'Lab Inventory',
      appVersion: app ? app.getVersion() : '2.1.2',
      electronVersion: process.versions.electron || '33.2.0',
      chromeVersion: process.versions.chrome || '130.0',
      nodeVersion: process.versions.node || '20.18',
      platform: process.platform,
      arch: process.arch
    };
  });

  // --------------------------------------------------------------------------
  // 7. Inventory Change Audit History
  // --------------------------------------------------------------------------

  ipcMain.handle('audit:log-change', async (_event, payload) => {
    return auditLogger.logChange(payload);
  });

  ipcMain.handle('audit:get-history', async (_event, filter) => {
    return auditLogger.getHistory(filter);
  });

  // --------------------------------------------------------------------------
  // 6. Custom Window Title Bar Controls (Spotify / Google Style)
  // --------------------------------------------------------------------------

  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
  });

  ipcMain.handle('window:maximize-toggle', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      return win.isMaximized();
    }
    return false;
  });

  ipcMain.handle('window:close', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('window:is-maximized', () => {
    const win = getMainWindow();
    return Boolean(win && !win.isDestroyed() && win.isMaximized());
  });
}

module.exports = {
  registerIpcHandlers
};
