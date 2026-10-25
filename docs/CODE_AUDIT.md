# Code smell audit — 24 October 2026

The audit reviewed the current working tree, including the existing playback and thumbnail changes.
Those staged changes were preserved. The work focused on resource ownership, asynchronous state,
validation at external boundaries, duplicated persistence logic, unsafe types and test reliability.
Python server/media/CLI code, studio rendering/state/components, launch scripts and quality configuration
were inspected. The findings below have fixes and regression coverage where behavior changed.

## Findings and fixes

| Finding | Result |
| --- | --- |
| Export textures stayed allocated for every cut until export completion. | Retire textures before uploading the next composition; keep both transition sources and B-roll. A 4,096-cut regression verifies bounded ownership. |
| Failed YUV plane allocation leaked the RGB target and earlier planes. | Release every partial allocation and keep failed replacements out of the texture map, allowing a later retry. |
| Texture uploads restored hard-coded WebGL unpack values. | Restore the previous unpack state in `finally`, including failed uploads. |
| Video retry state lived behind `any` casts, with duplicate timers and no explicit disposal. | Give bank videos concrete metadata, coalesce pending retries, and release timers/listeners with the video. |
| A late cached-thumbnail callback could notify an old owner or remove a newer cancellation. | Make completion and cancellation idempotent for cached loads as well as queued loads. |
| Export request timeouts stopped after receiving headers. | Keep the timeout and abort subscription alive through JSON body consumption. |
| Encoder queue polling left dequeue listeners behind when its fallback timeout won. | Either completion path now releases the listener and timer. |
| A failed older song selection erased a newer selection's features. | Check selection ownership in the failure path before changing state or rebuilding. |
| Saved loops starting at zero were treated as absent and lost their length/cuts. | Accept zero as a valid saved start; distinguish an actual saved start from a new edit's defaults. |
| Auto-frame wrote an old copy of all framing after asynchronous analysis. | Merge only unchanged, still-selected clips; ignore superseded requests and results for another project. |
| JSON endpoints handled malformed input inconsistently, sometimes dropping the connection. | Reject malformed UTF-8/JSON and non-object bodies centrally, before dispatch or side effects. Validate companion fields and proxy ID lists. |
| Frame-batch headers could populate the decoder cache with impossible metadata. | Validate integer bounds, dimensions, requested ranges and byte lengths before accepting a batch. Subject-analysis replies are also checked before use. |
| Library preferences could be truncated by an interrupted write or lose concurrent folder changes. | Share atomic persistence with projects and serialize folder read/modify/write operations. Damaged shapes fall back to an empty configuration. |
| Hidden-clip persistence had the same partial-write and concurrent-update risks. | Write atomically under a dedicated lock and validate stored paths before constructing the set. |
| Damaged project records could break listing or open with mismatched identity. | Validate identity, edit shape, name and timestamps consistently for listing and opening; require the entire ID to match. |
| Cache insertion duplicated eviction logic and double-counted bytes when a producer replaced a direct assignment. | Use one locked replacement routine that subtracts the old entry exactly once. |
| CLI rendering left ffmpeg alive and partial output behind if rendering failed or was interrupted. | Use the encoder's existing context manager so failure and interruption abort the child and remove partial output. |
| Conversion spawn failures left temporary files; failed video opens did not release captures. | Put conversion cleanup around the entire operation and decoder-open checks inside release scopes. |
| Source attribution raised on Windows paths from different drives. | Skip roots without a relative path and continue checking the other library roots. |
| A collapsed viewer could request infinite render dimensions. | Require both viewer dimensions before computing a render size. |
| Composition repeatedly resolved the same look and scanned every cut for per-clip B-roll. | Memoize modulation and resolved parameters within one frame, inspect only visible B-roll layers, and avoid allocating a full library ID list. Regression checks bound look reads on a 4,096-cut timeline and verify immediate in-place edits. |
| Renderer, export progress, drag state, DOM children and CSS variables bypassed type checks. | Add concrete interfaces and narrow browser boundaries; remove the unused import and enforce unused-local/parameter checks. |
| A project-dialog test's save fixture returned another project's name. | Return the metadata belonging to the requested ID, eliminating timing-dependent assertions against an inaccurate server response. |
| Default component-worker concurrency made timed tests fragile under host memory pressure. | Cap the pool at four workers. All 235 component tests and coverage floors pass with the existing timeouts and per-file isolation. |

## Validation

The initial release gate passed strict TypeScript and engine coverage, then failed one project-dialog
assertion because its save fixture returned the wrong project name. New regressions also reproduced
the stale-selection and GPU allocation failures before their fixes.

