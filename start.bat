@echo off
setlocal
cd /d "%~dp0"
title 静照 · 本地相册

set PORT=8765
set URL=http://127.0.0.1:%PORT%/index.html

echo.
echo   静照 · 本地相册
echo   ------------------------------------------
echo   本地服务: %URL%
echo   关闭这个窗口即停止服务。
echo.

where python >nul 2>nul
if not errorlevel 1 (
  start "" "%URL%"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :end
)

where py >nul 2>nul
if not errorlevel 1 (
  start "" "%URL%"
  py -m http.server %PORT% --bind 127.0.0.1
  goto :end
)

where node >nul 2>nul
if not errorlevel 1 (
  start "" "%URL%"
  npx --yes http-server -p %PORT% -a 127.0.0.1 -c-1
  goto :end
)

echo   没有找到 Python 或 Node。
echo.
echo   静照用到了 ES 模块、Web Worker 和 IndexedDB，
echo   这些能力在 file:// 下会被浏览器拦掉，所以必须走本地服务。
echo.
echo   随便装一个即可：
echo     Python   https://www.python.org/downloads/
echo     Node.js  https://nodejs.org/
echo.
pause

:end
endlocal
