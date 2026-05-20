// ComfyUI-Angelo — click-to-refine UI extension.
//
// Strategy: each AngeloRefine node gets its own canvas DOM widget
// attached at the bottom of the node. We draw the refined preview into
// that canvas ourselves (instead of using ComfyUI's auto-preview), and
// the canvas has a real DOM click listener. This sidesteps the issue
// where DOM image elements swallow clicks before LiteGraph sees them.

import { app } from "../../scripts/app.js";

const NODE_NAME = "AngeloRefine";

// Flip to true if something stops working and you want click → pixel-coord
// → widget-update → queue traced in the browser console.
const Angelo_DEBUG = false;
function dbg(...args) {
    if (Angelo_DEBUG) console.log("[Angelo]", ...args);
}


// --- Module-level hover tracking for the keyboard shortcuts. Set by
//     the canvas mouseenter / mouseleave handlers in attachPreviewCanvas.
let _AngeloHoveredNode = null;

// --- Global queuePrompt hook: bumps click_seq on every AngeloRefine
//     node where persistent_mask is on, so the standard ComfyUI Queue
//     button re-runs the refine on the held mask with a fresh seed.
//     Installed once per extension load; no-op for graphs without
//     AngeloRefine.
function installQueueHook() {
    if (app._AngeloQueueHookInstalled) return;
    if (typeof app.queuePrompt !== "function") return;
    const orig = app.queuePrompt.bind(app);
    app.queuePrompt = function (...args) {
        try {
            const nodes = (app.graph && app.graph._nodes) || [];
            for (const n of nodes) {
                if (n?.type !== NODE_NAME) continue;
                const persistW = findWidget(n, "persistent_mask");
                if (!persistW || !persistW.value) continue;
                const seqW = findWidget(n, "click_seq");
                if (!seqW) continue;
                setWidget(seqW, ((seqW.value || 0) + 1) & 0x7FFFFFFF);
                // Also clear `reset` so a stale tick doesn't blow away
                // the cached latent we want to refine on top of.
                const resetW = findWidget(n, "reset");
                if (resetW) setWidget(resetW, false);
                dbg("queueHook: bumped click_seq on persistent-mask node", n.id, "→", seqW.value);
            }
        } catch (e) {
            dbg("queueHook error (passing through)", e);
        }
        return orig(...args);
    };
    app._AngeloQueueHookInstalled = true;
    dbg("installed app.queuePrompt hook for persistent_mask");
}

// --- Global keyboard shortcuts. Active only when the cursor is hovering
//     a Angelo canvas AND that node is in Edit Mode. Mirrors
//     creative-tool conventions:
//       [ ]   → click_radius     (universal brush-size pattern)
//       { }   → feather_radius   (Photoshop brush hardness/softness)
//       , .   → denoise          (< > ordering on the same keys)
//     Captured in the capture phase so they beat ComfyUI's own
//     keybindings if any happen to overlap. preventDefault on a match
//     so the key event doesn't propagate further.
function installKeyboardShortcuts() {
    if (app._AngeloKeysInstalled) return;
    app._AngeloKeysInstalled = true;

    const bindings = [
        // [key, widget_name, delta, min, max, asInt, syncFn]
        ["[",  "click_radius",     -4,    8,   1024, true,  "syncClickRadiusInput"],
        ["]",  "click_radius",      4,    8,   1024, true,  "syncClickRadiusInput"],
        ["{",  "feather_radius",   -4,    0,    256, true,  "syncFeatherInput"],
        ["}",  "feather_radius",    4,    0,    256, true,  "syncFeatherInput"],
        [",",  "denoise",          -0.05, 0.05, 1.0, false, "syncDenoiseInput"],
        [".",  "denoise",           0.05, 0.05, 1.0, false, "syncDenoiseInput"],
    ];

    const handlers = {};
    for (const b of bindings) handlers[b[0]] = b;

    document.addEventListener("keydown", (event) => {
        const node = _AngeloHoveredNode;
        if (!node) return;

        // Don't intercept when the user is typing in an input or textarea
        // (e.g., the toolbar Seed input, or any other DOM widget).
        const t = event.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            return;
        }

        // Only active in Edit Mode. Sampler Mode has the toolbar
        // greyed; the keys would feel inert.
        const modeW = findWidget(node, "mode");
        if (!modeW || String(modeW.value) !== "Edit Mode") return;

        const binding = handlers[event.key];
        if (!binding) return;

        const [, name, delta, min, max, asInt, syncName] = binding;
        const w = findWidget(node, name);
        if (!w) return;
        let v = Number(w.value || 0) + delta;
        v = Math.max(min, Math.min(max, v));
        if (asInt) v = Math.round(v);
        else v = Math.round(v * 100) / 100;  // avoid float drift accumulating
        setWidget(w, v);

        // Sync the corresponding toolbar input so the visible value
        // tracks the keyboard adjustment.
        const syncFn = ({
            syncClickRadiusInput, syncFeatherInput,
            syncDenoiseInput,
        })[syncName];
        if (syncFn) syncFn(node);

        // For click_radius, also redraw the canvas so the hover ring
        // resizes immediately on the visible image.
        if (name === "click_radius" && typeof redrawCanvasWithOverlays === "function") {
            redrawCanvasWithOverlays(node);
        }

        dbg("key", event.key, "→", name, "=", v);
        event.preventDefault();
        event.stopPropagation();
    }, true);  // capture phase
    dbg("installed keyboard shortcuts");
}

app.registerExtension({
    name: "Angelo.ClickToRefine",

    async setup() {
        installQueueHook();
        installKeyboardShortcuts();
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== NODE_NAME) return;

        // --- Node setup: attach the preview canvas + hide mechanical widgets ---
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);
            hideMechanicalWidgets(this);
            attachPreviewCanvas(this);
            // Force LiteGraph to recompute layout now that hidden widgets
            // claim zero height — otherwise the node keeps its initial
            // tall size and the (now-hidden) widget slots show as gaps.
            if (typeof this.setSize === "function" && this.computeSize) {
                const min = this.computeSize();
                if (this.size[1] < min[1]) this.size[1] = min[1];
            }
            // Reflect persisted widget state in every toolbar control.
            // NOTE: on an existing-workflow load this runs BEFORE the
            // serialized widget values are restored, so the toggles
            // may show defaults here. The onConfigure hook below re-runs
            // the same sync after the restore to correct any mismatch.
            syncAllToolbarControls(this);

            // Mode widget: grey toolbar in Sampler Mode, un-grey in
            // Refinement; auto-force sampler_seed_control = fixed when
            // flipping into Refinement (and restore sampler_seed to its
            // at-run value via lockSeedToAtRun).
            const modeW = findWidget(this, "mode");
            if (modeW) {
                const origCb = modeW.callback;
                modeW.callback = (value, ...args) => {
                    const prevValue = modeW._AngeloPrevValue;
                    if (origCb) {
                        try { origCb.call(modeW, value, ...args); }
                        catch (e) { dbg("mode callback orig threw", e); }
                    }
                    modeW._AngeloPrevValue = value;
                    syncModeSwitchToFixed(this, prevValue);
                    syncModeState(this);
                };
                modeW._AngeloPrevValue = modeW.value;
            }
            syncModeState(this);   // initial state reflects persisted widget

            // Seed-control widgets: when value transitions TO "fixed"
            // (either by user click or programmatic set), restore the
            // corresponding seed widget to the seed_at_run value. This
            // ensures "fixed" always means "the seed that produced the
            // current canvas", not whatever value after-gen left in the
            // widget. Wrap each widget's callback to detect the transition.
            const samplerCtrlW = findWidget(this, "sampler_seed_control");
            if (samplerCtrlW) {
                const origCb = samplerCtrlW.callback;
                samplerCtrlW.callback = (value, ...args) => {
                    const prevValue = samplerCtrlW._AngeloPrevValue;
                    if (origCb) {
                        try { origCb.call(samplerCtrlW, value, ...args); }
                        catch (e) { dbg("sampler_seed_control callback orig threw", e); }
                    }
                    samplerCtrlW._AngeloPrevValue = value;
                    if (value === "fixed" && prevValue !== "fixed") {
                        lockSeedToAtRun(this, "sampler_seed", "sampler_seed_control");
                    }
                };
                samplerCtrlW._AngeloPrevValue = samplerCtrlW.value;
            }

            const seedCtrlW = findWidget(this, "seed_control");
            if (seedCtrlW) {
                const origCb = seedCtrlW.callback;
                seedCtrlW.callback = (value, ...args) => {
                    const prevValue = seedCtrlW._AngeloPrevValue;
                    if (origCb) {
                        try { origCb.call(seedCtrlW, value, ...args); }
                        catch (e) { dbg("seed_control callback orig threw", e); }
                    }
                    seedCtrlW._AngeloPrevValue = value;
                    if (value === "fixed" && prevValue !== "fixed") {
                        lockSeedToAtRun(this, "seed", "seed_control");
                    }
                };
                seedCtrlW._AngeloPrevValue = seedCtrlW.value;
            }
            const min = [340, 540];
            if (this.size[0] < min[0]) this.size[0] = min[0];
            if (this.size[1] < min[1]) this.size[1] = min[1];
        };

        // --- onExecuted: receive the new preview URL, draw into our canvas,
        //     and run after-gen seed control + record seed_at_run for the
        //     lock-on-fixed semantics. ---
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            if (origOnExecuted) origOnExecuted.apply(this, arguments);
            dbg("onExecuted", message);

            // Preview image (Angelo_preview)
            const refs = message?.Angelo_preview;
            if (refs && refs.length > 0) {
                const ref = refs[0];
                const url = makeViewUrl(ref);
                dbg("loading preview", url);
                loadIntoCanvas(this, url);
            }

            // Seed_at_run capture — used by the lock-on-fixed code. ComfyUI's
            // ui message values arrive as 1-element lists (their convention).
            const lastMode = message?.Angelo_mode?.[0];
            const samplerSeedAtRun = message?.Angelo_sampler_seed_at_run?.[0];
            const refineSeedAtRun = message?.Angelo_refine_seed_at_run?.[0];
            if (samplerSeedAtRun != null) {
                this._AngeloSamplerSeedAtRun = Number(samplerSeedAtRun);
            }
            if (refineSeedAtRun != null) {
                this._AngeloRefineSeedAtRun = Number(refineSeedAtRun);
            }

            // After-gen seed control. ComfyUI's standard "seed widgets" have
            // an auto-added control_after_generate dropdown that does this
            // for them; ours are explicit ENUM widgets, so we apply the
            // logic ourselves. Runs AFTER seed_at_run is captured so a
            // subsequent lock-on-fixed restores the pre-modification value.
            if (lastMode === "Sampler Mode") {
                applyAfterGenControl(this, "sampler_seed", "sampler_seed_control");
            } else if (lastMode === "Edit Mode") {
                applyAfterGenControl(this, "seed", "seed_control");
            }
        };

        // Reset and Undo now live on the DOM toggle bar above the canvas
        // (see attachPreviewCanvas). Removed the canvas-title-bar hooks
        // that used to draw + hit-test them — all interactive controls
        // sit on one horizontal line.

        // --- onConfigure: fires when a saved workflow is loaded and the
        //     node's serialized widget values are restored. onNodeCreated
        //     runs BEFORE that restore, so the toolbar would otherwise
        //     reflect defaults (e.g. Paint Mode shows OFF when the saved
        //     value was ON, and vice-versa). Re-run the full toolbar sync
        //     here so the DOM controls match the restored widget state. ---
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (origOnConfigure) origOnConfigure.apply(this, arguments);
            // Defer one tick — some ComfyUI versions finish applying
            // widget values immediately after onConfigure returns, so a
            // microtask-delayed sync sees the final restored state.
            const node = this;
            queueMicrotask(() => {
                try { syncAllToolbarControls(node); }
                catch (e) { dbg("onConfigure sync threw", e); }
            });
        };
    },
});


