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
var SEC_ESTADO = { idx: 0 };                        // índice (sobre schema) de la pregunta activa

// ── MODELO DE SECCIONES ─────────────────────────────────────────────────────
// El raíl agrupa las preguntas por q.config.seccion. Las preguntas sin sección
// forman una sección implícita con su propio título; si varias comparten el
// mismo título, todas juntas forman UNA sección. Una pregunta marcada con
// config.esEncabezado define siempre una sección propia (aunque no tenga
// respuestas): es la «tarjeta marca» que crea el botón «+ Nueva sección».
function _secNormNombre(s) { return String(s || '').trim().toLowerCase(); }

function seccionesDelEsquema() {
  const secs = [];
  const byName = Object.create(null);
  schema.forEach((q, i) => {
    const cfg = q.config || {};
    let nombre = String(cfg.seccion || '').trim();
    if (cfg.esEncabezado && !nombre) nombre = q.label;
    let sec = null;
    if (nombre) {
      const key = _secNormNombre(nombre);
      sec = byName[key];
      if (!sec) {
        sec = { nombre, titulo: nombre, encabezadoIdx: -1, items: [] };
        byName[key] = sec;
        secs.push(sec);
      }
    } else {
      sec = { nombre: '', titulo: q.label, encabezadoIdx: -1, items: [] };
      secs.push(sec);
    }
    if (cfg.esEncabezado && sec.encabezadoIdx < 0) sec.encabezadoIdx = i;
    sec.items.push({ q, i });
  });
  return secs;
}

// Preguntas visibles de una sección (excluye la tarjeta «marca» del raíl).
function _secItemsVisibles(sec, answers) {
  return sec.items.filter(it => !(it.q.config && it.q.config.esEncabezado) && esVisible(it.q, answers));
}

// Sección (objeto) a la que pertenece la pregunta en schema[idx].
function _secDeIdx(idx, secs) {
  const q = schema[idx];
  if (!q) return null;
  const cfg = q.config || {};
  const own = !!cfg.esEncabezado;
  const nombre = String(cfg.seccion || (own ? q.label : '')).trim();
  const key = _secNormNombre(nombre);
  return (secs || seccionesDelEsquema()).find(s =>
    s.encabezadoIdx === idx ||
    (key && _secNormNombre(s.nombre) === key) ||
    (!key && s.items.some(it => it.i === idx))) || null;
}

// Índice de la primera pregunta visible de una sección (o -1).
function _secPrimeraVisible(sec, answers) {
  const vis = _secItemsVisibles(sec, answers);
  if (vis.length) return vis[0].i;
  if (sec.encabezadoIdx >= 0) return sec.encabezadoIdx;
  return sec.items.length ? sec.items[0].i : -1;
}

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

// ── Ayudas de sección reutilizadas por questions.js / forms.js ──────────────
// Lista de nombres de sección existentes en el esquema (para poblar los
// desplegables «Sección» del editor de preguntas y del formulario alta).
function nombresDeSecciones() {
  const out = [];
  seccionesDelEsquema().forEach(s => { if (s.nombre) out.push(s.nombre); });
  return out;
}

// Tarjeta «marca» (config.esEncabezado) de una sección, o null.
function secHeaderPara(nombre) {
  const key = _secNormNombre(nombre);
  if (!key) return null;
  return schema.find(q => q.config && q.config.esEncabezado &&
    _secNormNombre(q.config.seccion || q.label) === key) || null;
}

// Índice de la primera pregunta visible de una sección (acepta objeto o nombre).
// Envuelve _secPrimeraVisible para uso desde forms.js (lista de gestión 🗂).
function secPrimeraVisibleDe(secOrNombre, answers) {
  const st = answers || readState().answers;
  let sec = secOrNombre;
  if (typeof sec === 'string') {
    const key = _secNormNombre(sec);
    sec = seccionesDelEsquema().find(s => _secNormNombre(s.nombre) === key);
  }
  return sec ? _secPrimeraVisible(sec, st) : -1;
}