The final `npm run quality` completed with exit code 0. Its output is retained locally in
`artifacts/audit/quality.log`; detailed coverage and performance reports remain under `artifacts/`.

| Check | Final result |
| --- | --- |
| Production TypeScript | Passed, including strict mode and unused-local/parameter checks. |
| Engine/state tests | 252 passed; 90.16% lines, 89.94% branches and 87.75% functions. |
| Component tests | 235 passed; 92.89% lines, 84.11% branches, 90.58% statements and 91.45% functions. |
| Python | 204 tests run: 203 passed and one expected skip; 91.63% combined statement/branch coverage. |
| Production build | Passed. The existing bundle-size advisory remains: approximately 603 kB JavaScript before gzip, 195 kB compressed. |
| Real Chrome tests | 26 passed, including native-size GPU rendering, moving exports, project persistence and existing controls. |
| Resource retention | Both garbage-collection regressions passed. |
| CPU budgets | Passed for 8, 256 and 4,096 cuts; the final 4,096-cut composition p95 was 0.767 ms against a 2 ms budget. |
| Shell and patch checks | ShellCheck, `bash -n run.sh` and `git diff --check` passed. |

An earlier measured run exceeded the composition budget under host memory pressure. Profiling showed
repeated parameter resolution and allocation; scoped reuse now removes that duplicate work. A separate
regression bounds per-clip look reads rather than relying only on machine-dependent wall-clock budgets.
Targeted failure-path checks also confirmed that video/YUV uploads restore their previous unpack state
and release textures. These timing measurements describe this workload and host, not every GPU or OS.

## Design patterns

The project already uses several appropriate patterns. A pattern is useful when it gives a real
responsibility or variation a clear home; implementing every named pattern would add unnecessary
indirection.

| Pattern | Current use and assessment |
| --- | --- |
| Strategy and registry | Python's `_CUT_MODE_STRATEGIES`, studio effect/transition/velocity registries and pure timeline operations keep selectable algorithms separate from their callers. Keep these data/function based. |
| Observer and external store | Zustand subscriptions, `Transport.subscribe` and history subscriptions let React follow changes without putting per-frame rendering into React state. |
| Facade and pipeline | `Engine` coordinates GPU resources and render pipelines; `VideoBank` owns preview players. This audit narrows the exporter to the engine methods it actually needs. |
| Repository | `ProjectStore` owns project-file operations and `Library` owns folder preferences/scanning. Shared atomic JSON persistence now removes repeated write mechanics. |
| Memento | Undo/redo stores edit snapshots with explicit entry and memory limits. This fits edits that span looks, cuts, LUTs and framing; converting every edit into command objects would be a separate design decision. |
| Dependency injection and adapter | `FrameSource`, `ClipLookResolver`'s catalog and `ThumbnailCache`'s factory/loader accept alternate implementations without involving React or the real decoder. |
| Object pool and bounded cache | Preview players are reused by `VideoBank`; media and thumbnail caches have explicit limits and shared work. Export textures now have similarly bounded lifetimes. |
| Scoped resource ownership | Python encoders use context managers; GPU allocations and browser requests use explicit cleanup scopes. This audit strengthens failure and cancellation behavior. |
| Scoped memoization | Composition shares a look's modulation, camera and finish values within one frame, avoiding repeated work while keeping the next frame responsive to mutable inspector edits. |

The clearest remaining architectural improvement is to extend dependency injection to async controllers:
they currently import the global studio store, while the store imports those controllers. Passing small
store/HTTP/storage/clock interfaces into those modules would remove that cycle and improve test isolation.
This merits a dedicated controller-boundary refactor with compatibility tests, rather than introducing a
general dependency-injection container throughout the UI.

An explicit export state machine becomes useful if export scheduling adds queued jobs, automatic retry
or concurrent jobs. The existing sequential async flow does not need a state-machine library solely to
earn the pattern name. Likewise, another event bus, generic factory hierarchy, service locator or extra
repository layer would duplicate responsibilities already represented here.

## Limits

This is a code review and regression exercise, not proof that every possible input or platform is
defect-free. No dependency-advisory audit or external delivery-specification review was performed.
Legacy saved editor payloads still have dynamic compatibility boundaries; this change does not introduce
a new project-file schema or migration. Existing orchestration modules were kept together where a split
would only move code without clarifying ownership. Native testing on additional operating systems and
GPUs remains separate from the local browser checks and simulated Windows encoder failures.
