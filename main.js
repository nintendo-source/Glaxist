const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const logFile = path.join(userDataPath, 'launcher_debug.log');

function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (e) {}
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('status-update', message);
  }
}

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

// BULLETPROOF JAVA 21 RESOLVER DIRECTLY TARGETING MODRINTH
async function getOrDownloadJava(versionStr) {
  logDebug(`Resolving Java runtime for version: ${versionStr}`);

  // 1. Direct path to the exact Modrinth Zulu Java 21 folder we found on your PC
  const directModrinthJava21 = path.join(
    process.env.APPDATA || '', 
    'ModrinthApp', 
    'meta', 
    'java_versions', 
    'zulu21.52.203-ca-jre21.0.12.1-win_x64', 
    'bin', 
    'javaw.exe'
  );

  if (fs.existsSync(directModrinthJava21)) {
    logDebug(`SUCCESS: Found exact Modrinth Java 21 at -> ${directModrinthJava21}`);
    return directModrinthJava21;
  }

  // 2. Fallback: Search inside Modrinth meta folder recursively
  const modrinthJavaDir = path.join(process.env.APPDATA || '', 'ModrinthApp', 'meta', 'java_versions');
  if (fs.existsSync(modrinthJavaDir)) {
    const found = searchJavaInDirectory(modrinthJavaDir, true);
    if (found) {
      logDebug(`SUCCESS: Found Java via Modrinth search at -> ${found}`);
      return found;
    }
  }

  // 3. Fallback to System PATH
  logDebug(`WARNING: No Java 21 found in Modrinth. Falling back to system 'javaw'.`);
  return "javaw";
}

function searchJavaInDirectory(baseDir, prefer21) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(baseDir, entry.name);
        const javawPath = path.join(fullPath, 'bin', 'javaw.exe');
        if (fs.existsSync(javawPath)) {
          if (prefer21 && fullPath.toLowerCase().includes('21')) {
            return javawPath;
          }
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

// Fetch Minecraft versions
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

// Launch Game
ipcMain.on('launch-game', async (event, { username, instanceId, version }) => {
  const instancePath = path.join(instancesBaseDir, instanceId, '.minecraft');
  const auth = Authenticator.getAuth(username);
  
  const resolvedJavaPath = await getOrDownloadJava(version);
  logDebug(`Final Selected Java Path: ${resolvedJavaPath}`);

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

  launcher.on('debug', (e) => logDebug(`[Debug] ${e}`));
  launcher.on('data', (e) => logDebug(`[Game] ${e}`));
  launcher.on('progress', (e) => {
    const percentage = e.total > 0 ? Math.round((e.task / e.total) * 100) : 0;
    logDebug(`Downloading ${e.type}: ${percentage}%`);
  });
  launcher.on('download-status', (e) => {
    const percentage = e.total > 0 ? Math.round((e.current / e.total) * 100) : 0;
    logDebug(`Downloading ${e.type}: ${percentage}%`);
  });
  launcher.on('error', (err) => {
    logDebug(`Launch Error: ${err}`);
    dialog.showErrorBox("Glaxist Launch Error", `The game failed to launch.\n\nError details:\n${err}`);
  });
  launcher.on('close', (code) => {
    logDebug(`Game exited with code ${code}`);
  });

  try {
    launcher.launch(opts);
  } catch (err) {
    logDebug(`Fatal Error: ${err.message}`);
    dialog.showErrorBox("Glaxist Fatal Error", err.message);
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