// Inserta `card` en el contenedor justo después de la tarjeta de `beforeQ`
// (o al principio si no hay referencia). Mantiene DOM y esquema alineados:
// polling/syncSchemaToDOM solo añaden/quitan tarjetas, nunca las reubican,
// así que el orden visual depende exclusivamente de estas inserciones.
function insertCardTras(card, beforeQ) {
  const cont = $('questions-container');
  if (!cont || !card) return;
  const beforeEl = beforeQ ? cardFor(beforeQ.id) : null;
  if (beforeEl && beforeEl.parentElement === cont) beforeEl.after(card);
  else cont.appendChild(card);
}

// Navegar a la sección por nombre ('' = sin sección / primera suelta).
function goToSectionDeNombre(nombre) {
  const secs = seccionesDelEsquema();
  const key = _secNormNombre(nombre);
  const sec = key ? secs.find(s => _secNormNombre(s.nombre) === key) : null;
  if (sec) {
    const idx = _secPrimeraVisible(sec, readState().answers);
    if (idx >= 0) { goToSection(idx); return; }
  }
  if (!nombre) {
    // «Sin sección»: ir a la primera pregunta suelta del esquema.
    const i = schema.findIndex(q => !(q.config && q.config.seccion));
    if (i >= 0) { goToSection(i); return; }
  }
  refreshSecciones();
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
  // Al cambiar de sección se vuelve ARRIBA del todo (no al borde de la
  // tarjeta), para que el raíl y la cabecera queden a la vista.
  setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 40);
}

function nextSection() {
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs);
  const ci = cur ? secs.indexOf(cur) : -1;
  const st = readState().answers;
  for (let d = 1; d < secs.length; d++) {
    const cand = secs[ci + d];
    if (!cand) continue;
    const idx = _secPrimeraVisible(cand, st);
    if (idx >= 0) { goToSection(idx); return; }
  }
  showStatus('Has revisado todas las secciones. Pulsa «Enviar» para sincronizar con el grupo.', 'ok', 5000);
}
function prevSection() {
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs);
  const ci = cur ? secs.indexOf(cur) : -1;
  const st = readState().answers;
  for (let d = ci - 1; d >= 0; d--) {
    const idx = _secPrimeraVisible(secs[d], st);
    if (idx >= 0) { goToSection(idx); return; }
  }
}

