// ── NAVEGACIÓN LATERAL DESPLEGABLE, MODAL DE MAPA Y ARRANQUE (js/main.js) ───

function switchMode(mode) {
  activeMode = mode;

  document.querySelectorAll('#side-menu .mode-tab[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const vSurvey    = $('view-survey');
  const vConsensus = $('view-consensus');
  const vDebate    = $('view-debate');

  if (vSurvey)    vSurvey.style.display    = mode === 'survey'    ? 'flex'  : 'none';
  if (vConsensus) vConsensus.style.display = mode === 'consensus' ? 'block' : 'none';
  if (vDebate)    vDebate.style.display    = mode === 'debate'    ? 'block' : 'none';

  const fab = $('submit-fab');
  if (fab) fab.classList.toggle('visible', mode === 'survey');

  if (typeof applyWizardPaging === 'function') applyWizardPaging();
  if (typeof updateWizNav === 'function')      updateWizNav();

  if (mode === 'consensus' && typeof renderReformulario === 'function') renderReformulario();
  if (mode === 'debate'    && typeof renderDebate === 'function')       renderDebate();

  closeSideNav();
  if (pollActive) schedulePoll(currentPollBaseInterval());
}

// ── MENÚ LATERAL (hamburguesa) ───────────────────────────────────────────────
function openSideNav() {
  const nav = $('side-nav');
  if (!nav) return;
  nav.classList.add('open');
  const bd = $('side-nav-backdrop');
  if (bd) bd.hidden = false;
  const tog = $('side-nav-toggle');
  if (tog) tog.setAttribute('aria-expanded', 'true');
}
function closeSideNav() {
  const nav = $('side-nav');
  if (!nav) return;
  nav.classList.remove('open');
  const bd = $('side-nav-backdrop');
  if (bd) bd.hidden = true;
  const tog = $('side-nav-toggle');
  if (tog) tog.setAttribute('aria-expanded', 'false');
}
function toggleSideNav() {
  const nav = $('side-nav');
  if (nav && nav.classList.contains('open')) closeSideNav(); else openSideNav();
}

// ── MODAL DEL MAPA ───────────────────────────────────────────────────────────
let _mapModalBuilt = false;

function closeMapModal() {
  const backdrop = $('map-modal-backdrop');
  if (backdrop) {
    backdrop.hidden = true;
    backdrop.style.setProperty('display', 'none', 'important');
  }
  document.body.classList.remove('map-modal-open');
}

function ensureModalsClosed() {
  ['map-modal-backdrop', 'account-modal-backdrop'].forEach(id => {
    const bd = $(id);
    if (bd && bd.hidden) bd.style.setProperty('display', 'none', 'important');
  });
  document.body.classList.remove('map-modal-open');
}

function openMapModal() {
  const backdrop = $('map-modal-backdrop');
  const body     = $('map-modal-body');
  if (!backdrop || !body) return;
  backdrop.hidden = false;
  backdrop.style.removeProperty('display');
  document.body.classList.add('map-modal-open');
  if (!_mapModalBuilt && typeof buildMapView === 'function') {
    buildMapView(body);
    _mapModalBuilt = true;
  } else if (typeof refreshMapMarkers === 'function') {
    refreshMapMarkers();
  }
  if (_mapaInstance) setTimeout(() => _mapaInstance.invalidateSize(), 80);
}

function bindMapModal() {
  const backdrop = $('map-modal-backdrop');
  if (!backdrop) return;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeMapModal(); });
  const btnClose = $('map-modal-close');
  if (btnClose) btnClose.addEventListener('click', closeMapModal);
  const btnMap = $('btn-map-modal');
  if (btnMap) btnMap.addEventListener('click', () => { closeSideNav(); openMapModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeMapModal();
      closeSideNav();
      if (typeof closeAccountModal === 'function') closeAccountModal();
    }
  });
}

