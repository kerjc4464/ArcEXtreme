@echo off
cd /d "%~dp0"
chcp 65001 >nul 2>&1
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set ARCEXTREME_COLOR=0
echo Starting ArcEXtreme Backend on port 9001 ...
python -m pip install -r requirements.txt
echo.
echo === Backend log will also be written to backend.log ===
echo If window flashes, open backend.log or run: python server.py
echo.
python -m uvicorn server:app --host 0.0.0.0 --port 9001 --log-level info --no-use-colors
if errorlevel 1 (
    echo.
    echo [Error] Backend exited with code %errorlevel%. Trying fallback without --no-use-colors ...
    python -m uvicorn server:app --host 0.0.0.0 --port 9001 --log-level info
)
pause
