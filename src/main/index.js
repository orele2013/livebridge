'use strict';

const path = require('path');
const {
  app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell,
  systemPreferences, powerSaveBlocker, session, screen, Menu
} = require('electron');

const settings = require('./settings');
const { Signaling, localAddresses } = require('./signaling');
const { Streamer, ffmpegPath } = require('./streamer');

const isDev = process.argv.includes('--dev');

// En Ubuntu con Wayland la captura de pantalla va por el portal de PipeWire.
if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

let win = null;
let psbId = null;
const signaling = new Signaling();
const streamer = new Streamer();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --------------------------------------------------------------- ventana

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    title: 'LiveBridge',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Sin esto, el compositor baja a 1 fps cuando la ventana queda tapada.
      backgroundThrottling: false
    }
  });

  win.once('ready-to-show', () => win.show());
  // --page=studio / --page=sender salta el selector (útil en desarrollo).
  const pageArg = (process.argv.find((a) => a.startsWith('--page=')) || '').split('=')[1];
  const page = ['studio', 'sender'].includes(pageArg) ? `${pageArg}.html` : 'index.html';
  win.loadFile(path.join(__dirname, '..', 'renderer', page));

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer ${source}:${line}] ${message}`);
    });
  }

  win.on('close', (event) => {
    if (!streamer.running) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Seguir emitiendo', 'Cortar y salir'],
      defaultId: 0,
      cancelId: 0,
      message: 'Hay una emisión en curso.',
      detail: 'Si cierras ahora se cortará el directo.'
    });
    if (choice === 0) event.preventDefault();
    else streamer.stop();
  });

  win.on('closed', () => { win = null; });
}

function setupSession() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-read'].includes(permission));
  });

  // Fuente única de verdad para getDisplayMedia(): la elección se hace en la UI,
  // así que aquí solo servimos la pantalla completa por defecto.
  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    }, { useSystemPicker: false });
  }
}

app.whenReady().then(() => {
  setupSession();
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', cleanup);

function cleanup() {
  signaling.stop();
  streamer.stop();
  releasePowerBlocker();
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Ventana',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Panel LIVE de TikTok',
          click: () => shell.openExternal('https://livecenter.tiktok.com')
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

// ------------------------------------------------------- puentes de eventos

signaling.on('message', (msg) => send('sig:message', msg));
signaling.on('peer', (info) => send('sig:peer', info));
signaling.on('status', (info) => send('sig:status', info));
signaling.on('error', (err) => send('sig:status', { level: 'error', text: err.message }));

streamer.on('log', (entry) => send('stream:log', entry));
streamer.on('stats', (stats) => send('stream:stats', stats));
streamer.on('ended', (info) => {
  releasePowerBlocker();
  send('stream:ended', info);
});

function holdPowerBlocker() {
  if (psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep');
}

function releasePowerBlocker() {
  if (psbId !== null) {
    try { powerSaveBlocker.stop(psbId); } catch {}
    psbId = null;
  }
}

// ------------------------------------------------------------------- IPC

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  arch: process.arch,
  versions: process.versions,
  ffmpegPath,
  isWayland: process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland',
  selfTest: process.argv.includes('--selftest'),
  tmpDir: app.getPath('temp').replace(/[\\/]+$/, ''),
  sep: path.sep
}));

// Cierre programático usado por la autoprueba.
ipcMain.handle('app:quit', (_e, code = 0) => {
  cleanup();
  app.exit(code);
});

ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:set', (_e, patch) => settings.save(patch));

ipcMain.handle('net:addresses', () => localAddresses());

ipcMain.handle('sources:list', async (_e, opts = {}) => {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error(
      'macOS no ha concedido el permiso de Grabación de pantalla a LiveBridge. '
      + 'Actívalo en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y reinicia la app.'
    );
  }

  const sources = await desktopCapturer.getSources({
    types: opts.types || ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null
  }));
});

ipcMain.handle('perm:media', async (_e, kind) => {
  if (process.platform !== 'darwin') return 'granted';
  if (kind === 'screen') return systemPreferences.getMediaAccessStatus('screen');
  const status = systemPreferences.getMediaAccessStatus(kind);
  if (status === 'not-determined') {
    const ok = await systemPreferences.askForMediaAccess(kind);
    return ok ? 'granted' : 'denied';
  }
  return status;
});

ipcMain.handle('perm:open-screen-settings', () => {
  if (process.platform === 'darwin') {
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  }
  return null;
});

ipcMain.handle('sig:start-server', async (_e, { port, code }) => signaling.startServer(port, code));
ipcMain.handle('sig:connect', async (_e, { host, port, code }) => signaling.connectTo(host, port, code));
ipcMain.handle('sig:stop', () => { signaling.stop(); return true; });
ipcMain.handle('sig:send', (_e, msg) => signaling.send(msg));

ipcMain.handle('stream:start', (_e, cfg) => {
  const res = streamer.start(cfg);
  holdPowerBlocker();
  return res;
});

ipcMain.handle('stream:stop', () => { streamer.stop(); return true; });
ipcMain.handle('stream:status', () => streamer.status());

ipcMain.on('stream:chunk', (_e, buffer) => {
  streamer.write(Buffer.from(buffer));
});

/**
 * Vista limpia: ajusta la ventana a la proporción de salida y la bloquea ahí,
 * para que quien capture la ventana desde fuera recoja la composición exacta
 * sin bordes ni interfaz.
 */
let boundsBeforeClean = null;

ipcMain.handle('win:clean', (_e, { on, width, height }) => {
  if (!win || win.isDestroyed()) return false;

  if (on) {
    boundsBeforeClean = win.getBounds();
    const ratio = width / height;
    const display = screen.getDisplayNearestPoint(win.getBounds());
    const scale = display.scaleFactor || 1;
    const area = display.workAreaSize;

    // El tamaño de ventana va en puntos, pero quien capture la ventana recoge
    // píxeles físicos. Dividiendo por el factor de escala, cada píxel del
    // lienzo cae exactamente en un píxel de pantalla: ni interpolación al
    // mostrarlo ni pérdida al capturarlo.
    let w = Math.round(width / scale);
    let h = Math.round(height / scale);

    const maxW = Math.round(area.width * 0.92);
    const maxH = Math.round(area.height * 0.92);
    if (w > maxW || h > maxH) {
      const k = Math.min(maxW / w, maxH / h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }

    win.setMinimumSize(240, 240);
    win.setContentSize(w, h);
    win.setAspectRatio(ratio);
    win.center();

    const deviceWidth = Math.round(w * scale);
    return { ok: true, deviceWidth, deviceHeight: Math.round(h * scale), scale, exact: deviceWidth >= width - 2 };
  } else {
    win.setAspectRatio(0);
    win.setMinimumSize(980, 640);
    if (boundsBeforeClean) win.setBounds(boundsBeforeClean);
    boundsBeforeClean = null;
  }

  return { ok: true };
});

ipcMain.handle('dialog:save-file', async (_e, defaultName) => {
  const opts = {
    title: 'Guardar grabación',
    defaultPath: path.join(app.getPath('videos'), defaultName || 'livebridge.mp4'),
    filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }]
  };
  const res = win && !win.isDestroyed()
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts);
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('shell:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return null;
});
