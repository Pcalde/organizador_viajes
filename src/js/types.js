/* ══════════════════════════════════════════════════════════════════════════
   REGISTRO DE TIPOS DE PREGUNTA (Generalizado + Edición/Borrado de Opciones)
   ══════════════════════════════════════════════════════════════════════════ */

function div(cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  return d;
}

function optVal(q, op) {
  if (op && typeof op === 'object') return op.nombre;
  const s = String(op);
  return q.tipo === 'radio' && s.includes('|') ? s.split('|')[0] : s;
}

function pcParts() {
  const badge = div('pc-badge'), panel = div('pc-panel');
  badge.addEventListener('click', () => panel.classList.toggle('open'));
  return [badge, panel];
}

// Controles de edición y borrado para cualquier opción
// ── EDITOR VISUAL INLINE Y BORRADO DE OPCIONES (Sin prompt/confirm) ─────────
function createOptionCrudControls(item, q, rawOp) {
  const qid    = q.id;
  const isCasa = q.tipo === 'casas';
  const isRad  = q.tipo === 'radio';
  const optKey = optVal(q, rawOp);

  // En radio "clave|etiqueta", mostramos la etiqueta en el editor pero preservamos la clave
  const rawStr   = typeof rawOp === 'string' ? rawOp : '';
  const hasPipe  = isRad && rawStr.includes('|');
  const radKey   = hasPipe ? rawStr.split('|')[0] : '';
  const curLabel = isCasa
    ? (rawOp.nombre || '')
    : (hasPipe ? rawStr.split('|').slice(1).join('|') : String(rawOp));

  const wrap  = div('opt-crud-btns');
  const bEdit = document.createElement('button');
  bEdit.type = 'button'; bEdit.className = 'btn-opt-crud'; bEdit.title = 'Editar opción'; bEdit.textContent = '✎';
  const bDel  = document.createElement('button');
  bDel.type  = 'button'; bDel.className  = 'btn-opt-crud danger'; bDel.title = 'Eliminar opción'; bDel.textContent = '✕';
  wrap.append(bEdit, bDel);

  // Contenedor desplegable que se inserta dentro de .opt-item
  const drawer = div('opt-edit-drawer');
  drawer.style.display = 'none';

  const openEditView = () => {
    drawer.style.display = 'flex';
    drawer.className = 'opt-edit-drawer mode-edit';
    if (isCasa) {
      drawer.innerHTML = `
        <div class="opt-edit-grid">
          <div class="opt-edit-field" style="flex:2;min-width:160px">
            <label>Nombre del alojamiento</label>
            <input type="text" class="inp-eo-nombre" value="${esc(rawOp.nombre || '')}" placeholder="Ej. Casa Rural El Pinar">
          </div>
          <div class="opt-edit-field" style="flex:1;min-width:100px">
            <label>Precio</label>
            <input type="text" class="inp-eo-precio" value="${esc(rawOp.precio || '')}" placeholder="Ej. 450 €">
          </div>
          <div class="opt-edit-field" style="flex:2;min-width:180px">
            <label>Enlace (URL)</label>
            <input type="text" class="inp-eo-url" value="${esc(rawOp.url || '')}" placeholder="https://...">
          </div>
          <div class="opt-edit-field" style="flex:2;min-width:180px">
            <label>Foto (URL de imagen)</label>
            <input type="text" class="inp-eo-foto" value="${esc(rawOp.foto || '')}" placeholder="https://…/foto.jpg">
          </div>
        </div>
        <div class="opt-edit-actions">
          <button type="button" class="btn-pc btn-eo-cancel">Cancelar</button>
          <button type="button" class="btn-propose btn-eo-save">Guardar cambios</button>
        </div>
      `;
    } else {
      drawer.innerHTML = `
        <div class="opt-edit-single">
          <input type="text" class="inp-eo-text" value="${esc(curLabel)}" placeholder="Texto de la opción…">
          <button type="button" class="btn-pc btn-eo-cancel">Cancelar</button>
          <button type="button" class="btn-propose btn-eo-save">Guardar</button>
        </div>
      `;
    }

    const firstInp = drawer.querySelector('input');
    if (firstInp) { firstInp.focus(); firstInp.select(); }

    const closeDrawer = () => { drawer.style.display = 'none'; drawer.innerHTML = ''; };
    drawer.querySelector('.btn-eo-cancel').addEventListener('click', closeDrawer);

    const saveBtn = drawer.querySelector('.btn-eo-save');
    saveBtn.addEventListener('click', async () => {
      if (!user) return;
      let nuevaOpcion, newKey;

      if (isCasa) {
        const nombre = drawer.querySelector('.inp-eo-nombre').value.trim();
        const precio = drawer.querySelector('.inp-eo-precio').value.trim();
        const url    = safeUrl(drawer.querySelector('.inp-eo-url').value);
        const foto   = safeUrl(drawer.querySelector('.inp-eo-foto').value);
        if (!nombre) { drawer.querySelector('.inp-eo-nombre').focus(); return; }
        nuevaOpcion = { nombre, precio, url, foto };
        newKey = nombre;
      } else {
        const txt = drawer.querySelector('.inp-eo-text').value.trim();
        if (!txt) { drawer.querySelector('.inp-eo-text').focus(); return; }
        nuevaOpcion = hasPipe ? `${radKey}|${txt}` : txt;
        newKey = hasPipe ? radKey : txt;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Guardando…';

      // Conservar el estado actual del formulario antes de repintar
      const card = cardFor(qid);
      const prevVal = (card && TIPOS[q.tipo]) ? TIPOS[q.tipo].read(card, q) : null;

      try {
        await api({
          action: 'edit_opcion',
          eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
          questionId: qid, oldOptKey: optKey, nuevaOpcion,
        });

        // Actualizar en memoria local
        const idx = (q.opciones || []).findIndex(o => optVal(q, o) === optKey);
        if (idx >= 0) q.opciones[idx] = nuevaOpcion;

        renderAllQuestions();
        restoreDraft();

        // Si el usuario tenía seleccionada la opción renombrada, migrar su selección a newKey
        const newCard = cardFor(qid);
        if (newCard && prevVal != null && newKey !== optKey) {
          if (q.tipo === 'checkbox' && Array.isArray(prevVal)) {
            TIPOS.checkbox.write(newCard, q, prevVal.map(v => v === optKey ? newKey : v));
          } else if (q.tipo === 'voto-ponderado' && typeof prevVal === 'object') {
            if (optKey in prevVal) { prevVal[newKey] = prevVal[optKey]; delete prevVal[optKey]; }
            TIPOS['voto-ponderado'].write(newCard, q, prevVal);
          } else if (q.tipo === 'casas' && Array.isArray(prevVal)) {
            TIPOS.casas.write(newCard, q, prevVal.map(c => (c.nombre === optKey ? { nombre: newKey, precio: nuevaOpcion.precio } : c)));
          }
          triggerSave();
        }

        showStatus('Opción actualizada', 'ok', 2000);
        pollOnce();
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Guardar';
        showStatus('No se pudo editar la opción: ' + err.message, 'err');
      }
    });

    drawer.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter')  { ev.preventDefault(); saveBtn.click(); }
        if (ev.key === 'Escape') { ev.preventDefault(); closeDrawer(); }
      });
    });
  };

  const openDeleteView = () => {
    drawer.style.display = 'flex';
    drawer.className = 'opt-edit-drawer mode-delete';
    drawer.innerHTML = `
      <div class="inline-confirm-bar">
        <span>¿Eliminar la opción <b>«${esc(curLabel)}»</b> para todo el grupo?</span>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn-pc btn-del-cancel">Cancelar</button>
          <button type="button" class="btn-pc btn-pc-contra btn-del-confirm">Sí, eliminar</button>
        </div>
      </div>
    `;

    drawer.querySelector('.btn-del-cancel').addEventListener('click', () => {
      drawer.style.display = 'none';
      drawer.innerHTML = '';
    });

    const confirmBtn = drawer.querySelector('.btn-del-confirm');
    confirmBtn.addEventListener('click', async () => {
      if (!user) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Eliminando…';
      try {
        await api({
          action: 'delete_opcion',
          eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
          questionId: qid, optKey,
        });
        if (Array.isArray(q.opciones)) {
          q.opciones = q.opciones.filter(o => optVal(q, o) !== optKey);
        }
        item.remove();
        triggerSave();
        showStatus('Opción eliminada', 'ok', 2000);
        pollOnce();
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Sí, eliminar';
        showStatus('No se pudo eliminar: ' + err.message, 'err');
      }
    });
  };

  bEdit.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (drawer.style.display !== 'none' && drawer.classList.contains('mode-edit')) {
      drawer.style.display = 'none';
    } else {
      openEditView();
    }
  });

  bDel.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (drawer.style.display !== 'none' && drawer.classList.contains('mode-delete')) {
      drawer.style.display = 'none';
    } else {
      openDeleteView();
    }
  });

  return { buttons: wrap, drawer };
}

