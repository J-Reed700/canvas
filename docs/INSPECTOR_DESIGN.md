# Inspector organization

The inspector follows the selected timeline appearance, with a persistent, explicit scope selector:
This appearance, All uses, Whole edit. Selecting reads the inherited treatment; changing a control creates
a copy on that appearance. Independent treatments survive main-look changes, save in projects, take
part in undo, and split into independently editable copies.

The main sections remain Looks, Layers and Edit. Layers opens on the effect stack and groups color,
camera and modulation into separate families. Preset discovery stays with presets; stack creation and
management stay above the stack; saving and reverting stay together in the footer. Less frequent global
generation controls are folded under Master. Edit groups timing, transitions, playback and generation.

The double-click appearance editor is the primary place to override a repeated clip. It opens on
Look & effects and names the source plus its occurrence (for example, Clip 4 · appearance 2 of 2).
Timing, Playback and Framing have their own sections. Navigation, scope and closing actions stay outside
the scrolling controls. Nested effect and modulation pickers preserve the editor underneath.

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
