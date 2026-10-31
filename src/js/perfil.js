// ══════════════════════════════════════════════════════════════════════════
//  PERFIL LOCAL Y PANTALLA «MIS VIAJES» (js/perfil.js)
//
//  Perfil guardado en localStorage: nombre + contraseña local. La contraseña
//  NUNCA se guarda en claro: se deriva con PBKDF2-SHA256 (100 000 iteraciones,
//  salt aleatorio de 16 bytes) y solo se persiste el derivado. Ese derivado
//  cifra la credencial de cada viaje (pinHash = sha256(PIN|eid)), de modo que
//  el localStorage no contiene ninguna credencial utilizable sin la contraseña.
//
//  Lista de viajes (#trips-list): por cada eid guardado se comprueba en el
//  servidor si sigue vivo (action 'all' con pinHash descifrado); los muertos
//  ofrecen eliminarlos de la lista.
//
//  Orden de pantallas: trips-screen ⇄ login-screen ⇄ survey-screen.
//  main.js decide cuál mostrar; este módulo expone:
//    · initPerfil()          → pinta #trips-list y enlaza los controles
//    · showTripsScreen()     → vuelve a «Mis viajes» (recarga credenciales)
//    · hideTripsScreen()     → oculta la pantalla (al entrar en un viaje)
//    · perfilEstaActivo()    → ¿hay perfil local?
//    · salirDelPerfil()      → borra perfil y viajes del dispositivo
//  Requiere: config.js, crypto.js, api.js, sesion.js, auth.js (normEid).
// ══════════════════════════════════════════════════════════════════════════

var LS_PROFILE   = 'viaje_perfil_v1';    // { nombre, salt, derived(b64), viajes:{eid:{alias,ts}} }
var LS_CRED_VAULT= 'viaje_credvault_v1'; // { eid: "ivHex.ctHex" } — pinHash cifrado con la contraseña

// `var` a propósito (script clásico compartido con el resto de módulos).
var _perfil = { activo: false, nombre: '', clave: null }; // clave SOLO en memoria

// ── derivación de clave (PBKDF2) ────────────────────────────────────────────
async function _deriveKeyB64(password, saltB64) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: _b64url2ab(saltB64), iterations: 100000, hash: 'SHA-256' },
    base, 256);
  return _ab2b64url(bits);
}

// ── almacenamiento ──────────────────────────────────────────────────────────
function _loadProfileStore() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PROFILE) || 'null');
    return (p && p.nombre && p.salt && p.derived) ? p : null;
  } catch (e) { return null; }
}
function _saveProfileStore(p) {
  try { localStorage.setItem(LS_PROFILE, JSON.stringify(p)); } catch (e) {}
}
function _loadVault() {
  try { return JSON.parse(localStorage.getItem(LS_CRED_VAULT) || '{}') || {}; }
  catch (e) { return {}; }
}
function _saveVault(v) {
  try { localStorage.setItem(LS_CRED_VAULT, JSON.stringify(v)); } catch (e) {}
}

// alias (nombre legible) de un viaje guardado
function _tripAlias(eid) {
  const p = _loadProfileStore();
  return (p && p.viajes && p.viajes[eid] && p.viajes[eid].alias) || '';
}

// ── alta de perfil / registro de viaje ──────────────────────────────────────
// Llamado desde main.js al crear un viaje desde cero (con contraseña nueva).
async function crearPerfilLocal(nombre, password) {
  const salt = randomHex(16);
  const derived = await _deriveKeyB64(password, salt);
  // Viajes preexistentes en el almacén v3 (sesión legacy guardada): se
  // adoptan al perfil nuevo para no perder accesos al fijar la contraseña.
  const viajes = {};
  try {
    const s = getSavedSessionRaw();
    if (s && s.eid) viajes[s.eid] = { alias: '', ts: Date.now() };
  } catch (e) {}
  const p = { nombre, salt, derived, viajes };
  _saveProfileStore(p);
  _perfil.activo = true; _perfil.nombre = nombre; _perfil.clave = derived;
}

