const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const url = require('url');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();
let mainWindow;

const userDataPath = app.getPath('userData');
const instancesFile = path.join(userDataPath, 'instances.json');
const instancesBaseDir = path.join(userDataPath, 'instances');
const iconsDir = path.join(userDataPath, 'icons');

function getStoredInstances() {
  if (!fs.existsSync(instancesFile)) {
    fs.writeFileSync(instancesFile, JSON.stringify([]));
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveInstances(instances) {
  fs.writeFileSync(instancesFile, JSON.stringify(instances, null, 2));
}

// SMART JAVA DISCOVERY FOR WINDOWS & EXISTING LAUNCHER RUNTIMES
function findJavaPathForVersion(versionStr) {
  let needsJava21 = true;
  if (versionStr) {
    const parts = versionStr.split('.');
    if (parts.length >= 2 && parts[0] === '1') {
      const minor = parseInt(parts[1], 10);
      if (minor < 20 || (minor === 20 && parts[2] && parseInt(parts[2], 10) < 5)) {
        needsJava21 = false;
      }
    }
  }

  // 1. Scan official Minecraft / Xbox App runtime folder on Windows (where Java 21 / 17 already live)
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const packagesDir = path.join(localAppData, 'Packages');
    if (fs.existsSync(packagesDir)) {
      try {
        const pkgs = fs.readdirSync(packagesDir);
        for (const pkg of pkgs) {
          if (pkg.startsWith('Microsoft.MinecraftLauncher') || pkg.startsWith('Microsoft.4297127D64EC6')) {
            const runtimeDir = path.join(packagesDir, pkg, 'LocalCache', 'Local', 'runtime');
            if (fs.existsSync(runtimeDir)) {
              const found = searchJavaInDirectory(runtimeDir, needsJava21);
              if (found) return found;
            }
          }
        }
      } catch (e) {}
    }
  }

  // 2. Scan standard JDK/JRE installation directories
  const commonDirs = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Eclipse Adoptium'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Java'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BellSoft'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Zulu')
  ];

  for (const baseDir of commonDirs) {
    if (fs.existsSync(baseDir)) {
      const found = searchJavaInDirectory(baseDir, needsJava21);
      if (found) return found;
    }
  }

  // 3. Fallback to global system PATH
  return "javaw";
}

function searchJavaInDirectory(baseDir, prefer21) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    entries.sort((a, b) => {
      const nameA = a.name.toLowerCase();
      const nameB = b.name.toLowerCase();
      if (prefer21) {
        if (nameA.includes('21') || nameA.includes('gamma')) return -1;
        if (nameB.includes('21') || nameB.includes('gamma')) return 1;
      } else {
        if (nameA.includes('17') || nameA.includes('delta')) return -1;
        if (nameB.includes('17') || nameB.includes('delta')) return 1;
      }
      return 0;
    });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(baseDir, entry.name);
        const javawPath = path.join(fullPath, 'bin', 'javaw.exe');
        if (fs.existsSync(javawPath)) {
          return javawPath;
        }
        const deeper = searchJavaInDirectory(fullPath, prefer21);
        if (deeper) return deeper;
      }
    }
  } catch (e) {}
  return null;
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 700,
    backgroundColor: '#111113',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.setMenuBarVisibility(false);
});

function sendStatus(message) {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('status-update', message);
  }
}

// Fetch all Minecraft versions from Mojang API
ipcMain.handle('get-minecraft-versions', async () => {
  return new Promise((resolve) => {
    https.get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.versions);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => {
      resolve([]);
    });
  });
});

ipcMain.handle('get-instances', () => {
  return getStoredInstances();
});

ipcMain.handle('create-instance', (event, { name, version, logoPath }) => {
  const instances = getStoredInstances();
  const folderName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const instanceDir = path.join(instancesBaseDir, folderName);
  const mcDir = path.join(instanceDir, '.minecraft');
  
  fs.mkdirSync(path.join(mcDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'resourcepacks'), { recursive: true });

  let savedLogoPath = null;
  if (logoPath && fs.existsSync(logoPath)) {
    fs.mkdirSync(iconsDir, { recursive: true });
    const ext = path.extname(logoPath);
    savedLogoPath = path.join(iconsDir, `${folderName}_${Date.now()}${ext}`);
    fs.copyFileSync(logoPath, savedLogoPath);
  }

  const newInstance = {
    id: folderName,
    name: name,
    version: version,
    logo: savedLogoPath ? url.pathToFileURL(savedLogoPath).href : null
  };

  instances.push(newInstance);
  saveInstances(instances);
  return newInstance;
});

// Launch Game with smart Java runtime resolver
ipcMain.on('launch-game', (event, { username, instanceId, version }) => {
  const instancePath = path.join(instancesBaseDir, instanceId, '.minecraft');
  const auth = Authenticator.getAuth(username);
  const resolvedJavaPath = findJavaPathForVersion(version);

  sendStatus(`Selected Java: ${resolvedJavaPath}`);

  const opts = {
    authorization: auth,
    root: instancePath,
    version: {
      number: version,
      type: "release"
    },
    memory: {
      max: "4G",
      min: "2G"
    },
    javaPath: resolvedJavaPath
  };

  launcher.removeAllListeners();

  launcher.on('debug', (e) => sendStatus(`[Debug] ${e}`));
  launcher.on('data', (e) => sendStatus(`[Game] ${e}`));
  launcher.on('progress', (e) => {
    const percentage = e.total > 0 ? Math.round((e.task / e.total) * 100) : 0;
    sendStatus(`Downloading ${e.type}: ${percentage}% (${e.task}/${e.total})`);
  });
  launcher.on('download-status', (e) => {
    const percentage = e.total > 0 ? Math.round((e.current / e.total) * 100) : 0;
    sendStatus(`Downloading ${e.type}: ${percentage}%`);
  });
  launcher.on('error', (err) => {
    sendStatus(`Launch Error: ${err}`);
  });
  launcher.on('close', (code) => {
    sendStatus(`Game exited with code ${code}`);
  });

  try {
    launcher.launch(opts);
  } catch (err) {
    sendStatus(`Fatal Error: ${err.message}`);
  }
});

ipcMain.on('upload-file', (event, { instanceId, filePath, targetType }) => {
  const instancePath = path.join(instancesBaseDir, instanceId, '.minecraft');
  const targetFolder = path.join(instancePath, targetType);
  const fileName = path.basename(filePath);
  const destPath = path.join(targetFolder, fileName);

  try {
    fs.copyFileSync(filePath, destPath);
    event.sender.send('upload-success', `Successfully added ${fileName} to ${targetType}!`);
  } catch (err) {
    event.sender.send('upload-success', `Error: ${err.message}`);
  }
});
