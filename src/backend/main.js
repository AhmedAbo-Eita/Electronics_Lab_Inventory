/**
 * ============================================================================
 * Main Electron Application Entry Point
 * ============================================================================
 * Coordinates the application lifecycle, BrowserWindow initialization,
 * frameless window controls, unsaved change guard, and registers backend IPC.
 */

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./ipcHandlers');

/**
 * Resolves an asset path from the bundled assets directory.
 * @param  {...string} segments
 * @returns {string}
 */
function getBundledAssetPath(...segments) {
  return path.join(__dirname, '../../assets', ...segments);
}

let mainWindow = null;
let hasUnsavedChanges = false;
let forceClose = false;

// Hardware & startup performance optimizations
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');

// Enforce single instance lock to prevent duplicate database writes
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

/**
 * Creates and configures the main desktop application window.
 */
function createWindow() {
  const iconPath = getBundledAssetPath('Images', 'package_6215997.png');

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: 'Lab Inventory',
    icon: iconPath,
    backgroundColor: '#131314',
    frame: false, // Frameless window - custom titlebar in frontend
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // Track window state changes for custom title bar controls
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state-change', true);
    }
  });

  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state-change', false);
    }
  });

  // Display immediately with dark background to eliminate perceived startup delay
  mainWindow.maximize();
  mainWindow.show();

  // Load frontend HTML
  mainWindow.loadFile(path.join(__dirname, '../frontend/index.html'));

  // Intercept window close to prompt user if unsaved changes exist via in-app dialog
  mainWindow.on('close', async (e) => {
    if (forceClose || !hasUnsavedChanges) {
      return;
    }

    e.preventDefault();
    mainWindow.webContents.send('app:prompt-close-save');
  });
}

// ----------------------------------------------------------------------------
// Register IPC Handlers with App Context
// ----------------------------------------------------------------------------
registerIpcHandlers({
  getMainWindow: () => mainWindow,
  setDirtyState: (dirty) => {
    hasUnsavedChanges = dirty;
  },
  getDirtyState: () => hasUnsavedChanges,
  setForceClose: () => {
    forceClose = true;
  }
});

// ----------------------------------------------------------------------------
// Application Lifecycle Hooks
// ----------------------------------------------------------------------------

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
