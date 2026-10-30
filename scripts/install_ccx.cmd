@echo off
rem Installs the newest WavePlug Studio .ccx with Adobe UPIA.
rem Double-click this file yourself (normal desktop session, not elevated) with Photoshop closed.
chcp 65001 >nul
setlocal
set "UPIA=J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "ROOT=%~dp0.."
set "LOG=%ROOT%\reports\install_%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%RANDOM%.log"
set "CCX="
for /f "delims=" %%f in ('dir /b /o:n "%ROOT%\releases\WavePlug_Studio_*_local.ccx"') do set "CCX=%ROOT%\releases\%%f"

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
