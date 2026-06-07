# Angelo

**A click-to-refine sampler for ComfyUI.** Generate an image, then click or paint on regions you want improved. Each click refines just that area while the rest stays bit-exact. One node replaces the standard `KSampler` + post-processing chain. Works with **FLUX 2 Klein 9B** and **Qwen-Image-Edit** as first-class edit models — plus any other sampler-compatible model (FLUX 1, SDXL, SD 1.5).

<a href="https://buymeacoffee.com/lorasandlenses"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>

![Angelo in Edit Mode](screenshots/toolbar-edit-mode.png)

## What it does in one screen

```
                                  ┌─────────────────────────────┐
   Model ──────────►              │     Angelo Node             │
                                  │  ┌───────────────────────┐  │
   Empty Latent ─►                │  │ Mode Steps CFG Sampler│  │  ← gen config row
                   AngeloRefine   │  │ Smpl Seed / Ctrl ...  │  │  ← sampler-seed row
   positive ────►                 │  │ [Reset][Undo] Inpaint▾│  │  ← refine actions
                                  │  │ [Click R][Feather]... │  │  ← refine values
   negative ────►                 │  ├───────────────────────┤  │
                                  │  │ Area Prompt: [______] │  │  ← in-node text box
   vae ─────────►                 │  ├───────────────────────┤  │
                                  │  │                       │  │
   clip ────────►                 │  │   Preview canvas      │  │  ← click / paint / drag
                                  │  │   (fits the node)     │  │
                                  │  └───────────────────────┘  │
                                  └────────────┬────────────────┘
                                               │
                                 image · latent · source_image outputs
```

That's the entire workflow. No KSampler upstream, no ADetailer downstream, no Image-to-Mask plumbing in between. Generate, click, done. The image always scales to fit the node — resize the node and the preview tracks it.

![Angelo wired into a graph](screenshots/workflow-overview.png)

## Why you'd want it

ComfyUI's standard "fix the bad hand" workflow is: generate, save the image, open MaskEditor, paint a mask, route the mask + image + a new sampler config back into the graph, re-queue. It works but it's friction-heavy.

Angelo collapses that into:

- **Click** a region. It refines with your main prompt, in place, immediately.
- **Load Image** to edit an existing photo directly in the node — no Empty Latent + `VAEEncode` chain to wire (you still connect the `vae` input as normal; Angelo does the encode itself). Or just **drag-drop an image file** onto the node; **right-click** the preview to copy it or open it in a new tab.
- **Paint** a freeform stroke with mouse-down + drag. Same thing but custom shape.
- **Type an Area Prompt** right in the node to refine a region with a different prompt (e.g. main prompt = "person in forest", area prompt = "detailed photorealistic face") — no second CLIP Text Encode node needed.
- **Toggle Xtra-Fine** to refine small regions at much higher effective resolution (the ADetailer move, but with full prompt control).
- **Smart Inpaint** — drag a rectangle and add brand-new content with an edit model (FLUX 2 Klein 9B or Qwen-Image-Edit).
- **Smart Guided Inpaint** — no drawing at all: pick a location from a dropdown ("top left", "center", …) + describe what to add, and the edit model places it.
- **Detect** a region by *describing* it (optional SAM 3) — type "the face", click the highlight, and it masks the silhouette for you. No painting. Nudge the mask in/out, or Shift/Alt-drag to touch it up by hand.
- **Re-roll** the last edit with a fresh seed on the same mask + original image, or **toggle Persistent Mask** to keep evolving a region over repeated Queues.
- **Undo / Redo** to step back and forward through your refines.
- **`source_image` output** emits the original pre-edit base, ready to wire straight into a compare node.

All in one node. All without re-queueing the whole workflow manually for each fix.

## Model compatibility

Angelo treats **FLUX 2 Klein 9B** and **Qwen-Image-Edit** as its two first-class edit models — both get the full feature set, including the Smart inpaint modes. It also works with any other sampler-compatible model: FLUX 1, SDXL, SD 1.5, and standard checkpoints (for **Refine**, Xtra-Fine, and Area Prompt — the Smart modes need an edit-trained model).

