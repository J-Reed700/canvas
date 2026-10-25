# Engineering quality and performance

This document describes enforced checks and measured workloads. It does not certify that every input,
platform or device is defect-free, or that every possible optimization has been exhausted.

## Run the release checks

Use Node 26 (`.nvmrc`), the project's Python environment, ffmpeg and Chrome/Chromium. Install the optional
Python development dependency once, then run the gate:

```sh
.venv/bin/python -m pip install -e '.[dev]'
npm ci
npm run quality
```

On Windows, use `.venv\Scripts\python.exe` for the installation command. `scripts/python.mjs` selects
the project's interpreter for npm commands; `DOWNBEAT_PYTHON` can select another interpreter explicitly.

The gate runs strict production TypeScript checks, engine/state coverage, UI coverage, Python coverage,
the production build, real Chrome editing/project/export regressions, and CPU performance budgets.
An absent browser, ffmpeg or production build **fails** the gate; it cannot report success after skipping
the browser checks. The ordinary `npm test` and `npm run test:e2e` commands remain available separately.

Component coverage uses at most four workers to bound memory use during full-layout tests. Per-file
isolation, test timeouts and coverage thresholds remain enforced.

The performance gate also runs two garbage-collection regressions. Retired render contexts must be
collectible while the current preview remains active, for both main-look and per-clip editing modes.

