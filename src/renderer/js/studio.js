'use strict';

/**
 * Modo Estudio: compone la escena (fuente principal + cámara + audio) en un
 * canvas, la graba con MediaRecorder y se la pasa a ffmpeg, que la manda por
 * RTMP a TikTok.
 */

const log = makeLogger('log');

const MIME_CANDIDATES = [
  'video/x-matroska;codecs=avc1,opus',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

const state = {
  cfg: null,
  width: 1080,
  height: 1920,
  fit: 'contain',
  background: '#000000',
  sourceKind: 'remote',
  live: false,
  clean: false,
  auto: false,
  autoKey: '',
  startedAt: 0,
  retries: 0,
  raf: null,
  lastFrame: 0,
  recorder: null,
  canvasStream: null,
  pc: null,
  pendingIce: [],
  labelsReady: false,
  streams: { device: null, screen: null, cam: null, mic: null }
};

const audio = {
  ctx: null,
  dest: null,
  micGain: null,
  sourceGain: null,
  monitorGain: null,
  micNode: null,
  sourceNode: null
};

const el = {};
for (const id of [
  'preview', 'source-kind', 'pane-remote', 'pane-device', 'pane-screen', 'ip-list', 'copy-ip',
  'port', 'code', 'code-big', 'new-code', 'server-state', 'restart-server', 'video-device',
  'device-audio', 'refresh-devices', 'local-source', 'refresh-local', 'fit', 'background',
  'cam-enabled', 'cam-device', 'cam-position', 'cam-shape', 'cam-size', 'cam-size-label',
  'mic-device', 'mic-gain', 'mic-gain-label', 'remote-gain', 'remote-gain-label', 'monitor',
  'preset', 'fps', 'bitrate', 'audio-bitrate', 'output-mode', 'pane-rtmp', 'pane-file',
  'rtmp-url', 'rtmp-key', 'file-path', 'pick-file', 'auto-retry', 'go-live', 'stop-live',
  'peer-dot', 'peer-text', 'live-dot', 'live-text', 'clock', 'ff-stats', 'stage-badge',
  'clear-log', 'open-tiktok', 'fit-note', 'v-remote', 'v-device', 'v-screen', 'v-cam', 'a-remote',
  'clean-view', 'clean-overlay', 'clean-exit', 'clean-dot', 'clean-text', 'clean-clock'
]) {
  el[id] = document.getElementById(id);
}

const ctx2d = el.preview.getContext('2d', { alpha: false });

// -------------------------------------------------------------------- arranque

(async function init() {
  const settings = await window.api.settings.get();
  const cfg = settings.studio;
  state.cfg = cfg;

  if (!cfg.code) cfg.code = randomCode();

  el.port.value = cfg.port;
  el.code.value = cfg.code;
  el['code-big'].textContent = cfg.code;
  el['source-kind'].value = cfg.sourceKind;
  el.fit.value = cfg.fit;
  el.background.value = cfg.background;
  el.preset.value = cfg.preset;
  el.fps.value = String(cfg.fps);
  el.bitrate.value = cfg.bitrate;
  el['audio-bitrate'].value = String(cfg.audioBitrate);
  el['output-mode'].value = cfg.outputMode;
  el['rtmp-url'].value = cfg.rtmpUrl;
  el['rtmp-key'].value = cfg.rtmpKey;
  el['cam-enabled'].checked = !!cfg.camEnabled;
  el['cam-position'].value = cfg.camPosition;
  el['cam-shape'].value = cfg.camShape;
  el['cam-size'].value = cfg.camSize;
  el['cam-size-label'].textContent = cfg.camSize;
  el['mic-gain'].value = Math.round(cfg.micGain * 100);
  el['mic-gain-label'].textContent = Math.round(cfg.micGain * 100);
  el['remote-gain'].value = Math.round(cfg.remoteGain * 100);
  el['remote-gain-label'].textContent = Math.round(cfg.remoteGain * 100);

  applyPreset(cfg.preset);
  state.fit = cfg.fit;
  state.background = cfg.background;
  state.sourceKind = cfg.sourceKind;
  showSourcePane();
  showDestinationPane();

  wireControls();
  startDrawLoop();
  setInterval(tickClock, 500);

  await refreshAddresses();
  await startServer();

  const info = await window.api.info();
  log(`LiveBridge listo · ${info.platform} · ffmpeg incrustado`, 'ok');

  // A partir de aquí nada debe bloquear el arranque: pedir permisos de
  // micrófono o de pantalla puede quedarse esperando al usuario.
  refreshDevices().catch((err) => log(`Dispositivos: ${err.message}`, 'error'));
  refreshLocalSources().catch((err) => log(`Pantallas locales: ${err.message}`, 'error'));
  if (state.sourceKind !== 'remote') activateSource().catch(() => {});
  if (cfg.camEnabled) toggleCamera().catch(() => {});

  if (info.selfTest) runSelfTest();
})();

function persist(patch) {
  Object.assign(state.cfg, patch);
  window.api.settings.set({ studio: patch });
}

// -------------------------------------------------------------------- controles

function wireControls() {
  el['source-kind'].addEventListener('change', async () => {
    state.sourceKind = el['source-kind'].value;
    persist({ sourceKind: state.sourceKind });
    showSourcePane();
    await activateSource();
  });

  el.fit.addEventListener('change', () => {
    state.fit = el.fit.value;
    persist({ fit: state.fit });
  });

  el.background.addEventListener('change', () => {
    state.background = el.background.value;
    persist({ background: state.background });
  });

  el.preset.addEventListener('change', () => {
    applyPreset(el.preset.value);
    persist({ preset: el.preset.value });
    // La ventana de vista limpia sigue la proporción de salida.
    if (state.clean) window.api.win.clean({ on: true, width: state.width, height: state.height });
    if (state.live) log('El formato cambiará al reiniciar la emisión.', 'warn');
  });

  el.fps.addEventListener('change', () => persist({ fps: Number(el.fps.value) }));
  el.bitrate.addEventListener('change', () => persist({ bitrate: Number(el.bitrate.value) }));
  el['audio-bitrate'].addEventListener('change', () => persist({ audioBitrate: Number(el['audio-bitrate'].value) }));
  el['rtmp-url'].addEventListener('change', () => persist({ rtmpUrl: el['rtmp-url'].value.trim() }));
  el['rtmp-key'].addEventListener('change', () => persist({ rtmpKey: el['rtmp-key'].value.trim() }));

  el['output-mode'].addEventListener('change', () => {
    persist({ outputMode: el['output-mode'].value });
    showDestinationPane();
  });

  el['pick-file'].addEventListener('click', async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const path = await window.api.dialog.saveFile(`livebridge-${stamp}.mp4`);
    if (path) el['file-path'].value = path;
  });

  el.port.addEventListener('change', () => persist({ port: Number(el.port.value) }));
  el.code.addEventListener('change', () => {
    const code = el.code.value.trim();
    persist({ code });
    el['code-big'].textContent = code || '------';
  });

  el['new-code'].addEventListener('click', async () => {
    const code = randomCode();
    el.code.value = code;
    el['code-big'].textContent = code;
    persist({ code });
    await startServer();
  });

  el['restart-server'].addEventListener('click', startServer);
  el['refresh-devices'].addEventListener('click', refreshDevices);
  el['refresh-local'].addEventListener('click', refreshLocalSources);

  el['copy-ip'].addEventListener('click', () => {
    navigator.clipboard.writeText(el['ip-list'].value || '');
    log(`Copiado: ${el['ip-list'].value}`);
  });

  el['video-device'].addEventListener('change', () => {
    persist({ deviceId: el['video-device'].value });
    if (state.sourceKind === 'device') activateSource();
  });

  el['device-audio'].addEventListener('change', () => {
    if (state.sourceKind === 'device') activateSource();
  });

  el['local-source'].addEventListener('change', () => {
    if (state.sourceKind === 'screen') activateSource();
  });

  el['cam-enabled'].addEventListener('change', async () => {
    persist({ camEnabled: el['cam-enabled'].checked });
    await toggleCamera();
  });

  el['cam-device'].addEventListener('change', async () => {
    persist({ camDeviceId: el['cam-device'].value });
    if (el['cam-enabled'].checked) await toggleCamera(true);
  });

  el['cam-position'].addEventListener('change', () => persist({ camPosition: el['cam-position'].value }));
  el['cam-shape'].addEventListener('change', () => persist({ camShape: el['cam-shape'].value }));

  el['cam-size'].addEventListener('input', () => {
    el['cam-size-label'].textContent = el['cam-size'].value;
    persist({ camSize: Number(el['cam-size'].value) });
  });

  el['mic-device'].addEventListener('change', async () => {
    persist({ micDeviceId: el['mic-device'].value });
    if (audio.ctx) await attachMic();
  });

  el['mic-gain'].addEventListener('input', () => {
    const v = Number(el['mic-gain'].value);
    el['mic-gain-label'].textContent = v;
    persist({ micGain: v / 100 });
    if (audio.micGain) audio.micGain.gain.value = v / 100;
  });

  el['remote-gain'].addEventListener('input', () => {
    const v = Number(el['remote-gain'].value);
    el['remote-gain-label'].textContent = v;
    persist({ remoteGain: v / 100 });
    if (audio.sourceGain) audio.sourceGain.gain.value = v / 100;
  });

  el.monitor.addEventListener('change', () => {
    if (audio.monitorGain) audio.monitorGain.gain.value = el.monitor.checked ? 1 : 0;
  });

  el['clear-log'].addEventListener('click', () => { document.getElementById('log').innerHTML = ''; });

  el['open-tiktok'].addEventListener('click', (event) => {
    event.preventDefault();
    window.api.openExternal('https://livecenter.tiktok.com');
  });

  el['go-live'].addEventListener('click', () => startStreaming(false));
  el['stop-live'].addEventListener('click', () => stopStreaming(true));

  el['clean-view'].addEventListener('click', () => setCleanView(true));
  el['clean-exit'].addEventListener('click', () => setCleanView(false));
  $('.stage').addEventListener('dblclick', () => setCleanView(!state.clean));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.clean) setCleanView(false);
  });

  document.addEventListener('mousemove', () => {
    if (state.clean) revealOverlay();
  });

  window.addEventListener('beforeunload', () => {
    window.api.stream.stop();
    window.api.sig.stop();
  });
}

