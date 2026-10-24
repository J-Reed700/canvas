// Display-referred .cube grades. Red is the fastest-changing axis in the file and in TEXTURE_3D.
// Keep float32 bytes in a portable, compact string so project files carry their grade with them.
export interface CubeLut {
  name: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: string;
}

export const MAX_CUBE_BYTES = 24 * 1024 * 1024;
const MAX_SIZE = 65;
const decoded = new WeakMap<CubeLut, Float32Array>();

function validDomain(lo: number, hi: number): boolean {
  const low = Math.fround(lo), high = Math.fround(hi);
  const span = Math.fround(high - low);
  return Number.isFinite(lo) && Number.isFinite(hi) && Number.isFinite(low) && Number.isFinite(high)
    && Number.isFinite(span) && span >= 2 ** -126;
}

function pack(values: number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Reject malformed or unsupported shaper LUTs rather than silently applying the wrong grade. */
export function parseCube(text: string, filename = 'Custom grade'): CubeLut {
  if (text.length > MAX_CUBE_BYTES) throw new Error('The LUT is too large (24 MB maximum).');
  let name = filename.replace(/\.cube$/i, '').slice(0, 120);
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const seen = new Set<string>();
  const values: number[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = /^TITLE\s/.test(raw.trim()) ? raw.trim() : raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [key, ...parts] = line.split(/\s+/);
    if (key === 'TITLE') {
      const title = /^TITLE\s+"(.*)"(?:\s*#.*)?$/.exec(line);
      if (!title) throw new Error('LUT TITLE must be enclosed in quotes.');
      name = title[1].slice(0, 120) || name;
      continue;
    }
    if (key === 'LUT_3D_SIZE' || key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX' || key === 'LUT_3D_INPUT_RANGE') {
      if (values.length || seen.has(key)) throw new Error(`Invalid or repeated ${key} header.`);
      seen.add(key);
      const nums = parts.map(Number);
      if (!nums.every(Number.isFinite)) throw new Error(`Invalid ${key} values.`);
      if (key === 'LUT_3D_SIZE') {
        size = nums[0];
        if (nums.length !== 1 || !Number.isInteger(size) || size < 2 || size > MAX_SIZE) {
          throw new Error('Use a 3D .cube LUT with a grid size from 2 to 65.');
        }
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        if (nums.length !== 2 || seen.has('DOMAIN_MIN') || seen.has('DOMAIN_MAX')) throw new Error('Invalid or mixed LUT input ranges.');
        domainMin = [nums[0], nums[0], nums[0]];
        domainMax = [nums[1], nums[1], nums[1]];
      } else {
        if (nums.length !== 3 || seen.has('LUT_3D_INPUT_RANGE')) throw new Error('Invalid or mixed LUT domains.');
        if (key === 'DOMAIN_MIN') domainMin = nums as [number, number, number];
        else domainMax = nums as [number, number, number];
      }
      continue;
    }
    if (/^[A-Za-z_]/.test(key)) throw new Error(`Unsupported LUT directive: ${key}. Use a 3D-only .cube file.`);
    const nums = [key, ...parts].map(Number);
    if (!size || nums.length !== 3 || !nums.every((v) => Number.isFinite(v) && Math.abs(v) <= 65504)) {
      throw new Error('Each LUT sample must contain three finite RGB values after LUT_3D_SIZE.');
    }
    values.push(...nums);
    if (values.length > size ** 3 * 3) throw new Error('The LUT contains more samples than its grid size.');
  }
  if (!size || values.length !== size ** 3 * 3) throw new Error(`Incomplete LUT: expected ${size ** 3} RGB samples, found ${values.length / 3}.`);
  if (domainMin.some((v, i) => !validDomain(v, domainMax[i]))) throw new Error('LUT domains must have a positive range representable by the GPU on every axis.');
  return { name, size, domainMin, domainMax, data: pack(values) };
}

/** Validate again on project restore: saved JSON is not necessarily a parser-produced LUT. */
export function lutValues(lut: CubeLut): Float32Array {
  const cached = decoded.get(lut);
  if (cached) return cached;
  if (typeof lut.name !== 'string' || lut.name.length > 120 ||
      !Number.isInteger(lut.size) || lut.size < 2 || lut.size > MAX_SIZE ||
      !Array.isArray(lut.domainMin) || !Array.isArray(lut.domainMax) ||
      lut.domainMin.length !== 3 || lut.domainMax.length !== 3 ||
      lut.domainMin.some((v, i) => !validDomain(v, lut.domainMax[i]))) {
    throw new Error('Invalid saved LUT grid or domain.');
  }
  const count = lut.size ** 3 * 3;
  if (typeof lut.data !== 'string' || lut.data.length !== Math.ceil(count * 4 / 3) * 4) throw new Error('Invalid saved LUT data length.');
  const binary = atob(lut.data);
  if (binary.length !== count * 4) throw new Error('Invalid saved LUT data.');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v) || Math.abs(v) > 65504) throw new Error('Invalid saved LUT sample.');
    values[i] = v;
  }
  decoded.set(lut, values);
  return values;
}

export const IDENTITY_LUT = parseCube('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1', 'Identity');
