// Downbeat GPU module library. Each module is one fragment pass (or a small custom chain).
// Params become `uniform float p_<id>`; animated terms are periodic over the loop so
// exports loop cleanly. Pixel sizes scale with uScale (= height / 1920).
import { PRELUDE } from './shaders.ts';
import type { CategoryId, CategoryMeta, ModSourceMeta, ModuleDef, ParamDef } from './types.ts';

const P = (id: string, name: string, min: number, max: number, def: number, extra: Partial<ParamDef> = {}): ParamDef => ({ id, name, min, max, def, step: extra.step ?? (max - min) / 200, ...extra });
const OPT = (id: string, name: string, opts: string[], def: number = 0): ParamDef => ({ id, name, min: 0, max: opts.length - 1, def, step: 1, opts });
const MIX: ParamDef = P('mix', 'Mix', 0, 1, 1);

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  space: { name: 'Space', color: '#9B8CFF' },
  warp: { name: 'Warp', color: '#5AD8FF' },
  time: { name: 'Time', color: '#FF7AE6' },
  light: { name: 'Light', color: '#FFD36A' },
  stylize: { name: 'Stylize', color: '#7CFFB2' },
  color: { name: 'Color', color: '#FF8A5B' },
};

const BAYER = `
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }`;

const RAMP = `
vec3 ramp5(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  return t < 1.0 ? mix(a, b, t) : t < 2.0 ? mix(b, c, t - 1.0) : t < 3.0 ? mix(c, d, t - 2.0) : mix(d, e, t - 3.0);
}
vec3 hx(float h) { return vec3(floor(h / 65536.0), mod(floor(h / 256.0), 256.0), mod(h, 256.0)) / 255.0; }`;

const YIQ = `
vec3 rgb2yiq(vec3 c) { return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c; }
vec3 yiq2rgb(vec3 c) { return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c; }`;

// Attack/decay envelope on every beat (a short attack so nothing jumps in a single frame).
const ENV = `
float beatEnv(float k) { float ph = fract(uBeat); return smoothstep(0.0, 0.06, ph) * exp(-ph * k); }`;

