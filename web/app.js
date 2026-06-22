/* ==========================================================================
   Rutec - logica del frontend
   ========================================================================== */

const state = {
  origen: null,            // {lat, lon, label}
  plantilla: [],           // ["NOMBRE 1", ...]
  facturas: [],            // [{cliente, direccion, comuna, nro}]
  resultado: [],           // [{name, direccion, comuna, nro, lat, lon, dist}]
  ocrReady: false,
  country: "Chile",
};

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

/* ---------- API helpers ---------- */
// Geocodificación directa desde el navegador a OpenStreetMap (Nominatim).
// Con caché y un máximo de ~1 consulta por segundo (política de uso de OSM).
const _geoCache = {};
let _lastGeo = 0;
async function apiGeocode(q, comuna = "") {
  const country = state.country || "Chile";
  const parts = [String(q || "").trim(), String(comuna || "").trim(), country].filter(Boolean);
  const full = parts.join(", ");
  const key = full.toLowerCase();
  if (_geoCache[key]) return _geoCache[key];

  const wait = 1100 - (Date.now() - _lastGeo);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGeo = Date.now();

  const cc = country.toLowerCase() === "chile" ? "&countrycodes=cl" : "";
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1` +
    `${cc}&q=${encodeURIComponent(full)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const arr = await r.json();
    let res;
    if (Array.isArray(arr) && arr.length) {
      res = { ok: true, lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), display: arr[0].display_name, query: full };
    } else {
      res = { ok: false, error: "Sin resultados", query: full };
    }
    _geoCache[key] = res;
    return res;
  } catch {
    return { ok: false, error: "No se pudo conectar con el mapa", query: full };
  }
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

$("btnOrigen").addEventListener("click", async () => {
  const q = $("origenInput").value.trim();
  if (!q) return toast("Escribe una dirección de origen");
  setStatus($("origenStatus"), "Buscando dirección...", "work");
  const g = await apiGeocode(q);
  if (g.ok) {
    state.origen = { lat: g.lat, lon: g.lon, label: g.display };
    setStatus($("origenStatus"), "✓ Origen: " + g.display, "ok");
    refreshProcesar();
  } else {
    setStatus($("origenStatus"), "No encontré esa dirección. Sé más específico.", "bad");
  }
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
    const nombres = (data.clientes || data.nombres || []).map((s) => String(s).trim()).filter(Boolean);
    // agregar sin duplicar
    for (const n of nombres) if (!state.plantilla.includes(n)) state.plantilla.push(n);
    renderPlantilla();
    setStatus($("plantillaStatus"), `✓ ${nombres.length} nombre(s) leídos`, "ok");
  } catch (err) {
    setStatus($("plantillaStatus"), "✗ " + err.message, "bad");
  } finally {
    e.target.value = "";
  }
});

function renderPlantilla() {
  const box = $("plantillaList");
  box.innerHTML = "";
  state.plantilla.forEach((n, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${n} <button title="Quitar">✕</button>`;
    chip.querySelector("button").onclick = () => {
      state.plantilla.splice(i, 1);
      renderPlantilla();
      refreshProcesar();
    };
    box.appendChild(chip);
  });
  refreshProcesar();
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

  let found = 0, errores = 0;
  for (let c = 0; c < grupos.length; c++) {
    setStatus($("facturaStatus"), `Leyendo facturas con IA... (grupo ${c + 1}/${grupos.length})`, "work");
    try {
      const data = await apiOcr(grupos[c], "factura");
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
      errores++;
      toast(err.message);
    }
  }
  renderFacturas();
  const extra = errores ? ` · ${errores} grupo(s) con error` : "";
  setStatus($("facturaStatus"), `✓ ${found} factura(s) leídas (total: ${state.facturas.length})${extra}`, found ? "ok" : "bad");
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
    for (const nombre of state.plantilla) {
      let best = -1, bestScore = 0;
      state.facturas.forEach((f, idx) => {
        if (usadas.has(idx)) return;
        const sc = similarity(nombre, f.cliente);
        if (sc > bestScore) { bestScore = sc; best = idx; }
      });
      if (best >= 0 && bestScore >= MATCH_THRESHOLD) {
        usadas.add(best);
        const f = state.facturas[best];
        paradas.push({ name: nombre, direccion: f.direccion, comuna: f.comuna, nro: f.nro, score: bestScore });
      } else {
        paradas.push({ name: nombre, direccion: "", comuna: "", nro: "", score: 0, sinFactura: true });
      }
    }
  } else {
    // sin plantilla: usar las facturas directamente
    paradas = state.facturas.map((f) => ({
      name: f.cliente, direccion: f.direccion, comuna: f.comuna, nro: f.nro, score: 1,
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

  // 3) Orden encadenado (vecino más cercano) — ruta de manejo más corta
  state.resultado = ordenarRutaCercana(ubicadas);
  const totalKm = state.resultado.reduce((s, u) => s + u.dist, 0);

  prog.classList.add("hidden");
  bar.style.width = "0%";
  const totalTxt = state.resultado.length ? ` · ~${totalKm.toFixed(1)} km total` : "";
  setStatus($("procesarStatus"), `✓ Listo: ${state.resultado.length} ubicadas, ${fallidas.length} por revisar${totalTxt}`, state.resultado.length ? "ok" : "bad");

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

function renderResultado(ubicadas, fallidas) {
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
      `<div class="meta">↪ ${u.dist.toFixed(2)} km desde la anterior · ${u.score < 1 && u.score > 0 ? "coincidencia " + Math.round(u.score * 100) + "%" : "directo"}</div>` +
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
          state.resultado = ordenarRutaCercana(state.resultado);
          renderResultado(state.resultado, fallidas.filter((x) => x !== f));
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

/* ---------- Reset ---------- */
$("btnReset").addEventListener("click", () => {
  if (!confirm("¿Empezar de nuevo? Se borrará todo lo cargado.")) return;
  state.plantilla = []; state.facturas = []; state.resultado = []; state.origen = null;
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
}
init();