function bindCreateTripUI() {
  const tabJoin   = $('tab-login-join');
  const tabCreate = $('tab-login-create');
  const extraBox  = $('create-trip-fields');
  const btnLogin  = $('btn-login');
  const btnCreate = $('btn-create-trip');
  if (!tabJoin || !tabCreate) return;

  const setLoginMode = isCreate => {
    tabJoin.classList.toggle('active', !isCreate);
    tabCreate.classList.toggle('active', isCreate);
    if (extraBox)  extraBox.style.display  = isCreate ? 'flex'  : 'none';
    if (btnLogin)  btnLogin.style.display  = isCreate ? 'none'  : 'block';
    if (btnCreate) btnCreate.style.display = isCreate ? 'block' : 'none';
    const errEl = $('login-error');
    if (errEl) errEl.style.display = 'none';
  };

  tabJoin.addEventListener('click',   () => setLoginMode(false));
  tabCreate.addEventListener('click', () => setLoginMode(true));

  if (btnCreate) {
    btnCreate.addEventListener('click', async () => {
      const nombre    = ($('login-nombre')?.value || '').trim();
      const eid       = ($('login-eid')?.value || '').trim().toLowerCase();
      const titulo    = ($('login-titulo')?.value || '').trim() || 'Cuestionario de viaje';
      const plantilla = $('login-plantilla')?.value || 'vacia';

      if (!nombre) { showLoginErr('Introduce tu nombre.'); return; }
      // Sin PIN, el código del viaje es el único "secreto": mejor largo y poco adivinable.
      if (!/^[a-z0-9-]{3,60}$/.test(eid)) { showLoginErr('El código debe tener al menos 3 caracteres (solo minúsculas a-z, números y guiones).'); return; }

      btnCreate.disabled = true;
      btnCreate.textContent = 'Creando viaje…';
      try {
        const pinHash = NO_PIN;
        const res = await api({
          action: 'crear_encuesta',
          eid, nombre, pinHash, plantilla, titulo,
        });

        user = { nombre: res.nombre, pinHash, eid };
        const recordar = $('login-recordar') ? $('login-recordar').checked : true;
        await beginSession(res.nombre, eid, pinHash, { persist: recordar });

        applyData(res.datos);
        $('utag-nombre').textContent = user.nombre;
        $('utag-eid').textContent    = '#' + user.eid;
        $('login-screen').style.display  = 'none';
        $('survey-screen').style.display = 'block';

        renderAllQuestions();
        if (typeof renderAusencias === 'function') renderAusencias();
        if (typeof renderReformulario === 'function') renderReformulario();
        if (typeof renderDebate === 'function') renderDebate();
        startPolling();
      } catch (e) {
        showLoginErr(e.message);
      } finally {
        btnCreate.disabled = false;
        btnCreate.textContent = 'Crear viaje y entrar →';
      }
    });
  }
}

function bindNavigation() {
  document.querySelectorAll('#side-menu .mode-tab[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  const tog = $('side-nav-toggle');
  if (tog) tog.addEventListener('click', toggleSideNav);
  const bd = $('side-nav-backdrop');
  if (bd) bd.addEventListener('click', closeSideNav);
  if (typeof bindMapModal === 'function') bindMapModal();
  if (typeof bindAccountModal === 'function') bindAccountModal();

  const surveyScreen = $('survey-screen');
  if (surveyScreen) {
    const obs = new MutationObserver(() => {
      if (surveyScreen.style.display !== 'none' && user) {
        hydrateFromServerIfNoDraft();
        if (typeof renderAusencias === 'function') renderAusencias();
        if (typeof renderReformulario === 'function') renderReformulario();
        if (typeof renderDebate === 'function') renderDebate();
      }
    });
    obs.observe(surveyScreen, { attributes: true, attributeFilter: ['style'] });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ensureModalsClosed();   // si algo falla al arrancar, la página no queda tapada
  if (typeof wizardGetFlag === 'function') surveyWizardMode = wizardGetFlag();
  bindAuth();
  bindCreateTripUI();
  bindForms();
  bindAusencias();
  bindSubmit();
  bindNavigation();
  if (typeof bindWizard === 'function') bindWizard();
  if (SUPABASE_URL.includes('TU-PROYECTO') || SUPABASE_KEY.startsWith('TU_CLAVE')) {
    showLoginErr('Falta configurar js/config.js (SUPABASE_URL y SUPABASE_KEY).');
    return;
  }
  tryRestoreSession();
});
