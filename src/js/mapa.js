// ══════════════════════════════════════════════════════════════════════════
//  VISTA DE MAPA (Leaflet) — src/js/mapa.js
//  Muestra todos los destinos geolocalizados del cuestionario como marcadores
//  con popup enriquecido: foto(s), URL, precio, distancia al punto de partida
//  y nº de votos del grupo. Incluye editor del punto de partida común.
//  Requiere: leaflet CSS/JS (index.html), helpers de types.js (geoDeOp,
//  haversineKm, fmtKm, puntoPartida, setPuntoPartida, optKmFromSchema).
// ══════════════════════════════════════════════════════════════════════════

var LS_FOTO_EXTRA = 'viajes:fotoExtra';   // foto opcional por opción: {qid|nombre: url}
var _mapaInstance = null;
var _mapaLayer    = null;

function getFotosExtra() {
  try { return JSON.parse(localStorage.getItem(LS_FOTO_EXTRA) || '{}'); } catch (e) { return {}; }
}
function setFotoExtra(qid, nombre, url) {
  try {
    const m = getFotosExtra();
    const k = qid + '||' + nombre;
    if (url) m[k] = url; else delete m[k];
    localStorage.setItem(LS_FOTO_EXTRA, JSON.stringify(m));
  } catch (e) {}
}
function fotoExtraFor(qid, nombre) {
  return getFotosExtra()[qid + '||' + nombre] || '';
}

// Recoge todas las opciones geolocalizables del esquema (checkbox, casas, radio…)
// junto con los votos del grupo sobre cada una.
function collectGeoDestinations() {
  const out = [];
  (schema || []).forEach(q => {
    if (!Array.isArray(q.opciones)) return;
    q.opciones.forEach(op => {
      const geo = geoDeOp(op);
      if (!geo) return;
      const nombre = optVal(q, op);
      const obj    = (op && typeof op === 'object') ? op : {};
      const fotos  = [safeUrl(obj.foto), safeUrl(fotoExtraFor(q.id, nombre))].filter(Boolean);
      out.push({
        qid: q.id,
        pregunta: q.label,
        nombre,
        geo,
        precio: obj.precio || '',
        url: safeUrl(obj.url),
        fotos,
        km: optKmFromSchema(op),
        voters: [],
      });
    });
  });

  // Votos actuales del grupo (respuesta enviada o mi borrador hidratado)
  const countVotes = (r, q, dest) => {
    const v = extractAnswer(r.answers || {}, q);
    if (v == null) return false;
    if (q.tipo === 'voto-ponderado') return Number(v[dest.nombre]) > 0;
    if (q.tipo === 'casas') return Array.isArray(v) && v.some(c => (typeof c === 'string' ? c : c.nombre) === dest.nombre);
    if (Array.isArray(v)) return v.includes(dest.nombre);
    return String(v) === dest.nombre;
  };
  out.forEach(dest => {
    const q = schema.find(x => x.id === dest.qid);
    if (!q) return;
    (respuestas || []).forEach(r => {
      if (countVotes(r, q, dest)) dest.voters.push(r.nombre);
    });
  });
  return out;
}

function renderMapPopup(d, enSolucion) {
  const parts = [];
  parts.push(`<b style="font-size:0.95rem">${esc(d.nombre)}</b>`);
  parts.push(`<div style="font-size:0.72rem;color:#666;margin-bottom:4px">${esc(d.pregunta)}</div>`);
  if (d.fotos.length) {
    parts.push(`<img src="${esc(d.fotos[0])}" alt="" style="width:180px;max-height:110px;object-fit:cover;border-radius:6px;display:block;margin-bottom:6px" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`);
  }
  const meta = [];
  if (d.precio) meta.push(`Precio: ${esc(d.precio)}`);
  if (d.km != null) meta.push(`${fmtKm(d.km)} desde salida`);
  if (meta.length) parts.push(`<div style="font-size:0.8rem;margin-bottom:4px">${meta.join(' · ')}</div>`);
  if (d.url) parts.push(`<div style="margin-bottom:4px"><a href="${esc(d.url)}" target="_blank" rel="noopener">Enlace externo</a></div>`);
  parts.push(`<div style="font-size:0.78rem">${d.voters.length ? 'Votado por: ' + d.voters.map(esc).join(', ') : 'Sin votos aún'}</div>`);
  if (enSolucion) {
    parts.push(`<div style="font-size:0.75rem;color:#2f855a;margin-top:4px">Incluido en una solución factible del grupo</div>`);
  }
  return parts.join('');
}

