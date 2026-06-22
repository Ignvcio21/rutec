@echo off
REM Recompila Rutec.exe y lo copia a la carpeta de entrega
cd /d "%~dp0"
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --onefile --name Rutec ^
  --add-data "web;web" --collect-submodules uvicorn ^
  --hidden-import multipart --hidden-import h11 server\main.py
if exist "dist\Rutec.exe" copy /Y "dist\Rutec.exe" "Rutec-App\Rutec.exe"
echo.
echo Listo. Ejecutable en Rutec-App\Rutec.exe
pause
