// ══════════════════════════════════════════════════════════════════════════
//  ASISTENTE DEL CUESTIONARIO (js/wizard.js)
//  Divide el cuestionario en secciones (una pregunta por tarjeta) con:
//   · Navegación por secciones dentro del menú lateral (lista de preguntas).
//   · Modo asistente: se ve una pregunta cada vez y se avanza con un botón.
//   · Cada tarjeta muestra además las estadísticas del grupo para esa
//     pregunta (mini-reformulario), sin salir del formulario.
//   · Barra inferior flotante que sigue al usuario al hacer scroll, con el
//     botón de envío siempre visible.
//  Requiere: state.js, questions.js, answers.js, reformulario.js, main.js.
// ══════════════════════════════════════════════════════════════════════════

var WIZ_LS_KEY = 'cuestionador_wizard_v1';

function wizardGetFlag() {
  try { return localStorage.getItem(WIZ_LS_KEY) === '1'; } catch (e) { return false; }
}
function wizardSetFlag(on) {
  surveyWizardMode = !!on;
  try { localStorage.setItem(WIZ_LS_KEY, on ? '1' : '0'); } catch (e) {}
}

// ── Render del reformulario en modo "sección" (una sola pregunta) ───────────
let _refQidOverride = null; // null = todas las preguntas (pestaña completa)

function renderReformSectionFor(qid) {
  const box = $('reform-section-' + qid);
  if (!box || typeof buildAnalyticalCard !== 'function') return;
  const q = schema.find(x => x.id === qid);
  if (!q) { box.innerHTML = ''; return; }
  _refQidOverride = qid;
  try {
    box.innerHTML = '';
    const card = buildAnalyticalCard(q, 0, getMySubmittedAnswers());
    if (card) {
      card.classList.add('ref-card-embedded');
      box.appendChild(card);
    } else {
      box.innerHTML = '<div class="reform-stats-empty">Tipo de pregunta sin estadísticas disponibles todavía.</div>';
    }
  } catch (e) {
    console.warn('No se pudieron calcular las estadísticas de', qid, e);
    box.innerHTML = '';
  } finally {
    _refQidOverride = null;
  }
}

// Repinta todas las secciones visibles (polling, envíos, cambios de esquema…)
function refreshReformSections() {
  document.querySelectorAll('#questions-container > .card[data-qid]')
    .forEach(c => renderReformSectionFor(c.dataset.qid));
}

// El motor del reformulario puede tardar; repintamos las secciones de forma
// agrupada (debounced) cuando llegan datos nuevos.
let _sectionsTimer = null;
function scheduleRefreshSections() {
  clearTimeout(_sectionsTimer);
  _sectionsTimer = setTimeout(() => {
    if (activeMode === 'survey') refreshReformSections();
  }, 350);
}

// ── Envolvente de renderAllQuestions: añade a cada tarjeta su bloque de
//    estadísticas del grupo y aplica la paginación del asistente ─────────────
const _origRenderAllQuestions = (typeof renderAllQuestions === 'function') ? renderAllQuestions : null;
renderAllQuestions = function () {
  if (_origRenderAllQuestions) _origRenderAllQuestions.apply(null, arguments);
  decorateQuestionCards();
  applyWizardPaging();
  updateWizNav();
};

function decorateQuestionCards() {
  const container = $('questions-container');
  if (!container) return;
  [...container.querySelectorAll(':scope > .card[data-qid]')].forEach(card => {
    const qid = card.dataset.qid;
    const q   = schema.find(x => x.id === qid);
    if (!q || q.tipo === 'textarea') return; // tarjeta informativa: sin stats
    let wrap = card.querySelector(':scope > .reform-stats-wrap');
    if (!wrap) {
      wrap = div('reform-stats-wrap');
      wrap.innerHTML = `
        <div class="reform-stats-head">
          <span><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Lo que responde el grupo</span>
          <button type="button" class="btn-link-like btn-toggle-stats">Ocultar</button>
        </div>
        <div class="reform-stats-body" id="reform-section-${esc(qid)}"></div>`;
      card.appendChild(wrap);
      wrap.querySelector('.btn-toggle-stats').addEventListener('click', e => {
        const body = wrap.querySelector('.reform-stats-body');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        e.currentTarget.textContent = hidden ? 'Ocultar' : 'Mostrar';
      });
    }
    renderReformSectionFor(qid);
  });
}

// ── Paginación del asistente (mostrar solo la pregunta activa) ──────────────
function currentWizIndex() {
  const n = Math.max(1, schema.length);
  return Math.min(Math.max(wizIndex, 0), n - 1);
}

