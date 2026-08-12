'use strict';

/**
 * Modo Emisor: captura una pantalla o ventana de ESTE equipo y la manda por
 * WebRTC al Estudio, que es quien emite a TikTok.
 */

const log = makeLogger('log');

const state = {
  cfg: null,
  kind: 'screen',
  sources: [],
  selectedId: null,
  pc: null,
  stream: null,
  connected: false,
  statsTimer: null
};

const el = {
  sources: $('#sources'),
  host: $('#host'),
  port: $('#port'),
  code: $('#code'),
  res: $('#res'),
  fps: $('#fps'),
  quality: $('#quality'),
  sharp: $('#sharp'),
  withAudio: $('#with-audio'),
  audioHint: $('#audio-hint'),
  connect: $('#connect'),
  disconnect: $('#disconnect'),
  self: $('#self'),
  connDot: $('#conn-dot'),
  connText: $('#conn-text'),
  statPill: $('#stat-pill'),
  permNotice: $('#perm-notice'),
  waylandNotice: $('#wayland-notice')
};

// ------------------------------------------------------------------ arranque

(async function init() {
  const settings = await window.api.settings.get();
  state.cfg = settings.sender;

  el.host.value = state.cfg.host || '';
  el.port.value = state.cfg.port || 4455;
  el.code.value = state.cfg.code || '';
  el.res.value = `${state.cfg.maxWidth}x${state.cfg.maxHeight}`;
  el.fps.value = String(state.cfg.fps || 30);
  el.quality.value = String(state.cfg.maxBitrate || 16000000);
  el.sharp.checked = state.cfg.sharp !== false;
  el.withAudio.checked = state.cfg.withAudio !== false;

  for (const [node, key] of [[el.host, 'host'], [el.code, 'code']]) {
    node.addEventListener('change', () => persist({ [key]: node.value.trim() }));
  }
  el.port.addEventListener('change', () => persist({ port: Number(el.port.value) }));
  el.fps.addEventListener('change', () => persist({ fps: Number(el.fps.value) }));
  el.quality.addEventListener('change', () => persist({ maxBitrate: Number(el.quality.value) }));
  el.sharp.addEventListener('change', () => persist({ sharp: el.sharp.checked }));
  el.withAudio.addEventListener('change', () => persist({ withAudio: el.withAudio.checked }));
  el.res.addEventListener('change', () => {
    const [w, h] = el.res.value.split('x').map(Number);
    persist({ maxWidth: w, maxHeight: h });
  });

  const info = await window.api.info();
  el.audioHint.textContent = audioHintFor(info.platform);
  if (info.isWayland) el.waylandNotice.classList.remove('hidden');

  if (info.platform === 'darwin') {
    const status = await window.api.perms.media('screen');
    if (status !== 'granted') el.permNotice.classList.remove('hidden');
  }

  await loadSources();
  log('Emisor listo. Elige una fuente y conecta con el Estudio.');
})();

function persist(patch) {
  Object.assign(state.cfg, patch);
  window.api.settings.set({ sender: patch });
}

function audioHintFor(platform) {
  if (platform === 'darwin') {
    return 'En macOS el sistema no deja capturar el audio interno: instala BlackHole '
         + 'y selecciónalo como salida para poder enviarlo.';
  }
  if (platform === 'win32') return 'En Windows se captura el audio del sistema directamente.';
  return 'En Linux depende de PulseAudio/PipeWire; si falla, el vídeo se envía igualmente.';
}

// -------------------------------------------------------------------- fuentes

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.kind = tab.dataset.kind;
    renderSources();
  });
});

$('#refresh').addEventListener('click', loadSources);

$('#open-perms').addEventListener('click', () => window.api.perms.openScreenSettings());

async function loadSources() {
  try {
    state.sources = await window.api.sources.list({ types: ['screen', 'window'] });
    renderSources();
  } catch (err) {
    log(`No se pudieron listar las fuentes: ${err.message}`, 'error');
  }
}