// ============================================================
// Preview canvas (the DOM widget that displays + handles clicks)
// ============================================================

function attachPreviewCanvas(node) {
    if (node._AngeloWidget) return;  // already attached

    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.position = "relative";
    container.style.background = "#1a1a1a";
    container.style.border = "1px solid #333";
    container.style.borderRadius = "4px";
    container.style.overflow = "hidden";
    container.style.display = "flex";
    container.style.flexDirection = "column";

    // Toolbar above the canvas, top to bottom:
    //   modeRow     — Mode dropdown, centred (the master Sampler/Edit switch)
    //   row3        — shared generation config (steps/cfg/sampler/sched), always active
    //   row4        — Sampler-Mode base-gen seed group, greyed in Edit Mode
    //   refineRows  — edit actions + refine values, greyed in Sampler Mode
    const toggleBarWrap = document.createElement("div");
    toggleBarWrap.style.display = "flex";
    toggleBarWrap.style.flexDirection = "column";
    toggleBarWrap.style.background = "#222";
    toggleBarWrap.style.borderBottom = "1px solid #333";
    toggleBarWrap.style.transition = "opacity 0.15s ease";  // smooth grey/un-grey on mode switch
    node._AngeloToolbarWrap = toggleBarWrap;

    // Mode row — centred at the top of the node, visually separated from
    // the rest of the toolbar by a bottom border.
    const modeRow = makeToolbarRow();
    modeRow.style.justifyContent = "center";
    modeRow.style.borderBottom = "1px solid #333";

    // Generation / sampler-seed rows (set-once-ish, sit under Mode).
    const row3 = makeToolbarRow();
    const row4 = makeToolbarRow();
    row4.style.transition = "opacity 0.15s ease";

    // Edit control rows — greyed in Sampler Mode (wrapped so the grey
    // target is just these rows, not the generation rows). A top border
    // separates the "edit" group from the "generation" group above.
    const refineRowsWrap = document.createElement("div");
    refineRowsWrap.style.transition = "opacity 0.15s ease";
    refineRowsWrap.style.borderTop = "1px solid #333";
    const row1 = makeToolbarRow();
    const row2 = makeToolbarRow();
    refineRowsWrap.appendChild(row1);
    refineRowsWrap.appendChild(row2);

    toggleBarWrap.appendChild(modeRow);
    toggleBarWrap.appendChild(row3);
    toggleBarWrap.appendChild(row4);
    toggleBarWrap.appendChild(refineRowsWrap);

    node._AngeloModeRow = modeRow;
    node._AngeloRefineRowsWrap = refineRowsWrap;
    node._AngeloSamplerSeedRow = row4;

    // ===== ROW 1: actions + mode toggles =====
    const resetBtn = makeActionButton("Reset", () => triggerReset(node), "reset");
    resetBtn.title = "Throw away the cached refined latent + history and start fresh from the upstream latent.";
    row1.appendChild(resetBtn);

    const undoBtn = makeActionButton("Undo", () => triggerUndo(node), "undo");
    undoBtn.title = "Pop the most recent refine off the history stack. Restores the cached latent from before the last click.";
    row1.appendChild(undoBtn);

    row1.appendChild(makeSeparator());

    const persistentMaskToggle = makeToggleButton("Persistent Mask", () => {
        const w = findWidget(node, "persistent_mask");
        if (!w) return;
        setWidget(w, !w.value);
        syncPersistentMaskToggle(node);
    });
    persistentMaskToggle.title = "When ON, the last mask is held. Pressing the standard ComfyUI Queue button re-runs the workflow refining only that region with a fresh seed each time — variations of one area without re-painting.";
    row1.appendChild(persistentMaskToggle);
    node._AngeloPersistentMaskToggle = persistentMaskToggle;

    const areaPromptToggle = makeToggleButton("Area Prompt", () => {
        const w = findWidget(node, "area_prompt");
        if (!w) return;
        setWidget(w, !w.value);
        syncAreaPromptToggle(node);
        syncAreaPromptVisibility(node);
    });
    areaPromptToggle.title = "When ON, a text box appears between the toolbar and the canvas. Refines encode that text with the connected CLIP and use it instead of the main prompt — paint/drag a region and reshape it with a different prompt. Requires a CLIP input wired + non-empty area text. Forced ON in Smart Inpaint.";
    row1.appendChild(areaPromptToggle);
    node._AngeloAreaPromptToggle = areaPromptToggle;

    const paintModeToggle = makeToggleButton("Paint Mode", () => {
        const w = findWidget(node, "paint_mode");
        if (!w) return;
        setWidget(w, !w.value);
        syncPaintModeToggle(node);
    });
    paintModeToggle.title = "When ON, hold + drag on the preview paints a freeform brush stroke (each dragged point becomes a circle of click_radius; the union is the refine mask). Release to submit. When OFF, clicks behave as single-circle refines.";
    row1.appendChild(paintModeToggle);
    node._AngeloPaintModeToggle = paintModeToggle;

    const fineUpscaleToggle = makeToggleButton("Fine Upscale", () => {
        const w = findWidget(node, "fine_upscaling");
        if (!w) return;
        setWidget(w, !w.value);
        syncFineUpscaleToggle(node);
    });
    fineUpscaleToggle.title = "When ON, the painted region is cropped from the latent, VAE-decoded, upscaled in pixel space to hit MP target, re-encoded, refined, and composited back. Gives the model effective higher resolution on small regions. Capped at Max linear scale.";
    row1.appendChild(fineUpscaleToggle);
    node._AngeloFineUpscaleToggle = fineUpscaleToggle;

    row1.appendChild(makeSeparator());

    // Inpainting Mode dropdown — Refine / Insert V1 / Insert V2.
    // Refine = current behaviour (best for refining existing content)
    // Smart Inpaint = drag a rectangle; locks denoise=1.0 / Fine Upscale=ON /
    //                 Ctx Pad=0; adds reference_latents so an edit model
    //                 (Klein 9B) sees the scene through its edit branch.
    const inpaintModeWidget = findWidget(node, "inpainting_mode");
    const inpaintModeOptions = (inpaintModeWidget && inpaintModeWidget.options && inpaintModeWidget.options.values)
        ? inpaintModeWidget.options.values
        : ["Refine", "Smart Inpaint", "Smart Guided Inpaint"];
    const inpaintModeSelect = makeDropdown("Inpaint",
        inpaintModeOptions,
        (val) => {
            const w = findWidget(node, "inpainting_mode");
            if (!w) return;
            setWidget(w, val);
            // Switching INTO Smart Inpaint: default feather to 0 (hard
            // rectangle edge). It stays user-adjustable afterwards — this
            // only fires on the user's mode pick, not on workflow load,
            // so a saved feather value is preserved across reloads.
            if (val === "Smart Inpaint") {
                const fw = findWidget(node, "feather_radius");
                if (fw) {
                    setWidget(fw, 0);
                    syncFeatherInput(node);
                }
            }
            // Mode change rewires the canvas interaction model — redraw
            // so the cursor / toolbar / overlays reflect it immediately.
            syncSmartInpaintLockedWidgets(node);
            redrawCanvasWithOverlays(node);
        }
    );
    inpaintModeSelect.title = "Inpainting Mode.\n\n"
        + "Refine — paint/click on the canvas to refine an existing region (faces, hands, textures). Partial-denoise from existing content.\n\n"
        + "Smart Inpaint — drag a rectangle on the canvas (click and hold one corner, release at the opposite). Adds NEW content in that region. Locks denoise=1.0 + Fine Upscale=ON + Area Prompt=ON; injects reference_latents so an edit model's (FLUX 2 Klein 9B etc.) edit branch activates. Feather defaults to 0 but stays adjustable.\n\n"
        + "Smart Guided Inpaint — no painting or boxes. Pick a LOCATION from the dropdown above the Area Prompt (top left, center, bottom half, …); it's prepended to your prompt at run time (e.g. 'In the top left of the image, a red car') and the edit model places the content there across the whole image. Locks denoise=1.0 + Fine Upscale=OFF + Area Prompt=ON; Feather and Persistent Mask disabled (no mask). Press 'Generate Guided Edit' to run. Coarse regions land most reliably.";
    row1.appendChild(inpaintModeSelect);
    node._AngeloInpaintModeSelect = inpaintModeSelect;

    // ===== ROW 2: numeric values =====
    const clickRadiusInput = makeNumberInput("Click R", { min: 8, max: 1024, step: 4, width: 56 }, (val) => {
        const w = findWidget(node, "click_radius");
        if (!w) return;
        setWidget(w, Math.round(val));
    });
    clickRadiusInput.title = "Pixel-space radius of the refinement region for a single click. Also the brush size in paint mode.\n\nKeyboard (cursor over canvas): [ to shrink, ] to grow.";
    row2.appendChild(clickRadiusInput);
    node._AngeloClickRadiusInput = clickRadiusInput;

    const featherInput = makeNumberInput("Feather", { min: 0, max: 256, step: 4, width: 56 }, (val) => {
        const w = findWidget(node, "feather_radius");
        if (!w) return;
        setWidget(w, Math.round(val));
    });
    featherInput.title = "Pixel-space gaussian blur on the mask edge. Smooths the seam between refined region and preserved surroundings. Roughly click_radius / 4 is a good default.\n\nKeyboard (cursor over canvas): { (shift+[) to shrink, } (shift+]) to grow.";
    row2.appendChild(featherInput);
    node._AngeloFeatherInput = featherInput;

    const denoiseInput = makeNumberInput("Denoise", { min: 0.05, max: 1.0, step: 0.05, width: 56 }, (val) => {
        const w = findWidget(node, "denoise");
        if (!w) return;
        setWidget(w, val);
    });
    denoiseInput.title = "How much of the sampler trajectory to run on the refine. 0.3 = subtle touch-up, 0.6 = real redo, 0.9+ = essentially regenerate that region.\n\nKeyboard (cursor over canvas): , to decrease, . to increase.";
    row2.appendChild(denoiseInput);
    node._AngeloDenoiseInput = denoiseInput;

    const seedInput = makeNumberInput("Seed", { min: 0, max: 0xFFFFFFFFFFFFFFFF, step: 1, width: 120 }, (val) => {
        const w = findWidget(node, "seed");
        if (!w) return;
        setWidget(w, Math.round(val));
    });
    seedInput.title = "[Edit Mode] Seed for the refine pass. After each click the Seed Ctrl dropdown decides what happens — fixed (leave alone), randomize (new random), increment (+1), decrement (-1).";
    row2.appendChild(seedInput);
    node._AngeloSeedInput = seedInput;

    const seedCtrlSelect = makeDropdown("Ctrl",
        ["fixed", "increment", "decrement", "randomize"],
        (val) => {
            const w = findWidget(node, "seed_control");
            if (!w) return;
            setWidget(w, val);
        }
    );
    seedCtrlSelect.title = "[Edit Mode] After-click seed behaviour. Mirrors ComfyUI's standard seed control_after_generate dropdown.";
    row2.appendChild(seedCtrlSelect);
    node._AngeloSeedCtrlSelect = seedCtrlSelect;

    row2.appendChild(makeSeparator());

    const mpInput = makeNumberInput("MP", { min: 0.1, max: 4.0, step: 0.1, width: 50 }, (val) => {
        const w = findWidget(node, "min_megapixels");
        if (!w) return;
        setWidget(w, val);
    });
    mpInput.title = "Fine Upscale: target megapixels for the refine pass. Higher = bigger compute per click but sharper detail. Only used when Fine Upscale is ON.";
    row2.appendChild(mpInput);
    node._AngeloMpInput = mpInput;

    const maxInput = makeNumberInput("Max", { min: 1.0, max: 16.0, step: 0.5, width: 50 }, (val) => {
        const w = findWidget(node, "max_upscale");
        if (!w) return;
        setWidget(w, val);
    });
    maxInput.title = "Fine Upscale: hard cap on linear upscale factor (8× = 64× area). Prevents pathological blow-up on tiny paints. Only used when Fine Upscale is ON.";
    row2.appendChild(maxInput);
    node._AngeloMaxInput = maxInput;

    // Ctx Pad: the fine_context_pad widget still exists on the
    // backend (serialised on existing workflows; used by the Refine
    // path's Fine Upscale crop with its default value). The toolbar
    // control was removed — Smart Inpaint forces it to 0 anyway and
    // tuning it for Refine isn't pulling its weight as a user-facing
    // knob.

    // Read the resize-method options from the underlying widget enum.
    const methodWidget = findWidget(node, "resize_method");
    const methodOptions = (methodWidget && methodWidget.options && methodWidget.options.values)
        ? methodWidget.options.values
        : ["nearest-exact", "bilinear", "area", "bicubic", "bislerp", "lanczos"];
    const methodSelect = makeDropdown("Method",
        methodOptions,
        (val) => {
            const w = findWidget(node, "resize_method");
            if (!w) return;
            setWidget(w, val);
        }
    );
    methodSelect.title = "Fine Upscale: pixel-space upscale method. lanczos = sharpest with mild ringing; bilinear = smooth (great for skin/faces); bicubic = middle; nearest-exact = blocky preserves exact values; bislerp/area = niche. Only used when Fine Upscale is ON.";
    row2.appendChild(methodSelect);
    node._AngeloMethodSelect = methodSelect;

    // ===== MODE ROW: the master Sampler/Edit switch, centred up top =====
    const modeWidget = findWidget(node, "mode");
    const modeOptions = (modeWidget && modeWidget.options && modeWidget.options.values)
        ? modeWidget.options.values
        : ["Edit Mode", "Sampler Mode"];
    const modeSelect = makeDropdown("Mode",
        modeOptions,
        (val) => {
            const w = findWidget(node, "mode");
            if (!w) return;
            setWidget(w, val);   // fires the wrapped mode callback (lock + grey sync)
        }
    );
    modeSelect.title = "Sampler Mode = generate a fresh base latent from the inputs (acts like a KSampler). Edit Mode = click/drag the preview to refine or inpaint the cached latent. Switching to Edit Mode auto-locks the sampler seed to the value that produced the base.";
    modeRow.appendChild(modeSelect);
    node._AngeloModeSelect = modeSelect;

    // ===== ROW 3: shared generation config (always active) =====
    const stepsInput = makeNumberInput("Steps", { min: 1, max: 100, step: 1, width: 48 }, (val) => {
        const w = findWidget(node, "steps");
        if (!w) return;
        setWidget(w, Math.round(val));
    });
    stepsInput.title = "Sampler step count for both Sampler Mode and refines. Match the model — FLUX 2 Klein distilled = 4.";
    row3.appendChild(stepsInput);
    node._AngeloStepsInput = stepsInput;

    const cfgInput = makeNumberInput("CFG", { min: 0.0, max: 30.0, step: 0.1, width: 48 }, (val) => {
        const w = findWidget(node, "cfg");
        if (!w) return;
        setWidget(w, val);
    });
    cfgInput.title = "Classifier-free guidance scale. FLUX 2 Klein distilled uses CFG=1 (no negative branch).";
    row3.appendChild(cfgInput);
    node._AngeloCfgInput = cfgInput;

    const samplerWidget = findWidget(node, "sampler_name");
    const samplerOptions = (samplerWidget && samplerWidget.options && samplerWidget.options.values)
        ? samplerWidget.options.values
        : ["euler"];
    const samplerSelect = makeDropdown("Sampler",
        samplerOptions,
        (val) => {
            const w = findWidget(node, "sampler_name");
            if (!w) return;
            setWidget(w, val);
        }
    );
    samplerSelect.title = "Sampling algorithm (shared by Sampler Mode + refines).";
    row3.appendChild(samplerSelect);
    node._AngeloSamplerSelect = samplerSelect;

    const schedulerWidget = findWidget(node, "scheduler");
    const schedulerOptions = (schedulerWidget && schedulerWidget.options && schedulerWidget.options.values)
        ? schedulerWidget.options.values
        : ["simple"];
    const schedulerSelect = makeDropdown("Sched",
        schedulerOptions,
        (val) => {
            const w = findWidget(node, "scheduler");
            if (!w) return;
            setWidget(w, val);
        }
    );
    schedulerSelect.title = "Noise schedule (shared by Sampler Mode + refines).";
    row3.appendChild(schedulerSelect);
    node._AngeloSchedulerSelect = schedulerSelect;

    // ===== ROW 4: Sampler-Mode seed group (greyed in Edit Mode) =====
    const samplerSeedInput = makeNumberInput("Smpl Seed", { min: 0, max: 0xFFFFFFFFFFFFFFFF, step: 1, width: 120 }, (val) => {
        const w = findWidget(node, "sampler_seed");
        if (!w) return;
        setWidget(w, Math.round(val));
    });
    samplerSeedInput.title = "[Sampler Mode] Seed for the base generation. After each run the Sampler Ctrl dropdown decides what happens to it.";
    row4.appendChild(samplerSeedInput);
    node._AngeloSamplerSeedInput = samplerSeedInput;

    const samplerSeedCtrlSelect = makeDropdown("Smpl Ctrl",
        ["fixed", "increment", "decrement", "randomize"],
        (val) => {
            const w = findWidget(node, "sampler_seed_control");
            if (!w) return;
            setWidget(w, val);
        }
    );
    samplerSeedCtrlSelect.title = "[Sampler Mode] After-generate seed behaviour for the base. Auto-forced to 'fixed' when you switch to Edit Mode so re-queues don't regenerate the base.";
    row4.appendChild(samplerSeedCtrlSelect);
    node._AngeloSamplerSeedCtrlSelect = samplerSeedCtrlSelect;

    const samplerDenoiseInput = makeNumberInput("Smpl Denoise", { min: 0.0, max: 1.0, step: 0.05, width: 56 }, (val) => {
        const w = findWidget(node, "sampler_denoise");
        if (!w) return;
        setWidget(w, val);
    });
    samplerDenoiseInput.title = "[Sampler Mode] Denoise for the base generation. 1.0 = full generation from the incoming (usually empty) latent.";
    row4.appendChild(samplerDenoiseInput);
    node._AngeloSamplerDenoiseInput = samplerDenoiseInput;

    container.appendChild(toggleBarWrap);

    // --- Area Prompt input — sits BETWEEN the toolbar and the canvas,
    //     and only shows when Area Prompt is ON (or Smart Inpaint forces
    //     it on). One textarea with a Pos/Neg toggle deciding which
    //     underlying widget it edits (area_text_positive /
    //     area_text_negative). Hiding it never clears the text — that
    //     lives in the widgets, and syncAreaPromptBox reloads it. ---
    attachAreaPromptBox(node, container);

    // Canvas + placeholder live in their own relative-positioned wrap
    // so the absolutely-positioned placeholder overlays ONLY the canvas.
    // The wrap flex-grows to fill whatever vertical space is left after
    // the toolbar + area-prompt box, and centres the canvas inside it.
    // The canvas's DISPLAY size is computed in JS (fitCanvasDisplaySize)
    // to fit this wrap while preserving aspect ratio — letterboxed by
    // the empty space around it, NOT by object-fit (which would break
    // the click-coordinate mapping that reads canvas.getBoundingClientRect).
    const canvasWrap = document.createElement("div");
    canvasWrap.style.position = "relative";
    canvasWrap.style.width = "100%";
    canvasWrap.style.flex = "1 1 auto";
    canvasWrap.style.minHeight = "0";
    canvasWrap.style.display = "flex";
    canvasWrap.style.alignItems = "center";
    canvasWrap.style.justifyContent = "center";
    canvasWrap.style.overflow = "hidden";

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    // Display size is set in px by fitCanvasDisplaySize; max-* are a
    // belt-and-suspenders cap so it never overflows before the first fit.
    canvas.style.maxWidth = "100%";
    canvas.style.maxHeight = "100%";
    canvas.style.cursor = "crosshair";
    canvas.width = 512;
    canvas.height = 512;
    canvasWrap.appendChild(canvas);

    // Placeholder text shown until the first image arrives
    const placeholder = document.createElement("div");
    placeholder.textContent = "Queue the workflow to generate a preview.\nClick a region in the preview to refine it.";
    placeholder.style.position = "absolute";
    placeholder.style.inset = "0";
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.style.textAlign = "center";
    placeholder.style.color = "#888";
    placeholder.style.padding = "20px";
    placeholder.style.whiteSpace = "pre-line";
    placeholder.style.pointerEvents = "none";
    placeholder.style.fontSize = "12px";
    canvasWrap.appendChild(placeholder);

    container.appendChild(canvasWrap);

    // --- Pointer events (instead of mouse*) + pointer capture so long
    //     drags don't get cancelled when the cursor leaves the canvas
    //     boundary briefly. Pointer capture routes all subsequent move/
    //     up events to the canvas until the drag ends. ---

    // Helper: clamp event coordinates to the canvas's CSS rect, then
    // convert to canvas-intrinsic (= image-pixel) coordinates.
    function eventToImagePixel(event) {
        const rect = canvas.getBoundingClientRect();
        let cx = event.clientX - rect.left;
        let cy = event.clientY - rect.top;
        // Clamp so off-canvas drag positions still produce valid points
        // at the canvas edge rather than negative / oversized values.
        cx = Math.max(0, Math.min(rect.width, cx));
        cy = Math.max(0, Math.min(rect.height, cy));
        const img = node._AngeloImg;
        if (!img || !img.naturalWidth || rect.width === 0 || rect.height === 0) {
            return null;
        }
        return {
            cssX: cx,
            cssY: cy,
            pixelX: (cx / rect.width) * img.naturalWidth,
            pixelY: (cy / rect.height) * img.naturalHeight,
        };
    }

    canvas.addEventListener("pointermove", (event) => {
        const p = eventToImagePixel(event);
        if (!p) return;
        node._AngeloHover = { x: p.cssX, y: p.cssY };

        if (node._AngeloDraggingRect) {
            // Smart Inpaint: update the live opposite-corner of the
            // drag-out rectangle as the user moves the cursor.
            node._AngeloDraggingRect.x2 = p.pixelX;
            node._AngeloDraggingRect.y2 = p.pixelY;
            node._AngeloDraggingRect.cssX2 = p.cssX;
            node._AngeloDraggingRect.cssY2 = p.cssY;
        } else if (node._AngeloPainting) {
            const stroke = node._AngeloStroke;
            const last = stroke[stroke.length - 1];
            // Dedup at 2px (image-pixel space) — saves bandwidth.
            if (!last || Math.hypot(last[0] - p.pixelX, last[1] - p.pixelY) > 2) {
                stroke.push([p.pixelX, p.pixelY]);
            }
        }
        redrawCanvasWithOverlays(node);
    });

    canvas.addEventListener("pointerleave", () => {
        node._AngeloHover = null;
        // IMPORTANT: do NOT cancel an active paint stroke here. With
        // pointer capture set on pointerdown, we keep receiving move/up
        // events even when the cursor leaves the canvas — long strokes
        // can briefly cross the boundary without breaking.
        redrawCanvasWithOverlays(node);
        if (_AngeloHoveredNode === node) _AngeloHoveredNode = null;
    });

    // Track keyboard-shortcut hover ownership separately from the
    // paint-stroke pointer events above. pointerenter fires when the
    // cursor crosses INTO the canvas — at that point this node owns the
    // keyboard shortcuts.
    canvas.addEventListener("pointerenter", () => {
        _AngeloHoveredNode = node;
    });

    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        // Smart Guided Inpaint has no canvas interaction at all — the
        // location comes from the dropdown, the run from the button.
        if (isSmartGuidedInpaintMode(node)) return;
        const smartInpaint = isSmartInpaintMode(node);
        const paintOn = isPaintModeOn(node);
        dbg("pointerdown", { smartInpaint, paintModeOn: paintOn });

        // Smart Inpaint always owns the canvas — drag-out rectangle.
        // It takes priority over paint_mode.
        if (!smartInpaint && !paintOn) return;
        const p = eventToImagePixel(event);
        if (!p) return;

        // Pointer capture: route all subsequent pointer events to this
        // element until pointerup, regardless of cursor position.
        try {
            canvas.setPointerCapture(event.pointerId);
            node._AngeloPointerId = event.pointerId;
        } catch (e) {
            dbg("setPointerCapture failed", e);
        }

        if (smartInpaint) {
            node._AngeloDraggingRect = {
                x1: p.pixelX, y1: p.pixelY,
                x2: p.pixelX, y2: p.pixelY,
                cssX1: p.cssX, cssY1: p.cssY,
                cssX2: p.cssX, cssY2: p.cssY,
            };
        } else {
            node._AngeloPainting = true;
            node._AngeloStroke = [[p.pixelX, p.pixelY]];
        }
        redrawCanvasWithOverlays(node);
        // Don't preventDefault on pointerdown — we still want pointermove
        // to fire normally. The subsequent "click" event won't fire if
        // any meaningful drag occurred (browser behaviour), and our
        // click handler also short-circuits when paint_mode is on.
    });

    function endPaintStroke(event) {
        if (!node._AngeloPainting) return;
        node._AngeloPainting = false;
        if (node._AngeloPointerId !== undefined) {
            try { canvas.releasePointerCapture(node._AngeloPointerId); }
            catch (e) { /* already released */ }
            node._AngeloPointerId = undefined;
        }
        const stroke = node._AngeloStroke || [];
        node._AngeloStroke = null;
        if (stroke.length === 0) {
            redrawCanvasWithOverlays(node);
            return;
        }
        dbg("paint stroke submitted", { points: stroke.length });
        triggerPaintRefine(node, stroke);
        redrawCanvasWithOverlays(node);
    }

    function endRectDrag() {
        if (!node._AngeloDraggingRect) return;
        const r = node._AngeloDraggingRect;
        node._AngeloDraggingRect = null;
        if (node._AngeloPointerId !== undefined) {
            try { canvas.releasePointerCapture(node._AngeloPointerId); }
            catch (e) { /* already released */ }
            node._AngeloPointerId = undefined;
        }
        const dx = Math.abs(r.x2 - r.x1);
        const dy = Math.abs(r.y2 - r.y1);
        // Reject degenerate (single-click) drags — Smart Inpaint needs
        // an actual rectangle. Threshold in image-pixel space.
        if (dx < 8 || dy < 8) {
            dbg("rect drag too small — ignored", { dx, dy });
            redrawCanvasWithOverlays(node);
            return;
        }
        dbg("smart inpaint rect submitted", r);
        triggerRectRefine(node, [r.x1, r.y1, r.x2, r.y2]);
        redrawCanvasWithOverlays(node);
    }

    canvas.addEventListener("pointerup", (event) => {
        if (event.button !== 0) return;
        if (node._AngeloDraggingRect) endRectDrag();
        else endPaintStroke(event);
    });
    canvas.addEventListener("pointercancel", (event) => {
        if (node._AngeloDraggingRect) endRectDrag();
        else endPaintStroke(event);
    });

    // --- Single-click refine (click mode only — paint mode and
    //     Smart Inpaint handle the canvas via pointer drag above). ---
    canvas.addEventListener("click", (event) => {
        if (isSmartGuidedInpaintMode(node)) return; // no canvas interaction
        if (isSmartInpaintMode(node)) return; // rectangle-drag owns it
        if (isPaintModeOn(node)) return; // paint mode owns the interaction
        const rect = canvas.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const img = node._AngeloImg;
        if (!img || !img.naturalWidth) {
            dbg("click ignored — no image loaded yet");
            return;
        }
        const pixelX = Math.floor((cx / rect.width) * img.naturalWidth);
        const pixelY = Math.floor((cy / rect.height) * img.naturalHeight);
        dbg("click", { cx, cy, pixelX, pixelY });
        triggerRefine(node, pixelX, pixelY, cx, cy);
        flashClickOverlay(node, cx, cy);
    });

    // Add as a DOM widget on the node so LiteGraph manages its layout.
    // getMinHeight floors the DOM-widget area; the toolbar now spans 4
    // rows so we give the canvas a sensible minimum below it. The canvas
    // itself scales to fill whatever space is left (fitCanvasDisplaySize),
    // so resizing the node taller just grows the image.
    const widget = node.addDOMWidget("Angelo_preview_canvas", "Angelo_canvas", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 320,
    });

    node._AngeloWidget = widget;
    node._AngeloCanvas = canvas;
    node._AngeloCanvasWrap = canvasWrap;
    node._AngeloPlaceholder = placeholder;
    node._AngeloContainer = container;

    // Re-fit the canvas whenever its available area changes — node
    // resize, area-prompt box show/hide, etc. ResizeObserver fires on
    // the wrap's rendered-size changes, which covers all of them.
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => fitCanvasDisplaySize(node));
        ro.observe(canvasWrap);
        node._AngeloCanvasResizeObserver = ro;
        const onRemoved = node.onRemoved;
        node.onRemoved = function () {
            try { ro.disconnect(); } catch (e) { /* noop */ }
            if (onRemoved) onRemoved.apply(this, arguments);
        };
    }
    fitCanvasDisplaySize(node);

    dbg("attached preview canvas to node", node.id);
}

