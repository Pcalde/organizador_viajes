// ══════════════════════════════════════════════════════════════════════════
//  CUESTIONARIO POR SECCIONES (js/secciones.js)
//  Sustituye al antiguo «modo asistente» de wizard.js: el cuestionario es
//  SIEMPRE por secciones (una visible cada vez), sin interruptor.
//
//   · Raíl de secciones a la izquierda (número, título completo en hasta
//     2 líneas, estado ✓ respondida / ● actual / ○ pendiente / ∅ no aplica).
//   · En pantallas <760 px el raíl pasa a chips horizontales con scroll.
//   · Barra inferior fija: ← Anterior · «n de N» · Siguiente → · Enviar.
//   · Condiciones de visibilidad por pregunta: q.config.mostrarSi =
//     {qid, op: 'incluye'|'igual'|'alguno', valor, no?}. Se evalúan sobre el
//     BORRADOR (readState()), solo sobre preguntas anteriores en el orden
//     (así no hay ciclos). Las ocultas se conservan en el borrador pero se
//     excluyen del envío (collectAnswers).
//   · Panel «Ver qué responde el grupo» bajo cada sección, plegado según el
//     ajuste global persistido en localStorage (visible | plegado | esperar).
//
//  Módulo con funciones EXPLÍCITAS llamado desde main.js y enterSurvey():
//  nada de monkeypatching de renderAllQuestions. Cárgalo en index.html
//  después de reformulario.js y antes de auth.js.
//  Requiere: state.js, questions.js, answers.js, reformulario.js, types.js.
// ══════════════════════════════════════════════════════════════════════════

var SEC_LS_GROUPINFO = 'cuestionador_groupinfo_v1'; // 'visible' | 'plegado' | 'esperar'
var SEC_ESTADO = { idx: 0 };                        // índice (sobre schema) de la sección activa

// ── Ajuste global de la información del grupo ───────────────────────────────
function getGroupInfoMode() {
  let m = null;
  try { m = localStorage.getItem(SEC_LS_GROUPINFO); } catch (e) {}
  return ['visible', 'plegado', 'esperar'].includes(m) ? m : 'plegado';
}
function setGroupInfoMode(mode) {
  if (!['visible', 'plegado', 'esperar'].includes(mode)) mode = 'plegado';
  try { localStorage.setItem(SEC_LS_GROUPINFO, mode); } catch (e) {}
  refreshSecciones();
}

// El botón de envío vive en la barra inferior (#sec-submit); #btn-generate se
// mantiene sincronizado para que todo lo existente (bindSubmit, estados) siga
// funcionando sin duplicar lógica.
function syncSubmitBar() {
  const btn = $('btn-generate'), bar = $('sec-submit');
  if (!btn || !bar) return;
  bar.textContent = btn.textContent;
  bar.disabled = btn.disabled;
  bar.classList.toggle('up-to-date', btn.classList.contains('up-to-date'));
}

