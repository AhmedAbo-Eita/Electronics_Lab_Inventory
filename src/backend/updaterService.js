/**
 * ============================================================================
 * GitHub Repository Release Update Service
 * ============================================================================
 * Checks github.com/AhmedAbo-Eita/Electronics_Lab_Inventory/releases for new
 * desktop versions, compares semver tags, and downloads updates.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const appSettings = require('./appSettings');

const GITHUB_OWNER = 'AhmedAbo-Eita';
const GITHUB_REPO = 'Electronics_Lab_Inventory';

/**
 * Performs an HTTPS GET request with User-Agent and follows redirects.
 * @param {string} urlStr
 * @returns {Promise<{ statusCode: number, headers: Object, body: string }>}
 */
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Lab-Inventory-Desktop-App',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    https.get(options, (res) => {
      // Follow standard 301/302 redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Normalizes a semver string for numeric comparison.
 * e.g. "v2.1.0" -> [2, 1, 0]
 */
function parseSemver(vStr) {
  if (!vStr) return [0, 0, 0];
  const cleaned = String(vStr).trim().replace(/^[vV]/, '');
  const parts = cleaned.split('.').map((p) => {
    const num = parseInt(p, 10);
    return isNaN(num) ? 0 : num;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/**
 * Compares two semver strings: a > b ? 1 : a < b ? -1 : 0
 */
function compareSemver(a, b) {
  const pA = parseSemver(a);
  const pB = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pA[i] > pB[i]) return 1;
    if (pA[i] < pB[i]) return -1;
  }
  return 0;
}

/**
 * Checks GitHub repository releases for a newer version than current app.
 *
 * @param {Object} [options]
 * @param {boolean} [options.simulate] If true, simulates a newer update for testing UI
 * @returns {Promise<Object>}
 */
async function checkForUpdates(options = {}) {
  const currentVersion = app ? app.getVersion() : '2.0.0';
  const nowIso = new Date().toISOString();
  appSettings.saveSettings({ lastUpdateCheck: nowIso });

  if (options.simulate) {
    return {
      ok: true,
      hasUpdate: true,
      currentVersion,
      latestVersion: '2.1.2',
      releaseName: 'Lab Inventory v2.1.2 (Demo Release)',
      releaseNotes: '### What\'s New in v2.1.2\n- Simple, clean settings interface without decorative icon clutter\n- Strict database password verification on credential updates\n- Secure session logout with automatic sign-in reset\n- Built-in GitHub release auto-updater and background sync',
      publishedAt: nowIso,
      htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      downloadUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v2.1.2/Lab_Inventory_Setup_2.1.2.exe`,
      assetName: 'Lab_Inventory_Setup_2.1.2.exe',
      assetSize: '65.4 MB',
      isSimulated: true
    };
  }

  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
    const res = await httpsGet(apiUrl);

    if (res.statusCode === 404 || res.statusCode === 403) {
      return {
        ok: true,
        hasUpdate: false,
        noReleases: true,
        currentVersion,
        message: 'No official releases found on GitHub repository yet. You are on the current build (v' + currentVersion + ').',
        htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
      };
    }

    if (res.statusCode !== 200) {
      return {
        ok: false,
        currentVersion,
        error: `GitHub API responded with HTTP ${res.statusCode}.`
      };
    }

    const releases = JSON.parse(res.body);
    if (!Array.isArray(releases) || releases.length === 0) {
      return {
        ok: true,
        hasUpdate: false,
        noReleases: true,
        currentVersion,
        message: 'No published releases in this repository yet. You are using the latest version (v' + currentVersion + ').',
        htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
      };
    }

    // Filter non-draft releases
    const validReleases = releases.filter((r) => !r.draft);
    if (validReleases.length === 0) {
      return {
        ok: true,
        hasUpdate: false,
        currentVersion,
        message: 'No public release available yet.'
      };
    }

    const latest = validReleases[0];
    const latestTag = latest.tag_name || latest.name || '';
    const hasUpdate = compareSemver(latestTag, currentVersion) > 0;

    // Look for Windows executable installer in assets
    let assetName = '';
    let downloadUrl = '';
    let assetSize = '';

    if (Array.isArray(latest.assets) && latest.assets.length > 0) {
      const exeAsset = latest.assets.find((a) => a.name && a.name.endsWith('.exe')) || latest.assets[0];
      if (exeAsset) {
        assetName = exeAsset.name;
        downloadUrl = exeAsset.browser_download_url;
        assetSize = (exeAsset.size / (1024 * 1024)).toFixed(1) + ' MB';
      }
    }

    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion: latestTag.replace(/^[vV]/, ''),
      releaseName: latest.name || latestTag,
      releaseNotes: latest.body || 'No release notes provided.',
      publishedAt: latest.published_at,
      htmlUrl: latest.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      downloadUrl: downloadUrl || latest.html_url,
      assetName: assetName || `Lab_Inventory_${latestTag}.exe`,
      assetSize
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      error: `Failed to check for updates: ${err.message}`
    };
  }
}

/**
 * Downloads a release asset directly to user's Downloads folder with progress tracking.
 *
 * @param {Object} params
 * @param {string} params.downloadUrl
 * @param {string} params.assetName
 * @param {(progress: { percent: number, transferred: number, total: number }) => void} onProgress
 * @returns {Promise<{ ok: boolean, filePath?: string, error?: string }>}
 */
function downloadReleaseAsset({ downloadUrl, assetName }, onProgress) {
  return new Promise((resolve) => {
    if (!downloadUrl) {
      return resolve({ ok: false, error: 'Download URL is missing.' });
    }

    const fileName = assetName || 'Lab_Inventory_Setup.exe';
    const downloadsFolder = app ? app.getPath('downloads') : path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsFolder)) {
      try {
        fs.mkdirSync(downloadsFolder, { recursive: true });
      } catch {}
    }
    const destPath = path.join(downloadsFolder, fileName);
    const fileStream = fs.createWriteStream(destPath);

    function startDownload(targetUrl) {
      const parsed = new URL(targetUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Lab-Inventory-Desktop-App'
        }
      };

      https.get(options, (res) => {
        // Follow redirects (e.g. GitHub to AWS S3)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return startDownload(res.headers.location);
        }

        if (res.statusCode !== 200) {
          fileStream.close();
          fs.unlink(destPath, () => {});
          return resolve({ ok: false, error: `Download failed with HTTP ${res.statusCode}` });
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let transferredBytes = 0;

        res.on('data', (chunk) => {
          transferredBytes += chunk.length;
          fileStream.write(chunk);
          if (totalBytes > 0 && typeof onProgress === 'function') {
            const percent = Math.min(100, Math.round((transferredBytes / totalBytes) * 100));
            onProgress({ percent, transferred: transferredBytes, total: totalBytes });
          }
        });

        res.on('end', () => {
          fileStream.end();
          if (typeof onProgress === 'function') {
            onProgress({ percent: 100, transferred: transferredBytes, total: totalBytes });
          }
          resolve({ ok: true, filePath: destPath, fileName });
        });
      }).on('error', (err) => {
        fileStream.close();
        fs.unlink(destPath, () => {});
        resolve({ ok: false, error: err.message });
      });
    }

    startDownload(downloadUrl);
  });
}

/**
 * Opens a downloaded file or reveals it in Explorer.
 */
function openDownloadedFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'File not found on disk.' };
  }
  try {
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  checkForUpdates,
  downloadReleaseAsset,
  openDownloadedFile
};