// Compute and apply the canvas DISPLAY size (CSS px) so the image fits
// entirely within its wrap while preserving aspect ratio — scaling both
// up and down. The canvas bitmap stays at the image's native resolution;
// only the CSS box scales, so click mapping (via getBoundingClientRect)
// and overlay drawing stay correct. The wrap centres the result, so any
// leftover space becomes letterbox margin.
function fitCanvasDisplaySize(node) {
    const canvas = node._AngeloCanvas;
    const wrap = node._AngeloCanvasWrap;
    if (!canvas || !wrap) return;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;
    const img = node._AngeloImg;
    const natW = (img && img.naturalWidth) ? img.naturalWidth : canvas.width;
    const natH = (img && img.naturalHeight) ? img.naturalHeight : canvas.height;
    if (natW <= 0 || natH <= 0) return;
    const scale = Math.min(availW / natW, availH / natH);
    canvas.style.width = Math.max(1, Math.floor(natW * scale)) + "px";
    canvas.style.height = Math.max(1, Math.floor(natH * scale)) + "px";
}

// Area Prompt box: a single textarea below the canvas plus a Pos/Neg
// toggle. The toggle decides which underlying widget the textarea is
// bound to (area_text_positive / area_text_negative). We keep the
// non-edited prompt's value in its widget untouched, so flipping the
// toggle just re-points the textarea at the other widget's text.
function attachAreaPromptBox(node, container) {
    node._AngeloAreaPromptTarget = "positive";

    const wrap = document.createElement("div");
    wrap.style.display = "flex";  // toggled to "none" by syncAreaPromptVisibility
    wrap.style.flexDirection = "column";
    wrap.style.background = "#222";
    wrap.style.borderTop = "1px solid #333";
    wrap.style.borderBottom = "1px solid #333";
    wrap.style.padding = "4px";
    wrap.style.gap = "4px";

    // Header row: label + Pos/Neg toggle.
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "6px";

    const label = document.createElement("span");
    label.textContent = "Area Prompt";
    label.style.color = "#bbb";
    label.style.fontSize = "11px";
    label.style.userSelect = "none";
    header.appendChild(label);

    const posNegBtn = document.createElement("button");
    posNegBtn.textContent = "Positive";
    posNegBtn.style.fontSize = "11px";
    posNegBtn.style.padding = "2px 8px";
    posNegBtn.style.borderRadius = "3px";
    posNegBtn.style.border = "1px solid #555";
    posNegBtn.style.background = "rgba(30, 120, 80, 0.95)";
    posNegBtn.style.color = "#fff";
    posNegBtn.style.cursor = "pointer";
    posNegBtn.style.userSelect = "none";
    posNegBtn.title = "Switch which Area Prompt this box edits. Positive = what to draw; "
        + "Negative = what to avoid (ignored by CFG=1 / distilled models like Klein, kept for others).";
    header.appendChild(posNegBtn);

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Area prompt — describes the masked region (used when Area Prompt is ON).";
    textarea.style.width = "100%";
    textarea.style.boxSizing = "border-box";
    textarea.style.minHeight = "48px";
    textarea.style.resize = "vertical";
    textarea.style.fontSize = "12px";
    textarea.style.fontFamily = "inherit";
    textarea.style.padding = "4px";
    textarea.style.border = "1px solid #555";
    textarea.style.borderRadius = "3px";
    textarea.style.background = "#1a1a1a";
    textarea.style.color = "#ddd";

    // Stop pointer/key events from bubbling to the graph canvas (node
    // drag / delete / canvas shortcuts) while editing.
    for (const ev of ["pointerdown", "mousedown", "keydown", "keyup", "wheel"]) {
        textarea.addEventListener(ev, (e) => e.stopPropagation());
    }

    const targetWidgetName = () =>
        node._AngeloAreaPromptTarget === "negative" ? "area_text_negative" : "area_text_positive";

    textarea.addEventListener("input", () => {
        const w = findWidget(node, targetWidgetName());
        if (w) setWidget(w, textarea.value);
    });

    posNegBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Persist current text before switching (input handler already
        // did, but be safe), then flip the target and reload.
        const curW = findWidget(node, targetWidgetName());
        if (curW) setWidget(curW, textarea.value);

        node._AngeloAreaPromptTarget =
            node._AngeloAreaPromptTarget === "negative" ? "positive" : "negative";
        syncAreaPromptBox(node);
    });

    // "Insert Smart Phrasing" — opens a popup of edit-preservation
    // constraints; ticked ones get appended to the active Area Prompt.
    const smartBtn = document.createElement("button");
    smartBtn.type = "button";
    smartBtn.textContent = "Insert Smart Phrasing";
    smartBtn.style.cssText = "align-self:flex-start; font-size:11px; padding:3px 10px; "
        + "border:1px solid #555; border-radius:3px; background:#2a2a2a; color:#bbb; cursor:pointer;";
    smartBtn.title = "Append edit-preservation phrases (keep lighting / pose / clothes / faces the same) to the Area Prompt above.";
    for (const ev of ["pointerdown", "mousedown"]) {
        smartBtn.addEventListener(ev, (e) => e.stopPropagation());
    }
    smartBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showSmartPhrasingPopup(node);
    });

    // Location dropdown (Smart Guided Inpaint only) — sits below the
    // "Area Prompt" heading and above the textarea. Picks the spatial
    // prefix prepended to the prompt at run time.
    const locationSelect = makeDropdown("Location", _Angelo_GUIDED_LOCATIONS, (val) => {
        const w = findWidget(node, "guided_location");
        if (w) setWidget(w, val);
    });
    locationSelect.title = "Where to place the new content. Prepended to your prompt at run time "
        + "(e.g. 'In the top left of the image, ...'). Smart Guided Inpaint only.";
    locationSelect.style.padding = "0";

    // "Generate Guided Edit" run button (Smart Guided Inpaint only) —
    // there's no click/drag to trigger a run in this mode.
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = "Generate Guided Edit";
    runBtn.style.cssText = "align-self:flex-start; font-size:11px; padding:4px 12px; "
        + "border:1px solid #4a7; border-radius:3px; background:rgba(30,120,80,0.95); "
        + "color:#fff; font-weight:bold; cursor:pointer;";
    runBtn.title = "Run the whole-image guided edit using the Location + Area Prompt.";
    for (const ev of ["pointerdown", "mousedown"]) {
        runBtn.addEventListener(ev, (e) => e.stopPropagation());
    }
    runBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        triggerGuidedRefine(node);
    });

    wrap.appendChild(header);
    wrap.appendChild(locationSelect);
    wrap.appendChild(textarea);
    wrap.appendChild(smartBtn);
    wrap.appendChild(runBtn);
    container.appendChild(wrap);

    node._AngeloAreaPromptWrap = wrap;
    node._AngeloAreaPromptTextarea = textarea;
    node._AngeloAreaPromptPosNegBtn = posNegBtn;
    node._AngeloAreaPromptLabel = label;
    node._AngeloSmartPhrasingBtn = smartBtn;
    node._AngeloGuidedLocationSelect = locationSelect;
    node._AngeloGuidedRunBtn = runBtn;

    syncAreaPromptBox(node);
    syncAreaPromptVisibility(node);
}