/** Techo de la salida: cabe en 1920×1080, en la orientación que toque. */
const MAX_LONG_SIDE = 1920;
const MAX_SHORT_SIDE = 1080;

function applyPreset(preset) {
  state.auto = preset === 'auto';
  el.fit.disabled = state.auto;
  el['fit-note'].textContent = state.auto ? '(no aplica en automático)' : '';

  if (state.auto) {
    // El tamaño real se toma de la fuente en cuanto llegue la primera imagen.
    state.autoKey = '';
    updateBadge();
    return;
  }

  const [w, h] = preset.split('x').map(Number);
  setCanvasSize(w, h);
}

/**
 * En automático la salida copia la forma de la fuente: ni franjas negras ni
 * recorte, y la orientación (horizontal o vertical) sale de la propia pantalla.
 * Nunca se escala hacia arriba, para no gastar bitrate inventando píxeles.
 */
function computeAutoSize(vw, vh) {
  const long = Math.max(vw, vh);
  const short = Math.min(vw, vh);
  const scale = Math.min(1, MAX_LONG_SIDE / long, MAX_SHORT_SIDE / short);
  return { width: toEven(vw * scale), height: toEven(vh * scale) };
}

// H.264 con yuv420p exige dimensiones pares.
function toEven(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function setCanvasSize(w, h) {
  if (state.width === w && state.height === h) return;
  state.width = w;
  state.height = h;
  el.preview.width = w;
  el.preview.height = h;
  updateBadge();
  if (state.clean) window.api.win.clean({ on: true, width: w, height: h });
}

function updateBadge() {
  const orientation = state.width > state.height ? 'horizontal'
    : state.width < state.height ? 'vertical' : 'cuadrado';
  el['stage-badge'].textContent = state.auto
    ? `Vista previa · automático ${state.width}×${state.height} (${orientation})`
    : `Vista previa · ${state.width}×${state.height}`;
}

/** Ajusta el lienzo a la fuente actual cuando el modo automático está activo. */
function syncAutoSize(video) {
  if (!state.auto || !video || !video.videoWidth) return;

  const key = `${video.videoWidth}x${video.videoHeight}`;
  if (key === state.autoKey) return;
  state.autoKey = key;

  if (state.live) {
    log('La fuente cambió de tamaño; el formato se ajustará al reiniciar la emisión.', 'warn');
    return;
  }

  const { width, height } = computeAutoSize(video.videoWidth, video.videoHeight);
  setCanvasSize(width, height);
  log(`Formato automático: ${width}×${height} (fuente ${key})`, 'ok');
}

function showSourcePane() {
  el['pane-remote'].hidden = state.sourceKind !== 'remote';
  el['pane-device'].hidden = state.sourceKind !== 'device';
  el['pane-screen'].hidden = state.sourceKind !== 'screen';
}

function showDestinationPane() {
  const mode = el['output-mode'].value;
  el['pane-rtmp'].hidden = mode !== 'rtmp';
  el['pane-file'].hidden = mode !== 'file';
}

// ------------------------------------------------------------------ dispositivos

/**
 * Sin permiso concedido, enumerateDevices() devuelve etiquetas vacías. Pedimos
 * solo el micrófono: los nombres de las cámaras aparecerán en cuanto el usuario
 * encienda una (y entonces recargamos la lista).
 */
async function ensureLabels() {
  if (state.labelsReady) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    state.labelsReady = true;
  } catch (err) {
    log(`Sin acceso al micrófono (${err.name}); los dispositivos saldrán sin nombre.`, 'warn');
  }
}

