"""ComfyUI-Angelo — click-to-refine sampler.

Keep the latent alive after sampling; click a region in the node's
own preview to do extra denoising steps just on that region while
the rest of the latent is preserved bit-exact (via mask-blended
re-noise inpainting, with feathered transitions).

Built for FLUX 2 Klein 9B distilled (4-step, CFG=1) but works with
any KSampler-compatible model.
"""

from .angelo_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Record ComfyUI's own Python interpreter so the optional SAM 3 installer
# (install_sam3_support.bat / .sh) installs into the SAME environment
# ComfyUI runs in — not whatever `python` happens to be on the user's
# PATH. sys.executable here is ComfyUI's interpreter for ANY launcher
# (portable, venv, conda, Stability Matrix, ...), so this is the reliable
# source of truth. Best-effort; never break node load.
try:
    import os as _os
    import sys as _sys
    if _sys.executable and _os.path.exists(_sys.executable):
        _marker = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                                ".comfy_python.txt")
        with open(_marker, "w", encoding="utf-8") as _f:
            _f.write(_sys.executable)
except Exception as _e:  # pragma: no cover
    print(f"[Angelo] could not record python path: {_e}")

# Registers the /angelo/detect SAM 3 route. Import is best-effort — if
# the server or sam3 deps aren't present, the node still loads (the
# detect feature just won't be available).
try:
    from . import angelo_segment  # noqa: F401
except Exception as _e:  # pragma: no cover
    print(f"[Angelo] segmentation route not registered: {_e}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
