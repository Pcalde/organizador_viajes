// ==========================================================================
//  CUESTIONARIO POR SECCIONES (js/secciones.js)
//  Sustituye al antiguo «modo asistente» de wizard.js: el cuestionario es
//  SIEMPRE por secciones (una visible cada vez), sin interruptor.
//
//   · Raí­l de secciones a la izquierda (número, tí­tulo completo en hasta
//     2 lí­neas, estado âœ“ respondida / ● actual / ○ pendiente / âˆ… no aplica).
//   · En pantallas <760 px el raí­l pasa a chips horizontales con scroll.
//   · Barra inferior fija: â† Anterior · «n de N» · Siguiente → · Enviar.
//   · Condiciones de visibilidad por pregunta: q.config.mostrarSi =
//     {qid, op: 'incluye'|'igual'|'alguno', valor, no?}. Se evalúan sobre el
//     BORRADOR (readState()), solo sobre preguntas anteriores en el orden
//     (así­ no hay ciclos). Las ocultas se conservan en el borrador pero se
//     excluyen del enví­o (collectAnswers).
//   · Panel «Ver qué responde el grupo» bajo cada sección, plegado según el
//     ajuste global persistido en localStorage (visible | plegado | esperar).
//
//  Módulo con funciones EXPLÍCITAS llamado desde main.js y enterSurvey():
//  nada de monkeypatching de renderAllQuestions. Cárgalo en index.html
//  después de reformulario.js y antes de auth.js.
//  Requiere: state.js, questions.js, answers.js, reformulario.js, types.js.
// ==========================================================================

var SEC_LS_GROUPINFO = 'cuestionador_groupinfo_v1'; // 'visible' | 'plegado' | 'esperar'
var SEC_ESTADO = { idx: 0 };                        // í­ndice (sobre schema) de la pregunta activa

// -- MODELO DE SECCIONES -----------------------------------------------------
// El raí­l agrupa las preguntas por q.config.seccion. Las preguntas sin sección
// forman una sección implí­cita con su propio tí­tulo; si varias comparten el
// mismo tí­tulo, todas juntas forman UNA sección. Una pregunta marcada con
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

// Preguntas visibles de una sección (excluye la tarjeta «marca» del raí­l).
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

// índice de la primera pregunta visible de una sección (o -1).
function _secPrimeraVisible(sec, answers) {
  const vis = _secItemsVisibles(sec, answers);
  if (vis.length) return vis[0].i;
  if (sec.encabezadoIdx >= 0) return sec.encabezadoIdx;
  return sec.items.length ? sec.items[0].i : -1;
}

// -- Ajuste global de la información del grupo -------------------------------
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

// El botón de enví­o vive en la barra inferior (#sec-submit); #btn-generate se
// mantiene sincronizado para que todo lo existente (bindSubmit, estados) siga
// funcionando sin duplicar lógica.
function syncSubmitBar() {
  const btn = $('btn-generate'), bar = $('sec-submit');
  if (!btn || !bar) return;
  bar.textContent = btn.textContent;
  bar.disabled = btn.disabled;
  bar.classList.toggle('up-to-date', btn.classList.contains('up-to-date'));
}