Two latent layouts are handled transparently. **Standard 4D models** (FLUX, SDXL, SD) use `[B, C, H, W]` latents. **Temporal / video-derived models** (Qwen Image Edit, Wan) use 5D `[B, C, T, H, W]` latents — their VAEs carry an extra frame axis. Angelo normalises latent shape at a single VAE boundary and feeds each model the dimensionality it expects before sampling (the same step ComfyUI's stock KSampler does), so you don't need a model-specific latent node — wire `model`, `vae`, and `clip` as usual.

For the **Smart** inpaint modes, use an **edit-trained** checkpoint — **FLUX 2 Klein 9B** or **Qwen-Image-Edit** (not plain Qwen-Image, which has the reference code path but isn't trained for it; see [Inpainting Mode](#inpainting-mode-refine--smart-inpaint--smart-guided-inpaint)). **Refine** (incl. Xtra-Fine and Area Prompt) works on any model.

## Install

Clone into your `ComfyUI/custom_nodes/`:

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/shootthesound/ComfyUI-Angelo.git
```

Restart ComfyUI. No additional Python dependencies for the core node. (The optional **Detect** feature adds SAM 3 — see [Detect](#detect--auto-segment-with-sam-3-optional) for its one-time opt-in installer.)

## Quick start

### FLUX 2 Klein 9B distilled

**Just want it running?** ComfyUI auto-lists this under **Workflow → Browse Templates → ComfyUI-Angelo** (the `example_workflows/` folder), or drag [`example_workflows/Klein9b-example.json`](example_workflows/Klein9b-example.json) onto the canvas — it's a complete FLUX 2 Klein 9B graph (UNet / CLIP / VAE loaders → Angelo → Save Image) wired and ready. Point the loaders at your model files and queue.

To wire it from scratch instead:

1. Add the **Angelo — click to refine** node from the `sampling/Angelo` category.
2. Wire it up:
   - `model` ← Load Checkpoint / FLUX model loader
   - `latent` ← Empty Latent Image
   - `positive` / `negative` ← CLIP Text Encode nodes
   - `vae` ← Load VAE / your VAE source
   - `clip` ← your CLIP / text encoder (optional, but required for the in-node **Area Prompt** and the Smart modes). Wire the same CLIP that feeds your CLIP Text Encode nodes.
3. Defaults are tuned for Klein 9B distilled: `steps=4`, `cfg=1.0`, `sampler=euler`, `scheduler=simple`. All sampler/generation settings live in the node's toolbar (no native widget rows). Adjust for other models.
4. Mode defaults to **Sampler Mode**. Queue the workflow — Angelo generates the base image.
5. Flip **Mode** to **Edit Mode** (top-left of the toolbar). The refine controls un-grey; cursor becomes a crosshair.
6. Click a region on the preview. Angelo refines that spot.

That's the loop. Click → refine → click → refine. Undo if needed. Reset to start over from the cached base.

### Qwen-Image-Edit

**Just want it running?** ComfyUI auto-lists this under **Workflow → Browse Templates → ComfyUI-Angelo**, or drag [`example_workflows/Qwen Edit 2511 example.json`](example_workflows/Qwen%20Edit%202511%20example.json) onto the canvas — a complete Qwen-Image-Edit 2511 graph wired to Angelo. Point the loaders at your model files and queue.

To wire it from scratch, do it exactly the same way as Klein — `model` / `vae` / `clip` / `positive` / `negative` — but point the loaders at a **Qwen-Image-Edit** checkpoint, its VAE, and its text encoder. There's no Qwen-specific latent node to add; Angelo normalises the latent shape internally.

Qwen-Image-Edit isn't distilled like Klein, so adjust the toolbar generation settings to suit it — typically more steps and CFG > 1 (or a low-step Lightning / Lightx2v LoRA if you run one, which lets you drop back toward 4–8 steps at CFG ≈ 1). Everything else is identical: Sampler Mode to generate, then Edit Mode for Refine / Xtra-Fine / Area Prompt / Smart Inpaint / Smart Guided Inpaint.

## The two modes

### Sampler Mode

Angelo acts as a normal sampler — generates the base image from the incoming latent. The refine control rows are greyed; canvas clicks do nothing. The generation config row (Mode / Steps / CFG / Sampler / Sched) and the Sampler-seed row stay active here:

- **Mode** — flip between Sampler / Edit.
- **Smpl Denoise** — denoise level for the base gen (1.0 = full regenerate from noise, like a normal KSampler).
- **Smpl Seed** + **Smpl Ctrl** — seed value + after-generate control (`fixed` / `randomize` / `increment` / `decrement`).

When you flip Mode to Edit Mode, `Smpl Ctrl` auto-locks to `fixed` and `Smpl Seed` snaps to the seed that actually produced the cached image (preserves it across the mode switch). The Sampler-seed row greys out in Edit Mode.

![Mode dropdown](screenshots/mode-dropdown.png)

### Edit Mode

The refine control rows come alive. Click, paint, or drag on the preview to refine, depending on the Inpaint mode.

Cursor changes by mode:
- **Crosshair** = single-click refine (Refine) or rectangle drag (Smart Inpaint)
- **Cell** = paint mode active (drag to draw a freeform stroke, Refine only)
- **Default arrow** = Smart Guided Inpaint (no canvas interaction — driven by the location dropdown + Generate button)

Paint Mode lets you brush a freeform region to refine instead of single-circle clicks:

![Paint Mode — freeform brushed region](screenshots/paint-mode.png)

## Load Image (edit an existing photo)

Want to edit a photo rather than something you generated? Hit **🖼 Load Image** in the toolbar, pick a file, and it becomes the base — no Empty Latent or separate `VAEEncode` node to wire. The `latent` input is **optional**; Load Image is all you need.

> **Still wire the `vae` input as normal.** Angelo encodes the loaded photo (and decodes previews) with it — it just does the encode internally, so you don't need a standalone `VAEEncode` node feeding `latent`.

On load you're asked how to size it:

- **Keep current resolution** — encode the photo as-is.
- **Resize to _X_ MP** — scale to a target megapixel (good for taming huge phone photos / saving VRAM).

Either way the dimensions are rounded to a multiple of 16 so any supported VAE is happy. The node then VAE-encodes the photo with the wired `vae`, installs it as the **base**, and switches to **Edit Mode** so you can click / paint / inpaint straight away.

Notes:
- **Reset and Undo return to the loaded photo** (it's the base).
- **While an image is loaded, the `latent` input is ignored.** Hit **✕ Unload** (appears next to Load Image while one is loaded) to clear it and hand the base back to the wired latent.
- The base is in-process state, so a ComfyUI restart clears it — but Load Image re-encodes from the uploaded file, so re-loading is one click.

### Using Angelo as a standalone image editor

Heads-up on how ComfyUI runs things: *any* Angelo action — Load Image, a refine click, a paint stroke — triggers ComfyUI's normal **queue**, which re-executes every output node on the canvas plus anything with a randomised seed. That's a ComfyUI behaviour, not something a custom node can opt out of (there's no "run just this node" API). So if you've got a sampler set to `randomize` or other Save Image chains hanging around, they fire on every edit too — which feels slow.

If you're using Angelo to **edit existing images**, keep it snappy by running it on a **minimal graph** — `Load Checkpoint / loaders → Angelo → Save Image` — or **mute / bypass (Ctrl+M)** the other generation chains while you edit. Then a load or click only runs Angelo and its loaders (which are cached), and nothing else re-fires.

## Toolbar

The toolbar holds everything — there are no native widget rows. Top to bottom, grouped into a centred Mode switch, a generation block, and an edit block:

```
                 ┌─────────────────┐
                 │  Mode: [Edit ▾] │            ← centred at the top
                 └─────────────────┘
  [Steps] [CFG] [Sampler ▾] [Sched ▾]            ← shared generation config (always active)
  [Smpl Seed] [Smpl Ctrl ▾] [Smpl Denoise]       ← base-gen seed (greys in Edit Mode)
 ─────────────────────────────────────────
  [Reset] [Undo] [Redo] [Re-roll] | [Persistent Mask] [Area Prompt] [Paint Mode] [Xtra-Fine] | [Inpaint ▾]
  [Click R] [Feather] [Denoise] [Seed] [Ctrl ▾] | [MP] [Max] [Method ▾]    ← edit block (greys in Sampler Mode)
```

The **Mode** switch sits centred up top. Below it, the generation block (always active, base-gen seed greys in Edit Mode); below the divider, the edit block (greys entirely in Sampler Mode). Every control has a hover tooltip. Quick reference:

### Mode + generation block

| Control | What it does |
|---|---|
| **Mode ▾** | Sampler Mode (generate the base) vs Edit Mode (click/paint/drag to refine). Centred at the top of the node |
| **Steps / CFG / Sampler ▾ / Sched ▾** | Sampler config, shared by base gen and refines. Klein 9B distilled: 4 / 1.0 / euler / simple. Qwen-Image-Edit: more steps + CFG > 1 (or a low-step Lightning LoRA) |
| **Smpl Seed / Smpl Ctrl ▾ / Smpl Denoise** | Seed, after-generate control, and denoise for the base generation (Sampler Mode) |

**Driving Steps / CFG / Sampler / Scheduler from elsewhere in the workflow.** If you'd rather have a single source of truth for those four values across your workflow than set them again on Angelo's toolbar, drop an **Angelo — Overrides** node (same `sampling/Angelo` category), set the fields you want to drive (leave others at `-1` / `(toolbar)` to fall through), and wire its `overrides` output into Angelo's `overrides` input slot. Per-field opt-in: override only `steps`, only `cfg`, any combination. Anything left at its sentinel uses the toolbar value as normal.

The Overrides node also carries **`disable_live_preview`** — flip this ON if ComfyUI's global latent preview (Settings → Preview method = Latent2RGB / TAESD) is rendering into the Angelo node mid-sample and squashing the editor area. It suppresses the preview callback for this Angelo only, so KSampler etc. elsewhere in your workflow keep their previews.

**Full custom sampler control (power-sigma, Flux 2 scheduler, NAG-Extended, custom guiders).** The Overrides node exposes three more optional slots — **`guider`** / **`sampler`** / **`sigmas`** — for replacing the whole sampler stack rather than just renaming pieces of it. Wire any `GUIDER` node (`CFGGuider`, `BasicGuider`, NAG variants, etc.), any `SAMPLER` (`KSamplerSelect` and friends), and any `SIGMAS` source (`BasicScheduler`, `KarrasScheduler`, `PolyexponentialScheduler`, power-sigma nodes, the Flux 2 scheduler) into those three slots. When all three are wired Angelo runs through `guider.sample(...)` instead of `comfy.sample.sample(...)` — the toolbar's `steps`/`cfg`/`sampler_name`/`scheduler` become moot, but the **Denoise** slider still applies (sigmas are tail-sliced per call, same as ComfyUI's `SplitSigmasDenoise`). Partial wiring (e.g. only `sampler`) silently falls back to the default. The implementation borrows three helpers from [@KursatAs](https://github.com/KursatAs)'s `customSampler` branch — full credit there, including the device-safe wrapper that fixes a CPU/GPU collision in ComfyUI-NAG-Extended's inpaint path.

### Edit block — actions + toggles

| Control | What it does |
|---|---|
| **Reset** | Discard cached refinements + history, start fresh from the Sampler-Mode base |
| **Undo** | Pop the most recent refine off the history stack (up to 10 deep) |
| **Redo** | Re-apply the most recent refine that Undo removed. A new edit clears the redo history. Button-only (no Ctrl-Z/Y — those clash with ComfyUI's graph undo) |
| **Re-roll** | Redo the most recent edit with a fresh seed on the **same mask + same starting image**, replacing the last attempt — cycle seeds on one edit without reset → re-mask → rerun. Works for click / paint / rectangle / detected masks |
| **Persistent Mask** | Hold the last mask, then hit Queue repeatedly to keep refining that region on the **latest** result — each press builds further, so you can gradually morph it (pair with `Ctrl=randomize`). For variations on the *original* image instead, use **Re-roll**. Locked OFF in Smart Guided Inpaint (no mask) |
| **Area Prompt** | Refine with the Area Prompt text typed in the box above the canvas (encoded with the connected `CLIP`) instead of the main prompt. Requires a `CLIP` input + non-empty text. The box only appears when this is ON. Forced ON in both Smart modes |
| **Paint Mode** | Hold + drag to paint a freeform stroke as the mask, instead of single-circle clicks (Refine only) |
| **Xtra-Fine** | Crop the painted region, upscale via VAE + image upscale, refine at high effective resolution, composite back. ADetailer-style. Forced ON in Smart Inpaint, OFF in Smart Guided Inpaint |
| **Inpaint ▾** | `Refine` / `Smart Inpaint` / `Smart Guided Inpaint`. See "Inpainting Mode" below |

### Edit block — refine values

| Control | What it does |
|---|---|
| **Click R** | Pixel radius for single-click refines + brush size in Paint Mode |
| **Feather** | Pixel-space gaussian feathering on the mask edge for smooth transitions. Defaults to 15 (and is adjustable) in Smart Inpaint for a soft blend; disabled in Smart Guided Inpaint |
| **Denoise** | How much trajectory to run on the refine (0.3 = subtle, 0.6 = real redo, 0.9+ = regenerate). Locked to 1.0 in both Smart modes |
| **Seed** + **Ctrl ▾** | Seed for the refine pass + after-generate control. Defaults to `randomize` so each refine is a fresh variation |
| **MP** | (Xtra-Fine only) Target megapixels for the refine pass |
| **Max** | (Xtra-Fine only) Hard cap on linear upscale factor (8× linear = 64× area) |
| **Method ▾** | (Xtra-Fine only) Pixel-space upscale method. Default lanczos. |

## Xtra-Fine (the killer feature)

Standard refine runs the model on the full latent. The mask only decides where output is written; the model sees the whole image as context. That's great for general refinement but it means a small region (a face, a hand) is only ~64 latent units wide — well below where FLUX renders detail well.

Xtra-Fine does what ADetailer does, but inside the same Angelo loop:

1. Compute the painted-mask bbox + a context-padding band of surrounding pixels for context.
2. VAE-decode the cached latent to pixels.
3. Crop the pixel image to that padded bbox.
4. Upscale the crop in pixel space to hit `MP` megapixels (capped at `Max` linear scale).
5. VAE-encode the upscaled crop → high-resolution latent.
6. Refine just the painted shape inside it via the standard noise-injection inpaint path.
7. VAE-decode, downscale, composite back into the cached pixel image.
8. VAE-encode the composited image AND blend with the cached latent using the mask as alpha — so the unaltered regions stay bit-exact (no VAE round-trip drift).

The result: a face that was 64 latent units gets refined at ~1000 latent units (depends on `MP` + `Max`). The model finally has room to render fingers, eyes, teeth correctly.

**Pair with Area Prompt** for a workflow Lightroom users will recognise: paint a region, type "detailed photorealistic face" in the Area Prompt box, click. Same image, that region transformed at full quality with the override prompt.

### When to use Xtra-Fine — and the size floor

**Rule of thumb: if the thing you're improving is small, turn Xtra-Fine ON.** A distant face, an eye, a hand, jewellery, text on a sign — anything that occupies only a small slice of the frame. In plain Refine those pixels map to just a handful of latent cells and the model has no room to render detail; Xtra-Fine crops them out and enlarges them to a full working canvas (the `MP` target, default ~1 MP ≈ 1024²) before refining, then composites back. For large regions plain Refine is already fine and faster.

**Mind the VAE size floor.** The VAE downsamples by **16× on FLUX 2** (8× on FLUX 1 / SDXL / SD 1.5), so the region the model actually works on needs enough latent cells to encode meaningful detail. Practical guidance:

- Aim for the refined region to land at **roughly 512–1024 px on its short edge** after the Xtra-Fine enlarge. On FLUX 2 that's ~32–64 latent cells — enough for coherent detail. The default `MP` ≈ 1024² gets you there for most paints.
- The enlarge is **capped at `Max` linear scale (default 8× = 64× area)**. So an extremely tiny paint can't be blown up without limit: a ~40 px region maxes out around ~320 px even at 8×, which is near the floor and will look soft. **Paint a little wider** (or raise `Max`) so the crop — and the VAE — have room to work.
- Below ~256 px effective working size, expect mush: there simply aren't enough latent cells for the model to put detail into, no matter the prompt.

In short: Xtra-Fine is what makes *small* fixes possible at all, but it can't conjure resolution from nothing — give it a crop that enlarges to a few hundred pixels minimum.

## Re-roll vs Persistent Mask (iterating on a region)

Two complementary ways to keep working a region without re-masking:

**Re-roll** (button, next to Undo) redoes your most recent edit with a fresh seed on the **same mask and the same starting image**, swapping the result in place of the last attempt. Mash it to cycle seeds on one edit until you like a result — it doesn't stack on top of itself. Works for click, paint, rectangle and detected masks. (It does this by popping the last attempt, so `Undo` afterwards still steps back through your history as expected.)

**Persistent Mask** (toggle) holds the last mask; each press of the standard ComfyUI Queue button re-runs it on the **latest** result, so the region builds *further* every time — use it to gradually morph something into something else over several presses:

- `Ctrl=randomize` + Queue, Queue, Queue → a varied walk, each step building on the last
- `Ctrl=fixed` + Queue, Queue, Queue → push the same direction deterministically

A new click while Persistent Mask is on commits a new region to keep building from.

In short: **Re-roll** = "try this edit again on the original"; **Persistent Mask** = "keep evolving from where I am now."

## Inpainting Mode (Refine / Smart Inpaint / Smart Guided Inpaint)

Three options for how a region is treated. The two Smart modes need an **edit-trained model** (FLUX 2 Klein 9B, **Qwen-Image-Edit**, etc.) and a wired `CLIP`. They work by injecting `reference_latents`, so a **base** text-to-image checkpoint (e.g. plain Qwen-Image, not the *Edit* variant) will produce colour-distorted output — it has the reference code path but its weights were never trained for it. Use the Edit variant for Smart Inpaint / Smart Guided Inpaint; **Refine** works on any model.

![Inpaint mode dropdown](screenshots/inpaint-modes.png)

| Mode | What it does | Use for |
|---|---|---|
| **Refine** (default) | Painted/clicked region is the starting state — the model partially denoises the existing pixels per the denoise level. Mask is a click circle or a paint stroke. | Face/hand fixes, polish, style adjustments, **editing what's already there** |
| **Smart Inpaint** | Drag a rectangle (click + hold one corner, release at the opposite). Locks `denoise=1.0`, `Xtra-Fine=ON`, `Area Prompt=ON`. Injects `reference_latents` so an edit model's edit branch activates, then zeros the masked latent so the region regenerates from full noise. | **Adding new content** in a specific drawn region |
| **Smart Guided Inpaint** | No painting or boxes. Pick a **location** from a dropdown ("Top left", "Center", "Bottom half", …); it's prepended to your Area Prompt at run time (e.g. *"In the top left of the image, a red car"*) and the edit model places it across the whole image. Locks `denoise=1.0`, `Xtra-Fine=OFF`, `Area Prompt=ON`; press **Generate Guided Edit** to run. | **Adding new content** when you don't want to draw — quick, coarse placement |

### Why Smart Inpaint exists

An edit model like FLUX 2 Klein or Qwen-Image-Edit has no concept of a mask — it takes a reference image + a prompt and produces an edited image. The painted shape only constrains *where the result is composited*, not what the model generates. Smart Inpaint addresses this by (a) cropping to the dragged rectangle so the model's working region is the area you care about, (b) injecting **that cropped region** as `reference_latents` so the edit branch sees the local context (the reference is the crop only — never the whole image), and (c) zeroing the masked latent so the model fills it as new content rather than refining what was there.

Typical "add a person on the road" workflow:

1. **Inpaint Mode: Smart Inpaint** (auto-locks denoise=1.0 / Xtra-Fine=ON / Area Prompt=ON)
2. **Drag a rectangle** roughly where the person should go — make it generously larger than the subject so the body isn't clipped at the rectangle edge
3. Type the **Area Prompt** (the box appears above the canvas): `"a person walking, full body, realistic, matching the scene's lighting"`
4. **Queue**

Rectangles beat tight silhouettes here: the composite keeps only what lands inside your shape, so a person-shaped mask clips any body part the model drew outside it. A generous rectangle gives the model room to compose a complete subject.

Example — drag a rectangle over the wheel, prompt `"wheel engulfed in flames"`, run:

<table>
<tr><td align="center"><b>Before</b> (rectangle + prompt)</td><td align="center"><b>After</b></td></tr>
<tr><td><img src="screenshots/smart-inpaint-before.png" width="400" alt="Smart Inpaint before"></td><td><img src="screenshots/smart-inpaint-after.png" width="400" alt="Smart Inpaint after"></td></tr>
</table>

### Smart Guided Inpaint — placement by words, not boxes

The same edit-model plumbing as Smart Inpaint, but the spatial "where" comes from a dropdown + prompt phrasing instead of a drawn region. There's no mask at all — the whole image is edited, with `reference_latents` keeping the rest faithful and the location prefix telling the model where to put the new content.

1. **Inpaint Mode: Smart Guided Inpaint**
2. Pick a **Location** from the dropdown above the Area Prompt box (corners, middles, center, edges, halves, top/bottom)
3. Type what to add in the **Area Prompt** box
4. Press **Generate Guided Edit**

Example — Location `Right edge`, prompt `"A sheep jumping up and down"`, hit Generate Guided Edit:

<table>
<tr><td align="center"><b>Before</b> (location + prompt)</td><td align="center"><b>After</b></td></tr>
<tr><td><img src="screenshots/smart-guided-before.png" width="400" alt="Smart Guided before"></td><td><img src="screenshots/smart-guided-after.png" width="400" alt="Smart Guided after"></td></tr>
</table>

Honest expectations: text-based placement is fuzzy by nature. Coarse regions ("top half", "bottom of the image", "center") land most reliably; fine ones are looser. FLUX 2 Klein and Qwen-Image-Edit honor these phrases well in practice. Use Smart Inpaint when you need *precise* placement, Smart Guided when you want a *quick, no-draw* edit.

**Insert Smart Phrasing** (a button under the Area Prompt box, shown in both Smart modes) opens a popup of edit-preservation constraints — *keep the lighting / pose / clothes / faces the same* — and appends the ticked ones to your Area Prompt. Handy for keeping the rest of the subject stable while changing one thing.

<table>
<tr><td align="center"><b>Tick the constraints</b></td><td align="center"><b>Appended to the Area Prompt</b></td></tr>
<tr><td><img src="screenshots/smart-phrasing-popup.png" width="400" alt="Insert Smart Phrasing popup"></td><td><img src="screenshots/smart-phrasing-applied.png" width="400" alt="Smart Phrasing appended to prompt"></td></tr>
</table>

…and the run (Location `Left edge`, *"a magical glowing whole in the ground, Keep the lighting the same"*) puts the glow on the left while leaving the rest of the scene intact:

![Smart Guided Inpaint — glow placed on the left edge](screenshots/smart-guided-left-edge.png)

## Detect — auto-segment with SAM 3 (optional)

Instead of painting or dragging a region, let **SAM 3** find it for you by *describing* it. In **Refine** or **Smart Inpaint**, a **🔍 Detect** row appears in the toolbar:

- **Type a concept** — "the face", "the red car", "her left hand" — and hit **Detect**; or
- Use the **Quick Detect…** dropdown of common subjects, grouped into People / Body / Clothing / Animals / Scene / Objects (face, hands, hair, clothing, sky, car, …). Picking one runs immediately and doesn't touch the text box.

Angelo highlights every match on the preview and you enter **detect mode** — nothing changes until you click. **Click a highlight** to edit that object; the others stay up so you can **work through each one in turn** without re-detecting. Edited candidates turn **green** (so you can track progress), the hovered one is **yellow**.

Per mode, the confirmed detection becomes:
- **Refine** → the exact **silhouette** mask (a latent-space inpaint — see below).
- **Smart Inpaint** → the detection's **bounding box** as the rectangle.
- **Smart Guided Inpaint** → Detect is hidden (no mask there).

Your **Area Prompt** applies to whatever candidate you click (toggle it on in Refine; it's forced on in Smart Inpaint) — so you can detect "person", set a prompt, and apply it to each one in turn.

**Detect-mode controls** — a floating panel pins to the top-right (beside the Mode switch) while candidates are up:
- **✕ Cancel Detect**, **Esc**, or **Space** leaves detect mode. Empty-space clicks do *nothing*, so you can't accidentally drop out mid-batch.
- A **highlight-opacity slider** — drag it down to fade the overlays and inspect the edges of what you just generated; candidates stay clickable, and it resets to full when you exit.
- **Conf** (in the Detect row) tunes the match threshold (≈0.2–0.3 finds more / fainter matches).

**Tidying up a detection.** SAM is usually close but not perfect — two tools fix it without re-detecting:
- **Mask `[−] / [+]`** (after the Quick Detect dropdown) grows or shrinks **every** detected mask together, 2px at a time — handy when a silhouette is a touch tight or loose all over. The number shows the current offset; it resets on each new detect.
- **Touch-up brush (Refine only).** Hold **Shift** and drag on the preview to **add** to the mask you start over (e.g. pull in a missed chunk of hair); hold **Alt** and drag to **subtract** — including punching a hole right in the middle. The brush size is your **Click R**, with a live green (add) / red (subtract) preview, and it works whether or not Paint Mode is on. Then click the candidate to apply the edited shape. (Brushing freezes that candidate's shape, so do any +/− grow first.)

**While it works** a *"Loading SAM 3…"* overlay covers the preview — the **first** Detect of a session builds and caches the model (several seconds), so this is just busy feedback rather than a frozen-looking canvas. It clears itself the moment results come back; if a request ever hangs, a **✕** on the overlay closes it manually. Anything you need to read or act on — *no matches*, a bad query, or the *SAM 3 not installed* prompt — shows as a persistent in-app message bar you dismiss yourself, never a toast that flashes past.

**It runs in latent space.** In standard **Refine** (Xtra-Fine off), the edit is a pure latent-space noise-mask inpaint — everything outside the silhouette stays bit-exact, with no VAE round-trip. SAM 3 runs on the decoded preview only to *produce* the shape, which is rasterised down into a latent mask. (Xtra-Fine and Smart Inpaint deliberately use the pixel-space VAE round-trip, as elsewhere.)

### Enabling it (one-time, optional)

Detect needs Meta's **SAM 3**, which isn't on PyPI — so it's **opt-in** and not installed with the node (Angelo's core stays dependency-free). To enable it:

1. **Close ComfyUI.**
2. Run the installer in the `ComfyUI-Angelo` folder:
   - **Windows:** `install_sam3_support.bat`
   - **macOS / Linux:** `install_sam3_support.sh`  (`bash install_sam3_support.sh`)
3. **Start ComfyUI again.**

The script installs SAM 3 + its dependencies into the *same* Python ComfyUI uses (it reads the interpreter path Angelo records on startup, so it works for portable, venv, or conda installs). The **SAM 3 weights (`sam3.pt`, ~GB) download automatically on first Detect** from a public mirror — no Hugging Face token needed. If `sam3` isn't installed, the Detect button just tells you to run the script; everything else in Angelo keeps working.

## Area Prompt (refine with a different prompt)

Connect a `CLIP` (the same one feeding your main positive/negative). Toggle **Area Prompt** on — a text box appears between the toolbar and the canvas. Type a prompt; refines encode it with the CLIP and use it instead of the main prompt. Toggle off → the box hides and refines revert to the main prompt. Hiding the box never loses what you typed (it lives in the node and reloads), and the cached image persists across the toggle.

**While Area Prompt is on, the refine uses the Area text _exclusively_ and never falls back to the main prompt — even when the Area text is left empty (empty = an empty positive prompt).** This matters for the Smart edit modes: the main positive can carry a whole-image `reference_latents` (e.g. a Klein edit workflow's ReferenceLatent), and letting it leak in made an empty-Area-Prompt Smart Inpaint reproduce the entire scene into the region instead of editing just it.

The box has a **Pos/Neg** toggle that switches which prompt you're editing. Negative is optional and falls back to the main negative when empty (matters only for CFG > 1; ignored at CFG=1 / distilled models like Klein — which is why it's tucked behind a toggle rather than a second always-visible box).

Both Smart modes force Area Prompt ON (it's the whole point there), and add an **Insert Smart Phrasing** button for the *keep X the same* constraints. Smart Guided Inpaint also adds the **Location** dropdown directly above the box.

Recommended: use `denoise=0.7-0.9` for area-prompt refines in **Refine** mode. Lower values won't give the new prompt room to take effect against an image generated with a different prompt. (Both Smart modes lock denoise=1.0 since they're regenerating from scratch.)

## Navigating the preview (zoom & pan)

The preview fits the node by default, but you can zoom in to work on fine detail:

| Action | Does |
|---|---|
| **Mouse wheel** | Zoom in / out, centered on the cursor (0.25×–8×) |
| **Middle-mouse hold + drag** | Pan around |
| **Double middle-click**, or **F** (cursor over node) | Reset back to fit |

When you zoom in (>1×), a small **minimap** appears in the bottom-right corner showing the whole image with a marker for your current viewport. Click-to-refine, paint, and rectangle-drag all keep working while zoomed — clicks land on the correct image pixel at any zoom — so you can zoom into a face, click to refine, and stay zoomed for the next click.

While you're zoomed or panned, the **auto-fit is suspended** so resizing the node won't snap your view back. A genuinely new image (or double-click reset) returns to fit; refining the *same* image keeps your zoom.

## Keyboard shortcuts

When the cursor is hovering the preview canvas AND you're in Edit Mode, these keys adjust the matching toolbar values directly:

| Keys | Adjusts | Step | Convention |
|---|---|---|---|
| `[` / `]` | Click R | 4 px | Universal brush-size (Photoshop, Krita, Procreate) |
| `{` / `}` (shift+brackets) | Feather | 4 px | Photoshop brush hardness/softness |
| `,` / `.` | Denoise | 0.05 | `<` / `>` ordering on the same keys |

The hover ring on the canvas updates live as you press `[` / `]`, so you can size the brush against the actual image content. Shortcuts only fire while the cursor is on the canvas; move to the toolbar and they revert to ComfyUI's normal keybindings.

## Tips

- **Default denoise (0.5) is for in-place touch-ups.** Bump to 0.85+ when you want a clear redo of the region (mandatory for Area Prompt; helpful for Xtra-Fine). Both Smart modes lock it to 1.0.
- **Click R + Feather scaling.** Feather ≈ `Click R / 4` works well as a starting point.
- **The preview always fits the node** (until you zoom). Resize the node and the image scales to fit (letterboxed), so a portrait image no longer forces a giant tall node. Wheel-zoom + middle-drag to inspect detail — see "Navigating the preview".
- **Lanczos is the default for Method.** For smooth content (faces, skin), try bilinear too — sometimes preferable on very soft subjects.
- **The refine controls grey out in Sampler Mode** (and the base-gen seed row greys in Edit Mode) so you can see at a glance which mode you're in.
- **Lock-on-fixed seed semantics.** Switching to `fixed` always also restores the seed widget to the value Python actually used at the last run — so "fixed" always means "the seed that produced the current canvas".
- **`Reset` discards undo history too.** Hit Undo first if you just want to roll back one refine.

## Honest limits

- **In-process state.** Refinements live in the running ComfyUI process. Restart = cache cleared. Workflow JSON saves widget values but not the cached refined latent.
- **VAE round-trip cost in Xtra-Fine.** ~1.5-2 seconds per click on a 5090 for FLUX 2 Klein. Trade-off for the resolution boost; OFF mode stays fast.
- **Crop+upscale is bounded by the model's training distribution.** Very small painted regions even at 8× upscale won't suddenly look like trained-resolution content. Paint wider so the crop carries more surrounding context.
- **One Angelo node per ComfyUI instance is sensible.** Multiple parallel Angelo nodes would share the global queue hook and may interact in surprising ways under Persistent Mask.
- **No multi-user safety.** Don't use this on a shared ComfyUI server expecting per-user state isolation.

## Compatibility

- **ComfyUI:** any reasonably modern version (the JS uses standard ComfyUI extension APIs).
- **Models:** any sampler-compatible model. Defaults are tuned for FLUX 2 Klein 9B distilled, but works with FLUX 1, FLUX 2 Dev, SDXL, SD 1.5, etc. — change `steps` / `cfg` / `sampler_name` / `scheduler` to match your model.
- **VAE:** FLUX 2 (16× downscale), FLUX 1 / SDXL / SD 1.5 (8× downscale) handled automatically. Exotic VAEs may need a small code change.
- **GPU:** any CUDA GPU that runs your base model. Angelo adds minimal overhead.

## Credits + contact

Built by Peter Neill ([shootthesound](https://github.com/shootthesound)).

Bug reports, feature requests, and "this changed how I work" stories all welcome via GitHub issues.

If Angelo saves you time, you can support development here:

<a href="https://buymeacoffee.com/lorasandlenses"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>

## License

MIT.