// Edit-preservation phrases for the Smart Phrasing popup. Adding more
// here automatically adds a checkbox.
const _Angelo_SMART_PHRASES = [
    "Keep the lighting the same",
    "Keep the pose the same",
    "Keep the clothes the same",
    "Keep the faces the same",
];

// Append the chosen phrases to the currently-active Area Prompt textarea
// (positive or negative per the Pos/Neg toggle), comma-joined onto any
// existing text. Skips phrases already present (case-insensitive) so
// re-opening the popup doesn't duplicate them. Persists to the widget.
function appendSmartPhrases(node, phrases) {
    const textarea = node._AngeloAreaPromptTextarea;
    if (!textarea || !phrases.length) return;
    const cur = textarea.value.trim();
    const lower = cur.toLowerCase();
    const fresh = phrases.filter((p) => !lower.includes(p.toLowerCase()));
    if (!fresh.length) return;
    const addition = fresh.join(", ");
    const next = cur ? (cur.replace(/,\s*$/, "") + ", " + addition) : addition;
    textarea.value = next;
    const wname = node._AngeloAreaPromptTarget === "negative"
        ? "area_text_negative" : "area_text_positive";
    const w = findWidget(node, wname);
    if (w) setWidget(w, next);
}

function showSmartPhrasingPopup(node) {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); "
        + "display:flex; align-items:center; justify-content:center; z-index:10000; "
        + "font-family:Arial,sans-serif;";

    const modal = document.createElement("div");
    modal.style.cssText = "background:#2a2a2a; color:#ddd; border:1px solid #555; "
        + "border-radius:8px; padding:16px; width:340px; max-width:90vw; "
        + "display:flex; flex-direction:column; gap:8px;";

    const header = document.createElement("div");
    header.textContent = "Insert Smart Phrasing";
    header.style.cssText = "font-size:14px; font-weight:bold; color:#aaa;";
    modal.appendChild(header);

    const hint = document.createElement("div");
    hint.textContent = "Tick the constraints to add to the Area Prompt.";
    hint.style.cssText = "font-size:11px; color:#888; margin-bottom:4px;";
    modal.appendChild(hint);

    const checks = [];
    for (const phrase of _Angelo_SMART_PHRASES) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex; align-items:center; gap:8px; font-size:13px; "
            + "cursor:pointer; padding:3px 2px;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        const span = document.createElement("span");
        span.textContent = phrase;
        row.appendChild(cb);
        row.appendChild(span);
        modal.appendChild(row);
        checks.push({ cb, phrase });
    }

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; margin-top:8px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "background:#444; color:#ddd; border:none; padding:6px 14px; "
        + "border-radius:4px; cursor:pointer;";

    const insertBtn = document.createElement("button");
    insertBtn.textContent = "Insert";
    insertBtn.style.cssText = "background:rgba(30,120,80,0.95); color:#fff; border:none; "
        + "padding:6px 14px; border-radius:4px; cursor:pointer;";

    footer.appendChild(cancelBtn);
    footer.appendChild(insertBtn);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); };
    insertBtn.addEventListener("click", () => {
        const chosen = checks.filter((c) => c.cb.checked).map((c) => c.phrase);
        appendSmartPhrases(node, chosen);
        close();
    });
    cancelBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", function onKey(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
}

