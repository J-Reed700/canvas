export type ScopeMode = 'waveform' | 'rgb';

/** Density plot in display code values. RGB parade lays out R/G/B in three adjacent panels. */
export function scopeDensity(pixels: Uint8Array, width: number, mode: ScopeMode, columns = 256, levels = 128): Uint16Array[] {
  const channels = Array.from({ length: mode === 'rgb' ? 3 : 1 }, () => new Uint16Array(columns * levels));
  for (let p = 0; p < pixels.length; p += 4) {
    const x = Math.min(columns - 1, Math.floor(((p / 4) % width) * columns / width));
    for (let c = 0; c < channels.length; c++) {
      const value = mode === 'rgb' ? pixels[p + c] : pixels[p] * 0.2126 + pixels[p + 1] * 0.7152 + pixels[p + 2] * 0.0722;
      const y = levels - 1 - Math.round(value / 255 * (levels - 1));
      const i = y * columns + x;
      if (channels[c][i] < 65535) channels[c][i]++;
    }
  }
  return channels;
}

export function drawScope(canvas: HTMLCanvasElement, pixels: Uint8Array, mode: ScopeMode): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const left = 25, top = 10, plotW = w - left - 5, plotH = h - top - 17;
  const columns = mode === 'rgb' ? Math.floor(plotW / 3) : plotW;
  const density = scopeDensity(pixels, 256, mode, columns, plotH);
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, w, h);
  const colors = mode === 'rgb' ? [[255, 101, 126], [103, 229, 175], [112, 159, 255]] : [[176, 231, 207]];
  density.forEach((channel, n) => {
    const img = ctx.createImageData(columns, plotH);
    for (let i = 0; i < channel.length; i++) {
      const glow = Math.min(1, Math.log2(1 + channel[i]) / 4);
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round(colors[n][c] * glow);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, left + n * columns, top);
  });
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (const v of [0, 25, 50, 75, 100]) {
    const y = top + (1 - v / 100) * (plotH - 1);
    ctx.fillStyle = '#7f8995';
    ctx.fillText(String(v), left - 4, y + 3);
    ctx.strokeStyle = 'rgba(180,195,215,0.15)';
    ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(w - 5, y + 0.5); ctx.stroke();
  }
  ctx.textAlign = 'center';
  (mode === 'rgb' ? ['R', 'G', 'B'] : ['LUMA · CODE VALUE %']).forEach((label, n, all) => {
    ctx.fillStyle = '#9ba8b7';
    ctx.fillText(label, left + plotW * (n + 0.5) / all.length, h - 3);
  });
}
