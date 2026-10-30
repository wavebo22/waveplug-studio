@echo off
rem Removes old WavePlug 0.6.1, OpenLayer and SD-PPP (Photoshop + ComfyUI) and the old F:\waveplug
rem development files. Everything is MOVED to F:\waveplug_uninstalled_<time>, not deleted.
rem Close Photoshop and ComfyUI first, then right-click -> Run as administrator.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_legacy.ps1"
pause