// ── Editor de condiciones («mostrar si…») ───────────────────────────────────
// Construye un mini-formulario reutilizable: pregunta previa + operador +
// valor (poblado con las opciones de aquella). `onlyBefore` limita la lista de
// preguntas a las que van antes de `qid` en el orden (regla anti-ciclos).
function buildCondEditor(host, schemaArr, currentQid, initial) {
  host.innerHTML = '';
  const cur = initial && typeof initial === 'object' ? initial : null;

  const lbl = document.createElement('label');
  lbl.className = 'cond-editor-title';
  lbl.innerHTML = '<i class="fa-solid fa-code-branch" aria-hidden="true"></i> Mostrar solo si… <span class="cond-hint">(opcional — deja «Sin condición» para mostrar siempre)</span>';

  const grid = div('cond-editor-grid');
  const selQ = document.createElement('select'); selQ.className = 'cond-q';
  const selOp = document.createElement('select'); selOp.className = 'cond-op';
  const selVal = document.createElement('select'); selVal.className = 'cond-val';
  const selNeg = document.createElement('select'); selNeg.className = 'cond-neg';
  selNeg.innerHTML = '<option value="">si</option><option value="1">no</option>';

  // Candidatas: preguntas ANTERIORES a `currentQid` en el orden (regla
  // anti-ciclos). Con `currentQid` vacío (pregunta nueva → se añade al final)
  // cualquier pregunta con opciones sirve. textarea/disponibilidad/horarios
  // no tienen opciones, así que quedan fuera automáticamente.
  const ci = currentQid ? schemaArr.findIndex(x => x.id === currentQid) : -1;
  const candidates = (schemaArr || []).filter((q, i) =>
    q.id !== currentQid && (q.opciones || []).length > 0 &&
    (ci < 0 || i < ci));

  const fillQ = () => {
    selQ.innerHTML = '<option value="">Sin condición</option>' +
      candidates.map(q => `<option value="${esc(q.id)}">${esc(q.label)}</option>`).join('');
    if (cur && cur.qid && candidates.some(q => q.id === cur.qid)) selQ.value = cur.qid;
  };
  // 'alguno' admite una lista de valores; aquí se representa como «incluye
  // CUALQUIERA de…» y se guarda como {op:'alguno', valor:[...]}.
  const OPS_FOR = q =>
    !q ? [] :
    q.tipo === 'checkbox' || q.tipo === 'casas' ? ['incluye', 'alguno'] :
    q.tipo === 'voto-ponderado' ? ['incluye', 'igual', 'alguno'] :
    q.tipo === 'radio' ? ['igual'] : [];

  const fillOps = q => {
    const ops = OPS_FOR(q);
    selOp.innerHTML = ops.map(o => `<option value="${o}">${
      o === 'incluye' ? 'incluye la opción' : o === 'alguno' ? 'incluye CUALQUIERA de…' : 'es exactamente'}</option>`).join('');
    if (cur && q && cur.qid === q.id && ops.includes(cur.op)) selOp.value = cur.op;
  };
  const optValsOf = q => (q && q.opciones ? q.opciones : []).map(op => optVal(q, op));
  const fillVals = q => {
    const vals = optValsOf(q);
    const multi = selOp.value === 'alguno';
    selVal.multiple = multi;
    selVal.size = multi ? Math.min(Math.max(vals.length, 2), 6) : 1;
    selVal.innerHTML = vals.length
      ? vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')
      : '<option value="">(esta pregunta no tiene opciones aún)</option>';
    if (cur && q && cur.qid === q.id) {
      const list = (Array.isArray(cur.valor) ? cur.valor : [cur.valor]).map(String);
      [...selVal.options].forEach(o => { o.selected = list.includes(o.value); });
    }
  };

  const sync = () => {
    const q = candidates.find(x => x.id === selQ.value) || null;
    const on = !!q;
    selOp.disabled = selVal.disabled = selNeg.disabled = !on;
    fillOps(q); fillVals(q);
  };
  selQ.addEventListener('change', sync);
  selOp.addEventListener('change', () => {
    const q = candidates.find(x => x.id === selQ.value) || null;
    if (q) fillVals(q);
  });
  fillQ(); sync();

  grid.append(selQ, selOp, selVal, selNeg);
  host.append(lbl, grid);
  return {
    read() {
      if (!selQ.value) return null;
      const multi = selOp.value === 'alguno';
      const valor = multi
        ? [...selVal.selectedOptions].map(o => o.value).filter(Boolean)
        : selVal.value;
      if (multi && !valor.length) return null; // «alguno» sin valores = sin condición
      if (!multi && !valor) return null;       // pregunta sin opciones aún
      const out = { qid: selQ.value, op: selOp.value || 'incluye', valor };
      if (selNeg.value === '1') out.no = true;
      return out;
    },
    selectIf(qid) { if ([...selQ.options].some(o => o.value === qid)) { selQ.value = qid; sync(); } },
  };
}

