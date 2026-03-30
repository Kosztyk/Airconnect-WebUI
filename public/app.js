const state = {
  discoveryDevices: [],
  defaults: {
    aircast: '-x /config/aircast.xml',
    airupnp: '-x /config/airupnp.xml -l 1000:2000'
  }
};

const pages = {
  dashboard: ['Dashboard', 'AirConnect status and quick actions'],
  services: ['Services', 'Separate runtime arguments for AirCast and AirUPnP'],
  discovery: ['Discovery', 'Devices merged from logs, cache, and config files'],
  config: ['Config', 'Edit aircast.xml and airupnp.xml separately'],
  logs: ['Logs', 'Recent output from the AirConnect container'],
  deployment: ['Deployment', 'Generated docker-compose snippet for the current runtime']
};

function showMessage(text, isError = false) {
  const box = document.getElementById('message-box');
  box.textContent = text;
  box.classList.remove('hidden', 'error', 'success', 'warning');
  box.classList.add(isError ? 'error' : 'success');
  clearTimeout(showMessage._timer);
  showMessage._timer = setTimeout(() => box.classList.add('hidden'), 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function setActivePage(target) {
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.target === target));
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${target}`));
  const [title, subtitle] = pages[target];
  document.getElementById('page-title').textContent = title;
  document.getElementById('subtitle').textContent = subtitle;
}

function formatStartedAt(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setBadge(id, exists, textWhenExists = 'Present', textWhenMissing = 'Missing') {
  const badge = document.getElementById(id);
  badge.textContent = exists ? textWhenExists : textWhenMissing;
  badge.classList.remove('ok', 'missing', 'neutral');
  badge.classList.add(exists ? 'ok' : 'missing');
}

function renderWarnings(warnings = []) {
  const box = document.getElementById('warning-box');
  const list = document.getElementById('warning-list');
  list.innerHTML = '';
  if (!warnings.length) {
    box.classList.add('hidden');
    return;
  }
  warnings.forEach((warning) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${warning.service || 'runtime'}:</strong> ${warning.message}`;
    list.appendChild(li);
  });
  box.classList.remove('hidden');
}

async function loadStatus() {
  const data = await api('/api/status');
  state.defaults = data.defaults || state.defaults;
  renderWarnings(data.warnings || []);

  document.getElementById('metric-container').textContent = data.state?.Running ? 'Running' : 'Stopped';
  document.getElementById('metric-aircast').textContent = data.services?.aircast?.enabled ? 'Enabled' : 'Disabled';
  document.getElementById('metric-airupnp').textContent = data.services?.airupnp?.enabled ? 'Enabled' : 'Disabled';
  document.getElementById('metric-devices').textContent = String(data.discoveredDevices ?? 0);

  document.getElementById('runtime-name').textContent = data.containerName || '—';
  document.getElementById('runtime-image').textContent = data.image || '—';
  document.getElementById('runtime-started').textContent = formatStartedAt(data.startedAt);
  document.getElementById('runtime-aircast-config').textContent = data.services?.aircast?.configPath || '—';
  document.getElementById('runtime-airupnp-config').textContent = data.services?.airupnp?.configPath || '—';

  document.getElementById('dashboard-default-aircast').textContent = state.defaults.aircast;
  document.getElementById('dashboard-default-airupnp').textContent = state.defaults.airupnp;

  document.getElementById('dashboard-aircast-file').textContent = data.configFiles?.aircast?.exists ? 'Present' : 'Missing';
  document.getElementById('dashboard-airupnp-file').textContent = data.configFiles?.airupnp?.exists ? 'Present' : 'Missing';
  document.getElementById('dashboard-legacy-file').textContent = data.configFiles?.legacy?.exists ? 'Present' : 'Missing';
}

async function loadEnv() {
  const data = await api('/api/config/env');
  state.defaults = data.defaults || state.defaults;
  document.getElementById('aircast-enabled').checked = data.aircastEnabled;
  document.getElementById('airupnp-enabled').checked = data.airupnpEnabled;
  document.getElementById('aircast-var').value = data.aircastVar || '';
  document.getElementById('airupnp-var').value = data.airupnpVar || '';
}

