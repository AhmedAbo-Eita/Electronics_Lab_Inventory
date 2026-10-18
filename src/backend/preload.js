/**
 * ============================================================================
 * Preload Script (Context Isolation Bridge)
 * ============================================================================
 * Exposes a secure, typed API bridge (`window.electronAPI`) from the Node.js
 * main process to the browser renderer process without enabling nodeIntegration.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Initializes the SQLite database and returns the inventory records.
   * @returns {Promise<{ ok: boolean, list: Array, path?: string, error?: string }>}
   */
  initAndLoadDB: () => ipcRenderer.invoke('db:init-and-load'),

  /**
   * Saves inventory components directly to the persistent SQLite database file.
   * @param {Array} components
   * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
   */
  saveDB: (components) => ipcRenderer.invoke('db:save', components),

  /**
   * Opens a native dialog to import an external SQLite (.db) database file.
   */
  importDBDialog: (title) => ipcRenderer.invoke('db:import-file', title),

  /**
   * Opens a native dialog to export inventory to an external SQLite (.db) database file.
   */
  exportDBDialog: (payload) => ipcRenderer.invoke('db:export-file', payload),

  /**
   * Opens a native dialog to save a starter SQLite database template (.db).
   */
  saveTemplateDB: () => ipcRenderer.invoke('db:export-template'),

  /**
   * Opens a native dialog to import a BOM from Excel (.xlsx), CSV, or SQLite (.db).
   */
  importBomDialog: (title) => ipcRenderer.invoke('db:import-bom', title),

  /**
   * Opens a native dialog to export BOM Availability & Shortage Report as a SQLite (.db) file.
   */
  exportBomReportDB: (payload) => ipcRenderer.invoke('db:export-bom-report', payload),

  /**
   * Updates application dirty state (controls window title asterisk and close guard).
   * @param {boolean} isDirty
   * @returns {Promise<boolean>}
   */
  setDirty: (isDirty) => ipcRenderer.invoke('app:set-dirty', isDirty),

  /**
   * Confirms force closing the application (bypasses unsaved changes prompt).
   * @returns {Promise<void>}
   */
  confirmForceClose: () => ipcRenderer.invoke('app:confirm-force-close'),

  /**
   * Subscribes to the save-and-close request triggered when user chooses 'Yes' on close prompt.
   * @param {() => void} callback
   */
  onRequestSaveAndClose: (callback) => {
    ipcRenderer.on('app:request-save-and-close', () => callback());
  },

  /**
   * Shows a native dialog message box.
   * @param {Electron.MessageBoxOptions} options
   * @returns {Promise<Electron.MessageBoxReturnValue>}
   */
  showMessage: (options) => ipcRenderer.invoke('dialog:message', options),

  /**
   * Retrieves current MySQL connectivity and sync status.
   */
  getMySQLStatus: () => ipcRenderer.invoke('mysql:get-status'),

  /**
   * Loads saved MySQL connection config.
   */
  getMySQLConfig: () => ipcRenderer.invoke('mysql:get-config'),

  /**
   * Saves updated MySQL connection config.
   */
  saveMySQLConfig: (config) => ipcRenderer.invoke('mysql:save-config', config),

  /**
   * Tests connection with provided credentials.
   */
  testMySQLConnection: (config) => ipcRenderer.invoke('mysql:test-connection', config),

  /**
   * Triggers two-way synchronization between local SQLite and remote MySQL.
   */
  syncMySQLNow: (components) => ipcRenderer.invoke('mysql:sync-now', components),

  /**
   * Minimizes the frameless window.
   */
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),

  /**
   * Toggles maximization of the frameless window.
   * @returns {Promise<boolean>} Current maximized state
   */
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),

  /**
   * Closes the window (triggers close interception if unsaved changes exist).
   */
  closeWindow: () => ipcRenderer.invoke('window:close'),

  /**
   * Checks whether the window is currently maximized.
   * @returns {Promise<boolean>}
   */
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /**
   * Subscribes to window maximize/unmaximize state changes to update the titlebar icon.
   * @param {(isMaximized: boolean) => void} callback
   */
  onWindowStateChange: (callback) => {
    ipcRenderer.on('window:state-change', (_event, isMax) => callback(isMax));
  }
});