// Muestra TODAS las tarjetas visibles de la sección activa; el resto queda
// oculta (display:none). La sección activa es la que contiene la pregunta en
// SEC_ESTADO.idx.
function applySectionPaging() {
  const container = $('questions-container');
  if (!container) return;
  if (!schema.length) { renderRail(); renderBottomBar(); return; }
  secClampIndex();
  const st = readState().answers;
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs) || secs[0];
  let activeIds = null;
  if (cur) {
    // Preguntas visibles de la sección + su tarjeta «marca» SIEMPRE que el
    // índice activo sea de esa misma sección (la marca no es una pregunta
    // «visible» normal, pero es la página de las secciones sin preguntas).
    activeIds = new Set(_secItemsVisibles(cur, st).map(it => it.q.id));
    if (cur.encabezadoIdx >= 0 && _secDeIdx(SEC_ESTADO.idx, secs) === cur) {
      activeIds.add(schema[cur.encabezadoIdx].id);
    }
    if (!activeIds.size && cur.items.length) activeIds.add(cur.items[0].q.id);
  }
  [...container.querySelectorAll(':scope > .card[data-qid]')].forEach(c => {
    c.style.display = (activeIds && activeIds.has(c.dataset.qid)) ? '' : 'none';
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
  if (typeof renderSecManageList === 'function') renderSecManageList();
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
// El raíl pinta SECCIONES (agrupaciones de config.seccion), no preguntas:
// cada entrada muestra el título de la sección, su estado global (✓ si todas
// sus preguntas visibles están respondidas, ⌀ si ninguna aplica, ●/○ en otro
// caso) y una sublista con las preguntas que contiene. Al pie: «+ Nueva
// sección» y el ajuste «lo que responde el grupo».
function renderRail() {
  const rail = $('sec-rail');
  if (!rail) return;
  rail.innerHTML = '';
  if (!schema.length) {
    rail.innerHTML = '<div class="sec-rail-empty">Sin secciones todavía</div>';
    rail.appendChild(secAddSectionButton());
    rail.appendChild(secGroupInfoRow());
    return;
  }
  const st = readState().answers;
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs);
  let shownNum = 0;
  secs.forEach((sec, si) => {
    const items = _secItemsVisibles(sec, st);
    const allHidden = sec.items.length > 0 && items.length === 0 && sec.encabezadoIdx < 0;
    const answered = items.length > 0 && items.every(it => _secHasAnswer(st[it.q.id], it.q.tipo));
    const active = cur === sec;
    if (!allHidden) shownNum++;

    const b = document.createElement('div');
    b.className = 'sec-rail-item' + (active ? ' active' : '') + (allHidden ? ' not-applicable' : '');
    b.setAttribute('role', 'listitem');
    const statusIcon = allHidden ? '⌀' : answered ? '✓' : active ? '●' : '○';
    const num = String(shownNum || 1).padStart(2, '0');
    // Ficha del raíl: zona navegable (botón) + botón 🗂 (gestionar sección),
    // que abre un menú inline con Renombrar / Eliminar sección / Añadir pregunta.
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'sec-rail-main';
    main.innerHTML =
      `<span class="sec-rail-status" aria-hidden="true">${statusIcon}</span>` +
      `<span class="sec-rail-num">${num}</span>` +
      `<span class="sec-rail-label">${esc(sec.titulo)}</span>` +
      (allHidden ? '<span class="sec-rail-na">no aplica</span>' : '');
    main.title = allHidden ? sec.titulo + ' — no aplica con las respuestas actuales' : sec.titulo;
    main.addEventListener('click', () => {
      const idx = _secPrimeraVisible(sec, st);
      if (idx >= 0) goToSection(idx);
    });
    b.appendChild(main);

    // Botón 🗂 «editar sección» (menú inline bajo la ficha).
    const tool = document.createElement('button');
    tool.type = 'button';
    tool.className = 'sec-rail-tool sec-rail-manage';
    tool.textContent = '🗂';
    tool.title = 'Gestionar sección «' + sec.titulo + '»';
    tool.setAttribute('aria-label', 'Gestionar sección ' + sec.titulo);
    tool.addEventListener('click', e => {
      e.stopPropagation();
      toggleSecManageMenu(b, sec);
    });
    b.appendChild(tool);

    // Sublista de preguntas de la sección (navegación fina dentro de ella).
    if (items.length) {
      const sub = div('sec-rail-sub');
      items.forEach(it => {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'sec-rail-subitem' + (it.i === SEC_ESTADO.idx ? ' current' : '');
        const dot = _secHasAnswer(st[it.q.id], it.q.tipo) ? '✓' : it.i === SEC_ESTADO.idx ? '●' : '·';
        s.innerHTML = `<span class="sub-dot">${dot}</span><span class="sub-txt">${esc(it.q.label)}</span>`;
        s.title = it.q.label;
        s.addEventListener('click', e => { e.stopPropagation(); goToSection(it.i); });
        sub.appendChild(s);
      });
      b.appendChild(sub);
    }
    rail.appendChild(b);
  });

  rail.appendChild(secAddSectionButton());
  rail.appendChild(secGroupInfoRow());
}

// ── Menú inline 🗂 «gestionar sección» (ficha del raíl) ─────────────────────
// Acciones: Renombrar · Eliminar sección · Añadir pregunta aquí.
let _secManageOpen = null;   // { host, panel } del menú abierto (solo uno a la vez)

function _secCerrarMenu() {
  if (_secManageOpen) {
    _secManageOpen.panel.remove();
    _secManageOpen = null;
  }
}

function toggleSecManageMenu(host, sec) {
  const yaAbierto = _secManageOpen && _secManageOpen.host === host;
  _secCerrarMenu();
  if (yaAbierto) return;
  const panel = div('sec-rail-menu');
  panel.setAttribute('role', 'menu');
  const mk = (label, cls, fn) => {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'sec-rail-menu-item' + (cls ? ' ' + cls : '');
    it.textContent = label;
    it.addEventListener('click', e => { e.stopPropagation(); fn(it, panel); });
    panel.appendChild(it);
    return it;
  };
  mk('✏️ Renombrar sección', '', (it, p) => _secAbrirRenombrar(host, sec, it, p));
  mk('➕ Añadir pregunta aquí', '', () => { _secCerrarMenu(); abrirAddPreguntaEnSeccion(sec.nombre || ''); });
  mk('🗑 Eliminar sección', 'danger', (it, p) => _secAbrirEliminar(host, sec, it, p));
  host.appendChild(panel);
  _secManageOpen = { host, panel };
}

// Cerrar el menú al hacer clic fuera de él o pulsar Escape.
document.addEventListener('click', e => {
  if (_secManageOpen && !e.target.closest('.sec-rail-item')) _secCerrarMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') _secCerrarMenu();
});

// Renombrar: replica el nuevo nombre en config.seccion de TODAS sus preguntas
// (vía edit_pregunta) y renombra también la tarjeta «marca».
function _secAbrirRenombrar(host, sec, btnItem, panel) {
  panel.innerHTML = '';
  const form = div('sec-rail-rename-form');
  const inp = document.createElement('input');
  inp.type = 'text'; inp.maxLength = 60; inp.value = sec.nombre || sec.titulo;
  inp.setAttribute('aria-label', 'Nuevo nombre de la sección');
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn-propose sec-rm-ok'; ok.textContent = 'Guardar';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn-pc sec-rm-cancel'; cancel.textContent = 'Cancelar';
  form.append(inp, ok, cancel);
  panel.appendChild(form);
  inp.focus(); inp.select();
  cancel.addEventListener('click', e => { e.stopPropagation(); _secCerrarMenu(); });
  const run = async () => {
    const nuevo = inp.value.trim();
    if (!nuevo) { inp.focus(); return; }
    if (nuevo.toLowerCase() === String(sec.nombre || '').trim().toLowerCase() &&
        !(sec.encabezadoIdx >= 0 && schema[sec.encabezadoIdx] &&
          schema[sec.encabezadoIdx].label !== nuevo)) {
      _secCerrarMenu(); return;
    }
    ok.disabled = true; ok.textContent = 'Guardando…';
    await renombrarSeccion(sec.nombre || sec.titulo, nuevo);
  };
  ok.addEventListener('click', e => { e.stopPropagation(); run(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Escape') _secCerrarMenu();
  });
}

// Eliminación en dos pasos con aviso claro (inline, sin window.confirm).
function _secAbrirEliminar(host, sec, btnItem, panel) {
  panel.innerHTML = '';
  const nPreg = sec.items.filter(it => !(it.q.config && it.q.config.esEncabezado)).length;
  const box = div('sec-rail-del-confirm');
  box.innerHTML =
    `<div class="sec-rail-del-txt">¿Eliminar la <b>sección «${esc(sec.titulo)}»</b>? ` +
    (nPreg
      ? `Sus <b>${nPreg}</b> pregunta${nPreg === 1 ? '' : 's'} NO se borran: pasarán a ` +
        `«Sin sección» (solo desaparece la agrupación y su marca del raíl).`
      : 'Solo se eliminará su marca del raíl (la sección está vacía).') +
    ` Se aplica para todo el grupo.</div>` +
    '<div class="sec-rail-del-actions">' +
      '<button type="button" class="btn-pc sec-rd-cancel">Cancelar</button>' +
      '<button type="button" class="btn-pc btn-pc-contra sec-rd-ok">Sí, eliminar sección</button>' +
    '</div>';
  panel.appendChild(box);
  box.querySelector('.sec-rd-cancel').addEventListener('click', e => {
    e.stopPropagation(); _secCerrarMenu();
  });
  box.querySelector('.sec-rd-ok').addEventListener('click', async e => {
    e.stopPropagation();
    const okBtn = box.querySelector('.sec-rd-ok');
    okBtn.disabled = true; okBtn.textContent = 'Eliminando…';
    await eliminarSeccion(sec.nombre || sec.titulo);
  });
}

// Repite el slug de crearSeccion para que las marcas generadas coincidan.
function _secHeaderId(nombre) {
  return 'seccion_' + String(nombre).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '').slice(0, 40);
}

// ¿Es esta pregunta la «marca» (encabezado) de la sección `nombre`?
function _esMarcaDeSeccion(q, nombre) {
  if (!q || !q.config || !q.config.esEncabezado) return false;
  const key = _secNormNombre(nombre);
  return _secNormNombre(q.config.seccion || q.label) === key || q.id.startsWith(_secHeaderId(nombre));
}

// Renombra una sección: replica el nuevo nombre en config.seccion de todas
// sus preguntas (edit_pregunta) y actualiza también la etiqueta de la marca.
async function renombrarSeccion(nombreViejo, nombreNuevo) {
  if (!user) { showStatus('Inicia sesión para renombrar secciones', 'err'); return false; }
  nombreNuevo = String(nombreNuevo || '').trim();
  if (!nombreNuevo) return false;
  const afectadas = schema.filter(q =>
    q.config && !_esMarcaDeSeccion(q, nombreViejo) &&
    _secNormNombre(q.config.seccion || '') === _secNormNombre(nombreViejo));
  const marcas = schema.filter(q => _esMarcaDeSeccion(q, nombreViejo));
  let ok = 0, errs = 0;
  for (const q of afectadas.concat(marcas)) {
    const newCfg = Object.assign({}, q.config || {}, { seccion: nombreNuevo });
    try {
      await apiAuth({
        action: 'edit_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: q.id,
        label: q.config.esEncabezado ? nombreNuevo : q.label,
        config: newCfg,
      });
      q.config = newCfg;
      if (q.config.esEncabezado) q.label = nombreNuevo;
      ok++;
    } catch (e) {
      console.warn('No se pudo renombrar la pregunta', q.id, e);
      errs++;
    }
  }
  if (!errs) {
    showStatus(`Sección renombrada a «${nombreNuevo}» (${ok} elemento${ok === 1 ? '' : 's'} actualizado${ok === 1 ? '' : 's'}).`, 'ok', 5000);
  } else {
    showStatus(`Se renombró parcialmente: ${ok} bien, ${errs} con error.`, 'err', 7000);
  }
  lastRaw = '';
  pollOnce();
  _secCerrarMenu();
  goToSectionDeNombre(nombreNuevo);
  return !errs;
}

// Elimina una sección: borra la tarjeta «marca» (delete_pregunta) y quita
// config.seccion a sus preguntas, que pasan a «Sin sección» (conservadas).
async function eliminarSeccion(nombre) {
  if (!user) { showStatus('Inicia sesión para eliminar secciones', 'err'); return false; }
  nombre = String(nombre || '').trim();
  if (!nombre) return false;
  const preguntas = schema.filter(q =>
    q.config && !_esMarcaDeSeccion(q, nombre) &&
    _secNormNombre(q.config.seccion || '') === _secNormNombre(nombre));
  const marcas = schema.filter(q => _esMarcaDeSeccion(q, nombre));
  let errs = 0;
  // 1) Las preguntas pasan a «Sin sección» ANTES de borrar la marca, para que
  //    en ningún momento queden huérfanas de un grupo que ya no existe.
  for (const q of preguntas) {
    const newCfg = Object.assign({}, q.config || {});
    delete newCfg.seccion;
    try {
      await apiAuth({
        action: 'edit_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: q.id, label: q.label, config: newCfg,
      });
      q.config = newCfg;
    } catch (e) {
      console.warn('No se pudo mover a «Sin sección» la pregunta', q.id, e);
      errs++;
    }
  }
  // 2) Borrar la/s marca/s
  for (const m of marcas) {
    try {
      await apiAuth({
        action: 'delete_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: m.id,
      });
      schema = schema.filter(x => x.id !== m.id);
      const card = cardFor(m.id);
      if (card) card.remove();
    } catch (e) {
      console.warn('No se pudo borrar la marca de sección', m.id, e);
      errs++;
    }
  }
  _secCerrarMenu();
  if (!errs) {
    showStatus(`Sección «${nombre}» eliminada. ${preguntas.length} pregunta${preguntas.length === 1 ? '' : 's'} pasaron a «Sin sección».`,
               'ok', 7000);
  } else {
    showStatus(`La sección se eliminó parcialmente (${errs} operación(es) con error). Revisa el raíl.`, 'err', 8000);
  }
  lastRaw = '';
  pollOnce();
  refreshSecciones();
  return !errs;
}

// Abre #add-q-form (tarjeta «Ampliar el cuestionario») con la sección ya
// seleccionada en el desplegable. Llamado desde el menú 🗂 y la lista de gestión.
function abrirAddPreguntaEnSeccion(nombre) {
  const f = $('add-q-form'), t = $('btn-toggle-add-q');
  if (t && !f.classList.contains('open')) t.click();  // rebind de secciones/condición
  const sel = $('add-q-seccion');
  if (sel) {
    const key = _secNormNombre(nombre);
    const op = key ? [...sel.options].find(o => _secNormNombre(o.value) === key) : null;
    sel.value = op ? op.value : '';
    if (typeof syncAddQSeccionField === 'function') syncAddQSeccionField();
  }
  if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const lbl = $('add-q-label');
  if (lbl) setTimeout(() => lbl.focus(), 250);
}

// Botón «+ Nueva sección» del pie del raíl: pide un nombre de forma inline
// (sin window.prompt) y crea una tarjeta «marca» (textarea informativa con
// config.esEncabezado + config.seccion) que da identidad al grupo en el raíl.
function secAddSectionButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sec-rail-add';
  btn.textContent = '+ Nueva sección';
  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    const form = div('sec-rail-add-form');
    form.innerHTML =
      '<input type="text" maxlength="60" placeholder="Nombre de la sección">' +
      '<div class="sec-rail-add-actions">' +
        '<button type="button" class="btn-pc sec-aa-cancel" type="button">Cancelar</button>' +
        '<button type="button" class="btn-propose sec-aa-ok">Crear →</button>' +
      '</div>';
    railInsertAfter(btn, form);
    const inp = form.querySelector('input');
    inp.focus();
    const close = () => { form.remove(); btn.style.display = ''; };
    form.querySelector('.sec-aa-cancel').addEventListener('click', close);
    const crear = async () => {
      const nombre = inp.value.trim();
      if (!nombre) { inp.focus(); return; }
      close();
      await crearSeccion(nombre);
    };
    form.querySelector('.sec-aa-ok').addEventListener('click', crear);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') crear();
      if (e.key === 'Escape') close();
    });
  });
  return btn;
}
function railInsertAfter(anchor, node) {
  const rail = $('sec-rail');
  if (!rail) return;
  const groupinfo = rail.querySelector('.sec-groupinfo-row');
  if (groupinfo) rail.insertBefore(node, groupinfo);
  else rail.appendChild(node);
}

