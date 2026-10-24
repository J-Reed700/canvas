"""Beat-synced and audio-reactive shaders for vertical video loops."""
from __future__ import annotations

from ._common import coord_grid, zoom_in
from .color import COLOR_EFFECTS
from .digital import DIGITAL_EFFECTS
from .geometry import GEOMETRY_EFFECTS
from .impact import IMPACT_EFFECTS
from .motion import MOTION_EFFECTS
from .optics import OPTICS_EFFECTS
from .texture import TEXTURE_EFFECTS

# Registry order is the order effects are listed in.
EFFECTS = {
    **MOTION_EFFECTS,
    **GEOMETRY_EFFECTS,
    **OPTICS_EFFECTS,
    **DIGITAL_EFFECTS,
    **COLOR_EFFECTS,
    **TEXTURE_EFFECTS,
    **IMPACT_EFFECTS,
}

__all__ = ["EFFECTS", "coord_grid", "zoom_in"]
