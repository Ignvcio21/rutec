# Rutec — Ordenador de rutas de reparto

Herramienta que lee fotos de **plantillas** (nombres de clientes del día) y
**facturas/guías** (dirección + comuna), las cruza, geocodifica las direcciones
y ordena las paradas **de la más cercana a la más lejana** desde un punto de
partida. Genera enlaces a **Waze** (por parada) y **Google Maps** (ruta completa).

Funciona como **app web (PWA)**: misma URL en PC y teléfono, usa la cámara del
móvil y se puede instalar como ícono. Se distribuye además como **`.exe`** para PC.

## Arquitectura

```
Rutec/
├─ server/main.py        Backend FastAPI: sirve la PWA + /api/ocr + /api/geocode + /api/models
├─ web/                  Frontend PWA (HTML/CSS/JS, manifest, service worker, íconos)
├─ tools/generate_icons.py   Genera los íconos
├─ .env                  Configuración (API key de Grok, puerto, país)
├─ dist/Rutec.exe        Ejecutable compilado (tras build)
└─ Rutec-App/            Carpeta lista para entregar (exe + .env + LEEME)
```

- **OCR**: IA de visión vía endpoint OpenAI-compatible `/v1/chat/completions`.
  Por defecto **Google Gemini** (`gemini-2.5-flash`, nivel gratuito). Es neutral al
  proveedor: cambiando `OCR_BASE_URL`/`OCR_MODEL`/`OCR_API_KEY` sirve para Grok, OpenAI, etc.
  La API key vive **solo en el servidor** (no en el navegador).
- **Geocodificación**: OpenStreetMap / Nominatim (gratis, 1 req/seg, con caché).
- **Distancia**: Haversine (línea recta), orden ascendente.

## Desarrollo (requiere Python 3.12)

```powershell
# crear entorno e instalar
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt pillow pyinstaller

# correr en modo desarrollo
.\.venv\Scripts\python.exe server\main.py
```

Abre http://localhost:8000

## Compilar el .exe

```powershell
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --name Rutec ^
  --add-data "web;web" --collect-submodules uvicorn ^
  --hidden-import multipart --hidden-import h11 server\main.py
```

El resultado queda en `dist\Rutec.exe`. **Debe ir acompañado de un archivo `.env`**
en la misma carpeta.

## Configuración (`.env`)

```
OCR_API_KEY=tu_clave_de_gemini
OCR_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OCR_MODEL=gemini-2.5-flash
GEO_COUNTRY=Chile
PORT=8000
```

Key gratis de Gemini: https://aistudio.google.com/apikey

> Para ver qué modelos tiene tu cuenta: con la app corriendo y la key puesta,
> abre `http://localhost:8000/api/models`.
