@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 第一次執行，先安裝套件...
  call npm install --no-audit --no-fund
)
echo.
echo 啟動 Shooting Hero 伺服器（關掉這個視窗就會停止）
echo.
node server\server.js
pause
