@echo off
setlocal
cd /d "%~dp0"

rem find Python: "py" launcher first, then "python"
set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" ( where python >nul 2>nul && set PY=python )
if "%PY%"=="" (
  echo Python is not installed. Get it from https://www.python.org/downloads/
  echo During install, tick "Add python.exe to PATH". Then double-click this file again.
  pause & exit /b 1
)

rem only install if something is missing
%PY% -c "import flask, cv2, numpy, PIL, requests" >nul 2>nul
if errorlevel 1 (
  echo Installing needed packages, one time only...
  %PY% -m pip install --only-binary=:all: flask opencv-python-headless numpy pillow requests
  if errorlevel 1 ( echo. & echo Install failed. Copy the message above and send it to me. & pause & exit /b 1 )
)
rem optional extras: PDF upload and OCR. Failure here is fine.
%PY% -c "import pypdfium2" >nul 2>nul || %PY% -m pip install --only-binary=:all: pypdfium2
%PY% -c "import pytesseract" >nul 2>nul || %PY% -m pip install --only-binary=:all: pytesseract

set TAKEOFF_OPEN=1
%PY% backend\app.py
pause
