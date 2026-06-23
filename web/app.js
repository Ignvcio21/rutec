/* ==========================================================================
   Rutec - logica del frontend
   ========================================================================== */

const state = {
  origen: null,            // {lat, lon, label}
  plantilla: [],           // [{nro, cliente, vendedor}]
  facturas: [],            // [{cliente, direccion, comuna, nro}]
  resultado: [],           // [{name, direccion, comuna, nro, vendedor, lat, lon, dist}]
  fallidas: [],            // [{name, direccion, comuna, motivo}] paradas no ubicadas
  ocrReady: false,
  country: "Chile",
};

/* ---------- sesión: guardar/restaurar en el navegador ---------- */
const SESSION_KEY = "rutec_session";
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      origen: state.origen,
      plantilla: state.plantilla,
      facturas: state.facturas,
      resultado: state.resultado,
      fallidas: state.fallidas,
      country: state.country,
    }));
  } catch {}
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!s) return false;
    state.origen = s.origen || null;
    state.plantilla = s.plantilla || [];
    state.facturas = s.facturas || [];
    state.resultado = s.resultado || [];
    state.fallidas = s.fallidas || [];
    state.country = s.country || state.country;
    return true;
  } catch { return false; }
}

// Normaliza un número de factura para comparar (solo dígitos, sin ceros a la izq.)
function normNro(s) {
  return String(s || "").replace(/\D/g, "").replace(/^0+/, "");
}

/* ---------- utilidades DOM ---------- */
const $ = (id) => document.getElementById(id);
function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

/* ---------- normalizacion y similitud de nombres ---------- */
const STOPWORDS = [
  "SPA", "S.A", "SA", "LTDA", "LIMITADA", "EIRL", "E.I.R.L", "CIA", "Y CIA",
  "COMERCIALIZADORA", "COMERCIAL", "DISTRIBUIDORA", "DISTRIBUIDOR",
  "SOCIEDAD", "SOC", "EMPRESA", "EMPRESAS", "E HIJOS", "HNOS", "HERMANOS",
  "MINIMARKET", "MINIMARKET", "ALMACEN", "BAZAR", "BOTILLERIA", "DE", "LA", "EL", "LOS", "LAS",
];
function normalize(s) {
  if (!s) return "";
  let t = s.toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // acentos
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let tokens = t.split(" ").filter((w) => w && !STOPWORDS.includes(w));
  return tokens.join(" ");
}
function bigrams(s) {
  const set = new Set();
  const t = s.replace(/\s/g, "");
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
// Dice coefficient sobre bigramas (0..1)
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  // refuerzo por tokens compartidos
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  let tinter = 0;
  for (const w of ta) if (tb.has(w)) tinter++;
  const jacc = tinter / (new Set([...ta, ...tb]).size);
  return Math.max(dice, jacc);
}

/* ---------- Haversine ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ordena la ruta de forma ENCADENADA (vecino más cercano): desde el origen va a
// la parada más cercana, desde ahí a la siguiente más cercana, etc. Evita zigzags.
// A cada parada le asigna `dist` = tramo recorrido desde el punto anterior.
function ordenarRutaCercana(stops) {
  const pendientes = stops.slice();
  const ruta = [];
  let cx = state.origen.lat;
  let cy = state.origen.lon;
  while (pendientes.length) {
    let mejor = 0;
    let mejorDist = Infinity;
    for (let i = 0; i < pendientes.length; i++) {
      const d = haversine(cx, cy, pendientes[i].lat, pendientes[i].lon);
      if (d < mejorDist) { mejorDist = d; mejor = i; }
    }
    const siguiente = pendientes.splice(mejor, 1)[0];
    siguiente.dist = mejorDist; // tramo desde la parada anterior (o el origen)
    ruta.push(siguiente);
    cx = siguiente.lat;
    cy = siguiente.lon;
  }
  return ruta;
}

// Ordena y mide la ruta por CARRETERA REAL usando OSRM (gratis).
// Optimiza el orden por caminos reales y da distancias reales (km).
// Si el servicio falla (sin internet o caído), usa la versión en línea recta.
async function ordenarRutaReal(origen, stops) {
  if (!stops.length) return [];
  if (stops.length === 1) {
    stops[0].dist = haversine(origen.lat, origen.lon, stops[0].lat, stops[0].lon);
    return stops.slice();
  }
  try {
    const coords = [[origen.lon, origen.lat], ...stops.map((s) => [s.lon, s.lat])];
    const path = coords.map((c) => `${c[0]},${c[1]}`).join(";");
    const url = `https://router.project-osrm.org/trip/v1/driving/${path}?source=first&roundtrip=false&overview=false`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.code !== "Ok" || !data.trips || !data.trips[0]) throw new Error("osrm");
    const N = coords.length;
    const order = new Array(N);
    data.waypoints.forEach((w, inputIdx) => { order[w.waypoint_index] = inputIdx; });
    const legs = data.trips[0].legs;
    const ruta = [];
    for (let k = 1; k < N; k++) {
      const inputIdx = order[k];
      if (inputIdx == null || inputIdx === 0) continue;
      const stop = stops[inputIdx - 1];
      stop.dist = (legs[k - 1] ? legs[k - 1].distance : 0) / 1000; // km por carretera
      ruta.push(stop);
    }
    if (ruta.length !== stops.length) throw new Error("incompleto");
    return ruta;
  } catch {
    return ordenarRutaCercana(stops); // respaldo: línea recta
  }
}

/* ---------- API helpers ---------- */
// Geocodificación directa desde el navegador a OpenStreetMap (Nominatim).
// Con caché y un máximo de ~1 consulta por segundo (política de uso de OSM).
const _geoCache = {};
let _lastGeo = 0;

