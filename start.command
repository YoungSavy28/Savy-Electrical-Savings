#!/usr/bin/env bash
# Mac: double-click this file. Linux: ./start.command
cd "$(dirname "$0")" || exit 1
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || { echo "Python is not installed. Get it from https://www.python.org/downloads/"; read -r -p "Press Enter to close"; exit 1; }

# only install if something is missing
if ! "$PY" -c "import flask, cv2, numpy, PIL, requests" >/dev/null 2>&1; then
  echo "Installing needed packages, one time only..."
  "$PY" -m pip install --only-binary=:all: flask opencv-python-headless numpy pillow requests \
    || "$PY" -m pip install --only-binary=:all: --user flask opencv-python-headless numpy pillow requests \
    || "$PY" -m pip install --only-binary=:all: --break-system-packages flask opencv-python-headless numpy pillow requests \
    || { echo; echo "Install failed. Copy the message above and send it to me."; read -r -p "Press Enter to close"; exit 1; }
fi
# optional extras: PDF upload and OCR. Failure here is fine.
"$PY" -c "import pypdfium2" >/dev/null 2>&1 || "$PY" -m pip install --only-binary=:all: pypdfium2 >/dev/null 2>&1
"$PY" -c "import pytesseract" >/dev/null 2>&1 || "$PY" -m pip install --only-binary=:all: pytesseract >/dev/null 2>&1

export TAKEOFF_OPEN=1
"$PY" backend/app.py