async function loadConfigFile(key) {
  const data = await api(`/api/config/file/${key}`);
  if (key === 'aircast') {
    document.getElementById('aircast-config-path').textContent = data.path;
    document.getElementById('aircast-config-xml').value = data.xml || '';
    setBadge('aircast-config-badge', data.exists);
  } else if (key === 'airupnp') {
    document.getElementById('airupnp-config-path').textContent = data.path;
    document.getElementById('airupnp-config-xml').value = data.xml || '';
    setBadge('airupnp-config-badge', data.exists);
  } else if (key === 'legacy') {
    document.getElementById('legacy-config-path').textContent = data.path;
    document.getElementById('legacy-config-xml').value = data.xml || '';
    const badge = document.getElementById('legacy-config-badge');
    badge.textContent = data.exists ? 'Present' : 'Legacy';
    badge.classList.remove('ok', 'missing');
    badge.classList.add(data.exists ? 'ok' : 'neutral');
  }
}

async function loadAllConfigs() {
  await Promise.all([loadConfigFile('aircast'), loadConfigFile('airupnp'), loadConfigFile('legacy')]);
}

async function loadLogs() {
  const tail = Number(document.getElementById('log-tail').value || 300);
  const data = await api(`/api/logs?tail=${tail}`);
  document.getElementById('logs-output').textContent = data.logs || '';
}

async function loadCompose() {
  const data = await api('/api/deployment/compose');
  document.getElementById('compose-output').textContent = data.compose || '';
}

async function loadDiscovery(forceRefresh = false) {
  const data = await api(`/api/discovery${forceRefresh ? '?refresh=1' : ''}`);
  state.discoveryDevices = data.devices || [];
  const tbody = document.getElementById('discovery-table');
  tbody.innerHTML = '';
  if (!state.discoveryDevices.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No devices found in logs, cache, or config yet.</td></tr>';
    return data;
  }
  state.discoveryDevices.forEach((device) => {
    const tr = document.createElement('tr');
    const lastSeen = device.lastSeen ? formatStartedAt(device.lastSeen) : 'Not seen in logs yet';
    tr.title = `Last seen: ${lastSeen}`;
    tr.innerHTML = `
      <td>${escapeHtml(device.name || '')}</td>
      <td>${escapeHtml(device.type || '')}</td>
      <td>${escapeHtml(device.ip || '')}</td>
      <td>${escapeHtml(device.port || '')}</td>
      <td>${escapeHtml(device.mac || '')}</td>
      <td>${escapeHtml(device.source || '')}</td>
    `;
    tbody.appendChild(tr);
  });
  return data;
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadEnv(), loadAllConfigs(), loadLogs(), loadCompose(), loadDiscovery()]);
}

async function saveConfig(key, textareaId, restartCheckboxId) {
  const xml = document.getElementById(textareaId).value;
  const restartContainer = restartCheckboxId ? document.getElementById(restartCheckboxId).checked : false;
  await api(`/api/config/file/${key}`, {
    method: 'POST',
    body: JSON.stringify({ xml, restartContainer })
  });
  await Promise.all([loadConfigFile(key), loadStatus(), loadCompose(), loadLogs()]);
}

async function generateConfig(target) {
  await api('/api/config/generate', {
    method: 'POST',
    body: JSON.stringify({ target })
  });
  if (target === 'both') {
    await Promise.all([loadConfigFile('aircast'), loadConfigFile('airupnp')]);
  } else {
    await loadConfigFile(target);
  }
  await Promise.all([loadStatus(), loadCompose()]);
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => setActivePage(btn.dataset.target));
});

