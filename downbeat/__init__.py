"""Downbeat: beat-locked, audio-reactive Spotify Canvas loops.

media/     files and ffmpeg: probing, thumbnails, playback proxies, encoding
analysis/  the song and the footage: beats, tempo, envelopes, subject framing
render/    the CPU renderer behind the command line
server/    the studio's backend
studio/    the browser studio (React + WebGL2)
delivery   export formats, spec checks and muxing
"""
from __future__ import annotations

__version__ = "4.0.0"