// Enfoca TODAS las búsquedas en la REGIÓN DEL MAULE (Talca, costa: Pelluhue,
// Curanipe, Constitución, etc., y hasta la cordillera), para no traer calles del
// mismo nombre en otras regiones de Chile, pero SIN excluir la costa.
// Formato Nominatim: "lon1,lat1,lon2,lat2" (dos esquinas del recuadro).
const GEO_VIEWBOX = "-72.85,-34.70,-70.30,-36.55";
const GEO_AREA_DEFECTO = ""; // no forzar comuna: se usa la que traiga la factura

// Extrae "calle de grilla" -> ej: "5½ Poniente" => "5 poniente"; null si no aplica.
function gridKey(s) {
  const m = String(s || "").toLowerCase().match(/(\d+)[^a-z0-9]*(norte|sur|oriente|poniente)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// Detecta direcciones de grilla chilena ("5 Poniente 3 y 4 Norte 1433")
// y devuelve { principal:"5 poniente", transversal:"3 norte" } o null.
function parseGrid(dir) {
  const re = /(\d+)\s*(?:y\s*\d+\s*)?(norte|sur|oriente|poniente)/gi;
  const calles = [];
  let m;
  while ((m = re.exec(String(dir || "").toLowerCase()))) calles.push(`${m[1]} ${m[2]}`);
  if (calles.length >= 2 && calles[0] !== calles[1]) {
    return { principal: calles[0], transversal: calles[1] };
  }
  return null;
}

// Una sola consulta a Nominatim (respeta el límite de 1/seg).
async function _nominatim(fullQuery, country) {
  const wait = 1100 - (Date.now() - _lastGeo);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGeo = Date.now();
  const cc = country.toLowerCase() === "chile" ? "&countrycodes=cl" : "";
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1` +
    `&viewbox=${GEO_VIEWBOX}&bounded=1` +
    `${cc}&q=${encodeURIComponent(fullQuery)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      const h = arr[0];
      return {
        ok: true,
        lat: parseFloat(h.lat),
        lon: parseFloat(h.lon),
        display: h.display_name,
        road: (h.address && (h.address.road || h.address.pedestrian)) || "",
        query: fullQuery,
      };
    }
    return { ok: false, error: "Sin resultados", query: fullQuery };
  } catch {
    return { ok: false, error: "No se pudo conectar con el mapa", query: fullQuery };
  }
}

async function apiGeocode(q, comuna = "") {
  const country = state.country || "Chile";
  const com = String(comuna || "").trim();
  const dir = String(q || "").trim();
  // Si la factura no trae comuna, se asume Talca (la zona de reparto).
  const area = com || GEO_AREA_DEFECTO;
  const key = [dir, area, country].join("|").toLowerCase();
  if (_geoCache[key]) return _geoCache[key];

  let res = null;

  // 1) Si es dirección de grilla, intenta la ESQUINA (más precisa por cuadra),
  //    pero solo la acepta si cae en la calle principal correcta.
  const grid = parseGrid(dir);
  if (grid) {
    const interQ = [`${grid.principal} y ${grid.transversal}`, area, country].filter(Boolean).join(", ");
    const inter = await _nominatim(interQ, country);
    if (inter.ok && gridKey(inter.road || inter.display) === gridKey(grid.principal)) {
      res = { ...inter, preciso: "esquina" };
    }
  }

  // 2) Si no hubo esquina válida, usa la dirección completa (método normal).
  if (!res) {
    const full = [dir, area, country].filter(Boolean).join(", ");
    res = await _nominatim(full, country);
  }

  _geoCache[key] = res;
  return res;
}
const NO_SERVER_MSG =
  "Sin conexión con el servidor. Verifica que Rutec.exe esté abierto (ventana negra) " +
  "y abre http://localhost:8000 — no el archivo index.html.";

// Reduce la foto (canvas) antes de subir: más rápido y evita cortes de subida.
function resizeImage(file, maxDim = 2000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("No se pudo procesar la imagen"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Imagen inválida")); };
    img.src = url;
  });
}