document.getElementById('refresh-all').addEventListener('click', async () => {
  try {
    await refreshAll();
    showMessage('Refreshed');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('restart-container').addEventListener('click', async () => {
  try {
    await api('/api/container/restart', { method: 'POST' });
    await refreshAll();
    showMessage('Container restarted');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('start-container').addEventListener('click', async () => {
  try {
    await api('/api/container/start', { method: 'POST' });
    await refreshAll();
    showMessage('Container started');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('stop-container').addEventListener('click', async () => {
  try {
    await api('/api/container/stop', { method: 'POST' });
    await refreshAll();
    showMessage('Container stopped');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('open-services').addEventListener('click', () => setActivePage('services'));
document.getElementById('open-config').addEventListener('click', () => setActivePage('config'));

document.getElementById('apply-defaults').addEventListener('click', () => {
  document.getElementById('aircast-enabled').checked = true;
  document.getElementById('airupnp-enabled').checked = true;
  document.getElementById('aircast-var').value = state.defaults.aircast;
  document.getElementById('airupnp-var').value = state.defaults.airupnp;
  showMessage('Recommended args applied locally');
});

document.getElementById('save-services').addEventListener('click', async () => {
  try {
    const result = await api('/api/config/env', {
      method: 'POST',
      body: JSON.stringify({
        aircastEnabled: document.getElementById('aircast-enabled').checked,
        airupnpEnabled: document.getElementById('airupnp-enabled').checked,
        aircastVar: document.getElementById('aircast-var').value,
        airupnpVar: document.getElementById('airupnp-var').value
      })
    });
    await refreshAll();
    const warningText = (result.warnings || []).length ? ` (${result.warnings.join(' ')})` : '';
    showMessage(`Services updated and container recreated${warningText}`.trim());
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('reload-aircast-config').addEventListener('click', async () => {
  try {
    await loadConfigFile('aircast');
    showMessage('AirCast config reloaded');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('reload-airupnp-config').addEventListener('click', async () => {
  try {
    await loadConfigFile('airupnp');
    showMessage('AirUPnP config reloaded');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('reload-legacy-config').addEventListener('click', async () => {
  try {
    await loadConfigFile('legacy');
    showMessage('Legacy config reloaded');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('generate-aircast-config').addEventListener('click', async () => {
  try {
    await generateConfig('aircast');
    showMessage('Starter AirCast XML generated');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('generate-airupnp-config').addEventListener('click', async () => {
  try {
    await generateConfig('airupnp');
    showMessage('Starter AirUPnP XML generated');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('generate-both-configs').addEventListener('click', async () => {
  try {
    await generateConfig('both');
    showMessage('Starter AirCast and AirUPnP XML files generated');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('save-aircast-config').addEventListener('click', async () => {
  try {
    await saveConfig('aircast', 'aircast-config-xml', 'restart-after-aircast-save');
    showMessage('aircast.xml saved');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('save-airupnp-config').addEventListener('click', async () => {
  try {
    await saveConfig('airupnp', 'airupnp-config-xml', 'restart-after-airupnp-save');
    showMessage('airupnp.xml saved');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('save-legacy-config').addEventListener('click', async () => {
  try {
    await saveConfig('legacy', 'legacy-config-xml');
    showMessage('Legacy config.xml saved');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('refresh-logs').addEventListener('click', async () => {
  try {
    await loadLogs();
    await loadStatus();
    showMessage('Logs refreshed');
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('refresh-discovery').addEventListener('click', async () => {
  try {
    const data = await loadDiscovery(true);
    await loadStatus();
    const mode = data?.meta?.refreshMode === 'deep-log-scan' ? 'deep log scan' : 'recent log scan';
    showMessage(`Discovery refreshed (${mode})`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.getElementById('copy-compose').addEventListener('click', async () => {
  try {
    const text = document.getElementById('compose-output').textContent;
    await navigator.clipboard.writeText(text);
    showMessage('Compose copied');
  } catch (error) {
    showMessage(error.message, true);
  }
});

(async function init() {
  try {
    await refreshAll();
  } catch (error) {
    showMessage(error.message, true);
  }
})();
