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
13. [Projects](#13-projects)
14. [Preview and transport](#14-preview-and-transport)
15. [Exporting](#15-exporting)
16. [Shortcuts](#16-shortcuts)
17. [Effects](#17-effects)
18. [Rhythms, transitions and speed ramps](#18-rhythms-transitions-and-speed-ramps)
19. [Troubleshooting](#19-troubleshooting)
20. [Notes for developers](#20-notes-for-developers)

## 1. How a canvas is built

A canvas is a loop cut to a slice of your song: 3 to 8 seconds for a Spotify Canvas, or as long as the whole
song for a visualizer. Three separate parts of the studio decide what ends up in it:

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
┌ downbeat · project · track ··········· Commands · Undo/Redo · Remix · Export ┐
├────────────────────┬─────────────────────────────────┬─────────────────────┤
│ Library            │ Viewer · shape · guides · Focus │ Inspector           │
│ Audio, tempo, grid │                                 │ Looks | Layers | Edit│
│ Clips              │ Canvas                          │                     │
│ Exports            │ Timecode · transport · loop      │ Active look/clip    │
├────────────────────┴─────────────────────────────────┤ Effects and color   │
│ Timeline · song waveform · video cuts · audio        │                     │
├──────────────────────────────────────────────────────┴─────────────────────┤
│ Local workspace · clips · look                 format · dimensions · fps   │
└────────────────────────────────────────────────────────────────────────────┘
```

The button next to the Downbeat name is the open project and whether it's saved; click it for
[Projects](#13-projects). On the right, Commands (⌘K, or Ctrl+K) searches workspace actions, ↶ and ↷ undo
and redo your last change, ? lists shortcuts, Remix (D) randomizes the canvas, and Export (E) opens the
export sheet. The arrow beside Remix chooses what a roll changes and offers Undo last roll.

Drag the dividers to resize the Library, Inspector and timeline. Double-click a divider to reset it; a
focused divider also accepts arrow keys, Shift+arrow for larger steps, and Home to reset. Sizes stay in
this browser. Focus viewer (Shift+F, or the expand icon) gives the viewer the workspace; Escape restores
the panels. Commands also offers Reset workspace layout. Narrow windows stack the panels vertically.

The Inspector's Looks gallery has search and collection filters. In Layers, All, Effects and Color switch
between the full stack and focused editing sections. The footer keeps the current format and output
dimensions visible.

## 3. A first canvas

1. Pick a folder. The first time you open the studio it shows one button, Pick a folder. Choose the folder
   your clips are in, and the studio lists its videos and songs, puts up to five clips in the edit and picks
   the newest song. To add files from elsewhere, drop video clips, album art (JPG/PNG) or songs anywhere on
   the window, or use Import in the Library.
2. Choose the song in the Track menu if it isn't the one you want. The studio analyzes its tempo, beats, sections and drum hits when you
   pick it.
3. Choose which part of the song loops. The chips above the timeline (Drop, Peak 2, Intro…) are suggestions.
   You can also drag the violet loop range on the waveform.
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
| Your folders | One group for each folder you picked, including its subfolders, skipping files under 250 KB such as alert sounds. The subfolder is shown under each song. ✕ stops listing the folder's songs and videos and leaves the files alone |

+ Add a folder lists a folder's songs here and its videos in Clips. On a Mac it opens the system folder
chooser. If that doesn't appear, look behind the browser window, or use Type a path (for example `~/Music`).
The folders you add are saved in `out/.library.json`.

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
| Import | Copies video clips, images or songs into the studio (`out/uploads/`). Dropping them on the window does the same. Videos the browser can't play, such as .avi, .mts or .wmv, are converted to .mp4 as they're added |
| + Folder | Lists the videos and songs in a folder and its subfolders, the 50 newest videos from each folder. The files stay where they are |
| Sequence → All | Puts every loaded clip into the edit. Videos that aren't loaded yet stay out. With nothing loaded, it starts on up to five clips, stock footage first |
| Sequence → Stock | Shows when the library has stock footage. Swaps the edit for up to five stock clips |
| Sequence → Solo | Keeps only clip 1 |
| Sequence → Reverse | Reverses the order |
| Sequence → Shuffle | Shuffles the order |
| ⌖ Auto-frame subjects | Finds a face or main subject in each clip and centers the crop on it |

When per-clip FX is on, each clip gets a small label in its top-right corner: "Main" if it uses the main look,
otherwise the name of its own look. Clicking the label opens that clip's stack in the Layers tab (see
[Per-clip FX](#10-per-clip-fx)).

Only clips that have been in the edit are loaded. Each gets a playback proxy, and a spinning ring means it's
still being made. The other videos from your folders are dimmed with a dashed border. Hover over one and click
+ Add (or tap it) to put it in the edit, which starts its proxy. Still images become clips too, and
adding one switches to the Living Cover Art look, which is designed for a single image.

### Finding a clip

The search box above the clips narrows them by file name, folder or size (`1920x1080`, or Vertical,
Landscape and Square). The chips under it show only the clips in the edit, the videos or the stills, and the
count next to Clips then says how many are shown. Esc in the search box clears it. The list here always keeps
the edit's order, so the numbers and dragging still work while it's narrowed.

Browse opens the clip library, built like the exports library: a card for each clip with its length, size and
folder, the same search and chips, and a sort (Folder order, In the edit first, Name, Longest, Shortest).
\+ on a card adds the clip to the edit and ✓ takes it out, without moving the card. Click a card to play the
clip and see its details. A clip that isn't loaded shows its first frame until you add it. From there you can
add it or take it out, open its effects when per-clip FX is on, reveal it in the Finder, or remove it from the
library. ← and → step through clips, / jumps to the search box, and Esc goes back to the cards, then closes.

The Exports section below lists your renders. Each one shows whether it passed the format's spec check
(✓ spec, or ✕ and the number of failures), with Reveal in Finder and a Delete button that asks for a second
click. An export made with a promo copy also has a ♫ button that downloads the promo with the song. The search box and the kind chips (Canvas, Apple, YouTube and so on) filter the list, and Browse opens
the full library. In the library, ← and → step through exports, / jumps to the search box and Esc closes it.

## 6. The timeline

The bottom panel shows one pass of the loop, left to right. It's about the edit only; effects don't appear on
it.

```
 Drop  Peak 2  Peak 3  Intro   16 cuts · from 0:27        Hits ½beat Beat ½bar Bar 2bars 3-3-2 Build …
 ✂ Split  Repeat  Put a clip in  Delete                          Snap  Beat ½ ¼ Off
 ▼  ▼          ▼                                    ← suggested loop starts (white triangles)
 ▁▃▅▇▅▃▁▂▃[████]▅▃▂▁▃▅▇▅▃▂▁▂▃▅▃▂                      ← the song; the violet range is the part that loops
 1         2         3         4                     ← bars inside the loop
 ◆#1 ◆#2 ◆#3 ◆#4 ◆#1 ◆#2 ◆#3 ◆#4 ◆#1 ◆#2 …            ← one block per cut
 ~~~^~~~~~~^~~~~~~^~~~~~                              ← source waveform, kick (red), hats (blue), energy (green)
```

### What #1, #2, #3, #4 mean

Each block is one cut, a stretch of time where one clip is on screen. The number is the clip's position in
the Clips list. With four clips in the edit, cuts are handed out in turn: #1, #2, #3, #4, then #1 again. Sixteen
cuts over four bars means each clip appears four times.

A clip that comes back doesn't repeat itself. Each return picks up later in the footage, and the thumbnail in
the block is the frame that block starts on.

How many cuts you get depends on the rhythm buttons at the top right: Beat cuts on every beat, Bar once a bar,
Hits on the strongest drum hits, and so on (full list in [section 18](#18-rhythms-transitions-and-speed-ramps)).
When the rhythm gives fewer cuts than there are clips, the longest cuts are split in two until every clip has
one. "Show every clip at least once" in the Edit tab turns that off.

The diamonds are transitions. Violet ones are animated, and the violet shading shows how long they last; white
ones are hard cuts. The diamond at the far left is the loop seam, where the end of the loop joins the start.
Each cut has its own length. Drag the edge of the violet shading to change it, or set it in the segment menu.
A transition can use up to 90% of the shorter block on either side, so two transitions never overlap.

With Loop set to Rebound in the Edit tab, the cuts fill the first half of the lane and a dashed violet line marks
the middle. The second half plays the same blocks backward, so it's drawn as a dimmed mirror of the first. Edit
the blocks in the first half; the mirror follows. There's no diamond at the seam, because the footage runs
back into its own first frame there.

### Where the layers go

On every block. The stack in the Layers tab processes whatever footage the timeline puts on screen, all the
way through the loop.

The exceptions are the per-clip modes. In Evolve and Look per clip, clip 1 plays the Layers stack and the
later clips get a mutation of it or a different studio look. In Custom, a clip can have a stack of its own that
only runs while that clip is on screen. When you open a clip's stack in the Layers tab, the timeline outlines that
clip's blocks, dims the rest, and the header says which clip is highlighted.

### Working with the timeline

| Do this | Where | Result |
|---|---|---|
| Click a loop chip | above the waveform | Moves the loop to that section. [ and ] step through them |
| Click or drag | song waveform | Moves the loop start, snapped to a downbeat |
| Click | cut lane | Moves the playhead and selects the block, which gets a violet outline |
| Drag a cut line | cut lane, cursor shows ↔ | Moves that cut, snapped to the Snap setting (the beat at first). Hold Shift to put it anywhere. The rhythm shows Custom |
| Drag the edge of the violet shading | cut lane, cursor shows ⇹ | Sets how long that one transition lasts, in quarter beats. Hold Shift for any length |
| Option-drag | a block | Slips the clip: same timing, different moment of the footage |
| Double-click, right-click, or long-press on a touch screen | a block | Opens the segment menu. Enter, the ✎ Edit segment button above the timeline and the ✎ Edit chip on the selected block open it too. It has Split, Repeat, Put a clip in and Delete for that block, then Timing (see [Moving a cut off the bar lines](#moving-a-cut-off-the-bar-lines)), then the clip, in-point (click a frame in the filmstrip or drag the slider), direction, speed ramp, the transition into that block and its length, and its framing (see [Framing one segment](#framing-one-segment)). A violet dot marks what you've set, and Back to auto clears it. ‹ › or ← → move to the next block, and ▶ Play the cut plays the transition into it. When the menu is taller than the window it scrolls, with "More below" at its bottom edge, and its title row stays at the top |
| Click a rhythm button | top right | Re-cuts the loop and starts the cuts over, dropping any you moved, split or added |

### Cutting blocks by hand

Select a block, then open **Edit → Block look** to give that cut its own macros, camera, Finish or effect
parameters. Check the setting you want to override, then adjust it. Unchecked settings keep following the
look. **Use look for all** clears the block's look overrides. Splitting a block preserves its treatment on
both halves. Layer overrides apply to the matching effect at that stack position; changing the effect does
not apply the old effect's values to its replacement.

The buttons under the rhythm buttons edit the blocks. Each one works on the selected block, or on the block
under the playhead when nothing is selected, and each is one ⌘Z step.

| Button | Key | Does |
|---|---|---|
| ✂ Split | B | Cuts the block under the playhead in two, on the nearest snap line. Nothing changes on screen: the second half carries on with the same footage, speed ramp, direction and camera move, across a hard cut. Change either half afterwards |
| Repeat | ⌘D | Cuts the block in half and plays its first half twice, a stutter on the beat |
| Put a clip in | | Pick a clip. It plays from the playhead to the next cut, from footage the edit hasn't shown yet when the clip has some, and takes a transition from the pool |
| Delete | Delete | Removes the block. The block before it plays on to the next cut, so every other cut stays on its beat. Deleting the first block makes the next one start the loop. The last block can't be deleted |
| Snap: Beat, ½, ¼, Off | N | Where Split, Put a clip in and dragged cut lines land |

The segment menu has the same four actions for its own block. Its Split cuts at the playhead when the playhead
is in that block, and in the middle otherwise; its Put a clip in fills the second half.

A hand-cut edit keeps going through changes to the tempo, the beat grid, the transitions the edit uses and
their order, the default transition length, clip speed, direction and speed ramp, and a Remix that only
changes the look. It starts over when the cuts would no longer make sense: see the list in
[Where each clip starts](#where-each-clip-starts).


### Moving a cut off the bar lines

The Timing section at the top of the segment menu shows the segment zoomed in, with a bar either side. Bar numbers run along the top, and the violet bands are the transitions.

- Drag the white handle on either cut line to move that cut. It snaps to the grid you pick with Snap (Beat, ½, ¼ or Off). Hold Shift to place it anywhere.
- Starts and Ends have ‹ › buttons that move a cut one step of the grid. The readout says where it sits, such as "Bar 2, beat 3½".
- Drag the edge of a violet band to change how long that transition lasts, or pick a length under Transition length.
- Click the strip to move the playhead there. Double-click it to split the segment at that point.

The cut at the start of segment 1 is the loop seam. It stays put, so pick another loop to move it.

### Where each clip starts

Each block plays its clip from an in-point, the moment of the footage the block starts on. The studio picks
them for you:

- A clip's first block starts at a random point, early enough that the footage lasts through the block and
  its transition. The pick stays in the first 60% of that range.
- When the clip comes back, its next block starts half a second after the last one's footage ended. If that
  wouldn't leave enough footage, it starts at a random point early in the clip instead.
- The picks come from the edit seed in the Edit tab, so they stay the same every time you play, export or
  reopen the project. ⚄ Re-roll in-points & order picks new ones for every block.
- Only the first 60 seconds of a clip are used, because its playback copy stops there. If the part you want
  is later in a long video, trim the file first.

To pick one yourself, double-click the block and drag the In-point slider. The playhead jumps to the block so
you can see the frame, and the slider stops where the block would run out of footage. The menu opens beside the
preview when the window has room for it. When it doesn't, as on a phone, the menu shows a live copy of the
preview at its top. You can also Option-drag
the block: drag right for an earlier moment, left for a later one. The cuts stay where they are.

A reversed block (Clip direction set to Reverse, Alternate or Random) plays backward and ends on its in-point.
A Ping-pong block starts and ends on it.

The in-points you set, any clip, speed ramp, transition or framing you picked for a single block, and any
cuts you moved, split or added, are cleared when you:

- add, remove or reorder clips, including All, Solo, Reverse and Shuffle
- click a rhythm button
- change the edit seed or click ⚄ Re-roll in-points & order
- Remix with Edit, Clips or Loop ticked
- change the loop length or move the loop, or switch it between Repeat and Rebound
- switch songs
- click a look or ⚄ Surprise me, unless Keep my edit is ticked

⌘Z brings them back. Changing which transitions the edit uses keeps what you set: a block you gave its own
transition keeps it, and the rest pick from the new pool. Set up the clips and the rhythm first, then cut and
pick in-points.

## 7. Looks

A look is a saved recipe: the layer stack, camera, Finish grade, cut settings and its own modulators. The Looks
tab has 44 built in, plus any you save. Every card plays a live preview on your own footage.

| Group | How many | What's in it |
|---|---|---|
| Your looks (★) | yours | Saved with ★ Save as look |
| Studio looks | 18 | Restrained designs: Liquid Chrome, Hyperspace, Super 8 Memory… |
| Album art & stills | 8 | For a single image: 2.5D parallax, cover visualizer, sparkle, tape |
| Classic stacks | 18 | Busier 3 or 4 layer stacks from the classic studio |

Clicking a look replaces your layers, camera and Finish. It also replaces your cut settings, unless "Keep my
edit" is ticked in the Edit tab. While you're editing one clip's own stack, clicking a look applies it to that
clip only; a highlighted banner says so, and Back to main returns to the main look.

← and → step through the list, and the gallery scrolls to keep the current look in view. The cards keep
playing while the preview is paused.

The current look is highlighted in the gallery until you change its layers, camera, Finish or modulators.
After that you're playing your own version, so nothing is highlighted. Revert, or clicking the look again,
brings the original back. Changes in the Edit tab don't count.

Variations (M) and Surprise me (R) are covered in [section 12](#12-roll-surprise-variations-and-undo).

## 8. The Layers tab

Click a card's header, or the ▾ at its right, to fold it up. The switch and buttons in the header don't fold it.

### Master card

FX intensity (0 to 180%) scales the whole stack. Under 100% it fades the layers toward the clean footage. Over
100% the layers stay fully on, their strength settings (amount, intensity, mix, glow, twist and the like) are
multiplied by the same factor up to each slider's maximum, and modulation swings further. Settings that shape
an effect rather than set its strength, such as kaleidoscope slices or a zoom, stay where they are. At 150%, a
Bloom set to 0.5 glows at 0.75. Double-click the slider to go back to 100%.

Per clip chooses whether clips share one look or get their own: Same look, Evolve, Look per clip or Custom
(see [section 10](#10-per-clip-fx)). Roll FX per clip gives every clip, clip 1 included, a random stack of
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
| + Add effect | Opens a menu of all 52 effects, grouped by category |
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
| ● | Modulate this slider. Colored when in use. Stepped sliders and option buttons have none, since they can't be modulated |

### Camera

Zoom (1 to 1.8×), Drift, Shake, Sway and Clip speed (0.25 to 2×). Changing clip speed changes how much footage
each cut uses, so the edit is rebuilt. Camera is shared by all clips and only shows when you're editing the
main look.

### Finish

The grade applied after every layer, shared by all clips: Exposure, Contrast, Saturation, Temperature, Tint
(green to magenta), Split tone and Split hue (shadows pushed toward one hue and highlights toward its
opposite), Fade, Halation, Vignette, Grain and Cinema bars. A flash guard on the GPU also limits sudden
brightness jumps between frames.

### Color studio

The **Color studio** card below Finish imports display-referred creative `.cube` LUTs with grids from 2 to
65 points per axis. **LUT mix** blends the grade; 0% bypasses it. The LUT travels inside saved looks,
projects and export edits, so reopening a project does not depend on the original file path. The LUT runs
after the color controls and before vignette/grain. Convert Log camera footage before using a creative LUT.

Turn on **Waveform** or **RGB parade** to inspect the finished preview. The scopes show sampled SDR code
values and update five times a second while visible. They pause during exports. These compact scopes help
with grading; they do not certify a delivery color space or measure HDR luminance.

### Save as look and Revert

★ Save as look adds the current stack, with its camera, Finish and cut settings, to Your looks. Revert puts the
stack back the way it was when you picked or rolled the look. That works for rolled and random looks too, as
long as you haven't reloaded the page since; after a reload, use ⌘Z.

## 9. Modulation

The ● at the end of a slider opens the modulation menu.

Each route can shape its source with **Attack** and **Decay**, reject low levels with **Gate**, and duck
against another source. For example, route bass to distortion, then choose vocals as the ducking source
to pull distortion back while the vocal is present. Attack and decay are in milliseconds; gate and duck
amount use normalized levels. Defaults preserve the original immediate response. Shaping is sampled on a
fixed time grid, so seeking and exporting do not depend on which frames were previewed first.

Procedural motion also uses cumulative audio and bass phase clocks. Loud sections accelerate motion and
quiet sections slow it down without reversing it; normalized phases complete a cycle over the loop.

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
| Evolve | Clip 1 uses the main look. Each later clip gets a mutated copy of it; Evolve amount sets how different. Tick "A new mutation on every cut" to give every cut after the first its own copy, so a clip that comes back looks different each time |
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

After Roll FX per clip, every clip has its own stack, so the main stack isn't used anywhere. The line above
the layer tools says so. Reset clip N or Same look on all brings the main look back.

## 11. The Edit tab

| Setting | Does |
|---|---|
| Loop length | The 1, 2, 4 and 8 bar presets, Whole song (from the first downbeat to the last full bar), or any length typed into the boxes: a number of bars, or a time such as 2:30, 150 or 2.5m, which rounds to the nearest bar. A loop can't run past the end of the song, and without a song the limit is 10 minutes. The note underneath says whether the length fits a Spotify Canvas (3 to 8 seconds). Lengths are whole bars so beat-synced effects stay in phase when the loop restarts |
| Loop | Repeat plays the edit from the start again, with a transition at the seam. Rebound plans the cuts over the first half of the loop and plays them backward in the second half, so the footage turns round in the middle and runs back into its first frame at the seam. The music and the effects keep going forward. Switching starts hand cuts over |
| Cut rhythm | Where cuts fall. Same as the buttons on the timeline. "Show every clip at least once", on by default, splits the longest cuts in two (on the beat, then on half and quarter beats) until every clip in the edit has a cut. With it off, the note underneath says how many clips are left out |
| Transitions | Which transitions the edit can use. Pools: All, Smooth, Kinetic, Glitch, Hard cuts. Click one to toggle it; double-click to use only that one |
| Transition length | Cut (instant), ¼, ½, 1 or 2 beats, for every cut that hasn't been given its own. A single cut's length is set in the segment menu or by dragging the edge of its pink shading on the timeline |
| Transition order | Cycle through the list in order, or Shuffle (never the same one twice in a row) |
| Clip direction | Forward, Reverse, Alternate (every other cut reversed), Ping-pong, Random |
| Speed ramp | Speed curves locked to the beat. Each one averages out to normal speed, so cut timing doesn't change. Double-click a block on the timeline to ramp only that cut |
| Edit seed | The random seed behind in-points, cut variety and transition picks. ⚄ Re-roll in-points & order picks a new one. Changing it starts hand cuts over. See [Where each clip starts](#where-each-clip-starts) |
| Tempo (no track) | The BPM of the synthetic beat when no song is loaded |
| Keep my edit | When ticked, switching looks leaves your cuts and transitions alone |

## 12. Roll, Surprise, Variations and undo

| Tool | Key | What it does |
|---|---|---|
| Remix | D | Randomizes the canvas. By default that's the look (a 4 to 6 layer stack), the edit (rhythm, transitions, transition length and order, speed ramp, direction, clip speed, seed, FX intensity from 85 to 175%, a Rebound loop about one roll in five, and with no song the tempo, picked so a loop of 8 seconds or less stays between 3 and 8) and the per-clip mode. Tick Clip order or Song section under ▾ to roll those as well |
| Undo last roll | Shift+D | Goes back one roll at a time, up to 40 |
| Surprise me | R | A random look, usually two layers: one main effect plus a light or color layer, sometimes one more or one fewer. Like clicking a look, it resets your cuts unless Keep my edit is ticked |
| Variations | M | Six mutations of the current look, playing live. Subtle/Wild sets how far they drift, ⟳ Mutate again (or M again) deals six more, and clicking one keeps it without touching your edit |
| ↶ Undo, ↷ Redo | ⌘Z, ⇧⌘Z | The arrows in the top bar. Undoes any change to the work: looks, layers, sliders, modulation, palette tints, cuts, clip order and framing, the song and its tempo and beat grid, and the screen and export settings. View toggles (Player UI, Safe zones, Sound, Loop/Listener, the open tab) aren't undone. Each button is greyed out when there's nothing to step to |

The studio also keeps your session (clips, look, edit, your looks, toggles) in the browser and restores it
the next time you open it. To keep an edit for good, save it as a project.

## 13. Projects

A project is one edit saved as a file: the clips and their order, the song and the part that loops, the look
and per-clip FX, the cuts, the framing and the export settings. Each project is a JSON file in
`out/projects/`, so it doesn't depend on the browser, and it's backed up with the rest of `out/`.

The button next to the Downbeat name in the top bar shows the open project and whether its file is up to
date: Saved, Saving, or Couldn't save (the studio tries again on your next change). An edit that isn't in a
project shows as Untitled, Not saved. Click the button or press ⌘O to open Projects.

| In Projects | What it does |
|---|---|
| Save as project | Saves the edit under the name you type, or under the song and look names if you leave it empty. From then on, each change is written to the file a moment after you make it |
| The name field | Renames the open project. Enter or clicking away keeps the new name, Esc puts the old one back |
| Save a copy | Saves the edit as a new project and switches to it. The project you were in keeps its last save |
| New project | Starts over on the first look, the first five clips and the newest song. Tempo fixes you made to songs carry over |
| A project in the list | Opens it. The project you're leaving gets your last change first. Each row shows the look, the clip count, the loop length in bars, the song and when it was last saved |
| 🗑 | Deletes the project's file, on the second click. If it's the open project, its edit stays on screen, saved only in the browser |
| Search | Shows once there are six projects or more. Finds one by its name, look or song. Esc clears it |

Opening a project or starting a new one replaces the edit on screen. If that edit isn't in a project, Projects
asks before replacing it. Undo starts over from the project you open.

⌘S saves the open project right away. It already saves itself, so you only need this before closing the
window in a hurry. With no project open, ⌘S opens Projects so you can name the edit.

### Opening the edit an export was made from

Each export keeps a copy of its edit in `out/projects/exports/`. In the exports library, open an export and
click Open the edit. The edit opens outside any project, so changing it doesn't touch a project until you save
it as one. Exports made before projects existed don't have an edit, and the button doesn't show for them.
Deleting an export deletes its copy of the edit too.

### What stays in the browser

Your looks (★ Save as look), the open tab, Player UI, Safe zones, Sound, the snap setting and the Roll options
belong to the studio rather than to one edit, so they stay in the browser and don't change when you switch
projects. The browser also keeps the edit you're working on, so a reload never loses it. If the open project is
saved from another tab or browser while this one is closed, the studio opens the newer file the next time it
starts.

## 14. Preview and transport

The viewer shows the canvas in the export's shape: 9:16 for Spotify, 16:9 for YouTube, 3:4 for Apple tall,
and 1:1 for square formats. Player UI is optional and starts off in a fresh browser session.
Drag on it to reframe the clip on screen, scroll to zoom in (up to 3×), and double-click to reset that clip's
framing. This framing belongs to the clip, so it applies everywhere the clip plays. A segment with its own
framing ignores it, and dragging the preview there tells you to use the segment menu instead. "Preparing clip…"
means a clip is still loading.

| Control | Does |
|---|---|
| ▶ / ⏸ (Space) | Play, pause |
| 00:00:00:17 / 00:00:06:11 | Position and loop length in hours:minutes:seconds:frames, at 30 fps |
| Previous / next frame (, / .) | Pause and step by one frame inside the loop |
| Focus viewer (Shift+F) | Expand the viewer; Escape restores the workspace |
| 1.2 | Bar and beat inside the loop |
| Loop / Listener (L) | Loop plays only the slice of the song behind the canvas. Listener lets the song play on while the canvas loops, the way a listener hears it |
| Off-sync (Listener only) | Starts the canvas at a random offset from the song. Spotify doesn't sync a canvas to the music, so this shows how it looks out of step |
| 1 bar / 2 / 4 / 8 (keys 1–4) | Loop length. A custom length gets its own button showing its bars and time; clicking it opens the Edit tab |
| Screen (O) | The device to preview on: Phone 9:16, Landscape 16:9, Tablet 3:4 or Square 1:1. It also sets the export shape: picking a screen picks a format of that shape, and picking a format in the export sheet changes the screen. O steps through them |
| Player UI (H) | Spotify's player overlay, to check what it covers |
| Safe zones (S) | Preview-only composition guides. On a phone, choose Spotify, TikTok, Reels or Shorts; other shapes show compatible Apple or composition margins. These are approximate reserves: actual UI and cropping vary by device, caption and placement |
| Sound | Mute |
| fps | Preview frame rate |

### Framing one segment

The Framing part of the segment menu (double-click a block on the timeline) sets where the crop sits and how far
it zooms for that one segment. It can hold still or move across the segment, which is how you get a push in, a
pull out or a pan that starts on one cut and lands on the next.

| Control | Does |
|---|---|
| Crop box | The clip at the segment's in-point, with the part the screen shows outlined. Drag the outline to move it, press outside it to jump there, and pinch on it to zoom (or use the Zoom slider). Scrolling over it scrolls the menu. A moving segment shows a solid Start box and a dashed End box. While the playhead is in the segment, a thin white box follows the crop, since the menu covers the preview |
| Motion | Auto lets the look's drift wander around the clip's framing. Still holds one framing for the whole segment. Smooth, Steady and On the beat move from the start framing to the end framing: Smooth eases out and in, Steady keeps one speed, and On the beat takes a quick step on each beat and holds in between |
| Start, End | Which end of the move the box and sliders change. The preview jumps to that end of the segment. ⇄ Swap turns a push in into a pull out, or reverses a pan |
| X, Y | Left to right and down to up, as a share of the room the crop has to move. "No room" means the clip only just fills the screen that way: a 16:9 clip on the 9:16 phone screen fills it top to bottom, so it has to zoom in before it can move up or down |
| Zoom | 1× to 3×, on top of the look's camera zoom (shown next to the Framing label). 1× is as wide as the clip goes while still filling the screen |
| Quick moves | Push in zooms in by half again over the segment, Pull out does the reverse, and Pan ← → ↑ ↓ sweep most of the way across the clip, zooming in first if there isn't room. Each one replaces the current framing |

The move runs from cut to cut and holds still through the transitions on either side. Shake and sway from the
look still apply on top, and so does any modulation on the camera zoom (many looks push it a little on each kick).
Auto, or Back to auto, drops the segment's framing. Like the other segment settings, it goes back to automatic
when you change the clips, the rhythm or the transitions.

## 15. Exporting

Press E or Export.

| Format | You get |
|---|---|
| Spotify 9:16 | A silent 3 to 8 second canvas. Sizes: Master 1080×1920, Lite 720×1280, or Spec-literal 608×1080 if Spotify rejects an upload |
| Apple 3:4 | Native 2048×2732 motion artwork, silent, 8–35 seconds, H.264 or ProRes |
| Apple 1:1 | Native 3840×3840 motion artwork, silent, 8–35 seconds, H.264 or ProRes |
| YouTube 16:9 | A 1920×1080 visualizer of any length |
| Social 1:1 | A 1080×1080 loop of any length |
| Social 9:16 | A 1080×1920 vertical social video |
| Cover 3000² | A 3000×3000 sRGB cover JPEG and a square motion preview |

For Apple formats, choose **H.264**, **ProRes 422 HQ** or **ProRes 4444** in the export sheet. ProRes writes
a MOV directly from the rendered frames. It avoids an additional H.264 output encode; the current source
pipeline still uses 8-bit playback copies (up to 2560 pixels on the long edge, or 2160 for still conversion).
The renderer is opaque, so ProRes 4444 does not add transparency or recover extra source precision.

**Frame 0 reference still** compares the opening frame to a still you choose. It reports a sampled RGB
similarity and warns about a different aspect ratio. This is a visual aid, not a guarantee that artwork will
be accepted. The reference is held for the current session; reselect it after reopening the studio.

The export itself is silent. For a demo with sound, check Also save a copy with the song: it's off unless you
check it, works with every format, and writes a second file, ending in `-audio.mp4`, with the song playing from
the loop start (under the whole repeated file for Apple). With Save to my Downloads folder on, that copy is
downloaded too. You can also make a 15 or 30 second promo with the song for Spotify, YouTube and Social (for
Reels, TikTok or Spotify Countdown pages), and have finished files copied to Downloads.
With a promo selected, an optional title and **OUT NOW** card are added to that social copy. The motion-art
master stays clean.

### Long videos

Spotify takes 3 to 8 seconds and Apple Music motion art at most 35, and the sheet warns you when the loop
doesn't fit the format you picked. YouTube 16:9 and both Social formats take any length, so use those for a
visualizer. With Also save a copy with the song checked you get a second file with the song playing from the
loop start. The GIF and WebP teasers use the first 10 seconds.

Videos over a minute are encoded at 20 Mbps instead of 50, which is about 150 MB a minute. How fast they
render depends on the look, the size and the machine; the progress line shows the time left. The video streams to disk as it
renders, so length isn't limited by memory.

For long videos pick a rhythm that cuts on the beat (On hits, Beat, ½ bar, Bar, 2 bars, Varied). One per clip
and Two per clip split the whole loop between your clips, so on a long loop each cut can outlast its footage,
and the clip holds its last frame until the next cut.

Spotify asks that canvases avoid rapid cuts. The sheet warns you when the shortest cut is under 0.3 seconds or
there are more than 2.5 cuts a second; a slower rhythm like ½ bar or Bar fixes it.

Render & verify renders every frame on the GPU, encodes the selected format, and checks the file against the
format's spec. H.264 uses an available browser/hardware encoder with a software fallback; ProRes uses ffmpeg.
While it runs, the preview shows the size being rendered and how far along it is. The result
appears in the Exports list with a pass or fail badge.

Exports take each clip frame from the server, which decodes it with ffmpeg, rather than from the browser's
video player, so every browser renders the same frames. The studio also checks that each cut's footage keeps
moving. If a cut shows one picture for 1.5 s or more, the sheet reads "Export failed: the clips froze", the
file isn't downloaded, and the clips check says which cut, which clip and why: a start point past the first
60 s of the clip, a speed setting that stops the footage, or frames that never reached the GPU.

The Stills and teasers row makes stills from clip 1 (a 3000² cover, a 2660×1140 Spotify header, a 2560×1440 YouTube
banner, a 2480×520 SoundCloud header) and GIF or WebP loops from your latest render.

Batch has two options. Export 4 rolls renders four random rolls and then returns to your edit. "This look on
N songs" renders the current look and edit on the 12 newest songs in the same folder as the current one, each
at its top loop suggestion, so every song on a release shares one style. Twelve is the limit so a big folder
such as Downloads can't start hours of rendering.

The sheet says which render it's on and names its look or song. Cancel stops the batch, and so does a render
that fails. Either way the batch ends on a summary: how many were exported, how many passed every check, where
it stopped if it did, and a download link for each file.

## 16. Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| , / . | Pause and step one frame backward / forward |
| ⌘K | Search workspace commands (Ctrl+K on Windows and Linux) |
| Shift+F | Focus viewer / restore the workspace |
| ← → | Previous / next look, or previous / next block while the segment menu is open |
| D, Shift+D | Remix, undo roll |
| R | Surprise me |
| M | Variations, and six more when they're open |
| E | Export |
| [ ] | Previous / next loop suggestion |
| 1–4 | Loop length: 1, 2, 4, 8 bars |
| T | Tap tempo |
| L | Loop / Listener |
| H | Player overlay |
| S | Safe zones |
| O | Next screen: phone, landscape, tablet, square |
| B | Split the block at the playhead |
| ⌘D | Repeat the selected block |
| Delete | Delete the selected block |
| N | Snap: beat, ½, ¼, off |
| ? | Shortcut list |
| Esc | Close menus and dialogs, leave viewer focus, or clear the selected block |
| ⌘Z, ⇧⌘Z | Undo, redo (Ctrl on Windows and Linux, where Ctrl+Y also redoes) |
| ⌘S | Save the open project now, or name the edit to save it as one |
| ⌘O | Projects |

| Mouse | Where | Action |
|---|---|---|
| Drag, scroll, double-click | preview | Reframe, zoom, reset framing |
| Double-click | any slider | Reset to default |
| Drag | envelope | Draw |
| Click | timeline block | Select it and move the playhead there |
| Drag | cut line | Move the cut; hold Shift to leave the snap grid |
| Drag | edge of a transition's violet shading | That transition's length |
| Option-drag | timeline block | Slip the footage |
| Double-click, right-click, Enter, or long-press on a touch screen | timeline block | Segment menu: split, repeat, put a clip in, delete, timing, clip, in-point, direction, speed ramp, transition and its length, framing |
| Drag | clip | Reorder |

## 17. Effects

Layers run top to bottom. Time effects remember earlier frames, so they start fresh whenever the stack
changes.

### Space

| Effect | Does |
|---|---|
| 2.5D Parallax | Fakes depth from brightness or distance to the center and orbits the camera. Made for album art and stills |
| Kaleidoscope | Mirrored polar slices that spin over the loop |
| Mirror | Split, quad or horizon symmetry |
| Infinite Tunnel | Flies forward through a tunnel made from the footage |
| Fractal Tunnel | Smaller copies of the frame nested inside it, with thin colored borders. They swell on the beat |
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
| Prism Echo | A faint enlarged copy with red and blue split apart, added on top. It snaps back on each beat and grows until the next |
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
| Acid Solarize | A pastel pink tint on the highlights that pulses every bar, 2 beats, beat or kick. Unlike Solarize, it never inverts |
| Film Stock | Bleach Bypass, Cyberpunk, Golden Hour, Sepia Noir, Cross Process, Teal & Orange |

## 18. Rhythms, transitions and speed ramps

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

## 19. Troubleshooting

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

### The in-points I picked went back

Changing the clips, the rhythm, the loop or the edit seed clears them, and so do rolling the edit, switching
songs, and clicking a look with Keep my edit unticked. Press ⌘Z to get them back. The full list is in
[Where each clip starts](#where-each-clip-starts).

### Some loop lengths are grayed out

That preset is longer than the song from its first downbeat. Every other length is allowed, including ones
outside Spotify's 3 to 8 seconds; the note under Loop length says when a length won't pass as a Canvas.

### A clip has a spinning ring, or the preview says "Preparing clip…"

Its playback proxy is still being built. Big 4K files take a while.

### The preview says it can't start

The studio draws with WebGL2, and the browser wouldn't give it a WebGL2 context. The message under it has the
browser's reason. Use a current Chrome or Edge, turn on "Use graphics acceleration when available" in its
System settings, and relaunch it. `chrome://gpu` should list WebGL2 as hardware accelerated.

## 20. Notes for developers

- `compose(ctx, t)` in `downbeat/studio/src/engine/composer.ts` turns the look, the edit, the audio and a time into
  one frame for the engine. Preview, look thumbnails, variations and export all call it, which is why export
  matches the preview. Keep it the only place frames are built.
- Animated shader terms have to complete whole cycles per loop or follow the beat, and stepped (integer)
  parameters are never modulated. Otherwise the loop jumps at the seam.
- Looks are edited in place. The render loop reads the look object every frame, so edits reach the preview
  immediately, but React can't detect a change to an object it already has. After an in-place edit, call
  `touch()`, which bumps `version`; components that display look data call `useVersion()` so they re-render.
  `useStudioStore.setState({})` does not re-render anything. That was why the Layers and Modulators controls
  looked dead.
- The edit is a list of blocks (`Block` in `engine/types.ts`), each with a stable id and a start in beats.
  `generateBlocks()` in `engine/timeline.ts` rolls them from the rhythm and the seed, and `resolve()` turns
  blocks into the segments `compose()` samples, filling in whatever a block leaves unset from the look's cut
  settings. `planTimeline()` is the two together. The store keeps `blocks: null` while the edit follows the
  rhythm, and the edit's own blocks once one is cut or set by hand. The edits themselves (split, repeat,
  insert, delete, trim) are pure functions in `engine/blocks.ts`; `state/blockActions.ts` applies them to the
  store. Player keys and the segment menu use block ids, so they follow a block through edits around it.
  Sessions saved with the older `customCuts` and `segOverrides` are turned into blocks by `fromLegacy()`.
- In a Rebound loop the plan covers half the loop: `tl.L` is half of `ctx.L` and `tl.rebound` is set.
  `editTime()` folds loop time into edit time, and `sampleTimeline()` returns `back` in the second half, where
  `compose()` asks for clip frames by seeking (`rev`), since a video can't play backward. Audio and effects use
  the real loop time. Reversed, ping-pong and stopped cuts are shown by seeking too. `canvas/renderLoop.ts`
  copies the frame a seek landed on before it starts the next seek; the other way round, Chrome is mid-seek
  whenever a frame is drawn and the footage looks like a run of stills.
- `VideoBank` (`engine/composer.ts`) keeps up to 20 `<video>` elements, one per cut on screen or coming up.
  `prime()` parks a cut's video on its first frame when the cut comes into view 0.35 s ahead, and leaves it
  there until the cut starts. When the bank is full, a new cut takes an element of the same clip that hasn't
  been used for a second, so an edit with more cuts than that seeks instead of loading the file again.
- Thumbnails go through `lib/thumbs.ts`, two at a time, newest first. They come from the same server as the
  clips' video, and Chrome opens only six connections to one server: a thumbnail for every cut at once (after
  a roll, or opening the segment menu) used to hold all six, and a cut's video waited seconds to load. Use
  `loadThumb()`, `thumbBackground()` or `thumbRef()` for any new thumbnail rather than a plain `url(...)`.
- Session state is saved to `localStorage` under `downbeat.studio.v1`. Undo history is kept in memory: 100
  steps, with a snapshot taken 350 ms after each change.
- `editState()` in `state/historyController.ts` is the edit itself, without the studio's own settings. Undo
  snapshots, the session, project files and the copy sent with each export (`meta.edit`) all use it, and
  `editFields()` reads one back with defaults for anything missing. `state/projectController.ts` keeps the
  open project's id in `localStorage` under `downbeat.project.v1` and writes the edit to its file after each
  session save, one request at a time and only when it changed. On the server, `downbeat/server/projects.py`
  stores them: GET `/api/projects` lists, GET `/api/projects/<id>` reads one, POST
  `/api/projects/{create,save,rename,delete}` writes, and GET `/api/projects/exports/<file>` reads an export's
  edit. Files are written to a temp file and moved into place.
- Per-clip stacks are rendered into `frame.pre`, before the transition. Camera and Finish always come from the
  main look.
- Exports stream to the server while they render. `/api/export/raw/begin` with `stream: "h264"` opens a
  `delivery.ChunkSession`, which appends the WebCodecs chunks to a `.h264` file and remuxes it at the end;
  without WebCodecs the browser sends raw RGBA frames to ffmpeg through `delivery.RawSession`. Nothing the size
  of the whole video is held in memory on either side.
- The export sheet's form is rendered by React. Progress and results are drawn into `#exportStatus`, which
  React never renders into, and the form is hidden while they show. Writing into React-owned nodes from outside
  React is what used to break the app after an export.