async function refreshDevices() {
  await ensureLabels();
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    log(`No se pudieron listar los dispositivos: ${err.message}`, 'error');
    return;
  }

  fillSelect(el['video-device'], devices.filter((d) => d.kind === 'videoinput'), state.cfg.deviceId, 'Cámara');
  fillSelect(el['cam-device'], devices.filter((d) => d.kind === 'videoinput'), state.cfg.camDeviceId, 'Cámara');
  fillSelect(el['mic-device'], devices.filter((d) => d.kind === 'audioinput'), state.cfg.micDeviceId, 'Micrófono');
}

function fillSelect(select, devices, selected, fallbackLabel) {
  select.innerHTML = '';
  if (!devices.length) {
    select.innerHTML = '<option value="">(ninguno detectado)</option>';
    return;
  }
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
    select.appendChild(option);
  });
  if (selected && devices.some((d) => d.deviceId === selected)) select.value = selected;
}

async function refreshLocalSources() {
  try {
    const sources = await window.api.sources.list({ types: ['screen', 'window'] });
    el['local-source'].innerHTML = '';
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = `${source.kind === 'screen' ? '🖥' : '🪟'} ${source.name}`;
      el['local-source'].appendChild(option);
    }
  } catch (err) {
    log(`Fuentes locales: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------- fuentes

function activeVideo() {
  if (state.sourceKind === 'remote') return el['v-remote'];
  if (state.sourceKind === 'device') return el['v-device'];
  return el['v-screen'];
}

async function activateSource() {
  stopStream('device');
  stopStream('screen');

  if (state.sourceKind === 'device') {
    const deviceId = el['video-device'].value;
    if (!deviceId) return log('No hay dispositivo de vídeo seleccionado.', 'warn');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: Number(el.fps.value) } },
        audio: el['device-audio'].checked ? { deviceId: { exact: deviceId } } : false
      }).catch(async (err) => {
        // Muchas capturadoras exponen el audio como un dispositivo aparte.
        if (el['device-audio'].checked) {
          log(`Sin audio del dispositivo (${err.name}): solo vídeo.`, 'warn');
          return navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
          });
        }
        throw err;
      });

      state.streams.device = stream;
      el['v-device'].srcObject = stream;
      if (audio.ctx) attachSourceAudio(stream);
      const s = stream.getVideoTracks()[0].getSettings();
      log(`Dispositivo activo: ${s.width}×${s.height}`, 'ok');
    } catch (err) {
      log(`No se pudo abrir el dispositivo: ${err.message}`, 'error');
    }
    return;
  }

  if (state.sourceKind === 'screen') {
    const id = el['local-source'].value;
    if (!id) return log('Elige una pantalla local.', 'warn');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: id,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: Number(el.fps.value)
          }
        }
      });
      state.streams.screen = stream;
      el['v-screen'].srcObject = stream;
      log('Pantalla local activa.', 'ok');
    } catch (err) {
      log(`No se pudo capturar la pantalla local: ${err.message}`, 'error');
    }
  }
}

function stopStream(key) {
  const stream = state.streams[key];
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  state.streams[key] = null;
  const video = { device: el['v-device'], screen: el['v-screen'], cam: el['v-cam'] }[key];
  if (video) video.srcObject = null;
  if (key === 'device' && audio.sourceNode) {
    try { audio.sourceNode.disconnect(); } catch {}
    audio.sourceNode = null;
  }
}

async function toggleCamera(force) {
  const on = el['cam-enabled'].checked;
  if (!on) {
    stopStream('cam');
    return;
  }
  if (state.streams.cam && !force) return;
  stopStream('cam');
  try {
    const deviceId = el['cam-device'].value;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 } } : { width: { ideal: 1280 } },
      audio: false
    });
    state.streams.cam = stream;
    el['v-cam'].srcObject = stream;
    log('Cámara encendida.', 'ok');
    // Con el permiso ya concedido, ahora sí llegan los nombres reales.
    await refreshDevices();
  } catch (err) {
    log(`Cámara: ${err.message}`, 'error');
    el['cam-enabled'].checked = false;
  }
}

// ------------------------------------------------------------------- compositor

function startDrawLoop() {
  const step = () => {
    state.raf = requestAnimationFrame(step);
    const interval = 1000 / Number(el.fps.value || 30);
    const now = performance.now();
    if (now - state.lastFrame < interval - 1) return;
    state.lastFrame = now;
    drawFrame();
  };
  state.raf = requestAnimationFrame(step);
}

function drawFrame() {
  const main = activeVideo();
  syncAutoSize(main);

  const { width: W, height: H } = state;

  ctx2d.fillStyle = state.background;
  ctx2d.fillRect(0, 0, W, H);

  if (main && main.videoWidth && main.readyState >= 2) {
    drawFitted(main, state.fit);
  } else {
    drawPlaceholder();
  }

  if (el['cam-enabled'].checked && state.streams.cam) {
    const cam = el['v-cam'];
    if (cam.videoWidth) drawCamera(cam);
  }
}

function drawFitted(video, fit) {
  const { width: W, height: H } = state;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = fit === 'cover' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx2d.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawCamera(cam) {
  const { width: W, height: H } = state;
  const margin = Math.round(W * 0.03);
  const boxW = Math.round(W * (Number(el['cam-size'].value) / 100));
  const shape = el['cam-shape'].value;
  const boxH = shape === 'circle' ? boxW : Math.round(boxW * (cam.videoHeight / cam.videoWidth));

  const pos = el['cam-position'].value;
  const x = pos.endsWith('left') ? margin : W - boxW - margin;
  const y = pos.startsWith('top') ? margin : H - boxH - margin;

  // Recorte central de la cámara para llenar la caja sin deformar.
  const srcScale = Math.max(boxW / cam.videoWidth, boxH / cam.videoHeight);
  const sw = boxW / srcScale;
  const sh = boxH / srcScale;
  const sx = (cam.videoWidth - sw) / 2;
  const sy = (cam.videoHeight - sh) / 2;

  ctx2d.save();
  ctx2d.beginPath();
  if (shape === 'circle') {
    ctx2d.arc(x + boxW / 2, y + boxH / 2, boxW / 2, 0, Math.PI * 2);
  } else {
    roundRect(ctx2d, x, y, boxW, boxH, Math.round(boxW * 0.05));
  }
  ctx2d.closePath();
  ctx2d.clip();
  ctx2d.drawImage(cam, sx, sy, sw, sh, x, y, boxW, boxH);
  ctx2d.restore();

  ctx2d.save();
  ctx2d.strokeStyle = 'rgba(255,255,255,.85)';
  ctx2d.lineWidth = Math.max(2, Math.round(W * 0.004));
  ctx2d.beginPath();
  if (shape === 'circle') {
    ctx2d.arc(x + boxW / 2, y + boxH / 2, boxW / 2, 0, Math.PI * 2);
  } else {
    roundRect(ctx2d, x, y, boxW, boxH, Math.round(boxW * 0.05));
  }
  ctx2d.stroke();
  ctx2d.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

function drawPlaceholder() {
  const { width: W, height: H } = state;
  ctx2d.fillStyle = '#6b7186';
  ctx2d.textAlign = 'center';
  ctx2d.font = `${Math.round(W * 0.035)}px -apple-system, system-ui, sans-serif`;
  const text = state.sourceKind === 'remote'
    ? 'Esperando al emisor…'
    : 'Sin señal en la fuente seleccionada';
  ctx2d.fillText(text, W / 2, H / 2);
}

// ------------------------------------------------------------------------ audio

function ensureAudioGraph() {
  if (audio.ctx) return;
  const ctx = new AudioContext({ sampleRate: 48000 });
  audio.ctx = ctx;
  audio.dest = ctx.createMediaStreamDestination();

  audio.micGain = ctx.createGain();
  audio.micGain.gain.value = Number(el['mic-gain'].value) / 100;
  audio.micGain.connect(audio.dest);

  audio.sourceGain = ctx.createGain();
  audio.sourceGain.gain.value = Number(el['remote-gain'].value) / 100;
  audio.sourceGain.connect(audio.dest);

  audio.monitorGain = ctx.createGain();
  audio.monitorGain.gain.value = el.monitor.checked ? 1 : 0;
  audio.sourceGain.connect(audio.monitorGain);
  audio.monitorGain.connect(ctx.destination);
}

async function attachMic() {
  ensureAudioGraph();
  if (audio.micNode) {
    try { audio.micNode.disconnect(); } catch {}
    audio.micNode = null;
  }
  if (state.streams.mic) {
    state.streams.mic.getTracks().forEach((t) => t.stop());
    state.streams.mic = null;
  }
  const deviceId = el['mic-device'].value;
  if (!deviceId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false
      }
    });
    state.streams.mic = stream;
    audio.micNode = audio.ctx.createMediaStreamSource(stream);
    audio.micNode.connect(audio.micGain);
    log('Micrófono conectado a la mezcla.', 'ok');
  } catch (err) {
    log(`Micrófono: ${err.message}`, 'error');
  }
}

function attachSourceAudio(stream) {
  if (!stream || !stream.getAudioTracks().length) return;
  ensureAudioGraph();
  if (audio.sourceNode) {
    try { audio.sourceNode.disconnect(); } catch {}
    audio.sourceNode = null;
  }
  audio.sourceNode = audio.ctx.createMediaStreamSource(stream);
  audio.sourceNode.connect(audio.sourceGain);
  log('Audio de la fuente conectado a la mezcla.', 'ok');
}

// ------------------------------------------------------------------ señalización

async function startServer() {
  const port = Number(el.port.value) || 4455;
  const code = el.code.value.trim();
  try {
    const res = await window.api.sig.startServer({ port, code });
    el['server-state'].textContent = `Escuchando en el puerto ${res.port}. Esperando al emisor.`;
    log(`Servidor de emparejamiento en :${res.port}`, 'ok');
  } catch (err) {
    el['server-state'].textContent = `No se pudo abrir el puerto ${port}.`;
    log(`Servidor: ${err.message}`, 'error');
  }
}

async function refreshAddresses() {
  const addresses = await window.api.net.addresses();
  el['ip-list'].innerHTML = '';
  if (!addresses.length) {
    el['ip-list'].innerHTML = '<option value="">(sin red local)</option>';
    return;
  }
  for (const addr of addresses) {
    const option = document.createElement('option');
    option.value = addr.address;
    option.textContent = `${addr.address}  ·  ${addr.name}`;
    el['ip-list'].appendChild(option);
  }
}

window.api.sig.onPeer((info) => {
  if (info.connected) {
    setDot(el['peer-dot'], el['peer-text'], 'on', info.name || 'Emisor conectado');
    log(`Emisor conectado: ${info.name || info.address}`, 'ok');
  } else {
    setDot(el['peer-dot'], el['peer-text'], '', 'Sin emisor');
    log('Emisor desconectado.', 'warn');
    closePeer();
  }
});

window.api.sig.onStatus((info) => log(info.text, info.level === 'error' ? 'error' : 'warn'));

window.api.sig.onMessage(async (msg) => {
  try {
    if (msg.t === 'offer') await handleOffer(msg.sdp);
    else if (msg.t === 'ice' && msg.candidate) await addIce(msg.candidate);
  } catch (err) {
    log(`Señalización: ${err.message}`, 'error');
  }
});

async function handleOffer(sdp) {
  closePeer();

  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  state.pc = pc;
  state.pendingIce = [];

  pc.addEventListener('track', (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    if (event.track.kind === 'video') {
      el['v-remote'].srcObject = stream;
      el['v-remote'].play().catch(() => {});
      log('Recibiendo vídeo del emisor.', 'ok');
    } else {
      // Chromium necesita el stream enganchado a un elemento para que
      // Web Audio reciba muestras del audio remoto.
      el['a-remote'].srcObject = stream;
      attachSourceAudio(stream);
    }
  });

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) window.api.sig.send({ t: 'ice', candidate: event.candidate.toJSON() });
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') log('La conexión WebRTC ha fallado.', 'error');
  });

  await pc.setRemoteDescription({ type: 'offer', sdp });
  for (const candidate of state.pendingIce.splice(0)) {
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  window.api.sig.send({ t: 'answer', sdp: pc.localDescription.sdp });
  log('Respuesta enviada al emisor.');
}

async function addIce(candidate) {
  if (!state.pc || !state.pc.remoteDescription) {
    state.pendingIce.push(candidate);
    return;
  }
  await state.pc.addIceCandidate(candidate);
}

function closePeer() {
  if (state.pc) {
    try { state.pc.close(); } catch {}
    state.pc = null;
  }
  el['v-remote'].srcObject = null;
  el['a-remote'].srcObject = null;
  if (audio.sourceNode) {
    try { audio.sourceNode.disconnect(); } catch {}
    audio.sourceNode = null;
  }
}

// --------------------------------------------------------------------- emisión

function pickMime() {
  for (const mime of MIME_CANDIDATES) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

async function startStreaming(isRetry) {
  if (state.live) return;

  const outputMode = el['output-mode'].value;
  if (outputMode === 'rtmp') {
    if (!el['rtmp-url'].value.trim() || !el['rtmp-key'].value.trim()) {
      return log('Rellena la URL del servidor y la clave de retransmisión.', 'error');
    }
  } else if (!el['file-path'].value) {
    return log('Elige el fichero MP4 de salida.', 'error');
  }

  ensureAudioGraph();
  if (audio.ctx.state === 'suspended') await audio.ctx.resume();
  if (!audio.micNode && el['mic-device'].value) await attachMic();

  const fps = Number(el.fps.value);
  const mixed = new MediaStream();

  state.canvasStream = el.preview.captureStream(fps);
  state.canvasStream.getVideoTracks().forEach((t) => mixed.addTrack(t));
  audio.dest.stream.getAudioTracks().forEach((t) => mixed.addTrack(t));

  const cfg = {
    outputMode,
    rtmpUrl: el['rtmp-url'].value.trim(),
    rtmpKey: el['rtmp-key'].value.trim(),
    filePath: el['file-path'].value,
    fps,
    bitrate: Number(el.bitrate.value),
    audioBitrate: Number(el['audio-bitrate'].value)
  };

  try {
    await window.api.stream.start(cfg);
  } catch (err) {
    log(`ffmpeg no arrancó: ${err.message}`, 'error');
    return;
  }

  const mimeType = pickMime();
  try {
    state.recorder = new MediaRecorder(mixed, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: cfg.bitrate * 1000 * 1.4,
      audioBitsPerSecond: cfg.audioBitrate * 1000
    });
  } catch (err) {
    log(`MediaRecorder: ${err.message}`, 'error');
    await window.api.stream.stop();
    return;
  }

  // Los trozos se encolan: si se enviaran en paralelo podrían llegar
  // desordenados a ffmpeg y romper el contenedor.
  state.chunkQueue = Promise.resolve();
  state.recorder.addEventListener('dataavailable', (event) => {
    if (!event.data || !event.data.size) return;
    state.chunkQueue = state.chunkQueue.then(async () => {
      const buffer = await event.data.arrayBuffer();
      window.api.stream.chunk(buffer);
    }).catch(() => {});
  });

  state.recorder.addEventListener('error', (event) => {
    log(`Grabador: ${event.error && event.error.message}`, 'error');
  });

  state.recorder.start(200);

  state.live = true;
  state.startedAt = Date.now();
  if (!isRetry) state.retries = 0;
  el['go-live'].disabled = true;
  el['stop-live'].disabled = false;
  setDot(el['live-dot'], el['live-text'], 'live', outputMode === 'file' ? 'Grabando' : 'EN DIRECTO');
  log(`Emisión iniciada · ${state.width}×${state.height} @${fps} · ${cfg.bitrate} kbps · ${mimeType || 'por defecto'}`, 'ok');
}

async function stopStreaming(manual) {
  if (!state.live) return;
  state.live = false;
  if (manual) state.retries = 99; // corta cualquier reintento pendiente

  // Esperamos al último trozo antes de cerrar ffmpeg: si no, el MP4 se queda
  // sin cerrar y el final del directo se pierde.
  const recorder = state.recorder;
  state.recorder = null;
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      const done = () => resolve();
      recorder.addEventListener('stop', done, { once: true });
      setTimeout(done, 2000);
      try { recorder.stop(); } catch { done(); }
    });
  }
  await (state.chunkQueue || Promise.resolve()).catch(() => {});

  if (state.canvasStream) {
    state.canvasStream.getTracks().forEach((t) => t.stop());
    state.canvasStream = null;
  }

  await window.api.stream.stop();

  el['go-live'].disabled = false;
  el['stop-live'].disabled = true;
  setDot(el['live-dot'], el['live-text'], '', 'Parado');
  el['ff-stats'].textContent = '—';
  if (manual) log('Emisión detenida.', 'warn');
}

window.api.stream.onLog((entry) => log(`ffmpeg: ${entry.text}`, entry.level));

window.api.stream.onStats((stats) => {
  el['ff-stats'].textContent = `${stats.fps} fps · ${stats.bitrate} · ${stats.speed}`;
  if (stats.speed && parseFloat(stats.speed) < 0.92) {
    // Se está quedando atrás: el bitrate o la resolución piden demasiada CPU.
    el['ff-stats'].style.color = 'var(--warn)';
  } else {
    el['ff-stats'].style.color = '';
  }
});

window.api.stream.onEnded(async (info) => {
  if (info.expected) {
    log('ffmpeg finalizado.', 'ok');
    return;
  }

  log(`ffmpeg se cerró de forma inesperada (código ${info.code}).`, 'error');
  const wasLive = state.live;
  await stopStreaming(false);

  if (wasLive && el['auto-retry'].checked && state.retries < 5) {
    state.retries += 1;
    log(`Reintentando en 4 s (intento ${state.retries}/5)…`, 'warn');
    setTimeout(() => startStreaming(true), 4000);
  }
});

function tickClock() {
  const text = state.live ? fmtDuration((Date.now() - state.startedAt) / 1000) : '00:00:00';
  el.clock.textContent = text;
  if (state.clean) {
    el['clean-clock'].textContent = text;
    el['clean-dot'].className = el['live-dot'].className;
    el['clean-text'].textContent = el['live-text'].textContent;
  }
}

// ------------------------------------------------------------- vista limpia

/**
 * Oculta toda la interfaz y deja solo el canvas, con la ventana ajustada a la
 * proporción de salida. Pensado para que TikTok LIVE Studio (u OBS) capture
 * esta ventana y reciba exactamente la composición.
 */
function setCleanView(on) {
  state.clean = on;
  document.body.classList.toggle('clean', on);
  el['clean-overlay'].hidden = !on;
  window.api.win.clean({ on, width: state.width, height: state.height });
  if (on) {
    revealOverlay();
    log('Vista limpia activada. Captura esta ventana desde LIVE Studio; sal con Esc.', 'ok');
  }
}

/** El aviso flotante se desvanece solo para no salir en la captura. */
function revealOverlay() {
  el['clean-overlay'].classList.remove('faded');
  clearTimeout(revealOverlay.timer);
  revealOverlay.timer = setTimeout(() => {
    el['clean-overlay'].classList.add('faded');
  }, 2500);
}

/**
 * Autoprueba (`--selftest`): graba 6 s del compositor a un MP4 temporal para
 * comprobar que canvas -> MediaRecorder -> ffmpeg funciona en esta máquina.
 * El resultado se imprime por consola y la app se cierra sola.
 */
async function runSelfTest() {
  const { tmpDir, sep } = await window.api.info();
  const target = `${tmpDir}${sep}livebridge-selftest.mp4`;
  el['output-mode'].value = 'file';
  showDestinationPane();
  el['file-path'].value = target;

  console.warn(`[selftest] grabando 6 s en ${target}`);
  await startStreaming(false);
  if (!state.live) {
    console.warn('[selftest] RESULTADO: FALLO al iniciar');
    window.api.quit(1);
    return;
  }

  // El cálculo del formato automático, con fuentes de distinta forma.
  const casos = [
    [1920, 1080, 1920, 1080], // 16:9 nativo, se respeta
    [2560, 1440, 1920, 1080], // 2K horizontal, se reduce
    [3840, 2160, 1920, 1080], // 4K horizontal, se reduce
    [1280, 800, 1280, 800],   // portátil 16:10, no se escala hacia arriba
    [1600, 1200, 1440, 1080], // 4:3, limitado por el lado corto
    [1080, 1920, 1080, 1920], // vertical nativo
    [1200, 1600, 1080, 1440]  // vertical 3:4
  ];
  const fallos = casos.filter(([vw, vh, w, h]) => {
    const r = computeAutoSize(vw, vh);
    return r.width !== w || r.height !== h;
  });
  console.warn(`[selftest] formato automático: ${fallos.length === 0 ? 'OK' : `FALLO en ${JSON.stringify(fallos)}`}`);

  // De paso ejercitamos la vista limpia mientras se está grabando.
  setTimeout(() => {
    setCleanView(true);
    const ok = document.body.classList.contains('clean')
      && getComputedStyle($('.sidebar')).display === 'none';
    console.warn(`[selftest] vista limpia: ${ok ? 'OK' : 'FALLO'}`);
    setCleanView(false);
    console.warn(`[selftest] vuelta a normal: ${document.body.classList.contains('clean') ? 'FALLO' : 'OK'}`);
  }, 3000);

  setTimeout(async () => {
    await stopStreaming(true);
    console.warn('[selftest] RESULTADO: emisión iniciada y detenida sin errores');
    setTimeout(() => window.api.quit(0), 1200);
  }, 6000);
}