// Valida una condición contra el esquema: la pregunta referida debe existir,
// ir ANTES de la propia en el orden y tener opciones compatibles.
// Devuelve null si es válida, o un mensaje de error legible.
function validarMostrarSi(cond, schemaArr, selfId, beforeIdx) {
  if (!cond || !cond.qid) return null; // sin condición = válido
  const bi = beforeIdx == null
    ? schemaArr.findIndex(q => q.id === selfId)
    : beforeIdx;
  const src = schemaArr.find(q => q.id === cond.qid);
  if (!src) return 'La pregunta de la condición ya no existe.';
  const si = schemaArr.findIndex(q => q.id === src.id);
  if (bi >= 0 && si >= bi) return `«${src.label}» debe ir antes de «${(schemaArr[bi] || {}).label || selfId}» en el orden.`;
  if (!['checkbox', 'voto-ponderado', 'radio', 'casas'].includes(src.tipo))
    return 'Las condiciones solo funcionan sobre checkbox, voto ponderado, radio o casas.';
  const vals = (src.opciones || []).map(op => optVal(src, op));
  const list = Array.isArray(cond.valor) ? cond.valor : [cond.valor];
  if (!list.length) return 'Elige al menos un valor para la condición.';
  for (const v of list) {
    if (!vals.includes(String(v)))
      return `El valor «${v}» no es una opción válida de «${src.label}».`;
  }
  return null;
}

// ¿La pregunta `qid` depende (directa o transitivamente) de `depOn`? Se usa
// al reordenar: mover una pregunta por encima de su fuente rompería la regla
// anti-ciclos («solo condiciones sobre preguntas anteriores»).
function condicionDependeDe(schemaArr, qid, depOn) {
  let cur = schemaArr.find(q => q.id === qid);
  const seen = new Set();
  while (cur && cur.config && cur.config.mostrarSi && cur.config.mostrarSi.qid) {
    const next = cur.config.mostrarSi.qid;
    if (next === depOn) return true;
    if (seen.has(next)) return false; // cadena corrupta con ciclo: no decidir
    seen.add(next);
    cur = schemaArr.find(q => q.id === next);
  }
  return false;
}

// ── Visibilidad condicional ─────────────────────────────────────────────────
// Evalúa una respuesta cruda contra la condición. Soporta checkbox/casas
// (array), voto-ponderado (dict; "incluye" ⇒ puntos > 0, "igual" ⇒ el punto
// exacto) y radio (string u objeto {estado}). `valor` puede ser un valor
// suelto o una lista (operador 'alguno').
function _condMatch(raw, op, valor) {
  const list = (Array.isArray(valor) ? valor : [valor]).map(String);
  if (raw == null) return false;
  switch (op) {
    case 'igual':
      if (Array.isArray(raw)) return raw.map(String).some(v => list.includes(v));
      if (typeof raw === 'object') {
        if ('estado' in raw) return list.includes(String(raw.estado));
        // voto-ponderado: la puntuación de alguna opción coincide exactamente
        return Object.entries(raw).some(([k, s]) => list.includes(k) && Number(s) === Number(list[0]));
      }
      return list.includes(String(raw));
    case 'alguno':
      if (Array.isArray(raw)) return raw.some(r => list.includes(String(r)));
      if (typeof raw === 'object') {
        if ('estado' in raw) return list.includes(String(raw.estado));
        const dict = normPond(raw);
        return list.some(k => Number(dict[k]) > 0);
      }
      return list.includes(String(raw));
    case 'incluye':
    default:
      if (Array.isArray(raw)) return raw.map(String).some(v => list.includes(v));
      if (typeof raw === 'object') {
        if ('estado' in raw) return list.includes(String(raw.estado));
        return list.some(k => Number(raw[k]) > 0); // voto-ponderado: puntuación > 0
      }
      return list.includes(String(raw));
  }
}

