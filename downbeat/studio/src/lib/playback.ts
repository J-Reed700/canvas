import type { Transport } from '../engine/audio.ts';

export const EDIT_FPS = 30;
export function timecode(seconds: number): string {
  const frames = Math.max(0, Math.floor(seconds * EDIT_FPS + 1e-6));
  const pad = (n: number) => String(n).padStart(2, '0');
  return [Math.floor(frames / 108000), Math.floor(frames / 1800) % 60, Math.floor(frames / 30) % 60, frames % 30].map(pad).join(':');
}

/** Frame steps pause playback and stay inside the loop, including its partial final frame. */
export function stepFrame(transport: Transport, delta: number) {
  transport.pause();
  const current = Math.floor(transport.loopTime() * EDIT_FPS + 1e-6);
  const last = Math.max(0, Math.ceil(transport.len * EDIT_FPS) - 1);
  transport.seek(Math.max(0, Math.min(last, current + delta)) / EDIT_FPS);
}
