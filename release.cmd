@echo off
rem WavePlug release: builds everything and packs the installer into releases.
rem ASCII only: the steps are in scripts\release.mjs (log: reports\release.log).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org and try again. & pause & exit /b 1)
node scripts\release.mjs
set "CODE=%ERRORLEVEL%"
if /i not "%~1"=="nopause" pause
exit /b %CODE%