// Crea la tarjeta «marca» de una sección nueva (optimista + add_pregunta).
async function crearSeccion(nombre) {
  if (!user) { showStatus('Inicia sesión para crear secciones', 'err'); return; }
  const id = 'seccion_' + nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) + '_' + Date.now().toString(36);
  const pregunta = { id, tipo: 'textarea', label: nombre, opciones: [],
                     config: { esEncabezado: true, seccion: nombre, descripcion: '' } };
  schema.push(pregunta);
  const card = buildQuestionCard(pregunta, schema.length - 1);
  const cont = $('questions-container');
  if (card && cont) {
    // Colocar la marca justo antes de la primera pregunta ya asignada a esta
    // sección (si existe), para que DOM y esquema queden alineados.
    const key = String(nombre).trim().toLowerCase();
    const firstInSec = schema.find(x => x.id !== id && x.config && !x.config.esEncabezado &&
      String(x.config.seccion || '').trim().toLowerCase() === key);
    if (firstInSec) insertCardTras(card, firstInSec);
    else cont.appendChild(card);
  }
  const emptyNotice = cont && cont.querySelector('[data-empty-notice]');
  if (emptyNotice) emptyNotice.remove();
  try {
    await apiPost({ action: 'add_pregunta', eid: user.eid, nombre: user.nombre,
                    pinHash: user.pinHash, pregunta });
    lastRaw = '';
    await pollOnce();
    // Navegar a la sección nueva tras el guardado real (usa el índice fresco
    // del esquema sincronizado). Aunque todavía no tenga preguntas visibles,
    // la tarjeta «marca» es suficiente para navegar hasta ella.
    if (typeof goToSectionDeNombre === 'function') goToSectionDeNombre(nombre);
    else refreshSecciones();
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 40);
    showStatus(`Sección «${nombre}» creada. Añade preguntas y asígnalas desde ✎.`, 'ok', 6000);
  } catch (e) {
    if (card) card.remove();
    const i = schema.indexOf(pregunta);
    if (i >= 0) schema.splice(i, 1);
    showStatus('No se pudo crear la sección: ' + e.message, 'err');
    refreshSecciones();
  }
}