function renderSources() {
  const list = state.sources.filter((s) => s.kind === state.kind);
  el.sources.innerHTML = '';

  if (!list.length) {
    el.sources.innerHTML = '<p class="hint">No hay fuentes de este tipo.</p>';
    return;
  }

  for (const source of list) {
    const node = document.createElement('div');
    node.className = 'source' + (source.id === state.selectedId ? ' selected' : '');
    node.innerHTML = `
      <img alt="" src="${source.thumbnail || ''}" />
      <div class="name"></div>`;
    node.querySelector('.name').textContent = source.name;
    node.addEventListener('click', () => selectSource(source.id));
    el.sources.appendChild(node);
  }
}

async function selectSource(id) {
  state.selectedId = id;
  renderSources();
  if (!state.connected) return;

  log('Cambiando de fuente en caliente…');
  try {
    await startCapture();
    for (const kind of ['video', 'audio']) {
      const track = state.stream.getTracks().find((t) => t.kind === kind);
      const sender = state.pc && state.pc.getSenders().find((s) => s.track && s.track.kind === kind);
      if (sender && track) await sender.replaceTrack(track);
    }
  } catch (err) {
    log(`No se pudo cambiar de fuente: ${err.message}`, 'error');
  }
}

// -------------------------------------------------------------------- captura

async function startCapture() {
  if (!state.selectedId) throw new Error('Elige primero una pantalla o ventana.');

  stopStream();

  const [maxWidth, maxHeight] = el.res.value.split('x').map(Number);
  const maxFrameRate = Number(el.fps.value);

  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: state.selectedId,
      maxWidth,
      maxHeight,
      maxFrameRate
    }
  };

  let stream = null;
  if (el.withAudio.checked) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video
      });
    } catch (err) {
      log(`Sin audio del sistema (${err.name}): se envía solo vídeo.`, 'warn');
    }
  }
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  state.stream = stream;
  el.self.srcObject = stream;

  const track = stream.getVideoTracks()[0];

  // Sin esto Chromium trata la captura como vídeo en movimiento: sacrifica
  // resolución para mantener los fps y el texto sale emborronado. 'detail'
  // invierte esa prioridad, que es lo que interesa al compartir una pantalla.
  track.contentHint = 'detail';

  const s = track.getSettings();
  log(`Capturando ${s.width}×${s.height} @ ${Math.round(s.frameRate || maxFrameRate)} fps`, 'ok');
  track.addEventListener('ended', () => {
    log('La fuente dejó de estar disponible.', 'warn');
    disconnect();
  });

  return stream;
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  el.self.srcObject = null;
}

// --------------------------------------------------------------------- WebRTC

async function connect() {
  const host = el.host.value.trim();
  const port = Number(el.port.value);
  const code = el.code.value.trim();

  if (!host) return log('Falta la IP del Estudio.', 'error');
  if (!state.selectedId) return log('Elige antes una pantalla o ventana.', 'error');

  el.connect.disabled = true;
  setDot(el.connDot, el.connText, 'warn', 'Conectando…');

  try {
    await window.api.sig.connect({ host, port, code });
    log(`Conectado al Estudio ${host}:${port}`, 'ok');
    persist({ host, port, code });

    await startCapture();
    await createPeer();

    state.connected = true;
    el.disconnect.disabled = false;
    startStatsTimer();
  } catch (err) {
    log(`No se pudo conectar: ${err.message}`, 'error');
    setDot(el.connDot, el.connText, '', 'Sin conectar');
    el.connect.disabled = false;
    await window.api.sig.stop();
    stopStream();
  }
}

/**
 * VP9 conserva mucho mejor el texto y las líneas finas que VP8, que es lo que
 * Chromium suele negociar por defecto. H.264 va más suelto de CPU y es la
 * alternativa si el equipo emisor no da abasto.
 */