// Registra un viaje en el perfil y guarda su credencial CIFRADA con la clave
// del perfil (derivada de la contraseña introducida en `password`).
async function registrarViaje(eid, password, alias) {
  eid = normEid(eid || '');
  if (!eid) return false;
  let p = _loadProfileStore();
  if (!p) {
    // Primer viaje con sesión ya iniciada (login normal): el usuario debe
    // fijar ahora su contraseña local para poder guardar el acceso.
    if (!password) return false;
    await crearPerfilLocal((user && user.nombre) || 'Yo', password);
    p = _loadProfileStore();
  } else if (password) {
    // Verifica la contraseña antes de escribir nada en el monedero.
    const d = await _deriveKeyB64(password, p.salt);
    if (d !== p.derived) throw new Error('La contraseña del perfil no es correcta.');
    _perfil.clave = d;
  }
  if (!_perfil.clave) {
    const d = await _deriveKeyB64(password || '', p.salt);
    if (d !== p.derived) throw new Error('Se necesita la contraseña del perfil para guardar el viaje.');
    _perfil.clave = d;
  }
  _perfil.activo = true; _perfil.nombre = p.nombre;
  const pinHash = (user && user.pinHash) || await getSessionPinHash(eid, p.nombre);
  if (pinHash) {
    const vault = _loadVault();
    const salt = eid + '|' + Date.now();
    vault[eid] = await aesEncrypt(_perfil.clave, pinHash, salt);
    vault[eid + '|salt'] = salt;
    _saveVault(vault);
  }
  p.viajes = p.viajes || {};
  p.viajes[eid] = { alias: String(alias || '').slice(0, 60), ts: Date.now() };
  _saveProfileStore(p);
  return true;
}

// ── desbloqueo / lectura de credenciales ────────────────────────────────────
async function unlockPerfil(password) {
  const p = _loadProfileStore();
  if (!p) return false;
  const derived = await _deriveKeyB64(password || '', p.salt);
  if (derived !== p.derived) return false;
  _perfil.activo = true; _perfil.nombre = p.nombre; _perfil.clave = derived;
  return true;
}