// Fila de ajuste «lo que responde el grupo» (visible/plegado/esperar).
function secGroupInfoRow() {
  const row = div('sec-groupinfo-row');
  row.innerHTML =
    '<label for="sec-groupinfo-mode">Grupo:</label>' +
    '<select id="sec-groupinfo-mode">' +
      '<option value="visible">Mostrar siempre</option>' +
      '<option value="plegado">Plegado</option>' +
      '<option value="esperar">Tras responder</option>' +
    '</select>';
  const sel = row.querySelector('select');
  sel.value = getGroupInfoMode();
  sel.addEventListener('change', () => setGroupInfoMode(sel.value));
  return row;
}

// ── Barra inferior fija: Anterior · sección n/N · Siguiente · Enviar ───────
// La unidad de navegación es la SECCIÓN (agrupación de config.seccion), no la
// pregunta: «2 de 5» cuenta secciones con contenido aplicable.
function renderBottomBar() {
  const bar = $('sec-nav');
  if (!bar) return;
  bar.classList.toggle('visible', activeMode === 'survey');
  const st = readState().answers;
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs) || secs[0];
  // Secciones navegables = las que tienen al menos una tarjeta para mostrar
  // (preguntas visibles o la propia marca de encabezado).
  const navSecs = secs.filter(s => s.items.some(it =>
    !it.q.config?.esEncabezado ? esVisible(it.q, st) : true));
  const total = Math.max(navSecs.length, 1);
  let pos = Math.max(1, navSecs.indexOf(cur) + 1);
  const label = $('sec-pos');
  if (label) label.textContent = `Sección ${pos} de ${total}`;
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
