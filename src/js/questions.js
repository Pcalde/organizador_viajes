// ── RENDER Y GESTIÓN CRUD DEL ESQUEMA DE PREGUNTAS (js/questions.js) ────────

function cardFor(qid) {
  return [...document.querySelectorAll('#questions-container > .card')]
    .find(c => c.dataset.qid === qid) || null;
}

function findItem(root, val) {
  return [...root.querySelectorAll('[data-val]')].find(e => e.dataset.val === val) || null;
}

function buildQuestionCard(q, idx) {
  const type = TIPOS[q.tipo];
  if (!type) return null;

  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.qid = q.id;
  card.state = {};
  card.dataset.cfg = JSON.stringify(q.config || {});

  const header = div('card-title-row');
  const title  = div('card-title');
  title.style.marginBottom = '0';
  title.innerHTML = `<span class="num">${idx + 1}</span> <span class="q-label-text">${esc(q.label)}</span>`;

  const actions = div('card-q-actions');
  const btnEdit = document.createElement('button');
  btnEdit.type = 'button'; btnEdit.className = 'btn-icon-subtle'; btnEdit.title = 'Editar pregunta'; btnEdit.textContent = '✎';
  const btnDel  = document.createElement('button');
  btnDel.type  = 'button'; btnDel.className  = 'btn-icon-subtle danger'; btnDel.title = 'Eliminar pregunta'; btnDel.textContent = '🗑';

  const mkMove = (txt, title, dir) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn-icon-subtle'; b.title = title; b.textContent = txt;
  b.addEventListener('click', () => moverPregunta(q.id, dir));
  return b;
  };
  actions.append(mkMove('▲', 'Subir', -1), mkMove('▼', 'Bajar', 1), btnEdit, btnDel);
  header.append(title, actions);
  card.appendChild(header);

  if (q.config && q.config.descripcion) {
      const d = div('q-desc md-content'); 
      d.innerHTML = renderMarkdown(q.config.descripcion); 
      card.appendChild(d);
  }

  // Panel inline para editar título / configuración de la pregunta
  const editBox = div('q-edit-inline');
  editBox.style.display = 'none';
  const cfg = q.config || {};
  editBox.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;width:100%">
      <label style="font-size:0.78rem;color:var(--muted)">Título de la pregunta</label>
      <input type="text" class="inp-edit-q-label" value="${esc(q.label)}" maxlength="200">
      ${q.tipo === 'slider' ? `
        <div class="slider-config" style="margin-top:4px">
          <div><label>Mínimo</label><input type="number" class="inp-eq-min" value="${cfg.min ?? 10}"></div>
          <div><label>Máximo</label><input type="number" class="inp-eq-max" value="${cfg.max ?? 500}"></div>
          <div><label>Paso</label><input type="number" class="inp-eq-step" value="${cfg.step ?? 10}"></div>
        </div>
      ` : ''}

      ${q.tipo === 'horarios' ? `
        <label style="font-size:0.78rem;color:var(--muted)">Duración ideal del plan (h)</label>
        <input type="number" class="inp-eq-dur" value="${cfg.duracionIdeal ?? 3}" min="1" max="12">
        <label style="font-size:0.78rem;color:var(--muted)">Franjas horarias (afectan a todo el grupo)</label>
        <div class="eq-franjas-host"></div>
      ` : ''}
      <label style="font-size:0.78rem;color:var(--muted)">Descripción / texto explicativo (opcional)</label>
        <textarea class="inp-edit-q-desc" rows="2" maxlength="500" placeholder="Texto que verá el grupo bajo el título">${esc(cfg.descripcion || '')}</textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
        <button type="button" class="btn-pc btn-cancel-eq">Cancelar</button>
        <button type="button" class="btn-propose btn-save-eq" style="padding:6px 14px;font-size:0.8rem">Guardar cambios</button>
      </div>
    </div>
  `;
  card.appendChild(editBox);
  let getFr = null;
  if (q.tipo === 'horarios') getFr = buildFranjasEditor(editBox.querySelector('.eq-franjas-host'), getFranjas(q));

  btnEdit.addEventListener('click', () => {
    editBox.style.display = editBox.style.display === 'none' ? 'flex' : 'none';
  });
  editBox.querySelector('.btn-cancel-eq').addEventListener('click', () => {
    editBox.style.display = 'none';
  });
  editBox.querySelector('.btn-save-eq').addEventListener('click', async () => {
    const newLabel = editBox.querySelector('.inp-edit-q-label').value.trim();
    if (!newLabel || !user) return;
    let newCfg = Object.assign({}, q.config || {});
    if (q.tipo === 'slider') {
      newCfg.min  = Number(editBox.querySelector('.inp-eq-min').value);
      newCfg.max  = Number(editBox.querySelector('.inp-eq-max').value);
      newCfg.step = Number(editBox.querySelector('.inp-eq-step').value) || 1;
    }
    if (q.tipo === 'horarios') {
      newCfg.franjas = getFr();
      if (!newCfg.franjas.length) { showStatus('Define al menos una franja válida', 'err'); return; }
      newCfg.duracionIdeal = Math.max(1, Math.min(12, Number(editBox.querySelector('.inp-eq-dur').value) || 3));
    }
    newCfg.descripcion = editBox.querySelector('.inp-edit-q-desc').value.trim();
    try {
      await apiAuth({
        action: 'edit_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: q.id, label: newLabel, config: newCfg,
      });
      q.label = newLabel;
      q.config = newCfg;
      renderAllQuestions();
      restoreDraft();
      showStatus('Pregunta actualizada', 'ok', 2500);
      pollOnce();
    } catch (e) {
      showStatus('No se pudo editar la pregunta: ' + e.message, 'err');
    }
  });

  // Panel de confirmación inline para eliminar la pregunta completa (sin window.confirm)
  const delBox = div('q-edit-inline');
  delBox.style.display = 'none';
  delBox.style.borderColor = 'var(--accent)';
  delBox.innerHTML = `
    <div class="inline-confirm-bar" style="width:100%">
      <span>¿Seguro que quieres eliminar la sección <b>«${esc(q.label)}»</b> para todo el grupo?</span>
      <div style="display:flex;gap:6px">
        <button type="button" class="btn-pc btn-qdel-cancel">Cancelar</button>
        <button type="button" class="btn-pc btn-pc-contra btn-qdel-confirm">Sí, eliminar pregunta</button>
      </div>
    </div>
  `;
  card.appendChild(delBox);

  btnDel.addEventListener('click', () => {
    editBox.style.display = 'none';
    delBox.style.display = delBox.style.display === 'none' ? 'flex' : 'none';
  });
  delBox.querySelector('.btn-qdel-cancel').addEventListener('click', () => {
    delBox.style.display = 'none';
  });
  delBox.querySelector('.btn-qdel-confirm').addEventListener('click', async () => {
    if (!user) return;
    const cBtn = delBox.querySelector('.btn-qdel-confirm');
    cBtn.disabled = true;
    cBtn.textContent = 'Eliminando…';
    try {
      await apiAuth({
        action: 'delete_pregunta',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: q.id,
      });
      schema = schema.filter(x => x.id !== q.id);
      card.remove();
      const domOrder = [...container.querySelectorAll(':scope > .card')].map(c => c.dataset.qid).join();
      if (domOrder !== schema.map(q => q.id).join()) {
        schema.forEach(q => { const c = cardFor(q.id); if (c) container.appendChild(c); });
      }
      renumberCards();
      showStatus('Pregunta eliminada', 'ok', 2500);
      pollOnce();
    } catch (e) {
      cBtn.disabled = false;
      cBtn.textContent = 'Sí, eliminar pregunta';
      showStatus('No se pudo eliminar la pregunta: ' + e.message, 'err');
    }
  });

  type.build(card, q);
  return card;
}

function renumberCards() {
  document.querySelectorAll('#questions-container > .card').forEach((c, i) => {
    const num = c.querySelector('.card-title .num');
    if (num) num.textContent = i + 1;
  });
}

function renderAllQuestions() {
  const container = $('questions-container');
  if (!container) return;
  container.innerHTML = '';

  if (!schema.length) {
    const empty = div('card');
    empty.dataset.emptyNotice = '1';
    empty.innerHTML = `
      <div class="card-title"><span class="num">✨</span> Encuesta en blanco</div>
      <p style="font-size:0.88rem;color:var(--muted)">
        Esta encuesta no tiene preguntas todavía. Pulsa <b>«+ Proponer una nueva pregunta al grupo»</b> justo debajo para añadir las secciones que necesitéis.
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  schema.forEach((q, idx) => {
    const card = buildQuestionCard(q, idx);
    if (card) container.appendChild(card);
  });
  refreshAllPC();
}

