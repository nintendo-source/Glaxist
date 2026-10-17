const { ipcRenderer } = require('electron');

let instances = [];
let selectedInstanceId = null;

const navItems = document.querySelectorAll('.nav-item');
const viewPanels = document.querySelectorAll('.view-panel');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(i => i.classList.remove('active'));
    viewPanels.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    const target = item.getAttribute('data-target');
    document.getElementById(target).classList.add('active');
  });
});

async function loadInstances() {
  instances = await ipcRenderer.invoke('get-instances');
  renderInstances();
}

function renderInstances() {
  const grid = document.getElementById('instances-grid');
  const targetSelect = document.getElementById('target-instance');
  
  grid.innerHTML = '';
  targetSelect.innerHTML = '';

  if (instances.length === 0) {
    grid.innerHTML = `<div class="empty-state">No instances found. Click "+ New Instance" above to create one!</div>`;
    selectedInstanceId = null;
    document.getElementById('launch-btn').disabled = true;
    return;
  }

  instances.forEach((inst, index) => {
    const card = document.createElement('div');
    card.className = `instance-card ${selectedInstanceId === inst.id || (index === 0 && !selectedInstanceId) ? 'selected' : ''}`;
    card.setAttribute('data-id', inst.id);
    
    if (index === 0 && !selectedInstanceId) {
      selectedInstanceId = inst.id;
    }

    let iconHTML = `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
    if (inst.logo) {
      iconHTML = `<img src="../${inst.logo}" alt="logo">`;
    }

    card.innerHTML = `
      <div class="instance-icon">${iconHTML}</div>
      <div class="instance-info">
        <h3>${inst.name}</h3>
        <p>Version ${inst.version}</p>
      </div>
      <div class="badge">Active</div>
    `;

    card.addEventListener('click', () => {
      document.querySelectorAll('.instance-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedInstanceId = inst.id;
      targetSelect.value = inst.id;
      document.getElementById('launch-btn').disabled = false;
    });

    grid.appendChild(card);

    const opt = document.createElement('option');
    opt.value = inst.id;
    opt.textContent = `${inst.name} (${inst.version})`;
    targetSelect.appendChild(opt);
  });

  if (instances.length > 0) {
    document.getElementById('launch-btn').disabled = false;
  }
}

const modal = document.getElementById('create-modal');
document.getElementById('open-modal-btn').addEventListener('click', () => modal.classList.add('active'));
document.getElementById('modal-cancel').addEventListener('click', () => modal.classList.remove('active'));

const modalLogoInput = document.getElementById('modal-logo');
const logoLabel = document.getElementById('logo-label');
modalLogoInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    logoLabel.innerText = e.target.files[0].name;
    logoLabel.style.color = '#ffffff';
  }
});

document.getElementById('modal-create').addEventListener('click', async () => {
  const name = document.getElementById('modal-name').value.trim();
  const version = document.getElementById('modal-version').value;
  const logoFile = modalLogoInput.files[0];

  if (!name) {
    alert("Please enter an instance name!");
    return;
  }

  const logoPath = logoFile ? logoFile.path : null;
  const newInst = await ipcRenderer.invoke('create-instance', { name, version, logoPath });
  
  modal.classList.remove('active');
  document.getElementById('modal-name').value = '';
  modalLogoInput.value = '';
  logoLabel.innerText = 'Choose PNG logo...';
  logoLabel.style.color = '#9ca3af';

  selectedInstanceId = newInst.id;
  loadInstances();
});

const fileInput = document.getElementById('file-input');
const fileLabel = document.getElementById('file-label');
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    fileLabel.innerText = e.target.files[0].name;
    fileLabel.style.color = "#ffffff";
  }
});

const launchBtn = document.getElementById('launch-btn');
const statusText = document.getElementById('status-text');

launchBtn.addEventListener('click', () => {
  const username = document.getElementById('username').value.trim();
  if (!username) {
    alert("Please enter a username!");
    return;
  }
  if (!selectedInstanceId) {
    alert("Please select or create an instance first!");
    return;
  }

  const activeInst = instances.find(i => i.id === selectedInstanceId);
  statusText.innerText = `Launching [${activeInst.name}] as [${username}]...`;

  ipcRenderer.send('launch-game', {
    username: username,
    instanceId: selectedInstanceId,
    version: activeInst.version
  });
});

document.getElementById('upload-btn').addEventListener('click', () => {
  const targetInstId = document.getElementById('target-instance').value;
  const fileType = document.getElementById('file-type').value;

  if (!targetInstId) {
    alert("No target instance available!");
    return;
  }
  if (fileInput.files.length === 0) {
    alert("Please select a file to upload!");
    return;
  }

  const filePath = fileInput.files[0].path;
  ipcRenderer.send('upload-file', {
    instanceId: targetInstId,
    filePath: filePath,
    targetType: fileType
  });
});

ipcRenderer.on('log', (event, data) => console.log(data));
ipcRenderer.on('upload-success', (event, msg) => {
  alert(msg);
  statusText.innerText = msg;
  fileInput.value = "";
  fileLabel.innerText = "Click here to browse file...";
  fileLabel.style.color = "#9ca3af";
});

loadInstances();