// ── CONSTRUCTORES DE ÍTEMS CON DRAWER VISUAL INTEGRADO ──────────────────────
function createOptItem(q, rawOp) {
  const qObj = typeof q === 'object' ? q : (schema.find(x => x.id === q) || { id: q, tipo: 'checkbox' });
  const val  = optVal(qObj, rawOp);
  const item = div('opt-item');
  item.dataset.qid = qObj.id;
  item.dataset.val = val;

  const row = div('opt-row-with-crud');
  const lbl = document.createElement('label'); lbl.className = 'opt-label'; lbl.style.flex = '1';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.value = val;
  const chk = document.createElement('span');  chk.className = 'check';
  const txt = document.createElement('span');  txt.style.flex = '1'; txt.textContent = val;
  lbl.append(inp, chk, txt);
  inp.addEventListener('change', triggerSave);

  const crud = createOptionCrudControls(item, qObj, rawOp);
  row.append(lbl, crud.buttons);

  const [badge, panel] = pcParts();
  item.append(row, crud.drawer, badge, panel);
  return item;
}

function createPondItem(q, rawOp) {
  const qObj = typeof q === 'object' ? q : (schema.find(x => x.id === q) || { id: q, tipo: 'voto-ponderado' });
  const val  = optVal(qObj, rawOp);
  const item = div('opt-item pond-item');
  item.dataset.qid = qObj.id;
  item.dataset.val = val;

  const row  = div('pond-row');
  const name = document.createElement('span');
  name.style.cssText = 'font-size:0.9rem;font-weight:500;flex:1';
  name.textContent = val;
  const grp  = div('btn-group-pond');
  const btns = [-1, 1, 3].map(s => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-pond';
    b.dataset.score = s; b.textContent = s > 0 ? '+' + s : String(s);
    return b;
  });
  grp.append(...btns);

  const crud = createOptionCrudControls(item, qObj, rawOp);
  row.append(name, grp, crud.buttons);

  btns.forEach(btn => btn.addEventListener('click', () => {
    const score = btn.dataset.score, wasActive = btn.classList.contains('active');
    btns.forEach(b => b.classList.remove('active'));
    if (!wasActive) {
      if (score === '3' || score === '-1') {
        const list = item.closest('.options-list');
        const conflicto = list && list.querySelector(`.btn-pond.active[data-score="${score}"]`);
        if (conflicto) conflicto.classList.remove('active');
      }
      btn.classList.add('active');
    }
    const card = item.closest('.card');
    if (card) updatePondRulesBar(card);
    triggerSave();
  }));

  const [badge, panel] = pcParts();
  item.append(row, crud.drawer, badge, panel);
  return item;
}

