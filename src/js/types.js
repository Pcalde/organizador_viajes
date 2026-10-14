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
function createOptionCrudControls(qid, optKey, isCasa = false, currentCasaObj = null) {
  const wrap = div('opt-crud-btns');
  const bEdit = document.createElement('button');
  bEdit.type = 'button'; bEdit.className = 'btn-opt-crud'; bEdit.title = 'Editar opción'; bEdit.textContent = '✎';
  const bDel  = document.createElement('button');
  bDel.type  = 'button'; bDel.className  = 'btn-opt-crud danger'; bDel.title = 'Eliminar opción'; bDel.textContent = '✕';

  bEdit.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    if (!user) return;
    let nuevaOpcion;
    if (isCasa) {
      const nuevoNombre = prompt('Nombre del alojamiento:', (currentCasaObj && currentCasaObj.nombre) || optKey);
      if (!nuevoNombre || !nuevoNombre.trim()) return;
      const nuevoPrecio = prompt('Precio (ej. 450 € total):', (currentCasaObj && currentCasaObj.precio) || '');
      if (nuevoPrecio === null) return;
      const nuevaUrl    = prompt('Enlace URL (https://...):', (currentCasaObj && currentCasaObj.url) || '');
      if (nuevaUrl === null) return;
      nuevaOpcion = { nombre: nuevoNombre.trim(), precio: nuevoPrecio.trim(), url: safeUrl(nuevaUrl) };
    } else {
      const nuevoTexto = prompt('Editar texto de la opción:', optKey);
      if (!nuevoTexto || !nuevoTexto.trim() || nuevoTexto.trim() === optKey) return;
      nuevaOpcion = nuevoTexto.trim();
    }

    try {
      await apiAuth({
        action: 'edit_opcion',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: qid, oldOptKey: optKey, nuevaOpcion,
      });
      await pollOnce();
      renderAllQuestions();
      restoreDraft();
      showStatus('Opción actualizada', 'ok', 2000);
    } catch (err) {
      showStatus('No se pudo editar la opción: ' + err.message, 'err');
    }
  });

  bDel.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    if (!user) return;
    if (!confirm(`¿Eliminar la opción «${optKey}» de esta pregunta?`)) return;
    try {
      await apiAuth({
        action: 'delete_opcion',
        eid: user.eid, nombre: user.nombre, pinHash: user.pinHash,
        questionId: qid, optKey,
      });
      const q = schema.find(x => x.id === qid);
      if (q && Array.isArray(q.opciones)) {
        q.opciones = q.opciones.filter(o => optVal(q, o) !== optKey);
      }
      const card = cardFor(qid);
      const item = card && findItem(card, optKey);
      if (item) item.remove();
      showStatus('Opción eliminada', 'ok', 2000);
      pollOnce();
    } catch (err) {
      showStatus('No se pudo eliminar la opción: ' + err.message, 'err');
    }
  });

  wrap.append(bEdit, bDel);
  return wrap;
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

// ── CONSTRUCTORES DE ÍTEMS ──────────────────────────────────────────────────
function createOptItem(qid, val) {
  const item = div('opt-item');
  item.dataset.qid = qid;
  item.dataset.val = val;

  const row = div('opt-row-with-crud');
  const lbl = document.createElement('label'); lbl.className = 'opt-label'; lbl.style.flex = '1';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.value = val;
  const chk = document.createElement('span');  chk.className = 'check';
  const txt = document.createElement('span');  txt.style.flex = '1'; txt.textContent = val;
  lbl.append(inp, chk, txt);
  inp.addEventListener('change', triggerSave);

  row.append(lbl, createOptionCrudControls(qid, val, false));
  const [badge, panel] = pcParts();
  item.append(row, badge, panel);
  return item;
}

function createPondItem(qid, val) {
  const item = div('opt-item pond-item');
  item.dataset.qid = qid;
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
  row.append(name, grp, createOptionCrudControls(qid, val, false));

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
  item.append(row, badge, panel);
  return item;
}

function createCasaItem(qid, op, n) {
  const item = div('opt-item');
  item.dataset.qid = qid;
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

  row.append(anchor, lbl, precio, createOptionCrudControls(qid, op.nombre, true, op));
  const [badge, panel] = pcParts();
  item.append(row, badge, panel);
  return item;
}

function toggleConditionalStepper(card, val) {
  const pw = card.querySelector('.plazas-wrap');
  const cs = card.state && card.state.stepperCfg;
  if (pw && cs) pw.style.display = val === cs.when ? 'flex' : 'none';
}

function createRadioItem(card, q, op) {
  const s = String(op);
  const [val, label] = s.includes('|') ? s.split('|') : [s, s];
  const row = div('opt-row-with-crud');
  row.dataset.val = val;

  const lbl = document.createElement('label'); lbl.className = 'opt-label'; lbl.style.flex = '1';
  const inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'radio-' + q.id; inp.value = val;
  const chk = document.createElement('span');  chk.className = 'check check-radio';
  lbl.append(inp, chk, document.createTextNode(' ' + label));
  inp.addEventListener('change', () => {
    toggleConditionalStepper(card, val);
    triggerSave();
  });

  row.append(lbl, createOptionCrudControls(q.id, val, false));
  return row;
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
      Object.entries(dict || {}).forEach(([val, score]) => {
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
      const ta = document.createElement('textarea');
      ta.placeholder = (q.config && q.config.placeholder) || '';
      ta.addEventListener('input', triggerSave);
      card.appendChild(ta);
    },
    read:  card => card.querySelector('textarea').value,
    write: (card, q, v) => { if (v != null) card.querySelector('textarea').value = v; },
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