"""
Punto de entrada para Vercel (runtime Python / ASGI).
Vercel detecta la variable `app` y la sirve como función serverless.
Reutiliza la misma app FastAPI que el servidor local.
"""
import os
import sys

# Permite importar el paquete `server` desde la raíz del repo.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.main import app  # noqa: E402

__all__ = ["app"]