function applyWizardPaging() {
  const container = $('questions-container');
  if (!container) return;
  const cards = [...container.querySelectorAll(':scope > .card[data-qid]')];
  const on = surveyWizardMode && activeMode === 'survey';

  // En modo asistente solo se ve la pregunta activa; sin wizard, todas.
  wizIndex = currentWizIndex();
  cards.forEach((c, i) => { c.style.display = (on && i !== wizIndex) ? 'none' : ''; });

  const nav = $('wiz-nav');
  if (nav) nav.style.display = on ? 'flex' : 'none';
  if (!on) return;

  [...container.querySelectorAll(':scope > [data-empty-notice]')].forEach(el => el.remove());

  if (!schema.length) {
    const empty = div('card');
    empty.dataset.emptyNotice = '1';
    empty.innerHTML = `
      <div class="card-title"><span class="num">✨</span> Encuesta en blanco</div>
      <p style="font-size:0.88rem;color:var(--muted)">
        Aún no hay preguntas. Desactiva el modo asistente arriba o pulsa
        <b>«+ Proponer una nueva pregunta al grupo»</b> para empezar.
      </p>`;
    container.appendChild(empty);
    if (nav) nav.style.display = 'none';
    return;
  }

  const label = nav.querySelector('.wiz-label');
  if (label) label.textContent = `${wizIndex + 1} / ${schema.length} · ${schema[wizIndex].label}`;
  const bar = nav.querySelector('.wiz-bar-fill');
  if (bar) bar.style.width = (((wizIndex + 1) / schema.length) * 100) + '%';
  const prev = $('wiz-prev'), next = $('wiz-next');
  if (prev) prev.disabled = wizIndex <= 0;
  if (next) {
    const last = wizIndex >= schema.length - 1;
    next.disabled = false;
    next.innerHTML = last
      ? 'Finalizar <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>'
      : 'Siguiente <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
  }
}

function gotoWizSection(i) {
  wizIndex = Math.min(Math.max(i, 0), Math.max(0, schema.length - 1));
  applyWizardPaging();
  updateWizNav();
  scrollToActiveCard();
}

function nextWizSection() {
  if (wizIndex >= schema.length - 1) {
    showStatus('Has revisado todas las preguntas. Pulsa «Actualizar respuesta» para sincronizar con el grupo.', 'ok', 5000);
    return;
  }
  gotoWizSection(wizIndex + 1);
}
function prevWizSection() { gotoWizSection(wizIndex - 1); }

function scrollToActiveCard() {
  const card = document.querySelector('#questions-container > .card[data-qid]:not([style*="display: none"])');
  if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

// ── Menú lateral: lista de secciones/preguntas ──────────────────────────────
function updateWizNav() {
  const host = $('wiz-nav');
  if (!host) return;
  const show = (activeMode === 'survey');
  host.style.display = show && surveyWizardMode ? 'flex' : show ? 'block' : 'none';

  const items = $('wiz-nav-items');
  if (!items) return;
  items.innerHTML = '';
  if (!schema.length) {
    items.innerHTML = '<div class="wiz-empty">Sin preguntas todavía</div>';
    return;
  }
  schema.forEach((q, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wiz-item' + (surveyWizardMode && i === wizIndex ? ' active' : '');
    b.dataset.i = i;
    const short = q.label.length > 42 ? q.label.slice(0, 42) + '…' : q.label;
    b.innerHTML = `<span class="wiz-num">${i + 1}</span><span class="wiz-txt">${esc(short)}</span>`;
    b.addEventListener('click', () => {
      if (surveyWizardMode) gotoWizSection(i);
      else focusSurveyCard(q.id);
      closeSideNav();
    });
    items.appendChild(b);
  });
}

function focusSurveyCard(qid) {
  switchMode('survey');
  const card = cardFor(qid);
  if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
}

// ── Conmutador del modo asistente ───────────────────────────────────────────
function setWizardUI(on) {
  const swOn = $('wiz-switch-on'), swOff = $('wiz-switch-off');
  if (swOn)  swOn.classList.toggle('active', on);
  if (swOff) swOff.classList.toggle('active', !on);
}

function toggleWizard(on) {
  wizardSetFlag(on);
  setWizardUI(on);
  applyWizardPaging();
  updateWizNav();
}

function bindWizard() {
  // Conmutador On/Off dentro del cuestionario
  const on = $('wiz-switch-on'), off = $('wiz-switch-off');
  if (on)  on.addEventListener('click',  () => toggleWizard(true));
  if (off) off.addEventListener('click', () => toggleWizard(false));

  // Conmutador compacto en el menú lateral
  const sw = $('wiz-mode-switch');
  if (sw) sw.addEventListener('click', () => toggleWizard(!surveyWizardMode));

  const prev = $('wiz-prev'), next = $('wiz-next');
  if (prev) prev.addEventListener('click', prevWizSection);
  if (next) next.addEventListener('click', nextWizSection);

  setWizardUI(surveyWizardMode);
}

// Teclado: ← → para navegar entre secciones en modo asistente
document.addEventListener('keydown', e => {
  if (!surveyWizardMode || activeMode !== 'survey' || !schema.length) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (e.key === 'ArrowRight') nextWizSection();
  if (e.key === 'ArrowLeft')  prevWizSection();
});