function applyCodecPreference(pc) {
  const transceiver = pc.getTransceivers().find(
    (t) => t.sender && t.sender.track && t.sender.track.kind === 'video'
  );
  if (!transceiver || !transceiver.setCodecPreferences) return;

  const caps = typeof RTCRtpSender.getCapabilities === 'function'
    ? RTCRtpSender.getCapabilities('video')
    : null;
  if (!caps || !caps.codecs) return;

  const wanted = el.sharp.checked ? 'video/vp9' : 'video/h264';
  const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === wanted);
  if (!preferred.length) {
    log(`Este equipo no ofrece ${wanted.split('/')[1].toUpperCase()}; se usa el códec por defecto.`, 'warn');
    return;
  }

  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== wanted);
  try {
    transceiver.setCodecPreferences([...preferred, ...rest]);
    log(`Códec preferido: ${wanted.split('/')[1].toUpperCase()}`, 'ok');
  } catch (err) {
    log(`No se pudo fijar el códec: ${err.message}`, 'warn');
  }
}

async function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  state.pc = pc;

  for (const track of state.stream.getTracks()) {
    pc.addTrack(track, state.stream);
  }

  applyCodecPreference(pc);

  // Sube el techo de bitrate: por defecto WebRTC es muy conservador con la
  // captura de pantalla y el texto se ve borroso.
  const maxBitrate = Number(el.quality.value);
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].scaleResolutionDownBy = 1;
    params.encodings[0].maxFramerate = Number(el.fps.value);
    params.degradationPreference = 'maintain-resolution';
    try {
      await sender.setParameters(params);
      log(`Techo de envío: ${Math.round(maxBitrate / 1000)} kbps a resolución completa.`);
    } catch (err) {
      log(`No se pudo fijar el bitrate: ${err.message}`, 'warn');
    }
  }

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) window.api.sig.send({ t: 'ice', candidate: event.candidate.toJSON() });
  });

  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    if (st === 'connected') setDot(el.connDot, el.connText, 'live', 'Enviando');
    else if (st === 'connecting') setDot(el.connDot, el.connText, 'warn', 'Negociando…');
    else if (st === 'failed' || st === 'disconnected') {
      setDot(el.connDot, el.connText, 'warn', 'Perdida');
      log(`Conexión WebRTC: ${st}`, 'error');
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  window.api.sig.send({ t: 'offer', sdp: pc.localDescription.sdp });
  log('Oferta enviada al Estudio.');
}

window.api.sig.onMessage(async (msg) => {
  if (!state.pc) return;
  try {
    if (msg.t === 'answer') {
      await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      log('Respuesta del Estudio aceptada.', 'ok');
    } else if (msg.t === 'ice' && msg.candidate) {
      await state.pc.addIceCandidate(msg.candidate);
    }
  } catch (err) {
    log(`Señalización: ${err.message}`, 'error');
  }
});

window.api.sig.onPeer((info) => {
  if (!info.connected && state.connected) {
    log('El Estudio cerró la conexión.', 'warn');
    disconnect();
  }
});

async function disconnect() {
  state.connected = false;
  stopStatsTimer();
  if (state.pc) {
    try { state.pc.close(); } catch {}
    state.pc = null;
  }
  stopStream();
  await window.api.sig.stop();
  setDot(el.connDot, el.connText, '', 'Sin conectar');
  el.connect.disabled = false;
  el.disconnect.disabled = true;
  el.statPill.textContent = '—';
}

el.connect.addEventListener('click', connect);
el.disconnect.addEventListener('click', disconnect);
window.addEventListener('beforeunload', () => { window.api.sig.stop(); });

// ----------------------------------------------------------------- estadística

function startStatsTimer() {
  stopStatsTimer();
  let prevBytes = 0;
  let prevTime = Date.now();

  state.statsTimer = setInterval(async () => {
    if (!state.pc) return;
    const report = await state.pc.getStats();
    let out = null;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    });
    if (!out) return;

    const now = Date.now();
    const elapsed = Math.max(0.001, (now - prevTime) / 1000);
    const kbps = Math.round(((out.bytesSent - prevBytes) * 8) / 1000 / elapsed);
    prevBytes = out.bytesSent;
    prevTime = now;

    el.statPill.textContent =
      `${out.frameWidth || '?'}×${out.frameHeight || '?'} · ${Math.round(out.framesPerSecond || 0)} fps · ${kbps} kbps`;
  }, 1000);
}

function stopStatsTimer() {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }
}
