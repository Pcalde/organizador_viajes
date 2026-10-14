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

  $('login-error').style.display = 'none';
  if (!nombre)        { showLoginErr('Escribe tu nombre'); return; }
  if (pin.length < 4) { showLoginErr('El PIN debe tener al menos 4 dígitos'); return; }
  if (!eid)           { showLoginErr('Introduce el ID de la encuesta'); return; }

  btn.textContent = 'Cargando…'; btn.disabled = true;
  try {
    const pinHash = await sha256(pin + '|' + eid);
    const res     = await api({ action: 'entrar', eid, nombre, pinHash });
    user = { nombre: res.nombre, pinHash, eid }; // nombre canónico (el servidor ignora mayúsculas)
    try { localStorage.setItem(LS_USER, JSON.stringify(user)); } catch (e) {}
    lastRaw = JSON.stringify(res.datos);
    applyData(res.datos);
    enterSurvey();
  } catch (e) {
    console.warn('Login:', e);
    showLoginErr(e.message);
    btn.textContent = 'Entrar →'; btn.disabled = false;
  }
}

function tryRestoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_USER) || 'null');
    if (!(saved && saved.nombre && saved.pinHash && saved.eid)) return;
    // Un enlace con ?e=<otra encuesta> manda sobre la sesión guardada
    const deLink = eidDeLaUrl();
    if (deLink && deLink !== saved.eid) return;
    $('login-nombre').value = saved.nombre;
    $('login-eid').value    = saved.eid;
    const btn = $('btn-login');
    btn.textContent = 'Cargando…'; btn.disabled = true;
    api({ action: 'entrar', eid: saved.eid, nombre: saved.nombre, pinHash: saved.pinHash })
      .then(res => {
        user = { ...saved, nombre: res.nombre };
        lastRaw = JSON.stringify(res.datos);
        applyData(res.datos);
        enterSurvey();
      })
      .catch(e => {
        user = null;
        try { localStorage.removeItem(LS_USER); } catch (_) {}
        showLoginErr(e.message);
        btn.textContent = 'Entrar →'; btn.disabled = false;
      });
  } catch (e) {}
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
  try { localStorage.removeItem(LS_USER); } catch (e) {}
  user = null; schema = []; proscontras = []; respondentes = []; ausencias = []; lastRaw = '';
  resetAusencias();
  $('questions-container').innerHTML = '';
  $('ausencias-card').style.display  = 'none';
  $('survey-screen').style.display   = 'none';
  $('login-screen').style.display    = 'flex';
  const btn = $('btn-login');
  btn.textContent = 'Entrar →'; btn.disabled = false;
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