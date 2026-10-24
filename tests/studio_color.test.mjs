import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, lutValues, IDENTITY_LUT } from '../downbeat/studio/src/engine/lut.ts';
import { scopeDensity } from '../downbeat/studio/src/engine/scopes.ts';
import { guideFor, SAFE_GUIDES } from '../downbeat/studio/src/lib/safeGuides.ts';

const samples = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1';
const cube = `LUT_3D_SIZE 2\n${samples}`;

test('cube parser preserves RGB order, extended values, domains and portable project serialization', () => {
  const lut = parseCube(`\uFEFF# a grade\r\nTITLE "Night drive"\nDOMAIN_MIN -0.1 -0.2 -0.3\nDOMAIN_MAX 1 2 3\n${cube}`, 'ignored.cube');
  assert.equal(lut.name, 'Night drive');
  assert.deepEqual(lut.domainMin, [-0.1, -0.2, -0.3]);
  assert.deepEqual(lut.domainMax, [1, 2, 3]);
  const restored = JSON.parse(JSON.stringify(lut));
  assert.deepEqual([...lutValues(restored)], samples.split(/\s/).map(Number));
  assert.equal(lutValues(restored), lutValues(restored), 'decodes once per immutable LUT');
  const extended = parseCube(cube.replace('1 1 1', '1.25 -0.5 2e0'));
  assert.deepEqual([...lutValues(extended).slice(-3)], [1.25, -0.5, 2]);
  assert.equal(parseCube(cube, 'Grade.cube').name, 'Grade');
  assert.equal(parseCube(`TITLE\t"Grade #2" # comment\n${cube}`).name, 'Grade #2');
});

test('cube parser accepts a shared input range and rejects malformed, mixed and incomplete LUTs', () => {
  const lut = parseCube(`LUT_3D_INPUT_RANGE -1 2\n${cube}`);
  assert.deepEqual(lut.domainMin, [-1, -1, -1]);
  assert.deepEqual(lut.domainMax, [2, 2, 2]);
  for (const input of [
    '', 'LUT_3D_SIZE 1', 'LUT_3D_SIZE 66', 'LUT_3D_SIZE 2.5',
    cube + '\n1 1 1', cube.replace('0 0 0', 'NaN 0 0'), cube.replace('0 0 0', '0 0 Infinity'),
    cube.replace('0 0 0', '0 0 1e99'), cube.replace('0 0 0', '0 0'),
    'LUT_1D_SIZE 2\n' + cube, 'DOMAIN_MAX 0 1 1\n' + cube,
    'DOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0\n' + cube,
    'LUT_3D_INPUT_RANGE 0 1\nDOMAIN_MIN 0 0 0\n' + cube,
    'DOMAIN_MIN 0 0 0\nLUT_3D_INPUT_RANGE 0 1\n' + cube,
    'DOMAIN_MAX 1e300 1 1\n' + cube,
    'DOMAIN_MIN 1 0 0\nDOMAIN_MAX 1.00000000001 1 1\n' + cube,
  ]) assert.throws(() => parseCube(input), undefined, input.slice(0, 80));
});

test('saved LUTs cannot smuggle invalid grids, payloads or nonfinite values into GPU allocation', () => {
  for (const changed of [{ size: 9999 }, { name: {} }, { name: 'x'.repeat(121) },
    { domainMin: [0, 0] }, { domainMax: [0, 1, 1] }, { domainMax: [1e300, 1, 1] },
    { domainMax: [1e-40, 1, 1] }, { domainMin: [1, 0, 0], domainMax: [1.00000000001, 1, 1] },
    { data: '' }, { data: '!'.repeat(IDENTITY_LUT.data.length) }]) {
    assert.throws(() => lutValues({ ...IDENTITY_LUT, ...changed }));
  }
  const bytes = Buffer.from(IDENTITY_LUT.data, 'base64');
  bytes.writeFloatLE(NaN, 0);
  assert.throws(() => lutValues({ ...IDENTITY_LUT, data: bytes.toString('base64') }));
});

test('a 65-point LUT fits in the project file limit without losing float32 precision', () => {
  const n = 65;
  const rows = Array.from({ length: n ** 3 }, (_, i) => `${(i % n) / (n - 1)} ${Math.floor(i / n) % n / (n - 1)} ${Math.floor(i / n ** 2) / (n - 1)}`);
  const lut = parseCube(`LUT_3D_SIZE ${n}\n${rows.join('\n')}`);
  assert.ok(JSON.stringify(lut).length < 5 * 1024 * 1024);
  assert.equal(lutValues(lut).length, n ** 3 * 3);
  assert.deepEqual([...lutValues(lut).slice(-3)], [1, 1, 1]);
});

test('waveform preserves horizontal placement and RGB parade separates channels', () => {
  const px = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  const wave = scopeDensity(px, 2, 'waveform', 2, 256)[0];
  assert.equal(wave[255 * 2], 1, 'black is bottom left');
  assert.equal(wave[1], 1, 'white is top right');
  assert.equal(wave.reduce((a, b) => a + b), 4);
  const rgb = scopeDensity(px, 2, 'rgb', 2, 256);
  assert.equal(rgb[0][0], 1, 'red top left');
  assert.equal(rgb[2][1], 2, 'blue top right twice');
  assert.equal(rgb[1][255 * 2], 2, 'green bottom left twice');
});

test('safe guides match the export shape and expose approximations for every platform', () => {
  assert.equal(guideFor('phone', 'tiktok').id, 'tiktok');
  assert.equal(guideFor('tablet', 'tiktok').id, 'apple');
  assert.equal(guideFor('phone', '', 'social_vertical').id, 'reels');
  for (const g of SAFE_GUIDES) {
    assert.ok(g.top + g.bottom < 100 && g.left + g.right < 100);
    assert.ok(g.source.startsWith('https://'));
  }
});
