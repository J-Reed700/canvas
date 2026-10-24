# Downbeat professional studio blueprint

This implementation follows the blueprint supplied in the project conversation. The earlier standalone
research report was not present in this checkout. This file records the adopted scope, technical decisions,
and validation rather than presenting that earlier research as a new audit.

## Product decisions

| Capability | Decision | Why it belongs in Downbeat |
| --- | --- | --- |
| Route attack, decay, gate and sidechain ducking | Adopt | A musician can shape a kick response or pull an effect back under vocals without adding a node graph. |
| Integrated audio and bass phase clocks | Adopt | Effects can accelerate through energetic passages without reversing when the energy falls. A normalized loop phase keeps cyclic motion periodic. |
| 3D `.cube` grades and compact scopes | Adopt | Creative color transforms become portable project assets, with feedback from the finished image. Preview and export share the same finishing shader. |
| Block parameter and macro overrides | Adopt | One cut can have its own treatment while the main look still controls untouched parameters. |
| Native ProRes delivery and opening-frame comparison | Adopt | Delivery can meet a distributor's requested format without an extra lossy intermediate. QA compares against an actual selected reference. |
| Platform composition guides and vertical social export | Adopt | Artists can compose for the interfaces around their art and make social videos without Spotify's short-loop constraints. |
| Optional promo text | Adopt for social copies | Promotional messaging belongs on the social version, with the clean motion-art master available separately. |
| A wholesale backend rewrite | Do not adopt | Rendering already runs in WebGL2 and encoding in ffmpeg. Rewriting orchestration would not move those expensive operations. |
| A general-purpose VJ node editor, live show-control stack, or AI-generation service | Outside this release | Each is a separate product commitment; the current work concentrates on editing, rendering, reliable files and delivery. |

## Python and reliability

Keep Python for local orchestration, media analysis and file management. The browser runs GPU shaders;
ffmpeg performs encoding; NumPy and OpenCV do numerical/media work in native code. Language choice does
not guarantee reliability. The relevant work is to bound memory and concurrency, make ownership explicit,
time-bound child processes, and test failure paths.

The hardening scope covers cache invalidation and concurrent cache misses; raw export session ownership;
bounded upload bodies; subprocess timeouts, pipes and cleanup; and hardware encoder availability. Tests
must exercise failures and races rather than merely assert that a lock or timeout exists.

Uploads are read in 1 MiB chunks; JSON bodies are capped at 16 MiB and project edits at 8 MiB. At most four
export sessions run concurrently. Accepted sockets have a 120-second inactivity timeout, and server
maintenance aborts abandoned exports after 15 minutes without activity while leaving an in-flight write
alone. Cache misses share one producer; media results include the source file's modification time and size.
Long audio-curve extraction uses 1024-frame FFT batches rather than a whole-export working matrix.

GPU target allocation now checks the device's texture limit and framebuffer completeness. Partial
allocations are released on failure. Transition, B-roll and effect scratch buffers allocate only when
needed; an unused half-float buffer at 3840×3840 would otherwise occupy about 112 MiB.
Feedback histories have a 512 MiB budget. Inactive histories are released consistently at preview and
export resolutions; an edit requiring too many simultaneous high-resolution histories gets an explicit
error instead of silently losing active feedback or exhausting the GPU.

## Color workflow

In **Layers → Color studio**, import a 3D-only `.cube` file (2–65 points per axis, up to 24 MB), then set
LUT mix. The parser checks sample count, finite values, domain bounds and unsupported shaper directives.
Packed float32 data is embedded in the edit. WebGL2 samples a bounded cache of RGB16F 3D textures with
trilinear interpolation. No CPU color loop runs per video frame.
The 8 MiB edit limit also applies to embedded grades: several large 65³ LUTs across clip looks can reach
that limit. A 33³ LUT is considerably smaller. Invalid restored LUTs are removed before rendering, and
undo history has a 32 MiB bound.

The LUT is display-referred: it follows the existing grade and precedes vignette/grain. It is suitable for
creative SDR grades, not an automatic camera-Log color-management system. The renderer remains opaque and
8-bit at its final output. Source frames still come from 8-bit 4:2:0 playback copies, capped at 2560 pixels
on the long edge (still-image conversion is capped at 2160). Native output sizing does not bypass that
source pipeline. ProRes storage cannot recover source detail, manufacture higher precision, or add alpha.

Optional waveform and RGB parade scopes sample the finished preview at five updates per second. They
are disabled by default, stop when hidden, and pause during export. They are grading aids rather than
broadcast measurement instruments.

## Platform guidance

Apple requires tall and square motion assets at 2048×2732 and 3840×3840, permits ProRes or H.264, and
accepts 8–35 seconds. Native square rendering replaces the previous 2048-to-3840 output upscale.
[Apple Video and Audio Asset Guide](https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html)

