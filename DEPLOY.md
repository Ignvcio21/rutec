# Desplegar Rutec en Vercel (gratis)

La app queda en una URL pública tipo `https://rutec.vercel.app`, accesible desde
cualquier teléfono con datos móviles. Como es `https`, el **GPS funciona** en el móvil.

## Resumen de la arquitectura en Vercel
- `api/index.py` → función serverless (Python) que sirve la PWA y el endpoint `/api/ocr`.
- `vercel.json` → enruta todo a esa función e incluye la carpeta `web/`.
- `requirements.txt` (raíz) → dependencias de Python.
- La geocodificación la hace el navegador directo contra OpenStreetMap.
- La **API key de Gemini va como variable de entorno en Vercel** (no en el código).

## Pasos

### 1. Subir el código a GitHub
```bash
git remote add origin https://github.com/<TU_USUARIO>/rutec.git
git push -u origin main
```
(Crea primero un repositorio vacío llamado `rutec` en https://github.com/new
 — sin README ni .gitignore, ya los traemos.)

### 2. Importar en Vercel
1. Entra a https://vercel.com e inicia sesión con tu cuenta de GitHub.
2. **Add New… → Project** → elige el repo `rutec` → **Import**.
3. No cambies nada del build (Vercel detecta Python solo). Aún NO hagas deploy:
   primero agrega las variables (paso 3).

### 3. Variables de entorno (Settings → Environment Variables)
Agrega estas cuatro:

| Name | Value |
|------|-------|
| `OCR_API_KEY` | tu clave de Google Gemini |
| `OCR_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `OCR_MODEL` | `gemini-2.5-flash` |
| `GEO_COUNTRY` | `Chile` |

### 4. Deploy
Pulsa **Deploy**. En ~1 min tendrás tu URL pública. Ábrela en el teléfono,
y en el menú del navegador elige "Agregar a pantalla de inicio".

## Actualizar la app más adelante
Cada vez que cambies algo:
```bash
git add -A && git commit -m "cambios" && git push
```
Vercel redepliega solo.
