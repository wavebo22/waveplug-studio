@echo off
chcp 65001 >nul
rem WavePlug one-click update: helper (when its source changed), plugin + Illustrator panel build,
rem Illustrator panel install (when missing). Open panels load the new build by themselves.
rem See scripts/update.mjs. No full-width punctuation in echo lines here.
cd /d "%~dp0"
where node >nul 2>nul || (echo 没找到 node, 请先安装 Node.js & pause & exit /b 1)
node scripts\update.mjs
pause