function createCasaItem(q, op, n) {
  const qObj = typeof q === 'object' ? q : (schema.find(x => x.id === q) || { id: q, tipo: 'casas' });
  const item = div('opt-item');
  item.dataset.qid = qObj.id;
  item.dataset.val = op.nombre;

  const row = div('casa-row');
  const url = safeUrl(op.url);
  const anchor = url ? document.createElement('a') : document.createElement('span');
  anchor.className = 'casa-num' + (url ? '' : ' no-link');
  if (url) {
    anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    anchor.title = 'Abrir enlace del alojamiento';
    anchor.addEventListener('click', e => e.stopPropagation());
  }
  anchor.textContent = n;

  const lbl = document.createElement('label'); lbl.className = 'casa-label';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.value = op.nombre;
  const chk = document.createElement('span');  chk.className = 'check';
  const txt = document.createElement('span');  txt.style.flex = '1'; txt.textContent = op.nombre;
  lbl.append(inp, chk, txt);
  inp.addEventListener('change', triggerSave);

  const precio = document.createElement('span');
  precio.className = 'casa-precio'; precio.textContent = op.precio || '';
  const foto = safeUrl(op.foto);
  let thumb = null;
  if (foto) {
    thumb = document.createElement('img');
    thumb.className = 'casa-foto'; thumb.src = foto; thumb.alt = op.nombre;
    thumb.loading = 'lazy'; thumb.referrerPolicy = 'no-referrer';
    thumb.addEventListener('error', () => thumb.remove());
    thumb.addEventListener('click', () => window.open(foto, '_blank', 'noopener'));
  }
  const crud = createOptionCrudControls(item, qObj, op);
  row.append(anchor, ...(thumb ? [thumb] : []), lbl, precio, crud.buttons);

  const [badge, panel] = pcParts();
  item.append(row, crud.drawer, badge, panel);
  return item;
}

function createRadioItem(card, q, op) {
  const s = String(op);
  const [val, label] = s.includes('|') ? s.split('|') : [s, s];
  const item = div('opt-item');
  item.dataset.qid = q.id;
  item.dataset.val = val;

  const row = div('opt-row-with-crud');
  const lbl = document.createElement('label'); lbl.className = 'opt-label'; lbl.style.flex = '1';
  const inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'radio-' + q.id; inp.value = val;
  const chk = document.createElement('span');  chk.className = 'check check-radio';
  lbl.append(inp, chk, document.createTextNode(' ' + label));
  inp.addEventListener('change', () => {
    toggleConditionalStepper(card, val);
    triggerSave();
  });

  const crud = createOptionCrudControls(item, q, op);
  row.append(lbl, crud.buttons);
  item.append(row, crud.drawer);
  return item;
}

