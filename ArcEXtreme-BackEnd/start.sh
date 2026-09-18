#!/bin/bash
# ArcEXtreme Backend one-click launcher for macOS / Linux.
# Windows 不受影响：继续用 start.bat，本文件仅供 sh 使用。
# 前提假设：系统已装好 Python 3.13（brew install python@3.13 libomp），脚本内只做检查不自动装 Python。
cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
export ARCEXTREME_COLOR=0

HOST="${ARCEXTREME_HOST:-0.0.0.0}"
PORT="${ARCEXTREME_PORT:-9001}"

echo "Starting ArcEXtreme Backend on port ${PORT} ..."

if ! command -v python3 >/dev/null 2>&1; then
  echo "[Error] 未找到 python3，请先安装 Python 3.13：brew install python@3.13 libomp" >&2
  exit 1
fi

if ! python3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"; then
  echo "[Error] Python 版本过低（需 3.10+，推荐 3.13）：$(python3 --version 2>&1)" >&2
  exit 1
fi

python3 -m pip install -r requirements.txt || {
  echo "[Error] 依赖安装失败，请检查网络后重试：python3 -m pip install -r requirements.txt" >&2
  exit 1
}

echo ""
echo "=== Backend log will also be written to backend.log ==="
echo "If the terminal closes, run: python3 server.py"
echo ""

python3 -m uvicorn server:app --host "$HOST" --port "$PORT" --log-level info --no-use-colors || {
  echo ""
  echo "[Warn] 带 --no-use-colors 启动失败，尝试不带该参数重试 ..."
  python3 -m uvicorn server:app --host "$HOST" --port "$PORT" --log-level info
}
