// ── RESPUESTAS, BORRADOR, HIDRATACIÓN Y ENVÍO ───────────────────────────────

let patchTimer = null;

function setDraftDirty(isDirty) {
  draftDirty = isDirty;
  const badge = $('badge-draft');
  if (badge) badge.style.display = isDirty ? 'inline' : 'none';
  const syncTxt = $('sticky-sync-state');
  if (syncTxt) {
    syncTxt.textContent = isDirty
      ? '● Tienes cambios en borrador local sin enviar al grupo'
      : '✓ Tus respuestas están sincronizadas con el grupo';
    syncTxt.classList.toggle('unsaved', isDirty);
  }
}

function triggerSave() {
  setDraftDirty(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, SAVE_DEBOUNCE);
}

function readState() {
  const answers = {};
  schema.forEach(q => {
    const card = cardFor(q.id), type = TIPOS[q.tipo];
    if (card && type) answers[q.id] = type.read(card, q);
  });
  return Object.assign({ answers }, (typeof readAusencias === 'function' && readAusencias()) || {});
}

function saveDraft() {
  if (!user) return;
  try { localStorage.setItem(LS_DRAFT(user.eid), JSON.stringify(readState())); } catch (e) {}
}

function restoreDraft() {
  if (!user) return;
  try {
    const raw = localStorage.getItem(LS_DRAFT(user.eid));
    if (!raw) {
      hydrateFromServerIfNoDraft();
      return;
    }
    const d = JSON.parse(raw);
    schema.forEach(q => {
      const card = cardFor(q.id), type = TIPOS[q.tipo];
      if (!card || !type || !d.answers || !(q.id in d.answers)) return;
      try { type.write(card, q, d.answers[q.id]); }
      catch (e) { console.warn('Borrador: no se pudo restaurar', q.id, e); }
    });
    if (typeof writeAusencias === 'function') writeAusencias(d);
    setDraftDirty(true);
  } catch (e) {
    console.warn('Borrador ilegible, se ignora.', e);
  }
}

// Si el usuario no tiene borrador local pero ya respondió antes en servidor, hidrata su formulario
function hydrateFromServerIfNoDraft() {
  if (!user || !respuestas || !respuestas.length) return;
  const mine = respuestas.find(r => r.nombre.toLowerCase() === user.nombre.toLowerCase());
  if (!mine || !mine.answers) return;

  schema.forEach(q => {
    const card = cardFor(q.id), type = TIPOS[q.tipo];
    const val  = extractAnswer(mine.answers, q);
    if (card && type && val != null) {
      try { type.write(card, q, val); } catch (e) {}
    }
  });
  if (typeof writeAusencias === 'function') {
    writeAusencias({
      ausencias_predichas: mine.answers.ausencias_predichas,
      prob_asistencia_propia: mine.answers.prob_asistencia_propia,
    });
  }
  setDraftDirty(false);
}

// Genera el payload: guarda el mapa uniforme `values` y mantiene las propiedades legacy
function collectAnswers() {
  const st = readState();
  const result = {
    timestamp: new Date().toISOString(),
    values: st.answers,
    opciones: [],
    casas: [],
    extras: {},
  };

  schema.forEach(q => {
    const v = st.answers[q.id];
    if (v == null) return;
    switch (q.id) {
      case 'opciones-destino': result.opciones    = v; break;
      case 'casas':            result.casas       = v; break;
      case 'precio':           result.precioMaxPP = v; break;
      case 'transporte':       result.transporte  = v; break;
      case 'disponibilidad':
        result.diasMax = v.diasMax;
        result.disponibilidad = { soloFinde: v.soloFinde, meDaIgual: v.meDaIgual, preferirPuente: v.preferirPuente };
        result.rangosFechas = v.rangos;
        break;
      default: result.extras[q.id] = v;
    }
  });

  if (st.ausencias_predichas) {
    result.ausencias_predichas    = st.ausencias_predichas;
    result.prob_asistencia_propia = st.prob_asistencia_propia;
  }
  return result;
}

function validarRespuestas() {
  for (const q of schema) {
    if (q.tipo !== 'disponibilidad') continue;
    const card = cardFor(q.id);
    if (!card) continue;
    const malo = TIPOS.disponibilidad.read(card, q).rangos.find(r => r.desde && r.hasta && r.hasta < r.desde);
    if (malo) return `Rango de fechas inválido (${malo.desde} → ${malo.hasta}): el fin no puede ser anterior al inicio.`;
  }
  return null;
}

async function enviarRespuesta(silent = false) {
  if (!user) return;
  const btn = $('btn-generate');

  const err = validarRespuestas();
  if (err) { showStatus(err, 'err', 8000); return; }

  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = 'Enviando…';
  }
  try {
    const answers = collectAnswers();
    const id = { eid: user.eid, nombre: user.nombre, pinHash: user.pinHash };

    // Actualización optimista local en `respuestas` para que el Reformulario responda al instante
    const idx = respuestas.findIndex(r => r.nombre.toLowerCase() === user.nombre.toLowerCase());
    const entry = { nombre: user.nombre, answers, ts: answers.timestamp };
    if (idx >= 0) respuestas[idx] = entry;
    else respuestas.push(entry);
    if (typeof renderReformulario === 'function' && activeMode === 'consensus') {
      renderReformulario();
    }

    await apiPost({ action: 'submit_response', ...id, answers });
    if (answers.ausencias_predichas) {
      await apiPost({ action: 'vote_ausencia', ...id, candidatos: answers.ausencias_predichas, prob_propia: answers.prob_asistencia_propia });
    }

    try { localStorage.removeItem(LS_DRAFT(user.eid)); } catch (e) {}
    setDraftDirty(false);
    if (!silent) showStatus('¡Respuesta sincronizada con el grupo!', 'ok', 3500);
    pollOnce();
  } catch (e) {
    showStatus('Error al enviar: ' + e.message, 'err', 8000);
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = 'Enviar mi respuesta →';
    }
  }
}

// Usado por el Reformulario: modifica una pregunta desde la vista de consenso y sincroniza
function patchSingleAnswer(qid, newVal) {
  const q = schema.find(x => x.id === qid);
  const card = cardFor(qid);
  if (!q || !card || !TIPOS[q.tipo]) return;

  TIPOS[q.tipo].write(card, q, newVal);

  // Actualizar memoria inmediatamente para re-renderizar gráficas sin lag
  const answers = collectAnswers();
  const idx = respuestas.findIndex(r => r.nombre.toLowerCase() === user.nombre.toLowerCase());
  const entry = { nombre: user.nombre, answers, ts: answers.timestamp };
  if (idx >= 0) respuestas[idx] = entry;
  else respuestas.push(entry);

  if (typeof renderReformulario === 'function') renderReformulario();

  clearTimeout(patchTimer);
  patchTimer = setTimeout(() => enviarRespuesta(true), 500);
}

function bindSubmit() {
  const btn = $('btn-generate');
  if (btn) btn.addEventListener('click', () => enviarRespuesta(false));
}