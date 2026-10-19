/**
 * ============================================================================
 * Application Persistent Settings Service
 * ============================================================================
 * Manages desktop preferences stored in `data/app_settings.json`:
 *   - Windows startup behavior (openAtLogin)
 *   - Auto-login credential state
 *   - Theme preference
 *   - Automatic update checking on startup
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getSettingsFilePath() {
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
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'app_settings.json');
      }
      return path.join(baseDir, 'app_settings.json');
    }
  }
  return path.join(dataDir, 'app_settings.json');
}

const DEFAULT_SETTINGS = {
  theme: 'system',
  openAtLogin: false,
  autoLogin: false,
  autoLoginUsername: '',
  checkUpdatesOnStartup: true,
  lastUpdateCheck: null
};

let cachedSettings = null;

/**
 * Loads settings from disk with fallback to defaults.
 */
function loadSettings() {
  if (cachedSettings) return { ...cachedSettings };
  const filePath = getSettingsFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
      return { ...cachedSettings };
    }
  } catch (err) {
    console.warn('[AppSettings] Failed to read settings, falling back to defaults:', err.message);
  }
  cachedSettings = { ...DEFAULT_SETTINGS };
  return { ...cachedSettings };
}

/**
 * Saves updated settings to disk.
 */
function saveSettings(newSettings = {}) {
  const current = loadSettings();
  cachedSettings = { ...current, ...newSettings };
  const filePath = getSettingsFilePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(cachedSettings, null, 2), 'utf-8');
    return { ok: true, settings: { ...cachedSettings } };
  } catch (err) {
    console.error('[AppSettings] Failed to save settings to disk:', err.message);
    return { ok: false, error: err.message, settings: { ...cachedSettings } };
  }
}

/**
 * Gets the Windows auto-start setting via Electron's loginItemSettings.
 */
function getAutoStart() {
  if (!app) return { openAtLogin: false };
  try {
    const loginItem = app.getLoginItemSettings();
    return { openAtLogin: Boolean(loginItem.openAtLogin) };
  } catch (err) {
    console.warn('[AppSettings] Error checking login item settings:', err.message);
    return { openAtLogin: false };
  }
}

/**
 * Configures the Windows auto-start setting via Electron's loginItemSettings.
 */
function setAutoStart(openAtLogin) {
  const shouldOpen = Boolean(openAtLogin);
  if (app) {
    try {
      app.setLoginItemSettings({
        openAtLogin: shouldOpen,
        path: process.execPath,
        args: []
      });
    } catch (err) {
      console.warn('[AppSettings] Error setting login item settings:', err.message);
    }
  }
  saveSettings({ openAtLogin: shouldOpen });
  return { ok: true, openAtLogin: shouldOpen };
}

module.exports = {
  loadSettings,
  saveSettings,
  getAutoStart,
  setAutoStart
};
