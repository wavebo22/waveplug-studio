@echo off
chcp 65001 >nul
rem update.cmd calls this with "nopause"
set "PAUSE=pause"
if /i "%~1"=="nopause" set "PAUSE=rem"
rem WaveLayer for Illustrator, development install without signing: lets Illustrator load unsigned CEP
rem panels (PlayerDebugMode, per user) and links dist\ai into the user CEP extensions folder.
rem Run npm run build first. Undo: delete the link and the PlayerDebugMode values.
rem No full-width punctuation in echo lines: under chcp 65001 cmd splits them.
set "SRC=%~dp0..\dist\ai"
if not exist "%SRC%\CSXS\manifest.xml" (echo 没找到 dist\ai, 请先运行 npm run build & %PAUSE% & exit /b 1)
for %%V in (11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
set "DST=%APPDATA%\Adobe\CEP\extensions"
if not exist "%DST%" mkdir "%DST%"
if exist "%DST%\com.waveplug.ai.wavelayer" rmdir "%DST%\com.waveplug.ai.wavelayer"
mklink /J "%DST%\com.waveplug.ai.wavelayer" "%SRC%" >nul || (echo 创建链接失败, 改为复制文件 & xcopy /e /i /y /q "%SRC%" "%DST%\com.waveplug.ai.wavelayer" >nul)
echo.
echo 检查:
if exist "%DST%\com.waveplug.ai.wavelayer\CSXS\manifest.xml" (echo   [OK] 面板已在 %DST%\com.waveplug.ai.wavelayer) else (echo   [失败] 扩展文件夹里没有 manifest.xml)
for %%V in (11 12 13) do (reg query "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode 2>nul | findstr /r /c:"REG_SZ  *1" >nul && echo   [OK] CSXS.%%V PlayerDebugMode=1 || echo   [失败] CSXS.%%V PlayerDebugMode 没写上)
tasklist /fi "imagename eq Illustrator.exe" 2>nul | find /i "Illustrator.exe" >nul && echo   [注意] Illustrator 正在运行, 必须完全退出再打开才会出现面板
echo.
echo 完成. 重启 Illustrator, 在 窗口 - 扩展功能 - WaveLayer 打开面板.
echo 以后改了代码只要双击 studio\update.cmd, 面板会自动载入新版本.
%PAUSE%
