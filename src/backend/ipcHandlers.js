/**
 * ============================================================================
 * Backend IPC Handler Registry (Pure Database Edition)
 * ============================================================================
 * Centralizes all Inter-Process Communication (IPC) handlers for:
 *   - Local SQLite database operations (`data/lab_inventory.db`)
 *   - Remote MySQL synchronization
 *   - Window state controls & native message boxes
 */

const { ipcMain, dialog } = require('electron');
const sqliteDb = require('./sqliteDatabase');
const mysqlClient = require('./mysqlClient');

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
   * Opens a native dialog to import components from an external SQLite (.db) database file.
   */
  ipcMain.handle('db:import-file', async (_event, title = 'Import SQLite Database File') => {
    const win = getMainWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title,
      filters: [
        { name: 'SQLite Database (*.db, *.sqlite, *.sqlite3)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return { canceled: true };
    }

    return sqliteDb.importFromExternalDbFile(filePaths[0]);
  });

  /**
   * Opens a native dialog to export inventory to an external SQLite (.db) database file.
   */
  ipcMain.handle('db:export-file', async (_event, { title, defaultPath, components }) => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: title || 'Export Inventory as SQLite Database',
      defaultPath: defaultPath || 'lab_inventory_backup.db',
      filters: [
        { name: 'SQLite Database (*.db)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    return sqliteDb.exportToExternalDbFile(filePath, components);
  });

  /**
   * Opens a native dialog to save a clean starter SQLite database template (.db).
   */
  ipcMain.handle('db:export-template', async () => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save SQLite Database Template',
      defaultPath: 'lab_inventory_template.db',
      filters: [
        { name: 'SQLite Database (*.db)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    return sqliteDb.exportTemplateDbFile(filePath);
  });

  /**
   * Opens a native dialog to export BOM Availability & Shortage Report as a SQLite (.db) file.
   */
  ipcMain.handle('db:export-bom-report', async (_event, { defaultPath, boardName, boardsCount, analysisItems }) => {
    const win = getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export BOM Availability Report Database',
      defaultPath: defaultPath || 'BOM_Availability_Report.db',
      filters: [
        { name: 'SQLite Database (*.db)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    return sqliteDb.exportBomReportToDbFile(filePath, boardName, boardsCount, analysisItems);
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
  ipcMain.handle('mysql:get-config', () => {
    return mysqlClient.loadConfig();
  });

  /**
   * Saves new MySQL connection configuration.
   */
  ipcMain.handle('mysql:save-config', (_event, newConfig) => {
    const updated = mysqlClient.saveConfig(newConfig);
    return { ok: true, config: updated };
  });

  /**
   * Tests connection with provided credentials without saving.
   */
  ipcMain.handle('mysql:test-connection', async (_event, customConfig) => {
    return mysqlClient.testConnection(customConfig);
  });

  /**
   * Triggers bidirectional sync between local SQLite and remote MySQL.
   */
  ipcMain.handle('mysql:sync-now', async (_event, localComponents) => {
    const result = await mysqlClient.sync(localComponents);
    return result;
  });

  // --------------------------------------------------------------------------
  // 4. Custom Window Title Bar Controls (Spotify / Google Style)
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
