// Spawning ffmpeg/ffprobe, shared by the per-customer info channel
// (encode/channel.js) and the media channel (encode/media.js).
import { spawn } from 'node:child_process';
import { log } from '../core/logger.js';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ffprobe ships next to ffmpeg; derived from FFMPEG_PATH so one override covers both.
export const FFPROBE = process.env.FFPROBE_PATH
  || FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`);

export class AbortedError extends Error {
  constructor() { super('generation aborted by newer request'); this.aborted = true; }
}

export function run(cmd, args, label = cmd, signal = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (error) => {
      if (signal?.aborted) { reject(new AbortedError()); return; }
      log.error('process', `${label} could not start`, { error: error.message });
      reject(error);
    });
    p.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      if (signal?.aborted) { reject(new AbortedError()); return; }
      log.error('process', `${label} failed`, {
        pid: p.pid,
        code,
        output: err.slice(-800),
      });
      reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
    signal?.addEventListener('abort', () => p.kill(), { once: true });
  });
}

// Run a command and collect its stdout (ffprobe's JSON).
export function capture(cmd, args, label = cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${label} exited ${code}: ${err.slice(-400)}`));
    });
  });
}
