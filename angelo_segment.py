"""Angelo — SAM 3 auto-segmentation backend.

Our own lazy loader for Meta's SAM 3 (the pip-installed `sam3` package —
not the other node packs). SAM 3's headline capability is *concept /
text* prompts: give it a noun phrase ("the front wheel", "her face") and
it segments every matching instance. We run it on Angelo's current
preview image and return the detections as polygons + boxes so the JS
can overlay them, let the user click-to-confirm, and feed the chosen
shape into the refine pipeline (silhouette for Refine, bbox for Smart
Inpaint).

The model is loaded once on first use and cached. It loads to GPU on
demand and is offloaded back to CPU after each detection so it doesn't
sit on VRAM next to the diffusion model between clicks.

Routes are namespaced under /angelo/ to avoid clashing with other packs.
"""

from __future__ import annotations

import os
import threading
import traceback

_LOCK = threading.Lock()
_STATE = {
    "model": None,        # the SAM3 image model
    "processor": None,    # Sam3Processor
    "device": None,       # torch device the model loads onto
    "import_error": None, # cached import failure message, if any
}

# Default checkpoint location (ComfyUI root / models/sam3/sam3.pt).
_DEFAULT_CKPT_REL = os.path.join("models", "sam3", "sam3.pt")


def _torch_devices():
    import comfy.model_management as mm
    return mm.get_torch_device(), mm.unet_offload_device()


def _resolve_checkpoint():
    """Absolute path to sam3.pt under the ComfyUI root, or None to let
    build_sam3_image_model() use its own default / auto-download."""
    try:
        from folder_paths import base_path
    except Exception:
        return None
    p = os.path.join(base_path, _DEFAULT_CKPT_REL)
    return p if os.path.exists(p) else None


def _ensure_model():
    """Lazily build + cache the SAM3 image model and processor. Returns
    (model, processor) or raises RuntimeError with a clear message."""
    if _STATE["import_error"]:
        raise RuntimeError(_STATE["import_error"])
    if _STATE["model"] is not None:
        return _STATE["model"], _STATE["processor"]

    with _LOCK:
        if _STATE["model"] is not None:
            return _STATE["model"], _STATE["processor"]
        try:
            # Official Meta SAM 3 pip package (already installed in the env).
            from sam3.model_builder import build_sam3_image_model
            from sam3.model.sam3_image_processor import Sam3Processor
        except Exception as e:  # pragma: no cover - environment dependent
            _STATE["import_error"] = (
                "SAM 3 is not available: failed to import the `sam3` package. "
                "Install it (pip install sam3 / the Meta SAM 3 release) and "
                "make sure models/sam3/sam3.pt exists.\n"
                f"Import error: {e}"
            )
            raise RuntimeError(_STATE["import_error"])

        load_device, _ = _torch_devices()
        ckpt = _resolve_checkpoint()
        print(f"[Angelo/SAM3] Building image model (checkpoint={ckpt or 'default'})...")
        if ckpt:
            model = build_sam3_image_model(checkpoint_path=ckpt)
        else:
            model = build_sam3_image_model()
        processor = Sam3Processor(model)
        model.processor = processor
        model.eval()

        _STATE["model"] = model
        _STATE["processor"] = processor
        _STATE["device"] = load_device
        print("[Angelo/SAM3] Model ready.")
        return model, processor


def _mask_to_polygons(mask_np, min_area=64, epsilon_frac=0.004):
    """Binary mask (H, W) -> list of polygons, each a flat [x0,y0,x1,y1,...]
    list in image-pixel coords. Contours are simplified so the payload and
    the JS overlay stay light. Tiny specks are dropped."""
    import numpy as np
    polys = []
    m = (mask_np > 0.5).astype("uint8")
    if m.sum() == 0:
        return polys
    try:
        import cv2
    except Exception:
        # No OpenCV — fall back to the mask's bounding box as a 4-pt polygon.
        ys, xs = np.where(m)
        x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        return [[x1, y1, x2, y1, x2, y2, x1, y2]]

    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, epsilon_frac * peri, True)
        pts = approx.reshape(-1, 2)
        if len(pts) < 3:
            continue
        polys.append([int(v) for xy in pts for v in xy])
    return polys