`.github/workflows/quality.yml` runs the same gate on Ubuntu. That workflow has been added locally;
a successful local run does not imply that a GitHub-hosted run has already executed.
Actions are pinned to commits resolved from their v7 tags. Inputs follow the official
[checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node),
[setup-python](https://github.com/actions/setup-python) and
[upload-artifact](https://github.com/actions/upload-artifact) documentation.

## Coverage scopes and minimums

| Suite | Scope | Enforced minimums |
| --- | --- | --- |
| Node | Engine, state, canvas and library modules loaded by the engine tests | 89% lines, 89% branches, 86% functions |
| Vitest | All component sources, `App.tsx` and workspace state | 92% lines, 90% statements, 83% branches, 90% functions |
| Python | All `downbeat` Python modules | 90% combined statement/branch coverage |

These scopes use different instrumentation and must not be added or averaged into a product-wide score.
In particular, the UI figure is not a claim that the UI tests alone cover the entire renderer/backend.
Browser assertions verify actual WebGL pixels, media movement, generated files and interaction; they do
not currently contribute to a line-coverage percentage. Python branch coverage is separately visible in
the JSON report; a 90% combined score does not mean 90% of branches were exercised.

Component HTML/JSON and Python JSON coverage reports are written beneath `artifacts/coverage/`. Engine
coverage appears in the command output. `vitest.config.ts`, `.coveragerc` and `package.json` define the
minimums. The minimums are regression floors, not targets that justify superficial tests or exclusions.

## Architecture boundaries

- `server/payloads.py` constructs HTTP media representations. The HTTP handler routes requests and
  streams their bodies; it no longer builds media listings by iterating live dictionaries.
- `StudioState.snapshot()` copies collections under the state lock, then serializes outside it. A slow
  proxy-status lookup cannot hold the state lock while uploads or exports need to record a result.
- `lib/mediaClient.ts` owns upload transport, validation and error normalization. Editor actions retain
  selection, automatic cover-art looks and song selection. Upload replies carry the imported item's
  metadata; an older server triggers one reconciliation per batch instead of one per file.
- `state/clipLooks.ts` resolves per-clip/per-cut look policy independently of React, HTTP and the GPU,
  with an injectable look collection. The store coordinates this policy with the existing editor.
- `state/mediaIndex.ts` shares indexed lookups for an immutable library snapshot. Weak keys allow old
  snapshots to be collected. Clip-duration maps discard entries when the edit no longer uses them.
- Timeline thumbnails use a 512-image LRU cache. Eviction releases the source and pending handlers;
  completed loads release their redraw closure instead of keeping an earlier edit alive.
- Rendering stays in WebGL2 and encoding stays in native codecs/ffmpeg. Bounded caches, shared in-flight
  work, per-session locks and explicit subprocess ownership handle the expensive resource boundaries.

Strict mode now checks production code, including concrete engine, video-bank, parameter-holder and
composed-frame interfaces. Unused locals and parameters also fail the production check. The
[code smell audit](CODE_AUDIT.md) records additional resource, async-state and persistence regressions.
Some dynamic boundaries still use explicit `any`; strict mode does not turn
those into validated data automatically. Central orchestration modules still exist. New abstractions
should separate actual responsibilities and be tested through observable behavior; applying a pattern
name is not a substitute for that work.

## Preserve existing functionality

The existing editor/browser regressions remain release checks. New checks cover transition and loop-seam
equivalence against the previous linear sampler, large timelines, import failures and legacy replies,
incremental metadata updates, selected-clip/proxy order, stale duration cleanup, and concurrent snapshots.
The real-browser suite imports two moving videos and checks metadata, existing selection and the absence
of full-library refreshes. A disconnected client after a committed upload cannot delete the registered file.

The first five-minute soak exposed a render-context retention leak even though the functional tests
passed. A rebuild created callbacks in a scope shared with the previous store state. Moving those
callbacks to module scope made retired contexts collectible. The GC regressions fail before that fix
and pass afterward; the browser before/after reports record its effect on retained memory.

## Reproduce performance measurements

```sh
npm run perf:check
npm run perf:studio
```

The browser command builds the current studio first, and records the module URL actually loaded by Chrome.

The CPU benchmark exercises 8, 256 and 4096 cuts in a ten-minute timeline with deterministic random seeks,
mixed transitions and actual composition/modulation logic. It reports batch-amortized median/p95 times,
checks CPU budgets and limits timeline sampling/selection to 64 segment reads. The access bound catches
a return to linear scanning even when a fast machine would still pass a wall-clock budget.

The browser benchmark creates a temporary home and library, opens the actual built studio, plays a
focused landscape preview, changes the look and undoes it every 250 ms, captures forced-GC heap snapshots,
and makes a real 720×1280 H.264 export. It records the actual preview dimensions, GPU renderer, browser
scheduling intervals, timecode update intervals, runtime errors, playback-player count and export checks.
Its minimum qualification budgets are recorded in the JSON alongside the observations.

The default soak is 60 seconds. For longer runs, set `DOWNBEAT_SOAK_SECONDS` (10–3600), for example:

```sh
DOWNBEAT_SOAK_SECONDS=300 npm run perf:studio
```

In PowerShell, set `$env:DOWNBEAT_SOAK_SECONDS = '300'` before the command. Reports default to
`artifacts/performance/engine.json` and `artifacts/performance/studio.json`; the `DOWNBEAT_PERF_REPORT`
and `DOWNBEAT_BROWSER_PERF_REPORT` variables can select other destinations.

RAF/timecode timings include scheduling and are not GPU timer-query measurements. JavaScript heap
snapshots do not measure total process, decoder or GPU memory. The fixture clips are generated small
sources, not a 4K camera-media qualification pack. A five-minute run is useful retention evidence;
multi-hour sessions and additional operating systems/GPUs still require their own qualification.

## Recorded baseline

The checked-in `docs/performance/` reports record the development host, workload and measurements from
24 October 2026. They are a reproducible reference, not a universal frame-rate or export-speed promise.

Both browser runs used the same 1080×608 viewer for 300 seconds and completed 1,193 look-change/undo
cycles. The final build also passed the ordinary release gate and a fresh benchmark-command smoke run.

| Observation | Before | After |
| --- | --- | --- |
| Retained JS heap growth after warm-up | 14.86 MiB | 1.17 MiB |
| Preview RAF interval, p95 | 16.7 ms | 16.7 ms |
| Timecode update interval, p95 | 34.1 ms | 34.1 ms |
| Moving 720×1280 H.264 export, one measured run | 2.93 s | 3.66 s |
| 4096-cut timeline sample, median CPU time | 9.30 µs | 0.37 µs |
| 4096-cut segment selection, median CPU time | 15.55 µs | 0.21 µs |

The retained-growth reduction is about 92% in this workload. The GC regressions independently verify
that retired contexts are collectible. The export timings are individual observations, not evidence
of an export speedup; scheduling, codec startup and other host activity affect them. Neither export
failed its media QA, and both remained within the recorded budget.

Local release results: 188 Python tests run (187 passed, one expected platform skip), 231 engine/state
tests passed, 230 component tests passed, 25 browser checks passed, two GC regressions passed, and strict
TypeScript plus the production build passed. Coverage was 89.39% lines / 89.66% branches for the Node
scope, 92.77% lines / 84% branches for the UI scope, and 90.22% combined statements/branches for Python
(93.04% statements, 78.68% branches). Vite still reports a size advisory for the 596 kB main JavaScript
chunk; it is not hidden or treated as a build failure.