function checkedValues(card) {
  return [...card.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
}

function getRadioStepperConfig(q) {
  if (q.config && q.config.conditionalStepper) return q.config.conditionalStepper;
  if (q.id === 'transporte') {
    return { when: 'llevo-coche', key: 'plazasLibres', label: 'Plazas libres en mi coche:', min: 1, max: 8, default: 3 };
  }
  return null;
}

function createStepper(min, max, initial, onChange) {
  let v = initial;
  const wrap = div('stepper');
  const m  = document.createElement('button'); m.type = 'button'; m.textContent = '−';
  const sp = document.createElement('span');   sp.textContent = v;
  const p  = document.createElement('button'); p.type = 'button'; p.textContent = '+';
  const set = n => { v = Math.max(min, Math.min(max, n)); sp.textContent = v; };
  m.addEventListener('click', () => { set(v - 1); if (onChange) onChange(v); });
  p.addEventListener('click', () => { set(v + 1); if (onChange) onChange(v); });
  wrap.append(m, sp, p);
  return { el: wrap, get: () => v, set };
}

function updatePondRulesBar(card) {
  const bar = card.querySelector('.pond-rules-bar');
  if (!bar) return;
  const has3   = !!card.querySelector('.btn-pond.active[data-score="3"]');
  const hasM1  = !!card.querySelector('.btn-pond.active[data-score="-1"]');
  const count1 = card.querySelectorAll('.btn-pond.active[data-score="1"]').length;

  const p3  = bar.querySelector('[data-rule="3"]');
  const p1  = bar.querySelector('[data-rule="1"]');
  const pm1 = bar.querySelector('[data-rule="-1"]');

  if (p3)  { p3.classList.toggle('used', has3);       p3.innerHTML  = `★ Favorito (+3): <b>${has3 ? 'Asignado' : '1 disp.'}</b>`; }
  if (p1)  { p1.classList.toggle('used', count1 > 0); p1.innerHTML  = `✓ Me vale (+1): <b>${count1}</b>`; }
  if (pm1) { pm1.classList.toggle('used', hasM1);      pm1.innerHTML = `✕ Veto (-1): <b>${hasM1 ? 'Asignado' : '1 disp.'}</b>`; }
}


function toggleConditionalStepper(card, val) {
  const pw = card.querySelector('.plazas-wrap');
  const cs = card.state && card.state.stepperCfg;
  if (pw && cs) pw.style.display = val === cs.when ? 'flex' : 'none';
}



function addDateRange(card, desde = null, hasta = null) {
  const list = card.querySelector('.ranges-list');
  if (!list) return;
  const row = div('date-range-row');
  const minAttr = (desde || hasta) ? '' : `min="${hoyLocal()}"`;
  row.innerHTML = `<label>Desde</label><input type="date" class="range-from" ${minAttr}><span class="sep">→</span><label>Hasta</label><input type="date" class="range-to" ${minAttr}><button type="button" class="btn-remove" title="Quitar">✕</button>`;
  if (desde) row.querySelector('.range-from').value = desde;
  if (hasta) row.querySelector('.range-to').value   = hasta;
  row.querySelector('.btn-remove').addEventListener('click', () => { row.remove(); triggerSave(); });
  row.querySelectorAll('input').forEach(i => i.addEventListener('change', triggerSave));
  list.appendChild(row);
}

const TOGGLES_DISP = [
  ['irYVenir',       'Plan de ir y venir en el día (sin dormir fuera)'],
  ['soloFinde',      'Solo puedo fines de semana'],
  ['meDaIgual',      'Me da igual entre semana o fin de semana'],
  ['preferirPuente', 'Mejor si hay puente / festivo'],
];

// NOTA: `var` es intencional. Los <script> clásicos comparten el scope global,
// pero las declaraciones `const/let` viven en un "script scope" separado y NO
// son visibles desde otros archivos .js (dan ReferenceError: X is not defined).
// `var` sí crea la propiedad en window, haciendo TIPOS accesible al resto.
var TIPOS = {

  checkbox: {
    build(card, q) {
      const list = div('options-list'); list.dataset.qid = q.id;
      (q.opciones || []).forEach(op => list.appendChild(createOptItem(q.id, optVal(q, op))));
      card.append(list, createAddOptForm(q));
    },
    read: card => checkedValues(card),
    write(card, q, vals) {
      const set = new Set(vals || []);
      card.querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = set.has(i.value); });
    },
    addOption(card, q, op, select) {
      const list = card.querySelector('.options-list');
      if (!list) return null;
      const item = createOptItem(q.id, optVal(q, op));
      if (select) item.querySelector('input').checked = true;
      list.appendChild(item);
      return item;
    },
  },

  'voto-ponderado': {
    build(card, q) {
      const rulesBar = div('pond-rules-bar');
      rulesBar.innerHTML = `
        <span class="rule-pill" data-rule="3">★ Favorito (+3): <b>1 disp.</b></span>
        <span class="rule-pill" data-rule="1">✓ Me vale (+1): <b>0</b></span>
        <span class="rule-pill" data-rule="-1">✕ Veto (-1): <b>1 disp.</b></span>
      `;
      const list = div('options-list'); list.dataset.qid = q.id;
      (q.opciones || []).forEach(op => list.appendChild(createPondItem(q.id, optVal(q, op))));
      card.append(rulesBar, list, createAddOptForm(q));
    },
    read(card) {
      const dict = {};
      card.querySelectorAll('.pond-item').forEach(item => {
        const b = item.querySelector('.btn-pond.active');
        if (b) dict[item.dataset.val] = parseInt(b.dataset.score, 10);
      });
      return dict;
    },
    write(card, q, dict) {
      card.querySelectorAll('.btn-pond.active').forEach(b => b.classList.remove('active'));
      Object.entries(normPond(dict) || {}).forEach(([val, score]) => {
        const item = findItem(card, val);
        const b = item && item.querySelector(`.btn-pond[data-score="${score}"]`);
        if (b) b.classList.add('active');
      });
      updatePondRulesBar(card);
    },
    addOption(card, q, op) {
      const list = card.querySelector('.options-list');
      if (!list) return null;
      const item = createPondItem(q.id, optVal(q, op));
      list.appendChild(item);
      return item;
    },
  },

  casas: {
    build(card, q) {
      const list = div('options-list'); list.dataset.qid = q.id;
      (q.opciones || []).forEach((op, i) => list.appendChild(createCasaItem(q.id, op, i + 1)));
      card.append(list, createAddCasaForm(q));
    },
    read(card, q) {
      return [...card.querySelectorAll('.opt-item')]
        .filter(it => it.querySelector('input[type=checkbox]').checked)
        .map(it => {
          const op = (q.opciones || []).find(o => o.nombre === it.dataset.val);
          return { nombre: it.dataset.val, precio: (op && op.precio) || null };
        });
    },
    write(card, q, casas) {
      const nombres = new Set((casas || []).map(c => typeof c === 'string' ? c : c.nombre));
      card.querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = nombres.has(i.value); });
    },
    addOption(card, q, op, select) {
      const list = card.querySelector('.options-list');
      if (!list) return null;
      const item = createCasaItem(q.id, op, list.children.length + 1);
      if (select) item.querySelector('input').checked = true;
      list.appendChild(item);
      return item;
    },
  },

  // ── horarios (Planificación por franjas + Restricciones de clase/trabajo/examen) ──
    horarios: {
      build(card, q) {
        const cfg = q.config || {};
        card.state.franjas  = getFranjas(q);
        card.state.duracion = createStepper(1, 12, cfg.duracionIdeal ?? 3, triggerSave);

        const wrap = div('horarios-builder');
        wrap.innerHTML = `
          <div class="hor-section">
            <div style="font-size:0.88rem;font-weight:600">1. ¿Qué días (o intervalos de días) y franjas puedes?</div>
            <div style="font-size:0.78rem;color:var(--muted)">Cada bloque es un intervalo de fechas (puede ser un solo día) con las franjas en las que estás libre.</div>
            <div class="day-slots-list"></div>
            <button type="button" class="btn-add btn-add-slot" style="margin-top:8px">+ Añadir intervalo de días y franjas</button>
          </div>

          <div class="hor-section" style="margin-top:20px;padding-top:16px;border-top:1px dashed var(--border)">
            <div style="font-size:0.88rem;font-weight:600">2. Restricciones horarias (clases, trabajo, exámenes…)</div>
            <div style="font-size:0.78rem;color:var(--muted)">Indica cuándo estás ocupado (en un intervalo de fechas o todos los días) para calcular si cuadramos o te unes al salir.</div>
            <div class="restricciones-list"></div>
            <button type="button" class="btn-add btn-add-rest" style="margin-top:8px">+ Añadir restricción horaria</button>
          </div>

          <div class="dias-row" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <span style="font-size:0.88rem;color:var(--muted)">Duración que te apetece para el plan (horas):</span>
            <div class="dur-stepper-slot"></div>
          </div>`;

        wrap.querySelector('.dur-stepper-slot').appendChild(card.state.duracion.el);
        wrap.querySelector('.btn-add-slot').addEventListener('click', () => { addDaySlotRow(card); triggerSave(); });
        wrap.querySelector('.btn-add-rest').addEventListener('click', () => { addRestriccionRow(card); triggerSave(); });
        card.appendChild(wrap);
        addDaySlotRow(card);
      },
      read(card) {
        const disponibilidades = [...card.querySelectorAll('.day-slot-row')].map(r => {
          const desde = r.querySelector('.slot-from').value || null;
          const hasta = r.querySelector('.slot-to').value || desde;
          return { desde, hasta, franjas: [...r.querySelectorAll('.franja-pill.active')].map(b => b.dataset.fid) };
        }).filter(d => d.desde && d.franjas.length);

        const restricciones = [...card.querySelectorAll('.restriccion-row')].map(r => {
          const fd = r.querySelector('.rest-fd').value || null;
          return {
            motivo: r.querySelector('.rest-motivo').value,
            fechaDesde: fd,
            fechaHasta: r.querySelector('.rest-fh').value || fd,
            desde: r.querySelector('.rest-desde').value || null,
            hasta: r.querySelector('.rest-hasta').value || null,
            meUnoAlSalir: r.querySelector('.rest-join-after').checked,
          };
        }).filter(r => r.desde && r.hasta);

        return { disponibilidades, restricciones, duracionHoras: card.state.duracion.get() };
      },
      write(card, q, v) {
        if (!v) return;
        if (v.duracionHoras && card.state.duracion) card.state.duracion.set(v.duracionHoras);
        if (Array.isArray(v.disponibilidades)) {
          card.querySelector('.day-slots-list').innerHTML = '';
          if (v.disponibilidades.length) v.disponibilidades.forEach(d => addDaySlotRow(card, d));
          else addDaySlotRow(card);
        }
        if (Array.isArray(v.restricciones)) {
          card.querySelector('.restricciones-list').innerHTML = '';
          v.restricciones.forEach(r => addRestriccionRow(card, r));
        }
      },
    },

  slider: {
    build(card, q) {
      const cfg  = q.config || {};
      const min  = cfg.min ?? 10, max = cfg.max ?? 500, step = cfg.step ?? 10;
      const def  = cfg.default ?? Math.round((min + max) / 2);
      const unit = cfg.unit ?? (q.id === 'precio' ? ' €' : '');

      const display = div('price-display');
      const slider  = document.createElement('input');
      slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = def;

      const paint = () => {
        const pct = max > min ? ((+slider.value - min) / (max - min)) * 100 : 0;
        slider.style.setProperty('--pct', pct + '%');
        display.textContent = slider.value + unit;
      };
      slider.addEventListener('input', () => { paint(); triggerSave(); });
      paint();
      card.state.slider = slider; card.state.paint = paint;

      const labels = div('price-labels');
      labels.innerHTML = `<span>${esc(min + unit)}</span><span>${esc(max + unit)}</span>`;
      card.append(display, slider, labels);
    },
    read: card => +card.state.slider.value,
    write(card, q, v) {
      if (v == null) return;
      card.state.slider.value = v;
      card.state.paint();
    },
  },

  radio: {
    build(card, q) {
      const wrap = div('transport-opts'); wrap.dataset.qid = q.id;
      const cs   = getRadioStepperConfig(q);
      if (cs) card.state.stepperCfg = cs;

      (q.opciones || []).forEach(op => wrap.appendChild(createRadioItem(card, q, op)));
      card.appendChild(wrap);

      if (cs) {
        card.state.stepper = createStepper(cs.min ?? 1, cs.max ?? 10, cs.default ?? 3, triggerSave);
        const pw  = div('plazas-wrap');
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-size:0.9rem;color:var(--muted)';
        lbl.textContent = cs.label || 'Valor adicional:';
        pw.append(lbl, card.state.stepper.el);
        card.appendChild(pw);
      }
      card.appendChild(createAddOptForm(q));
    },
    read(card, q) {
      const checked = card.querySelector('input[type=radio]:checked');
      if (!checked) return null;
      const cs = card.state.stepperCfg;
      if (cs) {
        const out = { estado: checked.value };
        if (checked.value === cs.when && card.state.stepper) {
          out[cs.key || 'valor'] = card.state.stepper.get();
        }
        return out;
      }
      return checked.value;
    },
    write(card, q, v) {
      if (v == null) return;
      const cs = card.state.stepperCfg;
      const estado = typeof v === 'object' ? v.estado : v;
      const rad = [...card.querySelectorAll('input[type=radio]')].find(r => r.value === estado);
      if (rad) {
        rad.checked = true;
        if (cs) toggleConditionalStepper(card, estado);
      }
      const key = cs && (cs.key || 'valor');
      if (typeof v === 'object' && key && v[key] != null && card.state.stepper) {
        card.state.stepper.set(v[key]);
      }
    },
    addOption(card, q, op, select) {
      const wrap = card.querySelector('.transport-opts');
      if (!wrap) return null;
      const item = createRadioItem(card, q, op);
      wrap.appendChild(item);
      if (select) {
        const inp = item.querySelector('input');
        inp.checked = true;
        toggleConditionalStepper(card, inp.value);
      }
      return item;
    },
  },

  textarea: {
  build(card, q) {
    // Este tipo es una tarjeta informativa, no una pregunta que requiera respuesta.
    const content = div('textarea-comment md-content');
    content.innerHTML = q.config?.descripcion ? renderMarkdown(q.config.descripcion) : '';
    if (content.innerHTML) card.appendChild(content);
  },
  read: () => null,
  write: () => {},
},

  disponibilidad: {
    build(card) {
      card.state.dias = createStepper(1, 30, 5, triggerSave);

      const sec = div();
      const lab = div();
      lab.style.cssText = 'font-size:0.85rem;color:var(--muted);margin-bottom:10px';
      lab.textContent = 'Ventanas de disponibilidad';
      const rl  = div('ranges-list');
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'btn-add'; add.textContent = '+ Añadir rango de fechas';
      add.addEventListener('click', () => { addDateRange(card); triggerSave(); });
      sec.append(lab, rl, add);
      card.appendChild(sec);
      addDateRange(card);

      const diasRow = div('dias-row');
      const dl = document.createElement('span');
      dl.style.cssText = 'font-size:0.9rem;color:var(--muted)';
      dl.textContent = 'Días máximos de viaje:';
      diasRow.append(dl, card.state.dias.el);
      card.appendChild(diasRow);

      const tw = div('toggle-wrap');
      TOGGLES_DISP.forEach(([k, text]) => {
        const lbl  = document.createElement('label'); lbl.className = 'toggle-label';
        const inp  = document.createElement('input'); inp.type = 'checkbox'; inp.dataset.k = k;
        const pill = document.createElement('span');  pill.className = 'toggle-pill';
        lbl.append(inp, pill, document.createTextNode(' ' + text));
        inp.addEventListener('change', triggerSave);
        tw.appendChild(lbl);
      });
      card.appendChild(tw);
    },
    read(card) {
      const rangos = [...card.querySelectorAll('.date-range-row')].map(r => ({
        desde: r.querySelector('.range-from').value || null,
        hasta: r.querySelector('.range-to').value   || null,
      })).filter(r => r.desde || r.hasta);
      const out = { rangos, diasMax: card.state.dias.get() };
      TOGGLES_DISP.forEach(([k]) => { out[k] = card.querySelector(`input[data-k="${k}"]`).checked; });
      return out;
    },
    write(card, q, v) {
      if (!v) return;
      if (v.diasMax) card.state.dias.set(v.diasMax);
      TOGGLES_DISP.forEach(([k]) => {
        const el = card.querySelector(`input[data-k="${k}"]`);
        if (el) el.checked = !!v[k];
      });
      if (v.rangos && v.rangos.length) {
        card.querySelector('.ranges-list').innerHTML = '';
        v.rangos.forEach(r => addDateRange(card, r.desde, r.hasta));
      }
    },
  },
};
// ── FRANJAS, MOTIVOS Y UTILIDADES DE HORARIOS ───────────────────────────────
const FRANJAS_HORARIAS = [
  { id: 'manana', label: '☀️ Mañana', start: 10.0, end: 14.0 },
  { id: 'comida', label: '🍽️ Comida', start: 14.0, end: 17.0 },
  { id: 'tarde',  label: '🎬 Tarde',  start: 17.0, end: 20.5 },
  { id: 'cena',   label: '🍷 Cena',   start: 20.5, end: 24.0 },
  { id: 'noche',  label: '🌙 Noche',  start: 24.0, end: 26.5 },
];

