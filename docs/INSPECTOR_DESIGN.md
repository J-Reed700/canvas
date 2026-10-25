# Inspector organization

The inspector follows the selected timeline appearance, with a persistent, explicit scope selector:
This appearance, All uses, Whole edit. Selecting reads the inherited treatment; changing a control creates
a copy on that appearance. Independent treatments survive main-look changes, save in projects, take
part in undo, and split into independently editable copies.

The main sections remain Looks, Layers and Edit. Layers opens on the effect stack and groups color,
camera and modulation into separate families. Preset discovery stays with presets; stack creation and
management stay above the stack; saving and reverting stay together in the footer. Less frequent global
generation controls are folded under Master. Edit groups timing, transitions, playback and generation.

The unified inspector is the primary place to override a segment or repeated clip. Selecting a block on
the timeline targets that segment (scope 'This appearance') and names the source plus its occurrence (for
example, Clip 4 · appearance 2 of 2). The Looks and Layers tabs edit that appearance's own look and effects
(forking from the source on first edit, with 'Use source look' to reset). The Edit tab presents that
segment's own settings inline as collapsible sections: Timing & transition (timing strip, cuts, transitions,
and block actions), Source & playback (clip, in-point filmstrip and slider, direction, speed, and ramps),
Framing (crop box, coordinates, motion, and quick moves), and Advanced values (macro, camera, finish, and
layer overrides). A top bar provides ‹ › segment stepping, position readout, '▶ Play the cut', and '↺ Reset
segment'. When scope is Whole edit or All uses, the Edit tab displays the whole-edit arrangement settings as
before. Double-click, right-click, Enter, or the toolbar's Edit segment button select the block and open its
Edit tab directly.

Research informing these decisions:

- [Apple: inspectors](https://support.apple.com/en-mide/guide/final-cut-pro/ver15f87af2/mac): the right-side
  inspector changes with the selected item.
- [Apple: change clip effect order](https://support.apple.com/en-ca/guide/final-cut-pro/ver761c7810/mac):
  the selected clip's ordered effect stack is managed together in the video inspector.
- [Adobe: Effect Controls](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/about-effect-controls-panel.html):
  show the selected clip's identity and its visual controls in one place.
- [Adobe: view effects](https://helpx.adobe.com/sg/premiere/desktop/add-video-effects/apply-video-effects/view-effects-in-the-effect-controls-panel.html):
  collapse related effect and property groups instead of presenting an undifferentiated control list.

These are design references; the scope and inheritance model are specific to Downbeat's repeated clips.