async function apiOcr(fileOrList, tipo) {
  const arr = Array.isArray(fileOrList) ? fileOrList : [fileOrList];
  const fd = new FormData();
  fd.append("tipo", tipo);
  for (const f of arr) {
    let blob = f;
    try { blob = await resizeImage(f); } catch { blob = f; }
    fd.append("files", blob, "foto.jpg");
  }
  let r;
  try {
    r = await fetch("/api/ocr", { method: "POST", body: fd });
  } catch {
    throw new Error(NO_SERVER_MSG);
  }
  if (!r.ok) {
    let msg = `Error ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/* ==========================================================================
   PASO 1 - Origen
   ========================================================================== */
$("btnGps").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Este dispositivo no permite ubicación");
  setStatus($("origenStatus"), "Obteniendo ubicación... acepta el permiso del navegador 📍", "work");

  const onOk = (pos) => {
    state.origen = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Mi ubicación (GPS)" };
    setStatus($("origenStatus"), `✓ Origen: tu ubicación actual (${state.origen.lat.toFixed(4)}, ${state.origen.lon.toFixed(4)})`, "ok");
    refreshProcesar();
    saveSession();
  };
  const onErr = (err) => {
    let m = err.message || "Error desconocido";
    if (err.code === 1) m = "Permiso de ubicación denegado. Actívalo en los ajustes del navegador (Ubicación) y reintenta.";
    else if (err.code === 2) m = "Ubicación no disponible. Revisa que el GPS del teléfono esté encendido.";
    else if (err.code === 3) m = "Tardó demasiado. Reintenta (mejor al aire libre).";
    setStatus($("origenStatus"), "✗ " + m, "bad");
  };
  // Primer intento de alta precisión; si falla por tiempo, reintenta en modo rápido.
  navigator.geolocation.getCurrentPosition(
    onOk,
    (err) => {
      if (err.code === 3) {
        navigator.geolocation.getCurrentPosition(onOk, onErr, { enableHighAccuracy: false, timeout: 25000, maximumAge: 120000 });
      } else {
        onErr(err);
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});

function setOrigen(lat, lon, label) {
  state.origen = { lat, lon, label };
  setStatus($("origenStatus"), "✓ Origen: " + label, "ok");
  $("origenResults").classList.add("hidden");
  refreshProcesar();
  saveSession();
}

// Busca varias coincidencias para que el usuario elija la correcta.
async function apiGeocodeMany(q, n = 6) {
  const country = state.country || "Chile";
  const full = [String(q || "").trim(), country].filter(Boolean).join(", ");
  const wait = 1100 - (Date.now() - _lastGeo);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGeo = Date.now();
  const cc = country.toLowerCase() === "chile" ? "&countrycodes=cl" : "";
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${n}&addressdetails=1` +
    `&viewbox=${GEO_VIEWBOX}&bounded=1` +
    `${cc}&q=${encodeURIComponent(full)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const arr = await r.json();
    return Array.isArray(arr)
      ? arr.map((h) => ({ lat: parseFloat(h.lat), lon: parseFloat(h.lon), display: h.display_name }))
      : [];
  } catch {
    return [];
  }
}

function renderOrigenResults(results) {
  const box = $("origenResults");
  box.innerHTML = "";
  if (!results.length) {
    box.innerHTML = `<div class="geo-empty">No encontré ese lugar. Agrega más detalle, o ponlo a mano en el mapa 👇</div>`;
    box.classList.remove("hidden");
    return;
  }
  results.forEach((r) => {
    const parts = r.display.split(",").map((s) => s.trim());
    const main = parts.slice(0, 2).join(", ");
    const sub = parts.slice(2).join(", ");
    const div = document.createElement("div");
    div.className = "geo-item";
    div.innerHTML = `<span class="pin">📍</span><div class="txt">${main}<div class="sub">${sub}</div></div>`;
    div.onclick = () => setOrigen(r.lat, r.lon, main);
    box.appendChild(div);
  });
  box.classList.remove("hidden");
}

async function buscarOrigen() {
  const q = $("origenInput").value.trim();
  if (q.length < 3) { $("origenResults").classList.add("hidden"); return; }
  setStatus($("origenStatus"), "Buscando...", "work");
  const results = await apiGeocodeMany(q);
  setStatus($("origenStatus"), "", "");
  renderOrigenResults(results);
}

$("btnOrigen").addEventListener("click", buscarOrigen);
$("origenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscarOrigen(); } });
let _origenDebounce;
$("origenInput").addEventListener("input", () => {
  clearTimeout(_origenDebounce);
  _origenDebounce = setTimeout(buscarOrigen, 700);
});

/* ---------- Mapa para fijar el punto a mano (se abre con botón) ---------- */
let _map = null;
function initMapa() {
  const start = state.origen ? [state.origen.lat, state.origen.lon] : [-35.4264, -71.6554]; // Talca centro por defecto
  _map = L.map("mapa", { zoomControl: true }).setView(start, state.origen ? 16 : 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(_map);
}

$("btnAbrirMapa").addEventListener("click", () => {
  const box = $("mapaBox");
  const abrir = box.classList.contains("hidden");
  box.classList.toggle("hidden");
  if (abrir) {
    if (!_map) initMapa();
    setTimeout(() => _map.invalidateSize(), 250);
    setTimeout(() => _map.invalidateSize(), 700);
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

$("btnGpsMapa").addEventListener("click", () => {
  if (!navigator.geolocation || !_map) return toast("Sin GPS disponible");
  navigator.geolocation.getCurrentPosition(
    (p) => _map.setView([p.coords.latitude, p.coords.longitude], 17),
    () => toast("No se pudo obtener tu ubicación"),
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

$("btnFijarMapa").addEventListener("click", () => {
  if (!_map) return;
  const c = _map.getCenter();
  setOrigen(c.lat, c.lng, `Punto en mapa (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`);
  $("mapaBox").classList.add("hidden");
  toast("Punto de partida fijado en el mapa");
});

/* ==========================================================================
   PASO 2 - Plantilla (nombres)
   ========================================================================== */
$("plantillaFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus($("plantillaStatus"), "Leyendo plantilla con IA...", "work");
  try {
    const data = await apiOcr(file, "plantilla");
    // Acepta el formato nuevo {filas:[{nro,cliente,vendedor}]} y el viejo {clientes:[...]}.
    let filas = [];
    if (Array.isArray(data.filas)) {
      filas = data.filas.map((f) => ({
        nro: String(f.nro || "").trim(),
        cliente: String(f.cliente || "").trim().toUpperCase(),
        vendedor: String(f.vendedor || "").trim(),
      }));
    } else {
      filas = (data.clientes || data.nombres || []).map((s) => ({ nro: "", cliente: String(s).trim().toUpperCase(), vendedor: "" }));
    }
    filas = filas.filter((f) => f.cliente);
    for (const f of filas) {
      const dup = state.plantilla.some((p) => (f.nro && p.nro === f.nro) || (!f.nro && p.cliente === f.cliente && !p.nro));
      if (!dup) state.plantilla.push(f);
    }
    renderPlantilla();
    setStatus($("plantillaStatus"), `✓ ${filas.length} fila(s) leídas`, "ok");
  } catch (err) {
    setStatus($("plantillaStatus"), "✗ " + err.message, "bad");
  } finally {
    e.target.value = "";
  }
});

function renderPlantilla() {
  const box = $("plantillaList");
  box.innerHTML = "";
  state.plantilla.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const vend = p.vendedor ? ` · ${p.vendedor.split(" ")[0]}` : "";
    chip.innerHTML = `${p.cliente}${vend} <button title="Quitar">✕</button>`;
    chip.querySelector("button").onclick = () => {
      state.plantilla.splice(i, 1);
      renderPlantilla();
      saveSession();
    };
    box.appendChild(chip);
  });
  refreshProcesar();
  saveSession();
}

/* ==========================================================================
   PASO 3 - Facturas (direcciones)
   ========================================================================== */
$("facturaFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  // Agrupar las imágenes para enviar varias en una sola petición (ahorra cuota de IA).
  const CHUNK = 6;
  const grupos = [];
  for (let i = 0; i < files.length; i += CHUNK) grupos.push(files.slice(i, i + CHUNK));

  let found = 0;
  // Lista de grupos pendientes; los que fallen (IA saturada) se reintentan en rondas.
  let pendientes = grupos.map((g, i) => ({ g, i }));
  const MAX_RONDAS = 4;

  for (let ronda = 0; ronda < MAX_RONDAS && pendientes.length; ronda++) {
    if (ronda > 0) {
      // La IA estaba saturada (503): esperar y reintentar SOLO los grupos que fallaron.
      for (let s = 25; s > 0; s--) {
        setStatus($("facturaStatus"), `IA saturada. Reintentando ${pendientes.length} grupo(s) en ${s}s...`, "work");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const fallaron = [];
    for (let j = 0; j < pendientes.length; j++) {
      const { g, i } = pendientes[j];
      setStatus($("facturaStatus"), `Leyendo facturas con IA... ${ronda > 0 ? "(reintento) " : ""}grupo ${i + 1}/${grupos.length}`, "work");
      if (j > 0) await new Promise((r) => setTimeout(r, 6000));
      try {
        const data = await apiOcr(g, "factura");
        const arr = data.facturas || (data.cliente ? [data] : []);
        for (const f of arr) {
          const item = {
            cliente: (f.cliente || "").trim(),
            direccion: (f.direccion || "").trim(),
            comuna: (f.comuna || "").trim(),
            nro: (f.nro || "").trim(),
          };
          if (item.cliente || item.direccion) { state.facturas.push(item); found++; }
        }
      } catch (err) {
        fallaron.push({ g, i }); // reintentar en la siguiente ronda
      }
    }
    pendientes = fallaron;
  }

  renderFacturas();
  const extra = pendientes.length
    ? ` · ⚠️ ${pendientes.length} grupo(s) no se leyeron (IA muy saturada). Vuelve a subir esas fotos en un rato.`
    : "";
  setStatus($("facturaStatus"), `✓ ${found} factura(s) leídas (total: ${state.facturas.length})${extra}`, pendientes.length ? "bad" : "ok");
  e.target.value = "";
});

function renderFacturas() {
  const box = $("facturaList");
  box.innerHTML = "";
  state.facturas.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML =
      `<b>${f.cliente || "(sin nombre)"}</b> ${f.nro ? `<span class="sub">N° ${f.nro}</span>` : ""}` +
      `<div class="sub">${[f.direccion, f.comuna].filter(Boolean).join(", ") || "(sin dirección)"}</div>`;
    box.appendChild(row);
  });
  refreshProcesar();
  saveSession();
}

/* ==========================================================================
   PASO 4 - Procesar
   ========================================================================== */
function refreshProcesar() {
  const ok = state.origen && (state.facturas.length > 0);
  $("btnProcesar").disabled = !ok;
}

const MATCH_THRESHOLD = 0.45;

$("btnProcesar").addEventListener("click", async () => {
  if (!state.origen) return toast("Falta el punto de partida");
  if (!state.facturas.length) return toast("Faltan facturas con direcciones");

  // 1) Construir la lista de paradas (cruce plantilla <-> facturas)
  let paradas = [];
  const usadas = new Set();

  if (state.plantilla.length) {
    for (const fila of state.plantilla) {
      const nombre = fila.cliente || "";
      let best = -1, bestScore = 0, metodo = "";

      // 1) Cruce por N° de factura (exacto) — el más confiable
      const keyNro = normNro(fila.nro);
      if (keyNro) {
        const idx = state.facturas.findIndex((f, i) => !usadas.has(i) && normNro(f.nro) === keyNro);
        if (idx >= 0) { best = idx; bestScore = 1; metodo = "nº"; }
      }
      // 2) Si no calzó por número, intenta por nombre (respaldo)
      if (best < 0) {
        let bScore = 0, bIdx = -1;
        state.facturas.forEach((f, idx) => {
          if (usadas.has(idx)) return;
          const sc = similarity(nombre, f.cliente);
          if (sc > bScore) { bScore = sc; bIdx = idx; }
        });
        if (bIdx >= 0 && bScore >= MATCH_THRESHOLD) { best = bIdx; bestScore = bScore; metodo = "nombre"; }
      }

      if (best >= 0) {
        usadas.add(best);
        const f = state.facturas[best];
        paradas.push({ name: nombre || f.cliente, direccion: f.direccion, comuna: f.comuna, nro: fila.nro || f.nro, vendedor: fila.vendedor || "", score: bestScore, metodo });
      } else {
        paradas.push({ name: nombre, direccion: "", comuna: "", nro: fila.nro || "", vendedor: fila.vendedor || "", score: 0, sinFactura: true });
      }
    }
  } else {
    // sin plantilla: usar las facturas directamente
    paradas = state.facturas.map((f) => ({
      name: f.cliente, direccion: f.direccion, comuna: f.comuna, nro: f.nro, vendedor: "", score: 1, metodo: "directo",
    }));
  }

  // 2) Geocodificar
  const prog = $("progress"); const bar = $("progressBar");
  prog.classList.remove("hidden");
  const ubicadas = []; const fallidas = [];
  for (let i = 0; i < paradas.length; i++) {
    const p = paradas[i];
    setStatus($("procesarStatus"), `Ubicando ${i + 1}/${paradas.length}: ${p.name}...`, "work");
    bar.style.width = `${Math.round(((i + 1) / paradas.length) * 100)}%`;
    if (!p.direccion) { fallidas.push({ ...p, motivo: p.sinFactura ? "Sin factura/dirección" : "Sin dirección" }); continue; }
    const g = await apiGeocode(p.direccion, p.comuna);
    if (g.ok) {
      ubicadas.push({ ...p, lat: g.lat, lon: g.lon, display: g.display });
    } else {
      fallidas.push({ ...p, motivo: "No se ubicó en el mapa" });
    }
  }

  // 3) Orden por CARRETERA real (OSRM); si falla, cae a línea recta
  setStatus($("procesarStatus"), "Calculando la mejor ruta por carretera...", "work");
  state.resultado = await ordenarRutaReal(state.origen, ubicadas);
  state.fallidas = fallidas;
  saveSession();
  const totalKm = state.resultado.reduce((s, u) => s + u.dist, 0);

  prog.classList.add("hidden");
  bar.style.width = "0%";
  // Desglose claro del por qué de las que faltan
  const sinFactura = fallidas.filter((f) => f.sinFactura).length;
  const sinUbicar = fallidas.length - sinFactura;
  const detalle = fallidas.length
    ? ` · ${fallidas.length} por revisar (${sinFactura} sin factura, ${sinUbicar} sin ubicar)`
    : "";
  const totalTxt = state.resultado.length ? ` · ~${totalKm.toFixed(1)} km total` : "";
  setStatus($("procesarStatus"), `✓ ${state.resultado.length} en ruta${detalle}${totalTxt}`, state.resultado.length ? "ok" : "bad");

  renderResultado(state.resultado, fallidas);
});

/* ==========================================================================
   RESULTADO
   ========================================================================== */
const IS_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

function wazeUrl(lat, lon) {
  // En el celular: deep link a la app (usa tu GPS como origen y arranca la ruta).
  if (IS_MOBILE) return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
  // En el PC (Waze web): mostramos la ruta con origen + destino ya cargados.
  const o = state.origen;
  if (o) return `https://www.waze.com/live-map/directions?from=ll.${o.lat}%2C${o.lon}&to=ll.${lat}%2C${lon}`;
  return `https://www.waze.com/live-map/directions?to=ll.${lat}%2C${lon}`;
}

/* ---------- Checklist de paradas completadas (persiste en el navegador) ---------- */
function doneKey(u) {
  return (u.name + "|" + (u.direccion || "")).toLowerCase();
}
function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem("rutec_done") || "[]")); }
  catch { return new Set(); }
}
function saveDone(set) {
  localStorage.setItem("rutec_done", JSON.stringify([...set]));
}
function updateDoneCounter(total) {
  const el = $("doneCounter");
  if (!el) return;
  const done = loadDone();
  let hechas = 0;
  state.resultado.forEach((u) => { if (done.has(doneKey(u))) hechas++; });
  el.textContent = `✅ ${hechas} de ${total} completadas`;
}
function mapsStopUrl(lat, lon) {
  const o = state.origen;
  let url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  if (o) url += `&origin=${o.lat},${o.lon}`;
  return url;
}

