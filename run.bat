@echo off
REM Ejecuta Rutec en modo desarrollo (sin compilar)
cd /d "%~dp0"
".venv\Scripts\python.exe" server\main.py
pause
