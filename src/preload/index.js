'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  quit: (code) => ipcRenderer.invoke('app:quit', code),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },

  sources: {
    list: (opts) => ipcRenderer.invoke('sources:list', opts)
  },

  perms: {
    media: (kind) => ipcRenderer.invoke('perm:media', kind),
    openScreenSettings: () => ipcRenderer.invoke('perm:open-screen-settings')
  },

  net: {
    addresses: () => ipcRenderer.invoke('net:addresses')
  },

  sig: {
    startServer: (opts) => ipcRenderer.invoke('sig:start-server', opts),
    connect: (opts) => ipcRenderer.invoke('sig:connect', opts),
    stop: () => ipcRenderer.invoke('sig:stop'),
    send: (msg) => ipcRenderer.invoke('sig:send', msg),
    onMessage: on('sig:message'),
    onPeer: on('sig:peer'),
    onStatus: on('sig:status')
  },

  stream: {
    start: (cfg) => ipcRenderer.invoke('stream:start', cfg),
    stop: () => ipcRenderer.invoke('stream:stop'),
    status: () => ipcRenderer.invoke('stream:status'),
    chunk: (arrayBuffer) => ipcRenderer.send('stream:chunk', arrayBuffer),
    onLog: on('stream:log'),
    onStats: on('stream:stats'),
    onEnded: on('stream:ended')
  },

  dialog: {
    saveFile: (defaultName) => ipcRenderer.invoke('dialog:save-file', defaultName)
  },

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});