// Reflect the current edit-target widget value into the textarea and
// update the Pos/Neg button styling. Called on creation, on toggle,
// and from the full toolbar sync (workflow load).
function syncAreaPromptBox(node) {
    const textarea = node._AngeloAreaPromptTextarea;
    const btn = node._AngeloAreaPromptPosNegBtn;
    if (!textarea || !btn) return;
    const onNeg = node._AngeloAreaPromptTarget === "negative";
    const wname = onNeg ? "area_text_negative" : "area_text_positive";
    const w = findWidget(node, wname);
    const val = w ? String(w.value ?? "") : "";
    if (textarea.value !== val) textarea.value = val;
    btn.textContent = onNeg ? "Negative" : "Positive";
    btn.style.background = onNeg ? "rgba(140, 60, 60, 0.95)" : "rgba(30, 120, 80, 0.95)";
}

// Show the Area Prompt box only when Area Prompt is effectively ON —
// either the area_prompt widget is true, or Smart Inpaint mode forces
// it on. Hiding is display:none only; the text lives in the
// area_text_* widgets and is reloaded by syncAreaPromptBox, so toggling
// visibility never loses what was typed.
function syncAreaPromptVisibility(node) {
    const guided = isSmartGuidedInpaintMode(node);
    const anySmart = isSmartInpaintMode(node) || guided;

    // Smart Phrasing button: both smart modes (both use reference-image
    // conditioning, so the "keep X the same" constraints apply).
    if (node._AngeloSmartPhrasingBtn) {
        node._AngeloSmartPhrasingBtn.style.display = anySmart ? "block" : "none";
    }
    // Location dropdown + Generate button: Smart Guided Inpaint only.
    if (node._AngeloGuidedLocationSelect) {
        node._AngeloGuidedLocationSelect.style.display = guided ? "inline-flex" : "none";
    }
    if (node._AngeloGuidedRunBtn) {
        node._AngeloGuidedRunBtn.style.display = guided ? "block" : "none";
    }

    const wrap = node._AngeloAreaPromptWrap;
    if (!wrap) return;
    const w = findWidget(node, "area_prompt");
    const on = (w && !!w.value) || anySmart;
    const next = on ? "flex" : "none";
    if (wrap.style.display === next) return;  // no change → no reflow
    wrap.style.display = next;
    // The container's height just changed — nudge LiteGraph to recompute
    // the node's reserved space for the DOM widget so the box isn't clipped.
    if (node.graph && node.graph.setDirtyCanvas) node.graph.setDirtyCanvas(true, true);
}

