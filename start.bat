@echo off
setlocal
cd /d "%~dp0"
set PORT=5173

where python >nul 2>nul
if not errorlevel 1 goto :usepython

where py >nul 2>nul
if not errorlevel 1 goto :usepy

where npx >nul 2>nul
if not errorlevel 1 goto :usenpx

goto :fallback

:usepython
echo [server] python -m http.server %PORT%
echo [server] http://localhost:%PORT%/
start "" "http://localhost:%PORT%/"
python -m http.server %PORT%
goto :end

:usepy
echo [server] py -m http.server %PORT%
echo [server] http://localhost:%PORT%/
start "" "http://localhost:%PORT%/"
py -m http.server %PORT%
goto :end

:usenpx
echo [server] npx http-server -p %PORT%
echo [server] http://localhost:%PORT%/
start "" "http://localhost:%PORT%/"
npx -y http-server -p %PORT% -c-1 .
goto :end

:fallback
echo.
echo 未检测到 python / py / npx。
echo 你可以直接双击 index.html 打开（npm 公开接口允许跨域，file:// 下同样可用），
echo 或者安装 Python / Node 后重新运行本脚本。
echo.
pause
goto :end

:end
endlocal
