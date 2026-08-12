'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  mode: null, // 'studio' | 'sender'
  studio: {
    port: 4455,
    code: '',
    preset: 'auto',
    fps: 30,
    bitrate: 5000,
    audioBitrate: 160,
    fit: 'contain',
    background: '#000000',
    rtmpUrl: '',
    rtmpKey: '',
    outputMode: 'rtmp', // 'rtmp' | 'file'
    deviceId: '',
    camEnabled: false,
    camDeviceId: '',
    camPosition: 'bottom-right',
    camSize: 26,
    camShape: 'rect',
    micDeviceId: '',
    micGain: 1,
    remoteGain: 1,
    sourceKind: 'remote' // 'remote' | 'device' | 'screen'
  },
  sender: {
    host: '',
    port: 4455,
    code: '',
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 30,
    withAudio: true
  }
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE(), 'utf8')));
  } catch {
    cache = deepMerge(DEFAULTS, {});
  }
  return cache;
}

function save(patch) {
  cache = deepMerge(load(), patch);
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('No se pudo guardar la configuración:', err.message);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