const MOTIVOS_RESTRICCION = [
  { id: 'clase',   label: '📚 Clase / Prácticas' },
  { id: 'trabajo', label: '💼 Trabajo / Turno' },
  { id: 'examen',  label: '📝 Examen / Entrega' },
  { id: 'otro',    label: '⏳ Otro compromiso' },
];

// Franjas de la pregunta (config.franjas) o las de por defecto
function getFranjas(q) {
  const f = q && q.config && Array.isArray(q.config.franjas) && q.config.franjas.length ? q.config.franjas : null;
  return f || FRANJAS_HORARIAS;
}

function fmtHM(h) {
  const n = ((h % 24) + 24) % 24;
  let hh = Math.floor(n), mm = Math.round((n - hh) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
const franjaSub = f => fmtHM(f.start) + '–' + fmtHM(f.end);

// [{desde,hasta|fecha,franjas}] → Map fecha → Set(franjas)   (acepta formato antiguo {fecha})
function dispToMap(list) {
  const m = new Map();
  (list || []).forEach(d => {
    const a = d.desde || d.fecha, b = d.hasta || d.fecha || a;
    if (!a || !Array.isArray(d.franjas) || !d.franjas.length || b < a) return;
    const cur = new Date(a + 'T00:00:00Z'), end = new Date(b + 'T00:00:00Z');
    for (let g = 0; cur <= end && g < 366; g++, cur.setUTCDate(cur.getUTCDate() + 1)) {
      const iso = cur.toISOString().slice(0, 10);
      const s = m.get(iso) || new Set();
      d.franjas.forEach(f => s.add(f));
      m.set(iso, s);
    }
  });
  return m;
}

// Map → intervalos compactados (días consecutivos con las mismas franjas)
function mapToDisp(m) {
  const dias = [...m.keys()].filter(k => m.get(k).size).sort();
  const out = []; let cur = null;
  dias.forEach(f => {
    const key = [...m.get(f)].sort().join(',');
    if (cur && cur.key === key && diffDaysISO(cur.hasta, f) === 1) cur.hasta = f;
    else { cur = { key, desde: f, hasta: f, franjas: [...m.get(f)] }; out.push(cur); }
  });
  return out.map(({ desde, hasta, franjas }) => ({ desde, hasta, franjas }));
}

// ¿Una restricción aplica a esta fecha? (sin fechas = todos los días)
function restAplica(r, fecha) {
  const a = r.fechaDesde || r.fecha || '';
  const b = r.fechaHasta || r.fecha || r.fechaDesde || '';
  if (!a && !b) return true;
  return (!a || fecha >= a) && (!b || fecha <= b);
}

// Editor de franjas reutilizable (edición de pregunta y creación). Devuelve un getter.
function buildFranjasEditor(host, franjas) {
  host.innerHTML = '';
  const list = div('franjas-editor');
  const addRow = f => {
    const row = div('franja-edit-row');
    row.dataset.fid = f.id || '';
    row.innerHTML = `
      <input type="text" class="fe-label" value="${esc(f.label)}" placeholder="Nombre (p.ej. 🍽️ Comida)" maxlength="24">
      <input type="time" class="fe-start" value="${fmtHM(f.start)}">
      <span>→</span>
      <input type="time" class="fe-end" value="${fmtHM(f.end)}">
      <button type="button" class="btn-remove" title="Quitar franja">✕</button>`;
    row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
    list.appendChild(row);
  };
  franjas.forEach(addRow);
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'btn-add'; add.style.marginTop = '8px';
  add.textContent = '+ Añadir franja';
  add.addEventListener('click', () => addRow({ label: '', start: 18, end: 20 }));
  host.append(list, add);

  return () => [...list.querySelectorAll('.franja-edit-row')].map((r, i) => {
    const label = r.querySelector('.fe-label').value.trim();
    let s = parseHHMM(r.querySelector('.fe-start').value);
    let e = parseHHMM(r.querySelector('.fe-end').value);
    if (!label || s == null || e == null) return null;
    if (s < 6) s += 24;          // madrugada = noche del mismo día
    if (e <= s) e += 24;
    return { id: r.dataset.fid || ('f' + Date.now().toString(36) + i), label, start: s, end: e };
  }).filter(Boolean);
}

function addDaySlotRow(card, data = null) {
  const list = card.querySelector('.day-slots-list');
  if (!list) return;
  const franjas = card.state.franjas || FRANJAS_HORARIAS;
  const row = div('day-slot-row');
  const desde = (data && (data.desde || data.fecha)) || hoyLocal();
  const hasta = (data && (data.hasta || data.fecha)) || desde;
  let def = franjas.filter(f => ['comida', 'tarde', 'cena'].includes(f.id)).map(f => f.id);
  if (!def.length) def = franjas.map(f => f.id);
  const activas = new Set(data && Array.isArray(data.franjas) ? data.franjas : def);

  row.innerHTML = `
    <div class="day-slot-header">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <label style="font-size:0.8rem;color:var(--muted)">Del</label>
        <input type="date" class="slot-from" value="${esc(desde)}">
        <label style="font-size:0.8rem;color:var(--muted)">al</label>
        <input type="date" class="slot-to" value="${esc(hasta)}">
      </div>
      <button type="button" class="btn-remove" title="Quitar intervalo">✕</button>
    </div>
    <div class="franjas-pills-row">
      ${franjas.map(f => `
        <button type="button" class="franja-pill ${activas.has(f.id) ? 'active' : ''}" data-fid="${esc(f.id)}">
          <span>${esc(f.label)}</span><small>${franjaSub(f)}</small>
        </button>`).join('')}
    </div>`;

  const from = row.querySelector('.slot-from'), to = row.querySelector('.slot-to');
  from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; triggerSave(); });
  to.addEventListener('change',   () => { if (!from.value || to.value < from.value) to.value = from.value; triggerSave(); });
  row.querySelector('.btn-remove').addEventListener('click', () => { row.remove(); triggerSave(); });
  row.querySelectorAll('.franja-pill').forEach(btn =>
    btn.addEventListener('click', () => { btn.classList.toggle('active'); triggerSave(); }));
  list.appendChild(row);
}

