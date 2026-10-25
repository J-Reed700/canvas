import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePath, openBrowser, sleep } from '../browserHarness.mjs';
import { TRANSITIONS, VERT } from '../../downbeat/studio/src/engine/shaders.ts';

test('all transitions render finite pixels and preserve both endpoints in portrait, square and landscape', {
  skip: chromePath ? false : 'needs Chrome or Chromium', timeout: 120_000,
}, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'downbeat-transitions-'));
  const browser = await openBrowser(join(tmp, 'chrome'));
  t.after(async () => { browser.ws.close(); browser.proc.kill(); await sleep(300); rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); });
  const result = await browser.run(`
    const transitions = ${JSON.stringify(Object.entries(TRANSITIONS).map(([id, transition]) => [id, transition.glsl]))};
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('Floating-point WebGL2 is required');
    const compile = (type, source) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, ${JSON.stringify(VERT)});
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const texture = (unit, incoming) => {
      const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      const data = new Uint8Array(8 * 8 * 4);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        data.set(incoming ? [20, (x + 1) * 10, 120 + y * 12, 255] : [(x + 1) * 16, (y + 1) * 12, 32, 255], i);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    texture(0, false); texture(1, true);
    const output = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, output);
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    let frames = 0;
    for (const [width, height] of [[37,65], [49,49], [65,37]]) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer');
      gl.viewport(0, 0, width, height);
      let start, end;
      for (const [id, source] of transitions) {
        const fragment = compile(gl.FRAGMENT_SHADER, source);
        const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(id + ': ' + gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const pos = gl.getAttribLocation(program, 'aPos'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(gl.getUniformLocation(program, 'uA'), 0); gl.uniform1i(gl.getUniformLocation(program, 'uB'), 1);
        gl.uniform2f(gl.getUniformLocation(program, 'uRes'), width, height); gl.uniform1f(gl.getUniformLocation(program, 'uSeed'), 7);
        for (const p of [0, 0.25, 0.5, 0.75, 1]) {
          gl.uniform1f(gl.getUniformLocation(program, 'uP'), p); gl.drawArrays(gl.TRIANGLES, 0, 6);
          const pixels = new Float32Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
          const error = gl.getError(); if (error) throw new Error(id + ': GL error ' + error);
          if (!pixels.every(Number.isFinite)) throw new Error(id + ': non-finite pixels at ' + p);
          if (p === 0 && !start) start = pixels;
          if (p === 1 && !end) end = pixels;
          const expected = p === 0 ? start : p === 1 ? end : null;
          if (expected && !pixels.every((value, index) => Math.abs(value - expected[index]) < 0.00001)) throw new Error(id + ': endpoint mismatch at ' + p + ' (' + width + '×' + height + ')');
          if (p === 0.5 && id !== 'dipBlack' && !pixels.some((value, index) => index % 4 !== 3 && value > 0.001)) throw new Error(id + ': empty midpoint');
          if (p === 0.25) {
            const blue = (x, y) => pixels[(y * width + x) * 4 + 2];
            const left = blue(0, Math.floor(height / 2)), right = blue(width - 1, Math.floor(height / 2));
            const bottom = blue(Math.floor(width / 2), 0), top = blue(Math.floor(width / 2), height - 1);
            if (['pushLeft', 'coverLeft', 'wipeLeft'].includes(id) && !(right > 0.4 && left < 0.2)) throw new Error(id + ': expected reveal from right');
            if (['pushRight', 'wipeRight'].includes(id) && !(left > 0.4 && right < 0.2)) throw new Error(id + ': expected reveal from left');
            if (['pushUp', 'coverUp', 'wipeUp'].includes(id) && !(bottom > 0.4 && top < 0.2)) throw new Error(id + ': expected reveal from bottom');
            if (['pushDown', 'wipeDown'].includes(id) && !(top > 0.4 && bottom < 0.2)) throw new Error(id + ': expected reveal from top');
          }
          frames++;
        }
        gl.deleteProgram(program); gl.deleteShader(fragment);
      }
    }
    return { transitions: transitions.length, frames };
  `);
  assert.equal(result.transitions, 64);
  assert.equal(result.frames, 64 * 3 * 5);
  assert.deepEqual(browser.problems, []);
});
