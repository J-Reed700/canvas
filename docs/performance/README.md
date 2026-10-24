# Recorded performance runs

These are measurements from the macOS/Apple M3 Max development host on 24 October 2026. The reports
contain exact workloads, host/runtime metadata and raw timings. They are evidence for these workloads,
not a universal editor frame-rate or export-speed guarantee.

| Report | Meaning |
| --- | --- |
| `engine-before.json` | CPU baseline before replacing linear timeline scans |
| `engine-after.json` | Indexed timeline sampling/selection and composition; checks include a bound on segment reads |
| `studio-before-memory-fix.json` | First five-minute 1080×608 browser soak, which exposed retained render contexts |
| `studio-after-memory-fix.json` | Five-minute 1080×608 run after the fix, on the final studio build |

The browser fixture uses generated moving clips, a focused landscape viewer, repeated look changes
and undo, forced-GC heap snapshots and an actual 720×1280 H.264 export. The screen choice is committed
to history before measurement so undo cannot accidentally change the test's viewer format.

Heap growth is measured from the warmed state. It includes browser/runtime working data and benchmark
bookkeeping; it is not total process or GPU memory. CPU timings are batch-amortized samples and vary
with JIT compilation, scheduling and other activity. The run identifiers and renderer are in the JSON.

See [quality checks and reproduction commands](../QUALITY.md) for coverage scopes and qualification limits.
