// Downbeat GPU engine: core GLSL (WebGL2 / GLSL ES 3.00).
// Working space is linear light with HDR headroom; the Finish pass tone-maps and encodes sRGB.
import type { TransitionDef, TransitionType } from './types.ts';

export const VERT: string = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const PRELUDE: string = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTime, uLoop, uPhase, uBeat, uBeatLen, uScale, uSeed, uFrame;
uniform float uAudioTime, uBassTime, uAudioPhase, uBassPhase;
uniform float uKick, uSnare, uHats, uBass, uEnergy, uBright;
#define PI 3.14159265359
#define TAU 6.28318530718
float aspect() { return uRes.x / uRes.y; }
vec2 toP(vec2 uv) { return (uv - 0.5) * vec2(aspect(), 1.0); }
vec2 toUv(vec2 p) { return p / vec2(aspect(), 1.0) + 0.5; }
vec2 mirrorUv(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toSRGB(vec3 c) { c = max(c, 0.0); return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLin(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.9375; }
// Loop crossfade: blends two time samples one period apart with variance correction.
float loopFbm(vec2 p, float cycles) {
  if (cycles < 0.5) return fbm3(vec3(p, 0.0));
  float w = uPhase; float z = uPhase * cycles;
  float m = mix(fbm3(vec3(p, z)), fbm3(vec3(p, z - cycles)), w);
  return (m - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w)) + 0.5;
}
float loopNoise(vec2 p, float cycles) {
  if (cycles < 0.5) return noise3(vec3(p, 0.0));
  float w = uPhase; float z = uPhase * cycles;
  float m = mix(noise3(vec3(p, z)), noise3(vec3(p, z - cycles)), w);
  return (m - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w)) + 0.5;
}
vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
vec3 hueRotate(vec3 c, float a) { const vec3 k = vec3(0.57735); float ca = cos(a); return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca); }
vec3 cosPal(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
`;

// Camera / source framing
export const SOURCE: string = PRELUDE + `
uniform sampler2D uVideo;
uniform vec2 uVidRes;
uniform vec2 uCenter;
uniform float uZoom, uRot, uFlip;
uniform vec2 uShake;
void main() {
  float ca = aspect(); float va = uVidRes.x / max(uVidRes.y, 1.0);
  vec2 frac = va > ca ? vec2(ca / va, 1.0) : vec2(1.0, va / ca);
  vec2 p = (vUv - 0.5) * vec2(ca, 1.0);
  p = rot(uRot) * p;
  p /= vec2(ca, 1.0) * uZoom;
  vec2 room = max((1.0 - frac / uZoom) * 0.5, 0.0);
  vec2 c = 0.5 + clamp(uCenter - 0.5, -room, room);
  vec2 uv = c + (p + uShake / uZoom) * frac; // shake is a fraction of the visible frame
  if (uFlip > 0.5) uv.x = 1.0 - uv.x;
  outColor = vec4(toLin(texture(uVideo, mirrorUv(uv)).rgb), 1.0);
}`;

export const BLIT: string = PRELUDE + `void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

// Export frames arrive as 8-bit 4:2:0 planes, BT.709 full range, top row first (clipFrames.ts). Flip them
// so the result is laid out like an uploaded <video> frame.
export const YUV: string = PRELUDE + `
uniform sampler2D uY, uU, uV;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float y = texture(uY, uv).r, u = texture(uU, uv).r - 0.5, v = texture(uV, uv).r - 0.5;
  outColor = vec4(y + 1.5748 * v, y - 0.1873 * u - 0.4681 * v, y + 1.8556 * u, 1.0);
}`;

// Finish: grade, tone, texture
export const FINISH: string = PRELUDE + `
uniform float p_exposure, p_contrast, p_saturation, p_temp, p_tint, p_fade, p_split, p_splitHue,
              p_vignette, p_grain, p_bars, p_halation;
uniform sampler2D uGlow;
uniform highp sampler3D uLut;
uniform float uLutMix, uLutSize;
uniform vec3 uLutMin, uLutMax;
vec3 shoulder(vec3 c) { // identity below 0.8, smooth roll-off of HDR highlights
  vec3 k = vec3(0.8);
  return mix(c, k + (1.0 - k) * (1.0 - exp(-(c - k) / (1.0 - k))), step(k, c));
}
void main() {
  vec3 c = texture(uSrc, vUv).rgb * exp2(p_exposure);
  if (p_halation > 0.0) {                       // red film halation from the blurred glow chain
    vec3 g = texture(uGlow, vUv).rgb;
    c += vec3(1.0, 0.32, 0.12) * luma(g) * p_halation * 0.6;
  }
  c *= vec3(1.0 + 0.10 * p_temp - 0.03 * p_tint, 1.0 + 0.06 * p_tint, 1.0 - 0.12 * p_temp - 0.03 * p_tint);
  c = shoulder(c);
  vec3 s = clamp(toSRGB(c), 0.0, 1.0);
  s = mix(s, s * s * (3.0 - 2.0 * s), p_contrast - 1.0);
  float l = luma(s);
  s = mix(vec3(l), s, p_saturation);
  vec3 sh = hsv2rgb(vec3(p_splitHue, 0.55, 1.0)), hi = hsv2rgb(vec3(fract(p_splitHue + 0.5), 0.45, 1.0));
  s = mix(s, s * mix(sh, hi, smoothstep(0.15, 0.85, l)) * 1.2, p_split * 0.4);
  s = p_fade * vec3(0.92, 0.95, 1.0) + s * (1.0 - p_fade);
  if (uLutMix > 0.0) {
    vec3 uvw = clamp((s - uLutMin) / (uLutMax - uLutMin), 0.0, 1.0);
    // Sample texel centers so the endpoints stay exact; hardware performs trilinear interpolation.
    uvw = (uvw * (uLutSize - 1.0) + 0.5) / uLutSize;
    s = mix(s, texture(uLut, uvw).rgb, uLutMix);
  }
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.25);
  s *= 1.0 - p_vignette * smoothstep(0.25, 0.85, length(q) * 1.15);
  vec2 gp = floor(gl_FragCoord.xy / max(uScale * 1.5, 1.0));
  float g = hash12(gp + fract(uFrame * 0.6180339) * 917.0) + hash12(gp * 0.5 + uFrame * 1.31) - 1.0;
  s += g * p_grain * 0.09 * (0.35 + 0.65 * (1.0 - abs(l - 0.45) * 1.6));
  float bars = p_bars * 0.5;
  s *= step(bars, vUv.y) * step(vUv.y, 1.0 - bars);
  s += (hash12(gl_FragCoord.xy + uFrame) - 0.5) / 255.0;   // de-band before 8-bit H.264
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

// Photosensitivity guard (W3C-style slew limit)
export const GUARD_STATE: string = PRELUDE + `
uniform sampler2D uCur; uniform sampler2D uState; uniform float uLimit, uReset;
void main() {
  float cur = luma(textureLod(uCur, vec2(0.5), 20.0).rgb);
  float prev = texture(uState, vec2(0.5)).r;
  float d = cur - prev;
  float k = (uReset > 0.5 || abs(d) <= uLimit) ? 1.0 : uLimit / abs(d);
  outColor = vec4(uReset > 0.5 ? cur : prev + k * d, k, 0.0, 1.0);
}`;
export const GUARD_OUT: string = PRELUDE + `
uniform sampler2D uCur; uniform sampler2D uPrevOut; uniform sampler2D uState;
void main() {
  float k = texture(uState, vec2(0.5)).g;
  outColor = vec4(mix(texture(uPrevOut, vUv).rgb, texture(uCur, vUv).rgb, k), 1.0);
}`;

// Dual-filter (Kawase) blur chain
export const BRIGHT: string = PRELUDE + `
uniform float uThreshold, uKnee;
void main() {
  vec2 t = 1.0 / uRes;
  vec3 c = (texture(uSrc, vUv + t * vec2(-0.5, -0.5)).rgb + texture(uSrc, vUv + t * vec2(0.5, -0.5)).rgb +
            texture(uSrc, vUv + t * vec2(-0.5, 0.5)).rgb + texture(uSrc, vUv + t * vec2(0.5, 0.5)).rgb) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = vec4(min(c * w, vec3(40.0)), 1.0);
}`;
export const KAWASE_DOWN: string = PRELUDE + `
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv - h).rgb + texture(uSrc, vUv + h).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb + texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  outColor = vec4(s / 8.0, 1.0);
}`;
export const KAWASE_UP: string = PRELUDE + `
uniform vec2 uTexel; uniform sampler2D uAdd; uniform float uAddW;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb + texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb +
           texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb + texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += (texture(uSrc, vUv + vec2(-h.x, h.y)).rgb + texture(uSrc, vUv + vec2(h.x, h.y)).rgb +
        texture(uSrc, vUv + vec2(h.x, -h.y)).rgb + texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb) * 2.0;
  outColor = vec4(s / 12.0 + texture(uAdd, vUv).rgb * uAddW, 1.0);
}`;
export const DIR_BLUR: string = PRELUDE + `
uniform vec2 uDir;
void main() {
  vec3 s = vec3(0.0); float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    s += texture(uSrc, vUv + uDir * float(i)).rgb * w; wsum += w;
  }
  outColor = vec4(s / wsum, 1.0);
}`;
export const RADIAL_BLUR: string = PRELUDE + `
uniform vec2 uCenterUv; uniform float uLength;
void main() {
  vec2 d = (uCenterUv - vUv) * uLength / 40.0;
  vec2 uv = vUv; vec3 s = vec3(0.0); float w = 1.0, wsum = 0.0;
  for (int i = 0; i < 40; i++) { s += texture(uSrc, uv).rgb * w; wsum += w; w *= 0.965; uv += d; }
  outColor = vec4(s / wsum, 1.0);
}`;
export const COMPOSITE: string = PRELUDE + `
uniform sampler2D uAdd; uniform vec3 uTint; uniform float uAmount;
void main() { outColor = vec4(texture(uSrc, vUv).rgb + texture(uAdd, vUv).rgb * uTint * uAmount, 1.0); }`;

// Tiny downsample used for export statistics (seam + flash analysis).
export const STATS: string = PRELUDE + `void main() { outColor = vec4(textureLod(uSrc, vUv, 4.0).rgb, 1.0); }`;

// Transitions (A -> B, uP in 0..1, 0.5 = on the beat)
const T = (body: string): string => PRELUDE + `
uniform sampler2D uA; uniform sampler2D uB; uniform float uP;
vec3 A(vec2 uv) { return texture(uA, mirrorUv(uv)).rgb; }
vec3 B(vec2 uv) { return texture(uB, mirrorUv(uv)).rgb; }
float ease(float x) { return x * x * (3.0 - 2.0 * x); }
void main() {
  float p = clamp(uP, 0.0, 1.0);
  if (p <= 0.0) { outColor = vec4(A(vUv), 1.0); return; }
  if (p >= 1.0) { outColor = vec4(B(vUv), 1.0); return; }
  float e = ease(p); float bell = sin(p * PI); ${body}
}`;

const transition = (name: string, type: TransitionType, description: string, body: string): TransitionDef =>
  ({ name, type, description, glsl: T(body) });

const wipe = (name: string, position: string, description: string, softness = 0.018) =>
  transition(name, 'Wipes', description, `float d = ${position};
    float m = 1.0 - smoothstep(e * ${1 + softness * 2} - ${softness * 2}, e * ${1 + softness * 2}, d);
    outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`);

const slide = (name: string, direction: string, description: string, cover = false) =>
  transition(name, 'Slides', description, `vec2 dir = ${direction};
    vec2 incoming = vUv + dir * (1.0 - e);
    bool inside = all(greaterThanEqual(incoming, vec2(0.0))) && all(lessThanEqual(incoming, vec2(1.0)));
    outColor = vec4(inside ? B(incoming) : A(${cover ? 'vUv' : 'vUv - dir * e'}), 1.0);`);

export const TRANSITIONS: Record<string, TransitionDef> = {
  cut: { name: 'Hard Cut', type: 'Cuts & fades', description: 'Switch instantly on the beat.', glsl: T(`outColor = vec4(p < 0.5 ? A(vUv) : B(vUv), 1.0);`) },
  dissolve: { name: 'Light Dissolve', type: 'Cuts & fades', description: 'Blend clips with a gentle lift in brightness.', glsl: T(`outColor = vec4(mix(A(vUv), B(vUv), e) * (1.0 + 0.35 * bell), 1.0);`) },
  luma: {
    name: 'Luma Burn',
    type: 'Light & color', description: 'Reveal the incoming image through a warm luminance burn.',
    glsl: T(`float l = luma(toSRGB(B(vUv)));
      float m = smoothstep(l - 0.18, l + 0.18, p * 1.36 - 0.18);
      vec3 c = mix(A(vUv), B(vUv), m);
      c += vec3(1.0, 0.55, 0.25) * (m * (1.0 - m)) * 1.6 * bell;
      outColor = vec4(c, 1.0);`),
  },
  zoom: {
    name: 'Zoom Punch',
    type: 'Zoom & spin', description: 'Punch into the next clip with radial motion blur.',
    glsl: T(`vec2 p0 = vUv - 0.5; vec3 s = vec3(0.0);
      float amt = 0.22 * bell;
      for (int i = 0; i < 16; i++) {
        float k = float(i) / 15.0;
        vec2 pa = p0 / (1.0 + e * 0.6 + amt * k) + 0.5;
        vec2 pb = p0 * (1.0 + (1.0 - e) * 0.5) / (1.0 + amt * k) + 0.5;
        s += mix(A(pa), B(pb), e);
      }
      outColor = vec4(s / 16.0, 1.0);`),
  },
  whip: {
    name: 'Whip Pan',
    type: 'Slides', description: 'Whip vertically with a streak of motion blur.',
    glsl: T(`vec3 s = vec3(0.0);
      for (int i = 0; i < 20; i++) {
        float k = (float(i) / 19.0 - 0.5) * 0.18 * bell;
        float o = e + k;
        vec2 uv = vUv + vec2(0.0, o);
        s += uv.y < 1.0 ? A(uv) : B(uv - vec2(0.0, 1.0));
      }
      outColor = vec4(s / 20.0, 1.0);`),
  },
  whipX: {
    name: 'Whip Sideways',
    type: 'Slides', description: 'Whip horizontally with a blurred camera move.',
    glsl: T(`vec3 s = vec3(0.0);
      for (int i = 0; i < 20; i++) {
        float k = (float(i) / 19.0 - 0.5) * 0.25 * bell;
        vec2 uv = vUv + vec2(e + k, 0.0);
        s += uv.x < 1.0 ? A(uv) : B(uv - vec2(1.0, 0.0));
      }
      outColor = vec4(s / 20.0, 1.0);`),
  },
  glitch: {
    name: 'Block Glitch',
    type: 'Glitch', description: 'Break the cut into displaced blocks and RGB fringes.',
    glsl: T(`vec2 cell = floor(vUv * vec2(8.0, 22.0) * (1.0 + floor(p * 4.0)));
      float r = hash12(cell + floor(p * 9.0) * 13.1 + uSeed);
      float off = (r - 0.5) * 0.25 * bell * step(0.55, hash12(cell * 1.7 + floor(p * 7.0)));
      vec2 uv = vUv + vec2(off, 0.0);
      float pick = step(r, e);
      float split = 0.02 * bell;
      vec3 a = vec3(A(uv + vec2(split, 0.0)).r, A(uv).g, A(uv - vec2(split, 0.0)).b);
      vec3 b = vec3(B(uv + vec2(split, 0.0)).r, B(uv).g, B(uv - vec2(split, 0.0)).b);
      outColor = vec4(mix(a, b, pick), 1.0);`),
  },
  mosh: {
    name: 'Datamosh',
    type: 'Glitch', description: 'Smear image detail into motion-like compression blocks.',
    glsl: T(`vec2 bs = vec2(1.0 / 24.0, 1.0 / 42.0);
      vec2 blk = (floor(vUv / bs) + 0.5) * bs;
      float lx = luma(B(blk + vec2(bs.x, 0.0))) - luma(B(blk - vec2(bs.x, 0.0)));
      float ly = luma(B(blk + vec2(0.0, bs.y))) - luma(B(blk - vec2(0.0, bs.y)));
      vec2 flow = vec2(lx, ly) * 0.9 * bell;
      vec3 smeared = A(vUv - flow * (0.5 + hash12(blk * 91.0)));
      float reveal = step(hash12(blk * 17.0 + uSeed), pow(p, 1.4));
      outColor = vec4(mix(smeared, B(vUv - flow * 0.3), reveal), 1.0);`),
  },
  ripple: {
    name: 'Shock Ripple',
    type: 'Distortion', description: 'Reveal the next clip behind an expanding circular wave.',
    glsl: T(`vec2 q = toP(vUv); float d = length(q);
      float R = p * (length(vec2(aspect(), 1.0)) * 0.5 + 0.12);
      float wave = sin(d * 38.0 - p * 30.0) * exp(-abs(d - R) * 6.0) * 0.045 * bell;
      vec2 uv = toUv(q + normalize(q + 1e-5) * wave);
      outColor = vec4(mix(A(uv), B(uv), 1.0 - smoothstep(R - 0.12, R, d)), 1.0);`),
  },
  iris: {
    name: 'Iris Bloom',
    type: 'Shapes', description: 'Open a circular iris with a softly glowing edge.',
    glsl: T(`float d = length(toP(vUv)); float r = e * (length(vec2(aspect(), 1.0)) * 0.5 + 0.06);
      float m = 1.0 - smoothstep(r - 0.06, r, d);
      float z = (d - r) / 0.025; float ring = exp(-z * z) * bell;
      outColor = vec4(mix(A(vUv), B(vUv), m) + vec3(1.0, 0.85, 0.7) * ring * 1.5, 1.0);`),
  },
  pixel: {
    name: 'Pixel Melt',
    type: 'Glitch', description: 'Melt into coarse pixels before resolving into the next clip.',
    glsl: T(`float n = mix(140.0, 9.0, bell);
      vec2 g = vec2(n * aspect(), n);
      vec2 uv = bell > 0.05 ? (floor(vUv * g) + 0.5) / g : vUv;
      outColor = vec4(mix(A(uv), B(uv), step(hash12(floor(vUv * g)), e)), 1.0);`),
  },
  swirl: {
    name: 'Vortex',
    type: 'Zoom & spin', description: 'Twist both clips around the center of the frame.',
    glsl: T(`vec2 q = toP(vUv); float d = length(q);
      float a = bell * 5.0 * (1.0 - smoothstep(0.0, 0.9, d));
      vec2 uv = toUv(rot(a) * q);
      outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  },
  prism: {
    name: 'Prism Split',
    type: 'Light & color', description: 'Separate red, green and blue into staggered color trails.',
    glsl: T(`float sh = 0.06 * bell;
      vec3 a = vec3(A(vUv + vec2(sh, 0.0)).r, A(vUv).g, A(vUv - vec2(sh, 0.0)).b);
      vec3 b = vec3(B(vUv - vec2(sh, 0.0)).r, B(vUv).g, B(vUv + vec2(sh, 0.0)).b);
      vec3 m = vec3(smoothstep(0.0, 0.7, p), smoothstep(0.15, 0.85, p), smoothstep(0.3, 1.0, p));
      outColor = vec4(mix(a, b, m), 1.0);`),
  },
  flare: {
    name: 'Light Leak',
    type: 'Light & color', description: 'Wash the cut in a traveling amber light leak.',
    glsl: T(`vec2 q = toP(vUv);
      float leak = exp(-pow(length(q - vec2(-0.6 + p * 1.2, 0.3 - p * 0.5)) * 1.6, 2.0));
      vec3 c = mix(A(vUv), B(vUv), e);
      c += vec3(1.0, 0.45, 0.15) * leak * bell * 1.4;
      outColor = vec4(c, 1.0);`),
  },
  slices: {
    name: 'Shutter Slices',
    type: 'Glitch', description: 'Slide alternating horizontal strips in opposite directions.',
    glsl: T(`float n = 9.0; float row = floor(vUv.y * n);
      float lp = clamp((p - row / n * 0.4) / 0.6, 0.0, 1.0);
      float dir = mod(row, 2.0) < 1.0 ? 1.0 : -1.0;
      float x = vUv.x + dir * ease(lp);
      outColor = vec4((x >= 0.0 && x <= 1.0) ? A(vec2(x, vUv.y)) : B(vec2(x - dir, vUv.y)), 1.0);`),
  },
  kaleido: {
    name: 'Kaleido Fold',
    type: 'Zoom & spin', description: 'Fold the picture into a rotating six-part kaleidoscope.',
    glsl: T(`vec2 q = toP(vUv); float r = length(q); float a = atan(q.y, q.x);
      float seg = TAU / 6.0; float fa = abs(mod(a + p * 2.0, seg) - seg * 0.5);
      vec2 k = toUv(vec2(cos(fa), sin(fa)) * r);
      vec2 uv = mix(vUv, k, bell);
      outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  },
  morph: {
    name: 'Flow Morph',
    type: 'Distortion', description: 'Flow between clips with a soft organic displacement.',
    glsl: T(`vec2 q = vUv * vec2(aspect(), 1.0) * 3.0;
      vec2 f = vec2(fbm3(vec3(q, uSeed)), fbm3(vec3(q + 7.3, uSeed))) - 0.5;
      vec3 a = A(vUv + f * 0.35 * e);
      vec3 b = B(vUv - f * 0.35 * (1.0 - e));
      outColor = vec4(mix(a, b, e), 1.0);`),
  },
  crossfade: transition('Cross Dissolve', 'Cuts & fades', 'An even, clean blend between two clips.',
    `outColor = vec4(mix(A(vUv), B(vUv), e), 1.0);`),
  dipBlack: transition('Dip to Black', 'Cuts & fades', 'Fade out to black, then bring in the next clip.',
    `vec3 c = p < 0.5 ? A(vUv) * (1.0 - ease(p * 2.0)) : B(vUv) * ease(p * 2.0 - 1.0);
     outColor = vec4(c, 1.0);`),
  dipWhite: transition('Dip to White', 'Cuts & fades', 'Pass through a clean white frame on the beat.',
    `vec3 c = p < 0.5 ? mix(A(vUv), vec3(1.0), ease(p * 2.0)) : mix(vec3(1.0), B(vUv), ease(p * 2.0 - 1.0));
     outColor = vec4(c, 1.0);`),
  blurDissolve: transition('Blur Dissolve', 'Cuts & fades', 'Soften both images into a dreamy crossfade.',
    `vec3 c = vec3(0.0);
     for (int i = 0; i < 12; i++) {
       float a = float(i) * TAU / 12.0; vec2 offset = vec2(cos(a) / aspect(), sin(a)) * 0.025 * bell;
       c += mix(A(vUv + offset), B(vUv + offset), e);
     }
     outColor = vec4(c / 12.0, 1.0);`),
  filmDissolve: transition('Film Dissolve', 'Cuts & fades', 'Blend through a fine, softly feathered film grain.',
    `float grain = hash12(floor(vUv * uRes) + uSeed);
     float m = smoothstep(grain - 0.25, grain + 0.25, e * 1.5 - 0.25);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  fadeThroughGray: transition('Silver Fade', 'Cuts & fades', 'Fade through a neutral silver tone for a muted cut.',
    `vec3 c = p < 0.5 ? mix(A(vUv), vec3(0.18), ease(p * 2.0)) : mix(vec3(0.18), B(vUv), ease(p * 2.0 - 1.0));
     outColor = vec4(c, 1.0);`),

  wipeLeft: wipe('Wipe Left', '1.0 - vUv.x', 'Reveal the next clip from right to left.'),
  wipeRight: wipe('Wipe Right', 'vUv.x', 'Reveal the next clip from left to right.'),
  wipeUp: wipe('Wipe Up', 'vUv.y', 'Sweep the incoming image upward.'),
  wipeDown: wipe('Wipe Down', '1.0 - vUv.y', 'Sweep the incoming image downward.'),
  diagonalWipe: wipe('Diagonal Wipe', '(vUv.x + 1.0 - vUv.y) * 0.5', 'Sweep diagonally from the upper-left corner.'),
  diagonalReverse: wipe('Reverse Diagonal', '(2.0 - vUv.x - vUv.y) * 0.5', 'Sweep diagonally from the upper-right corner.'),
  clockWipe: wipe('Clock Wipe', 'fract(atan(toP(vUv).x, toP(vUv).y + 0.000001) / TAU + 1.0)', 'Rotate a radial reveal clockwise around the center.'),
  softWipe: wipe('Feathered Wipe', 'vUv.x', 'A wide, soft-edged horizontal reveal.', 0.18),

  pushLeft: slide('Push Left', 'vec2(-1.0, 0.0)', 'Push the outgoing clip off the left edge.'),
  pushRight: slide('Push Right', 'vec2(1.0, 0.0)', 'Push the outgoing clip off the right edge.'),
  pushUp: slide('Push Up', 'vec2(0.0, 1.0)', 'Push the outgoing clip up and out of frame.'),
  pushDown: slide('Push Down', 'vec2(0.0, -1.0)', 'Push the outgoing clip down and out of frame.'),
  coverLeft: slide('Cover Left', 'vec2(-1.0, 0.0)', 'Slide the incoming clip left over a stationary image.', true),
  coverUp: slide('Cover Up', 'vec2(0.0, 1.0)', 'Slide the incoming clip upward over a stationary image.', true),

  zoomOut: transition('Zoom Pull', 'Zoom & spin', 'Pull back from the outgoing image into the next shot.',
    `vec2 q = vUv - 0.5;
     outColor = vec4(mix(A(q * (1.0 + e * 1.4) + 0.5), B(q / (1.0 + (1.0 - e) * 0.7) + 0.5), e), 1.0);`),
  crossZoom: transition('Cross Zoom', 'Zoom & spin', 'Rush both images toward the center with radial streaks.',
    `vec3 c = vec3(0.0);
     for (int i = 0; i < 16; i++) {
       float t = float(i) / 15.0; vec2 uv = (vUv - 0.5) * (1.0 - t * 0.5 * bell) + 0.5;
       c += mix(A(uv), B(uv), e);
     }
     outColor = vec4(c / 16.0, 1.0);`),
  spinLeft: transition('Spin Left', 'Zoom & spin', 'Rotate counterclockwise through a quick zoom.',
    `vec2 q = toP(vUv) / (1.0 + 0.45 * bell);
     vec2 a = toUv(rot(-e * PI) * q); vec2 b = toUv(rot((1.0 - e) * PI) * q);
     outColor = vec4(mix(A(a), B(b), e), 1.0);`),
  spinRight: transition('Spin Right', 'Zoom & spin', 'Rotate clockwise through a quick zoom.',
    `vec2 q = toP(vUv) / (1.0 + 0.45 * bell);
     vec2 a = toUv(rot(e * PI) * q); vec2 b = toUv(rot((e - 1.0) * PI) * q);
     outColor = vec4(mix(A(a), B(b), e), 1.0);`),
  barrelZoom: transition('Barrel Zoom', 'Zoom & spin', 'Bend the edges outward with a wide-angle zoom pulse.',
    `vec2 q = toP(vUv); vec2 uv = toUv(q * (1.0 + dot(q, q) * 1.1 * bell) / (1.0 + 0.3 * bell));
     outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),

  flash: transition('Flash Frame', 'Light & color', 'Hit the beat with a brief bright camera flash.',
    `vec3 c = mix(A(vUv), B(vUv), e);
     outColor = vec4(mix(c, vec3(2.0), pow(bell, 8.0) * 0.9), 1.0);`),
  exposureFade: transition('Exposure Bloom', 'Light & color', 'Overexpose the highlights into a luminous dissolve.',
    `vec3 c = mix(A(vUv), B(vUv), e);
     outColor = vec4(c * (1.0 + 2.5 * bell) + vec3(0.15) * pow(bell, 3.0), 1.0);`),
  chromaBloom: transition('Chroma Bloom', 'Light & color', 'Expand colored halos around highlights as the clips blend.',
    `vec2 q = vUv - 0.5; float s = 0.09 * bell;
     vec3 a = vec3(A(q * (1.0 + s) + 0.5).r, A(vUv).g, A(q * (1.0 - s) + 0.5).b);
     vec3 b = vec3(B(q * (1.0 - s) + 0.5).r, B(vUv).g, B(q * (1.0 + s) + 0.5).b);
     outColor = vec4(mix(a, b, e) * (1.0 + 0.3 * bell), 1.0);`),
  rgbSlide: transition('RGB Slide', 'Light & color', 'Slide separated color channels across the cut.',
    `float s = bell * 0.12;
     vec3 a = vec3(A(vUv + vec2(s, 0.0)).r, A(vUv).g, A(vUv - vec2(s, 0.0)).b);
     vec3 b = vec3(B(vUv - vec2(s, 0.0)).r, B(vUv).g, B(vUv + vec2(s, 0.0)).b);
     outColor = vec4(mix(a, b, smoothstep(0.25, 0.75, p)), 1.0);`),
  lightSweep: transition('Light Sweep', 'Light & color', 'Carry the reveal behind a bright diagonal ribbon of light.',
    `float d = (vUv.x + vUv.y) * 0.5; float edge = e * 1.3 - 0.15;
     float m = 1.0 - smoothstep(edge - 0.06, edge + 0.06, d);
     vec3 c = mix(A(vUv), B(vUv), m) + vec3(0.65, 0.8, 1.0) * exp(-pow((d - edge) * 20.0, 2.0)) * bell;
     outColor = vec4(c, 1.0);`),

  waveHorizontal: transition('Horizontal Wave', 'Distortion', 'Bend the image in traveling horizontal waves.',
    `vec2 uv = vUv + vec2(sin(vUv.y * TAU * 3.0 + p * TAU) * 0.08 * bell, 0.0);
     outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  waveVertical: transition('Vertical Wave', 'Distortion', 'Bend the image in traveling vertical waves.',
    `vec2 uv = vUv + vec2(0.0, sin(vUv.x * TAU * 3.0 + p * TAU) * 0.08 * bell);
     outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  liquid: transition('Liquid Melt', 'Distortion', 'Let the incoming image drip down in flowing ribbons.',
    `float x = vUv.x * 8.0; float n = noise3(vec3(x, 0.0, uSeed));
     float edge = e * 1.6 - n * 0.4 - 0.1;
     vec2 uv = vUv + vec2(sin(x + p * 5.0), cos(x * 1.3)) * bell * 0.025;
     float m = 1.0 - smoothstep(edge - 0.05, edge + 0.05, 1.0 - vUv.y);
     outColor = vec4(mix(A(uv), B(uv), m), 1.0);`),
  pinch: transition('Center Pinch', 'Distortion', 'Draw the frame inward through a pinched center.',
    `vec2 q = toP(vUv); float r = length(q);
     vec2 uv = toUv(q * (1.0 + 0.65 * bell * exp(-r * 3.0)));
     outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  bulge: transition('Lens Bulge', 'Distortion', 'Inflate the center with a soft fisheye pulse.',
    `vec2 q = toP(vUv); float r = length(q);
     vec2 uv = toUv(q / (1.0 + 1.2 * bell * exp(-r * 3.0)));
     outColor = vec4(mix(A(uv), B(uv), e), 1.0);`),
  turbulence: transition('Turbulent Wash', 'Distortion', 'Stir both clips through broad, rolling noise currents.',
    `vec2 q = toP(vUv) * 4.0;
     vec2 flow = vec2(fbm3(vec3(q, p * 2.0 + uSeed)), fbm3(vec3(q + 8.0, p * 2.0 + uSeed))) - 0.5;
     outColor = vec4(mix(A(vUv + flow * bell * 0.4), B(vUv - flow * bell * 0.4), e), 1.0);`),

  scanline: transition('Scanline Tear', 'Glitch', 'Tear horizontal scanlines into the next image.',
    `float row = floor(vUv.y * 100.0); float r = hash12(vec2(row, floor(p * 12.0) + uSeed));
     vec2 uv = vUv + vec2((r - 0.5) * 0.22 * bell, 0.0);
     vec3 c = mix(A(uv), B(uv), step(r, e));
     outColor = vec4(c * (1.0 - 0.25 * bell * mod(row, 2.0)), 1.0);`),
  channelGlitch: transition('Channel Glitch', 'Glitch', 'Swap RGB channels in independently jumping bands.',
    `float row = floor(vUv.y * 14.0); float r = hash12(vec2(row + uSeed, floor(p * 8.0)));
     vec2 off = vec2((r - 0.5) * 0.3 * bell, 0.0);
     vec3 a = vec3(A(vUv + off).r, A(vUv - off).g, A(vUv + off * 2.0).b);
     vec3 b = vec3(B(vUv - off).r, B(vUv + off).g, B(vUv - off * 2.0).b);
     outColor = vec4(mix(a, b, vec3(step(r, e), step(fract(r + 0.33), e), step(fract(r + 0.66), e))), 1.0);`),
  blockShuffle: transition('Block Shuffle', 'Glitch', 'Scatter tiled fragments before the next image locks in.',
    `vec2 cell = floor(vUv * vec2(12.0, 8.0)); vec2 shift = (hash22(cell + uSeed) - 0.5) * bell * 0.8;
     vec2 uv = vUv + shift;
     outColor = vec4(mix(A(uv), B(uv), step(hash12(cell + 3.0), e)), 1.0);`),
  staticDissolve: transition('Analog Static', 'Glitch', 'Tune through flickering television noise and signal loss.',
    `float n = hash12(floor(vUv * uRes) + floor(p * 24.0) * 17.0 + uSeed);
     vec2 uv = vUv + vec2((n - 0.5) * 0.03 * bell, 0.0);
     vec3 c = mix(A(uv), B(uv), e);
     outColor = vec4(mix(c, vec3(n), bell * 0.65), 1.0);`),

  diamond: transition('Diamond Reveal', 'Shapes', 'Open the next clip inside an expanding diamond.',
    `vec2 q = abs(vUv - 0.5); float d = q.x + q.y;
     float m = 1.0 - smoothstep(e * 1.04 - 0.04, e * 1.04, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  boxReveal: transition('Box Reveal', 'Shapes', 'Grow a centered rectangle to fill the frame.',
    `vec2 q = abs(vUv - 0.5) * 2.0; float d = max(q.x, q.y);
     float m = 1.0 - smoothstep(e * 1.04 - 0.04, e * 1.04, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  blinds: transition('Horizontal Blinds', 'Shapes', 'Open parallel horizontal slats across the frame.',
    `float d = fract(vUv.y * 10.0);
     float m = 1.0 - smoothstep(e * 1.06 - 0.06, e * 1.06, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  checkerboard: transition('Checkerboard', 'Shapes', 'Reveal alternating squares in a staggered checker pattern.',
    `vec2 cell = floor(vUv * vec2(12.0, 8.0)); float parity = mod(cell.x + cell.y, 2.0);
     float local = clamp(p * 1.6 - parity * 0.6, 0.0, 1.0);
     vec2 q = abs(fract(vUv * vec2(12.0, 8.0)) - 0.5) * 2.0;
     float m = 1.0 - smoothstep(local * 1.06 - 0.06, local * 1.06, max(q.x, q.y));
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  venetian: transition('Vertical Blinds', 'Shapes', 'Open parallel vertical slats across the frame.',
    `float d = fract(vUv.x * 12.0);
     float m = 1.0 - smoothstep(e * 1.06 - 0.06, e * 1.06, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  splitHorizontal: transition('Horizontal Split', 'Shapes', 'Part the image from the center toward the top and bottom.',
    `float d = abs(vUv.y - 0.5) * 2.0;
     float m = 1.0 - smoothstep(e * 1.04 - 0.04, e * 1.04, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
  splitVertical: transition('Vertical Split', 'Shapes', 'Part the image from the center toward the left and right.',
    `float d = abs(vUv.x - 0.5) * 2.0;
     float m = 1.0 - smoothstep(e * 1.04 - 0.04, e * 1.04, d);
     outColor = vec4(mix(A(vUv), B(vUv), m), 1.0);`),
};
