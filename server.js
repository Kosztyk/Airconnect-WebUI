const express = require('express');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const { parseStringPromise } = require('xml2js');

const app = express();
const port = Number(process.env.PORT || 8080);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'airconnect';
const ADMIN_HOST_PORT = Number(process.env.ADMIN_HOST_PORT || 8089);

const CONFIG_FILES = {
  legacy: { key: 'legacy', label: 'Legacy config.xml', fileName: 'config.xml', root: 'airconnect' },
  aircast: { key: 'aircast', label: 'AirCast config', fileName: 'aircast.xml', root: 'aircast' },
  airupnp: { key: 'airupnp', label: 'AirUPnP config', fileName: 'airupnp.xml', root: 'airupnp' }
};

const DEFAULT_ARGS = {
  aircast: '-x /config/aircast.xml',
  airupnp: '-x /config/airupnp.xml -l 1000:2000'
};

const DISCOVERY_CACHE_FILE = path.join(CONFIG_DIR, '.airconnect-admin-discovery-cache.json');
const DISCOVERY_CACHE_TTL_MS = Number(process.env.DISCOVERY_CACHE_TTL_MS || 1000 * 60 * 60 * 12);
const DISCOVERY_RECENT_LOG_TAIL = Number(process.env.DISCOVERY_RECENT_LOG_TAIL || 4000);
const DISCOVERY_MAX_LOG_SCAN_BYTES = Number(process.env.DISCOVERY_MAX_LOG_SCAN_BYTES || 2 * 1024 * 1024);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeNowIso() {
  return new Date().toISOString();
}

function getConfigPath(key) {
  const meta = CONFIG_FILES[key];
  if (!meta) {
    throw new Error(`Unknown config file key: ${key}`);
  }
  return path.join(CONFIG_DIR, meta.fileName);
}

