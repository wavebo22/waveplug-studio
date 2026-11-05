@echo off
chcp 65001 >nul
rem Opens the external generate panel demo (made-up data, no Photoshop / ComfyUI). Build first with build.cmd.
cd /d "%~dp0"
if not exist ..\..\dist\waveplug-overlay.exe (echo 还没有 dist\waveplug-overlay.exe：先双击 build.cmd & pause & exit /b 1)
start "" "..\..\dist\waveplug-overlay.exe" --demo
