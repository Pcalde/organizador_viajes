// ══════════════════════════════════════════════════════════════════════════
//  MODAL "MI CUENTA" — src/js/cuenta.js
//  Permite cambiar nombre y contraseña (PIN) desde el menú lateral, y fijar
//  el punto de partida personal ("¿desde dónde sales el día del viaje?"),
//  que alimenta el mapa (distancias a los destinos) vía setPuntoPartida().
//  Requiere: update_profile (schema.sql), sha256 (crypto.js), session helpers.
// ══════════════════════════════════════════════════════════════════════════
const nuevoPin = ''
function openAccountModal() {
  const backdrop = $('account-modal-backdrop');
  if (!backdrop || !user) return;
  // Prellenar con el estado actual
  $('acc-nombre').value = user.nombre || '';
  const p = puntoPartida();
  $('acc-partida').placeholder = p
    ? `Actual: ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} (${p.texto || 'sin etiqueta'})`
    : 'p.ej. Calle Mayor 1, Madrid';
  $('acc-partida').value = '';
  accountStatus('', 'ok');
  backdrop.hidden = false;
  backdrop.style.removeProperty('display');   // deshace el cierre forzado
}

function closeAccountModal() {
  const backdrop = $('account-modal-backdrop');
  if (backdrop) {
    backdrop.hidden = true;
    // Igual que en el modal del mapa: garantizamos que no quede tapando la página.
    backdrop.style.setProperty('display', 'none', 'important');
  }
}

function accountStatus(msg, kind) {
  const el = $('account-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'account-status' + (msg ? ' show ' + (kind || 'err') : '');
}

async function resolvePartidaCoords() {
  const q = ($('acc-partida')?.value || '').trim();
  if (!q) return null;
  const c = parseCoordStr(q);
  if (c) return { coords: c, texto: q };
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
      + encodeURIComponent(q), { headers: { 'Accept-Language': 'es' } });
    const arr = await res.json();
    if (arr && arr.length) return { coords: { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) }, texto: arr[0].display_name };
  } catch (e) { /* sin red: se ignora el punto de partida */ }
  return { error: 'No se encontró «' + q + '» en el mapa' };
}

async function saveAccountChanges() {
  if (!user) return;
  const btn = $('btn-account-save');
  const nuevoNombre = ($('acc-nombre')?.value || '').trim();

  accountStatus('', 'ok');
  if (!nuevoNombre)              { accountStatus('El nombre no puede estar vacío.'); return; }
  if (nuevoPin && !/^[A-Za-z0-9]{4,8}$/.test(nuevoPin)) {
    accountStatus('La nueva contraseña debe tener entre 4 y 8 caracteres (letras o dígitos).'); return;
  }

  // Resolver primero el punto de partida (si se ha escrito algo) para no
  // llamar al servidor si la geocodificación falla.
  let partida = null;
  const q = ($('acc-partida')?.value || '').trim();
  if (q) {
    accountStatus('Buscando ubicación…', 'ok');
    partida = await resolvePartidaCoords();
    if (partida && partida.error) { accountStatus(partida.error); return; }
  }

  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const id = { eid: user.eid, nombre: user.nombre, pinHash: user.pinHash };
    let finalName = user.nombre;

    const changedName = nuevoNombre !== user.nombre;
    const changedPin  = !!nuevoPin;
    if (changedName || changedPin) {
      const nuevoPinHash = changedPin ? await sha256(nuevoPin + '|' + user.eid) : null;
      const res = await apiPost({
        action: 'update_profile', ...id,
        nuevoNombre: changedName ? nuevoNombre : null,
        nuevoPinHash,
      });
      finalName = res.nombre || nuevoNombre || user.nombre;
      user.nombre = finalName;
      if (changedPin) {
        user.pinHash = nuevoPinHash;
        await storePinHash(user.eid, nuevoPinHash);   // refresca credencial cifrada
      }
      if (changedName) {
        await renameSavedSession(finalName);          // sesión guardada usa el nuevo nombre
        respondentes.forEach(r => { if (r.nombre.toLowerCase() === finalName.toLowerCase()) r.nombre = finalName; });
        respuestas.forEach(r => { if (r.nombre.toLowerCase() === finalName.toLowerCase()) r.nombre = finalName; });
      }
    }

    if (partida && partida.coords) setPuntoPartida({ lat: partida.coords.lat, lng: partida.coords.lng, texto: partida.texto });

    $('utag-nombre').textContent = user.nombre;
    if (typeof renderParticipants === 'function') renderParticipants();
    if (typeof renderAllQuestions === 'function') renderAllQuestions();
    if (typeof restoreDraft === 'function') restoreDraft();
    if (typeof refreshMapMarkers === 'function' && _mapaInstance) refreshMapMarkers();
    if (activeMode === 'consensus' && typeof renderReformulario === 'function') renderReformulario();

    accountStatus('Cambios guardados ✓', 'ok');
    setTimeout(closeAccountModal, 900);
  } catch (e) {
    accountStatus(e.message || 'Error al guardar');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar cambios →';
  }
}

function bindAccountModal() {
  const backdrop = $('account-modal-backdrop');
  if (!backdrop) return;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAccountModal(); });
  const btnClose = $('account-modal-close');
  if (btnClose) btnClose.addEventListener('click', closeAccountModal);

  const btnOpen = $('btn-account-modal');
  if (btnOpen) btnOpen.addEventListener('click', () => { closeSideNav(); openAccountModal(); });

  const btnSave = $('btn-account-save');
  if (btnSave) btnSave.addEventListener('click', saveAccountChanges);

  const btnGeo = $('acc-partida-geo');
  if (btnGeo) btnGeo.addEventListener('click', () => {
    if (!navigator.geolocation) { accountStatus('Geolocalización no disponible en este navegador.'); return; }
    accountStatus('Localizando…', 'ok');
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('acc-partida').value = pos.coords.latitude.toFixed(4) + ',' + pos.coords.longitude.toFixed(4);
        accountStatus('Ubicación actual rellenada: pulsa Guardar cambios.', 'ok');
      },
      () => accountStatus('Permiso de ubicación denegado.')
    );
  });

  const btnLogout = $('btn-account-logout');
  if (btnLogout) btnLogout.addEventListener('click', () => { closeAccountModal(); logout(); });
}
