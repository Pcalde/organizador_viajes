// ── AUTH / SESIÓN ───────────────────────────────────────────────────────────

function showLoginErr(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function normEid(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Enlace para compartir: https://…/?e=<id-de-encuesta>
function eidDeLaUrl() {
  const e = new URLSearchParams(location.search).get('e');
  return e ? normEid(e.trim()) : '';
}

async function handleLogin() {
  const nombre = $('login-nombre').value.trim();
  const pin    = $('login-pin').value.trim();
  const eid    = normEid($('login-eid').value.trim());
  const btn    = $('btn-login');
  const recordar = $('login-recordar') ? $('login-recordar').checked : true;

  $('login-error').style.display = 'none';
  if (!nombre)        { showLoginErr('Escribe tu nombre'); return; }
  // El PIN admite dígitos y letras (mín. 4); la fuerza bruta se frena en el
  // servidor (límite de intentos + bcrypt), no con reglas client-side.
  if (pin.length < 4) { showLoginErr('El PIN debe tener al menos 4 caracteres'); return; }
  if (!eid)           { showLoginErr('Introduce el ID de la encuesta'); return; }

  btn.textContent = 'Cargando…'; btn.disabled = true;
  try {
    const pinHash = await sha256(pin + '|' + eid);
    const res     = await api({ action: 'entrar', eid, nombre, pinHash });
    user = { nombre: res.nombre, pinHash, eid }; // nombre canónico (el servidor ignora mayúsculas)
    // La credencial persiste SOLO cifrada con un secreto aleatorio de sesión
    // (nunca en claro). Con "recordar" desmarcado no se escribe nada en disco.
    await beginSession(res.nombre, eid, pinHash, { persist: recordar });
    lastRaw = JSON.stringify(res.datos);
    applyData(res.datos);
    enterSurvey();
  } catch (e) {
    console.warn('Login:', e);
    showLoginErr(e.message);
    btn.textContent = 'Entrar →'; btn.disabled = false;
  } finally {
    $('login-pin').value = '';   // el PIN no permanece en el DOM
  }
}

function tryRestoreSession() {
  // En localStorage solo hay: nombre, eid, token y el pinHash CIFRADO con un
  // secreto aleatorio de esta instalación (inutilizable sin él, y el secreto
  // va sellado bajo el token). Otro dispositivo no tiene nada de esto: allí
  // siempre se pide el PIN.
  const saved = getSavedSession();
  if (!saved) return;
  // Un enlace con ?e=<otra encuesta> manda sobre la sesión guardada
  const deLink = eidDeLaUrl();
  if (deLink && deLink !== saved.eid) return;

  $('login-nombre').value = saved.nombre;
  $('login-eid').value    = saved.eid;

  getSessionPinHash(saved.eid, saved.nombre).then(async pinHash => {
    if (!pinHash) return;                       // sin credencial: login manual
    const btn = $('btn-login');
    btn.textContent = 'Cargando…'; btn.disabled = true;
    try {
      const datos = await api({ action: 'get_all', eid: saved.eid, nombre: saved.nombre, pinHash });
      user = { nombre: saved.nombre, pinHash, eid: saved.eid };
      lastRaw = JSON.stringify(datos);
      applyData(datos);
      enterSurvey();
    } catch (e) {
      console.warn('Restaurar sesión:', e);
      user = null;
      clearSession();
      showLoginErr('Sesión caducada: vuelve a introducir tu PIN.');
      btn.textContent = 'Entrar →'; btn.disabled = false;
    }
  });
}

function enterSurvey() {
  $('login-screen').style.display  = 'none';
  $('survey-screen').style.display = 'block';
  $('utag-nombre').textContent = user.nombre;
  $('utag-eid').textContent    = '#' + user.eid;
  resetAusencias();
  renderAllQuestions();
  renderAusencias();
  restoreDraft();
  startPolling();
}

function logout() {
  stopPolling();
  clearTimeout(saveTimer);
  clearSession();                       // revoca + borra el registro cifrado
  try { localStorage.removeItem(LS_USER); } catch (e) {}  // clave legada v2
  _resetUiToLogin('');
  user = null;
}

// Cierre de sesión no voluntario (revocado en otra pestaña): el registro ya
// fue revocado, solo hay que volver al login con un aviso.
function forcedLogout(msg) {
  stopPolling();
  clearTimeout(saveTimer);
  user = null;
  _resetUiToLogin(msg);
}

function _resetUiToLogin(msg) {
  schema = []; proscontras = []; respondentes = []; ausencias = []; lastRaw = '';
  resetAusencias();
  $('questions-container').innerHTML = '';
  $('ausencias-card').style.display  = 'none';
  $('survey-screen').style.display   = 'none';
  $('login-screen').style.display    = 'flex';
  const btn = $('btn-login');
  btn.textContent = 'Entrar →'; btn.disabled = false;
  if (msg) showLoginErr(msg);
}

function bindAuth() {
  const deLink = eidDeLaUrl();
  if (deLink) $('login-eid').value = deLink;
  $('btn-login').addEventListener('click', handleLogin);
  ['login-nombre', 'login-pin', 'login-eid'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); })
  );
  $('btn-logout').addEventListener('click', logout);
}