function containerPathToLocalPath(containerPath) {
  if (!containerPath) return '';
  const trimmed = String(containerPath).trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';
  if (trimmed === '/config') return CONFIG_DIR;
  if (trimmed.startsWith('/config/')) {
    return path.join(CONFIG_DIR, trimmed.slice('/config/'.length));
  }
  return trimmed;
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvList(envList = []) {
  const map = {};
  for (const item of envList) {
    const idx = item.indexOf('=');
    if (idx === -1) {
      map[item] = '';
    } else {
      map[item.slice(0, idx)] = item.slice(idx + 1);
    }
  }
  return map;
}

function mergeEnvList(originalEnv = [], updates = {}) {
  const map = parseEnvList(originalEnv);
  Object.entries(updates).forEach(([key, value]) => {
    map[key] = value;
  });
  return Object.entries(map).map(([key, value]) => `${key}=${value}`);
}

async function getTargetContainer() {
  const container = docker.getContainer(TARGET_CONTAINER);
  const inspect = await container.inspect();
  return { container, inspect };
}

function filterCreateOptions(inspect, newEnv) {
  const cfg = inspect.Config || {};
  const host = inspect.HostConfig || {};

  const createOptions = {
    name: inspect.Name ? inspect.Name.replace(/^\//, '') : TARGET_CONTAINER,
    Image: cfg.Image,
    Env: newEnv,
    Cmd: cfg.Cmd,
    Entrypoint: cfg.Entrypoint,
    Labels: cfg.Labels,
    WorkingDir: cfg.WorkingDir,
    User: cfg.User,
    Tty: cfg.Tty,
    OpenStdin: cfg.OpenStdin,
    StdinOnce: cfg.StdinOnce,
    AttachStdin: cfg.AttachStdin,
    AttachStdout: cfg.AttachStdout,
    AttachStderr: cfg.AttachStderr,
    ExposedPorts: cfg.ExposedPorts,
    HostConfig: {
      Binds: host.Binds,
      PortBindings: host.PortBindings,
      RestartPolicy: host.RestartPolicy,
      NetworkMode: host.NetworkMode,
      Privileged: host.Privileged,
      Devices: host.Devices,
      DeviceRequests: host.DeviceRequests,
      CapAdd: host.CapAdd,
      CapDrop: host.CapDrop,
      SecurityOpt: host.SecurityOpt,
      ReadonlyRootfs: host.ReadonlyRootfs,
      Tmpfs: host.Tmpfs,
      LogConfig: host.LogConfig,
      ExtraHosts: host.ExtraHosts,
      Dns: host.Dns,
      DnsOptions: host.DnsOptions,
      DnsSearch: host.DnsSearch,
      ShmSize: host.ShmSize,
      AutoRemove: host.AutoRemove,
      Ulimits: host.Ulimits
    }
  };

  if (host.Mounts && host.Mounts.length) {
    createOptions.HostConfig.Mounts = host.Mounts;
  }
  if (inspect.NetworkSettings && inspect.NetworkSettings.Networks && host.NetworkMode !== 'host') {
    createOptions.NetworkingConfig = { EndpointsConfig: {} };
    for (const [networkName, networkInfo] of Object.entries(inspect.NetworkSettings.Networks)) {
      createOptions.NetworkingConfig.EndpointsConfig[networkName] = {
        Aliases: networkInfo.Aliases,
        IPAMConfig: networkInfo.IPAMConfig,
        Links: networkInfo.Links
      };
    }
  }

  Object.keys(createOptions).forEach((key) => createOptions[key] === undefined && delete createOptions[key]);
  Object.keys(createOptions.HostConfig).forEach((key) => createOptions.HostConfig[key] === undefined && delete createOptions.HostConfig[key]);
  return createOptions;
}

async function recreateContainerWithEnv(envUpdates) {
  const { container, inspect } = await getTargetContainer();
  const mergedEnv = mergeEnvList(inspect.Config?.Env || [], envUpdates);
  const options = filterCreateOptions(inspect, mergedEnv);

  const wasRunning = inspect.State?.Running;
  if (wasRunning) {
    await container.stop({ t: 10 }).catch(() => {});
  }
  await container.remove({ force: true });
  const newContainer = await docker.createContainer(options);
  await newContainer.start();
  return { name: options.name, env: mergedEnv };
}

async function readConfigFile(key) {
  const filePath = getConfigPath(key);
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeConfigFile(key, xml) {
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
  await fs.promises.writeFile(getConfigPath(key), xml, 'utf8');
}

function extractConfigPath(args = '') {
  const text = String(args || '').trim();
  if (!text) return '';
  const match = text.match(/(?:^|\s)-x\s+("[^"]+"|'[^']+'|\S+)/);
  return match ? match[1].replace(/^['"]|['"]$/g, '') : '';
}

function hasLatencyArg(args = '') {
  return /(?:^|\s)-l\s+\S+/.test(String(args || ''));
}

function getArgCrossReferenceError(service, args = '') {
  const text = String(args || '');
  if (service === 'aircast' && /airupnp\.xml/i.test(text)) {
    return 'AIRCAST_VAR should point to an AirCast config such as /config/aircast.xml, not airupnp.xml.';
  }
  if (service === 'airupnp' && /aircast\.xml/i.test(text)) {
    return 'AIRUPNP_VAR should point to an AirUPnP config such as /config/airupnp.xml, not aircast.xml.';
  }
  return '';
}

async function validateServiceArgs(service, args, enabled = true) {
  const errors = [];
  const warnings = [];

  if (!enabled) return { errors, warnings };

  const crossRefError = getArgCrossReferenceError(service, args);
  if (crossRefError) {
    errors.push(crossRefError);
  }

  const configPath = extractConfigPath(args);
  if (configPath) {
    const localPath = containerPathToLocalPath(configPath);
    if (!(await fileExists(localPath))) {
      errors.push(`${service === 'aircast' ? 'AirCast' : 'AirUPnP'} references ${configPath}, but that file does not exist inside the shared /config mount.`);
    }
  }

  if (service === 'aircast' && hasLatencyArg(args)) {
    warnings.push('AIRCAST_VAR includes -l. That latency flag is primarily recommended for AirUPnP / Sonos / Heos setups.');
  }

  if (service === 'airupnp' && !hasLatencyArg(args)) {
    warnings.push('AIRUPNP_VAR does not include -l. The docker-airconnect image recommends -l 1000:2000 when you customize AIRUPNP_VAR for Sonos / Heos devices.');
  }

  return { errors, warnings };
}

function normalizeServiceArgs(service, enabled, rawArgs) {
  if (!enabled) return 'kill';
  const trimmed = String(rawArgs || '').trim();
  if (!trimmed) return DEFAULT_ARGS[service];
  return trimmed;
}

function summarizeRecentConfigWarnings(logText) {
  const warnings = [];
  const lines = String(logText || '').split(/\r?\n/);
  let currentService = '';

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('starting aircast version') || lower.includes('launching aircast')) {
      currentService = 'aircast';
    } else if (lower.includes('starting airupnp version') || lower.includes('launching airupnp')) {
      currentService = 'airupnp';
    }

    if (lower.includes('no config file, using defaults')) {
      warnings.push({
        level: 'warning',
        service: currentService || 'runtime',
        code: `${currentService || 'runtime'}-defaults`,
        message:
          currentService === 'aircast'
            ? 'Recent logs show AirCast started with defaults because no readable config file was found.'
            : currentService === 'airupnp'
              ? 'Recent logs show AirUPnP started with defaults because no readable config file was found.'
              : 'Recent logs show AirConnect started with defaults because no readable config file was found.'
      });
    }
  }

  return warnings;
}

function cleanDockerLogText(rawText = "") {
  return String(rawText || "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "")
    .replace(/\r\n/g, "\n");
}

function cropTextToLastBytes(text = '', maxBytes = DISCOVERY_MAX_LOG_SCAN_BYTES) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= maxBytes) {
    return buffer.toString('utf8');
  }
  const sliced = buffer.subarray(buffer.length - maxBytes);
  const newlineIndex = sliced.indexOf(0x0a);
  return (newlineIndex >= 0 ? sliced.subarray(newlineIndex + 1) : sliced).toString('utf8');
}

async function getRecentLogs(tail = 500) {
  const { container } = await getTargetContainer();
  const raw = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });
  return cleanDockerLogText(raw.toString('utf8'));
}

async function getDiscoveryLogs({ forceDeepScan = false, tail = DISCOVERY_RECENT_LOG_TAIL } = {}) {
  const { container, inspect } = await getTargetContainer();
  if (forceDeepScan) {
    const startedAt = inspect.State?.StartedAt ? Math.floor(new Date(inspect.State.StartedAt).getTime() / 1000) : 0;
    const raw = await container.logs({ stdout: true, stderr: true, since: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0, timestamps: true });
    return cropTextToLastBytes(cleanDockerLogText(raw.toString('utf8')));
  }
  const raw = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });
  return cleanDockerLogText(raw.toString('utf8'));
}

