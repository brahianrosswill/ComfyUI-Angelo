#!/usr/bin/env bash
# Angelo — install the OPTIONAL SAM 3 "Detect" feature (macOS / Linux).
#
# Angelo's core needs no extra dependencies; this is only for the SAM 3
# text-segmentation Detect button. It tries to find your ComfyUI Python
# automatically (a venv beside ComfyUI). If it picks the wrong one, set
# PYTHON yourself, e.g.:
#     PYTHON=/path/to/ComfyUI/venv/bin/python bash install_sam3_support.sh
set -e
cd "$(dirname "$0")"

# Pick a Python: PYTHON env var, then the interpreter ComfyUI recorded on
# its last start (.comfy_python.txt — reliable for any launcher), then a
# venv beside ComfyUI (../../), then `python` on PATH as a last resort.
PY="${PYTHON:-}"
if [ -z "$PY" ] && [ -f ".comfy_python.txt" ]; then PY="$(cat .comfy_python.txt)"; fi
if [ -z "$PY" ] && [ -x "../../venv/bin/python" ]; then PY="../../venv/bin/python"; fi
if [ -z "$PY" ] && [ -x "../../.venv/bin/python" ]; then PY="../../.venv/bin/python"; fi
if [ -z "$PY" ]; then PY="python"; fi
if [ ! -f ".comfy_python.txt" ]; then
  echo "NOTE: start ComfyUI once so Angelo can record its Python, for the most reliable install."
fi

echo "Angelo SAM 3 installer — using Python: $PY"
"$PY" --version || { echo "Python not found. Set PYTHON to your ComfyUI python and retry."; exit 1; }

if "$PY" -c "import sam3" >/dev/null 2>&1; then
  echo "SAM 3 is already installed in this environment — nothing to do."
  echo "Restart ComfyUI and use the Detect button in Angelo."
  exit 0
fi

echo "Installing SAM 3 runtime dependencies..."
"$PY" -m pip install -r sam3_requirements.txt

if [ ! -d sam3 ]; then
  echo "Cloning SAM 3 from GitHub..."
  git clone https://github.com/facebookresearch/sam3.git sam3 || {
    echo "git clone failed — is git installed?"; exit 1; }
else
  echo "sam3/ already present — skipping clone."
fi

echo "Installing SAM 3 (editable, no deps)..."
"$PY" -m pip install -e sam3 --no-deps

echo ""
echo "Done. Restart ComfyUI, then use the Detect button in Angelo."
echo "(The SAM 3 weights, sam3.pt, download automatically on first Detect.)"
