# Downbeat Studio guide

This covers every panel and control in the studio and how they connect. If you read one section, make it
[How a canvas is built](#1-how-a-canvas-is-built). The rest is reference.

1. [How a canvas is built](#1-how-a-canvas-is-built)
2. [The screen](#2-the-screen)
3. [A first canvas](#3-a-first-canvas)
4. [Track, tempo and beat grid](#4-track-tempo-and-beat-grid)
5. [Clips](#5-clips)
6. [The timeline](#6-the-timeline)
7. [Looks](#7-looks)
8. [The Layers tab](#8-the-layers-tab)
9. [Modulation](#9-modulation)
10. [Per-clip FX](#10-per-clip-fx)
11. [The Edit tab](#11-the-edit-tab)
12. [Roll, Surprise, Variations and undo](#12-roll-surprise-variations-and-undo)
13. [Preview and transport](#13-preview-and-transport)
14. [Exporting](#14-exporting)
15. [Shortcuts](#15-shortcuts)
16. [Effects](#16-effects)
17. [Rhythms, transitions and speed ramps](#17-rhythms-transitions-and-speed-ramps)
18. [Troubleshooting](#18-troubleshooting)
19. [Notes for developers](#19-notes-for-developers)

## 1. How a canvas is built

A canvas is a 3 to 8 second loop cut to a slice of your song. Three separate parts of the studio decide what
ends up in it:

| Part | Decides | Where you set it |
|---|---|---|
| The edit | Which clip is on screen at each moment, where the cuts fall, which transitions join them | Clips list, timeline, Edit tab |
| The look | What the footage looks like: a stack of effect layers, the camera, and the color grade (Finish) | Looks tab, Layers tab |
| Modulation | How sliders move with the music: kick, snare, tempo clocks, your own envelopes and macros | The ● at the end of each slider, the Modulators card |

Each frame is rendered in this order:

```
  Song slice ──► analysis (kick, snare, hats, bass, energy…) ──┐
                                                              │ modulation
  Clips ──► edit: which clip is on screen at this moment ──┐  ▼
                                                          ├─► Camera (zoom, drift, shake, clip speed)
                                                          ├─► Layers, top to bottom
                                                          ├─► Transition (only during a cut)
                                                          └─► Finish (exposure, contrast, split tone, grain…)
                                                                 │
                                                                 ▼
                                                        preview and export
```

The layers in the Layers tab don't take turns on the timeline. They're stacked, like adjustment layers in a
photo editor, and every enabled layer runs on every frame. The timeline only chooses which footage goes into
that stack at a given moment.

Preview and export use the same renderer, so an export matches the preview frame for frame.

## 2. The screen

```
┌ track · BPM · loop length · look · clip count ································· ?  🎲 Roll ▾  Export ┐
├──────────────┬─────────────────────────────────────────┬───────────────────────────────────────────┤
│ Track        │ Phone preview                           │ Looks | Layers | Edit                      │
│ BPM, grid    │                                         │                                           │
│ Meters       │ Transport bar                           │ Looks:  pick a look                       │
│ Clips        │                                         │ Layers: effect stack, modulators          │
│ Exports      ├─────────────────────────────────────────┤ Edit:   cuts, transitions, direction      │
│              │ Timeline: loop chips, rhythm buttons,   │                                           │
│              │ song waveform, cut lane                 │                                           │
└──────────────┴─────────────────────────────────────────┴───────────────────────────────────────────┘
```

The chips along the top are a summary: track, tempo, loop length, the main look's name and how many clips are
in the edit. On the right, ? lists the shortcuts, 🎲 Roll (D) randomizes the canvas (the ▾ beside it sets what
a roll changes and has Undo last roll), and Export Canvas (E) opens the export sheet.

## 3. A first canvas

1. Add media. Drop video clips, album art (JPG/PNG) and your song anywhere on the window, or use
   + Add clips, art or tracks. The server also loads clips and songs from `~/Downloads`.
2. Choose the song in the Track menu. The studio analyzes its tempo, beats, sections and drum hits when you
   pick it.
3. Choose which part of the song loops. The chips above the timeline (Drop, Peak 2, Intro…) are suggestions.
   You can also drag the lime box on the waveform.
4. Click clips in the Clips list to put them in the edit. The number on each clip is its position, and it's
   the same number (#1, #2…) you'll see on the timeline.
5. Pick a look in the Looks tab, or press D until you like what you see.
6. Adjust things in the Layers tab. Space plays and pauses.
7. Press E, then Render & verify.

## 4. Track, tempo and beat grid

Track menu: pick a song, or "No track (BPM clock)". Without a track the visuals follow a synthetic beat at
the tempo set in the Edit tab, so beat-driven effects still pulse.

The menu lists every song it can find, grouped by where it came from, and has a search box. Arrow keys and
Enter pick a song, and Esc closes the menu. The list is read again each time you open it, so songs you save
while the studio is running show up.

| Group | What's in it |
|---|---|
| Added in the studio | Songs you dropped on the window or added with + Add a song. They're copied to `out/uploads/` and stay in the list after a restart |
| Downloads | Every song at the top level of `~/Downloads` (not its subfolders), skipping files under 250 KB such as alert sounds |
| Your music folders | Folders you added with + Add a music folder, including their subfolders. The subfolder is shown under each song. ✕ stops listing a folder and leaves the files alone |

On a Mac, + Add a music folder opens the system folder chooser. If it doesn't appear, look behind the browser
window, or use Type a path (for example `~/Music`). The folders you add are saved in `out/.library.json`.

WAV, MP3, FLAC, M4A, AAC, AIFF, OGG and Opus all work. Formats that some browsers can't play (M4A, AAC, AIFF,
OGG, Opus) are converted to WAV with ffmpeg the first time you play them, and the 20 most recent
conversions are kept in `out/.audio-cache/`.

BPM: click the number to type a new tempo and press Enter. The tooltip says where the value came from
(detected, from the filename, or set by you). ½× and 2× fix a tempo detected at half or double time. "auto"
appears after you change the tempo and puts the detected value back. Tap (or the T key) sets the tempo from
four or more taps; with a track loaded it applies 1.6 seconds after your last tap.

Beat grid ◂ 0 ms ▸: if cuts land a little early or late against the music, shift the grid 10 ms per click
(1 ms with Shift), up to 250 ms either way. Click the number to reset it.

The six meters (kick, snare, hats, bass, energy, bright) show the values that drive modulation as the song
plays. If a meter sits still, anything modulated by it sits still too.

## 5. Clips

Click a clip to add it to the edit or take it out. Clips in the edit are numbered and listed first; the rest
are dimmed underneath. Drag a numbered clip onto another to change the order.

| Button | Does |
|---|---|
| All | Puts every clip in the library into the edit |
| Solo | Keeps only clip 1 |
| Reverse | Reverses the order |
| Shuffle | Shuffles the order |
| ⌖ Auto-frame subjects | Finds a face or main subject in each clip and centers the 9:16 crop on it |

When per-clip FX is on, each clip gets a small label in its top-right corner: "Main" if it uses the main look,
otherwise the name of its own look. Clicking the label opens that clip's stack in the Layers tab (see
[Per-clip FX](#10-per-clip-fx)).

A pulsing dot on a clip means its playback proxy is still being made. Still images become clips too, and
adding one switches to the Living Cover Art look, which is designed for a single image.

The Exports section below lists your renders. Each one shows whether it passed the format's spec check
(✓ spec, or ✕ and the number of failures), with download links and Reveal in Finder. The search box filters
the list and Browse opens the full library.

## 6. The timeline

The bottom panel shows one pass of the loop, left to right. It's about the edit only; effects don't appear on
it.

```
 Drop  Peak 2  Peak 3  Intro   16 cuts · from 0:27        Hits ½beat Beat ½bar Bar 2bars 3-3-2 Build …
 ▼  ▼          ▼                                    ← suggested loop starts (white triangles)
 ▁▃▅▇▅▃▁▂▃[████]▅▃▂▁▃▅▇▅▃▂▁▂▃▅▃▂                      ← the song; the lime box is the part that loops
 1         2         3         4                     ← bars inside the loop
 ◆#1 ◆#2 ◆#3 ◆#4 ◆#1 ◆#2 ◆#3 ◆#4 ◆#1 ◆#2 …            ← one block per cut
 ~~~^~~~~~~^~~~~~~^~~~~~                              ← kick (red), hats (blue), energy (green)
```

### What #1, #2, #3, #4 mean

Each block is one cut, a stretch of time where one clip is on screen. The number is the clip's position in
the Clips list. With four clips in the edit, cuts are handed out in turn: #1, #2, #3, #4, then #1 again. Sixteen
cuts over four bars means each clip appears four times.

A clip that comes back doesn't repeat itself. Each return picks up later in the footage, and the thumbnail in
the block is the frame that block starts on.

How many cuts you get depends on the rhythm buttons at the top right: Beat cuts on every beat, Bar once a bar,
Hits on the strongest drum hits, and so on (full list in [section 17](#17-rhythms-transitions-and-speed-ramps)).

The diamonds are transitions. Pink ones are animated, and the pink shading shows how long they last; white
ones are hard cuts. The diamond at the far left is the loop seam, where the end of the loop joins the start.

### Where the layers go

On every block. The stack in the Layers tab processes whatever footage the timeline puts on screen, all the
way through the loop.

The one exception is per-clip FX in Custom mode, where a clip can have a stack of its own that only runs
while that clip is on screen. When you open a clip's stack in the Layers tab, the timeline outlines that
clip's blocks, dims the rest, and the header says which clip is highlighted.

### Working with the timeline

| Do this | Where | Result |
|---|---|---|
| Click a loop chip | above the waveform | Moves the loop to that section. [ and ] step through them |
| Click or drag | song waveform | Moves the loop start, snapped to a downbeat |
| Click | cut lane | Moves the playhead |
| Drag a cut line | cut lane, cursor shows ↔ | Moves that cut, snapped to the beat. The rhythm switches to Custom |
| Option-drag | a block | Slips the clip: same timing, different moment of the footage |
| Double-click | a block | Choose the clip, in-point, speed ramp and the transition into that block |
| Click a rhythm button | top right | Re-cuts the loop and drops any cuts you dragged |

## 7. Looks

A look is a saved recipe: the layer stack, camera, Finish grade, cut settings and its own modulators. The Looks
tab has 44 built in, plus any you save. Every card plays a live preview on your own footage.

| Group | How many | What's in it |
|---|---|---|
| Your looks (★) | yours | Saved with ★ Save as look |
| Studio looks | 18 | Restrained designs: Liquid Chrome, Hyperspace, Super 8 Memory… |
| Album art & stills | 8 | For a single image: 2.5D parallax, cover visualizer, sparkle, tape |
| Classic stacks | 18 | Busier 3 to 5 layer stacks from the classic studio |

Clicking a look replaces your layers, camera and Finish. It also replaces your cut settings, unless "Keep my
edit" is ticked in the Edit tab. While you're editing one clip's own stack, clicking a look applies it to that
clip only; a pink banner says so, and Back to main returns to the main look.

← and → step through the list. Variations (M) and Surprise me (R) are covered in
[section 12](#12-roll-surprise-variations-and-undo).

## 8. The Layers tab

### Master card

FX intensity (0 to 150%) scales the whole stack. Under 100% it fades the layers toward the clean footage. Over
100% the layers stay fully on and modulation swings further. Double-click the slider to go back to 100%.

Per clip chooses whether clips share one look or get their own: Same look, Evolve, Look per clip or Custom
(see [section 10](#10-per-clip-fx)). 🎲 Roll FX per clip gives every clip, clip 1 included, a random stack of
its own. Same look on all drops the per-clip looks, and Reset clip N puts one clip back on the main look.

While you're editing a single clip's stack, this card's title changes to "Clip N · look name" with "plays only
on the #N blocks" underneath.

### Color palette

Colors pulled from clip #1. Click a color to tint the canvas with it: the Finish split tone switches to that
hue at 60% strength or more, and any 0 to 1 Hue or Tint slider in the stack you're editing is set to it too.
The color in use is outlined and marked "Tinted". Click the hex code to copy it. Finish is shared by every clip, so the tint
covers the whole canvas. ⌘Z undoes it.

### Modulators

These are modulation sources you control. They do nothing until a slider uses them: click the ● at the end of
a slider and pick one (see [section 9](#9-modulation)). The last lines of the card list what each one drives
right now, for example "Macro A → Liquid Glass · Refraction".

| Modulator | What it is | How to use it |
|---|---|---|
| LFO A, LFO B | A repeating wave you shape yourself. The picture shows one loop, with a line at each bar and a dot at the playhead | Pick a shape (sine, triangle, saw, square, random steps, smooth random), a rate (¼, ½, 1, 2 or 4 bars, or once per loop) and a phase, which sets where in the cycle it starts. The random shapes have a New pattern button. Double-click Phase to reset it |
| Macro A, Macro B | A 0 to 100% knob | Point several sliders at Macro A, then turn it to move them all at once. Double-click resets it to 0 |
| Envelope (whole loop) | A curve across the whole loop, start on the left, end on the right. It wraps around smoothly, so there's no jump at the seam | Drag on it to draw. Presets: Arc, Ramp, Dip, Pulses, Random. Double-click resets to Arc. The white line is the playhead |
| Step sequencer (1 bar) | 16 pads, one per sixteenth note, repeating every bar. A lit pad sends a short hit that fades out | Click pads on and off. Presets: Four, Offbeat, Clave, Rolls, Random. The outlined pad is the step playing now |

Modulators belong to the look you're editing, so each per-clip stack has its own LFOs, macros, envelope and steps.

An LFO always makes a whole number of cycles per loop. If you pick a rate longer than the loop, such as 4 bars on
a 1-bar loop, it plays once per loop instead, and the header says so. Square, saw and random steps change over
3% of a cycle rather than in a single frame.

### The layer stack

The line above the tools says where the stack below it runs, for example "every layer runs on every frame" or
"Clip 2's own stack: runs only while #2 is on screen".

| Tool | Does |
|---|---|
| + Add effect | Opens a menu of all 45 effects, grouped by category |
| 🎲 Random | Adds an effect you don't have yet, slotted in at its usual place in the stack |
| ⇅ Shuffle | Shuffles the order. Order matters, since each layer works on the output of the one above it |
| Clear | Removes every layer. Revert or ⌘Z brings them back |

On each layer card:

| Part | Does |
|---|---|
| Colored dot | The category: Space, Warp, Time, Stylize, Color or Light |
| Switch | Turns the layer on or off without losing its settings |
| ↑ ↓ ✕ | Move up, move down, remove |
| Slider | Drag to set; double-click for the default. On a modulated slider, a thin tick shows where the music has pushed it |
| Option buttons | Pick a mode, e.g. Halftone's CMYK, Ink or Color dots |
| ● | Modulate this slider. Colored when in use; gray when the setting is stepped and can't be modulated |

### Camera

Zoom (1 to 1.8×), Drift, Shake, Sway and Clip speed (0.25 to 2×). Changing clip speed changes how much footage
each cut uses, so the edit is rebuilt. Camera is shared by all clips and only shows when you're editing the
main look.

### Finish

The grade applied after every layer, shared by all clips: Exposure, Contrast, Saturation, Temperature, Tint
(green to magenta), Split tone and Split hue (shadows pushed toward one hue and highlights toward its
opposite), Fade, Halation, Vignette, Grain and Cinema bars. A flash guard on the GPU also limits sudden
brightness jumps between frames.

### Save as look and Revert

★ Save as look adds the current stack, with its camera, Finish and cut settings, to Your looks. Revert puts the
stack back the way it was when you picked or rolled the look. That works for rolled and random looks too, as
long as you haven't reloaded the page since; after a reload, use ⌘Z.

## 9. Modulation

The ● at the end of a slider opens the modulation menu.

| Group | Sources |
|---|---|
| From the song | Kick, Snare, Hats, Bass, Energy, Brightness, Vocals, Presence. With no track loaded these follow the synthetic beat |
| Tempo clocks | Beat pulse, Off-beat pulse, Bar ramp, LFO at ½ bar, 1 bar and 2 bars, Triangle (1 bar), Loop arc, Loop build, Random (per beat) |
| Yours | LFO A, LFO B, Step sequencer, Drawn envelope, Macro A, Macro B |

Pick a source, then set the amount from −1 to +1 (negative flips it). The slider's value becomes:

```
value = slider position + amount × FX intensity × source (0 to 1) × slider range
```

So with an amount of 0.25 on Kick, each kick pushes the slider up by a quarter of its range. Remove
modulation is at the bottom of the menu.

Stepped settings can't be modulated. That covers option buttons and whole-number sliders like Fly / loop or
Repeat, because a fractional value there would make the loop jump at the seam. For the same reason the tempo
clocks and LFO A and B complete a whole number of cycles per loop, the envelope wraps around, and the step
sequencer repeats every bar.

## 10. Per-clip FX

By default one look covers every clip. The Per clip control on the Master card changes that:

| Mode | What happens |
|---|---|
| Same look | Every clip uses the main look |
| Evolve | Clip 1 uses the main look. Each later clip gets a mutated copy of it; Evolve amount sets how different |
| Look per clip | Clip 1 uses the main look. Each later clip gets another look from the library, picked by the edit seed |
| Custom | You choose. Clips with their own stack use it; the rest use the main look |

Each clip's stack is applied to that clip before the transition, so at a cut the outgoing clip, in its style,
blends into the incoming clip, in its style. Camera and Finish always come from the main look, which keeps
the framing and grade consistent across the canvas.

To edit one clip's stack:

1. Switch Per clip to Custom, then click the clip's thumbnail in the strip on the Master card (or the label
   on the clip in the Clips list).
2. The Layers tab now shows that clip's layers. The card title reads "Clip 2 · name" and the timeline
   highlights the #2 blocks.
3. Your changes only show while that clip is on screen, so play the loop or click on a highlighted block.
4. Click Main in the strip to go back to the main stack.

If you move a slider and nothing changes, check the Layers header. If it says "Clip N", you're editing a clip
that isn't on screen at the moment.

After 🎲 Roll FX per clip, every clip has its own stack, so the main stack isn't used anywhere. The line above
the layer tools says so. Reset clip N or Same look on all brings the main look back.

## 11. The Edit tab

| Setting | Does |
|---|---|
| Loop length | 1, 2, 4 or 8 bars. Only lengths between 3 and 8 seconds (Spotify's limits) are available. Whole bars keep beat-synced effects lined up across the seam |
| Cut rhythm | Where cuts fall. Same as the buttons on the timeline |
| Transitions | Which transitions the edit can use. Pools: All, Smooth, Kinetic, Glitch, Hard cuts. Click one to toggle it; double-click to use only that one |
| Transition length | Cut (instant), ¼, ½, 1 or 2 beats |
| Transition order | Cycle through the list in order, or Shuffle (never the same one twice in a row) |
| Clip direction | Forward, Reverse, Alternate (every other cut reversed), Ping-pong, Random |
| Speed ramp | Speed curves locked to the beat. Each one averages out to normal speed, so cut timing doesn't change. Double-click a block on the timeline to ramp only that cut |
| Edit seed | The random seed behind in-points, cut variety and transition picks. ⚄ Re-roll picks a new one |
| Tempo (no track) | The BPM of the synthetic beat when no song is loaded |
| Keep my edit | When ticked, switching looks leaves your cuts and transitions alone |

## 12. Roll, Surprise, Variations and undo

| Tool | Key | What it does |
|---|---|---|
| 🎲 Roll | D | Randomizes the canvas. By default that's the look (a 4 to 6 layer stack), the edit (rhythm, transitions, transition length and order, speed ramp, direction, clip speed, seed, FX intensity) and the per-clip mode. Tick Clip order or Song section under ▾ to roll those as well |
| Undo last roll | Shift+D | Goes back one roll at a time, up to 40 |
| ⚄ Surprise me | R | A random two-layer look: one main effect plus a light or color layer. Like clicking a look, it resets your cuts unless Keep my edit is ticked |
| Variations | M | Six mutations of the current look, playing live. Subtle/Wild sets how far they drift, ⟳ Mutate again deals six more, and clicking one keeps it without touching your edit |
| Undo, redo | ⌘Z, ⇧⌘Z | Undoes nearly any change: layers, sliders, modulation, palette tints, cuts, clip order |

The studio saves your session (clips, look, edit, saved looks, toggles) in the browser and restores it next
time you open it.

## 13. Preview and transport

The phone preview shows what the export will look like. Drag on it to reframe the clip on screen, scroll to
zoom in (up to 3×), and double-click to reset that clip's framing. "Preparing clip…" means a clip is still
loading.

| Control | Does |
|---|---|
| ▶ / ⏸ (Space) | Play, pause |
| 0.58 / 6.36 | Position and loop length, in seconds |
| 1.2 | Bar and beat inside the loop |
| Loop / Listener (L) | Loop plays only the slice of the song behind the canvas. Listener lets the song play on while the canvas loops, the way a listener hears it |
| Off-sync (Listener only) | Starts the canvas at a random offset from the song. Spotify doesn't sync a canvas to the music, so this shows how it looks out of step |
| 1 bar / 2 / 4 / 8 (keys 1–4) | Loop length |
| Player UI (H) | Spotify's player overlay, to check what it covers |
| Safe zones (S) | What Spotify's interface covers (top 14%, bottom 33%) and what tall phones crop (9% each side) |
| Sound | Mute |
| fps | Preview frame rate |

## 14. Exporting

Press E or Export Canvas.

| Format | You get |
|---|---|
| Spotify 9:16 | A silent 3 to 8 second canvas. Sizes: Master 1080×1920, Lite 720×1280, or Spec-literal 608×1080 if Spotify rejects an upload |
| Apple 3:4 | 2048×2732 motion artwork, silent, repeated to at least 15 seconds |
| Apple 1:1 | Rendered at 2048 and delivered at 3840×3840 |
| YouTube 16:9 | A 1920×1080 visualizer with the song |
| Social 1:1 | A 1080×1080 loop, with the song if you want it |
| Cover 3000² | A 3000×3000 sRGB cover JPEG and a square motion preview |

You can also save a copy with the audio slice, make a 15 or 30 second promo with the song (for Reels, TikTok
or Spotify Countdown pages), and have finished files copied to Downloads.

Spotify asks that canvases avoid rapid cuts. The sheet warns you when the shortest cut is under 0.3 seconds or
there are more than 2.5 cuts a second; a slower rhythm like ½ bar or Bar fixes it.

Render & verify renders every frame on the GPU, encodes H.264 in hardware, and checks the file against the
format's spec. The result appears in the Exports list with a pass or fail badge.

The Release pack row makes stills from clip 1 (a 3000² cover, a 2660×1140 Spotify header, a 2560×1440 YouTube
banner, a 2480×520 SoundCloud header) and GIF or WebP loops from your latest render.

Batch has two options. Export 4 rolls renders four random rolls and then returns to your edit. "This look on
all tracks" renders the current look on every song in the library, each at its top loop suggestion, which is
handy for giving a release one visual style.

## 15. Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← → | Previous / next look |
| D, Shift+D | Roll, undo roll |
| R | Surprise me |
| M | Variations |
| E | Export |
| [ ] | Previous / next loop suggestion |
| 1–4 | Loop length: 1, 2, 4, 8 bars |
| T | Tap tempo |
| L | Loop / Listener |
| H | Player overlay |
| S | Safe zones |
| ? | Shortcut list |
| Esc | Close menus and dialogs |
| ⌘Z, ⇧⌘Z | Undo, redo |

| Mouse | Where | Action |
|---|---|---|
| Drag, scroll, double-click | preview | Reframe, zoom, reset framing |
| Double-click | any slider | Reset to default |
| Drag | envelope | Draw |
| Drag | cut line | Move the cut |
| Option-drag | timeline block | Slip the footage |
| Double-click | timeline block | Clip, in-point, speed ramp, transition |
| Drag | clip | Reorder |

## 16. Effects

Layers run top to bottom. Time effects remember earlier frames, so they start fresh whenever the stack
changes.

### Space

| Effect | Does |
|---|---|
| 2.5D Parallax | Fakes depth from brightness or distance to the center and orbits the camera. Made for album art and stills |
| Kaleidoscope | Mirrored polar slices that spin over the loop |
| Mirror | Split, quad or horizon symmetry |
| Infinite Tunnel | Flies forward through a tunnel made from the footage |
| Clone Grid | A mirrored video wall whose rows slide on the beat |
| Fisheye | Barrel lens with colored fringes at the edges |
| Ribbon Split | Strips that slide against each other and swing on the beat |
| Little Planet | Tiny-planet or rabbit-hole remap |
| B-Roll Blend | Lays a second clip over the frame: Screen, Add, Multiply, Overlay, Luma key, Chroma key or Difference |

### Warp

| Effect | Does |
|---|---|
| Liquid Flow | Noise-driven liquid currents |
| Liquid Glass | Refracting glass with color dispersion and highlights |
| Shockwave | Rings that ripple out on the beat, every 2 beats or every bar |
| Vortex | A twist at the center that pulses with the kick |
| Zoom Blur | Radial motion blur on the kicks |
| Gravity Melt | The frame sags and drips, mostly in the highlights |

### Time

| Effect | Does |
|---|---|
| Feedback Trails | Milkdrop-style echoes with zoom, spin and hue drift |
| Chroma Echo | Green and blue trail behind red |
| Slit Scan | A line sweeps the frame and each row keeps the moment it was passed |
| Datamosh Smear | Blocks freeze and smear with the motion, re-rolled every beat |
| Stutter | Beat-locked holds: choppy low frame rate, or a freeze on each beat or kick |

### Light

| Effect | Does |
|---|---|
| Bloom | Glow around the highlights |
| Anamorphic Flare | Horizontal lens streaks |
| God Rays | Light shafts from bright areas |
| Spectral Aberration | Color split across nine wavelengths |
| Light Leak | Film light leaks drifting in from the edge |
| Star Glint | Star spikes on the highlights |
| Tilt Shift | Miniature-style focus band |
| Double Vision | A tinted copy that splits off on every beat |
| Warm Pulse | A warm lift and glow on each hit |
| Beat Shutter | Dims the picture between beats without going black (photosensitivity-safe) |
| Bass Rim | A vignette that tightens on the bass, with a colored rim |

### Stylize

| Effect | Does |
|---|---|
| 1-Bit Dither | Bayer dither through a palette: Ink, Gameboy, Acid, Cyber, Sunset, Blood or Source |
| Halftone | CMYK, ink or color dot screens |
| Pixel Sort | Bright runs smear into sorted streaks |
| Glyph Matrix | The picture drawn in ASCII or matrix characters |
| Data Glitch | Block tears and RGB splits, re-rolled every 16th note |
| VHS Tape | Color bleed, wobble and a rolling tracking band |
| CRT Monitor | Curved glass, scanlines, RGB mask |
| Neon Contours | Glowing edges in rainbow, source color or white |
| Mosaic | Square pixels or round LED dots |
| Frost Mist | Frosted glass with drifting mist |
| Audio Visualizer | Spectrum ring, EQ bars, oscilloscope or horizon pulse drawn over the picture |

### Color

| Effect | Does |
|---|---|
| Gradient Map | Maps brightness through a palette: Thermal, Inferno, Acid, Vapor, Ocean, Gold, Holo, Noir |
| Holographic | Oil-slick shimmer across the highlights |
| Liquid Chrome | Turns the picture into polished, banded metal |
| Hue Orbit | Rotates all hues a set number of times per loop |
| Posterize | Flat, silkscreen-style tone bands |
| Solarize | Highlights fold back into the darks |
| Film Stock | Bleach Bypass, Cyberpunk, Golden Hour, Sepia Noir, Cross Process, Teal & Orange |

## 17. Rhythms, transitions and speed ramps

### Cut rhythms

| Button | Cuts |
|---|---|
| Hits | On the strongest kick and snare hits, at least 2 beats apart, aiming for at least one cut per clip |
| ½ beat | Every eighth note. Fast; expect the rapid-cuts warning |
| Beat | Every beat |
| ½ bar | Every 2 beats |
| Bar | Once a bar |
| 2 bars | Every 2 bars |
| 3-3-2 | Beat 1, the "and" of 2, and beat 4 of every bar |
| Build | A long first cut, then each one half as long as the last, speeding up into the seam |
| Varied | A seeded mix of 1 to 4 beat cuts |
| 1/clip | One cut per clip, evenly spaced |
| 2/clip | Two cuts per clip |
| Custom | Shows up once you've dragged a cut line |

### Transitions

Hard Cut, Light Dissolve, Luma Burn, Zoom Punch, Whip Pan, Whip Sideways, Block Glitch, Datamosh, Shock
Ripple, Iris Bloom, Pixel Melt, Vortex, Prism Split, Light Leak, Shutter Slices, Kaleido Fold and Flow Morph.
The loop seam favors the softer ones so the restart is harder to spot.

### Speed ramps

| Ramp | Feel |
|---|---|
| Constant | Normal speed |
| Surge | A burst on every beat, slow motion in between |
| Swell | Slow on the beat, rushing into the next one |
| Hold & jump | Holds for half a beat, then plays at double speed |
| Wave | Speeds up and slows down every two beats |
| Bar ramp | Slow motion that speeds up through the bar |

## 18. Troubleshooting

### I moved a slider and the preview didn't change

Most often you're editing a clip's own stack while another clip is on screen; the Layers header will say
"Clip N". Play the loop or click on a highlighted block. Otherwise check that the layer is switched on, that
FX intensity isn't near 0%, and that a layer above it isn't covering the picture completely (Glyph Matrix or
Liquid Chrome at full mix, for example).

### The LFOs, macros, envelope or step sequencer don't do anything

They only affect sliders pointed at them. The bottom of the Modulators card lists what each one drives. To
connect one, click a slider's ● and pick it.

### A modulated slider hardly moves

Raise the amount in the ● menu, push FX intensity past 100%, or check that source's meter. A quiet hi-hat
won't move much on Hats.

### The color palette tint is faint

It sets the Finish split tone to 60%. Raise Split tone in the Finish card, or add a Gradient Map layer for a
stronger recolor.

### Revert says there's no saved original

The look came from your last session, so the studio doesn't know how it started. Use ⌘Z, or pick the look
again in the Looks tab.

### Cuts land early or late

Nudge the beat grid in 10 ms steps, and check the tempo wasn't detected at half or double speed (½× or 2×).

### Some loop lengths are grayed out

At this tempo they'd fall outside Spotify's 3 to 8 second range.

### A clip says "Preparing clip…" or has a pulsing dot

Its playback proxy is still being built. Big 4K files take a while.

## 19. Notes for developers

- `compose(ctx, t)` in `downbeat/studio/composer.ts` turns the look, the edit, the audio and a time into
  one frame for the engine. Preview, look thumbnails, variations and export all call it, which is why export
  matches the preview. Keep it the only place frames are built.
- Animated shader terms have to complete whole cycles per loop or follow the beat, and stepped (integer)
  parameters are never modulated. Otherwise the loop jumps at the seam.
- Looks are edited in place. The render loop reads the look object every frame, so edits reach the preview
  immediately, but React can't detect a change to an object it already has. After an in-place edit, call
  `touch()`, which bumps `version`; components that display look data call `useVersion()` so they re-render.
  `useStudioStore.setState({})` does not re-render anything. That was why the Layers and Modulators controls
  looked dead.
- Session state is saved to `localStorage` under `downbeat.studio.v1`. Undo history is kept in memory: 100
  steps, with a snapshot taken 350 ms after each change.
- Per-clip stacks are rendered into `frame.pre`, before the transition. Camera and Finish always come from the
  main look.