function normalizeDiscoveryString(value = '') {
  return String(value || '').trim();
}

function normalizeDiscoveryStringKey(value = '') {
  return normalizeDiscoveryString(value).toLowerCase();
}

function normalizeMac(value = '') {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function formatMac(value = '') {
  const mac = normalizeMac(value);
  if (mac.length !== 12) return normalizeDiscoveryString(value);
  return mac.match(/.{1,2}/g).join(':');
}

function normalizePort(value = '') {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : text;
}

function normalizeDeviceType(type = '') {
  const value = normalizeDiscoveryString(type);
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower.includes('chromecast') || lower.includes('google cast')) return 'Chromecast';
  if (lower.includes('mediarenderer') || lower.includes('upnp')) return 'UPnP MediaRenderer';
  return value;
}

function choosePreferredType(left = '', right = '') {
  const a = normalizeDeviceType(left);
  const b = normalizeDeviceType(right);
  const score = (value) => {
    const lower = String(value || '').toLowerCase();
    if (!lower) return 0;
    if (lower === 'chromecast' || lower === 'upnp mediarenderer') return 3;
    if (lower.includes('chromecast') || lower.includes('upnp')) return 2;
    return 1;
  };
  return score(b) > score(a) ? b : a;
}

function getDeviceIdentityCandidates(device = {}) {
  const candidates = [];
  const mac = normalizeMac(device.mac);
  const ip = normalizeDiscoveryStringKey(device.ip);
  const port = normalizePort(device.port);
  const name = normalizeDiscoveryStringKey(device.name);
  const type = normalizeDiscoveryStringKey(normalizeDeviceType(device.type));

  if (mac) candidates.push(`mac:${mac}`);
  if (ip && port) candidates.push(`ipport:${ip}:${port}`);
  if (ip) candidates.push(`ip:${ip}`);
  if (name && type) candidates.push(`name:${name}|type:${type}`);
  if (name) candidates.push(`name:${name}`);

  return [...new Set(candidates)];
}