async function getCredViaje(eid) {
  const vault = _loadVault();
  const ct = vault[eid];
  if (!ct) return null;
  if (!_perfil.clave) return null;
  try {
    const hex = await aesDecrypt(_perfil.clave, ct, vault[eid + '|salt'] || eid);
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch (e) { return null; }
}

function perfilEstaActivo()  { return !!(_perfil.activo && _perfil.clave); }
function perfilNombre()      { return _perfil.nombre; }
function viajesGuardados() {
  const p = _loadProfileStore();
  return (p && p.viajes) ? p.viajes : {};
}

// ── pantalla «Mis viajes» ───────────────────────────────────────────────────
function tripsErr(msg) {
  const el = $('trips-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function _extraerEid(txt) {
  txt = String(txt || '').trim();
  const m = txt.match(/[?&]e=([^&#\s]+)/);        // enlace de invitación completo
  if (m) return normEid(decodeURIComponent(m[1]));
  return normEid(txt);
}

// Abre #login-screen en modo «Entrar» con el eid (y el nombre del perfil)
// pre-rellenados. Se usa cuando la entrada silenciosa desde «Mis viajes»
// falla porque el PIN cambió o la credencial caducó.
function abrirLoginParaViaje(eid, alias) {
  hideTripsScreen();
  $('survey-screen').style.display = 'none';
  const scr = $('login-screen');
  if (!scr) return;
  scr.style.display = 'flex';
  if (typeof setLoginMode === 'function') setLoginMode(false);
  const t = $('login-eid');
  if (t) t.value = eid;
  const n = $('login-nombre');
  if (n && !n.value) n.value = _perfil.nombre || '';
  const errEl = $('login-error');
  if (errEl) {
    errEl.textContent = `Vuelve a introducir el PIN de «${alias || eid}» para actualizar el acceso guardado.`;
    errEl.style.display = 'block';
  }
  const p = $('login-pin');
  if (p) setTimeout(() => p.focus(), 60);
}

function renderTripsList() {
  const host = $('trips-list');
  if (!host) return;
  host.innerHTML = '';
  const viajes = viajesGuardados();
  const eids = Object.keys(viajes);
  if (!eids.length) {
    host.innerHTML = '<div class="trips-empty">Todavía no tienes viajes guardados. Crea uno o únete a uno con su código.</div>';
    return;
  }
  eids.sort((a, b) => (viajes[b].ts || 0) - (viajes[a].ts || 0));
  eids.forEach(eid => {
    const row = div('trips-item');
    const nom = document.createElement('span');
    nom.className = 'trips-item-nombre';
    nom.innerHTML = `<strong>${esc(viajes[eid].alias || eid)}</strong>` +
      (viajes[eid].alias ? `<em>#${esc(eid)}</em>` : '');
    const tools = div('trips-item-tools');

    const btnEntrar = document.createElement('button');
    btnEntrar.type = 'button'; btnEntrar.className = 'btn-propose trips-btn-entrar';
    btnEntrar.textContent = 'Entrar →';
    btnEntrar.addEventListener('click', async () => {
      if (!_perfil.clave) { tripsErr('Introduce primero tu contraseña del perfil.'); return; }
      btnEntrar.disabled = true; btnEntrar.textContent = 'Comprobando…';
      const pinHash = await getCredViaje(eid);
      if (!pinHash) {
        btnEntrar.disabled = false; btnEntrar.textContent = 'Entrar →';
        tripsErr('No se pudo descifrar la credencial: vuelve a introducir la contraseña del perfil.');
        return;
      }
      try {
        // Entrada silenciosa: el pinHash del monedero cifra una sesión v3 con
        // un secreto nuevo en memoria (mismo mecanismo que el login normal).
        setSessionSecret(randomHex(32));
        const datos = await api({ action: 'all', eid, nombre: _perfil.nombre, pinHash });
        user = { nombre: _perfil.nombre, pinHash, eid };
        await beginSession(_perfil.nombre, eid, pinHash, { persist: true });
        lastRaw = JSON.stringify(datos);
        applyData(datos);
        hideTripsScreen();
        enterSurvey();
      } catch (e) {
        setSessionSecret(null);
        btnEntrar.disabled = false; btnEntrar.textContent = 'Entrar →';
        const muerto = /no existe|not found|404|registrado/i.test(String(e.message || ''));
        if (muerto) {
          row.classList.add('trips-dead');
          tripsErr(`El viaje «${eid}» ya no existe en el servidor. Puedes quitarlo de la lista (🗑).`);
        } else {
          // PIN cambiado u otra causa: se abre el login con el eid relleno.
          abrirLoginParaViaje(eid, viajes[eid].alias || '');
        }
      }
    });
    tools.appendChild(btnEntrar);

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button'; btnCopy.className = 'btn-propose trips-btn-copy';
    btnCopy.title = 'Copiar enlace de invitación de «' + (viajes[eid].alias || eid) + '»';
    btnCopy.textContent = '🔗 Copiar enlace';
    btnCopy.addEventListener('click', async () => {
      const url = location.origin + location.pathname + '?e=' + encodeURIComponent(eid);
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; }
      catch (e) {
        // Fallback para navegadores sin API de portapapeles (o sin HTTPS).
        try {
          const ta = document.createElement('textarea');
          ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch (e2) { ok = false; }
      }
      btnCopy.textContent = ok ? '✓ ¡Copiado!' : '⚠ ' + url;
      setTimeout(() => { btnCopy.textContent = '🔗 Copiar enlace'; }, 2500);
    });
    tools.appendChild(btnCopy);

    const btnDel = document.createElement('button');
    btnDel.type = 'button'; btnDel.className = 'sec-rail-tool sec-rail-delete';
    btnDel.title = 'Quitar «' + (viajes[eid].alias || eid) + '» de la lista (no borra el viaje del servidor)';
    btnDel.textContent = '🗑';
    btnDel.addEventListener('click', () => {
      const p = _loadProfileStore();
      if (!p) return;
      delete p.viajes[eid];
      _saveProfileStore(p);
      const vault = _loadVault();
      delete vault[eid]; delete vault[eid + '|salt'];
      _saveVault(vault);
      renderTripsList();
    });
    tools.appendChild(btnDel);

    row.append(nom, tools);
    host.appendChild(row);
  });
}

function showTripsScreen() {
  const scr = $('trips-screen');
  if (!scr) return;
  const ls = $('login-screen'), ss = $('survey-screen');
  if (ls) ls.style.display = 'none';
  if (ss) ss.style.display = 'none';
  stopPolling();
  clearTimeout(saveTimer);
  scr.style.display = 'flex';
  const n = $('trips-nombre');
  if (n) n.textContent = _perfil.nombre || '—';
  // Si el perfil está bloqueado (sin clave en memoria), mostrar la tarjeta de
  // contraseña y ocultar la lista hasta desbloquear.
  const chk = $('trips-check-card'), main = $('trips-main-card');
  if (_perfil.clave) {
    if (chk) chk.style.display = 'none';
    if (main) main.style.display = '';
  } else {
    if (chk) chk.style.display = '';
    if (main) main.style.display = 'none';
    const cn = $('trips-check-nombre');
    if (cn) cn.textContent = _perfil.nombre ? '· ' + _perfil.nombre : '';
    const pass = $('trips-pass');
    if (pass) setTimeout(() => pass.focus(), 60);
  }
  renderTripsList();
  tripsErr('');
}
function hideTripsScreen() {
  const scr = $('trips-screen');
  if (scr) scr.style.display = 'none';
}

function salirDelPerfil() {
  stopPolling();
  clearTimeout(saveTimer);
  clearSession();                                   // revoca la sesión v3
  setSessionSecret(null);
  try { localStorage.removeItem(LS_USER); } catch (e) {}  // clave legada v2
  Object.keys(viajesGuardados()).forEach(eid => {
    try { localStorage.removeItem(LS_DRAFT(eid)); } catch (e) {}
  });
  localStorage.removeItem(LS_PROFILE);
  localStorage.removeItem(LS_CRED_VAULT);
  _perfil.activo = false; _perfil.nombre = ''; _perfil.clave = null;
  user = null;
  schema = []; proscontras = []; respondentes = []; ausencias = []; lastRaw = '';
  resetAusencias();
  const qc = $('questions-container'); if (qc) qc.innerHTML = '';
  const ac = $('ausencias-card'); if (ac) ac.style.display = 'none';
  const sv = $('survey-screen'); if (sv) sv.style.display = 'none';
  const tr = $('trips-screen');  if (tr) tr.style.display = 'none';
  const lg = $('login-screen');  if (lg) lg.style.display = 'flex';
  const btn = $('btn-login');
  if (btn) { btn.textContent = 'Entrar →'; btn.disabled = false; }
}

// «Logout suave» (botón ⌂): cierra la encuesta pero CONSERVA el perfil local.
function volverATrips() {
  stopPolling();
  clearTimeout(saveTimer);
  clearSession();                                   // revoca la sesión v3
  setSessionSecret(null);
  user = null;
  schema = []; proscontras = []; respondentes = []; ausencias = []; lastRaw = '';
  resetAusencias();
  const qc = $('questions-container'); if (qc) qc.innerHTML = '';
  const ac = $('ausencias-card'); if (ac) ac.style.display = 'none';
  showTripsScreen();
}

// ¿Existe perfil local en disco (aunque esté bloqueado)? — para el arranque.
function hayPerfilLocal() { return !!_loadProfileStore(); }

// Carga los datos NO sensibles del perfil (nombre y lista de viajes) sin
// descifrar nada: sirve para pintar «Mis viajes» con la tarjeta de bloqueo.
function initPerfil() {
  const p = _loadProfileStore();
  if (p) { _perfil.activo = true; _perfil.nombre = p.nombre; _perfil.clave = null; }

  const btnCreate = $('btn-trips-create');
  if (btnCreate) btnCreate.addEventListener('click', () => {
    hideTripsScreen();
    const ls = $('login-screen');
    if (ls) ls.style.display = 'flex';
    // El acceso directo del login es solo «Entrar»: la creación de viaje se
    // hace desde «Mis viajes» (main.js → setLoginMode). Aun así, si alguien
    // llega al login por otro camino, el plegable «+ Crear» sigue disponible.
    if (typeof setLoginMode === 'function') setLoginMode(true);
    const inp = $('login-nombre');
    if (inp && !inp.value) inp.value = _perfil.nombre || '';
    const np = $('login-perfil-pass-nueva');
    if (np) setTimeout(() => np.focus(), 60);
  });

  const btnUnir = $('btn-trips-unir');
  const inpEid  = $('trips-eid-input');
  const unirse  = () => {
    const eid = _extraerEid(inpEid && inpEid.value);
    if (!eid) { tripsErr('Introduce un código o enlace de invitación válido.'); return; }
    hideTripsScreen();
    const ls = $('login-screen');
    if (ls) ls.style.display = 'flex';
    // «Unirme» es siempre modo Entrar (con el eid normalizado ya relleno).
    if (typeof setLoginMode === 'function') setLoginMode(false);
    const t = $('login-eid');
    if (t) t.value = eid;
    const n = $('login-nombre');
    if (n && !n.value) n.value = _perfil.nombre || '';
    const pw = $('login-perfil-pass');
    if (pw && _perfil.clave) pw.value = '';   // sin restos de la contraseña local
    const p = $('login-pin');
    if (p) setTimeout(() => p.focus(), 50);
  };
  if (btnUnir) btnUnir.addEventListener('click', unirse);
  if (inpEid)  inpEid.addEventListener('keydown', e => { if (e.key === 'Enter') unirse(); });

  const btnLogout = $('btn-trips-logout');
  if (btnLogout) btnLogout.addEventListener('click', salirDelPerfil);

  // Contraseña del perfil (pantalla de bloqueo)
  const chk  = $('trips-check-card');
  const pass = $('trips-pass');
  const acc  = $('btn-trips-unlock');
  const doUnlock = async () => {
    const ok = await unlockPerfil(pass ? pass.value : '');
    if (!ok) { tripsErr('Contraseña incorrecta.'); if (pass) pass.select(); return; }
    if (pass) pass.value = '';
    tripsErr('');
    showTripsScreen();      // oculta la tarjeta de bloqueo y pinta la lista
  };
  if (acc)  acc.addEventListener('click', doUnlock);
  if (pass) pass.addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
}
