"""ComfyUI-Angelo — click-to-refine sampler.

Keep the latent alive after sampling; click a region in the node's
own preview to do extra denoising steps just on that region while
the rest of the latent is preserved bit-exact (via mask-blended
re-noise inpainting, with feathered transitions).

Built for FLUX 2 Klein 9B distilled (4-step, CFG=1) but works with
any KSampler-compatible model.
"""

from .angelo_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Registers the /angelo/detect SAM 3 route. Import is best-effort — if
# the server or sam3 deps aren't present, the node still loads (the
# detect feature just won't be available).
try:
    from . import angelo_segment  # noqa: F401
except Exception as _e:  # pragma: no cover
    print(f"[Angelo] segmentation route not registered: {_e}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
