'use strict';

/**
 * Canal de señalización para WebRTC en red local.
 *
 * El modo Estudio levanta un servidor WebSocket; el modo Emisor se conecta a él.
 * Solo se usa para intercambiar la oferta/respuesta SDP y los candidatos ICE:
 * el vídeo viaja después punto a punto por WebRTC.
 */

const os = require('os');
const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');

const HELLO_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 15000;

class Signaling extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.peer = null; // socket del emisor conectado (modo estudio)
    this.client = null; // socket propio (modo emisor)
    this.code = '';
    this.pinger = null;
  }

  get connected() {
    const sock = this.peer || this.client;
    return !!sock && sock.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------- estudio

  startServer(port, code) {
    this.stop();
    this.code = String(code || '');

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host: '0.0.0.0' });

      wss.once('error', (err) => reject(err));

      wss.once('listening', () => {
        this.wss = wss;
        wss.removeAllListeners('error');
        wss.on('error', (err) => this.emit('error', err));
        this._startPinger();
        resolve({ port, addresses: localAddresses() });
      });

      wss.on('connection', (socket, req) => {
        const from = req.socket.remoteAddress;
        let authed = false;

        const timer = setTimeout(() => {
          if (!authed) socket.close(4001, 'timeout');
        }, HELLO_TIMEOUT_MS);

        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        socket.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          if (!authed) {
            if (msg.t !== 'hello') return;
            if (this.code && msg.code !== this.code) {
              send(socket, { t: 'denied', reason: 'code' });
              socket.close(4003, 'bad code');
              this.emit('status', { level: 'warn', text: `Código incorrecto desde ${from}` });
              return;
            }
            if (this.peer && this.peer.readyState === WebSocket.OPEN) {
              send(socket, { t: 'denied', reason: 'busy' });
              socket.close(4009, 'busy');
              return;
            }
            authed = true;
            clearTimeout(timer);
            this.peer = socket;
            send(socket, { t: 'welcome' });
            this.emit('peer', { connected: true, name: msg.name || from, address: from });
            return;
          }

          this.emit('message', msg);
        });

        socket.on('close', () => {
          clearTimeout(timer);
          if (this.peer === socket) {
            this.peer = null;
            this.emit('peer', { connected: false });
          }
        });

        socket.on('error', (err) => this.emit('status', { level: 'warn', text: err.message }));
      });
    });
  }

  // ----------------------------------------------------------------- emisor

  connectTo(host, port, code) {
    this.stop();

    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(`ws://${host}:${port}`);
      } catch (err) {
        reject(err);
        return;
      }

      const failEarly = (err) => reject(err instanceof Error ? err : new Error(String(err)));
      socket.once('error', failEarly);

      socket.on('open', () => {
        socket.removeListener('error', failEarly);
        socket.on('error', (err) => this.emit('error', err));
        this.client = socket;
        send(socket, { t: 'hello', code: String(code || ''), name: os.hostname() });
      });

      socket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.emit('peer', { connected: true });
          resolve({ ok: true });
          return;
        }
        if (msg.t === 'denied') {
          const text = msg.reason === 'busy'
            ? 'El estudio ya tiene otro emisor conectado.'
            : 'Código de emparejamiento incorrecto.';
          reject(new Error(text));
          return;
        }
        this.emit('message', msg);
      });

      socket.on('close', () => {
        if (this.client === socket) {
          this.client = null;
          this.emit('peer', { connected: false });
        }
      });
    });
  }

  // ------------------------------------------------------------------ común

  send(msg) {
    const sock = this.peer || this.client;
    if (sock && sock.readyState === WebSocket.OPEN) {
      send(sock, msg);
      return true;
    }
    return false;
  }

  stop() {
    if (this.pinger) {
      clearInterval(this.pinger);
      this.pinger = null;
    }
    if (this.client) {
      try { this.client.close(); } catch {}
      this.client = null;
    }
    if (this.peer) {
      try { this.peer.close(); } catch {}
      this.peer = null;
    }
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      try { wss.close(); } catch {}
    }
  }

  _startPinger() {
    this.pinger = setInterval(() => {
      if (!this.wss) return;
      for (const socket of this.wss.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        try { socket.ping(); } catch {}
      }
    }, PING_INTERVAL_MS);
  }
}

function send(socket, msg) {
  try {
    socket.send(JSON.stringify(msg));
  } catch {}
}

function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

module.exports = { Signaling, localAddresses };
