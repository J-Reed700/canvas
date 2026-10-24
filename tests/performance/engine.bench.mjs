// CPU work only. Browser/GPU and native encode timings are measured separately.
import assert from 'node:assert/strict';
import { cpus, platform, arch } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { planTimeline, sampleTimeline } from '../../downbeat/studio/src/engine/timeline.ts';
import { segAt } from '../../downbeat/studio/src/engine/blocks.ts';
import { compose } from '../../downbeat/studio/src/engine/composer.ts';
import { makeSampler } from '../../downbeat/studio/src/engine/audio.ts';
import { LOOKS } from '../../downbeat/studio/src/engine/looks.ts';

let checksum = 0;
function measure(fn, count = 20_000) {
  for (let i = 0; i < 2_000; i++) checksum += fn(i);
  const times = [];
  const batch = 200;
  for (let i = 0; i < count; i += batch) {
    const start = performance.now();
    for (let j = 0; j < batch; j++) checksum += fn(i + j);
    times.push((performance.now() - start) / batch);
  }
  times.sort((a, b) => a - b);
  return { median_ms: times[Math.floor(times.length / 2)], p95_ms: times[Math.floor(times.length * 0.95)] };
}

const cases = [];
for (const cuts of [8, 256, 4096]) {
  const L = 600, beatDur = 0.5, seed = 17;
  const clips = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, duration: 60 }));
  const tl = planTimeline({ L, beatDur, clips, seed, rhythm: 'custom', custom: Array.from({ length: cuts - 1 }, (_, i) => (i + 1) * L / cuts), transitions: ['dissolve', 'zoom', 'cut'], transBeats: 1 });
  assert.equal(tl.segs.length, cuts);
  const ctx = { tl, L, beatDur, seed, clips, look: LOOKS[0], clipDur: () => 60, sampler: makeSampler({ features: null, L, beatDur, seed, loopStart: 0 }) };
  const time = (i) => ((i * 7919) % 1_000_003) / 1_000_003 * L;
  let visits = 0;
  const indexed = { ...tl, segs: new Proxy(tl.segs, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) visits++; return Reflect.get(target, key, receiver); } }) };
  sampleTimeline(indexed, L * .99); const sampleVisits = visits;
  visits = 0; segAt(indexed, L * .99); const selectionVisits = visits;
  cases.push({ cuts, sample_segment_reads: sampleVisits, selection_segment_reads: selectionVisits, sample: measure((i) => sampleTimeline(tl, time(i)).a.seg.i), selection: measure((i) => segAt(tl, time(i)).i), compose: measure((i) => compose(ctx, time(i)).needs.length, 4_000) });
}
const report = { schema: 1, timestamp: new Date().toISOString(), runtime: process.version, host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, workload: '600-second loop; 8 clips; mixed cut/dissolve/zoom; deterministic random seeks; batch-amortized CPU times', cases, checksum };
const destination = resolve(process.env.DOWNBEAT_PERF_REPORT || 'artifacts/performance/engine.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.table(cases.map(({ cuts, sample, selection, compose }) => ({ cuts, 'sample p95 (µs)': +(sample.p95_ms * 1000).toFixed(2), 'selection p95 (µs)': +(selection.p95_ms * 1000).toFixed(2), 'compose p95 (µs)': +(compose.p95_ms * 1000).toFixed(2) })));
console.log(`Report: ${destination}`);
if (process.argv.includes('--check')) {
  // CPU orchestration should leave most of a 33.3 ms frame for decoding and GPU work.
  for (const c of cases) {
    assert.ok(c.sample_segment_reads <= 64 && c.selection_segment_reads <= 64, `${c.cuts} cuts: timeline lookup exceeds 64 segment reads`);
    assert.ok(c.sample.p95_ms < 0.25, `${c.cuts} cuts: sample exceeds 0.25 ms budget`);
    assert.ok(c.selection.p95_ms < 0.25, `${c.cuts} cuts: selection exceeds 0.25 ms budget`);
    assert.ok(c.compose.p95_ms < 2, `${c.cuts} cuts: composition exceeds 2 ms budget`);
  }
}
