@echo off
chcp 65001 >nul
rem Builds the WavePlug overlay (selection pop-up). Needs Rust: https://rustup.rs
cd /d "%~dp0"
where cargo >nul 2>nul || (echo 没找到 cargo：请先安装 Rust（https://rustup.rs），装完重新打开命令行 & pause & exit /b 1)
cargo test --release || (echo 测试失败 & pause & exit /b 1)
cargo build --release || (echo 编译失败，把上面的错误发给 Claude & pause & exit /b 1)
rem the running copy keeps the exe locked: stop it before replacing it
taskkill /im waveplug-overlay.exe /f >nul 2>nul
timeout /t 1 /nobreak >nul
copy /y target\release\waveplug-overlay.exe ..\..\dist\waveplug-overlay.exe >nul || (echo 复制到 dist 失败：请在任务管理器结束 waveplug-overlay.exe 后重试 & pause & exit /b 1)
start "" "..\..\dist\waveplug-overlay.exe"
echo.
echo 完成：已更新并启动 dist\waveplug-overlay.exe
echo 在 PS 里画一个选区试试。
pause