function mergeSources(...sourceLists) {
  const merged = new Set();
  sourceLists.flat().forEach((source) => {
    const normalized = normalizeDiscoveryString(source);
    if (normalized) merged.add(normalized);
  });
  return [...merged].sort((a, b) => a.localeCompare(b));
}

function getTimeValue(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : 0;
}

function extractTimestampFromLogLine(line = '') {
  const text = String(line || '');
  const match = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (!match) {
    return { timestamp: null, message: text };
  }

  const timestamp = match[1];
  const startIndex = match.index || 0;
  const endIndex = startIndex + timestamp.length;

  let message = text.slice(endIndex).trim();
  if (message.startsWith(']')) {
    message = message.slice(1).trim();
  }

  if (!message) {
    message = text.slice(startIndex).trim();
  }

  return { timestamp, message };
}

function mergeDiscoveryDevice(existing = {}, incoming = {}) {
  const incomingHasNewerSeen = getTimeValue(incoming.lastSeen) >= getTimeValue(existing.lastSeen);
  return {
    name: normalizeDiscoveryString(existing.name) || normalizeDiscoveryString(incoming.name),
    ip: normalizeDiscoveryString(existing.ip) || normalizeDiscoveryString(incoming.ip),
    port: normalizePort(existing.port) || normalizePort(incoming.port),
    mac: formatMac(existing.mac) || formatMac(incoming.mac),
    type: choosePreferredType(existing.type, incoming.type),
    visible: Boolean(existing.visible || incoming.visible),
    configured: Boolean(existing.configured || incoming.configured),
    lastSeen: incomingHasNewerSeen ? (incoming.lastSeen || existing.lastSeen || null) : (existing.lastSeen || incoming.lastSeen || null),
    sources: mergeSources(existing.sources || [existing.source], incoming.sources || [incoming.source])
  };
}

function mergeDiscoveryEntries(devices = []) {
  const merged = [];
  const indexByCandidate = new Map();

  for (const rawDevice of devices) {
    if (!rawDevice || typeof rawDevice !== 'object') continue;
    const device = {
      name: normalizeDiscoveryString(rawDevice.name),
      ip: normalizeDiscoveryString(rawDevice.ip),
      port: normalizePort(rawDevice.port),
      mac: formatMac(rawDevice.mac),
      type: normalizeDeviceType(rawDevice.type),
      visible: rawDevice.visible !== false,
      configured: Boolean(rawDevice.configured),
      lastSeen: rawDevice.lastSeen || null,
      sources: mergeSources(rawDevice.sources || [rawDevice.source])
    };

    if (!device.name && !device.ip && !device.mac) continue;

    const candidates = getDeviceIdentityCandidates(device);
    let foundIndex = null;
    for (const candidate of candidates) {
      if (indexByCandidate.has(candidate)) {
        foundIndex = indexByCandidate.get(candidate);
        break;
      }
    }

    if (foundIndex === null) {
      foundIndex = merged.length;
      merged.push(device);
    } else {
      merged[foundIndex] = mergeDiscoveryDevice(merged[foundIndex], device);
    }

    getDeviceIdentityCandidates(merged[foundIndex]).forEach((candidate) => indexByCandidate.set(candidate, foundIndex));
  }

  return merged;
}

function pruneCachedDiscoveryDevices(devices = []) {
  const now = Date.now();
  return devices.filter((device) => {
    if (!device.lastSeen) return false;
    return now - getTimeValue(device.lastSeen) <= DISCOVERY_CACHE_TTL_MS;
  });
}

function sortDiscoveryDevices(devices = []) {
  return [...devices].sort((left, right) => {
    const leftLive = (left.sources || []).includes('logs') ? 0 : 1;
    const rightLive = (right.sources || []).includes('logs') ? 0 : 1;
    if (leftLive !== rightLive) return leftLive - rightLive;

    const leftSeen = getTimeValue(left.lastSeen);
    const rightSeen = getTimeValue(right.lastSeen);
    if (leftSeen !== rightSeen) return rightSeen - leftSeen;

    const leftName = normalizeDiscoveryString(left.name).toLowerCase();
    const rightName = normalizeDiscoveryString(right.name).toLowerCase();
    return leftName.localeCompare(rightName);
  });
}

