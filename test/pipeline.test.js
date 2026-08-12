'use strict';

/**
 * Prueba de humo de la tubería de ffmpeg sin abrir la interfaz:
 * genera un WebM parecido al que produce MediaRecorder, lo mete por stdin
 * al Streamer en modo fichero y comprueba que sale un MP4 válido.
 *
 *   node test/pipeline.test.js
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Streamer, buildArgs, joinRtmp } = require('../src/main/streamer');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livebridge-test-'));
const sampleWebm = path.join(tmp, 'sample.webm');
const outMp4 = path.join(tmp, 'out.mp4');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------------ unitarias

console.log('\nURL RTMP');
check('une servidor y clave', joinRtmp('rtmp://x/live', 'k1') === 'rtmp://x/live/k1');
check('tolera la barra final', joinRtmp('rtmp://x/live/', 'k1') === 'rtmp://x/live/k1');
check('tolera espacios', joinRtmp('  rtmp://x/live  ', ' k1 ') === 'rtmp://x/live/k1');

console.log('\nArgumentos de ffmpeg');
const args = buildArgs({ outputMode: 'rtmp', rtmpUrl: 'rtmp://x/live', rtmpKey: 'k', fps: 30, bitrate: 5000, audioBitrate: 160 });
check('keyframe cada 2 s', args[args.indexOf('-g') + 1] === '60');
check('bitrate con tope', args.includes('-maxrate') && args[args.indexOf('-maxrate') + 1] === '5000k');
check('pixel format compatible', args[args.indexOf('-pix_fmt') + 1] === 'yuv420p');
check('salida FLV', args[args.indexOf('-f') + 1] === 'flv');
const fileArgs = buildArgs({ outputMode: 'file', filePath: '/tmp/a.mp4', fps: 24, bitrate: 3000, audioBitrate: 128 });
check('modo fichero muxa a mp4', fileArgs[fileArgs.indexOf('-f') + 1] === 'mp4');
check('modo fichero escribe la ruta', fileArgs[fileArgs.length - 1] === '/tmp/a.mp4');
check('fps 24 -> gop 48', fileArgs[fileArgs.indexOf('-g') + 1] === '48');

// ------------------------------------------------------- muestra de entrada

console.log('\nGenerando muestra de vídeo (5 s, VP8 + Opus)…');
const gen = spawnSync(ffmpeg, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30:duration=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
  '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-b:a', '96k',
  sampleWebm
]);
check('muestra creada', gen.status === 0 && fs.existsSync(sampleWebm), gen.stderr && gen.stderr.toString().slice(0, 300));

// --------------------------------------------------- tubería completa

(async function run() {
  console.log('\nTubería Streamer -> MP4');

  const streamer = new Streamer();
  const logs = [];
  streamer.on('log', (entry) => logs.push(`${entry.level}: ${entry.text}`));

  const ended = new Promise((resolve) => streamer.once('ended', resolve));
  streamer.start({ outputMode: 'file', filePath: outMp4, fps: 30, bitrate: 2500, audioBitrate: 128 });
  check('el proceso arranca', streamer.running);

  // Alimentamos en trozos de 32 KB, como haría MediaRecorder.
  await new Promise((resolve, reject) => {
    const reader = fs.createReadStream(sampleWebm, { highWaterMark: 32 * 1024 });
    reader.on('data', (chunk) => streamer.write(chunk));
    reader.on('end', resolve);
    reader.on('error', reject);
  });

  streamer.stop();
  const result = await ended;
  check('ffmpeg termina limpiamente', result.code === 0, `código ${result.code} · ${logs.join(' | ')}`);
  check('cierre esperado', result.expected === true);

  const size = fs.existsSync(outMp4) ? fs.statSync(outMp4).size : 0;
  check('MP4 con contenido', size > 20000, `${size} bytes`);

  // ffprobe no viene con ffmpeg-static: inspeccionamos con el propio ffmpeg.
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', outMp4, '-f', 'null', '-']);
  const stderr = info.stderr.toString();
  check('vídeo H.264', /Video: h264/.test(stderr), stderr.slice(0, 200));
  check('audio AAC', /Audio: aac/.test(stderr));
  check('resolución conservada', /540x960/.test(stderr));
  check('duración ~5 s', /time=00:00:0[45]/.test(stderr), (stderr.match(/time=\S+/g) || []).pop());

  console.log(`\n${failures === 0 ? 'TODO OK' : `${failures} FALLO(S)`}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();
