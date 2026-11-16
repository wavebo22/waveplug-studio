@echo off
chcp 65001 >nul
rem update.cmd calls this with "nopause"
set "PAUSE=pause"
if /i "%~1"=="nopause" set "PAUSE=rem"
rem Builds the WavePlug overlay helper (外置框架). Needs Rust: https://rustup.rs
rem The running helper is NOT stopped: its exe is renamed out of the way (Windows allows that for a
rem running exe) and the new one copied in. The running copy notices within a few seconds and
rem restarts into the new build, keeping the ComfyUI it started (src/life.rs).
cd /d "%~dp0"
where cargo >nul 2>nul || (echo 没找到 cargo：请先安装 Rust（https://rustup.rs），装完重新打开命令行 & %PAUSE% & exit /b 1)
cargo test --release || (echo 测试失败 & %PAUSE% & exit /b 1)
cargo build --release || (echo 编译失败，把上面的错误发给 Claude & %PAUSE% & exit /b 1)
set "NEW=target\release\waveplug-overlay.exe"
for %%D in ("..\..\dist" "..\..\dist\plugin" "..\..\dist\dev") do call :put "%%~D" || (%PAUSE% & exit /b 1)
echo.
echo 完成：dist、dist\plugin、dist\dev 里的 waveplug-overlay.exe 已更新。
rem no full-width brackets / semicolons here: under chcp 65001 cmd split this line and ran half of it
echo 正在运行的外置框架会在几秒内自动换成新版本，ComfyUI 不会被关闭。
echo 外置框架没在运行时，Photoshop 下次启动会自动打开它。
%PAUSE%
exit /b 0

:put
if not exist "%~1" mkdir "%~1"
if exist "%~1\waveplug-overlay.exe" (
  ren "%~1\waveplug-overlay.exe" "waveplug-overlay.old-%RANDOM%%RANDOM%.exe" || (echo 无法替换 %~1\waveplug-overlay.exe & exit /b 1)
)
copy /y "%NEW%" "%~1\waveplug-overlay.exe" >nul || (echo 复制到 %~1 失败 & exit /b 1)
exit /b 0
