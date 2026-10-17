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

// UNIVERSAL JAVA AUTO-DETECTOR FOR ANY PLAYER'S PC
function findJavaPath() {
  // 1. Check JAVA_HOME environment variable
  if (process.env.JAVA_HOME) {
    const javaHomePath = path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe');
    if (fs.existsSync(javaHomePath)) return javaHomePath;
  }

  // 2. Scan common Windows installation directories automatically
  const commonDirs = [
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\BellSoft",
    "C:\\Program Files\\Eclipse Foundation",
    "C:\\Program Files (x86)\\Java"
  ];

  for (const baseDir of commonDirs) {
    if (fs.existsSync(baseDir)) {
      try {
        const subFolders = fs.readdirSync(baseDir);
        for (const folder of subFolders) {
          const javawPath = path.join(baseDir, folder, 'bin', 'javaw.exe');
          if (fs.existsSync(javawPath)) {
            return javawPath;
          }
        }
      } catch (e) {}
    }
  }

  // 3. Fallback to global system PATH command if no folder match is found
  return "javaw";
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

// Launch Game using the dynamic Java detector
ipcMain.on('launch-game', (event, { username, instanceId, version }) => {
  const instancePath = path.join(instancesBaseDir, instanceId, '.minecraft');
  const auth = Authenticator.getAuth(username);
  const resolvedJavaPath = findJavaPath();

  sendStatus(`Using Java at: ${resolvedJavaPath}`);

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
