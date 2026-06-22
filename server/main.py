"""
Rutec - Backend (FastAPI)
-------------------------
Sirve la PWA (carpeta /web) y expone una pequena API que:
  - /api/ocr      -> lee una foto (plantilla o factura) usando IA de vision (Grok / xAI)
  - /api/geocode  -> convierte una direccion en coordenadas (OpenStreetMap / Nominatim)
  - /api/config   -> dice al frontend si la API key esta configurada

La API key de Grok NO viaja al navegador: se queda aqui en el servidor.
"""

import os
import re
import sys
import json
import time
import base64
import asyncio
import threading
import webbrowser
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles


# ----------------------------------------------------------------------------
# Rutas base (compatibles con PyInstaller .exe)
# ----------------------------------------------------------------------------
def base_dir() -> Path:
    """Carpeta base, ya sea ejecutando .py o el .exe empaquetado."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


BASE = base_dir()
WEB_DIR = BASE / "web"

# El .env se busca junto al ejecutable/proyecto para que el usuario lo edite facil.
ENV_CANDIDATES = [
    Path(sys.executable).resolve().parent / ".env" if getattr(sys, "frozen", False) else None,
    BASE / ".env",
    Path.cwd() / ".env",
]
for c in ENV_CANDIDATES:
    if c and c.exists():
        load_dotenv(c)
        break
else:
    load_dotenv()


# ----------------------------------------------------------------------------
# Configuracion
# ----------------------------------------------------------------------------
# Proveedor de OCR (compatible con formato OpenAI: Gemini, Grok/xAI, OpenAI, etc.)
# Se aceptan nombres genericos (OCR_*) y se mantienen los antiguos (XAI_*, GEMINI_*) como respaldo.
OCR_API_KEY = (
    os.getenv("OCR_API_KEY")
    or os.getenv("GEMINI_API_KEY")
    or os.getenv("XAI_API_KEY")
    or ""
).strip()
OCR_BASE_URL = (
    os.getenv("OCR_BASE_URL")
    or os.getenv("XAI_BASE_URL")
    or "https://generativelanguage.googleapis.com/v1beta/openai"
).strip().rstrip("/")
OCR_MODEL = (os.getenv("OCR_MODEL") or os.getenv("XAI_MODEL") or "gemini-2.0-flash").strip()
NOMINATIM_URL = os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search").strip()
GEO_COUNTRY = os.getenv("GEO_COUNTRY", "Chile").strip()

app = FastAPI(title="Rutec", version="1.0.0")


# ----------------------------------------------------------------------------
# Prompts para la IA de vision
# ----------------------------------------------------------------------------
PROMPT_PLANTILLA = (
    "Eres un asistente que lee una planilla / hoja de ruta / liquidacion de reparto. "
    "Es una tabla con una fila por cliente a visitar. De cada fila extrae, si existen: "
    "el NUMERO de factura o documento, el NOMBRE del cliente, y el VENDEDOR (codigo o nombre). "
    "La hoja normalmente NO trae direcciones. "
    "Devuelve UNICAMENTE un JSON valido con esta forma exacta:\n"
    '{"filas": [{"nro": "...", "cliente": "...", "vendedor": "..."}]}\n'
    "Reglas:\n"
    "- 'nro' = numero de factura/documento de esa fila (solo los digitos). Si no hay, cadena vacia.\n"
    "- 'cliente' = nombre del cliente tal como aparece, en mayusculas.\n"
    "- 'vendedor' = codigo o nombre del vendedor de esa fila (ej. '010 GUILLERMO GARCIA'). Si no hay, cadena vacia.\n"
    "Una fila por cada renglon, aunque el mismo cliente se repita con distinto numero. "
    "No agregues explicaciones ni texto fuera del JSON."
)

PROMPT_FACTURA = (
    "Eres un asistente que lee facturas o guias de despacho chilenas. "
    "Extrae los datos del CLIENTE/DESTINATARIO (campo SENOR(ES), DIRECCION, COMUNA). "
    "Si hay varias facturas en la imagen, devuelve una entrada por cada una. "
    "Devuelve UNICAMENTE un JSON valido con esta forma exacta:\n"
    '{"facturas": [{"cliente": "...", "direccion": "...", "comuna": "...", "nro": "..."}]}\n'
    "Reglas:\n"
    "- 'cliente' = nombre del destinatario (campo SENOR(ES)).\n"
    "- 'direccion' = direccion de entrega tal cual (calle y numero).\n"
    "- 'comuna' = comuna/ciudad de entrega.\n"
    "- 'nro' = numero de factura/guia si existe, si no, cadena vacia.\n"
    "No incluyas el emisor de la factura, solo el cliente que recibe. "
    "No agregues texto fuera del JSON."
)


def _extract_json(text: str) -> dict:
    """Intenta sacar un objeto JSON de la respuesta del modelo (quita ``` y ruido)."""
    if not text:
        raise ValueError("Respuesta vacia del modelo")
    text = text.strip()
    # quitar fences ```json ... ```
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    # primer { hasta ultimo }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    return json.loads(text)


async def _call_grok_vision(images: list[tuple[bytes, str]], prompt: str) -> dict:
    """Envía una o varias imágenes en UNA sola petición (ahorra cuota)."""
    if not OCR_API_KEY:
        raise HTTPException(
            status_code=400,
            detail="Falta la API key de IA. Edita el archivo .env y pon OCR_API_KEY=tu_clave",
        )
    content = [{"type": "text", "text": prompt}]
    for image_bytes, mime in images:
        b64 = base64.b64encode(image_bytes).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

    payload = {
        "model": OCR_MODEL,
        "temperature": 0,
        "messages": [{"role": "user", "content": content}],
    }
    headers = {
        "Authorization": f"Bearer {OCR_API_KEY}",
        "Content-Type": "application/json",
    }

    # Reintenta automáticamente si la API responde 429 (límite por minuto).
    resp = None
    for attempt in range(3):
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OCR_BASE_URL}/chat/completions", json=payload, headers=headers
            )
        if resp.status_code == 200:
            break
        if resp.status_code == 429 and attempt < 2:
            await asyncio.sleep(3 * (attempt + 1))  # espera 3s, luego 6s
            continue
        break

    if resp is None or resp.status_code != 200:
        code = resp.status_code if resp is not None else "?"
        if code == 429:
            raise HTTPException(
                status_code=429,
                detail="Límite de la IA alcanzado momentáneamente. Espera ~1 minuto y reintenta.",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Error de la API de IA ({code}): {resp.text[:300] if resp is not None else ''}",
        )

    data = resp.json()
    try:
        msg = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise HTTPException(status_code=502, detail="Respuesta inesperada de la IA")
    try:
        return _extract_json(msg)
    except Exception:
        raise HTTPException(
            status_code=502,
            detail=f"No pude interpretar la respuesta del modelo: {msg[:300]}",
        )


# ----------------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------------
@app.get("/api/config")
async def get_config():
    return {
        "ocr_ready": bool(OCR_API_KEY),
        "model": OCR_MODEL,
        "country": GEO_COUNTRY,
    }


@app.get("/api/models")
async def list_models():
    """Lista los modelos disponibles en la cuenta de Grok (para elegir el de vision)."""
    if not OCR_API_KEY:
        raise HTTPException(status_code=400, detail="Falta OCR_API_KEY en el archivo .env")
    headers = {"Authorization": f"Bearer {OCR_API_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{OCR_BASE_URL}/models", headers=headers)
        data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No pude consultar modelos: {e}")
    ids = [m.get("id") for m in data.get("data", [])] if isinstance(data, dict) else []
    return {"models": ids, "actual": OCR_MODEL, "raw": data}


@app.post("/api/ocr")
async def ocr(tipo: str = Form(...), files: list[UploadFile] = File(...)):
    """tipo = 'plantilla' o 'factura'. Acepta varias imágenes en una sola petición."""
    images: list[tuple[bytes, str]] = []
    for f in files:
        content = await f.read()
        if content:
            images.append((content, f.content_type or "image/jpeg"))
    if not images:
        raise HTTPException(status_code=400, detail="No se recibió ninguna imagen")
    prompt = PROMPT_PLANTILLA if tipo == "plantilla" else PROMPT_FACTURA
    result = await _call_grok_vision(images, prompt)
    return JSONResponse(result)


# --- Geocodificacion con cache + limite de 1 req/seg (politica Nominatim) ----
_geo_cache: dict[str, dict] = {}
_geo_lock = asyncio.Lock()
_last_geo_call = {"t": 0.0}


@app.get("/api/geocode")
async def geocode(q: str, comuna: str = ""):
    query_parts = [p for p in [q.strip(), comuna.strip(), GEO_COUNTRY] if p]
    full_query = ", ".join(query_parts)
    key = full_query.lower()
    if key in _geo_cache:
        return _geo_cache[key]

    async with _geo_lock:
        # respetar 1 peticion por segundo
        elapsed = time.time() - _last_geo_call["t"]
        if elapsed < 1.1:
            await asyncio.sleep(1.1 - elapsed)
        params = {
            "q": full_query,
            "format": "jsonv2",
            "limit": 1,
            "addressdetails": 1,
            "countrycodes": "cl" if GEO_COUNTRY.lower() == "chile" else "",
        }
        headers = {"User-Agent": "Rutec/1.0 (ruteo de reparto)"}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(NOMINATIM_URL, params=params, headers=headers)
            _last_geo_call["t"] = time.time()
            arr = resp.json()
        except Exception as e:
            result = {"ok": False, "error": str(e), "query": full_query}
            return result

    if isinstance(arr, list) and arr:
        hit = arr[0]
        result = {
            "ok": True,
            "lat": float(hit["lat"]),
            "lon": float(hit["lon"]),
            "display": hit.get("display_name", full_query),
            "query": full_query,
        }
    else:
        result = {"ok": False, "error": "Sin resultados", "query": full_query}
    _geo_cache[key] = result
    return result


# ----------------------------------------------------------------------------
# Archivos estaticos (la PWA). Debe ir al final para no tapar /api.
# ----------------------------------------------------------------------------
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


def _open_browser(url: str):
    time.sleep(1.2)
    try:
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    # Abrir el navegador automaticamente al iniciar (solo en local)
    threading.Thread(target=_open_browser, args=(f"http://localhost:{port}",), daemon=True).start()
    print("\n==============================================")
    print("  Rutec en marcha")
    print(f"  En este PC:        http://localhost:{port}")
    print(f"  En el telefono:    http://<IP-de-este-PC>:{port}")
    print("  (misma red WiFi). Ctrl+C para detener.")
    print("==============================================\n")
    uvicorn.run(app, host=host, port=port, log_level="info")