function toDiscoveryResponseDevice(device = {}) {
  return {
    name: device.name || '',
    type: device.type || '',
    ip: device.ip || '',
    port: device.port || '',
    mac: device.mac || '',
    source: (device.sources || []).join(', '),
    sources: device.sources || [],
    visible: device.visible !== false,
    configured: Boolean(device.configured),
    lastSeen: device.lastSeen || null
  };
}

async function readDiscoveryCache() {
  try {
    const raw = await fs.promises.readFile(DISCOVERY_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      devices: Array.isArray(parsed.devices) ? pruneCachedDiscoveryDevices(parsed.devices) : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { updatedAt: null, devices: [] };
    }
    return { updatedAt: null, devices: [] };
  }
}

async function writeDiscoveryCache(devices = []) {
  const payload = {
    updatedAt: safeNowIso(),
    devices: pruneCachedDiscoveryDevices(devices)
  };
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
  await fs.promises.writeFile(DISCOVERY_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function parseDiscoveredDevicesFromLogs(logText) {
  const text = cleanDockerLogText(logText);
  const lines = text.split(/\r?\n/);
  const devices = [];

  for (const line of lines) {
    const { timestamp, message } = extractTimestampFromLogLine(line);
    const lastSeen = timestamp || safeNowIso();

    const castMatch = message.match(/AddCastDevice:.*adding renderer \((.+?) - ([0-9.]+):(\d+)\) with mac ([A-F0-9:]+)/i)
      || message.match(/adding renderer \((.+?) - ([0-9.]+):(\d+)\) with mac ([A-F0-9:]+)/i)
      || message.match(/adding renderer \((.+?) - ([0-9.]+):(\d+)\)/i);
    if (castMatch) {
      devices.push({
        name: castMatch[1].trim(),
        ip: castMatch[2].trim(),
        port: castMatch[3].trim(),
        mac: (castMatch[4] || '').trim(),
        type: Number(castMatch[3]) === 8009 ? 'Chromecast' : 'UPnP/Other',
        source: 'logs',
        visible: true,
        lastSeen
      });
      continue;
    }

    const mrMatch = message.match(/AddMRDevice:.*adding renderer \((.+?)\) with mac ([A-F0-9:]+)/i)
      || message.match(/adding renderer \((.+?)\) with mac ([A-F0-9:]+)/i);
    if (mrMatch) {
      devices.push({
        name: mrMatch[1].trim(),
        ip: '',
        port: '',
        mac: mrMatch[2].trim(),
        type: 'UPnP MediaRenderer',
        source: 'logs',
        visible: true,
        lastSeen
      });
    }
  }

  return mergeDiscoveryEntries(devices);
}

async function parseConfiguredDevices(xml, source) {
  if (!xml.trim()) return [];
  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, trim: true });
    const devices = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
          value.forEach(walk);
        } else if (value && typeof value === 'object') {
          if (key.toLowerCase() === 'device') {
            devices.push({
              name: value.name || value.Name || value.friendlyName || value.udn || 'Configured device',
              ip: value.ip || value.host || '',
              port: value.port || '',
              mac: value.mac || value.udn || '',
              type: source,
              source,
              visible: String(value.enabled ?? '1') !== '0',
              configured: true,
              lastSeen: null
            });
          }
          walk(value);
        }
      }
    };
    walk(parsed);
    return devices;
  } catch {
    return [];
  }
}

async function buildDiscoverySnapshot({ forceRefresh = false } = {}) {
  const cache = await readDiscoveryCache();
  const shouldDeepScan = Boolean(forceRefresh || !cache.devices.length);
  const logText = await getDiscoveryLogs({ forceDeepScan: shouldDeepScan, tail: DISCOVERY_RECENT_LOG_TAIL });
  const logDevices = await parseDiscoveredDevicesFromLogs(logText);
  const cachedLiveDevices = pruneCachedDiscoveryDevices(mergeDiscoveryEntries([...cache.devices, ...logDevices]));
  await writeDiscoveryCache(cachedLiveDevices);

  const [fromAirCast, fromAirUpnp, fromLegacy] = await Promise.all([
    parseConfiguredDevices(await readConfigFile('aircast'), 'aircast.xml'),
    parseConfiguredDevices(await readConfigFile('airupnp'), 'airupnp.xml'),
    parseConfiguredDevices(await readConfigFile('legacy'), 'config.xml')
  ]);

  const mergedDevices = sortDiscoveryDevices(mergeDiscoveryEntries([
    ...cachedLiveDevices,
    ...fromAirCast,
    ...fromAirUpnp,
    ...fromLegacy
  ]));

  return {
    devices: mergedDevices.map(toDiscoveryResponseDevice),
    activeDevicesCount: cachedLiveDevices.length,
    meta: {
      cacheUpdatedAt: safeNowIso(),
      refreshMode: shouldDeepScan ? 'deep-log-scan' : 'recent-log-scan',
      logDevices: logDevices.length,
      cachedDevices: cachedLiveDevices.length,
      configuredDevices: fromAirCast.length + fromAirUpnp.length + fromLegacy.length,
      totalDevices: mergedDevices.length
    }
  };
}