def detect_text(pil_image, text, confidence_threshold=0.3, max_detections=20):
    """Run SAM 3 text grounding on a PIL image. Returns a list of
    detections: {"polygons": [[x,y,...], ...], "bbox": [x1,y1,x2,y2],
    "score": float}, in image-pixel coords, sorted by score."""
    import torch
    import numpy as np

    model, processor = _ensure_model()
    load_device, offload_device = _torch_devices()

    img_w, img_h = pil_image.size
    results = []
    try:
        model.to(load_device)
        if hasattr(processor, "set_confidence_threshold"):
            processor.set_confidence_threshold(float(confidence_threshold))
        state = processor.set_image(pil_image)
        if text and text.strip():
            state = processor.set_text_prompt(text.strip(), state)

        masks = state.get("masks", None)
        boxes = state.get("boxes", None)
        scores = state.get("scores", None)
        if masks is None or len(masks) == 0:
            return []

        # Sort by score (desc) and cap.
        if scores is not None and len(scores) > 0:
            order = torch.argsort(scores, descending=True)
            masks = masks[order]
            boxes = boxes[order] if boxes is not None else None
            scores = scores[order]
        n = len(masks)
        if max_detections > 0:
            n = min(n, max_detections)

        for i in range(n):
            mask_np = masks[i].detach().to("cpu").float().numpy()
            if mask_np.ndim == 3:
                mask_np = mask_np[0]
            polys = _mask_to_polygons(mask_np)
            if not polys:
                continue
            if boxes is not None:
                b = boxes[i].detach().to("cpu").float().tolist()
                bbox = [float(b[0]), float(b[1]), float(b[2]), float(b[3])]
            else:
                ys, xs = np.where(mask_np > 0.5)
                bbox = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]
            score = float(scores[i]) if scores is not None else 0.0
            results.append({"polygons": polys, "bbox": bbox, "score": score})
    finally:
        # Offload off the GPU so we don't squat VRAM between clicks.
        try:
            model.to(offload_device)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    return {"width": img_w, "height": img_h, "detections": results}


# --- HTTP route ------------------------------------------------------

try:
    from server import PromptServer
    _HAS_SERVER = True
except ImportError:
    _HAS_SERVER = False


def _load_preview_image(filename, subfolder, type_):
    """Resolve a ComfyUI /view-style image ref to a PIL image."""
    import folder_paths
    from PIL import Image
    type_ = type_ or "temp"
    if type_ == "output":
        base = folder_paths.get_output_directory()
    elif type_ == "input":
        base = folder_paths.get_input_directory()
    else:
        base = folder_paths.get_temp_directory()
    path = os.path.join(base, subfolder or "", filename or "")
    path = os.path.normpath(path)
    # Guard against path traversal outside the base dir.
    if not os.path.normpath(path).startswith(os.path.normpath(base)):
        raise ValueError("invalid image path")
    return Image.open(path).convert("RGB")


if _HAS_SERVER:
    from aiohttp import web

    routes = PromptServer.instance.routes

    @routes.post("/angelo/detect")
    async def _angelo_detect(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        method = (data or {}).get("method", "sam3_text")
        text = (data or {}).get("text", "")
        threshold = float((data or {}).get("confidence_threshold", 0.3))
        max_det = int((data or {}).get("max_detections", 20))
        filename = (data or {}).get("filename", "")
        subfolder = (data or {}).get("subfolder", "")
        type_ = (data or {}).get("type", "temp")

        if not filename:
            return web.json_response({"error": "no preview image (generate one first)"}, status=400)

        try:
            pil = _load_preview_image(filename, subfolder, type_)
        except Exception as e:
            return web.json_response({"error": f"could not load preview: {e}"}, status=400)

        # Run the (blocking, GPU) detection off the event loop.
        import asyncio
        loop = asyncio.get_event_loop()
        try:
            if method == "sam3_text":
                result = await loop.run_in_executor(
                    None, detect_text, pil, text, threshold, max_det
                )
            else:
                return web.json_response({"error": f"unknown method '{method}'"}, status=400)
        except Exception as e:
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

        return web.json_response({"ok": True, **result})