// ¿Visible según su condición y el borrador de respuestas actual?
// Las cadenas circulares o condiciones rotas se tratan como "visible"
// (fallback seguro: no ocultar contenido por un error de datos).
function esVisible(q, answers) {
  const cond = q && q.config && q.config.mostrarSi;
  if (!cond || !cond.qid) return true;
  const st = answers || readState().answers;
  const guard = st.__guard || (st.__guard = new Set());
  if (guard.has(q.id)) return true;
  guard.add(q.id);
  try {
    // La fuente puede estar condicionada a su vez: se evalúa en cascada.
    const srcQ = schema.find(x => x.id === cond.qid);
    if (srcQ && !esVisible(srcQ, st)) return false;
    const ok = _condMatch(st[cond.qid], cond.op || 'incluye', cond.valor);
    return cond.no ? !ok : ok;
  } catch (e) {
    return true;
  } finally {
    guard.delete(q.id);
  }
}

// Motivo legible por el que una pregunta está oculta (o '' si es visible).
function secRazonOculta(q, answers) {
  const cond = q && q.config && q.config.mostrarSi;
  if (!cond || !cond.qid) return '';
  const st = answers || readState().answers;
  const src = schema.find(x => x.id === cond.qid);
  if (!src) return 'la pregunta de su condición ya no existe';
  if (!esVisible(src, st)) return `porque «${src.label}» tampoco aplica`;
  const valTxt = Array.isArray(cond.valor) ? cond.valor.join(' / ') : String(cond.valor);
  return `porque «${src.label}» ${cond.no ? 'no ' : ''}${cond.op === 'igual' ? 'es' : 'no incluye'} «${valTxt}»`;
}

// Avisa a la tarjeta ACTIVA de que sus respuestas no se enviarán (está oculta
// por condición). Se re-evalúa en cada cambio vía refreshSecciones().
function updateHiddenNotice() {
  const container = $('questions-container');
  if (!container) return;
  [...container.querySelectorAll(':scope > .card[data-qid]')].forEach(card => {
    card.querySelectorAll('.sec-hidden-notice').forEach(n => n.remove());
  });
  const q = schema[SEC_ESTADO.idx];
  if (!q || esVisible(q)) return;
  const card = cardFor(q.id);
  if (!card) return;
  const n = div('sec-hidden-notice');
  n.innerHTML = '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i> <b>No aplica</b> con tus respuestas actuales ' +
    esc(secRazonOculta(q)) + '. Tus cambios se guardan, pero no se envían al grupo.';
  const controls = card.querySelector('.options-list');
  if (controls && controls.parentElement === card) card.insertBefore(n, controls);
  else card.appendChild(n);
}

// Preguntas visibles (referencias reales de `schema`, con su índice original).
function visibleQuestions() {
  let st = null;
  const getSt = () => st || (st = readState());
  const out = [];
  schema.forEach((q, i) => {
    if (esVisible(q, getSt().answers)) out.push({ q, i });
  });
  return out;
}

// ¿Tiene la pregunta una condición «mostrarSi» (aunque esté rota)? Sirve para
// distinguir en el reformulario «no aplica con tus respuestas» de «sin datos».
function tieneCondicion(q) {
  return !!(q && q.config && q.config.mostrarSi && q.config.mostrarSi.qid);
}

// IDs de preguntas ocultas según un borrador de respuestas. Con `draft` se
// evalúa sobre ese objeto; sin él, sobre el estado actual del formulario.
function hiddenQuestionIds(draft) {
  const st = draft && draft.answers ? draft : { answers: draft || readState().answers };
  const out = new Set();
  schema.forEach(q => { if (!esVisible(q, st.answers)) out.add(q.id); });
  return out;
}