function ensureMap(mapHost) {
  if (_mapaInstance) return;
  _mapaInstance = L.map(mapHost, { scrollWheelZoom: true }).setView([40.4168, -3.7038], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(_mapaInstance);
  _mapaLayer = L.layerGroup().addTo(_mapaInstance);
}

function refreshMapMarkers() {
  if (!_mapaInstance || !_mapaLayer) return;
  _mapaLayer.clearLayers();
  const dests = collectGeoDestinations();

  // Soluciones del motor: los destinos presentes en alguna solución factible
  // se marcan con borde destacado para poder ver el mapa "con soluciones".
  let nombresSolucion = new Set();
  try {
    if (typeof buildModelData === 'function' && typeof ejecutarMotorFactibilidad === 'function') {
      const model = buildModelData();
      const { soluciones } = ejecutarMotorFactibilidad(model);
      nombresSolucion = new Set(soluciones.flatMap(s => s.asistentesNucleo.concat(s.satelitesAsignados)));
      window._solucionesMapa = soluciones; // accesible desde el popup
    }
  } catch (e) { /* el mapa funciona aunque el motor falle */ }

  dests.forEach(d => {
    const enSolucion = d.voters.some(n => nombresSolucion.has(n));
    const mk = L.marker([d.geo.lat, d.geo.lng], {
      opacity: enSolucion ? 1 : 0.75,
    }).addTo(_mapaLayer);
    mk.bindPopup(renderMapPopup(d, enSolucion));
  });

  const origin = puntoPartida();
  if (origin) {
    L.circleMarker([origin.lat, origin.lng], {
      radius: 8, color: '#b7791f', fillColor: '#f6e05e', fillOpacity: 0.9,
    }).addTo(_mapaLayer).bindPopup('<b>Punto de partida del grupo</b>');
  }

  const pts = dests.map(d => [d.geo.lat, d.geo.lng]);
  if (origin) pts.push([origin.lat, origin.lng]);
  if (pts.length === 1) _mapaInstance.setView(pts[0], 12);
  else if (pts.length > 1) _mapaInstance.fitBounds(L.latLngBounds(pts).pad(0.2));
}

// ── Editor del punto de partida común ───────────────────────────────────────
function buildOriginEditor(host) {
  host.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:0.85rem">
      <label>Punto de partida comun del grupo:</label>
      <input type="text" class="mp-origen-q" placeholder="Calle, ciudad o «40.4168,-3.7038»" style="flex:1;min-width:180px;padding:6px 8px">
      <button type="button" class="btn-pc mp-origen-buscar">Fijar</button>
      <button type="button" class="btn-pc mp-origen-geo" title="Usar mi ubicación actual">Mi ubicacion</button>
      <button type="button" class="btn-pc mp-origen-clear">Borrar</button>
      <span class="mp-origen-status" style="color:var(--muted);font-size:0.78rem"></span>
    </div>`;

  const inp = host.querySelector('.mp-origen-q');
  const status = host.querySelector('.mp-origen-status');
  const p = puntoPartida();
  if (p) inp.placeholder = `Actual: ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} («${p.texto || ''}»)`;

  const fijar = (coords, texto) => {
    setPuntoPartida({ lat: coords.lat, lng: coords.lng, texto: texto || '' });
    status.textContent = 'Origen actualizado';
    refreshMapMarkers();
    if (typeof renderAllQuestions === 'function') renderAllQuestions();
    if (typeof restoreDraft === 'function') restoreDraft();
    if (activeMode === 'consensus' && typeof renderReformulario === 'function') renderReformulario();
  };

  host.querySelector('.mp-origen-buscar').addEventListener('click', async () => {
    const q = inp.value.trim();
    if (!q) { status.textContent = 'Escribe algo que buscar'; return; }
    const c = parseCoordStr(q);
    if (c) { fijar(c, q); return; }
    status.textContent = 'Buscando…';
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), {
        headers: { 'Accept-Language': 'es' },
      });
      const arr = await res.json();
      if (arr && arr.length) fijar({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) }, arr[0].display_name);
      else status.textContent = 'Sin resultados';
    } catch (e) { status.textContent = 'Error de red'; }
  });

  host.querySelector('.mp-origen-geo').addEventListener('click', () => {
    if (!navigator.geolocation) { status.textContent = 'Geolocalización no disponible'; return; }
    status.textContent = 'Localizando…';
    navigator.geolocation.getCurrentPosition(
      pos => fijar({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'Mi ubicación'),
      () => { status.textContent = 'Permiso denegado'; }
    );
  });

  host.querySelector('.mp-origen-clear').addEventListener('click', () => {
    setPuntoPartida(null);
    status.textContent = 'Origen borrado';
    refreshMapMarkers();
  });
}

// ── Construcción de la vista completa ───────────────────────────────────────
function buildMapView(container) {
  container.innerHTML = '';

  const card = div('card');
  card.innerHTML = `
    <div class="card-title"><span class="num">M</span> Mapa de destinos</div>
    <p style="font-size:0.82rem;color:var(--muted);margin-bottom:10px">
      Todos los destinos geolocalizados del cuestionario (fotos, enlaces, precios y distancia al punto de partida).
      Haz clic en un marcador para ver la ficha completa. Las coordenadas se fijan editando cada opción (editor de opcion, campo Destino).
    </p>`;
  const originHost = div('mp-origin-editor');
  originHost.style.marginBottom = '10px';
  card.appendChild(originHost);

  const mapHost = div('map-view');
  mapHost.style.cssText = 'height:420px;border-radius:10px;border:1px solid var(--border);z-index:0';
  card.appendChild(mapHost);
  container.appendChild(card);

  if (typeof L === 'undefined') {
    mapHost.innerHTML = '<p style="padding:16px;color:var(--accent)">Leaflet no está cargado (comprueba tu conexión CDN).</p>';
    return;
  }

  ensureMap(mapHost);
  setTimeout(() => _mapaInstance.invalidateSize(), 60);
  buildOriginEditor(originHost);
  refreshMapMarkers();
}
