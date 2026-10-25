// Photographic, optical and drawn filters. All passes receive linear light and return linear light.
// Color/ink calculations use sRGB explicitly; animation uses whole cycles over uPhase, never wall time.
import type { ModuleDef, ParamDef } from './types.ts';

const P = (id: string, name: string, min: number, max: number, def: number, step = (max - min) / 200): ParamDef => ({ id, name, min, max, def, step });
const OPT = (id: string, name: string, opts: string[], def = 0): ParamDef => ({ id, name, opts, min: 0, max: opts.length - 1, def, step: 1 });
const MIX = P('mix', 'Mix', 0, 1, 1);

export const FILTER_MODULES: Record<string, ModuleDef> = {
  editorial: {
    name: 'Editorial Color', cat: 'color', styles: ['natural', 'soft', 'light'],
    desc: 'Neutral documentary, warm skin, cool editorial or pastel color without distortion or beat pulses',
    params: [OPT('mode', 'Grade', ['Neutral', 'Warm Skin', 'Cool Editorial', 'Pastel']), P('strength', 'Strength', 0, 1, 0.7), P('matte', 'Matte blacks', 0, 0.15, 0)],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb), o = s;
      float y = luma(s); int mode = int(p_mode + 0.5);
      float skin = smoothstep(0.0, 0.10, s.r - s.b) * smoothstep(-0.02, 0.10, s.g - s.b);
      if (mode == 0) o = mix(s, s * s * (3.0 - 2.0 * s), 0.10);
      if (mode == 1) o = s * vec3(1.035, 1.005, 0.955) + vec3(0.012, 0.004, 0.0) * (1.0 - y);
      if (mode == 2) {
        o = s * mix(vec3(0.94, 1.01, 1.05), vec3(1.015, 1.0, 0.98), smoothstep(0.15, 0.8, y));
        o = mix(o, s, skin * 0.75);
        o = mix(vec3(luma(o)), o, 0.9);
      }
      if (mode == 3) o = mix(vec3(y), s, 0.82) * 0.94 + vec3(0.045, 0.038, 0.035);
      o = o * (1.0 - p_matte) + p_matte;
      outColor = vec4(toLin(max(mix(s, o, p_strength), 0.0)), 1.0);
    }`,
  },
  monochrome: {
    name: 'Monochrome Print', cat: 'color', styles: ['monochrome'],
    desc: 'Continuous-tone silver, matte, noir and selenium prints with a red/blue tonal filter',
    params: [OPT('mode', 'Print', ['Silver', 'Matte', 'Noir', 'Selenium']), P('filter', 'Red / blue filter', -1, 1, 0), P('contrast', 'Contrast', 0.6, 1.8, 1.1), MIX],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb);
      vec3 weights = vec3(0.299, 0.587, 0.114) + p_filter * vec3(0.16, -0.05, -0.11);
      float y = clamp(dot(s, weights), 0.0, 1.0); int mode = int(p_mode + 0.5);
      y = clamp((y - 0.5) * p_contrast + 0.5, 0.0, 1.0);
      if (mode == 1) y = 0.065 + 0.88 * pow(y, 0.94);
      if (mode == 2) y = smoothstep(0.10, 0.90, y);
      vec3 o = vec3(y);
      if (mode == 3) o *= mix(vec3(0.94, 0.92, 1.03), vec3(1.02, 1.0, 0.98), y);
      outColor = vec4(toLin(mix(s, o, p_mix)), 1.0);
    }`,
  },
  photoprint: {
    name: 'Photographic Print', cat: 'color', styles: ['film'],
    desc: 'Creative 16mm, 35mm, faded print, expired film and disposable-flash color treatments',
    params: [OPT('mode', 'Process', ['16mm Daylight', '35mm Cinema', 'Faded Print', 'Expired Film', 'Disposable Flash']), P('strength', 'Strength', 0, 1, 0.8)],
    glsl: `void main() {
      vec3 s = clamp(toSRGB(texture(uSrc, vUv).rgb), 0.0, 1.0), o = s;
      float y = luma(s); int mode = int(p_mode + 0.5);
      if (mode == 0) {
        o = mix(s, smoothstep(vec3(-0.04), vec3(1.08), s), 0.55) * vec3(1.025, 1.01, 0.94);
        o = mix(vec3(luma(o)), o, 0.91);
      } else if (mode == 1) {
        o = mix(s * vec3(0.97, 1.015, 1.025), s * vec3(1.035, 1.005, 0.955), smoothstep(0.12, 0.85, y));
        o = mix(o, o * o * (3.0 - 2.0 * o), 0.22);
      } else if (mode == 2) {
        o = mix(vec3(y), s, 0.76) * 0.84 + vec3(0.095, 0.075, 0.063);
      } else if (mode == 3) {
        o = mix(s * vec3(1.04, 1.025, 0.91), s * vec3(1.075, 0.98, 0.95), smoothstep(0.2, 0.8, y));
        o += vec3(0.018, 0.028, 0.005) * (1.0 - y);
      } else {
        float center = 1.0 - smoothstep(0.15, 0.85, length(toP(vUv)));
        o = clamp((s - 0.06) * 1.16, 0.0, 1.0) * vec3(1.025, 1.01, 0.94);
        o += (1.0 - o) * center * 0.10;
        o *= 0.84 + 0.16 * center;
      }
      outColor = vec4(toLin(max(mix(s, o, p_strength), 0.0)), 1.0);
    }`,
  },
  filmtexture: {
    name: 'Film Dust & Scratches', cat: 'stylize', styles: ['film', 'monochrome'],
    desc: 'Fine dust, intermittent vertical scratches and restrained exposure breathing; repeats with the loop',
    params: [P('dust', 'Dust', 0, 1, 0.25), P('scratches', 'Scratches', 0, 1, 0.15), P('size', 'Dust size', 0.5, 3, 1), P('breath', 'Exposure breath', 0, 1, 0.08)],
    glsl: `void main() {
      vec3 c = texture(uSrc, vUv).rgb;
      vec2 grid = vUv * vec2(aspect(), 1.0) * 95.0 / p_size;
      vec2 cell = floor(grid); vec2 center = hash22(cell + uSeed * 0.01);
      float life = pow(max(0.0, sin(TAU * (uPhase + hash12(cell + 31.0)))), 6.0);
      float dotMask = 1.0 - smoothstep(0.035, 0.10, length(fract(grid) - center));
      float dust = dotMask * step(1.0 - p_dust * 0.18, hash12(cell + 11.0)) * life * step(0.001, p_dust);
      float x = vUv.x * 37.0;
      float scratchLife = pow(max(0.0, sin(TAU * (uPhase + hash12(vec2(floor(x), 8.0))))), 12.0);
      float line = 1.0 - smoothstep(0.008, 0.03, abs(fract(x) - 0.5));
      float scratch = line * step(1.0 - p_scratches * 0.16, hash12(vec2(floor(x), 13.0))) * scratchLife;
      scratch *= smoothstep(0.35, 0.65, loopNoise(vec2(floor(x), vUv.y * 5.0), 1.0));
      c *= (1.0 - dust * 0.55) * (1.0 + sin(TAU * uPhase) * p_breath * 0.025);
      c += scratch * p_scratches * 0.18;
      outColor = vec4(max(c, 0.0), 1.0);
    }`,
  },
  gateweave: {
    name: 'Film Gate Weave', cat: 'space', styles: ['film'],
    desc: 'Tiny mechanical frame movement and film breathing with no beat-driven zoom',
    params: [P('amount', 'Frame movement', 0, 1, 0.2), P('rotation', 'Gate rotation', 0, 1, 0.15), P('breath', 'Exposure breath', 0, 1, 0.1), P('cycles', 'Cycles / loop', 0, 4, 1, 1)],
    glsl: `void main() {
      float a = TAU * uPhase * p_cycles;
      vec2 off = vec2(sin(a) + 0.32 * sin(a * 3.0), cos(a * 2.0) + 0.25 * sin(a * 5.0)) * p_amount * 0.002;
      vec2 uv = toUv(rot(sin(a * 2.0) * p_rotation * p_amount * 0.003) * toP(vUv)) + off;
      vec3 c = texture(uSrc, mirrorUv(uv)).rgb * (1.0 + p_breath * sin(a * 3.0) * 0.025);
      outColor = vec4(c, 1.0);
    }`,
  },
  diffusion: {
    name: 'Optical Diffusion', cat: 'light', styles: ['natural', 'film', 'soft', 'light'],
    desc: 'Black mist, portrait softness or pearlescent glow; static unless you add animation',
    params: [OPT('mode', 'Diffusion', ['Black Mist', 'Soft Portrait', 'Pearl']), P('amount', 'Strength', 0, 1, 0.3), P('radius', 'Spread', 2, 32, 14), P('threshold', 'Highlight threshold', 0.2, 1, 0.6), P('warmth', 'Warmth', -1, 1, 0)],
    glsl: `void main() {
      vec3 src = texture(uSrc, vUv).rgb, soft = vec3(0.0), glow = vec3(0.0);
      vec2 rad = vec2(p_radius * uScale) / uRes;
      float threshold = toLin(vec3(p_threshold)).r;
      for (int i = 0; i < 24; i++) {
        float a = float(i) * 2.39996323;
        vec2 off = vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 24.0) * rad;
        vec3 sampleColor = texture(uSrc, mirrorUv(vUv + off)).rgb;
        soft += sampleColor; glow += max(sampleColor - threshold, 0.0);
      }
      soft /= 24.0; glow /= 24.0;
      vec3 tint = vec3(1.0 + p_warmth * 0.12, 1.0, 1.0 - p_warmth * 0.12);
      vec3 c = src + glow * tint * p_amount * 0.7;
      if (p_mode > 0.5 && p_mode < 1.5) c = mix(c, soft + glow * tint * 0.35, p_amount * 0.3);
      if (p_mode > 1.5) c = mix(c, soft * 0.92 + vec3(0.035) + glow * tint * 0.4, p_amount * 0.3);
      outColor = vec4(max(c, 0.0), 1.0);
    }`,
  },
  defocus: {
    name: 'Selective Defocus', cat: 'light', styles: ['soft'],
    desc: 'Soft focus or highlight-weighted bokeh around a sharp spot or band, with optional slow focus breathing',
    params: [OPT('mode', 'Focus shape', ['Spot', 'Band', 'Full frame']), P('amount', 'Strength', 0, 1, 0.6), P('radius', 'Blur radius', 2, 40, 22), P('x', 'Focus X', 0, 1, 0.5), P('y', 'Focus Y', 0, 1, 0.5), P('width', 'Sharp area', 0.05, 0.9, 0.3), P('bokeh', 'Highlight bokeh', 0, 1, 0.4), P('breathe', 'Focus breathing', 0, 1, 0)],
    glsl: `void main() {
      vec3 src = texture(uSrc, vUv).rgb, acc = vec3(0.0); float total = 0.0;
      vec2 q = (vUv - vec2(p_x, p_y)) * vec2(aspect(), 1.0);
      float dist = p_mode < 0.5 ? length(q) : abs(q.y);
      float mask = p_mode > 1.5 ? 1.0 : smoothstep(p_width * 0.5, p_width * 0.5 + 0.22, dist);
      float radius = p_radius * (1.0 + p_breathe * sin(TAU * uPhase) * 0.25) * mask;
      for (int i = 0; i < 32; i++) {
        float a = float(i) * 2.39996323;
        vec2 off = vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 32.0) * radius * uScale / uRes;
        vec3 c = texture(uSrc, mirrorUv(vUv + off)).rgb;
        float w = 1.0 + p_bokeh * min(luma(c), 4.0) * 3.0;
        acc += c * w; total += w;
      }
      outColor = vec4(mix(src, acc / total, p_amount * mask), 1.0);
    }`,
  },
  gobo: {
    name: 'Window & Leaf Shadows', cat: 'light', styles: ['light'],
    desc: 'Projected window panes, Venetian blinds or dappled leaf shadows with optional slow movement',
    params: [OPT('mode', 'Pattern', ['Window', 'Blinds', 'Leaves']), P('amount', 'Shadow depth', 0, 1, 0.35), P('scale', 'Pattern scale', 0.5, 4, 1), P('angle', 'Angle', -180, 180, -18), P('softness', 'Softness', 0.01, 0.3, 0.08), P('drift', 'Movement', 0, 1, 0.12)],
    glsl: `void main() {
      vec2 q = rot(p_angle * PI / 180.0) * toP(vUv) * p_scale;
      q += vec2(sin(TAU * uPhase), cos(TAU * uPhase)) * p_drift * 0.12;
      float lightMask;
      if (p_mode < 0.5) {
        float box = (1.0 - smoothstep(0.32, 0.32 + p_softness, abs(q.x))) * (1.0 - smoothstep(0.38, 0.38 + p_softness, abs(q.y)));
        float panes = smoothstep(0.012, 0.012 + p_softness * 0.3, abs(q.x)) * smoothstep(0.012, 0.012 + p_softness * 0.3, abs(q.y));
        lightMask = box * panes;
      } else if (p_mode < 1.5) lightMask = smoothstep(-p_softness * 4.0, p_softness * 4.0, sin(q.y * 48.0));
      else lightMask = smoothstep(0.43 - p_softness, 0.53 + p_softness, fbm3(vec3(q * 7.0, 2.0)));
      vec3 c = texture(uSrc, vUv).rgb * (1.0 - p_amount * (1.0 - lightMask));
      outColor = vec4(c, 1.0);
    }`,
  },
  gel: {
    name: 'Color Gel Lighting', cat: 'light', styles: ['light'],
    desc: 'A restrained color wash, side light, split gel or soft spotlight over the original image',
    params: [OPT('mode', 'Lighting', ['Wash', 'Side Light', 'Split Gel', 'Spotlight'], 1), P('hue', 'Gel hue', 0, 1, 0.09), P('saturation', 'Gel color', 0, 1, 0.35), P('amount', 'Strength', 0, 1, 0.25), P('position', 'Light position', 0, 1, 0.4), P('spread', 'Spread', 0.1, 1, 0.6)],
    glsl: `void main() {
      vec3 src = texture(uSrc, vUv).rgb;
      vec3 tint = hsv2rgb(vec3(p_hue, p_saturation, 1.0));
      float mask = 1.0;
      if (p_mode > 0.5 && p_mode < 2.5) mask = smoothstep(p_position - p_spread, p_position + p_spread, vUv.x);
      if (p_mode > 2.5) mask = 1.0 - smoothstep(0.0, p_spread, length((vUv - vec2(p_position, 0.55)) * vec2(aspect(), 1.0)));
      vec3 c = src * mix(vec3(1.0), tint * 1.12, p_amount * mask);
      if (p_mode > 1.5 && p_mode < 2.5) c *= mix(vec3(1.0), hsv2rgb(vec3(fract(p_hue + 0.5), p_saturation, 1.0)) * 1.12, p_amount * (1.0 - mask));
      outColor = vec4(max(c, 0.0), 1.0);
    }`,
  },
  paper: {
    name: 'Paper Texture', cat: 'stylize', styles: ['illustrated', 'film', 'monochrome'],
    desc: 'Still paper tooth, fine fibers and an optional warm or cool print base',
    params: [P('amount', 'Texture', 0, 1, 0.35), P('scale', 'Paper tooth', 0.5, 4, 1), P('fibers', 'Fibers', 0, 1, 0.4), P('warmth', 'Paper warmth', -1, 1, 0.2)],
    glsl: `void main() {
      vec3 s = toSRGB(texture(uSrc, vUv).rgb);
      vec2 px = gl_FragCoord.xy / max(uScale, 0.01) / p_scale;
      float tooth = hash12(floor(px)) - 0.5;
      float fiber = noise3(vec3(px * vec2(0.025, 0.35), 3.0)) - 0.5;
      vec3 tint = vec3(1.0 + p_warmth * p_amount * 0.025, 1.0, 1.0 - p_warmth * p_amount * 0.055);
      vec3 o = s * tint * (1.0 + (tooth * 0.10 + fiber * p_fibers * 0.12) * p_amount);
      outColor = vec4(toLin(max(o, 0.0)), 1.0);
    }`,
  },
  sketch: {
    name: 'Pencil, Charcoal & Ink', cat: 'stylize', styles: ['illustrated'],
    desc: 'Tonal pencil hatching, soft charcoal or ink wash on a paper-colored base',
    params: [OPT('mode', 'Medium', ['Pencil', 'Charcoal', 'Ink Wash']), P('detail', 'Detail', 0, 1, 0.55), P('width', 'Stroke width', 0.5, 3, 1), P('paper', 'Warm paper', 0, 1, 0.2), MIX],
    glsl: `float tone(vec2 uv) { return luma(toSRGB(texture(uSrc, mirrorUv(uv)).rgb)); }
    void main() {
      vec3 src = toSRGB(texture(uSrc, vUv).rgb);
      vec2 px = p_width * uScale / uRes; float y = luma(src);
      float n = tone(vUv + vec2(0, px.y)), s = tone(vUv - vec2(0, px.y));
      float e = tone(vUv + vec2(px.x, 0)), w = tone(vUv - vec2(px.x, 0));
      float edge = length(vec2(e - w, n - s));
      vec2 ref = gl_FragCoord.xy / max(uScale, 0.01) / p_width;
      float hatch = smoothstep(0.25, 0.8, sin((ref.x + ref.y) * 1.1)) * (1.0 - smoothstep(0.15, 0.8, y));
      float crossHatch = smoothstep(0.45, 0.85, sin((ref.x - ref.y) * 0.9)) * (1.0 - smoothstep(0.05, 0.4, y));
      float value = 1.0 - (1.0 - y) * 0.48 - edge * (0.7 + p_detail * 1.5) - (hatch + crossHatch) * 0.23;
      if (p_mode > 0.5 && p_mode < 1.5) {
        float tooth = hash12(floor(ref * 0.7));
        value = (y + n + s + e + w) / 5.0 - edge * 0.65 - (1.0 - y) * tooth * 0.3;
      }
      if (p_mode > 1.5) value = floor(y * 5.0 + 0.5) / 5.0 - smoothstep(0.06, 0.22, edge) * (0.55 + p_detail * 0.35);
      vec3 paper = vec3(1.0, 1.0 - p_paper * 0.025, 1.0 - p_paper * 0.07);
      outColor = vec4(toLin(mix(src, paper * clamp(value, 0.03, 1.0), p_mix)), 1.0);
    }`,
  },
  watercolor: {
    name: 'Watercolor Wash', cat: 'stylize', styles: ['illustrated'],
    desc: 'Edge-preserving pigment washes, pooled outlines and paper-like granulation',
    params: [P('radius', 'Brush size', 1, 10, 4), P('bleed', 'Pigment pooling', 0, 1, 0.35), P('detail', 'Edge detail', 0, 1, 0.45), MIX],
    glsl: `void main() {
      vec3 src = toSRGB(texture(uSrc, vUv).rgb), best = src; float lowest = 1e9;
      vec2 px = p_radius * uScale / uRes;
      // Kuwahara: choose the least varied quadrant so broad washes keep subject boundaries.
      for (int q = 0; q < 4; q++) {
        vec2 dir = vec2(q == 0 || q == 3 ? -1.0 : 1.0, q < 2 ? -1.0 : 1.0);
        vec3 sum = vec3(0.0), square = vec3(0.0);
        for (int x = 0; x < 3; x++) for (int y = 0; y < 3; y++) {
          vec3 c = toSRGB(texture(uSrc, mirrorUv(vUv + vec2(x, y) * dir * px)).rgb);
          sum += c; square += c * c;
        }
        vec3 mean = sum / 9.0;
        float variance = dot(abs(square / 9.0 - mean * mean), vec3(1.0));
        if (variance < lowest) { lowest = variance; best = mean; }
      }
      float edge = length(src - best);
      float pigment = noise3(vec3(toP(vUv) * 150.0, 2.0)) - 0.5;
      vec3 wash = mix(best, floor(best * 12.0 + 0.5) / 12.0, 0.22);
      wash *= 1.0 - edge * p_detail * 0.9 + pigment * p_bleed * 0.10;
      wash = mix(wash, wash * wash * 0.95, smoothstep(0.02, 0.20, edge) * p_bleed * 0.35);
      outColor = vec4(toLin(max(mix(src, wash, p_mix), 0.0)), 1.0);
    }`,
  },
};