function buildAirCastStarterXml() {
  return `<?xml version="1.0"?>
<aircast>
  <common>
    <enabled>1</enabled>
    <name>%s+</name>
    <codec>flac</codec>
    <metadata>1</metadata>
    <flush>1</flush>
    <drift>0</drift>
    <media_volume>0.5</media_volume>
  </common>
  <main_log>info</main_log>
  <util_log>warn</util_log>
  <cast_log>info</cast_log>
  <raop_log>info</raop_log>
  <log_limit>-1</log_limit>
  <max_players>32</max_players>
  <binding>?</binding>
  <ports>0:0</ports>
</aircast>
`;
}

function buildAirUpnpStarterXml() {
  return `<?xml version="1.0"?>
<airupnp>
  <common>
    <enabled>1</enabled>
    <name>%s+</name>
    <codec>flac</codec>
    <metadata>1</metadata>
    <flush>1</flush>
    <drift>0</drift>
    <http_length>-1</http_length>
    <upnp_max>1</upnp_max>
    <latency>1000:2000</latency>
  </common>
  <main_log>info</main_log>
  <util_log>warn</util_log>
  <upnp_log>info</upnp_log>
  <raop_log>info</raop_log>
  <log_limit>-1</log_limit>
  <max_players>32</max_players>
  <binding>?</binding>
  <ports>0:0</ports>
</airupnp>
`;
}

async function collectConfigStatus() {
  const result = {};
  for (const key of Object.keys(CONFIG_FILES)) {
    const filePath = getConfigPath(key);
    const xml = await readConfigFile(key);
    result[key] = {
      key,
      label: CONFIG_FILES[key].label,
      path: filePath,
      exists: Boolean(xml.trim()),
      bytes: Buffer.byteLength(xml || '', 'utf8')
    };
  }
  return result;
}

