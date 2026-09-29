@echo off
cd /d "%~dp0"
rem Accept connections from other devices on the same network (login is still required).
rem Delete the next line to allow only this PC (127.0.0.1).
set HOST=0.0.0.0
start "" http://127.0.0.1:5173
npm start
