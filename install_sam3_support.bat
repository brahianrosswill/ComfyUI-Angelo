@echo off
REM Angelo - install the OPTIONAL SAM 3 "Detect" feature (Windows).
REM
REM Angelo's core needs no extra dependencies; this is only for the SAM 3
REM text-segmentation Detect button. It tries to find your ComfyUI Python
REM automatically (portable embedded, or a venv beside ComfyUI). If it
REM picks the wrong one, set PYTHON yourself, e.g.:
REM    set "PYTHON=C:\ComfyUI\python_embeded\python.exe"
REM    install_sam3_support.bat

setlocal
cd /d "%~dp0"

REM Pick a Python in priority order: PYTHON env var, then the interpreter
REM ComfyUI recorded on its last start (.comfy_python.txt - the reliable
REM one for any launcher), then portable embedded / venv beside ComfyUI,
REM then `python` on PATH as a last resort.
set "PY="
if defined PYTHON set "PY=%PYTHON%"
if not defined PY if exist ".comfy_python.txt" set /p PY=<".comfy_python.txt"
if not defined PY if exist "..\..\..\python_embeded\python.exe" set "PY=..\..\..\python_embeded\python.exe"
if not defined PY if exist "..\..\venv\Scripts\python.exe" set "PY=..\..\venv\Scripts\python.exe"
if not defined PY if exist "..\..\.venv\Scripts\python.exe" set "PY=..\..\.venv\Scripts\python.exe"
if not defined PY set "PY=python"
if not exist ".comfy_python.txt" echo NOTE: start ComfyUI once so Angelo can record its Python, for the most reliable install.

echo Angelo SAM 3 installer - using Python: %PY%
"%PY%" --version
if errorlevel 1 (
  echo Python not found. Set PYTHON to your ComfyUI python.exe and retry.
  exit /b 1
)

"%PY%" -c "import sam3" 1>nul 2>nul
if not errorlevel 1 (
  echo SAM 3 is already installed in this environment - nothing to do.
  echo Restart ComfyUI and use the Detect button in Angelo.
  exit /b 0
)

echo Installing SAM 3 runtime dependencies...
"%PY%" -m pip install -r "sam3_requirements.txt"
if errorlevel 1 (
  echo Dependency install failed.
  exit /b 1
)

if not exist "sam3" (
  echo Cloning SAM 3 from GitHub...
  git clone https://github.com/facebookresearch/sam3.git sam3
  if errorlevel 1 (
    echo git clone failed - is git installed and on PATH?
    exit /b 1
  )
) else (
  echo sam3 folder already present - skipping clone.
)

echo Installing SAM 3 ^(editable, no deps^)...
"%PY%" -m pip install -e "sam3" --no-deps
if errorlevel 1 (
  echo SAM 3 install failed.
  exit /b 1
)

echo.
echo Done. Restart ComfyUI, then use the Detect button in Angelo.
echo The SAM 3 weights ^(sam3.pt^) download automatically on first Detect.
endlocal