// ── Render del cuestionario por secciones (llamado desde main.js) ───────────
// No reescribe renderAllQuestions: la llama primero (composición explícita) y
// después aplica paginación, raíl, barra y paneles de estadísticas.
function renderSecciones() {
  renderAllQuestions();
  decorateSectionStats();
  applySectionPaging();
}

// Clampa el índice a una posición válida (preferentemente visible).
function secClampIndex() {
  const n = Math.max(1, schema.length);
  SEC_ESTADO.idx = Math.min(Math.max(SEC_ESTADO.idx | 0, 0), n - 1);
  const visIds = new Set(visibleQuestions().map(v => v.q.id));
  if (!visIds.has(schema[SEC_ESTADO.idx] && schema[SEC_ESTADO.idx].id)) {
    for (let d = 1; d < n; d++) {
      for (const cand of [SEC_ESTADO.idx - d, SEC_ESTADO.idx + d]) {
        if (cand >= 0 && cand < n && visIds.has(schema[cand] && schema[cand].id)) {
          SEC_ESTADO.idx = cand; d = n; break;
        }
      }
    }
  }
}

function goToSection(i) {
  SEC_ESTADO.idx = i;
  secClampIndex();
  applySectionPaging();
  renderRail();
  renderBottomBar();
  const card = document.querySelector('#questions-container > .card[data-qid]:not([hidden])');
  if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
}

function nextSection() {
  const vis = visibleQuestions();
  const pos = vis.findIndex(v => v.i === SEC_ESTADO.idx);
  if (pos < 0 || pos >= vis.length - 1) {
    showStatus('Has revisado todas las secciones. Pulsa «Enviar» para sincronizar con el grupo.', 'ok', 5000);
    return;
  }
  goToSection(vis[pos + 1].i);
}
function prevSection() {
  const vis = visibleQuestions();
  const pos = vis.findIndex(v => v.i === SEC_ESTADO.idx);
  if (pos <= 0) return;
  goToSection(vis[pos - 1].i);
}

// Muestra solo la tarjeta activa; el resto queda oculta (display:none).
function applySectionPaging() {
  const container = $('questions-container');
  if (!container) return;
  if (!schema.length) { renderRail(); renderBottomBar(); return; }
  secClampIndex();
  const activeId = schema[SEC_ESTADO.idx] && schema[SEC_ESTADO.idx].id;
  [...container.querySelectorAll(':scope > .card[data-qid]')].forEach(c => {
    c.style.display = (c.dataset.qid === activeId) ? '' : 'none';
  });
  renderRail();
  renderBottomBar();
  updateHiddenNotice();
}

// Recalcula todo tras cualquier cambio que pueda alterar visibilidad/estados.
function refreshSecciones() {
  if (activeMode !== 'survey') return;
  applySectionPaging();
  decorateSectionStats();
}

// Cambios de esquema desde el servidor que afectan a las condiciones:
//   · Una condición cuyo qid ya no existe se limpia (edit_pregunta) para no
//     dejar secciones ocultas permanentemente por datos huérfanos.
//   · Si la pregunta activa quedó oculta o eliminada, el raíl salta a la
//     primera visible.
// Se llama desde polling.js cuando `schemaChanged` (los cambios locales pasan
// por los flujos de questions.js/forms.js, que ya validan y refrescan).
function syncCondicionesTrasCambioEsquema() {
  const ids = new Set(schema.map(q => q.id));
  schema.forEach(q => {
    const cond = q.config && q.config.mostrarSi;
    if (!cond || !cond.qid || ids.has(cond.qid)) return;
    delete q.config.mostrarSi;
    if (user) {
      apiAuth({
        action: 'edit_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: q.id, label: q.label, config: q.config,
      }).catch(e => console.warn('No se pudo limpiar la condición de', q.id, e));
    }
  });
  const visIds = new Set(visibleQuestions().map(v => v.q.id));
  if (!visIds.has(schema[SEC_ESTADO.idx] && schema[SEC_ESTADO.idx].id)) {
    const first = visibleQuestions()[0];
    SEC_ESTADO.idx = first ? first.i : 0;
  }
  refreshSecciones();
}

