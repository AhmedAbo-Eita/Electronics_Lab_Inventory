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
   * Subscribes to the in-app close prompt when closing window with unsaved changes.
   * @param {() => void} callback
   */
  onPromptCloseSave: (callback) => {
    ipcRenderer.on('app:prompt-close-save', () => callback());
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
  },

  /**
   * Registers a new user with encrypted password.
   */
  registerUser: (payload) => ipcRenderer.invoke('auth:register', payload),

  /**
   * Authenticates user credentials.
   */
  loginUser: (credentials) => ipcRenderer.invoke('auth:login', credentials),

  /**
   * Gets currently authenticated session user.
   */
  getCurrentUser: () => ipcRenderer.invoke('auth:get-current-user'),

  /**
   * Updates user email address.
   */
  updateUserEmail: (payload) => ipcRenderer.invoke('auth:update-email', payload),

  /**
   * Updates user password.
   */
  updateUserPassword: (payload) => ipcRenderer.invoke('auth:update-password', payload),

  /**
   * Retrieves all users (admin only).
   */
  getAllUsers: () => ipcRenderer.invoke('users:get-all'),

  /**
   * Updates user permissions (admin only).
   */
  updateUserPermissions: (payload) => ipcRenderer.invoke('users:update-permissions', payload),

  /**
   * Loads general application settings.
   */
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),

  /**
   * Saves general application settings.
   */
  saveAppSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),

  /**
   * Retrieves Windows auto-start setting.
   */
  getAutoStart: () => ipcRenderer.invoke('app:get-auto-start'),

  /**
   * Configures Windows auto-start setting.
   */
  setAutoStart: (openAtLogin) => ipcRenderer.invoke('app:set-auto-start', openAtLogin),

  /**
   * Checks GitHub releases for application updates.
   */
  checkForUpdates: (options) => ipcRenderer.invoke('app:check-for-updates', options),

  /**
   * Downloads a release update asset to the user's Downloads folder.
   */
  downloadUpdate: (payload) => ipcRenderer.invoke('app:download-update', payload),

  /**
   * Subscribes to release download progress events.
   * @param {(progress: { percent: number, transferred: number, total: number }) => void} callback
   */
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('app:update-download-progress', (_event, progress) => callback(progress));
  },

  /**
   * Opens or highlights a downloaded file on disk.
   */
  openDownloadedFile: (filePath) => ipcRenderer.invoke('app:open-downloaded-file', filePath),

  /**
   * Safely opens an external URL in the user's default browser.
   */
  openExternalUrl: (url) => ipcRenderer.invoke('app:open-external', url),

  /**
   * Retrieves application and runtime system information.
   */
  getSystemInfo: () => ipcRenderer.invoke('app:get-system-info'),

  /**
   * Records an inventory change in the audit log.
   */
  logAuditChange: (payload) => ipcRenderer.invoke('audit:log-change', payload),

  /**
   * Retrieves inventory change history.
   */
  getAuditHistory: (filter) => ipcRenderer.invoke('audit:get-history', filter)
});