async function buildStatusPayload() {
  const { inspect } = await getTargetContainer();
  const env = parseEnvList(inspect.Config?.Env || []);
  const logText = await getRecentLogs(500);
  const discovery = await buildDiscoverySnapshot();
  const configFiles = await collectConfigStatus();

  const aircastVar = env.AIRCAST_VAR || '';
  const airupnpVar = env.AIRUPNP_VAR || '';
  const aircastEnabled = aircastVar !== 'kill';
  const airupnpEnabled = airupnpVar !== 'kill';

  const warnings = [];
  warnings.push(...summarizeRecentConfigWarnings(logText));

  const aircastValidation = await validateServiceArgs('aircast', aircastVar, aircastEnabled);
  const airupnpValidation = await validateServiceArgs('airupnp', airupnpVar, airupnpEnabled);

  aircastValidation.errors.forEach((message, index) => warnings.push({ level: 'error', service: 'aircast', code: `aircast-error-${index}`, message }));
  aircastValidation.warnings.forEach((message, index) => warnings.push({ level: 'warning', service: 'aircast', code: `aircast-warning-${index}`, message }));
  airupnpValidation.errors.forEach((message, index) => warnings.push({ level: 'error', service: 'airupnp', code: `airupnp-error-${index}`, message }));
  airupnpValidation.warnings.forEach((message, index) => warnings.push({ level: 'warning', service: 'airupnp', code: `airupnp-warning-${index}`, message }));

  if (aircastEnabled && aircastVar.includes('/config/config.xml')) {
    warnings.push({
      level: 'warning',
      service: 'aircast',
      code: 'aircast-legacy-config',
      message: 'AIRCAST_VAR still points to /config/config.xml. This admin app now prefers /config/aircast.xml.'
    });
  }
  if (airupnpEnabled && airupnpVar.includes('/config/config.xml')) {
    warnings.push({
      level: 'warning',
      service: 'airupnp',
      code: 'airupnp-legacy-config',
      message: 'AIRUPNP_VAR still points to /config/config.xml. This admin app now prefers /config/airupnp.xml.'
    });
  }

  const seenCodes = new Set();
  const dedupedWarnings = warnings.filter((warning) => {
    const code = `${warning.service}:${warning.code}:${warning.message}`;
    if (seenCodes.has(code)) return false;
    seenCodes.add(code);
    return true;
  });

  return {
    ok: true,
    targetContainer: TARGET_CONTAINER,
    containerName: inspect.Name?.replace(/^\//, '') || TARGET_CONTAINER,
    image: inspect.Config?.Image || '',
    state: inspect.State || {},
    startedAt: inspect.State?.StartedAt || null,
    discoveredDevices: discovery.activeDevicesCount,
    logSummary: { defaultConfigWarnings: summarizeRecentConfigWarnings(logText).length },
    configFiles,
    defaults: { ...DEFAULT_ARGS },
    services: {
      aircast: {
        enabled: aircastEnabled,
        args: aircastVar,
        configPath: extractConfigPath(aircastVar) || '/config/aircast.xml',
        configExists: extractConfigPath(aircastVar) ? await fileExists(containerPathToLocalPath(extractConfigPath(aircastVar))) : false,
        hasLatencyArg: hasLatencyArg(aircastVar)
      },
      airupnp: {
        enabled: airupnpEnabled,
        args: airupnpVar,
        configPath: extractConfigPath(airupnpVar) || '/config/airupnp.xml',
        configExists: extractConfigPath(airupnpVar) ? await fileExists(containerPathToLocalPath(extractConfigPath(airupnpVar))) : false,
        hasLatencyArg: hasLatencyArg(airupnpVar)
      }
    },
    warnings: dedupedWarnings
  };
}

async function ensureActiveConfigFilesExist() {
  const { inspect } = await getTargetContainer();
  const env = parseEnvList(inspect.Config?.Env || []);
  const checks = [];
  const aircastVar = env.AIRCAST_VAR || '';
  const airupnpVar = env.AIRUPNP_VAR || '';
  if (aircastVar && aircastVar !== 'kill') {
    checks.push(validateServiceArgs('aircast', aircastVar, true));
  }
  if (airupnpVar && airupnpVar !== 'kill') {
    checks.push(validateServiceArgs('airupnp', airupnpVar, true));
  }
  const results = await Promise.all(checks);
  const errors = results.flatMap((item) => item.errors);
  if (errors.length) {
    throw new Error(errors.join(' '));
  }
}

app.get('/api/status', async (_req, res) => {
  try {
    res.json(await buildStatusPayload());
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/config/env', async (_req, res) => {
  try {
    const { inspect } = await getTargetContainer();
    const env = parseEnvList(inspect.Config?.Env || []);
    res.json({
      ok: true,
      defaults: { ...DEFAULT_ARGS },
      aircastVar: env.AIRCAST_VAR || '',
      airupnpVar: env.AIRUPNP_VAR || '',
      aircastEnabled: env.AIRCAST_VAR !== 'kill',
      airupnpEnabled: env.AIRUPNP_VAR !== 'kill'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/config/env', async (req, res) => {
  try {
    let {
      aircastEnabled = true,
      airupnpEnabled = true,
      aircastVar = '',
      airupnpVar = ''
    } = req.body || {};

    aircastVar = normalizeServiceArgs('aircast', aircastEnabled, aircastVar);
    airupnpVar = normalizeServiceArgs('airupnp', airupnpEnabled, airupnpVar);

    const aircastValidation = await validateServiceArgs('aircast', aircastVar, aircastEnabled);
    const airupnpValidation = await validateServiceArgs('airupnp', airupnpVar, airupnpEnabled);
    const errors = [...aircastValidation.errors, ...airupnpValidation.errors];
    const warnings = [...aircastValidation.warnings, ...airupnpValidation.warnings];

    if (errors.length) {
      return res.status(400).json({ ok: false, error: errors.join(' ') });
    }

    const result = await recreateContainerWithEnv({
      AIRCAST_VAR: aircastVar,
      AIRUPNP_VAR: airupnpVar
    });

    res.json({ ok: true, message: 'Container recreated with updated environment', result, warnings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/config/file/:key', async (req, res) => {
  try {
    const key = String(req.params.key || '').toLowerCase();
    if (!CONFIG_FILES[key]) {
      return res.status(404).json({ ok: false, error: 'Unknown config file key' });
    }
    const xml = await readConfigFile(key);
    res.json({
      ok: true,
      key,
      label: CONFIG_FILES[key].label,
      path: getConfigPath(key),
      exists: Boolean(xml.trim()),
      xml
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/config/file/:key', async (req, res) => {
  try {
    const key = String(req.params.key || '').toLowerCase();
    if (!CONFIG_FILES[key]) {
      return res.status(404).json({ ok: false, error: 'Unknown config file key' });
    }

    const { xml, restartContainer = false } = req.body || {};
    if (typeof xml !== 'string') {
      return res.status(400).json({ ok: false, error: 'xml must be a string' });
    }
    if (xml.trim()) {
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const root = Object.keys(parsed || {})[0] || '';
      if (key !== 'legacy' && root !== CONFIG_FILES[key].root) {
        return res.status(400).json({ ok: false, error: `${CONFIG_FILES[key].label} must use a <${CONFIG_FILES[key].root}> root element.` });
      }
    }

    await writeConfigFile(key, xml);

    if (restartContainer) {
      await ensureActiveConfigFilesExist();
      const { container } = await getTargetContainer();
      await container.restart();
    }

    res.json({ ok: true, path: getConfigPath(key) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/config/generate', async (req, res) => {
  try {
    const target = String(req.body?.target || 'both').toLowerCase();
    const generated = {};

    if (target === 'aircast' || target === 'both') {
      generated.aircast = buildAirCastStarterXml();
      await writeConfigFile('aircast', generated.aircast);
    }
    if (target === 'airupnp' || target === 'both') {
      generated.airupnp = buildAirUpnpStarterXml();
      await writeConfigFile('airupnp', generated.airupnp);
    }

    if (!Object.keys(generated).length) {
      return res.status(400).json({ ok: false, error: 'target must be aircast, airupnp, or both' });
    }

    res.json({ ok: true, generated });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/container/restart', async (_req, res) => {
  try {
    await ensureActiveConfigFilesExist();
    const { container } = await getTargetContainer();
    await container.restart();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/container/start', async (_req, res) => {
  try {
    await ensureActiveConfigFilesExist();
    const { container } = await getTargetContainer();
    await container.start();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/container/stop', async (_req, res) => {
  try {
    const { container } = await getTargetContainer();
    await container.stop({ t: 10 });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const tail = Math.min(Number(req.query.tail || 300), 2000);
    const logs = await getRecentLogs(tail);
    res.json({ ok: true, logs });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/discovery', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const snapshot = await buildDiscoverySnapshot({ forceRefresh });
    res.json({ ok: true, devices: snapshot.devices, meta: snapshot.meta });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/deployment/compose', async (_req, res) => {
  try {
    const { inspect } = await getTargetContainer();
    const env = parseEnvList(inspect.Config?.Env || []);
    const image = inspect.Config?.Image || '1activegeek/airconnect';
    const compose = `services:\n  airconnect:\n    image: ${image}\n    container_name: ${TARGET_CONTAINER}\n    network_mode: host\n    volumes:\n      - /root/airconnect:/config\n    environment:\n      - AIRCAST_VAR=${(env.AIRCAST_VAR || DEFAULT_ARGS.aircast).replace(/\n/g, ' ')}\n      - AIRUPNP_VAR=${(env.AIRUPNP_VAR || DEFAULT_ARGS.airupnp).replace(/\n/g, ' ')}\n    restart: unless-stopped\n\n  airconnect-admin:\n    image: yourrepo/airconnect-admin:latest\n    container_name: airconnect-admin\n    ports:\n      - \"${ADMIN_HOST_PORT}:8080\"\n    volumes:\n      - /root/airconnect:/config\n      - /var/run/docker.sock:/var/run/docker.sock\n    environment:\n      - TARGET_CONTAINER=${TARGET_CONTAINER}\n      - CONFIG_DIR=/config\n      - PORT=8080\n      - ADMIN_HOST_PORT=${ADMIN_HOST_PORT}\n    restart: unless-stopped\n`;
    res.json({ ok: true, compose });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'airconnect-admin', time: safeNowIso() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`AirConnect Admin listening on port ${port}`);
});