// ── Estado de respuesta de una pregunta (para el raíl ✓/○) ─────────────────
function _secHasAnswer(raw, tipo) {
  if (raw == null) return false;
  if (tipo === 'textarea') return true;
  if (Array.isArray(raw)) return raw.length > 0;
  if (tipo === 'disponibilidad') {
    return !!(raw.rangos && raw.rangos.length) || !!raw.soloFinde || !!raw.meDaIgual ||
           !!raw.preferirPuente || !!raw.irYVenir || (raw.diasMax != null && raw.diasMax !== 5);
  }
  if (tipo === 'horarios') {
    return !!((raw.disponibilidades && raw.disponibilidades.length) ||
              (raw.restricciones && raw.restricciones.length));
  }
  if (tipo === 'slider') return true;
  if (typeof raw === 'object') {
    if ('estado' in raw) return true;
    return Object.values(raw).some(v => Number(v) !== 0);
  }
  return String(raw).length > 0;
}

// ── Raíl de secciones ───────────────────────────────────────────────────────
function renderRail() {
  const rail = $('sec-rail');
  if (!rail) return;
  rail.innerHTML = '';
  if (!schema.length) {
    rail.innerHTML = '<div class="sec-rail-empty">Sin secciones todavía</div>';
    return;
  }
  const st = readState();
  const visIds = new Set(visibleQuestions().map(v => v.q.id));
  schema.forEach((q, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const visible = visIds.has(q.id);
    const answered = _secHasAnswer(st.answers[q.id], q.tipo);
    const active = i === SEC_ESTADO.idx;
    b.className = 'sec-rail-item' + (active ? ' active' : '') +
                  (!visible ? ' not-applicable' : '');
    b.setAttribute('aria-current', active ? 'step' : 'false');
    const statusIcon = !visible ? '⌀' : answered ? '✓' : active ? '●' : '○';
    const num = String(i + 1).padStart(2, '0');
    b.innerHTML =
      `<span class="sec-rail-status" aria-hidden="true">${statusIcon}</span>` +
      `<span class="sec-rail-num">${num}</span>` +
      `<span class="sec-rail-label">${esc(q.label)}</span>` +
      (!visible ? '<span class="sec-rail-na">no aplica</span>' : '');
    b.title = visible ? q.label : q.label + ' — no aplica con las respuestas actuales';
    b.addEventListener('click', () => goToSection(i));
    rail.appendChild(b);
  });
}

// ── Barra inferior fija: Anterior · n de N · Siguiente · Enviar ────────────
function renderBottomBar() {
  const bar = $('sec-nav');
  if (!bar) return;
  bar.classList.toggle('visible', activeMode === 'survey');
  const vis = visibleQuestions();
  const total = Math.max(vis.length, 1);
  const pos = Math.max(1, vis.findIndex(v => v.i === SEC_ESTADO.idx) + 1);
  const label = $('sec-pos');
  if (label) label.textContent = `${pos} de ${total}`;
  const fill = $('sec-bar-fill');
  if (fill) fill.style.width = ((pos / total) * 100) + '%';
  const prev = $('sec-prev'), next = $('sec-next');
  if (prev) prev.disabled = pos <= 1;
  if (next) {
    next.disabled = pos >= total;
    next.innerHTML = 'Siguiente <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
  }
  const submit = $('sec-submit');
  const isLast = pos >= total;
  if (submit) submit.classList.toggle('is-final', isLast);
  syncSubmitBar();
}

