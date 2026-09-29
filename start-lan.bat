@echo off
cd /d "%~dp0"
rem Accept connections from other devices on the same network (login is still required).
rem To allow only this PC, use start.bat instead.
set HOST=0.0.0.0
start "" http://127.0.0.1:5173
npm start
