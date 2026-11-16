@echo off
rem Installs the most recently built WavePlug Studio .ccx with Adobe UPIA (by file date: 0.1.10 sorts before 0.1.9 by name).
rem Close Photoshop, then right-click this file -> Run as administrator (a non-elevated run returned -432 on mainpc).
chcp 65001 >nul
setlocal
set "UPIA=D:\App\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "ROOT=%~dp0.."
set "LOG=%ROOT%\reports\install_%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%RANDOM%.log"
set "CCX="
rem one plugin for users and development (the old _DEV_ packages are skipped)
for /f "delims=" %%f in ('dir /b /o:d "%ROOT%\releases\WavePlug_Studio_*_local.ccx" ^| findstr /v /i "_DEV_"') do set "CCX=%ROOT%\releases\%%f"

rem UPIA resolves a root-relative Adobe user path against its current drive.
rem Keep the working drive on the user's profile drive, even when run from F:.
cd /d "%USERPROFILE%"
if errorlevel 1 (
  echo Could not switch UPIA working directory to %USERPROFILE%.
  pause
  exit /b 1
)

tasklist /fi "imagename eq Photoshop.exe" | find /i "Photoshop.exe" >nul && (
  echo 请先保存并完全关闭 Photoshop，再运行本脚本。
  pause
  exit /b 1
)

> "%LOG%" (
  echo === environment ===
  whoami
  echo USERPROFILE=%USERPROFILE%
  echo APPDATA=%APPDATA%
  echo LOCALAPPDATA=%LOCALAPPDATA%
  echo TEMP=%TEMP%
  echo HOMEDRIVE=%HOMEDRIVE%
  echo HOMEPATH=%HOMEPATH%
  echo WORKDIR=%CD%
  echo CCX=%CCX%
  echo === install ===
)
"%UPIA%" /install "%CCX%" >> "%LOG%" 2>&1
echo === list ===>> "%LOG%"
"%UPIA%" /list all >> "%LOG%" 2>&1
type "%LOG%"
echo.
echo 结果已保存到 %LOG%
pause
