"""AngeloRefine — single-node click-to-refine sampler.

How it works:
  - On first run (no clicks yet), the node decodes the incoming latent
    via VAE and shows the image in its own preview area. The latent is
    cached server-side keyed by node id.
  - The JS frontend attaches click handling to that preview. When the
    user clicks a region they want improved, the JS updates this node's
    click_x / click_y / click_seq widgets and re-queues the workflow.
  - On re-run, the node detects the new click_seq, builds a feathered
    circular mask centred on (click_x, click_y) with radius click_radius,
    re-noises the cached latent partially (`denoise`), and re-samples
    `steps` steps with the mask applied. ComfyUI's noise_mask handling
    re-stitches the original outside the mask at each step (the noise-
    injection inpaint pattern), so the unclicked region stays preserved.
  - The refined latent is cached for the next click, so successive clicks
    keep refining the SAME working latent rather than starting over.
  - Toggle the `reset` widget (or press the Reset button the JS adds) to
    throw away the cache and start fresh from the incoming latent.

The cache is in-process state only — restart of ComfyUI clears it.
"""

from __future__ import annotations

import hashlib
import json
import math
import torch

import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import folder_paths
import node_helpers

# Reuse PreviewImage's save machinery for the preview output.
import nodes as comfy_nodes


# Per-node state cache:
#   unique_id -> {
#     "history":   list[Tensor],   # stack of latents (oldest first, current = [-1])
#     "click_seq": int,            # last processed click_seq from JS
#     "undo_seq":  int,            # last processed undo_seq from JS
#     "fingerprint": str,          # hash of incoming latent; mismatch = upstream changed
#   }
_STATE: dict[str, dict] = {}

# Max number of latents to keep in the undo stack per node. Each FLUX 2
# latent at 832x1776 is ~180 KB (bf16); 10 = ~1.8 MB per node. Cheap.
_HISTORY_CAP: int = 10

# Valid resize methods for the Fine Upscaling crop. All routed through
# comfy.utils.common_upscale which accepts both 4D image tensors and 4D
# latent tensors. lanczos is image-quality; bislerp is latent-aware.
# Default nearest-exact preserves exact sample values (good for
# latents); for the pixel-space path lanczos / bicubic typically look
# better. The user picks one for both ops in the Fine Upscale flow.
_FINE_UPSCALE_RESIZE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "bislerp", "lanczos"]

# Smart Guided Inpaint: maps a location dropdown LABEL (set by the JS
# location selector) to a natural-language prefix that's prepended to
# the Area Prompt text before CLIP encoding. The labels here are the
# single source of truth — the JS dropdown lists exactly these keys.
# Order is preserved (py3.7+ dicts) so the JS can build its dropdown
# from the same list via the widget's tooltip / a mirrored array.
_GUIDED_LOCATION_PREFIXES = {
    "(none)":               "",
    "Whole image":          "Across the whole image, ",
    "Top left":             "In the top left of the image, ",
    "Top middle":           "In the top middle of the image, ",
    "Top right":            "In the top right of the image, ",
    "Middle left":          "On the left middle of the image, ",
    "Center":               "In the center of the image, ",
    "Middle right":         "On the right middle of the image, ",
    "Bottom left":          "In the bottom left of the image, ",
    "Bottom middle":        "In the bottom middle of the image, ",
    "Bottom right":         "In the bottom right of the image, ",
    "Left edge":            "Along the left edge of the image, ",
    "Right edge":           "Along the right edge of the image, ",
    "Top edge":             "Along the top edge of the image, ",
    "Bottom edge":          "Along the bottom edge of the image, ",
    "Top half":             "In the top half of the image, ",
    "Bottom half":          "In the bottom half of the image, ",
    "Left half":            "In the left half of the image, ",
    "Right half":           "In the right half of the image, ",
    "Top of the image":     "At the top of the image, ",
    "Bottom of the image":  "At the bottom of the image, ",
}