export const MODULES: Record<string, ModuleDef> = {
  // Space
  parallax: {
    name: '2.5D Parallax', cat: 'space', desc: 'Fakes depth from brightness and distance from the center, then circles the camera. Made for album art and stills',
    params: [P('amount', 'Depth', 0, 1, 0.55), OPT('speed', 'Orbit', ['1 bar', '2 bars', 'Whole loop']), OPT('src', 'Depth from', ['Brightness', 'Center', 'Both'], 2),
      P('focus', 'Focus plane', 0, 1, 0.45), P('kick', 'Kick push', 0, 1, 0.3)],
    glsl: `float depthAt(vec2 uv) {
      float l = 0.0;
      for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) l += luma(texture(uSrc, mirrorUv(uv + vec2(float(i), float(j)) * 0.035)).rgb);
      l /= 9.0; l = l / (1.0 + l) * 1.6;
      float c = 1.0 - smoothstep(0.0, 0.8, length((uv - 0.5) * vec2(aspect(), 1.0)));
      return p_src < 0.5 ? l : (p_src < 1.5 ? c : mix(l, c, 0.55));
    }
    void main() {
      // whole orbits per loop so the seam is invisible
      float per = p_speed < 0.5 ? 4.0 : 8.0;
      float n = p_speed > 1.5 ? 1.0 : max(1.0, floor(uLoop / max(uBeatLen, 1e-3) / per + 0.5));
      float a = TAU * uPhase * n;
      vec2 orbit = vec2(sin(a), 0.6 * cos(a)) * p_amount * 0.045 * (1.0 + 1.5 * p_kick * uKick);
      vec2 uv = vUv;
      for (int k = 0; k < 3; k++) uv = vUv - orbit * (depthAt(uv) - p_focus);
      outColor = vec4(texture(uSrc, mirrorUv(uv)).rgb, 1.0);
    }`,
  },
  kaleido: {
    name: 'Kaleidoscope', cat: 'space', desc: 'Mirrored wedges that rotate in time with the loop',
    params: [P('slices', 'Slices', 2, 16, 6, { step: 1 }), P('spin', 'Spin / loop', -3, 3, 1, { step: 1 }),
      P('zoom', 'Zoom', 0.4, 2.5, 1), P('offset', 'Offset', 0, 0.6, 0.15), MIX],
    glsl: `void main() {
      vec2 q = toP(vUv);
      float r = length(q) / p_zoom;
      float a = atan(q.y, q.x) + p_spin * TAU * uPhase;
      float seg = TAU / max(p_slices, 2.0);
      a = abs(mod(a, seg) - seg * 0.5);
      vec2 k = vec2(cos(a), sin(a)) * r + vec2(p_offset, p_offset * 0.6);
      vec3 c = texture(uSrc, mirrorUv(toUv(k))).rgb;
      outColor = vec4(mix(texture(uSrc, vUv).rgb, c, p_mix), 1.0);
    }`,
  },
  mirror: {
    name: 'Mirror', cat: 'space', desc: 'Two-way, four-way or horizon mirror',
    params: [OPT('mode', 'Mode', ['Split', 'Quad', 'Horizon']), P('shift', 'Axis', -0.3, 0.3, 0), MIX],
    glsl: `void main() {
      vec2 uv = vUv; vec2 c = vec2(0.5 + p_shift, 0.5); int m = int(p_mode + 0.5);
      if (m != 2) uv.x = c.x - abs(uv.x - c.x);
      if (m != 0) uv.y = c.y + abs(uv.y - c.y);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, texture(uSrc, mirrorUv(uv)).rgb, p_mix), 1.0);
    }`,
  },
  tunnel: {
    name: 'Infinite Tunnel', cat: 'space', desc: 'Endless tunnel that flies forward in time with the loop',
    params: [P('speed', 'Fly / loop', 0, 4, 1, { step: 1 }), P('spin', 'Spin / loop', -2, 2, 0, { step: 1 }),
      P('repeat', 'Repeat', 1, 6, 2, { step: 1 }), P('fog', 'Core fog', 0, 1, 0.6), MIX],
    glsl: `void main() {
      vec2 q = toP(vUv); float r = max(length(q), 1e-3); float a = atan(q.y, q.x);
      float v = 0.32 / r + 2.0 * p_speed * uPhase;
      float u = a / TAU * p_repeat + p_spin * uPhase;
      vec2 uv = vec2(abs(fract(u) * 2.0 - 1.0), abs(fract(v * 0.5) * 2.0 - 1.0));
      vec3 c = texture(uSrc, uv).rgb * mix(1.0, smoothstep(0.0, 0.45, r), p_fog);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, c, p_mix), 1.0);
    }`,
  },
  fractal: {
    name: 'Fractal Tunnel', cat: 'space', desc: 'Smaller copies of the frame nested inside it, each with a thin colored border. They swell on the beat',
    params: [P('count', 'Copies', 1, 6, 2, { step: 1 }), P('size', 'Size', 0.3, 0.95, 0.68), P('inner', 'Inner size', 0.4, 0.9, 0.65),
      P('opacity', 'Opacity', 0, 1, 0.65), P('border', 'Border', 0, 12, 2), P('hue', 'Border hue', 0, 1, 0.52),
      OPT('trigger', 'Trigger', ['Beat', 'Kick', 'None'])],
    glsl: ENV + `void main() {
      int tr = int(p_trigger + 0.5);
      float env = tr == 0 ? beatEnv(3.0) : tr == 1 ? clamp(uKick, 0.0, 1.0) : 0.0;
      // blends in display values, as the CPU version did
      vec3 c = toSRGB(texture(uSrc, vUv).rgb);
      vec3 rim = hsv2rgb(vec3(p_hue, 0.58, 0.94)) * (0.6 + 0.4 * env);
      float bw = p_border > 0.01 ? max(p_border * uScale, 1.0) : 0.0;   // line width in pixels
      vec2 q = vUv - 0.5;
      float s = p_size, grow = 0.05;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= p_count) break;
        float sc = s + grow * env;
        vec2 d = (abs(q) - 0.5 * sc) * uRes;                          // pixels past the copy's edges
        float edge = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);   // signed distance to its outline
        float inside = clamp(0.5 - edge, 0.0, 1.0);
        if (inside > 0.0) {
          // the whole frame shrunk to this size, box-filtered so fine detail doesn't shimmer
          vec2 l = q / sc + 0.5, o = 0.25 / (sc * uRes);
          vec3 cp = texture(uSrc, l + o).rgb + texture(uSrc, l - o).rgb + texture(uSrc, l + vec2(o.x, -o.y)).rgb + texture(uSrc, l - vec2(o.x, -o.y)).rgb;
          c = mix(c, toSRGB(cp * 0.25), p_opacity * inside);
        }
        c = mix(c, rim, (1.0 - smoothstep(bw * 0.5 - 0.5, bw * 0.5 + 0.5, abs(edge))) * step(0.5, bw));
        s *= p_inner; grow *= 0.8;
      }
      outColor = vec4(toLin(c), 1.0);
    }`,
  },
  tile: {
    name: 'Clone Grid', cat: 'space', desc: 'A mirrored grid of copies whose rows slide on the beat',
    params: [P('count', 'Grid', 1, 6, 3, { step: 1 }), P('slide', 'Beat slide', 0, 1, 0.35), P('gap', 'Gap', 0, 0.15, 0.02),
      OPT('flip', 'Mirror cells', ['Off', 'On'], 1), MIX],
    glsl: `void main() {
      vec2 cell = vUv * p_count; float row = floor(cell.y);
      cell.x += p_slide * 0.5 * (1.0 - cos(PI * uBeat)) * (mod(row, 2.0) < 1.0 ? 1.0 : -1.0);
      vec2 id = floor(cell); vec2 f = fract(cell);
      if (p_flip > 0.5) { if (mod(id.x, 2.0) > 0.5) f.x = 1.0 - f.x; if (mod(id.y, 2.0) > 0.5) f.y = 1.0 - f.y; }
      f = (f - 0.5) * (1.0 + p_gap * 4.0) + 0.5;
      float inside = step(0.0, f.x) * step(f.x, 1.0) * step(0.0, f.y) * step(f.y, 1.0);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, texture(uSrc, f).rgb * inside, p_mix), 1.0);
    }`,
  },
  lens: {
    name: 'Fisheye', cat: 'space', desc: 'Bulging lens with color fringes at the edges',
    params: [P('bulge', 'Bulge', -0.8, 1.5, 0.5), P('disperse', 'Fringe', 0, 1, 0.35), MIX],
    glsl: `void main() {
      vec2 q = toP(vUv); float r2 = dot(q, q);
      float k = p_bulge; float comp = 1.0 + max(k, 0.0) * 0.18;
      vec3 c;
      c.r = texture(uSrc, mirrorUv(toUv(q * (1.0 + k * r2 * (1.0 + 0.08 * p_disperse)) / comp))).r;
      c.g = texture(uSrc, mirrorUv(toUv(q * (1.0 + k * r2) / comp))).g;
      c.b = texture(uSrc, mirrorUv(toUv(q * (1.0 + k * r2 * (1.0 - 0.08 * p_disperse)) / comp))).b;
      outColor = vec4(mix(texture(uSrc, vUv).rgb, c, p_mix), 1.0);
    }`,
  },
  ribbons: {
    name: 'Ribbon Split', cat: 'space', desc: 'Strips that slide in opposite directions, swinging on the beat',
    params: [P('count', 'Ribbons', 2, 24, 8, { step: 1 }), OPT('dir', 'Bands', ['Horizontal', 'Vertical']), P('shift', 'Shift', 0, 0.5, 0.12),
      P('snap', 'Snap', 0, 1, 0.5), MIX],
    glsl: `void main() {
      float along = p_dir < 0.5 ? vUv.y : vUv.x;
      float id = floor(along * p_count);
      float w = 0.5 - 0.5 * cos(PI * uBeat);
      float e = mix(w, smoothstep(0.0, 1.0, smoothstep(0.0, 1.0, w)), p_snap);
      float amp = p_shift * e * (mod(id, 2.0) < 1.0 ? 1.0 : -1.0) * (0.6 + 0.4 * hash12(vec2(id, uSeed)));
      vec2 uv = vUv;
      if (p_dir < 0.5) uv.x = fract(uv.x + amp); else uv.y = fract(uv.y + amp);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, texture(uSrc, uv).rgb, p_mix), 1.0);
    }`,
  },
  polar: {
    name: 'Little Planet', cat: 'space', desc: 'Wraps the picture into a tiny planet or a rabbit hole',
    params: [OPT('mode', 'Mode', ['Planet', 'Rabbit hole']), P('zoom', 'Zoom', 0.3, 2, 1), P('spin', 'Spin / loop', -3, 3, 0, { step: 1 }), MIX],
    glsl: `void main() {
      vec2 q = toP(vUv);
      float u = atan(q.y, q.x) / TAU + 0.25 + p_spin * uPhase;
      float v = length(q) / (0.5 * p_zoom);
      if (p_mode > 0.5) v = 1.0 - v;
      vec3 c = texture(uSrc, mirrorUv(vec2(u * 2.0, v))).rgb;
      outColor = vec4(mix(texture(uSrc, vUv).rgb, c, p_mix), 1.0);
    }`,
  },
  broll: {
    name: 'B-Roll Blend', cat: 'space', aux: 'clipB', desc: 'Blends or keys a second clip over the frame (Screen, Add, Multiply, Overlay, Luma Key, Chroma Key, Difference)',
    params: [
      OPT('mode', 'Blend', ['Screen', 'Add', 'Multiply', 'Overlay', 'Luma Key', 'Chroma Key', 'Difference']),
      P('mix', 'Opacity', 0, 1, 0.55),
      P('thresh', 'Key threshold', 0, 1, 0.35),
      P('soft', 'Key softness', 0.02, 0.5, 0.15),
      P('zoom', 'B-roll scale', 0.5, 2, 1),
    ],
    glsl: `uniform sampler2D uAux;
    void main() {
      vec2 uvB = (vUv - 0.5) / max(p_zoom, 1e-3) + 0.5;
      vec3 a = texture(uSrc, vUv).rgb;
      vec3 b = texture(uAux, mirrorUv(uvB)).rgb;
      int m = int(p_mode + 0.5);
      vec3 blended;
      if (m == 0) {
        blended = a + b - a * b;
      } else if (m == 1) {
        blended = a + b;
      } else if (m == 2) {
        blended = a * b;
      } else if (m == 3) {
        blended = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - min(a, vec3(1.0))) * (1.0 - min(b, vec3(1.0))), step(0.5, a));
      } else if (m == 4) {
        float lb = luma(b);
        float key = smoothstep(p_thresh - p_soft * 0.5, p_thresh + p_soft * 0.5, lb);
        blended = mix(a, b, key);
      } else if (m == 5) {
        float diff = max(b.g - max(b.r, b.b), 0.0);
        float key = 1.0 - smoothstep(p_thresh - p_soft * 0.5, p_thresh + p_soft * 0.5, diff);
        vec3 bClean = vec3(b.r, min(b.g, max(b.r, b.b)), b.b);
        blended = mix(a, bClean, key);
      } else {
        blended = abs(a - b);
      }
      outColor = vec4(mix(a, blended, p_mix), 1.0);
    }`,
  },

  // Warp
  liquid: {
    name: 'Liquid Flow', cat: 'warp', desc: 'Flowing liquid distortion',
    params: [P('amount', 'Amount', 0, 1, 0.35), P('scale', 'Scale', 0.5, 6, 2), P('cycles', 'Flow / loop', 0, 4, 1, { step: 1 })],
    glsl: `void main() {
      vec2 p = toP(vUv) * p_scale;
      vec2 w = vec2(loopFbm(p, p_cycles), loopFbm(p + vec2(5.2, 1.3), p_cycles)) - 0.5;
      vec2 w2 = vec2(loopFbm(p + 3.0 * w + vec2(1.7, 9.2), p_cycles), loopFbm(p + 3.0 * w + vec2(8.3, 2.8), p_cycles)) - 0.5;
      outColor = vec4(texture(uSrc, mirrorUv(vUv + w2 * p_amount * 0.18)).rgb, 1.0);
    }`,
  },
  glass: {
    name: 'Liquid Glass', cat: 'warp', desc: 'Wavy glass that bends and splits the light',
    params: [P('strength', 'Refraction', 0, 1, 0.5), P('scale', 'Scale', 0.5, 6, 2.2), P('cycles', 'Flow / loop', 0, 3, 1, { step: 1 }),
      P('shine', 'Shine', 0, 1, 0.5), P('disperse', 'Dispersion', 0, 1, 0.5)],
    glsl: `void main() {
      vec2 p = toP(vUv) * p_scale; float e = 0.02;
      float h = loopFbm(p, p_cycles);
      vec2 g = vec2(loopFbm(p + vec2(e, 0.0), p_cycles) - h, loopFbm(p + vec2(0.0, e), p_cycles) - h) / e;
      vec3 n = normalize(vec3(-g * 0.35, 1.0));
      vec2 off = n.xy * p_strength * 0.12; float d = p_disperse * 0.3;
      vec3 c = vec3(texture(uSrc, mirrorUv(vUv + off * (1.0 + d))).r, texture(uSrc, mirrorUv(vUv + off)).g,
                    texture(uSrc, mirrorUv(vUv + off * (1.0 - d))).b);
      vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
      float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 48.0);
      float fres = (1.0 - n.z) * (1.0 - n.z);
      outColor = vec4(c + (spec * 2.5 + fres * 0.8) * p_shine * vec3(1.0, 0.98, 0.95), 1.0);
    }`,
  },
  ripple: {
    name: 'Shockwave', cat: 'warp', desc: 'Rings that ripple outward on the beat',
    params: [P('strength', 'Strength', 0, 1, 0.5), P('speed', 'Speed', 0.3, 2, 1), OPT('every', 'Emit every', ['Beat', '2 Beats', 'Bar']),
      P('glow', 'Ring glow', 0, 1, 0.3)],
    glsl: `void main() {
      float ev = p_every < 0.5 ? 1.0 : (p_every < 1.5 ? 2.0 : 4.0);
      float age = fract(uBeat / ev);
      vec2 q = toP(vUv); float d = length(q);
      float R = age * p_speed * 1.1; float w = 0.05 + 0.08 * age;
      float x = (d - R) / w; float env = exp(-x * x) * (1.0 - age);
      vec2 dir = q / max(d, 1e-4);
      float disp = -x * exp(-x * x) * p_strength * 0.07 * (1.0 - age);
      vec3 c = vec3(texture(uSrc, toUv(q - dir * disp * 1.15)).r, texture(uSrc, toUv(q - dir * disp)).g,
                    texture(uSrc, toUv(q - dir * disp * 0.85)).b);
      outColor = vec4(c + env * p_glow * vec3(0.75, 0.9, 1.0) * 0.7, 1.0);
    }`,
  },
  vortex: {
    name: 'Vortex', cat: 'warp', desc: 'Twists the middle of the frame on the kick',
    params: [P('twist', 'Twist', -1, 1, 0.4), P('radius', 'Radius', 0.2, 1.2, 0.7), P('spin', 'Spin / loop', -2, 2, 0, { step: 1 })],
    glsl: `void main() {
      vec2 q = toP(vUv); float f = 1.0 - smoothstep(0.0, p_radius, length(q));
      float a = p_twist * 4.0 * f * f + p_spin * TAU * uPhase * f;
      outColor = vec4(texture(uSrc, mirrorUv(toUv(rot(a) * q))).rgb, 1.0);
    }`,
  },
  zoomblur: {
    name: 'Zoom Blur', cat: 'warp', desc: 'Blur that rushes outward on the kick',
    params: [P('amount', 'Amount', 0, 1, 0.25)],
    glsl: `void main() {
      vec2 q = vUv - 0.5; vec3 s = vec3(0.0);
      for (int i = 0; i < 14; i++) s += texture(uSrc, 0.5 + q * (1.0 - p_amount * 0.14 * float(i) / 13.0)).rgb;
      outColor = vec4(s / 14.0, 1.0);
    }`,
  },
  droop: {
    name: 'Gravity Melt', cat: 'warp', desc: 'The frame sags and drips downward, heaviest in the highlights',
    params: [P('amount', 'Melt', 0, 1, 0.5), P('bright', 'Highlight melt', 0, 1, 0.5), P('scale', 'Drips', 0.5, 8, 3),
      P('cycles', 'Flow / loop', 0, 3, 1, { step: 1 })],
    glsl: ENV + `void main() {
      float env = 0.55 + 0.45 * beatEnv(3.0);
      float n = loopFbm(vec2(toP(vUv).x * p_scale * 5.0, 0.37), p_cycles);
      n = smoothstep(0.3, 0.75, n);
      float l = luma(toSRGB(texture(uSrc, vUv).rgb));
      float sag = p_amount * env * (0.1 + 0.9 * n) * pow(1.0 - vUv.y, 1.4) * max(0.0, 1.0 + p_bright * (l - 0.45) * 2.0) * 0.32;
      float wob = sin(vUv.y * 26.0 + TAU * uPhase) * 0.004 * p_amount;
      outColor = vec4(texture(uSrc, mirrorUv(vUv + vec2(wob, sag))).rgb, 1.0);
    }`,
  },

  // Time (feedback)
  trails: {
    name: 'Feedback Trails', cat: 'time', desc: 'Each frame leaves a fading copy that can zoom, spin and shift hue', feedback: true,
    params: [P('decay', 'Persistence', 0, 0.97, 0.82), P('zoom', 'Zoom', -1, 1, 0.35), P('rotate', 'Rotate', -1, 1, 0),
      P('hue', 'Hue drift', -1, 1, 0.15), OPT('blend', 'Blend', ['Max', 'Screen', 'Smear'], 1)],
    glsl: `uniform sampler2D uPrev; void main() {
      vec2 q = rot(p_rotate * 0.03) * toP(vUv) / (1.0 + p_zoom * 0.04);
      vec3 prev = max(hueRotate(texture(uPrev, mirrorUv(toUv(q))).rgb, p_hue * 0.15), 0.0) * p_decay;
      vec3 cur = texture(uSrc, vUv).rgb;
      vec3 o = p_blend < 0.5 ? max(cur, prev) : (p_blend < 1.5 ? cur + prev * (1.0 - min(cur, 1.0)) : mix(cur, prev, p_decay * 0.85));
      outColor = vec4(min(o, vec3(12.0)), 1.0);
    }`,
  },
  echo: {
    name: 'Chroma Echo', cat: 'time', desc: 'Green and blue lag behind red, leaving color-split trails', feedback: true,
    params: [P('amount', 'Lag', 0, 0.97, 0.75), P('drift', 'Drift', 0, 1, 0.2)],
    glsl: `uniform sampler2D uPrev; void main() {
      vec3 cur = texture(uSrc, vUv).rgb;
      vec3 prev = texture(uPrev, toUv(toP(vUv) / (1.0 + p_drift * 0.02))).rgb;
      outColor = vec4(cur.r, mix(cur.g, prev.g, p_amount * 0.85), mix(cur.b, prev.b, p_amount), 1.0);
    }`,
  },
  slitscan: {
    name: 'Slit Scan', cat: 'time', desc: 'A scan line sweeps the frame; each row keeps the moment it was passed', feedback: true,
    params: [P('cycles', 'Sweeps / loop', 1, 4, 2, { step: 1 }), OPT('dir', 'Direction', ['Top → bottom', 'Left → right']),
      P('width', 'Band', 0.01, 0.3, 0.04), P('hold', 'Persistence', 0.7, 1, 1)],
    glsl: `uniform sampler2D uPrev; void main() {
      float s = p_dir < 0.5 ? 1.0 - vUv.y : vUv.x;
      float w = max(p_width, 1.5 * p_cycles / max(uLoop * 30.0, 1.0));
      float d = fract(uPhase * p_cycles) - s; d -= floor(d);
      float k = 1.0 - smoothstep(w * 0.6, w, d);
      vec3 cur = texture(uSrc, vUv).rgb;
      outColor = vec4(mix(cur, mix(texture(uPrev, vUv).rgb, cur, k), p_hold), 1.0);
    }`,
  },
  mosh: {
    name: 'Datamosh Smear', cat: 'time', desc: 'Blocks freeze and smear along the motion, re-rolled every beat', feedback: true,
    params: [P('amount', 'Mosh', 0, 1, 0.5), P('block', 'Block size', 0, 1, 0.4), P('flow', 'Flow', 0, 1, 0.5), P('hold', 'Hold', 0, 1, 0.7)],
    glsl: `uniform sampler2D uPrev; void main() {
      float bt = floor(uBeat);
      float px = mix(10.0, 56.0, p_block) * uScale;
      vec2 cell = floor(gl_FragCoord.xy / px);
      float on = step(hash12(cell * 0.73 + bt * 11.17 + uSeed), p_amount);
      vec3 cur = texture(uSrc, vUv).rgb;
      vec2 cuv = (cell + 0.5) * px / uRes; vec2 e = vec2(px * 0.5) / uRes;
      float gx = luma(toSRGB(texture(uSrc, cuv + vec2(e.x, 0.0)).rgb)) - luma(toSRGB(texture(uSrc, cuv - vec2(e.x, 0.0)).rgb));
      float gy = luma(toSRGB(texture(uSrc, cuv + vec2(0.0, e.y)).rgb)) - luma(toSRGB(texture(uSrc, cuv - vec2(0.0, e.y)).rgb));
      vec2 mv = (vec2(gx, gy) * 3.0 + (hash22(cell + bt * 3.71) - 0.5) * 0.8) * p_flow * 7.0 * uScale / uRes;
      vec3 moshed = mix(texture(uPrev, vUv - mv).rgb, cur, mix(0.25, 0.015, p_hold));
      outColor = vec4(mix(cur, moshed, on), 1.0);
    }`,
  },

  // Light (multi-pass chains in engine.js)
  stutter: {
    name: 'Stutter', cat: 'time', desc: 'Beat-locked frame holds: choppy low-fps motion or a freeze on every beat', feedback: true,
    params: [OPT('mode', 'Mode', ['Choppy', 'Beat freeze', 'Kick freeze']), P('rate', 'Steps / beat', 1, 8, 3, { step: 1 }),
      P('hold', 'Freeze length', 0.1, 0.9, 0.45)],
    glsl: `uniform sampler2D uPrev; void main() {
      // beat position one export frame ago; a hold releases whenever a new step / beat starts
      float pb = mod(uTime - 1.0 / 30.0 + uLoop, uLoop) / max(uBeatLen, 1e-3);
      bool fresh;
      if (p_mode < 0.5) fresh = floor(uBeat * p_rate + 1e-4) != floor(pb * p_rate + 1e-4);
      else if (p_mode < 1.5) fresh = floor(uBeat + 1e-4) != floor(pb + 1e-4) || fract(uBeat) > p_hold;
      else fresh = uKick < 0.55 || fract(uBeat) > p_hold || floor(uBeat + 1e-4) != floor(pb + 1e-4);
      outColor = vec4(fresh ? texture(uSrc, vUv).rgb : texture(uPrev, vUv).rgb, 1.0);
    }`,
  },
  bloom: {
    name: 'Bloom', cat: 'light', desc: 'Soft glow around bright areas', kind: 'bloom',
    params: [P('threshold', 'Threshold', 0, 2, 0.7), P('intensity', 'Intensity', 0, 3, 0.8), P('radius', 'Radius', 0, 1, 0.7),
      P('warmth', 'Warmth', -1, 1, 0)],
  },
  streaks: {
    name: 'Anamorphic Flare', cat: 'light', desc: 'Horizontal lens streaks from highlights', kind: 'streaks',
    params: [P('threshold', 'Threshold', 0, 2, 0.9), P('intensity', 'Intensity', 0, 3, 1), P('length', 'Length', 0, 1, 0.6),
      P('hue', 'Hue', 0, 1, 0.56)],
  },
  rays: {
    name: 'God Rays', cat: 'light', desc: 'Light shafts streaming from bright areas', kind: 'rays',
    params: [P('threshold', 'Threshold', 0, 2, 0.6), P('intensity', 'Intensity', 0, 3, 0.8), P('length', 'Length', 0, 1, 0.6),
      P('height', 'Source height', 0, 1, 0.78)],
  },
  chroma: {
    name: 'Spectral Aberration', cat: 'light', desc: 'Pulls the colors apart towards the edges, like a cheap lens',
    params: [P('amount', 'Amount', 0, 1, 0.3), OPT('mode', 'Mode', ['Radial', 'Horizontal'])],
    glsl: `void main() {
      vec2 q = toP(vUv);
      vec2 dir = p_mode < 0.5 ? q * length(q) * 1.6 : vec2(0.35, 0.0);
      vec3 acc = vec3(0.0), wsum = vec3(0.0);
      for (int i = 0; i < 9; i++) {
        float t = float(i) / 8.0;
        vec3 w = max(vec3(1.0 - abs(t - 0.1) * 2.6, 1.0 - abs(t - 0.5) * 2.6, 1.0 - abs(t - 0.9) * 2.6), 0.0);
        acc += texture(uSrc, mirrorUv(toUv(q - dir * (t - 0.5) * p_amount * 0.09))).rgb * w; wsum += w;
      }
      outColor = vec4(acc / wsum, 1.0);
    }`,
  },
  leak: {
    name: 'Light Leak', cat: 'light', desc: 'Drifting film light leaks from the frame edge',
    params: [P('amount', 'Amount', 0, 1.5, 0.6), P('hue', 'Hue', 0, 1, 0.05), P('cycles', 'Drift / loop', 1, 3, 1, { step: 1 })],
    glsl: `void main() {
      vec2 q = toP(vUv);
      float n1 = loopFbm(q * 0.8 + vec2(3.0), p_cycles), n2 = loopFbm(q * 1.3 + vec2(9.0), p_cycles);
      float edge = smoothstep(0.15, 0.9, length(q * vec2(1.6, 1.0)));
      float leak = smoothstep(0.45, 0.85, n1) * (0.35 + 0.65 * edge);
      vec3 col = toLin(hsv2rgb(vec3(fract(p_hue + (n2 - 0.5) * 0.12), 0.85, 1.0)));
      outColor = vec4(texture(uSrc, vUv).rgb + col * leak * p_amount * 1.4, 1.0);
    }`,
  },
  glint: {
    name: 'Star Glint', cat: 'light', desc: 'Cross-screen star spikes from the highlights',
    params: [P('threshold', 'Threshold', 0, 2, 0.4), P('intensity', 'Intensity', 0, 3, 1), P('length', 'Length', 0, 1, 0.4),
      OPT('points', 'Points', ['4', '6', '8']), P('angle', 'Angle', 0, 1, 0.125), P('spin', 'Spin / loop', -2, 2, 0, { step: 1 }),
      P('hue', 'Tint', 0, 1, 0.58)],
    glsl: `vec3 hi(vec3 c, float th) { float l = luma(c); return c * max(l - th, 0.0) / max(l, 1e-3); }
    void main() {
      vec3 src = texture(uSrc, vUv).rgb;
      int axes = p_points < 0.5 ? 2 : (p_points < 1.5 ? 3 : 4);
      int taps = axes == 2 ? 12 : (axes == 3 ? 10 : 8);
      float len = 0.03 + p_length * 0.16;
      float j = hash12(gl_FragCoord.xy);
      vec3 acc = vec3(0.0);
      for (int a = 0; a < 4; a++) {
        if (a >= axes) break;
        float ang = p_angle * PI + float(a) * PI / float(axes) + p_spin * uPhase * PI / float(axes);
        vec2 dir = vec2(cos(ang), sin(ang)) / vec2(aspect(), 1.0);
        for (int i = 1; i <= 12; i++) {
          if (i > taps) break;
          float k = (float(i) - j) / float(taps);
          vec2 o = dir * k * k * len;
          acc += (hi(texture(uSrc, vUv + o).rgb, p_threshold) + hi(texture(uSrc, vUv - o).rgb, p_threshold)) * (1.0 - k) * (1.0 - k);
        }
      }
      vec3 tint = mix(vec3(1.0), toLin(hsv2rgb(vec3(p_hue, 0.6, 1.0))), 0.6);
      outColor = vec4(src + acc * tint * p_intensity * 6.0 / float(taps), 1.0);
    }`,
  },
  tiltshift: {
    name: 'Tilt Shift', cat: 'light', desc: 'Blurs above and below a sharp band so the scene looks like a miniature',
    params: [P('focus', 'Focus height', 0, 1, 0.5), P('width', 'Focus band', 0.02, 0.6, 0.18), P('blur', 'Blur', 0, 1, 0.6),
      P('sat', 'Saturation', 0, 2, 1.25)],
    glsl: `void main() {
      float f = smoothstep(p_width * 0.5, p_width * 0.5 + 0.22, abs(vUv.y - p_focus));
      float rad = f * p_blur * 0.022;
      vec3 acc = texture(uSrc, vUv).rgb; float ws = 1.0;
      if (rad > 1e-4) {
        for (int i = 0; i < 32; i++) {
          float a = float(i) * 2.39996323;
          vec2 o = vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 32.0) * rad / vec2(aspect(), 1.0);
          vec3 s = texture(uSrc, vUv + o).rgb;
          float w = 1.0 + 2.0 * luma(min(s, vec3(4.0)));
          acc += s * w; ws += w;
        }
      }
      vec3 c = acc / ws;
      outColor = vec4(max(mix(vec3(luma(c)), c, p_sat), 0.0), 1.0);
    }`,
  },
  ghost: {
    name: 'Double Vision', cat: 'light', desc: 'A tinted ghost copy that splits away on every beat',
    params: [P('amount', 'Separation', 0, 1, 0.4), P('angle', 'Angle', 0, 1, 0), P('tint', 'Tint split', 0, 1, 0.5),
      OPT('mode', 'Blend', ['Screen', 'Add', 'Average'])],
    glsl: ENV + `void main() {
      float ang = p_angle * PI;
      vec2 off = vec2(cos(ang), sin(ang)) / vec2(aspect(), 1.0) * p_amount * (0.35 + 0.65 * beatEnv(4.0)) * 0.035;
      vec3 a = texture(uSrc, mirrorUv(vUv - off)).rgb * mix(vec3(1.0), vec3(1.18, 0.86, 0.8), p_tint);
      vec3 b = texture(uSrc, mirrorUv(vUv + off)).rgb * mix(vec3(1.0), vec3(0.8, 0.96, 1.2), p_tint);
      int m = int(p_mode + 0.5);
      vec3 c = m == 0 ? a + b * 0.65 * (1.0 - min(a, vec3(1.0))) : m == 1 ? (a + b) * 0.62 : mix(a, b, 0.5);
      outColor = vec4(c, 1.0);
    }`,
  },
  prismecho: {
    name: 'Prism Echo', cat: 'light', desc: 'Adds a faint enlarged copy with red and blue pulled apart. It snaps back on each beat and grows until the next',
    params: [P('amount', 'Strength', 0, 0.6, 0.22), P('zoom', 'Zoom', 1, 1.4, 1.08), P('expand', 'Expand', 0, 0.25, 0.1),
      P('split', 'Color split', 0, 24, 4), OPT('trigger', 'Trigger', ['Beat', 'Kick'])],
    glsl: ENV + `vec3 ghostAt(vec2 uv, float z) { return texture(uSrc, (uv - 0.5) / z + 0.5).rgb; }
    void main() {
      float env = p_trigger < 0.5 ? beatEnv(2.5) : clamp(uKick, 0.0, 1.0);
      float z = p_zoom + p_expand * (1.0 - env);            // the copy zooms in further as the hit fades
      vec2 sp = vec2(p_split * uScale / uRes.x, 0.0);       // the split is in pixels at 1080 x 1920
      vec3 g = vec3(ghostAt(vUv + sp, z).r, ghostAt(vUv, z).g, ghostAt(vUv - sp, z).b);
      // added in display values, as the CPU version did, so the copy lifts the shadows too
      vec3 o = toSRGB(texture(uSrc, vUv).rgb) + toSRGB(g) * p_amount * (0.5 + 0.5 * env);
      outColor = vec4(toLin(o), 1.0);
    }`,
  },
  pulse: {
    name: 'Warm Pulse', cat: 'light', desc: 'Warms and brightens the picture on every hit',
    params: [OPT('trigger', 'Trigger', ['Kick', 'Beat', 'Bass', 'Snare']), P('amount', 'Amount', 0, 1, 0.35), P('warmth', 'Warmth', 0, 1, 0.6),
      P('glow', 'Glow', 0, 1, 0.4)],
    glsl: ENV + `void main() {
      int tr = int(p_trigger + 0.5);
      float env = clamp(tr == 0 ? uKick : tr == 1 ? beatEnv(5.0) : tr == 2 ? uBass : uSnare, 0.0, 1.0);
      vec3 src = texture(uSrc, vUv).rgb;
      vec3 glow = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float a = float(i) * TAU / 8.0;
        glow += max(texture(uSrc, vUv + vec2(cos(a), sin(a)) / vec2(aspect(), 1.0) * 0.012).rgb - 0.6, 0.0);
      }
      vec3 warm = mix(vec3(1.0), vec3(1.0, 0.82, 0.6), p_warmth);
      outColor = vec4(src * (1.0 + env * p_amount * 0.6 * warm) + glow / 8.0 * warm * env * p_glow * 1.5, 1.0);
    }`,
  },
  shutter: {
    name: 'Beat Shutter', cat: 'light', desc: 'Dims the picture between beats, never to black, so it stays photosafe',
    params: [OPT('rate', 'Rate', ['Off-beat', 'Every 2 beats', 'Every bar']), P('depth', 'Depth', 0, 0.5, 0.25), P('soft', 'Softness', 0, 1, 0.6)],
    glsl: `void main() {
      float per = p_rate < 0.5 ? 1.0 : (p_rate < 1.5 ? 2.0 : 4.0);
      float s = 0.5 - 0.5 * cos(TAU * fract(uBeat / per));
      float gate = mix(smoothstep(0.3, 0.7, s), s, p_soft);
      outColor = vec4(texture(uSrc, vUv).rgb * (1.0 - p_depth * gate), 1.0);
    }`,
  },
  bassrim: {
    name: 'Bass Rim', cat: 'light', desc: 'A vignette that tightens on the low end, with a colored rim glow',
    params: [OPT('trigger', 'Trigger', ['Bass', 'Kick', 'Beat']), P('amount', 'Punch', 0, 1, 0.5), P('size', 'Size', 0.3, 1.2, 0.65),
      P('rim', 'Rim glow', 0, 1, 0.5), P('hue', 'Rim hue', 0, 1, 0.8)],
    glsl: ENV + `void main() {
      int tr = int(p_trigger + 0.5);
      float env = clamp(tr == 0 ? uBass : tr == 1 ? uKick : beatEnv(4.0), 0.0, 1.0);
      float d = length(toP(vUv) * vec2(1.6, 1.0));
      float R = p_size * (1.0 - 0.3 * env * p_amount);
      vec3 c = texture(uSrc, vUv).rgb * (1.0 - smoothstep(R * 0.5, R, d) * (0.3 + 0.55 * p_amount * (0.4 + 0.6 * env)));
      float x = (d - R * 0.82) / 0.07;
      c += toLin(hsv2rgb(vec3(p_hue, 0.8, 1.0))) * exp(-x * x) * p_rim * env * 0.5;
      outColor = vec4(c, 1.0);
    }`,
  },

  // Stylize
  dither: {
    name: '1-Bit Dither', cat: 'stylize', desc: '8×8 ordered dither in a limited palette',
    params: [P('size', 'Pixel', 1, 10, 3), P('levels', 'Tones', 2, 6, 2, { step: 1 }),
      OPT('palette', 'Palette', ['Ink', 'Gameboy', 'Acid', 'Cyber', 'Sunset', 'Blood', 'Source']), P('contrast', 'Contrast', 0.5, 2.5, 1.3), MIX],
    glsl: BAYER + RAMP + `void main() {
      float px = max(1.0, floor(p_size * uScale + 0.5));
      vec2 cell = floor(gl_FragCoord.xy / px);
      vec3 s = toSRGB(texture(uSrc, (cell + 0.5) * px / uRes).rgb);
      float n = p_levels - 1.0; float d = bayer8(cell);
      vec3 col;
      int pal = int(p_palette + 0.5);
      if (pal == 6) {
        col = clamp(floor(((s - 0.5) * p_contrast + 0.5) * n + d) / n, 0.0, 1.0);
      } else {
        float l = clamp((luma(s) - 0.5) * p_contrast + 0.5, 0.0, 1.0);
        float q = clamp(floor(l * n + d) / n, 0.0, 1.0);
        if (pal == 0) col = ramp5(q, hx(723727.), hx(2763315.), hx(7237240.), hx(13158080.), hx(16052712.));
        else if (pal == 1) col = ramp5(q, hx(997391.), hx(3170864.), hx(5996314.), hx(9153551.), hx(10206223.));
        else if (pal == 2) col = ramp5(q, hx(725030.), hx(3808410.), hx(1024895.), hx(8191823.), hx(15925176.));
        else if (pal == 3) col = ramp5(q, hx(1179684.), hx(5963977.), hx(16723607.), hx(5234943.), hx(15334911.));
        else if (pal == 4) col = ramp5(q, hx(1706798.), hx(7150427.), hx(14697051.), hx(16752451.), hx(16770984.));
        else col = ramp5(q, hx(655360.), hx(4849680.), hx(11735598.), hx(16734798.), hx(16767439.));
      }
      outColor = vec4(mix(texture(uSrc, vUv).rgb, toLin(col), p_mix), 1.0);
    }`,
  },
  halftone: {
    name: 'Halftone', cat: 'stylize', desc: 'Rotated CMYK or ink dot screens',
    params: [P('size', 'Dot size', 3, 28, 10), OPT('mode', 'Screen', ['CMYK', 'Ink', 'Color dots']), P('angle', 'Angle', 0, 90, 30), MIX],
    glsl: `
    float cellPx() { return max(2.0, p_size * uScale); }
    vec2 cellCenterUv(vec2 fc, float ang) {
      float cp = cellPx(); vec2 p = rot(ang) * fc / cp;
      return (transpose(rot(ang)) * ((floor(p) + 0.5) * cp)) / uRes;
    }
    float dotMask(vec2 fc, float ang, float v) {
      float cp = cellPx(); vec2 p = rot(ang) * fc / cp;
      float d = length(fract(p) - 0.5); float r = sqrt(clamp(v, 0.0, 1.0)) * 0.62; float aa = 1.2 / cp;
      return 1.0 - smoothstep(r - aa, r + aa, d);
    }
    vec4 cmyk(vec3 c) { float k = 1.0 - max(c.r, max(c.g, c.b)); vec3 cmy = (1.0 - c - k) / max(1.0 - k, 1e-3); return vec4(cmy, k); }
    void main() {
      vec2 fc = gl_FragCoord.xy; float a = radians(p_angle); int m = int(p_mode + 0.5);
      vec3 o;
      if (m == 0) {
        float c = dotMask(fc, a + radians(15.0), cmyk(toSRGB(texture(uSrc, cellCenterUv(fc, a + radians(15.0))).rgb)).x);
        float mg = dotMask(fc, a + radians(75.0), cmyk(toSRGB(texture(uSrc, cellCenterUv(fc, a + radians(75.0))).rgb)).y);
        float y = dotMask(fc, a, cmyk(toSRGB(texture(uSrc, cellCenterUv(fc, a)).rgb)).z);
        float k = dotMask(fc, a + radians(45.0), cmyk(toSRGB(texture(uSrc, cellCenterUv(fc, a + radians(45.0))).rgb)).w);
        o = vec3(0.97, 0.95, 0.9) * (1.0 - c * vec3(1.0, 0.25, 0.05)) * (1.0 - mg * vec3(0.05, 1.0, 0.35)) * (1.0 - y * vec3(0.0, 0.05, 1.0)) * (1.0 - k * 0.92);
      } else if (m == 1) {
        float l = luma(toSRGB(texture(uSrc, cellCenterUv(fc, a)).rgb));
        o = mix(vec3(0.96, 0.94, 0.88), vec3(0.06, 0.06, 0.09), dotMask(fc, a, 1.0 - l));
      } else {
        vec3 s = toSRGB(texture(uSrc, cellCenterUv(fc, a)).rgb);
        o = s * dotMask(fc, a, luma(s) * 1.3);
      }
      outColor = vec4(mix(texture(uSrc, vUv).rgb, toLin(o), p_mix), 1.0);
    }`,
  },
  pixelsort: {
    name: 'Pixel Sort', cat: 'stylize', desc: 'Sorts runs of bright pixels into streaks',
    params: [P('threshold', 'Threshold', 0, 1, 0.55), P('length', 'Length', 0, 1, 0.5), OPT('dir', 'Direction', ['Fall', 'Rise', 'Sideways']), MIX],
    glsl: `void main() {
      vec2 dir = p_dir < 0.5 ? vec2(0.0, 1.0) : (p_dir < 1.5 ? vec2(0.0, -1.0) : vec2(1.0, 0.0));
      vec3 cur = texture(uSrc, vUv).rgb; float lc = luma(toSRGB(cur));
      vec3 best = cur; float bl = lc; float run = 0.0;
      if (lc > p_threshold) {
        for (int i = 1; i <= 40; i++) {
          vec3 s = texture(uSrc, vUv + dir * p_length * 0.4 * float(i) / 40.0).rgb; float l = luma(toSRGB(s));
          if (l < p_threshold) break;
          run = float(i) / 40.0;
          if (l > bl) { bl = l; best = s; }
        }
      }
      vec3 o = mix(cur, best, smoothstep(0.0, 0.25, run));
      outColor = vec4(mix(cur, o, p_mix), 1.0);
    }`,
  },
  ascii: {
    name: 'Glyph Matrix', cat: 'stylize', desc: 'Redraws the picture as text characters, ASCII or Matrix-style', aux: 'glyphs',
    params: [P('cell', 'Cell', 6, 36, 14), OPT('color', 'Color', ['Source', 'Matrix', 'Amber', 'Mono']), OPT('charset', 'Glyphs', ['Ramp', 'Matrix']), MIX],
    glsl: `uniform sampler2D uAux; void main() {
      float px = max(4.0, floor(p_cell * uScale));
      vec2 cell = floor(gl_FragCoord.xy / px); vec2 f = fract(gl_FragCoord.xy / px);
      vec2 c0 = (cell + 0.5) * px / uRes; vec2 o = vec2(px * 0.25) / uRes;
      vec3 s = (texture(uSrc, c0).rgb * 2.0 + texture(uSrc, c0 + o).rgb + texture(uSrc, c0 - o).rgb +
                texture(uSrc, c0 + vec2(o.x, -o.y)).rgb + texture(uSrc, c0 - vec2(o.x, -o.y)).rgb) / 6.0;
      vec3 ss = toSRGB(s); float l = clamp(luma(ss) * 1.15, 0.0, 0.999);
      float idx = floor(l * 16.0);
      float row = p_charset < 0.5 ? 0.0 : 1.0;
      if (row > 0.5) idx = floor(hash12(cell + floor(uBeat * 2.0) * 3.7) * 16.0);
      float g = texture(uAux, vec2((idx + f.x) / 16.0, (row + f.y) / 2.0)).r;
      if (row > 0.5) g *= smoothstep(0.04, 0.5, l);
      int m = int(p_color + 0.5);
      vec3 col = m == 0 ? ss * 1.25 : m == 1 ? vec3(0.35, 1.0, 0.45) * (0.35 + l) : m == 2 ? vec3(1.0, 0.7, 0.25) * (0.35 + l) : vec3(0.92);
      if (m == 1 && hash12(cell + floor(uBeat * 4.0)) > 0.97) col = vec3(0.85, 1.0, 0.9);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, toLin(col * g), p_mix), 1.0);
    }`,
  },
  glitch: {
    name: 'Data Glitch', cat: 'stylize', desc: 'Block tears and RGB splits that change every 16th note',
    params: [P('amount', 'Amount', 0, 1, 0.35), P('block', 'Block size', 0, 1, 0.5), P('split', 'RGB split', 0, 1, 0.4)],
    glsl: `void main() {
      float t = floor(uBeat * 4.0);
      vec2 bsz = vec2(mix(0.5, 0.06, p_block), mix(0.12, 0.012, p_block));
      vec2 b = floor(vUv / bsz);
      float r = hash12(b + t * 7.13 + uSeed);
      float on = step(1.0 - p_amount * 0.55, r);
      float dx = (hash12(b * 3.1 + t) - 0.5) * 0.22 * p_amount * on;
      float ln = floor(vUv.y * 180.0);
      dx += step(0.988 - p_amount * 0.04, hash12(vec2(ln, t))) * (hash12(vec2(t, ln)) - 0.5) * 0.08;
      vec2 uv = vUv + vec2(dx, 0.0); float sp = p_split * 0.012 * (0.3 + p_amount);
      vec3 c = vec3(texture(uSrc, mirrorUv(uv + vec2(sp, 0.0))).r, texture(uSrc, mirrorUv(uv)).g, texture(uSrc, mirrorUv(uv - vec2(sp, 0.0))).b);
      if (on > 0.5 && hash12(b + t + 0.5) > 0.7) c = c.gbr;
      outColor = vec4(c, 1.0);
    }`,
  },
  vhs: {
    name: 'VHS Tape', cat: 'stylize', desc: 'Chroma bleed, line wobble and a rolling tracking band',
    params: [P('amount', 'Wear', 0, 1, 0.6), P('tracking', 'Tracking', 0, 1, 0.35), P('bleed', 'Chroma bleed', 0, 1, 0.55)],
    glsl: YIQ + `void main() {
      float y = vUv.y;
      float wob = (loopNoise(vec2(y * 40.0, 3.0), 2.0) - 0.5) * 0.005 * p_amount;
      float dy = y - fract(uPhase * 2.0 + 0.3); dy -= floor(dy + 0.5); dy *= 16.0;
      float band = exp(-dy * dy) * p_tracking;
      wob += (hash12(vec2(floor(y * 240.0), uFrame)) - 0.5) * 0.035 * band;
      vec2 uv = vec2(vUv.x + wob, y);
      vec3 yiq = rgb2yiq(toSRGB(texture(uSrc, mirrorUv(uv)).rgb));
      vec2 iq = vec2(0.0);
      for (int i = -4; i <= 4; i++) iq += rgb2yiq(toSRGB(texture(uSrc, mirrorUv(uv + vec2(float(i + 2) * 0.004 * p_bleed, 0.0))).rgb)).yz;
      yiq.yz = mix(yiq.yz, iq / 9.0, p_bleed) * (1.0 - 0.25 * p_amount);
      vec3 s = clamp(yiq2rgb(yiq), 0.0, 1.0);
      s = mix(s, s * vec3(1.04, 0.97, 1.08) + 0.03, p_amount);
      s += band * (hash12(gl_FragCoord.xy * 0.5 + uFrame) - 0.3) * 0.35;
      outColor = vec4(toLin(s), 1.0);
    }`,
  },
  crt: {
    name: 'CRT Monitor', cat: 'stylize', desc: 'Curved glass, scanlines and an RGB aperture mask',
    params: [P('curve', 'Curvature', 0, 1, 0.35), P('scan', 'Scanlines', 0, 1, 0.55), P('mask', 'Aperture', 0, 1, 0.45)],
    glsl: `void main() {
      vec2 q = vUv * 2.0 - 1.0; q *= 1.0 + p_curve * 0.12 * dot(q.yx, q.yx); vec2 uv = q * 0.5 + 0.5;
      float inside = 1.0 - smoothstep(0.985, 1.0, max(abs(q.x), abs(q.y)));
      vec3 c = texture(uSrc, uv).rgb;
      float lines = uRes.y / max(3.0 * uScale, 1.0);
      c *= mix(1.0, 0.5 + 0.5 * (0.5 + 0.5 * cos(uv.y * lines * TAU)), p_scan);
      float m = mod(floor(gl_FragCoord.x / max(1.0, uScale * 1.5)), 3.0);
      vec3 mask = m < 1.0 ? vec3(1.0, 0.72, 0.72) : (m < 2.0 ? vec3(0.72, 1.0, 0.72) : vec3(0.72, 0.72, 1.0));
      c *= mix(vec3(1.0), mask * 1.3, p_mask);
      outColor = vec4(c * inside, 1.0);
    }`,
  },
  edges: {
    name: 'Neon Contours', cat: 'stylize', desc: 'Glowing outlines in rainbow, the original colors or white',
    params: [P('strength', 'Strength', 0, 2, 1), P('dim', 'Dim source', 0, 1, 0.7), P('hue', 'Hue / loop', 0, 3, 1, { step: 1 }),
      OPT('mode', 'Color', ['Rainbow', 'Source', 'White'])],
    glsl: `void main() {
      vec2 t = max(1.0, 1.5 * uScale) / uRes;
      float tl = luma(toSRGB(texture(uSrc, vUv + t * vec2(-1, 1)).rgb)), tc = luma(toSRGB(texture(uSrc, vUv + t * vec2(0, 1)).rgb)),
            tr = luma(toSRGB(texture(uSrc, vUv + t * vec2(1, 1)).rgb)), ml = luma(toSRGB(texture(uSrc, vUv + t * vec2(-1, 0)).rgb)),
            mr = luma(toSRGB(texture(uSrc, vUv + t * vec2(1, 0)).rgb)), bl = luma(toSRGB(texture(uSrc, vUv + t * vec2(-1, -1)).rgb)),
            bc = luma(toSRGB(texture(uSrc, vUv + t * vec2(0, -1)).rgb)), br = luma(toSRGB(texture(uSrc, vUv + t * vec2(1, -1)).rgb));
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl), gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
      float e = smoothstep(0.1, 0.6, length(vec2(gx, gy))) * p_strength;
      vec3 src = texture(uSrc, vUv).rgb;
      int m = int(p_mode + 0.5);
      vec3 col = m == 0 ? toLin(hsv2rgb(vec3(fract(atan(gy, gx) / TAU + uPhase * p_hue), 0.85, 1.0))) : m == 1 ? src * 3.0 : vec3(1.0);
      outColor = vec4(src * (1.0 - p_dim) + col * e * 1.6, 1.0);
    }`,
  },
  mosaic: {
    name: 'Mosaic', cat: 'stylize', desc: 'Pixel blocks or round LED dots',
    params: [P('size', 'Block', 2, 64, 14), OPT('shape', 'Shape', ['Square', 'LED']), MIX],
    glsl: `void main() {
      float px = max(1.0, p_size * uScale);
      vec2 cell = floor(gl_FragCoord.xy / px); vec2 f = fract(gl_FragCoord.xy / px) - 0.5;
      vec3 c = texture(uSrc, (cell + 0.5) * px / uRes).rgb;
      if (p_shape > 0.5) c *= (1.0 - smoothstep(0.32, 0.5, length(f))) * 1.4;
      outColor = vec4(mix(texture(uSrc, vUv).rgb, c, p_mix), 1.0);
    }`,
  },
  frost: {
    name: 'Frost Mist', cat: 'stylize', desc: 'Frosted-glass blur with drifting mist',
    params: [P('amount', 'Frost', 0, 1, 0.5), P('scale', 'Grain size', 1, 8, 2.5), P('mist', 'Mist', 0, 1, 0.35),
      P('cycles', 'Drift / loop', 0, 3, 1, { step: 1 }), P('tint', 'Cold tint', 0, 1, 0.4)],
    glsl: `void main() {
      vec2 cell = floor(gl_FragCoord.xy / max(1.0, p_scale * uScale));
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 6; i++) {
        vec2 h = hash22(cell + float(i) * 17.17) - 0.5;
        acc += texture(uSrc, mirrorUv(vUv + h * p_amount * 0.025 / vec2(aspect(), 1.0))).rgb;
      }
      vec3 c = acc / 6.0;
      float haze = p_mist * smoothstep(0.25, 0.85, loopFbm(toP(vUv) * 1.8 + vec2(2.0, 7.0), p_cycles));
      c = mix(c, toLin(vec3(0.78, 0.86, 0.95)) * (0.55 + 0.45 * luma(c)), haze * 0.75);
      outColor = vec4(mix(c, c * vec3(0.92, 0.98, 1.08), p_tint), 1.0);
    }`,
  },
  visualizer: {
    name: 'Audio Visualizer',
    cat: 'stylize',
    desc: 'A spectrum ring, EQ bars, a waveform or a horizon line that moves with the music',
    params: [
      OPT('mode', 'Style', ['Ring Spectrum', 'EQ Bars', 'Oscilloscope', 'Dual Horizon']),
      P('scale', 'Size', 0.15, 1.0, 0.48),
      P('glow', 'Glow', 0, 1.5, 0.65),
      P('hue', 'Tint hue', 0, 1, 0.56),
      P('mix', 'Overlay mix', 0, 1, 0.85),
    ],
    glsl: `float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453123); }
    vec3 tex(vec2 uv) { return texture(uSrc, uv).rgb; }
    void main() {
      float loopPhase = TAU * uTime / max(uLoop, 0.001);
      int m = int(p_mode + 0.5);
      vec3 visColor = vec3(0.0);

      if (m == 0) {
        // Mode 0: Circular Ring Spectrum around center
        vec2 p = toP(vUv);
        float r = length(p);
        float ang = atan(p.y, p.x);
        float normAng = abs(ang) / PI;

        float bassBand = (uKick * 0.8 + uBass * 0.7) * exp(-normAng * 3.5);
        float midBand = (uSnare * 0.8 + uEnergy * 0.6) * exp(-pow((normAng - 0.45) * 4.0, 2.0));
        float highBand = (uHats * 0.85 + uBright * 0.6) * exp(-pow((normAng - 0.85) * 4.5, 2.0));
        float audioVal = bassBand + midBand + highBand;

        float numBins = 48.0;
        float binId = floor(normAng * numBins);
        float binFrac = fract(normAng * numBins);
        float binWiggle = 0.85 + 0.15 * sin(loopPhase + binId * 0.4);
        float binMask = smoothstep(0.12, 0.22, binFrac) * (1.0 - smoothstep(0.78, 0.88, binFrac));

        float baseR = p_scale * 0.32;
        float maxH = p_scale * 0.32;
        float barH = max(0.005, audioVal * binWiggle * maxH);

        float barGlow = step(baseR, r) * step(r, baseR + barH) * binMask;
        float dCrest = abs(r - (baseR + barH));
        float crestLine = exp(-dCrest * dCrest / max(0.00003 * (1.0 + p_glow * 2.0), 1e-6));
        float dInner = abs(r - baseR);
        float innerRing = exp(-dInner * dInner / 0.00004);
        float outerGlow = exp(-max(0.0, r - (baseR + barH)) * (20.0 / max(0.5 + p_glow, 0.1))) * p_glow * 0.8;

        float ringIntensity = barGlow * 0.8 + crestLine * 1.5 + innerRing * 0.6 + outerGlow;
        vec3 tint = toLin(hsv2rgb(vec3(fract(p_hue + normAng * 0.35 + 0.04 * sin(loopPhase)), 0.75, 1.0)));
        visColor = tint * ringIntensity * (0.8 + p_glow * 0.6);
      } else if (m == 1) {
        // Mode 1: Bottom 24-bar EQ spectrum
        float marginX = 0.06;
        float normX = (vUv.x - marginX) / (1.0 - 2.0 * marginX);

        if (normX >= 0.0 && normX <= 1.0) {
          float barCount = 24.0;
          float barId = floor(normX * barCount);
          float barFrac = fract(normX * barCount);
          float normBar = barId / (barCount - 1.0);

          float bassW = exp(-normBar * 4.5);
          float midW = exp(-pow((normBar - 0.42) * 4.2, 2.0));
          float highW = exp(-pow((normBar - 0.88) * 4.0, 2.0));

          float audioVal = bassW * (uKick * 0.9 + uBass * 0.8)
                         + midW * (uSnare * 0.85 + uEnergy * 0.6)
                         + highW * (uHats * 0.9 + uBright * 0.7);

          float barAnim = 0.88 + 0.12 * sin(loopPhase * 2.0 + barId * 0.65);
          float maxBarH = p_scale * 0.65;
          float barH = clamp(audioVal * barAnim * maxBarH + 0.02 * p_scale, 0.015, maxBarH);

          float baseY = 0.05;
          float barMask = smoothstep(0.12, 0.22, barFrac) * (1.0 - smoothstep(0.78, 0.88, barFrac));
          float inBar = step(baseY, vUv.y) * step(vUv.y, baseY + barH) * barMask;
          float ledGrid = 0.82 + 0.18 * cos(vUv.y * 360.0);

          float dCap = abs(vUv.y - (baseY + barH));
          float capGlow = exp(-dCap * dCap / 0.00004) * barMask * 1.6;

          float dX = max(0.0, abs(barFrac - 0.5) - 0.33);
          float dY = max(0.0, vUv.y - (baseY + barH));
          float glowDist = length(vec2(dX, dY * 1.4));
          float ambientGlow = exp(-glowDist * 22.0) * p_glow * 0.7;

          float barIntensity = inBar * ledGrid + capGlow + ambientGlow;
          vec3 tint = toLin(hsv2rgb(vec3(fract(p_hue + normBar * 0.38 + 0.03 * sin(loopPhase)), 0.75, 1.0)));
          visColor = tint * barIntensity * (0.9 + p_glow * 0.5);
        }
      } else if (m == 2) {
        // Mode 2: Center oscilloscope waveform reacting to bass/kick/snare/hats
        float win = sin(clamp(vUv.x, 0.0, 1.0) * PI);
        win = pow(win, 0.5);

        float wBass = sin(vUv.x * TAU * 2.0 + loopPhase) * (uBass * 0.55 + uKick * 0.65);
        float wSnare = sin(vUv.x * TAU * 6.0 - loopPhase * 2.0) * (uSnare * 0.35);
        float wHats = sin(vUv.x * TAU * 14.0 + loopPhase * 3.0) * (uHats * 0.22);
        float wEnergy = sin(vUv.x * TAU * 28.0 + loopPhase) * (uEnergy * 0.12);

        float totalWave = (wBass + wSnare + wHats + wEnergy) * win * p_scale * 0.35;
        float waveY = 0.5 + totalWave;
        float d = abs(vUv.y - waveY);

        float core = exp(-d * d / 0.000035) * 2.0;
        float halo = exp(-d * d / max(0.0005 * (1.0 + p_glow * 2.5), 1e-5)) * (0.8 + p_glow * 0.8);
        float wideGlow = exp(-d * (16.0 / max(0.6 + p_glow, 0.1))) * p_glow * 0.45;

        float oscIntensity = (core + halo + wideGlow) * win;
        vec3 tint = toLin(hsv2rgb(vec3(fract(p_hue + abs(totalWave) * 0.6 + 0.05 * sin(loopPhase)), 0.75, 1.0)));
        visColor = tint * oscIntensity;
      } else {
        // Mode 3: Symmetric horizontal laser/horizon wave
        float dy = abs(vUv.y - 0.5);
        float win = sin(clamp(vUv.x, 0.0, 1.0) * PI);
        win = pow(win, 0.6);

        float baseOffset = p_scale * 0.18;
        float wLaser = (sin(vUv.x * TAU * 3.0 + loopPhase) * (uKick * 0.45 + uBass * 0.4)
                      + cos(vUv.x * TAU * 8.0 - loopPhase * 2.0) * (uSnare * 0.3 + uHats * 0.25)
                      + sin(vUv.x * TAU * 18.0 + loopPhase * 4.0) * (uBright * 0.15)) * win * p_scale * 0.14;

        float targetY = baseOffset + wLaser;
        float dWave = abs(dy - targetY);

        float laserCore = exp(-dWave * dWave / 0.00004) * 2.0;
        float laserHalo = exp(-dWave * dWave / max(0.0006 * (1.0 + p_glow * 2.0), 1e-5)) * (0.7 + p_glow * 0.8);
        float laserGlow = exp(-dWave * (18.0 / max(0.5 + p_glow, 0.1))) * p_glow * 0.5;

        float centerBeam = exp(-dy * dy / 0.00006) * (uEnergy * 0.7 + uKick * 0.5 + 0.3);
        float ribs = pow(max(0.0, cos(vUv.x * 40.0 * PI + loopPhase)), 6.0)
                   * step(dy, targetY) * (uBass * 0.35 + 0.1) * p_glow;

        float horizonIntensity = (laserCore + laserHalo + laserGlow + centerBeam * 0.8 + ribs) * win;
        vec3 tint = toLin(hsv2rgb(vec3(fract(p_hue + dy * 0.8 + 0.04 * sin(loopPhase)), 0.75, 1.0)));
        visColor = tint * horizonIntensity;
      }

      vec3 c = tex(vUv);
      vec3 screenCol = c + visColor - c * clamp(visColor, 0.0, 1.0);
      vec3 blended = mix(c + visColor, screenCol, 0.4);
      outColor = vec4(mix(c, blended, p_mix), 1.0);
    }`,
  },

  // Color
  gradient: {
    name: 'Gradient Map', cat: 'color', desc: 'Maps brightness onto a color palette',
    params: [OPT('palette', 'Palette', ['Thermal', 'Inferno', 'Acid', 'Vapor', 'Ocean', 'Gold', 'Holo', 'Noir']),
      P('contrast', 'Contrast', 0.5, 2.5, 1.15), P('mid', 'Midtones', 0.4, 3, 1.4), P('cycle', 'Cycle / loop', 0, 3, 0, { step: 1 }), MIX],
    glsl: RAMP + `void main() {
      vec3 src = texture(uSrc, vUv).rgb;
      float t = clamp((pow(luma(toSRGB(src)), 1.0 / p_mid) - 0.5) * p_contrast + 0.5, 0.0, 1.0);
      t = 1.0 - abs(1.0 - mod(t + 2.0 * p_cycle * uPhase, 2.0));
      int pal = int(p_palette + 0.5); vec3 c;
      if (pal == 0) c = ramp5(t, hx(16.), hx(4915330.), hx(14680138.), hx(16747520.), hx(16777120.));
      else if (pal == 1) c = ramp5(t, hx(4.), hx(4328040.), hx(9643623.), hx(14504250.), hx(16580516.));
      else if (pal == 2) c = ramp5(t, hx(720947.), hx(3604611.), hx(43115.), hx(13041408.), hx(16318437.));
      else if (pal == 3) c = ramp5(t, hx(2097231.), hx(8072383.), hx(16740277.), hx(16766629.), hx(10418431.));
      else if (pal == 4) c = ramp5(t, hx(2068.), hx(7485.), hx(683162.), hx(4770532.), hx(13299960.));
      else if (pal == 5) c = ramp5(t, hx(854534.), hx(4074000.), hx(10974506.), hx(15254126.), hx(16774874.));
      else if (pal == 6) c = cosPal(t * 1.2 + 0.1, vec3(0.55), vec3(0.45), vec3(1.0), vec3(0.0, 0.33, 0.67));
      else c = ramp5(t, hx(0.), hx(1185312.), hx(7039851.), hx(13619151.), hx(16777215.));
      outColor = vec4(mix(src, toLin(c), p_mix), 1.0);
    }`,
  },
  holo: {
    name: 'Holographic', cat: 'color', desc: 'Oil-slick iridescence across the highlights',
    params: [P('amount', 'Amount', 0, 1, 0.6), P('scale', 'Scale', 0.5, 6, 2), P('cycles', 'Shimmer / loop', 0, 3, 1, { step: 1 })],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb); float l = luma(s);
      float film = l * 1.6 + loopFbm(toP(vUv) * p_scale, p_cycles) * 1.2 + uPhase * p_cycles;
      vec3 irid = cosPal(film, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
      vec3 o = mix(s, s * 0.4 + irid * (0.3 + 0.7 * sqrt(l)), p_amount * smoothstep(0.0, 0.3, l));
      outColor = vec4(toLin(o), 1.0);
    }`,
  },
  chrome: {
    name: 'Liquid Chrome', cat: 'color', desc: 'Turns the image into polished, banded metal',
    params: [P('mix', 'Mix', 0, 1, 0.8), P('bands', 'Bands', 0.5, 6, 2.2), OPT('tint', 'Metal', ['Silver', 'Gold', 'Rose', 'Ice'])],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb); vec2 t = max(1.0, 2.0 * uScale) / uRes;
      float lx = luma(toSRGB(texture(uSrc, vUv + vec2(t.x, 0.0)).rgb)) - luma(toSRGB(texture(uSrc, vUv - vec2(t.x, 0.0)).rgb));
      float ly = luma(toSRGB(texture(uSrc, vUv + vec2(0.0, t.y)).rgb)) - luma(toSRGB(texture(uSrc, vUv - vec2(0.0, t.y)).rgb));
      vec3 n = normalize(vec3(-lx * 6.0, -ly * 6.0, 1.0)); float l = luma(s);
      float env = pow(max(0.0, 0.5 + 0.5 * cos((n.y * 0.5 + l * p_bands + 0.15 * sin(n.x * 6.0)) * TAU)), 1.5);
      int m = int(p_tint + 0.5);
      vec3 tint = m == 0 ? vec3(0.92, 0.95, 1.0) : m == 1 ? vec3(1.0, 0.8, 0.45) : m == 2 ? vec3(1.0, 0.72, 0.75) : vec3(0.7, 0.92, 1.0);
      vec3 metal = mix(vec3(0.03), tint, env) + pow(env, 12.0) * 0.8;
      outColor = vec4(toLin(mix(s, metal, p_mix)), 1.0);
    }`,
  },
  hue: {
    name: 'Hue Orbit', cat: 'color', desc: 'Cycles through the color wheel a whole number of times per loop',
    params: [P('cycles', 'Turns / loop', -3, 3, 1, { step: 1 }), P('sat', 'Saturation', 0, 2, 1.15)],
    glsl: `void main() {
      vec3 c = max(hueRotate(texture(uSrc, vUv).rgb, p_cycles * TAU * uPhase), 0.0);
      outColor = vec4(max(mix(vec3(luma(c)), c, p_sat), 0.0), 1.0);
    }`,
  },
  posterize: {
    name: 'Posterize', cat: 'color', desc: 'Flattens the picture into a few bands of tone',
    params: [P('levels', 'Levels', 2, 8, 4, { step: 1 }), P('sat', 'Saturation', 0, 2, 1.3), MIX],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb);
      vec3 q = floor(s * p_levels + 0.5) / p_levels;
      q = clamp(mix(vec3(luma(q)), q, p_sat), 0.0, 1.0);
      outColor = vec4(toLin(mix(s, q, p_mix)), 1.0);
    }`,
  },
  solarize: {
    name: 'Solarize', cat: 'color', desc: 'Highlights fold back into the darks, like overexposed darkroom film',
    params: [P('threshold', 'Threshold', 0.15, 0.85, 0.5), P('amount', 'Amount', 0, 1, 0.8), OPT('mode', 'Mode', ['Classic', 'Color', 'Neon'])],
    glsl: `vec3 tent(vec3 v, vec3 th) { return mix(v / th, (1.0 - v) / (1.0 - th), step(th, v)); }
    void main() {
      vec3 s = clamp(toSRGB(texture(uSrc, vUv).rgb), 0.0, 1.0);
      int m = int(p_mode + 0.5); vec3 o;
      if (m == 0) o = tent(s, vec3(p_threshold));
      else if (m == 1) o = tent(s, clamp(vec3(p_threshold - 0.12, p_threshold, p_threshold + 0.12), 0.08, 0.92));
      else {
        float l = max(luma(s), 1e-3);
        o = s * tent(vec3(l), vec3(p_threshold)).x / l;
        o = mix(vec3(luma(o)), o, 1.7);
      }
      outColor = vec4(toLin(mix(s, clamp(o, 0.0, 1.0), p_amount)), 1.0);
    }`,
  },
  acidsolar: {
    name: 'Acid Solarize', cat: 'color', desc: 'Tints the highlights pastel pink in a pulse on every bar. Unlike Solarize, it never inverts',
    params: [P('amount', 'Amount', 0, 1, 0.25), P('threshold', 'Threshold', 0, 0.9, 0.51),
      OPT('trigger', 'Trigger', ['Every bar', 'Every 2 beats', 'Every beat', 'Kick'])],
    glsl: `void main() {
      int tr = int(p_trigger + 0.5);
      float per = tr == 0 ? 4.0 : tr == 1 ? 2.0 : 1.0;
      float ph = fract(uBeat / per) * per;                   // beats since the last pulse
      float env = tr == 3 ? clamp(uKick, 0.0, 1.0) : smoothstep(0.0, 0.06, ph) * exp(-2.5 * ph);
      vec3 s = toSRGB(texture(uSrc, vUv).rgb);
      float m = clamp((dot(s, vec3(0.299, 0.587, 0.114)) - p_threshold) / 0.39, 0.0, 1.0);
      // lift red and blue and trim green, a pink that stays light; HDR highlights keep their level
      vec3 tint = min(s * vec3(1.10, 0.96, 1.12) + vec3(0.063, 0.0, 0.047), max(s, 1.0));
      outColor = vec4(toLin(mix(s, tint, m * p_amount * env)), 1.0);
    }`,
  },
  filmstock: {
    name: 'Film Stock', cat: 'color', desc: 'Film-lab color looks: bleach bypass, cyberpunk, golden hour, sepia noir and more',
    params: [OPT('mode', 'Stock', ['Bleach Bypass', 'Cyberpunk', 'Golden Hour', 'Sepia Noir', 'Cross Process', 'Teal & Orange']),
      P('strength', 'Strength', 0, 1, 0.8)],
    glsl: `void main() {
      vec3 s = clamp(toSRGB(texture(uSrc, vUv).rgb), 0.0, 1.0);
      float l = luma(s); int m = int(p_mode + 0.5); vec3 o;
      if (m == 0) {
        vec3 ov = mix(2.0 * s * l, 1.0 - 2.0 * (1.0 - s) * (1.0 - l), step(0.5, l));
        o = mix(vec3(l), ov, 0.45); o = (o - 0.5) * 1.15 + 0.5;
      } else if (m == 1) {
        o = mix(s * vec3(0.72, 0.92, 1.3), s * vec3(1.25, 0.78, 1.15), smoothstep(0.15, 0.75, l));
        o = mix(vec3(luma(o)), o, 1.3);
      } else if (m == 2) {
        o = s * vec3(1.12, 1.0, 0.78) + vec3(0.05, 0.025, -0.01) * (1.0 - l);
        o = mix(vec3(luma(o)), o, 1.1);
      } else if (m == 3) {
        float n = smoothstep(0.04, 0.96, pow(l, 1.15));
        o = n * vec3(1.07, 0.94, 0.76);
      } else if (m == 4) {
        o = vec3(smoothstep(0.05, 0.95, s.r), pow(s.g, 0.9), mix(0.14, 0.86, s.b));
        o = mix(vec3(luma(o)), o, 1.2);
      } else {
        o = mix(s * vec3(0.8, 1.02, 1.12), s * vec3(1.15, 0.98, 0.8), smoothstep(0.2, 0.8, l));
        o = mix(vec3(luma(o)), o, 1.15);
      }
      outColor = vec4(toLin(mix(s, clamp(o, 0.0, 1.0), p_strength)), 1.0);
    }`,
  },
};

// Pseudo-modules that are always present: the per-clip camera and the final grade.
export const CAMERA: { name: string; params: ParamDef[] } = {
  name: 'Camera', params: [P('zoom', 'Zoom', 1, 1.8, 1.06), P('drift', 'Drift', 0, 1, 0.35), P('shake', 'Shake', 0, 1, 0),
    P('sway', 'Sway', 0, 1, 0), P('speed', 'Clip speed', 0.25, 2, 1, { retime: true })],
};
export const FINISH_DEF: { name: string; params: ParamDef[] } = {
  name: 'Finish', params: [P('exposure', 'Exposure', -2, 2, 0), P('contrast', 'Contrast', 0.6, 1.7, 1.1), P('saturation', 'Saturation', 0, 2, 1.05),
    P('temp', 'Temperature', -1, 1, 0), P('tint', 'Tint', -1, 1, 0), P('split', 'Split tone', 0, 1, 0.2), P('splitHue', 'Split hue', 0, 1, 0.55),
    P('fade', 'Fade', 0, 0.3, 0.02), P('halation', 'Halation', 0, 1, 0), P('vignette', 'Vignette', 0, 1, 0.35), P('grain', 'Grain', 0, 1, 0.25),
    P('bars', 'Cinema bars', 0, 0.25, 0)],
};

export function moduleSource(id: string): string | null {
  const m = MODULES[id];
  if (!m || !m.glsl) return null;
  const uniforms = m.params.map((p) => `uniform float p_${p.id};`).join('\n');
  return `${PRELUDE}\n${uniforms}\n${m.glsl}`;
}

export const buildStageSource = moduleSource;

export function defaults(params: ParamDef[]): Record<string, number> {
  return Object.fromEntries(params.map((p) => [p.id, p.def]));
}

// Modulation sources (all 0..1). Audio bands come from the server analysis; clocks are locked to
// the loop (whole cycles per loop, so they never jump at the seam); 'user' sources are set per look.
export const MOD_SOURCES: Record<string, ModSourceMeta> = {
  kick: { name: 'Kick', color: '#FF5A6E', kind: 'audio' },
  snare: { name: 'Snare', color: '#FFB547', kind: 'audio' },
  hats: { name: 'Hats', color: '#5AD8FF', kind: 'audio' },
  bass: { name: 'Bass', color: '#A07BFF', kind: 'audio' },
  energy: { name: 'Energy', color: '#7CFF9B', kind: 'audio' },
  bright: { name: 'Brightness', color: '#FFF07A', kind: 'audio' },
  vocals: { name: 'Vocals', short: 'VOC', color: '#FF94D2', kind: 'audio' },
  presence: { name: 'Presence', short: 'PRS', color: '#80FFE5', kind: 'audio' },
  beat: { name: 'Beat pulse', color: '#FF7AE6', kind: 'clock' },
  off: { name: 'Off-beat pulse', color: '#FF9FB7', kind: 'clock' },
  bar: { name: 'Bar ramp', color: '#FF9DF0', kind: 'clock' },
  lfoH: { name: 'LFO · ½ bar', color: '#B79CFF', kind: 'clock' },
  lfo: { name: 'LFO · 1 bar', color: '#C2A6FF', kind: 'clock' },
  lfo2: { name: 'LFO · 2 bars', color: '#CDB8FF', kind: 'clock' },
  tri: { name: 'Triangle · 1 bar', color: '#9FC6FF', kind: 'clock' },
  arc: { name: 'Loop arc', color: '#8FF0D2', kind: 'clock' },
  build: { name: 'Loop build', color: '#6FE3B5', kind: 'clock' },
  rand: { name: 'Random · beat', color: '#C9CED6', kind: 'clock' },
  lfoA: { name: 'LFO A', color: '#8FA2FF', kind: 'user' },
  lfoB: { name: 'LFO B', color: '#E08CFF', kind: 'user' },
  seq: { name: 'Step sequencer', color: '#FFD36E', kind: 'user' },
  env: { name: 'Drawn envelope', color: '#FFA36E', kind: 'user' },
  macroA: { name: 'Macro A', color: '#C8FF4D', kind: 'user' },
  macroB: { name: 'Macro B', color: '#4DFFC8', kind: 'user' },
};