// ── Panel «Lo que responde el grupo» bajo cada sección ─────────────────────
function decorateSectionStats() {
  const container = $('questions-container');
  if (!container) return;
  const mode = getGroupInfoMode();
  const submitted = getMySubmittedAnswers();
  [...container.querySelectorAll(':scope > .card[data-qid]')].forEach(card => {
    const qid = card.dataset.qid;
    const q = schema.find(x => x.id === qid);
    if (!q || q.tipo === 'textarea') return;
    let wrap = card.querySelector(':scope > .reform-stats-wrap');
    if (!wrap) {
      wrap = div('reform-stats-wrap');
      wrap.innerHTML = `
        <div class="reform-stats-head">
          <span><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Lo que responde el grupo</span>
          <span class="reform-stats-tools">
            <button type="button" class="btn-link-like btn-toggle-stats"></button>
          </span>
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
    // Modo del panel bajo esta sección: visible / plegado / esperar-respuesta.
    const answered = _secHasAnswer(readState().answers[qid], q.tipo);
    let open = true;
    if (mode === 'plegado') open = false;
    else if (mode === 'esperar') open = answered;
    const body = wrap.querySelector('.reform-stats-body');
    body.style.display = open ? '' : 'none';
    const tgl = wrap.querySelector('.btn-toggle-stats');
    if (tgl) tgl.textContent = open ? 'Ocultar' : 'Mostrar';
    renderReformSectionFor(qid, submitted);
  });
}

// Pinta las estadísticas del grupo de UNA pregunta (usa el motor del
// reformulario vía su override de sección única, sin parchearlo).
let _secStatsTimer = null;
function renderReformSectionFor(qid, myAnsPre) {
  const box = $('reform-section-' + qid);
  if (!box || typeof buildAnalyticalCard !== 'function') return;
  const q = schema.find(x => x.id === qid);
  if (!q) { box.innerHTML = ''; return; }
  try {
    box.innerHTML = '';
    const myAns = myAnsPre !== undefined ? myAnsPre : getMySubmittedAnswers();
    const card = buildAnalyticalCard(q, 0, myAns);
    if (card) {
      card.classList.add('ref-card-embedded');
      box.appendChild(card);
    } else {
      box.innerHTML = '<div class="reform-stats-empty">Tipo de pregunta sin estadísticas disponibles todavía.</div>';
    }
  } catch (e) {
    console.warn('No se pudieron calcular las estadísticas de', qid, e);
    box.innerHTML = '';
  }
}

// Repinta los paneles de estadísticas de forma agrupada (debounced) cuando
// llegan datos nuevos (polling, envíos, cambios de esquema…).
function scheduleRefreshSections() {
  clearTimeout(_secStatsTimer);
  _secStatsTimer = setTimeout(() => {
    if (activeMode === 'survey') decorateSectionStats();
  }, 350);
}

// Barras flotantes: solo existe la barra inferior del cuestionario.
function updateFloatingBars() {
  const nav = $('sec-nav');
  if (nav) nav.classList.toggle('visible', activeMode === 'survey' && schema.length > 0);
}

// ── Enlazado (se llama una vez desde main.js, en DOMContentLoaded) ─────────
function initSecciones() {
  const prev = $('sec-prev'), next = $('sec-next');
  if (prev) prev.addEventListener('click', prevSection);
  if (next) next.addEventListener('click', nextSection);
  // El envío (#sec-submit) se enlaza en bindSubmit() (answers.js), que es el
  // dueño del flujo; aquí solo la navegación y el ajuste de información.

  const sel = $('sec-groupinfo-mode');
  if (sel) {
    sel.value = getGroupInfoMode();
    sel.addEventListener('change', () => setGroupInfoMode(sel.value));
  }

  // Teclado: ← → para navegar entre secciones.
  document.addEventListener('keydown', e => {
    if (activeMode !== 'survey' || !schema.length) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'ArrowRight') nextSection();
    if (e.key === 'ArrowLeft') prevSection();
  });
}

// Hook global opcional: otros módulos pueden avisar de que cambió algo.
window.onSecChange = refreshSecciones;