def _latent_fingerprint(latent: torch.Tensor) -> str:
    """Quick non-cryptographic fingerprint of an incoming latent.

    Used to detect when the upstream KSampler has produced a fresh
    latent (e.g. user changed the prompt + re-queued), so we can
    automatically reset the cache instead of layering refinements
    onto a now-irrelevant base.
    """
    flat = latent.detach().to(torch.float32).flatten()
    n = min(flat.numel(), 1024)
    sample = flat[::max(1, flat.numel() // n)][:n]
    h = hashlib.sha1()
    h.update(str(tuple(latent.shape)).encode())
    h.update(sample.cpu().numpy().tobytes())
    return h.hexdigest()


def _parse_stroke_points(raw: str) -> list[tuple[float, float]]:
    """Parse the JS-set stroke_points widget. Empty / malformed → []."""
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    out = []
    if not isinstance(data, list):
        return []
    for item in data:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            try:
                out.append((float(item[0]), float(item[1])))
            except (TypeError, ValueError):
                continue
    return out


def _stroke_mask_latent(
    latent_h: int,
    latent_w: int,
    stroke_points_pixel: list[tuple[float, float]],
    r_latent: float,
    scale_x: float,
    scale_y: float,
    device: torch.device,
) -> torch.Tensor:
    """Vectorised union of circles in latent space, one circle per
    point in stroke_points_pixel. Points come in image-pixel coords;
    we scale them to latent space here using the per-axis ratios.

    Memory: one [N_points, H, W] float tensor briefly. For N=200, a
    typical FLUX 2 latent (~52x111), that's about 4 MB peak — fine.
    """
    if not stroke_points_pixel:
        return torch.zeros((1, latent_h, latent_w), device=device, dtype=torch.float32)

    pts = torch.tensor(stroke_points_pixel, device=device, dtype=torch.float32)
    cx = pts[:, 0] * scale_x  # [N]
    cy = pts[:, 1] * scale_y  # [N]

    ys = torch.arange(latent_h, device=device, dtype=torch.float32).view(1, -1, 1)
    xs = torch.arange(latent_w, device=device, dtype=torch.float32).view(1, 1, -1)
    cxv = cx.view(-1, 1, 1)
    cyv = cy.view(-1, 1, 1)
    dist2 = (xs - cxv) ** 2 + (ys - cyv) ** 2

    circles = (dist2 <= r_latent * r_latent).to(torch.float32)  # [N, H, W]
    mask = circles.amax(dim=0)  # union via max
    return mask.unsqueeze(0)  # [1, H, W]


def _parse_rect_points(raw: str) -> tuple[float, float, float, float] | None:
    """Parse the JS-set rect_points widget — JSON list of one or more
    [x1, y1, x2, y2] entries in image-pixel coords. We use only the
    LAST rectangle (the most recent drag); earlier entries are kept
    in the widget history for the undo stack to consume but don't
    affect mask building. Returns None for empty / malformed input.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if not isinstance(data, list) or not data:
        return None
    last = data[-1]
    if not isinstance(last, (list, tuple)) or len(last) < 4:
        return None
    try:
        return (float(last[0]), float(last[1]), float(last[2]), float(last[3]))
    except (TypeError, ValueError):
        return None


def _rect_mask_latent(
    latent_h: int,
    latent_w: int,
    rect_pixel: tuple[float, float, float, float],
    scale_x: float,
    scale_y: float,
    device: torch.device,
) -> torch.Tensor:
    """Build a [1, H, W] filled-rectangle mask in latent space.

    rect_pixel is (x1, y1, x2, y2) in image-pixel coords; corners
    aren't required to be ordered (the user may drag in any
    direction). Output is clamped to the latent bounds.
    """
    x1, y1, x2, y2 = rect_pixel
    x_lo_p, x_hi_p = min(x1, x2), max(x1, x2)
    y_lo_p, y_hi_p = min(y1, y2), max(y1, y2)

    xlat_lo = max(0, min(latent_w, int(round(x_lo_p * scale_x))))
    xlat_hi = max(0, min(latent_w, int(round(x_hi_p * scale_x))))
    ylat_lo = max(0, min(latent_h, int(round(y_lo_p * scale_y))))
    ylat_hi = max(0, min(latent_h, int(round(y_hi_p * scale_y))))

    mask = torch.zeros((1, latent_h, latent_w), device=device, dtype=torch.float32)
    if xlat_hi > xlat_lo and ylat_hi > ylat_lo:
        mask[0, ylat_lo:ylat_hi, xlat_lo:xlat_hi] = 1.0
    return mask


def _mask_bbox_latent(mask: torch.Tensor) -> tuple[int, int, int, int] | None:
    """Tight latent-space bbox of non-zero mask values. Returns
    (y_min, y_max, x_min, x_max) or None if the mask is empty.

    Threshold of 0.01 includes the feathered edge — bbox covers the
    full soft-edge region not just the binary interior.
    """
    m = mask[0] if mask.dim() == 3 else mask
    nz = m > 0.01
    if not nz.any():
        return None
    rows = nz.any(dim=1)
    cols = nz.any(dim=0)
    ridx = rows.nonzero(as_tuple=False).squeeze(-1)
    cidx = cols.nonzero(as_tuple=False).squeeze(-1)
    return (
        int(ridx[0].item()),
        int(ridx[-1].item()) + 1,
        int(cidx[0].item()),
        int(cidx[-1].item()) + 1,
    )


def _fine_upscale_factor(
    bbox_w_latent: int,
    bbox_h_latent: int,
    scale_x: float,
    scale_y: float,
    target_mp: float,
    max_linear: float,
) -> float:
    """Linear scale factor to apply to the cropped latent so that the
    crop is processed at ≥ target_mp (in image-pixel-equivalent terms),
    clamped to max_linear. Returns 1.0 when the crop already meets
    target — no upscale needed."""
    if scale_x <= 0 or scale_y <= 0:
        return 1.0
    bbox_w_pix = bbox_w_latent / scale_x
    bbox_h_pix = bbox_h_latent / scale_y
    current_mp = bbox_w_pix * bbox_h_pix / 1_000_000.0
    if current_mp <= 0 or current_mp >= target_mp:
        return 1.0
    needed = math.sqrt(target_mp / current_mp)
    return min(needed, max_linear)


def _resize_latent(t: torch.Tensor, target_h: int, target_w: int, method: str) -> torch.Tensor:
    """Resize the spatial dims of a latent or mask tensor using one of
    ComfyUI's standard latent-resize methods. Accepts [C,H,W], [B,C,H,W],
    or [1,H,W] (mask). Returns the same rank as input.

    `method` is one of _FINE_UPSCALE_RESIZE_METHODS. Routes through
    comfy.utils.common_upscale so bislerp + lanczos custom paths work."""
    method = method if method in _FINE_UPSCALE_RESIZE_METHODS else "nearest-exact"
    if t.dim() == 3:
        t4 = t.unsqueeze(0)
        out = comfy.utils.common_upscale(t4, target_w, target_h, method, "disabled")
        return out.squeeze(0)
    if t.dim() == 4:
        return comfy.utils.common_upscale(t, target_w, target_h, method, "disabled")
    raise ValueError(f"_resize_latent: unexpected ndim {t.dim()}")


def _refine_with_fine_upscaling(
    *,
    model,
    vae,
    current: torch.Tensor,    # [B, C, H_lat, W_lat] cached full-res latent
    mask: torch.Tensor,        # [1, H_lat, W_lat] feathered mask, latent res
    scale_x: float,
    scale_y: float,
    target_mp: float,
    max_linear: float,
    resize_method: str,
    context_pad_pixel: int,
    inpainting_mode: str,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    positive,
    negative,
    denoise: float,
    callback,
    disable_pbar: bool,
) -> torch.Tensor:
    """Pixel-space crop + upscale + VAE encode + refine + VAE decode +
    downscale + composite + VAE encode. The latent-space crop+upscale
    approach smears bilinearly-interpolated latents into a low-freq
    starting state that the model can't recover detail from. Going
    through pixel space (where there's an image-upscale toolkit that's
    been tuned for natural images) and re-encoding gives the model a
    "natural" latent at the higher resolution to denoise from.

    Cost: 2 VAE encodes + 1 VAE decode added per Fine Upscale refine
    (the existing end-of-run preview decode is unchanged). For FLUX 2
    Klein on a 5090 that's about 0.5-1s extra per click.

    Returns the new full-resolution refined latent, or `current`
    unchanged if the mask bbox is empty / degenerate.
    """
    bbox = _mask_bbox_latent(mask)
    if bbox is None:
        return current
    y0_tight, y1_tight, x0_tight, x1_tight = bbox

    # Apply context padding: grow the bbox outward by context_pad_pixel
    # in every direction (clamped to the latent boundaries). This is
    # the area the model SEES during refine. The painted-shape mask
    # stays unchanged — areas inside the padded bbox but outside the
    # painted shape have mask=0 in the cropped tensor, so the noise-
    # injection inpaint preserves them as context (the model uses them
    # to inform what to draw inside the mask, but doesn't overwrite
    # them). All downstream code uses the PADDED bbox.
    H_lat = current.shape[-2]
    W_lat = current.shape[-1]
    pad_lat_y = max(0, round(context_pad_pixel * scale_y))
    pad_lat_x = max(0, round(context_pad_pixel * scale_x))
    y0 = max(0, y0_tight - pad_lat_y)
    y1 = min(H_lat, y1_tight + pad_lat_y)
    x0 = max(0, x0_tight - pad_lat_x)
    x1 = min(W_lat, x1_tight + pad_lat_x)

    bbox_h_lat = y1 - y0
    bbox_w_lat = x1 - x0
    if bbox_h_lat <= 0 or bbox_w_lat <= 0:
        return current

    scale = _fine_upscale_factor(bbox_w_lat, bbox_h_lat, scale_x, scale_y, target_mp, max_linear)
    if scale <= 1.0:
        # No upscale needed — fall back to the standard latent-space
        # noise-injection inpaint. Avoids unnecessary VAE round-trips
        # when the painted region already meets the MP target.
        print(f"[Angelo fine-upscale] scale=1.0 — using latent-space path (no VAE round-trip)")
        noise = comfy.sample.prepare_noise(current, seed, None)
        return comfy.sample.sample(
            model, noise, steps, cfg, sampler_name, scheduler,
            positive, negative, current,
            denoise=denoise,
            noise_mask=mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=seed,
        )

    # ----- VAE decode the full cached latent → cached pixels -----
    cached_pixels = vae.decode(current)  # (B, H_pix, W_pix, C) float [0,1]
    H_pix = cached_pixels.shape[1]
    W_pix = cached_pixels.shape[2]
    # Pixel-per-latent ratio per axis (16 for FLUX 2, 8 for SDXL/SD1.5)
    px_per_lat_y = max(1, H_pix // current.shape[-2])
    px_per_lat_x = max(1, W_pix // current.shape[-1])

    # Pixel-space bbox derived from the latent-space bbox.
    y0_p = y0 * px_per_lat_y
    y1_p = y1 * px_per_lat_y
    x0_p = x0 * px_per_lat_x
    x1_p = x1 * px_per_lat_x
    bbox_h_p = y1_p - y0_p
    bbox_w_p = x1_p - x0_p

    # Upscaled target dims in pixel space. Snap to multiples of the
    # VAE downscale (16 for FLUX 2) so the subsequent VAE encode
    # produces a clean integer-dim latent.
    vae_snap = max(px_per_lat_y, px_per_lat_x)
    target_h_p = max(vae_snap, math.ceil(bbox_h_p * scale / vae_snap) * vae_snap)
    target_w_p = max(vae_snap, math.ceil(bbox_w_p * scale / vae_snap) * vae_snap)

    print(f"[Angelo fine-upscale] bbox_lat=(h={bbox_h_lat}, w={bbox_w_lat}) "
          f"bbox_px=(h={bbox_h_p}, w={bbox_w_p}) scale={scale:.2f} "
          f"target_px=(h={target_h_p}, w={target_w_p}) "
          f"resize={resize_method} max_linear={max_linear} "
          f"vae_ratio=(x={px_per_lat_x}, y={px_per_lat_y})")

    # ----- Crop pixel image + upscale in pixel space -----
    pixel_crop = cached_pixels[:, y0_p:y1_p, x0_p:x1_p, :]  # (B, h, w, C)
    # common_upscale expects (B, C, H, W) — permute, upscale, permute back.
    pixel_crop_chw = pixel_crop.movedim(-1, 1)
    pixel_crop_up_chw = comfy.utils.common_upscale(
        pixel_crop_chw, target_w_p, target_h_p, resize_method, "disabled",
    )
    pixel_crop_up = pixel_crop_up_chw.movedim(1, -1)  # back to (B, H, W, C)

    # ----- VAE encode the upscaled pixel crop → latent at high res -----
    latent_up = vae.encode(pixel_crop_up)
    target_h_lat = latent_up.shape[-2]
    target_w_lat = latent_up.shape[-1]

    # ----- Build mask at the upscaled latent resolution -----
    # Mask resizing always uses bilinear regardless of the user's choice.
    # The user's resize_method is for the IMAGE content upscale (where
    # lanczos / bicubic / etc. have real quality differences). The mask
    # is a 1-channel feathered alpha where we just want smooth values;
    # lanczos's grayscale-branch returns a transposed 3D tensor (PIL
    # quirk) and bislerp's spherical-vector math is semantically wrong
    # on a single channel.
    mask_crop = mask[..., y0:y1, x0:x1].contiguous()
    mask_crop_up = _resize_latent(mask_crop, target_h_lat, target_w_lat, "bilinear").clamp(0.0, 1.0)

    # ===== Smart Inpaint pre-processing on the upscaled patch =====
    # Klein 9B's edit branch only activates when reference_latents is
    # present on the conditioning. We then zero the masked area so the
    # sampler regenerates that region from full noise at sigma_max
    # (the denoise=1.0 lock makes this clean: every pixel in the
    # painted rect is brand-new content, with the surrounding context
    # band restored each step by the noise_mask compositing). The
    # reference uses the PRE-ZERO upscaled patch so Klein still sees
    # what was there before we blanked it.
    # POSITIVE ONLY — putting reference_latents on negative would tell
    # CFG>1 samplers to steer AWAY from the reference scene. Non-edit
    # models ignore the field, so this is harmless on any checkpoint.
    if inpainting_mode == "Smart Inpaint":
        reference_latent = latent_up.clone()
        positive = node_helpers.conditioning_set_values(
            positive, {"reference_latents": [reference_latent]}, append=True,
        )
        m = mask_crop_up.unsqueeze(0)
        latent_up = (1.0 - m) * latent_up

    # ----- Refine via noise-injection inpaint on the upscaled latent -----
    noise = comfy.sample.prepare_noise(latent_up, seed, None)
    refined_latent_up = comfy.sample.sample(
        model, noise, steps, cfg, sampler_name, scheduler,
        positive, negative, latent_up,
        denoise=denoise,
        noise_mask=mask_crop_up,
        callback=callback,
        disable_pbar=disable_pbar,
        seed=seed,
    )

    # ----- VAE decode refined latent → high-res pixel patch -----
    refined_pixel_up = vae.decode(refined_latent_up)  # (B, target_h_p, target_w_p, C)

    # ----- Downscale refined patch back to original bbox pixel size -----
    refined_pixel_up_chw = refined_pixel_up.movedim(-1, 1)
    refined_pixel_chw = comfy.utils.common_upscale(
        refined_pixel_up_chw, bbox_w_p, bbox_h_p, resize_method, "disabled",
    )
    refined_pixel = refined_pixel_chw.movedim(1, -1)  # (B, bbox_h_p, bbox_w_p, C)

    # ----- Composite refined patch into the cached pixel image -----
    # Build a pixel-space alpha by resizing the latent feathered mask to
    # full pixel resolution, cropping to the bbox. Always bilinear for
    # the same reasons as the mask upscale above — lanczos's grayscale
    # path is broken, bislerp doesn't apply to 1-channel.
    mask_4d = mask.unsqueeze(0)  # [1, 1, H_lat, W_lat]
    pixel_mask = comfy.utils.common_upscale(
        mask_4d, W_pix, H_pix, "bilinear", "disabled",
    ).clamp(0.0, 1.0)  # [1, 1, H_pix, W_pix]
    pixel_alpha_crop = pixel_mask[0, 0, y0_p:y1_p, x0_p:x1_p]  # [bbox_h_p, bbox_w_p]
    pixel_alpha_crop = pixel_alpha_crop.unsqueeze(0).unsqueeze(-1)  # [1, h, w, 1]

    new_pixels = cached_pixels.clone()
    pixel_orig_crop = cached_pixels[:, y0_p:y1_p, x0_p:x1_p, :]
    composited = refined_pixel * pixel_alpha_crop + pixel_orig_crop * (1.0 - pixel_alpha_crop)
    new_pixels[:, y0_p:y1_p, x0_p:x1_p, :] = composited

    # ----- VAE encode the composited full image → encoded latent -----
    encoded_latent = vae.encode(new_pixels)

    # ----- Blend in LATENT space using the feathered mask as alpha -----
    # The VAE encode is lossy, so naively returning encoded_latent would
    # mean the *unaltered* regions of the image drift slightly with every
    # Fine Upscale click. Avoidable: keep the original cached latent
    # outside the mask, take the encoded latent inside the mask. Mask is
    # already feathered, so the transition is smooth. Now unaltered
    # regions stay bit-exact across successive clicks; only the masked
    # area accumulates any VAE-roundtrip cost (and it gets a fresh
    # refine each click anyway, so any drift there is overwritten).
    alpha_lat = mask.unsqueeze(0)  # [1, 1, H_lat, W_lat]
    new_latent = encoded_latent * alpha_lat + current * (1.0 - alpha_lat)
    return new_latent


def _circle_mask_latent_direct(
    latent_h: int,
    latent_w: int,
    cx_latent: float,
    cy_latent: float,
    r_latent: float,
    device: torch.device,
) -> torch.Tensor:
    """Build a binary [1, latent_h, latent_w] mask with a filled circle
    centred on (cx_latent, cy_latent) of radius `r_latent`, all in
    latent-space coordinates. The caller is responsible for converting
    pixel-space click coords to latent space using the correct per-axis
    scale (image_dim_pixel → latent_dim) so this function stays VAE-
    agnostic.
    """
    ys = torch.arange(latent_h, device=device, dtype=torch.float32).view(-1, 1)
    xs = torch.arange(latent_w, device=device, dtype=torch.float32).view(1, -1)
    dist2 = (xs - cx_latent) ** 2 + (ys - cy_latent) ** 2
    mask = (dist2 <= r_latent * r_latent).to(torch.float32)
    return mask.unsqueeze(0)  # [1, H, W]


def _gaussian_blur_2d(mask: torch.Tensor, sigma_latent: float) -> torch.Tensor:
    """Separable gaussian blur on a [B, H, W] or [H, W] mask tensor.

    sigma_latent is in latent-space units.
    """
    if sigma_latent <= 0:
        return mask
    # Kernel covers ~±3σ. Force odd size.
    ksize = int(2 * math.ceil(3 * sigma_latent) + 1)
    half = ksize // 2
    x = torch.arange(ksize, device=mask.device, dtype=torch.float32) - half
    k1d = torch.exp(-0.5 * (x / sigma_latent) ** 2)
    k1d = k1d / k1d.sum()

    # Reshape mask to [N, 1, H, W]
    orig_ndim = mask.dim()
    if orig_ndim == 2:
        m = mask.unsqueeze(0).unsqueeze(0)
    elif orig_ndim == 3:
        m = mask.unsqueeze(1)
    elif orig_ndim == 4:
        m = mask
    else:
        raise ValueError(f"gaussian_blur_2d: unexpected mask ndim {orig_ndim}")

    kh = k1d.view(1, 1, 1, ksize)
    kv = k1d.view(1, 1, ksize, 1)

    m = torch.nn.functional.pad(m, (half, half, 0, 0), mode="replicate")
    m = torch.nn.functional.conv2d(m, kh)
    m = torch.nn.functional.pad(m, (0, 0, half, half), mode="replicate")
    m = torch.nn.functional.conv2d(m, kv)

    if orig_ndim == 2:
        return m.squeeze(0).squeeze(0)
    if orig_ndim == 3:
        return m.squeeze(1)
    return m


def _decode_to_preview(vae, latent_samples: torch.Tensor):
    """Decode the latent and save to the temp directory in the same
    format PreviewImage uses, so we can return the same ui dict shape.

    Returns (image_tensor, list_of_image_refs). Each image ref is a
    {filename, subfolder, type} dict.
    """
    image = vae.decode(latent_samples)  # (B, H, W, C) float in [0, 1]

    # Reuse PreviewImage's save logic via a transient instance.
    previewer = comfy_nodes.PreviewImage()
    ui = previewer.save_images(image, filename_prefix="Angelo_preview")
    return image, ui["ui"]["images"]


class AngeloRefine:
    """Click-to-refine sampler. See module docstring."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent": ("LATENT",),
                "vae": ("VAE",),

                # ===== Sampler Mode controls (top of native widget area) =====
                # Visible in the node body. When `mode == "Sampler Mode"`, the
                # toolbar is greyed and canvas clicks do nothing — this widget
                # group is the active one, producing the base latent from the
                # incoming latent via comfy.sample.sample. When mode flips to
                # Refinement, sampler_seed_control is auto-forced to "fixed"
                # so subsequent Queue presses don't regenerate the base.
                "mode": (["Sampler Mode", "Edit Mode"], {"default": "Sampler Mode",
                                                                "tooltip": "Sampler Mode: AngeloRefine acts "
                                                                           "like a KSampler — generates the "
                                                                           "base latent from the incoming "
                                                                           "(usually empty) latent. Toolbar "
                                                                           "and canvas clicks are inert. "
                                                                           "Edit Mode: click / paint / drag "
                                                                           "to refine or inpaint the cached "
                                                                           "base. Switching to Edit Mode auto-"
                                                                           "locks sampler_seed_control to "
                                                                           "'fixed' so the base stays stable."}),
                "sampler_denoise": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1.0, "step": 0.05,
                                              "tooltip": "[Sampler Mode] Denoise level for the base "
                                                         "generation. 1.0 = generate fully from noise "
                                                         "(KSampler default). Lower = img2img-style from "
                                                         "the incoming latent."}),
                "sampler_seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                                         "control_after_generate": False,
                                         "tooltip": "[Sampler Mode] Seed for the base generation. "
                                                    "Controlled by sampler_seed_control after each run."}),
                "sampler_seed_control": (["fixed", "increment", "decrement", "randomize"],
                                         {"default": "fixed",
                                          "tooltip": "[Sampler Mode] After-generation seed behaviour. "
                                                     "Auto-forced to 'fixed' when you switch to Edit "
                                                     "Mode so the cached base stays stable across the "
                                                     "refine clicks."}),

                # ===== Edit Mode controls (driven from toolbar) =====
                # Hidden from the native widget area; the toolbar above the
                # preview canvas drives these. seed_control follows the same
                # fixed/random/increment/decrement pattern as sampler_seed.
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                                 "control_after_generate": False,
                                 "tooltip": "[Edit Mode] Seed for the refine pass. Hidden — "
                                            "controlled by the Seed input on the toolbar."}),
                "seed_control": (["fixed", "increment", "decrement", "randomize"],
                                 {"default": "randomize",
                                  "tooltip": "[Edit Mode] After-click seed behaviour. Hidden — "
                                             "controlled by the Seed Ctrl dropdown on the toolbar. "
                                             "Defaults to randomize so each refine click produces a "
                                             "fresh variation rather than repeating the same result."}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 100,
                                  "tooltip": "Match the model's expected step count. "
                                             "FLUX 2 Klein distilled = 4."}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1,
                                  "tooltip": "FLUX 2 Klein distilled uses CFG=1 (no negative)."}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "denoise": ("FLOAT", {"default": 0.5, "min": 0.05, "max": 1.0, "step": 0.05,
                                      "tooltip": "How much noise to add back for the refinement. "
                                                 "0.3 = subtle touch-up, 0.6 = real redo, "
                                                 "0.9+ = essentially regenerate that region."}),

                "click_radius": ("INT", {"default": 96, "min": 8, "max": 1024, "step": 4,
                                         "tooltip": "Pixel-space radius of the refinement region. "
                                                    "Updated automatically by the JS click widget."}),
                "feather_radius": ("INT", {"default": 24, "min": 0, "max": 256, "step": 4,
                                           "tooltip": "Pixel-space gaussian blur applied to the mask "
                                                      "before sampling. Smooths the seam between the "
                                                      "refined region and the preserved surroundings. "
                                                      "Roughly half of click_radius is a good default."}),

                # JS-driven widgets. click_x/y in pixel space; -1 = no click yet.
                # click_seq increments per click to force ComfyUI to detect a change
                # and re-execute this node (otherwise identical inputs would skip).
                # image_w/h are the actual decoded image dimensions in pixels —
                # set by the JS whenever a fresh preview is loaded into the canvas,
                # so we can compute the correct pixel→latent scale without
                # hardcoding the VAE downscale factor (FLUX 2 is 16, FLUX 1 / SDXL
                # are 8, exotic VAEs vary).
                "click_x": ("INT", {"default": -1, "min": -1, "max": 16384}),
                "click_y": ("INT", {"default": -1, "min": -1, "max": 16384}),
                "click_seq": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF}),
                "image_w": ("INT", {"default": 0, "min": 0, "max": 16384}),
                "image_h": ("INT", {"default": 0, "min": 0, "max": 16384}),
                # Undo bookkeeping: undo_seq increments when the user clicks
                # the Undo button. Python pops the last refined latent off
                # the history stack on each new undo_seq value.
                "undo_seq": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF}),

                "reset": ("BOOLEAN", {"default": False,
                                      "tooltip": "Tick + re-queue to discard the cached refined "
                                                 "latent and start over from the incoming latent."}),
                # DEPRECATED as a control — always-on now. Kept declared
                # (not removed) so its slot in widgets_values stays put;
                # deleting it would shift every later widget's position
                # and drift old saved workflows on load. Hidden in the UI;
                # run() ignores the value and always decodes the preview.
                "auto_decode": ("BOOLEAN", {"default": True,
                                            "tooltip": "(Deprecated — preview always decodes now.)"}),

                # STEP 2 of the Fine Upscaling re-introduction: JS toggle
                # bar drives these. Both widgets are hidden from the node
                # UI; the green "Fine Upscale" toggle and the small "MP"
                # numeric input on the bar above the preview canvas are
                # the user-facing surface. Python's run() still prints the
                # received values so we can verify the JS bar correctly
                # drives them. SAMPLING IS STILL UNCHANGED — neither value
                # is read by any code path below the print. Step 3 wires
                # the actual crop+upscale+refine.
                "fine_upscaling": ("BOOLEAN", {"default": False,
                                               "tooltip": "When ON, the painted region is cropped, "
                                                          "bilinear-upscaled in latent space to hit "
                                                          "min_megapixels, refined, downscaled, and "
                                                          "composited back. Gives the model more "
                                                          "effective resolution on small painted "
                                                          "regions. Upscale capped at 8× linear "
                                                          "internally. Set via the Fine Upscale "
                                                          "toggle above the preview."}),
                "min_megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 4.0, "step": 0.1,
                                             "tooltip": "Target megapixels for the refine pass when "
                                                        "Fine Upscaling is on. Only used in that mode. "
                                                        "Set via the MP input above the preview."}),
                "max_upscale": ("FLOAT", {"default": 8.0, "min": 1.0, "max": 16.0, "step": 0.5,
                                          "tooltip": "Hard cap on the linear upscale factor in Fine "
                                                     "Upscaling. 8.0 was the original internal default. "
                                                     "Lower values reduce smoothing artifacts from "
                                                     "extreme upscales at the cost of less effective "
                                                     "resolution gain. Set via the Max input above "
                                                     "the preview."}),
                "resize_method": (_FINE_UPSCALE_RESIZE_METHODS, {"default": "lanczos",
                                                                 "tooltip": "Pixel-space upscale method for "
                                                                            "Fine Upscale. lanczos is the "
                                                                            "default — sharpest detail recovery "
                                                                            "for natural images. bilinear is "
                                                                            "smooth (good for skin/faces); "
                                                                            "bicubic middle ground; nearest-"
                                                                            "exact preserves exact sample values; "
                                                                            "area/bislerp niche."}),
                "inpainting_mode": (["Refine", "Smart Inpaint", "Smart Guided Inpaint"], {"default": "Refine",
                                                                  "tooltip": "How the painted region is treated.\n\n"
                                                                             "Refine — the painted region is partially "
                                                                             "denoised from the existing content. Best "
                                                                             "for refining what's already there (faces, "
                                                                             "hands, textures). Paint/click as normal.\n\n"
                                                                             "Smart Inpaint — adds NEW content where you "
                                                                             "drag a rectangle. Click+hold one corner, "
                                                                             "release at the opposite corner. Locks "
                                                                             "denoise=1.0, Fine Upscale=ON, Ctx Pad=0 "
                                                                             "(the right defaults for adding new subjects "
                                                                             "with an edit model — Klein 9B etc.). "
                                                                             "Reference_latents are auto-injected so the "
                                                                             "model's edit branch activates.\n\n"
                                                                             "Smart Guided Inpaint — no painting or boxes. "
                                                                             "Pick a location from the dropdown above the "
                                                                             "Area Prompt; it's prepended to your prompt "
                                                                             "(e.g. 'In the top left of the image, ...') "
                                                                             "and the edit model places the content there "
                                                                             "across the whole image. Locks denoise=1.0, "
                                                                             "Fine Upscale=OFF, Area Prompt=ON; press "
                                                                             "'Generate Guided Edit' to run."}),

                # Hidden — DOM location dropdown (Smart Guided Inpaint)
                # drives this. Holds a LABEL key from
                # _GUIDED_LOCATION_PREFIXES; run() maps it to the prompt
                # prefix at encode time.
                "guided_location": ("STRING", {"default": "(none)", "multiline": False}),

                "fine_context_pad": ("INT", {"default": 64, "min": 0, "max": 512, "step": 8,
                                              "tooltip": "[Fine Upscale] Pixel-space padding around the "
                                                         "painted-shape bbox before cropping. Gives the "
                                                         "model surrounding context (skin, hair, "
                                                         "background) so a tight face mask at high denoise "
                                                         "still produces a coherent face that matches its "
                                                         "surroundings. The painted shape is unchanged — "
                                                         "only the area the model SEES grows. Outside the "
                                                         "painted shape, the surrounding pixels are "
                                                         "preserved (not refined). Larger pad = more "
                                                         "context + less effective resolution on the "
                                                         "painted area (bump MP to compensate)."}),

                "persistent_mask": ("BOOLEAN", {"default": False,
                                                "tooltip": "When ON, the last mask used (click point or paint "
                                                           "stroke) is held in the node. Pressing the standard "
                                                           "ComfyUI Queue button re-runs the workflow with that "
                                                           "same mask + a fresh seed, giving a variation of just "
                                                           "that region while leaving the rest of the cached "
                                                           "image unchanged. Toggled via the Persistent Mask "
                                                           "button above the preview."}),

                "paint_mode": ("BOOLEAN", {"default": False,
                                           "tooltip": "When ON, hold + drag on the preview paints a "
                                                      "freeform brush stroke (each dragged point is the "
                                                      "centre of a circle of click_radius; the union is "
                                                      "the refine mask). Release to submit. Single clicks "
                                                      "in paint mode work as one-point strokes. When OFF, "
                                                      "clicks behave as before (single-circle refine)."}),

                # Hidden — JS-set JSON list of [x_pixel, y_pixel] points
                # captured during a paint drag. Empty when no paint stroke
                # is pending (e.g. the user just single-clicked instead).
                "stroke_points": ("STRING", {"default": "", "multiline": False}),

                # Hidden — JS-set JSON list of [x1, y1, x2, y2] rectangles
                # in image-pixel coords, captured during Smart Inpaint
                # rectangle drags. The backend uses only the most recent
                # entry as the active mask.
                "rect_points": ("STRING", {"default": "", "multiline": False}),

                "area_prompt": ("BOOLEAN", {"default": False,
                                            "tooltip": "When ON, refinements encode the Area Prompt text "
                                                       "(typed in the box below the canvas) with the "
                                                       "connected CLIP and use it instead of the main "
                                                       "positive/negative — useful for reshaping a region "
                                                       "with a different prompt (e.g. main prompt = wide "
                                                       "shot, area prompt = \"detailed face, photorealistic "
                                                       "eyes\"). The click-and-mask behaviour is unchanged; "
                                                       "only the prompt differs. If CLIP isn't connected or "
                                                       "the area text is empty, the main positive/negative "
                                                       "are used. Forced ON in Smart Inpaint."}),

                # Hidden — DOM text box below the canvas drives these.
                # The Area Prompt input has a Pos/Neg toggle that decides
                # which of these two the textarea is editing. Encoded
                # with the connected CLIP at run time when area_prompt is
                # on. Negative is usually unused (Klein / CFG=1) but kept
                # for non-distilled models.
                "area_text_positive": ("STRING", {"default": "", "multiline": True}),
                "area_text_negative": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                # CLIP / text encoder for the Area Prompt. Optional —
                # without it the area text is ignored and the main
                # positive/negative are used.
                "clip": ("CLIP",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("image", "latent")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "sampling/Angelo"
    DESCRIPTION = (
        "Click-to-refine sampler. Click a region in the preview to do "
        "extra denoising on just that area while the rest of the latent "
        "is preserved. Repeated clicks layer refinements on top of each other."
    )

    def run(
        self,
        model,
        positive,
        negative,
        latent,
        vae,
        mode,
        sampler_denoise,
        sampler_seed,
        sampler_seed_control,
        seed,
        seed_control,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        click_radius,
        feather_radius,
        click_x,
        click_y,
        click_seq,
        image_w,
        image_h,
        undo_seq,
        reset,
        auto_decode,
        fine_upscaling,
        min_megapixels,
        max_upscale,
        resize_method,
        inpainting_mode,
        fine_context_pad,
        persistent_mask,
        paint_mode,
        stroke_points,
        rect_points,
        area_prompt,
        guided_location="(none)",
        area_text_positive="",
        area_text_negative="",
        clip=None,
        unique_id=None,
    ):
        node_id = str(unique_id)
        incoming = latent["samples"]
        incoming_fp = _latent_fingerprint(incoming)

        # ===== Smart Inpaint locks =====
        # The whole point of Smart Inpaint as a mode is to opinionate
        # the params that matter for "add new content in a rectangle"
        # workflows. Override the widget values up front so every code
        # path downstream sees the locked values regardless of what
        # the user set the toolbar to.
        # area_prompt ON makes Smart Inpaint encode the Area Prompt
        # text (typed below the canvas) with the connected CLIP and use
        # it — a separate "what to insert" prompt is usually what you
        # want alongside a wider scene prompt on the main inputs. If no
        # CLIP is wired or the area text is empty, the toggle is a no-op
        # and the main positive is used (see the area-conditioning block
        # further down in run()), so forcing ON is always safe.
        if inpainting_mode == "Smart Inpaint":
            denoise = 1.0
            fine_context_pad = 0
            fine_upscaling = True
            area_prompt = True
            # feather_radius is left under user control — a soft edge can
            # help blend the inserted content into the surroundings.
        elif inpainting_mode == "Smart Guided Inpaint":
            # No painting / boxes — the whole image is edited and the
            # location dropdown supplies a prompt prefix that tells the
            # edit model where to place the content. No region to crop
            # (Fine Upscale OFF), no mask edge to feather, and no mask to
            # persist (Persistent Mask is meaningless here).
            denoise = 1.0
            fine_context_pad = 0
            fine_upscaling = False
            area_prompt = True
            feather_radius = 0
            persistent_mask = False

        # ===== Sampler Mode branch =====
        # Acts like a KSampler: take the incoming latent (typically empty),
        # run a fresh denoise pass with sampler_seed + sampler_denoise, cache
        # the result as the new base. All toolbar / canvas / refine logic is
        # skipped — those are Edit Mode concerns.
        if mode == "Sampler Mode":
            callback = latent_preview.prepare_callback(model, steps)
            disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
            noise = comfy.sample.prepare_noise(incoming, sampler_seed, None)
            new_latent = comfy.sample.sample(
                model, noise, steps, cfg, sampler_name, scheduler,
                positive, negative, incoming,
                denoise=sampler_denoise,
                callback=callback,
                disable_pbar=disable_pbar,
                seed=sampler_seed,
            )
            # Replace the cache with the freshly-sampled base. Drops the
            # undo history (it's irrelevant — we have a brand-new image).
            #
            # CRITICAL: store the fingerprint of the INCOMING latent, not
            # the freshly-generated new_latent. The fingerprint is the
            # "did upstream change?" signal used by Edit Mode's
            # auto-reset check. If we stored new_latent's fingerprint,
            # Edit Mode would always see (cached_fp != incoming_fp)
            # → think upstream changed → wipe cache → refine the empty
            # latent. Storing incoming_fp means Refinement only resets
            # when the user actually rewires upstream.
            #
            # sampler_seed_at_run = the seed Python used. Sent back to JS
            # via the ui message so JS can (a) apply after-gen control
            # next, and (b) restore this value if the user later switches
            # the control to "fixed".
            _STATE[node_id] = {
                "history": [new_latent],
                "click_seq": click_seq,
                "undo_seq": undo_seq,
                "fingerprint": incoming_fp,
                "sampler_seed_at_run": int(sampler_seed),
            }
            out_latent = {"samples": new_latent}
            ui_msg = {
                "Angelo_preview": [],
                "Angelo_mode": ["Sampler Mode"],
                "Angelo_sampler_seed_at_run": [int(sampler_seed)],
            }
            # Preview always decodes now (auto_decode deprecated).
            image, image_refs = _decode_to_preview(vae, new_latent)
            ui_msg["Angelo_preview"] = image_refs
            return {"ui": ui_msg, "result": (image, out_latent)}

        # ===== Edit Mode branch (existing behaviour) =====

        # Decide whether to (re)seed the cache from the incoming latent.
        # Reset on explicit toggle, first run, or fingerprint change —
        # but NOT on fingerprint change while persistent_mask is on, because
        # the whole point of persistent_mask is to keep refining the cached
        # latent across upstream re-rolls (the user's pressing Queue
        # specifically because they want a variation of the held region,
        # not a fresh image).
        state = _STATE.get(node_id)
        fingerprint_changed = state is not None and state.get("fingerprint") != incoming_fp
        need_reset = (
            reset
            or state is None
            or (fingerprint_changed and not persistent_mask)
        )

        if need_reset:
            _STATE[node_id] = {
                "history": [incoming.clone()],
                "click_seq": -1,
                "undo_seq": -1,
                "fingerprint": incoming_fp,
            }
            state = _STATE[node_id]

        # Undo: if undo_seq advanced and we have history to pop, pop it.
        # We always keep at least one latent (the base / earliest refine)
        # so the preview stays valid.
        new_undo = undo_seq > 0 and undo_seq != state.get("undo_seq", -1)
        if new_undo:
            if len(state["history"]) > 1:
                state["history"].pop()
            state["undo_seq"] = undo_seq

        current = state["history"][-1]

        # Has the user clicked since our last execution for this node?
        new_click = (
            click_x >= 0
            and click_y >= 0
            and click_seq != state["click_seq"]
        )

        # Distinguish "genuine new click" (mask data changed, user has
        # chosen a new region) from "persistent_mask Queue press" (only
        # click_seq bumped, mask data same as last time). The JS hook
        # for persistent_mask bumps click_seq WITHOUT touching click_x/y
        # or stroke_points; a real click handler updates both. Compare
        # to the last-processed values to tell them apart.
        is_genuine_new_input = False
        if new_click:
            last_x = state.get("last_click_x", click_x - 1)
            last_y = state.get("last_click_y", click_y - 1)
            last_stroke = state.get("last_stroke_points", "__sentinel__")
            is_genuine_new_input = (
                click_x != last_x
                or click_y != last_y
                or stroke_points != last_stroke
            )

        # Persistent-mask base snapshot management. The snapshot is the
        # source latent that every persistent_mask Queue press refines
        # FROM, so each variation starts from the same base instead of
        # iterating on the previous refine (which drifts).
        # Lifecycle:
        #   - persistent_mask OFF: snapshot cleared (no-op if already absent)
        #   - persistent_mask ON + genuine new click: snapshot the
        #     POST-refine result (next Queue presses iterate from this
        #     new region's just-refined state)
        #   - persistent_mask ON + Queue press: use existing snapshot
        #     (or snapshot the current cache if none exists yet)
        if not persistent_mask:
            state.pop("persistent_mask_base", None)

        if new_click:
            # Pixel → latent conversion. The JS sends us the actual image
            # dimensions (image_w, image_h) so we can derive the per-axis
            # scale dynamically rather than hardcoding a VAE downscale
            # factor — that breaks for FLUX 2 (16×) vs FLUX 1 / SDXL (8×).
            # Fall back to 8× only if image dims weren't provided (shouldn't
            # happen in normal use).
            latent_h = current.shape[-2]
            latent_w = current.shape[-1]
            if image_w > 0 and image_h > 0:
                scale_x = latent_w / image_w
                scale_y = latent_h / image_h
            else:
                # Fallback for headless tests / direct node use without the
                # JS widget populating image_w/h. 8× is the most common VAE
                # downscale (FLUX 1, SDXL, SD1.5) but breaks for FLUX 2 (16×).
                scale_x = scale_y = 1.0 / 8.0
                print("[Angelo] warning: image_w/h not set by JS; "
                      "falling back to 8x VAE assumption — may be wrong for FLUX 2")

            r_latent = max(1.0, click_radius * scale_x)
            sigma_latent = (feather_radius * scale_x) if feather_radius > 0 else 0.0

            # Build the mask. Sources of mask shape, in priority:
            #   1. Smart Guided Inpaint: full-image (no region — the whole
            #      image is edited, location comes from the prompt prefix).
            #   2. Smart Inpaint: a single rectangle from rect_points.
            #   3. Refine + paint_mode + stroke points: union of brush
            #      circles along the drag path.
            #   4. Refine single-click: one circle at (click_x, click_y).
            if inpainting_mode == "Smart Guided Inpaint":
                mask = torch.ones((1, latent_h, latent_w),
                                  device=current.device, dtype=torch.float32)
            elif inpainting_mode == "Smart Inpaint":
                rect = _parse_rect_points(rect_points)
                if rect is not None:
                    mask = _rect_mask_latent(
                        latent_h, latent_w, rect,
                        scale_x, scale_y, current.device,
                    )
                else:
                    # No rectangle drawn yet — nothing to do. Caller
                    # already gates on click_seq change so this is the
                    # "user switched into Smart Inpaint without dragging
                    # a rect" case; fall through with an empty mask and
                    # let downstream noise_mask handling preserve the
                    # cached latent.
                    mask = torch.zeros((1, latent_h, latent_w),
                                       device=current.device, dtype=torch.float32)
            else:
                stroke_pts = _parse_stroke_points(stroke_points) if paint_mode else []
                if stroke_pts:
                    mask = _stroke_mask_latent(
                        latent_h, latent_w,
                        stroke_pts, r_latent,
                        scale_x, scale_y, current.device,
                    )
                else:
                    cx_latent = click_x * scale_x
                    cy_latent = click_y * scale_y
                    mask = _circle_mask_latent_direct(
                        latent_h, latent_w,
                        cx_latent, cy_latent, r_latent,
                        current.device,
                    )
            if sigma_latent > 0:
                mask = _gaussian_blur_2d(mask, max(0.5, sigma_latent))
                mask = mask.clamp(0.0, 1.0)

            # Area-prompt conditioning selection. When area_prompt is on
            # AND a CLIP is connected AND there's positive area text, encode
            # the area text and use it for this refine. Negative area text
            # is optional — falls back to the main negative when empty
            # (fine for CFG=1 / distilled models that ignore it anyway).
            #
            # Smart Guided Inpaint prepends a location prefix to the
            # positive text (e.g. "In the top left of the image, ") so the
            # edit model places the content at the chosen spot.
            area_pos_text = str(area_text_positive)
            if inpainting_mode == "Smart Guided Inpaint":
                prefix = _GUIDED_LOCATION_PREFIXES.get(str(guided_location), "")
                area_pos_text = prefix + area_pos_text
            if area_prompt and clip is not None and area_pos_text.strip():
                tokens_p = clip.tokenize(area_pos_text)
                refine_positive = clip.encode_from_tokens_scheduled(tokens_p)
                if str(area_text_negative).strip():
                    tokens_n = clip.tokenize(str(area_text_negative))
                    refine_negative = clip.encode_from_tokens_scheduled(tokens_n)
                else:
                    refine_negative = negative
            else:
                refine_positive = positive
                refine_negative = negative

            # Sample with the mask. Use the seed widget value as-is —
            # NO click_seq offset. Per-Queue variation (when persistent_mask
            # is on) and per-click variation (when user wants different
            # attempts on the same spot) are now controlled by seed_control:
            #   fixed     → same seed each run, repeatable result
            #   randomize → seed changes after each run (via JS after-gen),
            #               so each Queue / click produces a different result
            #   increment/decrement → +1/-1 each run
            # An older version of this code did `(seed + click_seq) & mask`
            # to fake per-click variation in the absence of after-gen
            # control. That broke "fixed means fixed" — even with the seed
            # widget locked, click_seq's increment still moved the effective
            # sampling seed. Now the user has explicit control.
            this_seed = int(seed)
            callback = latent_preview.prepare_callback(model, steps)
            disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

            # Decide the SOURCE latent for this refine. Default = current
            # cached latent (standard iterative behaviour). Override =
            # persistent_mask snapshot when the user is iterating Queue
            # presses on the held mask. The snapshot pins the source so
            # repeated Queues all start from the same place — seed=fixed
            # → identical results; seed=randomize → real variations of
            # the same base, not drifting iterations.
            if persistent_mask and not is_genuine_new_input:
                # Queue press (or same-spot re-click) under persistent_mask.
                # Take the existing snapshot, or create one from the
                # current cache if this is the first persistent_mask
                # iteration since the toggle was turned on.
                if "persistent_mask_base" not in state:
                    state["persistent_mask_base"] = current.clone()
                refine_source = state["persistent_mask_base"]
            else:
                refine_source = current

            # ===== Inpainting Mode pre-processing =====
            # Refine: no pre-processing — partial denoise from the
            #   existing latent does the work.
            # Smart Inpaint: forces fine_upscaling=True up top, so its
            #   pre-processing (latent zero + reference_latents) lives
            #   inside _refine_with_fine_upscaling.
            # Smart Guided Inpaint: whole-image edit through the non-
            #   fine-upscale path below — inject the scene as
            #   reference_latents so Klein's edit branch keeps the rest
            #   of the image faithful while applying the location-guided
            #   change. POSITIVE ONLY (negative reference would steer
            #   CFG>1 samplers away from the scene).
            if inpainting_mode == "Smart Guided Inpaint":
                reference_latent = refine_source.clone()
                refine_positive = node_helpers.conditioning_set_values(
                    refine_positive, {"reference_latents": [reference_latent]}, append=True,
                )

            if fine_upscaling:
                # Pixel-space crop + upscale + VAE encode + refine + VAE
                # decode + downscale + composite + VAE encode. Avoids
                # the latent-bilinear-smearing failure mode of the
                # earlier latent-space approach. The OFF code path
                # below is untouched.
                refined = _refine_with_fine_upscaling(
                    model=model, vae=vae, current=refine_source, mask=mask,
                    scale_x=scale_x, scale_y=scale_y,
                    target_mp=float(min_megapixels),
                    max_linear=float(max_upscale),
                    resize_method=str(resize_method),
                    context_pad_pixel=int(fine_context_pad),
                    inpainting_mode=str(inpainting_mode),
                    seed=this_seed, steps=steps, cfg=cfg,
                    sampler_name=sampler_name, scheduler=scheduler,
                    positive=refine_positive, negative=refine_negative,
                    denoise=denoise, callback=callback, disable_pbar=disable_pbar,
                )
            else:
                # ===== OFF path — copy-verbatim from 5dc6697; do not edit
                # (only `current` → `refine_source` to support persistent
                #  mask's snapshot-based source pinning) =====
                noise = comfy.sample.prepare_noise(refine_source, this_seed, None)
                refined = comfy.sample.sample(
                    model, noise, steps, cfg, sampler_name, scheduler,
                    refine_positive, refine_negative, refine_source,
                    denoise=denoise,
                    noise_mask=mask,
                    callback=callback,
                    disable_pbar=disable_pbar,
                    seed=this_seed,
                )
                # ===== end OFF path =====

            # Push the new refined latent onto the history stack so undo
            # can pop back to the pre-click state. Cap the stack length.
            state["history"].append(refined)
            if len(state["history"]) > _HISTORY_CAP:
                state["history"] = state["history"][-_HISTORY_CAP:]
            state["click_seq"] = click_seq
            # Track the actual click data that produced this refine so
            # the next run can distinguish "new genuine click" vs
            # "persistent_mask Queue press with identical inputs".
            state["last_click_x"] = click_x
            state["last_click_y"] = click_y
            state["last_stroke_points"] = stroke_points
            # Store the seed Python used. JS uses this for after-gen
            # control + lock-on-fixed semantics.
            state["refine_seed_at_run"] = int(seed)
            # If this was a genuine new click under persistent_mask,
            # snapshot the POST-refine result as the new base for any
            # subsequent persistent_mask Queue presses to iterate from.
            # (Queue presses without a genuine new click leave the
            # existing snapshot alone — they read from it, don't update.)
            if persistent_mask and is_genuine_new_input:
                state["persistent_mask_base"] = refined.clone()
            current = refined

        out_latent = {"samples": current}
        # Build the ui message — always includes the mode + seed_at_run
        # values so JS can apply after-gen control and lock-on-fixed.
        # Multi-valued lists because ComfyUI's ui dict uses list format.
        ui_msg = {
            "Angelo_preview": [],
            "Angelo_mode": ["Edit Mode"],
            "Angelo_refine_seed_at_run": [int(state.get("refine_seed_at_run", seed))],
        }
        # Preview always decodes now (auto_decode deprecated).
        image, image_refs = _decode_to_preview(vae, current)
        ui_msg["Angelo_preview"] = image_refs
        return {"ui": ui_msg, "result": (image, out_latent)}


NODE_CLASS_MAPPINGS = {
    "AngeloRefine": AngeloRefine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AngeloRefine": "Angelo — click to refine",
}