Opening-frame artwork and the placement of important visual elements need a visual review in addition to
technical checks. The selected-reference comparison is an aid, not a guarantee of distributor acceptance.
[Apple Music Album Motion Guidelines](https://help.apple.com/itc/albummotionguide/en.lproj/static.html)

The preview guides are explicitly approximate. Insets in `safeGuides.ts` are conservative composition
choices, not claims of universal official pixel bounds. Captions, action buttons and crops vary by app,
device and placement. They never burn into exports. Compare against the destination's actual preview.
[Spotify Canvas guidelines](https://support.spotify.com/us/artists/article/canvas-guidelines/),
[TikTok in-feed specifications](https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads),
[YouTube visual guides](https://support.google.com/youtube/answer/16215842),
[Meta creative guidance](https://developers.meta.com/vr/resources/optimize-ad-campaign/)

## Studio workspace

The frontend now uses a neutral graphite shell with restrained violet selection states, a clean canvas
viewer, and a timeline spanning the Library and viewer. Library, Inspector and timeline dividers resize
with a pointer or keyboard and persist locally. Viewer focus (Shift+F) expands the canvas. Frame stepping
and 30 fps timecode support precise review without changing the playback/export renderer.

Commands (⌘K / Ctrl+K) searches real workspace actions and supports keyboard selection, focus trapping
and focus restoration. The Looks gallery searches and filters collections, Layers offers focused Effects
and Color sections, and clip sequencing actions live in a compact menu. The timeline separates source
waveform, video cuts and audio response. Narrow windows stack panels, and reduced-motion preferences
disable decorative motion.

Existing functionality is a release requirement for visual redesigns. Media import, clip selection and
sequencing, framing, timing, modulation, project history, platform previews and exports must remain
available. Controls moved into menus must remain reachable by pointer and keyboard. The browser suite
checks control visibility and hit targets at 1024×768 and 390×844, exercises the compact Sequence menu,
and continues through the existing editing, project and export checks. The source waveform supplements
the original kick, hats and energy timeline overlays.

## Verification

The engineering pass also enables strict production TypeScript, introduces enforceable coverage floors,
and adds `npm run quality` plus a CI workflow. Timeline sampling/selection uses logarithmic lookup;
library lookups share an index; upload results update the library directly, preserving selection and
proxy priority. Clip look policy, upload transport and server serialization have separate boundaries.
The first browser soak exposed retained render contexts; module-scope callbacks and GC regressions fix
that leak. Timeline thumbnails now have bounded ownership and release completed/pending handlers.
See [engineering quality and performance](docs/QUALITY.md) for scopes, reproduction commands and
recorded before/after measurements.

The release checks are Python unit/integration tests, Node engine/state tests, React component tests,
TypeScript plus the production build, and the real Chrome end-to-end suite. The browser suite compiles
all shaders, reads actual GPU pixels to verify LUT application/mix/bypass, draws scopes, and makes real
exports. Delivery tests inspect encoded files with ffprobe, including ProRes profiles and containers.

Verified on the macOS development host on 24 October 2026:

| Check | Result |
| --- | --- |
| Python unit/integration suite | 188 run: 187 passed, 1 expected platform skip |
| Node engine/state tests | 231 passed |
| React component tests | 230 passed across 16 files |
| Chrome end-to-end suite | 25 passed, including bulk import without full-library refreshes, responsive control reachability, sequencing, workspace commands, frame stepping, panel resizing, focus, actual exports, project reload, LUT pixels, scopes and a native 3840×3840 render |
| Render-context lifetime | 2 GC regressions passed, covering main-look and per-clip editing |
| Coverage gates | Engine/state: 89.39% lines / 89.66% branches; UI: 92.77% lines / 84% branches; Python: 90.22% combined statements/branches |
| TypeScript and production build | Passed in strict mode; Vite reports a bundle-size advisory for the 596 kB main chunk |
| Native encoder smoke check | One 3840×3840 frame encoded and probed successfully for H.264, ProRes 422 HQ and ProRes 4444 |
| Diff whitespace check | Passed |

The Python skip is the non-macOS folder-chooser branch: running it on macOS would open the native chooser.
The native encoder checks confirmed `avc1` / `yuv420p`, `apch` / `yuv422p10le`, and `ap4h` /
`yuv444p12le` respectively. The ProRes integration tests additionally verify eight-second repetition,
MOV containers and audio companions that preserve the ProRes video stream.

Reproduce the automated checks with:

```sh
.venv/bin/python -m unittest discover -s tests -v
npm test
npm run build
npm run test:e2e
git diff --check
```

For the complete engineering gate, install the Python development extra and run `npm run quality`.
`npm run perf:studio` separately qualifies the actual preview, memory retention and export workload.

Passing these checks demonstrates the tested behavior; it is not a promise of zero defects, universal
hardware support, or parity with every feature of an established editing/VJ suite. Additional operating
systems and GPU vendors still need their own release qualification.