// -- Editor de condiciones («mostrar si…») -----------------------------------
// Construye un mini-formulario reutilizable: pregunta previa + operador +
// valor (poblado con las opciones de aquella). `onlyBefore` limita la lista de
// preguntas a las que van antes de `qid` en el orden (regla anti-ciclos).
function buildCondEditor(host, schemaArr, currentQid, initial) {
  host.innerHTML = '';
  const cur = initial && typeof initial === 'object' ? initial : null;

  const panel = div('cond-editor-panel');
  const lbl = document.createElement('div');
  lbl.className = 'cond-editor-title';
  lbl.innerHTML = '<span class="cond-editor-icon"><i class="fa-solid fa-code-branch" aria-hidden="true"></i></span><span><b>Mostrar esta pregunta según otra respuesta</b><small>Opcional · Si no añades una regla, siempre estará visible.</small></span>';

  const grid = div('cond-editor-grid');
  const selQ = document.createElement('select'); selQ.className = 'cond-q';
  const selOp = document.createElement('select'); selOp.className = 'cond-op';
  const selVal = document.createElement('select'); selVal.className = 'cond-val';
  const selNeg = document.createElement('select'); selNeg.className = 'cond-neg';
  selNeg.innerHTML = '<option value="">Sí­, se cumple</option><option value="1">No, al contrario</option>';

  // Candidatas: preguntas ANTERIORES a `currentQid` en el orden (regla
  // anti-ciclos). Con `currentQid` vací­o (pregunta nueva → se añade al final)
  // cualquier pregunta con opciones sirve. textarea/disponibilidad/horarios
  // no tienen opciones, así­ que quedan fuera automáticamente.
  const ci = currentQid ? schemaArr.findIndex(x => x.id === currentQid) : -1;
  const candidates = (schemaArr || []).filter((q, i) =>
    q.id !== currentQid && ((q.opciones || []).length > 0 || q.tipo === 'disponibilidad') &&
    (ci < 0 || i < ci));

  const fillQ = () => {
    selQ.innerHTML = '<option value="">Sin condición</option>' +
      candidates.map(q => `<option value="${esc(q.id)}">${esc(q.label)}</option>`).join('');
    if (cur && cur.qid && candidates.some(q => q.id === cur.qid)) selQ.value = cur.qid;
  };
  // 'alguno' admite una lista de valores; aquí­ se representa como «incluye
  // CUALQUIERA de…» y se guarda como {op:'alguno', valor:[...]}.
  const OPS_FOR = q =>
    !q ? [] :
    q.tipo === 'checkbox' || q.tipo === 'casas' ? ['incluye', 'alguno'] :
    q.tipo === 'disponibilidad' ? ['incluye', 'alguno'] :
    q.tipo === 'voto-ponderado' ? ['incluye', 'alguno'] :
    q.tipo === 'radio' ? ['igual'] : [];

  const fillOps = q => {
    const ops = OPS_FOR(q);
    selOp.innerHTML = ops.map(o => {
      const positiveVote = q && q.tipo === 'voto-ponderado';
      const label = o === 'incluye'
        ? (positiveVote ? 'ha valorado positivamente (+1 o +3)' : 'incluye la opción')
        : o === 'alguno'
          ? (positiveVote ? 'ha valorado alguna positivamente (+1 o +3)' : 'incluye CUALQUIERA de…')
          : 'es exactamente';
      return `<option value="${o}">${label}</option>`;
    }).join('');
    if (cur && q && cur.qid === q.id && ops.includes(cur.op)) selOp.value = cur.op;
  };
  const condOptionsOf = q => q && q.tipo === 'disponibilidad'
    ? DISP_PREFERENCIAS_OPCIONES
    : (q && q.opciones ? q.opciones : []).map(op => ({ value: optVal(q, op), label: optVal(q, op) }));
  const fillVals = q => {
    const vals = condOptionsOf(q);
    const multi = selOp.value === 'alguno';
    selVal.multiple = multi;
    selVal.size = multi ? Math.min(Math.max(vals.length, 2), 6) : 1;
    selVal.innerHTML = vals.length
      ? vals.map(v => `<option value="${esc(v.value)}">${esc(v.label)}</option>`).join('')
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

  const step = (n, title, control, cls) => {
    const wrap = div('cond-step ' + (cls || ''));
    const caption = document.createElement('label');
    caption.innerHTML = `<span>${n}</span>${title}`;
    wrap.append(caption, control);
    return wrap;
  };
  grid.append(
    step('1', 'Pregunta de referencia', selQ, 'cond-step-question'),
    step('2', 'Qué debe responder', selOp, 'cond-step-op'),
    step('3', 'Elección', selVal, 'cond-step-value'),
    step('4', 'Coincidencia', selNeg, 'cond-step-neg')
  );
  panel.append(lbl, grid);
  host.append(panel);
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
  if (!['checkbox', 'voto-ponderado', 'radio', 'casas', 'disponibilidad'].includes(src.tipo))
    return 'Las condiciones solo funcionan sobre preguntas con opciones o preferencias.';
  const vals = src.tipo === 'disponibilidad'
    ? DISP_PREFERENCIAS_OPCIONES.map(op => op.value)
    : (src.opciones || []).map(op => optVal(src, op));
  const list = Array.isArray(cond.valor) ? cond.valor : [cond.valor];
  if (!list.length) return 'Elige al menos un valor para la condición.';
  for (const v of list) {
    if (!vals.includes(String(v)))
      return `El valor «${v}» no es una opción válida de «${src.label}».`;
  }
  return null;
}

// ¿La pregunta `qid` depende (directa o transitivamente) de `depOn`? Se usa
// al reordenar: mover una pregunta por encima de su fuente romperí­a la regla
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

// -- Visibilidad condicional -------------------------------------------------
// Evalúa una respuesta cruda contra la condición. Soporta checkbox/casas
// (array), voto-ponderado (dict; "incluye" â‡’ puntos > 0, "igual" â‡’ el punto
// exacto) y radio (string u objeto {estado}). `valor` puede ser un valor
// suelto o una lista (operador 'alguno').
function _condMatch(raw, op, valor) {
  const list = (Array.isArray(valor) ? valor : [valor]).map(String);
  if (raw == null) return false;
  if (raw && typeof raw === 'object') {
    let preferencias = Array.isArray(raw.preferencias) ? raw.preferencias : null;
    // Compatibilidad con respuestas anteriores al selector por categorí­as.
    if (!preferencias && ['irYVenir', 'soloFinde', 'soloEntreSemana', 'meDaIgual', 'preferirPuente'].some(k => k in raw)) {
      preferencias = [
        raw.irYVenir ? 'plan:dia' : 'plan:indiferente',
        raw.soloFinde ? 'dias:solo_finde' : raw.soloEntreSemana ? 'dias:solo_semana' : 'dias:indiferente',
        raw.preferirPuente ? 'festivos:puente' : 'festivos:indiferente',
      ];
    }
    if (preferencias) return preferencias.some(v => list.includes(String(v)));
  }
  switch (op) {
    case 'igual':
      if (Array.isArray(raw)) return raw.map(String).some(v => list.includes(v));
      if (typeof raw === 'object') {
        if ('estado' in raw) return list.includes(String(raw.estado));
        // Compatibilidad con condiciones antiguas en voto ponderado: una
        // opción cuenta como elegida solo con voto positivo (+1 o +3), nunca -1.
        const dict = normPond(raw);
        return list.some(k => Number(dict[k]) > 0);
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
// por condición). Se re-evalúa en cada cambio ví­a refreshSecciones().
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
    esc(secRazonOculta(q)) + '. Tus cambios se guardan, pero no se enví­an al grupo.';
  const controls = card.querySelector('.options-list');
  if (controls && controls.parentElement === card) card.insertBefore(n, controls);
  else card.appendChild(n);
}

// Preguntas visibles (referencias reales de `schema`, con su í­ndice original).
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

// -- Ayudas de sección reutilizadas por questions.js / forms.js --------------
// Lista de nombres de sección existentes en el esquema (para poblar los
// desplegables «Sección» del editor de preguntas y del formulario alta).
function nombresDeSecciones() {
  const out = [], seen = new Set();
  seccionesDelEsquema().forEach(s => {
    // Las preguntas antiguas sin config.seccion forman secciones implí­citas
    // con su propio tí­tulo; también deben poder elegirse como destino.
    const nombre = String(s.nombre || s.titulo || '').trim();
    const key = _secNormNombre(nombre);
    if (nombre && !seen.has(key)) { seen.add(key); out.push(nombre); }
  });
  return out;
}

// Tarjeta «marca» (config.esEncabezado) de una sección, o null.
function secHeaderPara(nombre) {
  const key = _secNormNombre(nombre);
  if (!key) return null;
  return schema.find(q => q.config && q.config.esEncabezado &&
    _secNormNombre(q.config.seccion || q.label) === key) || null;
}

async function crearEncabezadoParaSeccion(nombre, items) {
  const id = 'seccion_' + String(nombre).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) + '_' + Date.now().toString(36);
  const pregunta = { id, tipo: 'textarea', label: nombre, opciones: [], config: { esEncabezado: true, seccion: nombre, descripcion: '' } };
  const first = items.length ? items[0].q : null;
  const pos = first ? schema.findIndex(q => q.id === first.id) : schema.length;
  schema.splice(pos < 0 ? schema.length : pos, 0, pregunta);
  const card = buildQuestionCard(pregunta, Math.max(0, pos));
  if (first) insertCardAntes(card, first); else $('questions-container')?.appendChild(card);
  try {
    await apiPost({ action: 'add_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, pregunta });
    // add_pregunta inserta al final en el servidor: persistir el orden local
    // evita que el encabezado reaparezca detrás tras el siguiente sondeo.
    await apiAuth({ action: 'reordenar_preguntas', eid: user.eid, nombre: user.nombre,
      pinHash: user.pinHash, ids: schema.map(q => q.id) });
  } catch (e) {
    card?.remove(); const idx = schema.indexOf(pregunta); if (idx >= 0) schema.splice(idx, 1); throw e;
  }
}

// Compatibilidad con los editores: garantiza una sección con encabezado,
// también cuando el destino procede de preguntas antiguas.
async function crearSeccion(nombre) {
  const name = String(nombre || '').trim();
  if (!user || !name) throw new Error('Inicia sesión y escribe un nombre de sección.');
  const section = seccionesDelEsquema().find(s => _secNormNombre(s.nombre || s.titulo) === _secNormNombre(name));
  if (section && section.encabezadoIdx >= 0) return true;
  const members = section ? section.items.map(it => it.q) : [];
  for (const q of members) {
    const config = { ...(q.config || {}), seccion: name };
    await apiAuth({ action: 'edit_pregunta', eid: user.eid, nombre: user.nombre,
      pinHash: user.pinHash, questionId: q.id, config });
    q.config = config;
    const card = cardFor(q.id); if (card) card.dataset.cfg = JSON.stringify(config);
  }
  await crearEncabezadoParaSeccion(name, members.map(q => ({ q })));
  lastRaw = ''; await pollOnce(); refreshSecciones();
  if (typeof rebindAddQSeccion === 'function') rebindAddQSeccion();
  return true;
}

function secNombreExiste(nombre) {
  const key = _secNormNombre(nombre);
  return !!key && seccionesDelEsquema().some(sec =>
    _secNormNombre(sec.nombre || sec.titulo) === key);
}

// Inserta `card` en el contenedor justo después de la tarjeta de `beforeQ`
// (o al principio si no hay referencia). Mantiene DOM y esquema alineados:
// polling/syncSchemaToDOM solo añaden/quitan tarjetas, nunca las reubican,
// así­ que el orden visual depende exclusivamente de estas inserciones.
function insertCardAntes(card, beforeQ) {
  const cont = $('questions-container');
  if (!cont || !card) return;
  const beforeEl = beforeQ ? cardFor(beforeQ.id) : null;
  if (beforeEl && beforeEl.parentElement === cont) cont.insertBefore(card, beforeEl);
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

// -- Render del cuestionario por secciones (llamado desde main.js) -----------
// No reescribe renderAllQuestions: la llama primero (composición explí­cita) y
// después aplica paginación, raí­l, barra y paneles de estadí­sticas.
function renderSecciones() {
  renderAllQuestions();
  decorateSectionStats();
  applySectionPaging();
}

// Clampa el í­ndice a una posición válida (preferentemente visible).
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
  // tarjeta), para que el raí­l y la cabecera queden a la vista.
  setTimeout(() => {
    const active = $('sec-rail')?.querySelector('.sec-rail-item.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    const main = $('questions-container');
    if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 40);
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
  const participantsCard = $('participants-card');
  const attendanceCard = $('ausencias-card');
  const intro = !schema.length || SEC_ESTADO.idx === 0;
  [participantsCard, attendanceCard].forEach(card => {
    if (card) card.style.display = intro ? '' : 'none';
  });
  if (!schema.length) { renderRail(); renderBottomBar(); return; }
  secClampIndex();
  const st = readState().answers;
  const secs = seccionesDelEsquema();
  const cur = _secDeIdx(SEC_ESTADO.idx, secs) || secs[0];
  let activeIds = null;
  if (cur) {
    // Preguntas visibles de la sección + su tarjeta «marca» SIEMPRE que el
    // í­ndice activo sea de esa misma sección (la marca no es una pregunta
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
}

// Cambios de esquema desde el servidor que afectan a las condiciones:
//   · Una condición cuyo qid ya no existe se limpia (edit_pregunta) para no
//     dejar secciones ocultas permanentemente por datos huérfanos.
//   · Si la pregunta activa quedó oculta o eliminada, el raí­l salta a la
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

// -- Estado de respuesta de una pregunta (para el raí­l âœ“/○) -----------------
function _secHasAnswer(raw, tipo) {
  if (raw == null) return false;
  if (tipo === 'textarea') return true;
  if (Array.isArray(raw)) return raw.length > 0;
  if (tipo === 'disponibilidad') {
    return !!(raw.rangos && raw.rangos.length) || !!(raw.preferencias && raw.preferencias.length) ||
           !!raw.soloFinde || !!raw.soloEntreSemana || !!raw.meDaIgual ||
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

// -- Raí­l de secciones -------------------------------------------------------
// El raí­l pinta SECCIONES (agrupaciones de config.seccion), no preguntas:
// cada entrada muestra el tí­tulo de la sección, su estado global (âœ“ si todas
// sus preguntas visibles están respondidas, âŒ€ si ninguna aplica, ●/○ en otro
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
    b.setAttribute('role', 'button'); b.tabIndex = 0;
    b.className = 'sec-rail-item' + (active ? ' active' : '') + (allHidden ? ' not-applicable' : '');
    b.setAttribute('aria-current', active ? 'step' : 'false');
    const statusIcon = allHidden ? '\u2205' : answered ? '\u2713' : active ? '\u25CF' : '\u25CB';
    const num = String(shownNum || 1).padStart(2, '0');
    b.innerHTML =
      `<span class="sec-rail-status" aria-hidden="true">${statusIcon}</span>` +
      `<span class="sec-rail-num">${num}</span>` +
      `<span class="sec-rail-label">${esc(sec.titulo)}</span>` +
      (allHidden ? '<span class="sec-rail-na">no aplica</span>' : '');
    b.title = allHidden ? sec.titulo + ' — no aplica con las respuestas actuales' : sec.titulo;
    b.addEventListener('click', () => {
      const idx = _secPrimeraVisible(sec, st);
      if (idx >= 0) goToSection(idx);
    });
    b.addEventListener('keydown', e => {
      if (e.target !== b || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault(); b.click();
    });

    const tools = div('sec-rail-tools');
    const rename = document.createElement('button');
    rename.type = 'button'; rename.className = 'sec-rail-tool'; rename.textContent = '\u270E';
    rename.title = 'Renombrar sección'; rename.setAttribute('aria-label', rename.title);
    rename.addEventListener('click', e => {
      e.stopPropagation();
      if (tools.querySelector('.sec-rail-rename-form')) return;
      const form = div('sec-rail-rename-form');
      form.innerHTML = '<input type="text" maxlength="60" aria-label="Nuevo nombre de sección">' +
        '<button type="button" class="sec-rail-tool" title="Guardar nombre">&#10003;</button>' +
        '<button type="button" class="sec-rail-tool" title="Cancelar">&#215;</button>';
      tools.appendChild(form);
      const input = form.querySelector('input'); input.value = sec.titulo; input.focus(); input.select();
      const close = () => form.remove();
      form.querySelectorAll('button')[1].addEventListener('click', e2 => { e2.stopPropagation(); close(); });
      form.querySelectorAll('button')[0].addEventListener('click', e2 => {
        e2.stopPropagation(); renombrarSeccion(sec, input.value.trim());
      });
      input.addEventListener('keydown', e2 => {
        if (e2.key === 'Enter') form.querySelectorAll('button')[0].click();
        if (e2.key === 'Escape') close();
      });
    });
    tools.appendChild(rename);
    [[-1, '\u25B2', 'Subir sección'], [1, '\u25BC', 'Bajar sección']].forEach(([dir, glyph, title]) => {
      const ctl = document.createElement('button');
      ctl.type = 'button'; ctl.className = 'sec-rail-tool'; ctl.textContent = glyph;
      ctl.title = title; ctl.setAttribute('aria-label', title);
      ctl.disabled = (si === 0 && dir < 0) || (si === secs.length - 1 && dir > 0);
      ctl.addEventListener('click', e => { e.stopPropagation(); moverSeccion(sec, si, Number(dir)); });
      tools.appendChild(ctl);
    });
    if (sec.encabezadoIdx >= 0) {
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'sec-rail-tool sec-rail-delete'; del.textContent = '\u00D7';
      del.title = 'Eliminar sección (conservar preguntas)'; del.setAttribute('aria-label', del.title);
      del.addEventListener('click', e => { e.stopPropagation(); eliminarSeccion(sec); });
      tools.appendChild(del);
    }
    const mergeChoices = secs.filter(other => other !== sec && (other.nombre || other.titulo));
    if (mergeChoices.length) {
      const merge = document.createElement('button');
      merge.type = 'button'; merge.className = 'sec-rail-tool sec-rail-merge';
      merge.textContent = '\u21C4'; merge.title = 'Combinar con otra sección';
      merge.setAttribute('aria-label', merge.title);
      merge.addEventListener('click', e => {
        e.stopPropagation();
        const select = document.createElement('select');
        select.className = 'sec-rail-merge-select';
        select.setAttribute('aria-label', `Combinar ${sec.titulo} con`);
        select.innerHTML = '<option value="">Combinar con…</option>' +
          mergeChoices.map((other, oi) => `<option value="${oi}">${esc(other.titulo)}</option>`).join('');
        select.addEventListener('change', () => {
          if (select.value === '') return;
          const target = mergeChoices[Number(select.value)];
          if (target) combinarSeccion(sec, target);
          select.remove();
        });
        tools.appendChild(select); select.focus();
      });
      tools.appendChild(merge);
    }
    b.appendChild(tools);

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

function railInsertAfter(anchor, node) {
  const rail = $('sec-rail');
  if (!rail || !node) return;
  const groupInfo = rail.querySelector('.sec-groupinfo-row');
  rail.insertBefore(node, groupInfo || null);
}

function secAddSectionButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sec-rail-add';
  btn.textContent = '+ Nueva sección';
  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    const form = div('sec-rail-add-form');
    form.innerHTML = '<input type="text" maxlength="60" placeholder="Nombre de la sección">' +
      '<div class="sec-rail-add-actions"><button type="button" class="btn-pc sec-aa-cancel">Cancelar</button>' +
      '<button type="button" class="btn-propose sec-aa-ok">Crear →</button></div>';
    railInsertAfter(btn, form);
    const input = form.querySelector('input'); input.focus();
    const close = () => { form.remove(); btn.style.display = ''; };
    form.querySelector('.sec-aa-cancel').addEventListener('click', close);
    const create = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (!user) { close(); showStatus('Inicia sesión para crear secciones.', 'err'); return; }
      if (secNombreExiste(name)) { showStatus(`Ya existe una sección llamada «${name}».`, 'err'); return; }
      close();
      const id = 'seccion_' + name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) + '_' + Date.now().toString(36);
      const q = { id, tipo: 'textarea', label: name, opciones: [], config: { esEncabezado: true, seccion: name, descripcion: '' } };
      schema.push(q);
      const card = buildQuestionCard(q, schema.length - 1);
      $('questions-container')?.appendChild(card);
      try {
        await apiPost({ action: 'add_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, pregunta: q });
        lastRaw = ''; await pollOnce();
        if (typeof rebindAddQSeccion === 'function') rebindAddQSeccion();
        refreshSecciones(); goToSectionDeNombre(name);
        showStatus(`Sección «${name}» creada.`, 'ok', 3500);
      } catch (e) {
        card?.remove(); schema = schema.filter(item => item.id !== id);
        showStatus('No se pudo crear la sección: ' + e.message, 'err', 6000);
        refreshSecciones();
      }
    };
    form.querySelector('.sec-aa-ok').addEventListener('click', create);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') close(); });
  });
  return btn;
}

async function persistSectionOrder(ordered) {
  if (!user) throw new Error('La sesión ha caducado. Inicia sesión de nuevo.');
  const ids = ordered.map(q => q.id);
  await apiAuth({ action: 'reordenar_preguntas', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, ids });
  schema = ordered;
  const cont = $('questions-container');
  if (cont) ordered.forEach(q => { const card = cardFor(q.id); if (card) cont.appendChild(card); });
  renumberCards(); lastRaw = ''; refreshSecciones();
}

async function colocarPreguntaEnSeccion(qid, nombre) {
  if (!nombre) return true;
  const q = schema.find(item => item.id === qid);
  const section = seccionesDelEsquema().find(s => _secNormNombre(s.nombre || s.titulo) === _secNormNombre(nombre));
  if (!q || !section) return false;
  const header = section.encabezadoIdx >= 0 ? schema[section.encabezadoIdx] : null;
  const sectionQuestions = section.items
    .filter(it => it.q.id !== qid && it.q !== header)
    .map(it => it.q);
  const memberIds = new Set([...sectionQuestions, ...(header ? [header] : []), q].map(item => item.id));
  const firstSectionIndex = schema.findIndex(item => memberIds.has(item.id));
  const ordered = schema.filter(item => !memberIds.has(item.id));
  const insertAt = schema.slice(0, Math.max(0, firstSectionIndex)).filter(item => !memberIds.has(item.id)).length;
  // Repara grupos antiguos: encabezado primero, y preguntas del grupo juntas.
  const sectionBlock = [...(header ? [header] : []), ...sectionQuestions, q];
  ordered.splice(insertAt, 0, ...sectionBlock);
  const positions = new Map(ordered.map((item, i) => [item.id, i]));
  for (const item of ordered) {
    const sourceId = item.config?.mostrarSi?.qid;
    if (sourceId && positions.has(sourceId) && positions.get(sourceId) >= positions.get(item.id)) {
      showStatus('No se pudo colocar la pregunta junto a esa sección porque rompería una dependencia condicional.', 'err', 6500);
      return false;
    }
  }
  await persistSectionOrder(ordered);
  return true;
}

async function moverSeccion(sec, index, delta) {
  const sections = seccionesDelEsquema(), targetIndex = index + delta;
  if (!user || targetIndex < 0 || targetIndex >= sections.length) return;
  const reordered = sections.slice();
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  const ids = reordered.flatMap(s => s.items.map(it => it.q.id));
  const byId = new Map(schema.map(q => [q.id, q]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  const pos = new Map(ordered.map((q, i) => [q.id, i]));
  for (const q of ordered) {
    const dep = q.config?.mostrarSi?.qid;
    if (dep && pos.has(dep) && pos.get(dep) >= pos.get(q.id)) {
      showStatus(`No se puede mover la sección: «${q.label}» depende de una pregunta que quedaría detrás.`, 'err', 6000);
      return;
    }
  }
  try { await persistSectionOrder(ordered); }
  catch (e) { showStatus('No se pudo reordenar la sección: ' + e.message, 'err', 6000); }
}

async function eliminarSeccion(sec) {
  if (!user || sec.encabezadoIdx < 0) return;
  const header = schema[sec.encabezadoIdx];
  try {
    for (const { q } of sec.items) {
      if (q === header) continue;
      const config = { ...(q.config || {}) }; delete config.seccion;
      await apiAuth({ action: 'edit_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: q.id, config });
      q.config = config;
    }
    await apiAuth({ action: 'delete_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: header.id });
    schema = schema.filter(q => q.id !== header.id); cardFor(header.id)?.remove();
    lastRaw = ''; await pollOnce(); refreshSecciones();
    showStatus(`Sección «${sec.titulo}» eliminada; se conservaron sus preguntas.`, 'ok', 4000);
  } catch (e) {
    lastRaw = ''; await pollOnce(); refreshSecciones();
    showStatus('No se pudo eliminar la sección: ' + e.message, 'err', 7000);
  }
}

async function combinarSeccion(source, target) {
  if (!user || source === target) return;
  const name = target.nombre || target.titulo;
  const sourceHeader = source.encabezadoIdx >= 0 ? schema[source.encabezadoIdx] : null;
  try {
    for (const { q } of source.items) {
      if (q === sourceHeader) continue;
      const config = { ...(q.config || {}), seccion: name };
      await apiAuth({ action: 'edit_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: q.id, config });
      q.config = config;
    }
    if (sourceHeader) {
      await apiAuth({ action: 'delete_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: sourceHeader.id });
      schema = schema.filter(q => q.id !== sourceHeader.id); cardFor(sourceHeader.id)?.remove();
    }
    lastRaw = ''; await pollOnce(); refreshSecciones();
    showStatus(`Sección combinada con «${name}».`, 'ok', 3500);
  } catch (e) {
    lastRaw = ''; await pollOnce(); refreshSecciones();
    showStatus('No se pudo combinar la sección: ' + e.message, 'err', 7000);
  }
}

async function renombrarSeccion(sec, nombre) {
  if (!user || !nombre) return;
  const memberIds = new Set(sec.items.map(it => it.q.id));
  const conflict = seccionesDelEsquema().find(other =>
    !other.items.some(it => memberIds.has(it.q.id)) &&
    _secNormNombre(other.nombre || other.titulo) === _secNormNombre(nombre));
  if (conflict) {
    showStatus(`Ya existe «${conflict.titulo}». Usa «Combinar» para unir ambas secciones.`, 'err', 5000);
    return;
  }
  const header = sec.encabezadoIdx >= 0 ? schema[sec.encabezadoIdx] : null;
  try {
    for (const { q } of sec.items) {
      const config = { ...(q.config || {}), seccion: nombre };
      if (q === header) config.esEncabezado = true;
      await apiAuth({ action: 'edit_pregunta', eid: user.eid, nombre: user.nombre,
        pinHash: user.pinHash, questionId: q.id,
        ...(q === header ? { label: nombre } : {}), config });
    }


    if (!header) await crearEncabezadoParaSeccion(nombre, sec.items);
    lastRaw = ''; await pollOnce(); refreshSecciones();
    if (typeof rebindAddQSeccion === 'function') rebindAddQSeccion();
    showStatus(`Sección renombrada a «${nombre}».`, 'ok', 3000);
  } catch (e) {
    showStatus('No se pudo renombrar la sección: ' + e.message + '. Actualiza los datos si solo se cambió una parte.', 'err', 7000);
    pollOnce();
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

// -- Barra inferior fija: Anterior · sección n/N · Siguiente · Enviar -------
// La unidad de navegación es la SECCIí“N (agrupación de config.seccion), no la
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

// -- Panel «Lo que responde el grupo» bajo cada sección ---------------------
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

// Pinta las estadí­sticas del grupo de UNA pregunta (usa el motor del
// reformulario ví­a su override de sección única, sin parchearlo).
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
      box.innerHTML = '<div class="reform-stats-empty">Tipo de pregunta sin estadí­sticas disponibles todaví­a.</div>';
    }
  } catch (e) {
    console.warn('No se pudieron calcular las estadí­sticas de', qid, e);
    box.innerHTML = '';
  }
}

// Repinta los paneles de estadí­sticas de forma agrupada (debounced) cuando
// llegan datos nuevos (polling, enví­os, cambios de esquema…).
function scheduleRefreshSections() {
  clearTimeout(_secStatsTimer);
  _secStatsTimer = setTimeout(() => {
    if (activeMode === 'survey') decorateSectionStats();
  }, 350);
}

// Barras flotantes: solo existe la barra inferior del cuestionario.
function updateFloatingBars() {
  const nav = $('sec-nav');
  if (nav) nav.classList.toggle('visible', activeMode === 'survey');
}

// -- Enlazado (se llama una vez desde main.js, en DOMContentLoaded) ---------
function initSecciones() {
  const prev = $('sec-prev'), next = $('sec-next');
  if (prev) prev.addEventListener('click', prevSection);
  if (next) next.addEventListener('click', nextSection);
  // El enví­o (#sec-submit) se enlaza en bindSubmit() (answers.js), que es el
  // dueño del flujo; aquí­ solo la navegación y el ajuste de información.

  const sel = $('sec-groupinfo-mode');
  if (sel) {
    sel.value = getGroupInfoMode();
    sel.addEventListener('change', () => setGroupInfoMode(sel.value));
  }

  // Teclado: â† → para navegar entre secciones.
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
