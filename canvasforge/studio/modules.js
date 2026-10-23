// Canvas Forge GPU module library. Each module is one fragment pass (or a small custom chain).
// Params become `uniform float p_<id>`; every animated term is periodic over the loop so
// exports are seamless by construction. Pixel sizes scale with uScale (= height / 1920).
import { PRELUDE } from './shaders.js';

const P = (id, name, min, max, def, extra = {}) => ({ id, name, min, max, def, step: extra.step ?? (max - min) / 200, ...extra });
const OPT = (id, name, opts, def = 0) => ({ id, name, min: 0, max: opts.length - 1, def, step: 1, opts });
const MIX = P('mix', 'Mix', 0, 1, 1);

export const CATEGORIES = {
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

export const MODULES = {
  // ------------------------------------------------------------------ SPACE
  kaleido: {
    name: 'Kaleidoscope', cat: 'space', desc: 'Polar mirror folds that spin on the loop',
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
    name: 'Mirror', cat: 'space', desc: 'Bilateral, quad or horizon symmetry',
    params: [OPT('mode', 'Mode', ['Split', 'Quad', 'Horizon']), P('shift', 'Axis', -0.3, 0.3, 0), MIX],
    glsl: `void main() {
      vec2 uv = vUv; vec2 c = vec2(0.5 + p_shift, 0.5); int m = int(p_mode + 0.5);
      if (m != 2) uv.x = c.x - abs(uv.x - c.x);
      if (m != 0) uv.y = c.y + abs(uv.y - c.y);
      outColor = vec4(mix(texture(uSrc, vUv).rgb, texture(uSrc, mirrorUv(uv)).rgb, p_mix), 1.0);
    }`,
  },
  tunnel: {
    name: 'Infinite Tunnel', cat: 'space', desc: 'Log-polar tunnel flying forward on the loop',
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
  tile: {
    name: 'Clone Grid', cat: 'space', desc: 'Mirrored video wall with rows sliding on the beat',
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
    name: 'Fisheye', cat: 'space', desc: 'Barrel lens with spectral edge fringing',
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

  // ------------------------------------------------------------------ WARP
  liquid: {
    name: 'Liquid Flow', cat: 'warp', desc: 'Domain-warped noise currents (seamless)',
    params: [P('amount', 'Amount', 0, 1, 0.35), P('scale', 'Scale', 0.5, 6, 2), P('cycles', 'Flow / loop', 0, 4, 1, { step: 1 })],
    glsl: `void main() {
      vec2 p = toP(vUv) * p_scale;
      vec2 w = vec2(loopFbm(p, p_cycles), loopFbm(p + vec2(5.2, 1.3), p_cycles)) - 0.5;
      vec2 w2 = vec2(loopFbm(p + 3.0 * w + vec2(1.7, 9.2), p_cycles), loopFbm(p + 3.0 * w + vec2(8.3, 2.8), p_cycles)) - 0.5;
      outColor = vec4(texture(uSrc, mirrorUv(vUv + w2 * p_amount * 0.18)).rgb, 1.0);
    }`,
  },
  glass: {
    name: 'Liquid Glass', cat: 'warp', desc: 'Refractive glass with dispersion and specular light',
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
    name: 'Shockwave', cat: 'warp', desc: 'Refractive rings emitted on the beat',
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
    name: 'Vortex', cat: 'warp', desc: 'Center twist — great on the kick',
    params: [P('twist', 'Twist', -1, 1, 0.4), P('radius', 'Radius', 0.2, 1.2, 0.7), P('spin', 'Spin / loop', -2, 2, 0, { step: 1 })],
    glsl: `void main() {
      vec2 q = toP(vUv); float f = 1.0 - smoothstep(0.0, p_radius, length(q));
      float a = p_twist * 4.0 * f * f + p_spin * TAU * uPhase * f;
      outColor = vec4(texture(uSrc, mirrorUv(toUv(rot(a) * q))).rgb, 1.0);
    }`,
  },
  zoomblur: {
    name: 'Zoom Blur', cat: 'warp', desc: 'Radial motion blur — punchy on kicks',
    params: [P('amount', 'Amount', 0, 1, 0.25)],
    glsl: `void main() {
      vec2 q = vUv - 0.5; vec3 s = vec3(0.0);
      for (int i = 0; i < 14; i++) s += texture(uSrc, 0.5 + q * (1.0 - p_amount * 0.14 * float(i) / 13.0)).rgb;
      outColor = vec4(s / 14.0, 1.0);
    }`,
  },

  // ------------------------------------------------------------------ TIME (feedback)
  trails: {
    name: 'Feedback Trails', cat: 'time', desc: 'Milkdrop-style infinite echo with zoom, spin and hue drift', feedback: true,
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
    name: 'Chroma Echo', cat: 'time', desc: 'Green and blue lag behind red — prismatic motion trails', feedback: true,
    params: [P('amount', 'Lag', 0, 0.97, 0.75), P('drift', 'Drift', 0, 1, 0.2)],
    glsl: `uniform sampler2D uPrev; void main() {
      vec3 cur = texture(uSrc, vUv).rgb;
      vec3 prev = texture(uPrev, toUv(toP(vUv) / (1.0 + p_drift * 0.02))).rgb;
      outColor = vec4(cur.r, mix(cur.g, prev.g, p_amount * 0.85), mix(cur.b, prev.b, p_amount), 1.0);
    }`,
  },

  // ------------------------------------------------------------------ LIGHT (multi-pass chains in engine.js)
  bloom: {
    name: 'Bloom', cat: 'light', desc: 'HDR dual-filter bloom', kind: 'bloom',
    params: [P('threshold', 'Threshold', 0, 2, 0.7), P('intensity', 'Intensity', 0, 3, 0.8), P('radius', 'Radius', 0, 1, 0.7),
      P('warmth', 'Warmth', -1, 1, 0)],
  },
  streaks: {
    name: 'Anamorphic Flare', cat: 'light', desc: 'Horizontal lens streaks from highlights', kind: 'streaks',
    params: [P('threshold', 'Threshold', 0, 2, 0.9), P('intensity', 'Intensity', 0, 3, 1), P('length', 'Length', 0, 1, 0.6),
      P('hue', 'Hue', 0, 1, 0.56)],
  },
  rays: {
    name: 'God Rays', cat: 'light', desc: 'Volumetric light shafts from bright areas', kind: 'rays',
    params: [P('threshold', 'Threshold', 0, 2, 0.6), P('intensity', 'Intensity', 0, 3, 0.8), P('length', 'Length', 0, 1, 0.6),
      P('height', 'Source height', 0, 1, 0.78)],
  },
  chroma: {
    name: 'Spectral Aberration', cat: 'light', desc: '9-wavelength chromatic dispersion',
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

  // ------------------------------------------------------------------ STYLIZE
  dither: {
    name: '1-Bit Dither', cat: 'stylize', desc: 'Ordered 8×8 Bayer dither through a curated palette',
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
    name: 'Pixel Sort', cat: 'stylize', desc: 'Bright runs melt into sorted streaks',
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
    name: 'Glyph Matrix', cat: 'stylize', desc: 'Luminance rendered as type — ASCII ramp or matrix glyphs', aux: 'glyphs',
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
    name: 'Data Glitch', cat: 'stylize', desc: 'Block tears and RGB splits that re-roll every 16th note',
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
    name: 'Neon Contours', cat: 'stylize', desc: 'Sobel edges glowing in rainbow, source or white',
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

  // ------------------------------------------------------------------ COLOR
  gradient: {
    name: 'Gradient Map', cat: 'color', desc: 'Luminance mapped through a designed palette',
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
    name: 'Holographic', cat: 'color', desc: 'Thin-film iridescence that shimmers across highlights',
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
    name: 'Hue Orbit', cat: 'color', desc: 'Full hue rotations per loop, plus saturation',
    params: [P('cycles', 'Turns / loop', -3, 3, 1, { step: 1 }), P('sat', 'Saturation', 0, 2, 1.15)],
    glsl: `void main() {
      vec3 c = max(hueRotate(texture(uSrc, vUv).rgb, p_cycles * TAU * uPhase), 0.0);
      outColor = vec4(max(mix(vec3(luma(c)), c, p_sat), 0.0), 1.0);
    }`,
  },
  posterize: {
    name: 'Posterize', cat: 'color', desc: 'Silkscreen tone bands with a saturation kick',
    params: [P('levels', 'Levels', 2, 8, 4, { step: 1 }), P('sat', 'Saturation', 0, 2, 1.3), MIX],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb);
      vec3 q = floor(s * p_levels + 0.5) / p_levels;
      q = clamp(mix(vec3(luma(q)), q, p_sat), 0.0, 1.0);
      outColor = vec4(toLin(mix(s, q, p_mix)), 1.0);
    }`,
  },
};

// Pseudo-modules that are always present: the per-clip camera and the final grade.
export const CAMERA = {
  name: 'Camera', params: [P('zoom', 'Zoom', 1, 1.8, 1.06), P('drift', 'Drift', 0, 1, 0.35), P('shake', 'Shake', 0, 1, 0),
    P('sway', 'Sway', 0, 1, 0), P('speed', 'Clip speed', 0.25, 2, 1)],
};
export const FINISH_DEF = {
  name: 'Finish', params: [P('exposure', 'Exposure', -2, 2, 0), P('contrast', 'Contrast', 0.6, 1.7, 1.1), P('saturation', 'Saturation', 0, 2, 1.05),
    P('temp', 'Temperature', -1, 1, 0), P('tint', 'Tint', -1, 1, 0), P('split', 'Split tone', 0, 1, 0.2), P('splitHue', 'Split hue', 0, 1, 0.55),
    P('fade', 'Fade', 0, 0.3, 0.02), P('halation', 'Halation', 0, 1, 0), P('vignette', 'Vignette', 0, 1, 0.35), P('grain', 'Grain', 0, 1, 0.25),
    P('bars', 'Cinema bars', 0, 0.25, 0)],
};

export function moduleSource(id) {
  const m = MODULES[id];
  if (!m || !m.glsl) return null;
  const uniforms = m.params.map((p) => `uniform float p_${p.id};`).join('\n');
  return `${PRELUDE}\n${uniforms}\n${m.glsl}`;
}

export function defaults(params) {
  return Object.fromEntries(params.map((p) => [p.id, p.def]));
}

// Modulation sources (all 0..1). Audio bands come from the server analysis; the rest are clocks.
export const MOD_SOURCES = {
  kick: { name: 'Kick', color: '#FF5A6E' },
  snare: { name: 'Snare', color: '#FFB547' },
  hats: { name: 'Hats', color: '#5AD8FF' },
  bass: { name: 'Bass', color: '#A07BFF' },
  energy: { name: 'Energy', color: '#7CFF9B' },
  bright: { name: 'Brightness', color: '#FFF07A' },
  beat: { name: 'Beat pulse', color: '#FF7AE6' },
  bar: { name: 'Bar ramp', color: '#FF9DF0' },
  lfo: { name: 'LFO · 1 bar', color: '#C2A6FF' },
  rand: { name: 'Random · beat', color: '#C9CED6' },
};
