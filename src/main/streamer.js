'use strict';

/**
 * Envoltorio de ffmpeg: recibe los trozos de vídeo del compositor (MediaRecorder,
 * WebM/Matroska por stdin) y los reempaqueta a RTMP (TikTok) o a un fichero MP4.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ffmpegPath = resolveFfmpeg();

function resolveFfmpeg() {
  let p = require('ffmpeg-static');
  if (typeof p === 'string' && p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

function joinRtmp(url, key) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const k = String(key || '').trim();
  if (!k) return base;
  return `${base}/${k}`;
}

function buildArgs(cfg) {
  const fps = Math.max(1, Math.round(cfg.fps || 30));
  const vBitrate = Math.max(500, Math.round(cfg.bitrate || 5000));
  const aBitrate = Math.max(64, Math.round(cfg.audioBitrate || 160));
  const gop = fps * 2; // TikTok pide keyframe cada 2 s

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-fflags', '+genpts',
    '-thread_queue_size', '1024',
    '-i', 'pipe:0',

    // Vídeo. Sin '-tune zerolatency' a propósito: desactiva fotogramas B y
    // lookahead, y con ello se pierde bastante calidad por bit. El par de
    // segundos extra de latencia no importan en un directo.
    '-c:v', 'libx264',
    '-preset', cfg.x264Preset || 'faster',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${vBitrate}k`,
    '-maxrate', `${vBitrate}k`,
    '-bufsize', `${vBitrate * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-r', String(fps),
    '-fps_mode', 'cfr',

    // audio
    '-c:a', 'aac',
    '-b:a', `${aBitrate}k`,
    '-ar', '44100',
    '-ac', '2',
    '-af', 'aresample=async=1000'
  ];

  if (cfg.outputMode === 'file') {
    args.push('-movflags', '+faststart', '-f', 'mp4', cfg.filePath);
  } else {
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', joinRtmp(cfg.rtmpUrl, cfg.rtmpKey));
  }

  return args;
}

class Streamer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.startedAt = 0;
    this.bytesIn = 0;
    this.stopping = false;
  }

  get running() {
    return !!this.proc;
  }

  start(cfg) {
    if (this.proc) throw new Error('Ya hay una emisión en curso.');

    if (cfg.outputMode === 'file') {
      if (!cfg.filePath) throw new Error('Falta la ruta del fichero de salida.');
    } else {
      if (!cfg.rtmpUrl) throw new Error('Falta la URL del servidor RTMP.');
      if (!cfg.rtmpKey) throw new Error('Falta la clave de retransmisión.');
    }

    const args = buildArgs(cfg);
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    this.proc = proc;
    this.stopping = false;
    this.startedAt = Date.now();
    this.bytesIn = 0;

    // Una tubería rota al cerrar es normal: no debe tumbar el proceso principal.
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE' && !this.stopping) {
        this.emit('log', { level: 'error', text: `stdin: ${err.message}` });
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/[\r\n]+/)) {
        const text = line.trim();
        if (!text) continue;
        const stats = parseStats(text);
        if (stats) this.emit('stats', stats);
        else this.emit('log', { level: /error|failed|invalid/i.test(text) ? 'error' : 'info', text });
      }
    });

    proc.on('error', (err) => {
      this.proc = null;
      this.emit('log', { level: 'error', text: `No se pudo lanzar ffmpeg: ${err.message}` });
      this.emit('ended', { code: -1, expected: false });
    });

    proc.on('close', (code) => {
      const expected = this.stopping;
      this.proc = null;
      this.stopping = false;
      this.emit('ended', { code, expected });
    });

    this.emit('log', { level: 'info', text: `ffmpeg listo (${cfg.outputMode === 'file' ? cfg.filePath : 'RTMP'})` });
    return { ok: true, pid: proc.pid };
  }

  write(chunk) {
    if (!this.proc || this.stopping) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytesIn += buf.length;
    try {
      return this.proc.stdin.write(buf);
    } catch {
      return false;
    }
  }

  stop() {
    if (!this.proc) return;
    this.stopping = true;
    const proc = this.proc;
    try {
      proc.stdin.end();
    } catch {}
    setTimeout(() => {
      if (this.proc === proc) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 8000);
  }

  status() {
    return {
      running: this.running,
      seconds: this.proc ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      bytesIn: this.bytesIn
    };
  }
}

// "frame=  123 fps= 30 q=24.0 size=  512kB time=00:00:04.10 bitrate=1023.4kbits/s speed=1.01x"
function parseStats(line) {
  if (!line.startsWith('frame=')) return null;
  const grab = (re) => {
    const m = line.match(re);
    return m ? m[1] : null;
  };
  return {
    frame: Number(grab(/frame=\s*(\d+)/)) || 0,
    fps: Number(grab(/fps=\s*([\d.]+)/)) || 0,
    bitrate: grab(/bitrate=\s*([\d.]+\w*\/s)/) || '',
    time: grab(/time=\s*([\d:.]+)/) || '',
    speed: grab(/speed=\s*([\d.]+x)/) || '',
    dropped: Number(grab(/drop=\s*(\d+)/)) || 0
  };
}

module.exports = { Streamer, ffmpegPath, joinRtmp, buildArgs };