function addRestriccionRow(card, data = null) {
  const list = card.querySelector('.restricciones-list');
  if (!list) return;
  const row = div('restriccion-row');
  const motivo = (data && data.motivo) || 'clase';
  const fd    = (data && (data.fechaDesde || data.fecha)) || '';
  const fh    = (data && (data.fechaHasta || data.fecha)) || '';
  const desde = (data && data.desde) || '16:00';
  const hasta = (data && data.hasta) || '20:00';
  const meUno = data && data.meUnoAlSalir !== undefined ? !!data.meUnoAlSalir : true;

  row.innerHTML = `
    <div class="rest-grid">
      <select class="rest-motivo">
        ${MOTIVOS_RESTRICCION.map(m => `<option value="${m.id}" ${m.id === motivo ? 'selected' : ''}>${m.label}</option>`).join('')}
      </select>
      <div class="rest-time-pair">
        <input type="date" class="rest-fd" value="${esc(fd)}" title="Desde (vacío = todos los días)">
        <span>→</span>
        <input type="date" class="rest-fh" value="${esc(fh)}" title="Hasta">
      </div>
      <div class="rest-time-pair">
        <input type="time" class="rest-desde" value="${esc(desde)}">
        <span>→</span>
        <input type="time" class="rest-hasta" value="${esc(hasta)}">
      </div>
      <button type="button" class="btn-remove" title="Eliminar restricción">✕</button>
    </div>
    <div class="rest-sub-opts">
      <label class="toggle-label" style="font-size:0.78rem;color:var(--muted)">
        <input type="checkbox" class="rest-join-after" ${meUno ? 'checked' : ''}>
        <span class="toggle-pill" style="transform:scale(0.8)"></span>
        <span>⚡ Puedo incorporarme en cuanto salga de esta obligación</span>
      </label>
      <span style="font-size:0.73rem;color:var(--muted)">* Sin fechas = todos los días. Si cruza medianoche (22:00→02:00) también vale.</span>
    </div>`;

  const fdI = row.querySelector('.rest-fd'), fhI = row.querySelector('.rest-fh');
  fdI.addEventListener('change', () => { if (fdI.value && (!fhI.value || fhI.value < fdI.value)) fhI.value = fdI.value; });
  row.querySelector('.btn-remove').addEventListener('click', () => { row.remove(); triggerSave(); });
  row.querySelectorAll('select, input').forEach(el => el.addEventListener('change', triggerSave));
  list.appendChild(row);
}
// Garantiza: un valor por opción, a lo sumo un +3 y un −1. Convierte respuestas antiguas de checkbox (array) en +1.
function normPond(v) {
  if (Array.isArray(v)) { const o = {}; v.forEach(k => { o[k] = 1; }); return o; }
  const out = {}; let fav = false, veto = false;
  Object.entries(v || {}).forEach(([k, s]) => {
    s = Number(s);
    if (![-1, 1, 3].includes(s)) return;
    if (s === 3  && fav)  return; if (s === 3)  fav = true;
    if (s === -1 && veto) return; if (s === -1) veto = true;
    out[k] = s;
  });
  return out;
}
