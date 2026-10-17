const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();
let mainWindow;

const instancesFile = path.join(__dirname, 'instances.json');

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

  mainWindow.loadFile('renderer/index.html');
  mainWindow.setMenuBarVisibility(false);
});

// Fetch all Minecraft versions from Mojang's official public API
ipcMain.handle('get-minecraft-versions', async () => {
  return new Promise((resolve) => {
    https.get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Returns array of versions (id, type, etc.)
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
  const instanceDir = path.join(__dirname, 'instances', folderName);
  const mcDir = path.join(instanceDir, '.minecraft');
  
  fs.mkdirSync(path.join(mcDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(mcDir, 'resourcepacks'), { recursive: true });

  let savedLogoPath = null;
  if (logoPath && fs.existsSync(logoPath)) {
    const iconsDir = path.join(__dirname, 'icons');
    fs.mkdirSync(iconsDir, { recursive: true });
    const ext = path.extname(logoPath);
    savedLogoPath = path.join(iconsDir, `${folderName}_${Date.now()}${ext}`);
    fs.copyFileSync(logoPath, savedLogoPath);
  }

  const newInstance = {
    id: folderName,
    name: name,
    version: version,
    logo: savedLogoPath ? path.relative(__dirname, savedLogoPath) : null
  };

  instances.push(newInstance);
  saveInstances(instances);
  return newInstance;
});

ipcMain.on('launch-game', (event, { username, instanceId, version }) => {
  const instancePath = path.join(__dirname, 'instances', instanceId, '.minecraft');
  const auth = Authenticator.getAuth(username);

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
    }
  };

  launcher.launch(opts);

  launcher.on('debug', (e) => event.sender.send('log', e));
  launcher.on('data', (e) => event.sender.send('log', e));
  launcher.on('progress', (e) => event.sender.send('progress', e));
});

ipcMain.on('upload-file', (event, { instanceId, filePath, targetType }) => {
  const instancePath = path.join(__dirname, 'instances', instanceId, '.minecraft');
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