function syncSchemaToDOM() {
  const container = $('questions-container');
  if (!container) return;

  // Quitar aviso de encuesta vacía si ya hay preguntas
  const emptyNotice = container.querySelector('[data-empty-notice]');
  if (emptyNotice && schema.length) emptyNotice.remove();

  // 1. Eliminar tarjetas de preguntas que ya no existen en `schema`
  const validQids = new Set(schema.map(q => q.id));
  [...container.querySelectorAll(':scope > .card')].forEach(c => {
    if (c.dataset.qid && !validQids.has(c.dataset.qid)) c.remove();
  });

  if (!schema.length) {
    renderAllQuestions();
    return;
  }

  // 2. Añadir o sincronizar cada pregunta
  schema.forEach((q, idx) => {
    const card = cardFor(q.id);
    if (!card) {
      const nueva = buildQuestionCard(q, idx);
      if (nueva) container.appendChild(nueva);
      return;
    }
      if (q.tipo === 'horarios' && card.dataset.cfg !== JSON.stringify(q.config || {})) {
      const prev  = TIPOS.horarios.read(card, q);
      const nueva = buildQuestionCard(q, idx);
      if (nueva) { card.replaceWith(nueva); TIPOS.horarios.write(nueva, q, prev); }
      return;
    }

    // Actualizar título si cambió
    const lblEl = card.querySelector('.q-label-text');
    if (lblEl && lblEl.textContent !== q.label) lblEl.textContent = q.label;

    const desc = (q.config && q.config.descripcion) || '';
    let de = card.querySelector(':scope > .q-desc');
    if (desc) {
        if (!de) { 
            de = div('q-desc md-content'); 
            card.querySelector('.card-title-row').after(de); 
        }
        de.innerHTML = renderMarkdown(desc);
    } else if (de) de.remove();

    const type = TIPOS[q.tipo];
    if (!type || !type.addOption) return;

    // Eliminar opciones borradas
    const validOptVals = new Set((q.opciones || []).map(op => optVal(q, op)));
    [...card.querySelectorAll('[data-val]')].forEach(el => {
      if (!validOptVals.has(el.dataset.val)) el.remove();
    });

    // Añadir opciones nuevas
    (q.opciones || []).forEach(op => {
      if (!findItem(card, optVal(q, op))) type.addOption(card, q, op, false);
    });
  });

  renumberCards();
}
function moveCardDom(qid, dir) {
  const c = cardFor(qid);
  if (!c) return;
  if (dir < 0 && c.previousElementSibling) c.parentNode.insertBefore(c, c.previousElementSibling);
  if (dir > 0 && c.nextElementSibling)     c.nextElementSibling.after(c);
  renumberCards();
}

async function moverPregunta(qid, dir) {
  const i = schema.findIndex(x => x.id === qid), j = i + dir;
  if (!user || i < 0 || j < 0 || j >= schema.length) return;
  [schema[i], schema[j]] = [schema[j], schema[i]];
  moveCardDom(qid, dir);
  try {
    await apiAuth({ action: 'reordenar_preguntas', eid: user.eid, nombre: user.nombre,
                    pinHash: user.pinHash, ids: schema.map(x => x.id) });
    lastRaw = ''; // Aplicar el orden confirmado del servidor en el siguiente sondeo.
    pollOnce();
  } catch (e) {
    [schema[i], schema[j]] = [schema[j], schema[i]];
    moveCardDom(qid, -dir);
    showStatus('No se pudo reordenar: ' + e.message, 'err');
  }
}