function metodoTxt(u) {
  if (u.metodo === "nº") return "✔ por N° factura";
  if (u.metodo === "nombre") return `~ por nombre ${Math.round((u.score || 0) * 100)}%`;
  return "directo";
}

function renderResultado(ubicadas, fallidas) {
  state.fallidas = fallidas || [];
  const sec = $("step-resultado");
  sec.classList.remove("hidden");
  const list = $("resultList");
  list.innerHTML = "";
  const done = loadDone();
  ubicadas.forEach((u) => {
    const li = document.createElement("li");
    const key = doneKey(u);
    const isDone = done.has(key);
    if (isDone) li.classList.add("done");
    li.innerHTML =
      `<label class="chk" title="Marcar como entregado"><input type="checkbox" ${isDone ? "checked" : ""} /></label>` +
      `<div class="name">${u.name}</div>` +
      `<div class="addr">${[u.direccion, u.comuna].filter(Boolean).join(", ")}</div>` +
      `<div class="meta">↪ ${u.dist.toFixed(2)} km desde la anterior · ${metodoTxt(u)}${u.vendedor ? " · 👤 " + u.vendedor.split(" ")[0] : ""}</div>` +
      `<div class="acts">
         <a class="mini waze" href="${wazeUrl(u.lat, u.lon)}" target="_blank" rel="noopener">🚗 Waze</a>
         <a class="mini gmaps" href="${mapsStopUrl(u.lat, u.lon)}" target="_blank" rel="noopener">🗺️ Maps</a>
       </div>`;
    li.querySelector("input").addEventListener("change", (e) => {
      const set = loadDone();
      if (e.target.checked) { set.add(key); li.classList.add("done"); }
      else { set.delete(key); li.classList.remove("done"); }
      saveDone(set);
      updateDoneCounter(ubicadas.length);
    });
    list.appendChild(li);
  });
  updateDoneCounter(ubicadas.length);

  // No ubicados
  const box = $("unmatchedBox"); const ul = $("unmatchedList");
  ul.innerHTML = "";
  if (fallidas.length) {
    box.classList.remove("hidden");
    box.querySelector("summary").textContent = `⚠️ ${fallidas.length} no ubicado(s) - corregir dirección`;
    fallidas.forEach((f) => {
      const div = document.createElement("div");
      div.className = "umrow";
      div.innerHTML =
        `<span><b>${f.name}</b> — ${f.motivo}</span>` +
        `<input type="text" placeholder="Escribe la dirección completa" value="${f.direccion || ""}" />` +
        `<button class="btn mini">Ubicar</button>`;
      const input = div.querySelector("input");
      div.querySelector("button").onclick = async () => {
        const q = input.value.trim();
        if (!q) return toast("Escribe la dirección");
        const g = await apiGeocode(q, f.comuna);
        if (g.ok) {
          const u = { ...f, direccion: q, lat: g.lat, lon: g.lon };
          state.resultado.push(u);
          state.resultado = await ordenarRutaReal(state.origen, state.resultado);
          renderResultado(state.resultado, fallidas.filter((x) => x !== f));
          saveSession(); // guarda ruta + fallidas actualizadas
          toast("Agregado y reordenado");
        } else {
          toast("Aún no la encuentro, prueba con otra referencia");
        }
      };
      ul.appendChild(div);
    });
  } else {
    box.classList.add("hidden");
  }

  sec.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ==========================================================================
   MODO RUTA PASO A PASO (optativo) — muestra una parada a la vez
   ========================================================================== */
let rmIndex = 0;

function nextPendingIndex(from) {
  const done = loadDone();
  const N = state.resultado.length;
  for (let k = 0; k < N; k++) {
    const i = (from + k) % N;
    if (!done.has(doneKey(state.resultado[i]))) return i;
  }
  return -1; // todas entregadas
}

function renderStep() {
  const N = state.resultado.length;
  const done = loadDone();
  const hechas = state.resultado.filter((u) => done.has(doneKey(u))).length;
  const card = $("rmCard");
  const acts = $("rmSkip").parentElement;

  if (rmIndex < 0) {
    card.innerHTML = `<div class="rm-done-all">🎉 ¡Ruta completada!</div>` +
      `<div class="rm-addr">Entregaste las ${N} paradas.</div>`;
    acts.classList.add("hidden");
    $("rmProgress").textContent = `${hechas} de ${N} entregadas`;
    return;
  }
  acts.classList.remove("hidden");
  const u = state.resultado[rmIndex];
  $("rmProgress").textContent = `${hechas} de ${N} entregadas`;
  // reconstruir la tarjeta (por si venía del estado "completada")
  card.innerHTML =
    `<div class="rm-pos" id="rmPos"></div><div class="rm-name" id="rmName"></div>` +
    `<div class="rm-addr" id="rmAddr"></div><div class="rm-dist" id="rmDist"></div>` +
    `<div class="rm-nav">` +
    `<a id="rmWaze" class="rm-bignav waze" target="_blank" rel="noopener">🚗 Ir con Waze</a>` +
    `<a id="rmMaps" class="rm-bignav gmaps" target="_blank" rel="noopener">🗺️ Maps</a></div>`;
  $("rmPos").textContent = `Parada ${rmIndex + 1} de ${N}`;
  $("rmName").textContent = u.name;
  $("rmAddr").textContent = [u.direccion, u.comuna].filter(Boolean).join(", ");
  $("rmDist").textContent = `↪ ${u.dist.toFixed(2)} km desde la anterior`;
  $("rmWaze").href = wazeUrl(u.lat, u.lon);
  $("rmMaps").href = mapsStopUrl(u.lat, u.lon);
}

$("btnIniciarRuta").addEventListener("click", () => {
  if (!state.resultado.length) return toast("Primero genera la ruta");
  rmIndex = nextPendingIndex(0);
  $("routeMode").classList.remove("hidden");
  renderStep();
});

$("rmExit").addEventListener("click", () => {
  $("routeMode").classList.add("hidden");
  renderResultado(state.resultado, state.fallidas); // refresca la lista con lo entregado
});

$("rmDone").addEventListener("click", () => {
  if (rmIndex < 0) return;
  const set = loadDone();
  set.add(doneKey(state.resultado[rmIndex]));
  saveDone(set);
  rmIndex = nextPendingIndex(rmIndex);
  renderStep();
});

$("rmSkip").addEventListener("click", () => {
  if (rmIndex < 0) return;
  const sig = nextPendingIndex(rmIndex + 1);
  if (sig === rmIndex) return toast("Es la única parada pendiente");
  rmIndex = sig;
  renderStep();
});

/* ---------- Ruta completa en Google Maps (multi-parada) ---------- */
$("btnMapsAll").addEventListener("click", () => {
  if (!state.resultado.length) return toast("Primero genera la ruta");
  const o = state.origen;
  const pts = state.resultado;
  const dest = pts[pts.length - 1];
  const waypoints = pts.slice(0, -1).map((p) => `${p.lat},${p.lon}`).join("|");
  let url = `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${dest.lat},${dest.lon}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
  window.open(url, "_blank");
  if (pts.length > 10) toast("Nota: Google Maps puede limitar rutas con muchas paradas");
});

/* ---------- Exportar CSV ---------- */
$("btnCsv").addEventListener("click", () => {
  if (!state.resultado.length) return toast("Primero genera la ruta");
  const rows = [["Orden", "Cliente", "Direccion", "Comuna", "Distancia_km", "Lat", "Lon"]];
  state.resultado.forEach((u, i) =>
    rows.push([i + 1, u.name, u.direccion, u.comuna, u.dist.toFixed(2), u.lat, u.lon])
  );
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ruta_rutec.csv";
  a.click();
});

/* ---------- Reset (Empezar de nuevo) ---------- */
$("btnReset").addEventListener("click", () => {
  if (!confirm("¿Empezar de nuevo? Se borrará la planilla, las facturas, la ruta y lo marcado.")) return;
  state.plantilla = []; state.facturas = []; state.resultado = []; state.fallidas = []; state.origen = null;
  localStorage.removeItem(SESSION_KEY);   // borra la sesión guardada
  localStorage.removeItem("rutec_done");  // borra el checklist de entregas
  renderPlantilla(); renderFacturas();
  $("step-resultado").classList.add("hidden");
  setStatus($("origenStatus"), ""); setStatus($("plantillaStatus"), ""); setStatus($("facturaStatus"), ""); setStatus($("procesarStatus"), "");
  $("origenInput").value = "";
  toast("Listo, empieza de nuevo");
});

/* ---------- Init ---------- */
async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    state.ocrReady = cfg.ocr_ready;
    state.country = cfg.country || "Chile";
    const badge = $("ocrBadge");
    if (cfg.ocr_ready) {
      badge.textContent = "IA: lista ✓";
      badge.className = "badge badge-ok";
    } else {
      badge.textContent = "IA: falta key";
      badge.className = "badge badge-bad";
      badge.title = "Edita el archivo .env y agrega XAI_API_KEY";
    }
  } catch {
    $("ocrBadge").textContent = "IA: offline";
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Restaurar sesión guardada (sobrevive a recargas y cierres del navegador)
  if (loadSession()) {
    renderPlantilla();
    renderFacturas();
    if (state.origen) {
      setStatus($("origenStatus"), "✓ Origen: " + (state.origen.label || "guardado"), "ok");
    }
    if (state.resultado && state.resultado.length) {
      renderResultado(state.resultado, state.fallidas || []);
      const f = (state.fallidas || []).length;
      setStatus($("procesarStatus"), `✓ Ruta guardada: ${state.resultado.length} paradas${f ? ` · ${f} por revisar` : ""}`, "ok");
    }
    refreshProcesar();
  }
}
init();