function loadIntoCanvas(node, url) {
    if (!node._AngeloCanvas) {
        attachPreviewCanvas(node);
    }
    const canvas = node._AngeloCanvas;
    const placeholder = node._AngeloPlaceholder;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        node._AngeloImg = img;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        if (placeholder) placeholder.style.display = "none";

        // Tell Python the actual image dimensions so it can derive the
        // correct pixel→latent scale per-axis (FLUX 2 is 16×, FLUX 1
        // / SDXL are 8×; we don't want to hardcode either).
        const wi = findWidget(node, "image_w");
        const hi = findWidget(node, "image_h");
        if (wi) setWidget(wi, img.naturalWidth);
        if (hi) setWidget(hi, img.naturalHeight);

        // Re-fit the canvas display size to the new image's aspect ratio.
        fitCanvasDisplaySize(node);

        // Force a node redraw so LiteGraph re-computes the canvas widget size.
        if (node.graph && node.graph.setDirtyCanvas) {
            node.graph.setDirtyCanvas(true, false);
        }
        dbg("image drawn", { w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = (e) => {
        dbg("image load error", e, url);
    };
    img.src = url;
}

/**
 * Redraw the canvas with the underlying image + any active overlays
 * (hover ring, paint stroke). Called on every mousemove + on demand
 * from the paint handlers. Cheap: ~1 image blit + a few arcs per frame.
 */
function redrawCanvasWithOverlays(node) {
    const canvas = node._AngeloCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (node._AngeloImg) {
        ctx.drawImage(node._AngeloImg, 0, 0);
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Cursor changes by mode — only remaining visual indicator now
    // that the corner pills are gone.
    if (canvas) {
        if (isSmartGuidedInpaintMode(node)) {
            canvas.style.cursor = "default";  // no canvas interaction
        } else if (isSmartInpaintMode(node)) {
            canvas.style.cursor = "crosshair";
        } else {
            canvas.style.cursor = isPaintModeOn(node) ? "cell" : "crosshair";
        }
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;

    const radiusWidget = findWidget(node, "click_radius");
    const radiusPixel = radiusWidget ? radiusWidget.value : 96;

    // 1. Paint stroke (if actively painting) — draw the union of brush
    //    circles so far at 50% opacity (the user wanted it visibly
    //    blue without fully occluding the underlying image).
    if (node._AngeloPainting && node._AngeloStroke?.length) {
        ctx.save();
        ctx.fillStyle = "rgba(80, 180, 255, 0.5)";
        for (const [px, py] of node._AngeloStroke) {
            ctx.beginPath();
            ctx.arc(px, py, radiusPixel, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // 1b. Smart Inpaint live rectangle while the user is dragging.
    if (node._AngeloDraggingRect) {
        const r = node._AngeloDraggingRect;
        const x = Math.min(r.x1, r.x2);
        const y = Math.min(r.y1, r.y2);
        const w = Math.abs(r.x2 - r.x1);
        const h = Math.abs(r.y2 - r.y1);
        ctx.save();
        ctx.fillStyle = "rgba(80, 180, 255, 0.35)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(80, 180, 255, 1.0)";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    // 2. Hover ring at cursor position (skip during active paint or
    //    rect drag — those have their own active visuals; skip in
    //    Smart Inpaint mode entirely since the click_radius circle
    //    is irrelevant to a rectangle workflow).
    if (node._AngeloHover
        && !node._AngeloPainting
        && !node._AngeloDraggingRect
        && !isSmartInpaintMode(node)) {
        const px = node._AngeloHover.x * scaleX;
        const py = node._AngeloHover.y * scaleY;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 200, 80, 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, radiusPixel, 0, Math.PI * 2);
        ctx.stroke();
        // Tiny cross-hair at the centre
        ctx.strokeStyle = "rgba(255, 200, 80, 0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
        ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
        ctx.stroke();
        ctx.restore();
    }
}

function flashClickOverlay(node, cx, cy) {
    // Draw a fading ring on the canvas at the click point.
    // We don't have the click_radius -> pixel scaling on hand here cheaply;
    // just draw a 24px ring as visual feedback that the click registered.
    const canvas = node._AngeloCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    // Scale the click point from display coords to canvas coords (canvas
    // is at natural image size; display is css-scaled).
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = cx * scaleX;
    const py = cy * scaleY;

    const radiusWidget = findWidget(node, "click_radius");
    const radiusPixel = radiusWidget ? radiusWidget.value : 96;

    let t0 = performance.now();
    const tick = (t) => {
        const elapsed = t - t0;
        const alpha = Math.max(0, 1 - elapsed / 1500);
        if (alpha <= 0) return;
        // Redraw the underlying image then the ring on top
        if (node._AngeloImg) {
            ctx.drawImage(node._AngeloImg, 0, 0);
        }
        ctx.save();
        ctx.strokeStyle = `rgba(255, 200, 80, ${alpha})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(px, py, radiusPixel, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255, 220, 120, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}


// ============================================================
// Refine trigger — update hidden widgets + queue
// ============================================================

function triggerRefine(node, pixelX, pixelY, displayCX, displayCY) {
    const wx = findWidget(node, "click_x");
    const wy = findWidget(node, "click_y");
    const ws = findWidget(node, "click_seq");
    const wr = findWidget(node, "reset");
    const wsp = findWidget(node, "stroke_points");
    if (!wx || !wy || !ws) {
        dbg("ERROR: hidden widgets not found", { wx: !!wx, wy: !!wy, ws: !!ws });
        return;
    }

    setWidget(wx, pixelX);
    setWidget(wy, pixelY);
    setWidget(ws, ((ws.value || 0) + 1) & 0x7FFFFFFF);
    if (wr) setWidget(wr, false);
    // Clear stroke_points so a leftover paint stroke from earlier
    // doesn't bleed into a single-click refine.
    if (wsp) setWidget(wsp, "");

    dbg("queueing workflow (click)", { click_x: wx.value, click_y: wy.value, click_seq: ws.value });
    queuePrompt();
}

function triggerPaintRefine(node, strokePoints) {
    const wsp = findWidget(node, "stroke_points");
    const ws = findWidget(node, "click_seq");
    const wx = findWidget(node, "click_x");
    const wy = findWidget(node, "click_y");
    const wr = findWidget(node, "reset");
    if (!wsp || !ws) {
        dbg("ERROR: stroke widgets not found", { wsp: !!wsp, ws: !!ws });
        return;
    }

    // Round to ints to keep the JSON tight. Sub-pixel precision is
    // wasted — Python rasterises into latent space anyway.
    const compact = strokePoints.map(([x, y]) => [Math.round(x), Math.round(y)]);
    setWidget(wsp, JSON.stringify(compact));
    setWidget(ws, ((ws.value || 0) + 1) & 0x7FFFFFFF);
    // Also set click_x/y to the first stroke point as a fallback target,
    // in case anything downstream reads them.
    if (wx) setWidget(wx, compact[0][0]);
    if (wy) setWidget(wy, compact[0][1]);
    if (wr) setWidget(wr, false);

    dbg("queueing workflow (paint)", { points: compact.length, click_seq: ws.value });
    queuePrompt();
}

function queuePrompt() {
    if (typeof app.queuePrompt === "function") {
        const ret = app.queuePrompt(0);
        if (ret && typeof ret.then === "function") {
            ret.catch(e => dbg("queuePrompt promise rejected", e));
        }
    } else {
        dbg("ERROR: app.queuePrompt is not a function");
    }
}

function isPaintModeOn(node) {
    const w = findWidget(node, "paint_mode");
    if (!w) {
        dbg("isPaintModeOn: paint_mode widget NOT FOUND on node — widget list:",
            (node.widgets || []).map(x => x.name));
        return false;
    }
    const v = w.value;
    // Coerce defensively — different ComfyUI versions may store BOOLEAN
    // widgets as actual booleans, the strings "true"/"false", or 0/1.
    const on = (v === true || v === 1 || v === "true" || v === "True" || v === "1");
    return on;
}

function isSmartInpaintMode(node) {
    const w = findWidget(node, "inpainting_mode");
    if (!w) return false;
    return w.value === "Smart Inpaint";
}

function isSmartGuidedInpaintMode(node) {
    const w = findWidget(node, "inpainting_mode");
    if (!w) return false;
    return w.value === "Smart Guided Inpaint";
}

// Either edit-model mode (both inject reference_latents).
function isAnySmartMode(node) {
    return isSmartInpaintMode(node) || isSmartGuidedInpaintMode(node);
}

// Smart Guided Inpaint location labels — MUST match the Python
// _GUIDED_LOCATION_PREFIXES keys exactly (Python owns the label→prefix
// mapping; JS only stores the chosen label).
const _Angelo_GUIDED_LOCATIONS = [
    "(none)", "Whole image",
    "Top left", "Top middle", "Top right",
    "Middle left", "Center", "Middle right",
    "Bottom left", "Bottom middle", "Bottom right",
    "Left edge", "Right edge", "Top edge", "Bottom edge",
    "Top half", "Bottom half", "Left half", "Right half",
    "Top of the image", "Bottom of the image",
];

// Smart Guided Inpaint has no click/drag — this fires the backend's
// new_click gate so the whole-image guided edit runs. Sets a valid
// (image-centre) click point, bumps click_seq, clears any stale
// stroke/rect, and queues.
function triggerGuidedRefine(node) {
    const ws = findWidget(node, "click_seq");
    if (!ws) return;
    const wx = findWidget(node, "click_x");
    const wy = findWidget(node, "click_y");
    const wr = findWidget(node, "reset");
    const wsp = findWidget(node, "stroke_points");
    const wrp = findWidget(node, "rect_points");
    const img = node._AngeloImg;
    const cx = img && img.naturalWidth ? Math.round(img.naturalWidth / 2) : 0;
    const cy = img && img.naturalHeight ? Math.round(img.naturalHeight / 2) : 0;
    if (wx) setWidget(wx, cx);
    if (wy) setWidget(wy, cy);
    setWidget(ws, ((ws.value || 0) + 1) & 0x7FFFFFFF);
    if (wr) setWidget(wr, false);
    if (wsp) setWidget(wsp, "");
    if (wrp) setWidget(wrp, "");
    dbg("queueing workflow (smart guided edit)", { click_seq: ws.value });
    queuePrompt();
}

function triggerRectRefine(node, rect) {
    const wrp = findWidget(node, "rect_points");
    const ws = findWidget(node, "click_seq");
    const wx = findWidget(node, "click_x");
    const wy = findWidget(node, "click_y");
    const wr = findWidget(node, "reset");
    const wsp = findWidget(node, "stroke_points");
    if (!wrp || !ws) {
        dbg("ERROR: rect widgets not found", { wrp: !!wrp, ws: !!ws });
        return;
    }

    // Round to ints; the backend rasterises into latent space anyway.
    const [x1, y1, x2, y2] = rect.map(v => Math.round(v));
    setWidget(wrp, JSON.stringify([[x1, y1, x2, y2]]));
    setWidget(ws, ((ws.value || 0) + 1) & 0x7FFFFFFF);
    // Stash a fallback target at the rect centre (some downstream UI
    // reads click_x/y).
    if (wx) setWidget(wx, Math.round((x1 + x2) / 2));
    if (wy) setWidget(wy, Math.round((y1 + y2) / 2));
    if (wr) setWidget(wr, false);
    // Clear stroke_points so a previous paint stroke can't fall through.
    if (wsp) setWidget(wsp, "");

    dbg("queueing workflow (smart inpaint rect)", { x1, y1, x2, y2, click_seq: ws.value });
    queuePrompt();
}


// ============================================================
// Reset button (canvas-rendered on the title bar)
// ============================================================

// (Title-bar button rect/draw helpers removed when Reset/Undo moved to
// the DOM toggle bar. Earlier versions had resetButtonRect /
// undoButtonRect / drawTitleButton / hitRect / roundedRect here; see
// git history if we ever want canvas-rendered buttons again.)

function triggerUndo(node) {
    const wu = findWidget(node, "undo_seq");
    if (!wu) return;
    setWidget(wu, ((wu.value || 0) + 1) & 0x7FFFFFFF);
    dbg("queue undo", { undo_seq: wu.value });
    if (typeof app.queuePrompt === "function") app.queuePrompt(0);
}

function triggerReset(node) {
    const wr = findWidget(node, "reset");
    const ws = findWidget(node, "click_seq");
    const wx = findWidget(node, "click_x");
    const wy = findWidget(node, "click_y");
    if (!wr) return;
    wr.value = true;
    if (wx) wx.value = -1;
    if (wy) wy.value = -1;
    if (ws) ws.value = ((ws.value || 0) + 1) & 0x7FFFFFFF;
    node._AngeloImg = null;
    if (node._AngeloCanvas) {
        const ctx = node._AngeloCanvas.getContext("2d");
        ctx.clearRect(0, 0, node._AngeloCanvas.width, node._AngeloCanvas.height);
    }
    if (node._AngeloPlaceholder) node._AngeloPlaceholder.style.display = "flex";
    app.graph.setDirtyCanvas(true, true);
    if (typeof app.queuePrompt === "function") app.queuePrompt(0);
    setTimeout(() => {
        if (wr.value === true) {
            wr.value = false;
            app.graph.setDirtyCanvas(true, true);
        }
    }, 1000);
}


// ============================================================
// Helpers
// ============================================================

function findWidget(node, name) {
    if (!node.widgets) return null;
    return node.widgets.find(w => w.name === name);
}

/**
 * Build a momentary action button (Reset, Undo). Click → onClick().
 * `kind` selects a colour theme so different actions are visually
 * distinct in the bar.
 */
function makeActionButton(label, onClick, kind = "neutral") {
    const themes = {
        reset:   { fg: "#ffe0d0", bg: "rgba(70, 50, 50, 0.95)",  border: "rgba(220, 140, 100, 0.9)" },
        undo:    { fg: "#dde7ff", bg: "rgba(50, 60, 70, 0.95)",  border: "rgba(120, 170, 220, 0.9)" },
        neutral: { fg: "#ccc",    bg: "#2a2a2a",                  border: "#555" },
    };
    const th = themes[kind] || themes.neutral;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cursor = "pointer";
    btn.style.padding = "3px 10px";
    btn.style.fontSize = "11px";
    btn.style.fontWeight = "bold";
    btn.style.border = `1px solid ${th.border}`;
    btn.style.borderRadius = "3px";
    btn.style.background = th.bg;
    btn.style.color = th.fg;
    btn.style.userSelect = "none";
    btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return btn;
}

/** Thin vertical separator for the toggle bar. */
function makeSeparator() {
    const sep = document.createElement("div");
    sep.style.width = "1px";
    sep.style.alignSelf = "stretch";
    sep.style.background = "#444";
    sep.style.margin = "0 4px";
    return sep;
}

/** A horizontal row of controls inside the toolbar wrapper. */
function makeToolbarRow() {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "row";
    row.style.flexWrap = "wrap";
    row.style.alignItems = "center";
    row.style.gap = "4px";
    row.style.padding = "4px 6px";
    return row;
}

/**
 * Build a click-to-toggle button. Returns the DOM element; the caller
 * is responsible for syncing its visual state to whatever underlying
 * widget value it's bound to (call syncPersistentMaskToggle / similar on
 * the relevant node after the widget value changes).
 */
function makeToggleButton(label, onToggle) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label + ": OFF";
    btn.dataset.state = "off";
    btn.style.cursor = "pointer";
    btn.style.padding = "3px 10px";
    btn.style.fontSize = "11px";
    btn.style.fontWeight = "bold";
    btn.style.border = "1px solid #555";
    btn.style.borderRadius = "3px";
    btn.style.background = "#2a2a2a";
    btn.style.color = "#bbb";
    btn.style.userSelect = "none";
    btn._AngeloLabel = label;
    btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
    });
    return btn;
}

// --- Sync helpers: keep DOM toolbar controls in lockstep with the
//     underlying widget values. Called once on node creation (so persisted
//     widget state reflects in the UI) and after every toggle click.

function _syncToggle(btn, widgetValue, onColor) {
    if (!btn) return;
    const on = !!widgetValue;
    btn.textContent = btn._AngeloLabel + (on ? ": ON" : ": OFF");
    btn.dataset.state = on ? "on" : "off";
    btn.style.background = on ? onColor.bg : "#2a2a2a";
    btn.style.color = on ? "#fff" : "#bbb";
    btn.style.borderColor = on ? onColor.border : "#555";
}

const _TOGGLE_ON_COLORS = {
    blue:   { bg: "rgba(20, 80, 140, 0.95)",  border: "rgba(120, 170, 220, 0.9)" },
    green:  { bg: "rgba(30, 120, 80, 0.95)",  border: "rgba(140, 220, 170, 0.9)" },
    purple: { bg: "rgba(95, 50, 130, 0.95)",  border: "rgba(180, 140, 220, 0.9)" },
    teal:   { bg: "rgba(30, 110, 130, 0.95)", border: "rgba(140, 200, 220, 0.9)" },
};

function syncPersistentMaskToggle(node) {
    // Backend forces persistent_mask OFF in Smart Guided Inpaint (no
    // mask to persist) — reflect that as OFF rather than the stale
    // widget value.
    const effective = isSmartGuidedInpaintMode(node)
        ? false
        : findWidget(node, "persistent_mask")?.value;
    _syncToggle(node._AngeloPersistentMaskToggle, effective, _TOGGLE_ON_COLORS.blue);
}

function syncAreaPromptToggle(node) {
    // Backend forces area_prompt=True in Smart Inpaint regardless of
    // widget state — reflect that in the displayed toggle so it reads
    // ON instead of misleadingly showing the underlying widget value.
    const effective = isSmartInpaintMode(node)
        ? true
        : findWidget(node, "area_prompt")?.value;
    _syncToggle(node._AngeloAreaPromptToggle, effective, _TOGGLE_ON_COLORS.purple);
}

function syncPaintModeToggle(node) {
    _syncToggle(node._AngeloPaintModeToggle, findWidget(node, "paint_mode")?.value, _TOGGLE_ON_COLORS.teal);
}

function syncFineUpscaleToggle(node) {
    // Backend forces fine_upscaling ON in Smart Inpaint and OFF in
    // Smart Guided Inpaint regardless of widget state — reflect that in
    // the displayed toggle rather than the (stale) underlying value.
    let effective;
    if (isSmartInpaintMode(node)) effective = true;
    else if (isSmartGuidedInpaintMode(node)) effective = false;
    else effective = findWidget(node, "fine_upscaling")?.value;
    _syncToggle(node._AngeloFineUpscaleToggle, effective, _TOGGLE_ON_COLORS.green);
}

// Smart Inpaint mode hard-locks several params on the backend
// regardless of widget state:
//   denoise=1.0, fine_upscaling=ON, fine_context_pad=0, area_prompt=ON
// Dim the corresponding UI controls + paint_mode + click_radius so
// the user can see at a glance that they're not driving anything.
// Feather is NOT locked — a soft edge can help blend the insert, so
// it stays under user control.
const _Angelo_LOCK_SUFFIX = "\n\n[Locked in this Inpaint mode.]";
function _dimControls(node, ids, dim) {
    for (const id of ids) {
        const el = node[id];
        if (!el) continue;
        el.style.opacity = dim ? "0.35" : "";
        el.style.pointerEvents = dim ? "none" : "";
        if (dim) {
            el.title = (el.title?.split("\n\n[")[0] || el.title || "") + _Angelo_LOCK_SUFFIX;
        } else if (el.title && el.title.includes(_Angelo_LOCK_SUFFIX.trim())) {
            el.title = el.title.split(_Angelo_LOCK_SUFFIX)[0];
        }
    }
}

function syncSmartInpaintLockedWidgets(node) {
    const guided = isSmartGuidedInpaintMode(node);
    const anySmart = isSmartInpaintMode(node) || guided;

    // Common locks for BOTH smart modes — backend forces these or they
    // don't apply: denoise, fine_upscale toggle, paint_mode, click
    // radius, area_prompt toggle.
    _dimControls(node, [
        "_AngeloDenoiseInput",
        "_AngeloFineUpscaleToggle",
        "_AngeloPaintModeToggle",
        "_AngeloClickRadiusInput",
        "_AngeloAreaPromptToggle",
    ], anySmart);

    // Feather: live in Smart Inpaint (a soft edge can help blend the
    // insert), disabled in Smart Guided (whole-image edit, no mask edge).
    _dimControls(node, ["_AngeloFeatherInput"], guided);

    // Persistent Mask: meaningless in Smart Guided (no mask). Dimmed +
    // forced OFF there; left alone in Smart Inpaint (re-rolls the rect).
    _dimControls(node, ["_AngeloPersistentMaskToggle"], guided);

    // Fine Upscale + Area Prompt toggles' displayed state is forced by
    // the backend (ON for Smart Inpaint; Fine Upscale OFF for Smart
    // Guided; Area Prompt ON for both). Re-run their sync so the labels
    // reflect the forced state, and refresh the Area Prompt box + guided
    // controls visibility.
    syncFineUpscaleToggle(node);
    syncAreaPromptToggle(node);
    syncPersistentMaskToggle(node);
    syncAreaPromptVisibility(node);
}

function _syncNumberInput(wrap, widgetValue) {
    if (!wrap || !wrap._AngeloInput || widgetValue == null) return;
    if (wrap._AngeloInput.value !== String(widgetValue)) {
        wrap._AngeloInput.value = String(widgetValue);
    }
}

function syncClickRadiusInput(node) {
    _syncNumberInput(node._AngeloClickRadiusInput, findWidget(node, "click_radius")?.value);
}
function syncFeatherInput(node) {
    _syncNumberInput(node._AngeloFeatherInput, findWidget(node, "feather_radius")?.value);
}
function syncDenoiseInput(node) {
    _syncNumberInput(node._AngeloDenoiseInput, findWidget(node, "denoise")?.value);
}
function syncSeedInput(node) {
    _syncNumberInput(node._AngeloSeedInput, findWidget(node, "seed")?.value);
}
function syncSeedCtrlSelect(node) {
    const wrap = node._AngeloSeedCtrlSelect;
    const w = findWidget(node, "seed_control");
    if (!wrap || !w || !wrap._AngeloSelect) return;
    if (wrap._AngeloSelect.value !== String(w.value)) {
        wrap._AngeloSelect.value = String(w.value);
    }
}

/**
 * Mode-state sync: when mode == "Sampler Mode" grey out the toolbar
 * + canvas (controls inert); when "Edit Mode" un-grey. Also
 * auto-forces sampler_seed_control to "fixed" when switching INTO
 * Edit Mode, so subsequent Queue presses don't regenerate the
 * cached base.
 */
function syncModeState(node) {
    const modeW = findWidget(node, "mode");
    if (!modeW) return;
    const inSampler = String(modeW.value) === "Sampler Mode";

    // Row 3 (mode + shared gen config) is ALWAYS active — both modes use
    // steps/cfg/sampler/scheduler, and the Mode dropdown must always work.
    //
    // Refinement control rows (1+2) grey out in Sampler Mode — they don't
    // apply while generating a base.
    const refineRows = node._AngeloRefineRowsWrap;
    if (refineRows) {
        refineRows.style.opacity = inSampler ? "0.4" : "1";
        refineRows.style.pointerEvents = inSampler ? "none" : "auto";
    }
    // Sampler-seed row (4) greys in Edit Mode — that seed group only
    // drives the base generation.
    const samplerSeedRow = node._AngeloSamplerSeedRow;
    if (samplerSeedRow) {
        samplerSeedRow.style.opacity = inSampler ? "1" : "0.4";
        samplerSeedRow.style.pointerEvents = inSampler ? "auto" : "none";
    }
    // Cursor: default in Sampler Mode (clicks do nothing); crosshair
    // in Smart Inpaint (rectangle drag); cell when paint mode is on
    // for Refine; crosshair otherwise.
    if (node._AngeloCanvas) {
        if (inSampler || isSmartGuidedInpaintMode(node)) {
            // Sampler Mode: clicks do nothing. Smart Guided: no canvas
            // interaction (location dropdown + Generate button drive it).
            node._AngeloCanvas.style.cursor = "default";
        } else if (isSmartInpaintMode(node)) {
            node._AngeloCanvas.style.cursor = "crosshair";
        } else {
            node._AngeloCanvas.style.cursor = isPaintModeOn(node) ? "cell" : "crosshair";
        }
    }
}

function syncModeSwitchToFixed(node, prevMode) {
    // Called from the mode widget's callback. If switching INTO Refinement
    // Mode, force sampler_seed_control to "fixed" AND restore sampler_seed
    // to the seed Python actually used for the cached base (which after
    // after-gen control may have drifted from the current widget value).
    const modeW = findWidget(node, "mode");
    if (!modeW) return;
    const nowInRefine = String(modeW.value) === "Edit Mode";
    if (nowInRefine && prevMode === "Sampler Mode") {
        lockSeedToAtRun(node, "sampler_seed", "sampler_seed_control");
        dbg("syncMode: forced sampler_seed_control → fixed + restored sampler_seed");
    }
}

/**
 * Apply after-gen control (fixed / increment / decrement / randomize) to
 * a seed widget. ComfyUI's built-in seed widgets auto-attach this dropdown;
 * ours are explicit ENUM widgets so we do the modification ourselves.
 * Runs AFTER the response is processed so seed_at_run capture happens
 * first (lock-on-fixed restores from the pre-modification value).
 */
function applyAfterGenControl(node, seedWidgetName, controlWidgetName) {
    const seedW = findWidget(node, seedWidgetName);
    const ctrlW = findWidget(node, controlWidgetName);
    if (!seedW || !ctrlW) return;
    const ctrl = String(ctrlW.value);
    const maxSeed = 0xFFFFFFFFFFFFFFFF;
    let cur = Number(seedW.value || 0);
    let next = cur;
    switch (ctrl) {
        case "fixed":     return;  // no change
        case "increment": next = (cur + 1) % (maxSeed + 1); break;
        case "decrement": next = cur > 0 ? cur - 1 : maxSeed; break;
        case "randomize":
            // 53 bits is the safe integer range; that's plenty of seed
            // entropy for any sampler.
            next = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
            break;
        default: return;
    }
    setWidget(seedW, next);
    // Mirror to the matching toolbar input.
    if (seedWidgetName === "seed") {
        syncSeedInput(node);
    } else if (seedWidgetName === "sampler_seed") {
        syncSamplerSeedInput(node);
    }
    dbg("after-gen", seedWidgetName, ctrl, cur, "→", next);
}

/**
 * "Lock seed to the value Python actually used at the last run." Used when
 * a control widget flips to "fixed" — restores the seed widget to what was
 * sent to Python (before ComfyUI's after-gen modified it), then forces the
 * control to "fixed". The "_AngeloSamplerSeedAtRun" / "_AngeloRefineSeedAtRun"
 * fields are captured from the Angelo_*_seed_at_run keys in the ui message
 * each onExecuted.
 */
function lockSeedToAtRun(node, seedWidgetName, controlWidgetName) {
    const seedW = findWidget(node, seedWidgetName);
    const ctrlW = findWidget(node, controlWidgetName);
    if (!seedW || !ctrlW) return;
    const stored = seedWidgetName === "sampler_seed"
        ? node._AngeloSamplerSeedAtRun
        : node._AngeloRefineSeedAtRun;
    // Always set control to fixed.
    if (ctrlW.value !== "fixed") setWidget(ctrlW, "fixed");
    // Restore seed value if we have a known-used value to fall back to.
    if (stored != null) {
        if (Number(seedW.value) !== Number(stored)) {
            setWidget(seedW, Number(stored));
        }
    }
    // Mirror to toolbar.
    if (seedWidgetName === "seed") {
        syncSeedInput(node);
        syncSeedCtrlSelect(node);
    } else if (seedWidgetName === "sampler_seed") {
        syncSamplerSeedInput(node);
        syncSamplerSeedCtrlSelect(node);
    }
}
function syncMpInput(node) {
    _syncNumberInput(node._AngeloMpInput, findWidget(node, "min_megapixels")?.value);
}
function syncMaxInput(node) {
    _syncNumberInput(node._AngeloMaxInput, findWidget(node, "max_upscale")?.value);
}

function syncMethodSelect(node) {
    const wrap = node._AngeloMethodSelect;
    const w = findWidget(node, "resize_method");
    if (!wrap || !w || !wrap._AngeloSelect) return;
    if (wrap._AngeloSelect.value !== String(w.value)) {
        wrap._AngeloSelect.value = String(w.value);
    }
}

// --- Sync helpers for the row 3/4 sampler + generation controls ---
function _syncDropdownWrap(wrap, widgetValue) {
    if (!wrap || !wrap._AngeloSelect || widgetValue == null) return;
    if (wrap._AngeloSelect.value !== String(widgetValue)) {
        wrap._AngeloSelect.value = String(widgetValue);
    }
}
function syncModeSelect(node) {
    _syncDropdownWrap(node._AngeloModeSelect, findWidget(node, "mode")?.value);
}
function syncStepsInput(node) {
    _syncNumberInput(node._AngeloStepsInput, findWidget(node, "steps")?.value);
}
function syncCfgInput(node) {
    _syncNumberInput(node._AngeloCfgInput, findWidget(node, "cfg")?.value);
}
function syncSamplerSelect(node) {
    _syncDropdownWrap(node._AngeloSamplerSelect, findWidget(node, "sampler_name")?.value);
}
function syncSchedulerSelect(node) {
    _syncDropdownWrap(node._AngeloSchedulerSelect, findWidget(node, "scheduler")?.value);
}
function syncSamplerSeedInput(node) {
    _syncNumberInput(node._AngeloSamplerSeedInput, findWidget(node, "sampler_seed")?.value);
}
function syncSamplerSeedCtrlSelect(node) {
    _syncDropdownWrap(node._AngeloSamplerSeedCtrlSelect, findWidget(node, "sampler_seed_control")?.value);
}
function syncSamplerDenoiseInput(node) {
    _syncNumberInput(node._AngeloSamplerDenoiseInput, findWidget(node, "sampler_denoise")?.value);
}
function syncGuidedLocationSelect(node) {
    _syncDropdownWrap(node._AngeloGuidedLocationSelect, findWidget(node, "guided_location")?.value);
}

function syncInpaintModeSelect(node) {
    const wrap = node._AngeloInpaintModeSelect;
    const w = findWidget(node, "inpainting_mode");
    if (!wrap || !w || !wrap._AngeloSelect) return;
    if (wrap._AngeloSelect.value !== String(w.value)) {
        wrap._AngeloSelect.value = String(w.value);
    }
    // Keep the locked-widget UI in sync — the mode value may have
    // changed via a workflow load, undo, or any path other than the
    // dropdown's own click handler.
    syncSmartInpaintLockedWidgets(node);
}

// Reflect ALL persisted widget state into the DOM toolbar controls.
// Call this both on node creation AND on configure (workflow load) —
// onNodeCreated runs BEFORE ComfyUI restores serialized widget values,
// so a sync there alone leaves toggles like Paint Mode showing the
// default instead of the saved value. onConfigure fires after the
// restore, so a second pass there fixes the mismatch.
function syncAllToolbarControls(node) {
    syncPersistentMaskToggle(node);
    syncAreaPromptToggle(node);
    syncPaintModeToggle(node);
    syncFineUpscaleToggle(node);
    syncClickRadiusInput(node);
    syncFeatherInput(node);
    syncDenoiseInput(node);
    syncSeedInput(node);
    syncSeedCtrlSelect(node);
    syncMpInput(node);
    syncMaxInput(node);
    syncMethodSelect(node);
    syncInpaintModeSelect(node);
    // Row 3/4 sampler + generation controls.
    syncModeSelect(node);
    syncStepsInput(node);
    syncCfgInput(node);
    syncSamplerSelect(node);
    syncSchedulerSelect(node);
    syncSamplerSeedInput(node);
    syncSamplerSeedCtrlSelect(node);
    syncSamplerDenoiseInput(node);
    syncGuidedLocationSelect(node);
    syncSmartInpaintLockedWidgets(node);
    syncAreaPromptBox(node);
    syncAreaPromptVisibility(node);
    syncModeState(node);
}

function makeDropdown(label, options, onChange) {
    const wrap = document.createElement("div");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "4px";
    wrap.style.fontSize = "11px";
    wrap.style.color = "#bbb";
    wrap.style.padding = "0 4px";

    const lbl = document.createElement("span");
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const sel = document.createElement("select");
    sel.style.fontSize = "11px";
    sel.style.padding = "2px 4px";
    sel.style.border = "1px solid #555";
    sel.style.borderRadius = "3px";
    sel.style.background = "#1a1a1a";
    sel.style.color = "#ddd";
    for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    sel.addEventListener("mousedown", (e) => e.stopPropagation());
    sel.addEventListener("pointerdown", (e) => e.stopPropagation());
    wrap.appendChild(sel);
    wrap._AngeloSelect = sel;
    return wrap;
}

/**
 * Small inline numeric input with a label. width is the input width in
 * pixels (label adds ~20px). Calls onChange(numericValue) when committed.
 */
function makeNumberInput(label, opts, onChange) {
    const wrap = document.createElement("div");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "4px";
    wrap.style.fontSize = "11px";
    wrap.style.color = "#bbb";
    wrap.style.padding = "0 4px";

    const lbl = document.createElement("span");
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const input = document.createElement("input");
    input.type = "number";
    input.min = String(opts.min ?? 0);
    input.max = String(opts.max ?? 100);
    input.step = String(opts.step ?? 1);
    input.style.width = (opts.width || 60) + "px";
    input.style.padding = "2px 4px";
    input.style.fontSize = "11px";
    input.style.border = "1px solid #555";
    input.style.borderRadius = "3px";
    input.style.background = "#1a1a1a";
    input.style.color = "#ddd";
    input.addEventListener("change", () => {
        let v = parseFloat(input.value);
        if (!isFinite(v)) v = opts.min ?? 0;
        const lo = opts.min ?? -Infinity, hi = opts.max ?? Infinity;
        v = Math.max(lo, Math.min(hi, v));
        input.value = String(v);
        onChange(v);
    });
    // Stop click on the input from selecting / dragging the node behind it.
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    wrap.appendChild(input);
    wrap._AngeloInput = input;
    return wrap;
}

function setWidget(widget, value) {
    if (!widget) return;
    widget.value = value;
    // Some ComfyUI versions sync the value-for-serialization through the
    // widget's callback rather than reading widget.value directly. Fire
    // it both with and without graph args to maximise compatibility.
    try {
        if (typeof widget.callback === "function") {
            widget.callback(value, app.canvas, widget.node || null);
        }
    } catch (e) {
        dbg("widget callback threw", widget.name, e);
    }
}

function hideMechanicalWidgets(node) {
    // JS-driven widgets that don't need to clutter the user-visible UI.
    // Skipped while Angelo_DEBUG is on so we can watch them update.
    if (Angelo_DEBUG) return;

    const hideNames = [
        // JS-driven plumbing (never user-visible)
        "click_x", "click_y", "click_seq",
        "image_w", "image_h", "undo_seq",
        "stroke_points", "rect_points",
        // Area Prompt text (driven by the DOM textarea below the canvas)
        "area_text_positive", "area_text_negative",
        // Smart Guided Inpaint location (driven by the DOM dropdown)
        "guided_location",
        // Toolbar-driven (visible via the bar above the canvas)
        "persistent_mask", "area_prompt", "paint_mode", "fine_upscaling",
        "click_radius", "feather_radius", "denoise",
        "seed", "seed_control",
        "min_megapixels", "max_upscale", "resize_method", "fine_context_pad",
        "inpainting_mode",
        // Sampler / generation config — now in toolbar rows 3 & 4
        "mode", "sampler_denoise", "sampler_seed", "sampler_seed_control",
        "steps", "cfg", "sampler_name", "scheduler",
        // Deprecated control — always-on, kept declared for serialization
        "auto_decode",
        // Driven by the Reset button on the toolbar — no need to see the widget too
        "reset",
    ];
    if (!node.widgets) return;
    for (const w of node.widgets) {
        // Hide explicit-name matches PLUS any ComfyUI-auto-added
        // "control_after_generate" dropdowns that may have been
        // attached to seed widgets (legacy auto-attach for widgets
        // literally named "seed"). The Python widgets opt out via
        // `"control_after_generate": False`, but some ComfyUI versions
        // ignore that opt-out, so this pattern-match catches the
        // orphaned dropdowns either way.
        const isAutoControl = typeof w.name === "string"
            && /control_after_generate/i.test(w.name);
        if (!hideNames.includes(w.name) && !isAutoControl) continue;
        // The "type = hidden" trick alone isn't enough — some renderers
        // still reserve the widget's natural height. Belt + suspenders:
        // use ComfyUI's own "converted-widget" type (which the frontend
        // explicitly skips), set hidden=true (newer LiteGraph respects
        // it), zero-out computeSize (-4 cancels the 4px inter-widget
        // gap), and null the draw function so nothing paints even if a
        // renderer iterates over hidden widgets.
        w.type = "converted-widget";
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.draw = () => {};
    }
}

function makeViewUrl(ref) {
    const params = new URLSearchParams();
    params.set("filename", ref.filename);
    if (ref.subfolder) params.set("subfolder", ref.subfolder);
    if (ref.type) params.set("type", ref.type);
    return `/view?${params.toString()}`;
}
