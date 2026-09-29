@echo off
cd /d "%~dp0"
rem Only this PC can connect (127.0.0.1).
rem To let phones and other PCs on the same network connect, use start-lan.bat instead.
start "" http://127.0.0.1:5173
npm start
