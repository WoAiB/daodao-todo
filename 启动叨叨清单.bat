@echo off
rem 叨叨清单启动器：起本地服务器并打开浏览器（ES modules 需通过 http 访问）
cd /d "%~dp0"
start "" http://localhost:8417
python -m http.server 8417
