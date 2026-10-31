// ── FORMULARIOS DE PROPUESTA ────────────────────────────────────────────────
var aqGetFranjas = null;
function createAddOptForm(q) {
  const wrap    = div('add-opt-form');
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'add-opt-trigger'; trigger.textContent = '+ Proponer opción';
  const fields  = div('add-opt-fields');
  trigger.addEventListener('click', () => fields.classList.toggle('open'));

  const row = div('add-opt-row');
  const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Nueva opción…';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn-propose'; btn.textContent = 'Proponer →';
  btn.addEventListener('click', () => submitNewOpcion(q, inp.value.trim(), inp));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  row.append(inp, btn);
  fields.appendChild(row);
  wrap.append(trigger, fields);
  return wrap;
}

function createAddCasaForm(q) {
  const wrap    = div('add-opt-form');
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'add-opt-trigger'; trigger.textContent = '+ Proponer casa';
  const fields  = div('add-opt-fields');
  const mk = ph => { const i = document.createElement('input'); i.type = 'text'; i.placeholder = ph; return i; };
  const inFoto   = mk('URL de foto (opcional, enlace directo a la imagen)');
  trigger.addEventListener('click', () => fields.classList.toggle('open'));

  const inNombre = mk('Nombre o descripción *');
  const inPrecio = mk('Precio (p.ej. 280€)');
  const inUrl    = mk('URL (opcional)');
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn-propose'; btn.textContent = 'Proponer →';
  btn.addEventListener('click', () => {
    const nombre = inNombre.value.trim();
    if (!nombre) { inNombre.focus(); return; }
    const rawUrl = inUrl.value.trim(), url = safeUrl(rawUrl);
    if (rawUrl && !url) { showStatus('La URL debe ser http(s) válida', 'err'); inUrl.focus(); return; }
    const rawFoto = inFoto.value.trim(), foto = safeUrl(rawFoto);
    if (rawFoto && !foto) { showStatus('La URL de la foto debe ser http(s) válida', 'err'); inFoto.focus(); return; }
    submitNewCasa(q, { nombre, precio: inPrecio.value.trim(), url, foto });
    inNombre.value = inPrecio.value = inUrl.value = inFoto.value = '';
    fields.classList.remove('open');
  });
  fields.append(inNombre, inPrecio, inUrl, inFoto, btn);
  wrap.append(trigger, fields);
  return wrap;
}

// Selecciona (marca) una opción ya existente en vez de duplicarla
function selectExisting(item) {
  const inp = item && item.querySelector('input');
  if (inp) { inp.checked = true; triggerSave(); }
}

async function submitNewOpcion(q, valor, inp) {
  if (!valor || !user) { if (inp) inp.focus(); return; }
  if (q.tipo === 'radio') valor = valor.replace(/\|/g, '/'); // '|' separa valor y etiqueta
  const card = cardFor(q.id);
  const type = TIPOS[q.tipo];
  if (!card || !type || !type.addOption) return;

  if (inp) { inp.value = ''; const f = inp.closest('.add-opt-fields'); if (f) f.classList.remove('open'); }

  const existente = findItem(card, valor);
  if (existente) { selectExisting(existente); return; }

  q.opciones = q.opciones || [];
  const item = type.addOption(card, q, valor, true);
  q.opciones.push(valor);
  refreshPC(q.id);
  triggerSave();

  try {
    await apiPost({ action: 'add_opcion', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: q.id, opcion: valor });
  } catch (e) {
    if (item) item.remove();
    const i = q.opciones.indexOf(valor);
    if (i >= 0) q.opciones.splice(i, 1);
    showStatus('No se pudo añadir la opción: ' + e.message, 'err');
  }
}

async function submitNewCasa(q, casa) {
  if (!user) return;
  const card = cardFor(q.id);
  const type = TIPOS[q.tipo];
  if (!card || !type) return;

  const existente = findItem(card, casa.nombre);
  if (existente) { selectExisting(existente); return; }

  q.opciones = q.opciones || [];
  const item = type.addOption(card, q, casa, true);
  q.opciones.push(casa);
  refreshPC(q.id);
  triggerSave();

  try {
    await apiPost({ action: 'add_opcion', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: q.id, opcion: casa });
  } catch (e) {
    if (item) item.remove();
    const i = q.opciones.indexOf(casa);
    if (i >= 0) q.opciones.splice(i, 1);
    showStatus('No se pudo añadir la casa: ' + e.message, 'err');
  }
}

// ── NUEVA PREGUNTA ──────────────────────────────────────────────────────────
// Desplegable «Sección» del formulario de pregunta nueva. Las opciones son las
// secciones existentes (marcas + nombres usados por preguntas sueltas); la
// última entrada permite crear una sección nueva escribiendo su nombre.
const AQ_SEC_NUEVA = '__nueva__';
function rebindAddQSeccion() {
  const sel = $('add-q-seccion');
  if (!sel) return;
  const nombres = (typeof nombresDeSecciones === 'function') ? nombresDeSecciones() : [];
  sel.innerHTML = '<option value="">Sin sección (aparece suelta en el raíl)</option>' +
    nombres.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    `<option value="${AQ_SEC_NUEVA}">+ Crear sección nueva…</option>`;
  const inp = $('add-q-seccion-nombre');
  if (inp) inp.value = '';
  syncAddQSeccionField();
}

function syncAddQSeccionField() {
  const sel = $('add-q-seccion'), inp = $('add-q-seccion-nombre');
  if (!sel || !inp) return;
  inp.style.display = sel.value === AQ_SEC_NUEVA ? '' : 'none';
  if (sel.value !== AQ_SEC_NUEVA) inp.value = '';
}

// Nombre de sección elegido en el formulario ('' = sin sección).
function aqSeccionElegida() {
  const sel = $('add-q-seccion');
  if (!sel) return '';
  if (sel.value === AQ_SEC_NUEVA) return ($('add-q-seccion-nombre').value || '').trim();
  return sel.value;
}

function resetAddQuestionForm() {
  $('add-q-label').value = '';
  const cont = $('add-q-opts-container');
  cont.innerHTML = '<div class="add-q-opt-row"><input type="text" placeholder="Opción 1"><button class="btn-remove" type="button">✕</button></div>';
  $('add-q-tipo').dispatchEvent(new Event('change')); // reajusta placeholder
  aqGetFranjas = buildFranjasEditor($('aq-franjas-host'), FRANJAS_HORARIAS);
  $('aq-dur').value = 3;
  $('add-q-desc').value = '';
  rebindAddQSeccion(); // desplegable de secciones al día
  rebindAddQCond(); // editor de condición limpio (sobre el esquema actual)
}

// Reconstruye el editor «mostrar solo si…» del formulario de pregunta nueva.
// Sin `currentQid`: la pregunta se añadirá al final, así que puede depender
// de cualquier pregunta existente con opciones. Se expone en host._getCond().
function rebindAddQCond() {
  const host = $('add-q-cond-host');
  if (!host || typeof buildCondEditor !== 'function') return;
  host._getCond = buildCondEditor(host, schema, null, null).read;
}

async function submitNewQuestion() {
  if (!user) return;
  const tipo  = $('add-q-tipo').value;
  const label = $('add-q-label').value.trim();
  if (!label) { $('add-q-label').focus(); return; }

  const slug = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
  const id = slug + '_' + Date.now().toString(36);

  let opciones = [], config = {};
  const textos = [...$('add-q-opts-container').querySelectorAll('input[type=text]')].map(i => i.value.trim()).filter(Boolean);

  if (tipo === 'slider') {
    config = {
      min:  +($('aq-min').value  || 0),
      max:  +($('aq-max').value  || 100),
      step: +($('aq-step').value || 10),
    };
    if (config.max <= config.min) { showStatus('El máximo debe ser mayor que el mínimo', 'err'); return; }
    config.default = Math.round((config.min + config.max) / 2);
    } else if (tipo === 'horarios') {
    const franjas = aqGetFranjas();
    if (!franjas.length) { showStatus('Define al menos una franja válida', 'err'); return; }
    config = { duracionIdeal: Math.max(1, Math.min(12, +$('aq-dur').value || 3)), franjas };
  } else if (tipo === 'casas') {
    opciones = textos.map(nombre => ({ nombre, precio: '', url: '', foto: '' }));
  } else if (tipo === 'radio') {
    opciones = textos.map(t => t.replace(/\|/g, '/'));
  } else if (tipo !== 'textarea' && tipo !== 'disponibilidad' && tipo !== 'horarios') {
    opciones = textos;
  }
  const desc = $('add-q-desc').value.trim();
  if (desc) config.descripcion = desc;

  // Condición «mostrar solo si…» del editor de #add-q-cond-host. La pregunta
  // nueva se añade AL FINAL del orden, así que cualquier fuente existente es
  // "anterior" y la validación anti-ciclos pasa con beforeIdx = schema.length.
  const condHost = $('add-q-cond-host');
  if (condHost && typeof condHost._getCond === 'function') {
    const cond = condHost._getCond();
    if (cond) {
      const errCond = typeof validarMostrarSi === 'function'
        ? validarMostrarSi(cond, schema, null, schema.length) : null;
      if (errCond) { showStatus(errCond, 'err', 6000); return; }
      config.mostrarSi = cond;
    }
  }

  const pregunta = { id, tipo, label, opciones, config };
  // Sección elegida en el desplegable (o nombre nuevo escrito a mano). La
  // tarjeta «marca» de una sección nueva se crea aquí mismo si no existe.
  const secElegida = aqSeccionElegida();
  if (secElegida) {
    config.seccion = secElegida;
    if (typeof secHeaderPara === 'function' && !secHeaderPara(secElegida) &&
        typeof crearSeccion === 'function') {
      crearSeccion(secElegida);   // fire-and-forget: pollOnce traerá la marca
    }
  }

  // Optimista, con rollback. Insertar AL FINAL del esquema, pero justo después
  // de la última tarjeta visible de su sección (si la tiene), para que DOM y
  // esquema coincidan hasta que llegue el orden definitivo del servidor.
  schema.push(pregunta);
  const card = buildQuestionCard(pregunta, schema.length - 1);
  const contQ = $('questions-container');
  if (card && contQ) {
    let beforeEl = null;
    if (secElegida) {
      for (let j = schema.length - 2; j >= 0; j--) {
        const x = schema[j];
        if (!x.config || x.config.esEncabezado) continue;
        if (String(x.config.seccion || '').trim().toLowerCase() !==
            secElegida.trim().toLowerCase()) continue;
        const c = cardFor(x.id);
        if (c && c.parentElement === contQ) { beforeEl = c; break; }
      }
    }
    if (beforeEl) beforeEl.after(card); else contQ.appendChild(card);
  }
  $('add-q-form').classList.remove('open');
  resetAddQuestionForm();
  // La sección nueva entra en el raíl/barra (y si es condicional, visible ya).
  if (typeof refreshSecciones === 'function') setTimeout(refreshSecciones, 0);

  try {
    await apiPost({ action: 'add_pregunta', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, pregunta });
    // Refresca el snapshot (incluida la posición inicial asignada por SQL).
    lastRaw = '';
    await pollOnce();
  } catch (e) {
    if (card) card.remove();
    const i = schema.indexOf(pregunta);
    if (i >= 0) schema.splice(i, 1);
    showStatus('No se pudo crear la pregunta: ' + e.message, 'err');
    if (typeof refreshSecciones === 'function') setTimeout(refreshSecciones, 0);
  }
}

// ── NUEVA SECCIÓN (tarjeta #add-section-card + lista #sec-manage-list) ──────
// Crea la marca de la sección (crearSeccion, ahora awaited) y, si se
// cumplimentó el bloque opcional, una primera pregunta dentro de ella en
// secuencia (primero la marca: así la pregunta llega a un grupo ya existente).
async function submitNewSection() {
  if (!user) return;
  const nombre = ($('add-sec-nombre').value || '').trim();
  if (!nombre) { $('add-sec-nombre').focus(); showStatus('Escribe el nombre de la sección', 'err'); return; }
  const btn = $('btn-submit-new-sec');
  btn.disabled = true; btn.textContent = 'Creando…';

  // Primera pregunta opcional (se construye ANTES de crear la marca para que
  // los fallos de validación no dejen una sección huérfana a medias).
  let primera = null;
  const qLabel = ($('add-sec-q-label').value || '').trim();
  if (qLabel) {
    const tipo = $('add-sec-q-tipo').value;
    const slug = qLabel.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    const opcionesTextos = [...$('add-sec-q-opts-container').querySelectorAll('input[type=text]')]
      .map(i => i.value.trim()).filter(Boolean);
    let opciones = [], config = {};
    if (tipo === 'slider') {
      config = { min: 0, max: 100, step: 10, default: 50 };
    } else if (tipo === 'radio') {
      opciones = opcionesTextos.map(t => t.replace(/\|/g, '/'));
    } else if (tipo !== 'textarea') {
      opciones = opcionesTextos;
    }
    config.seccion = nombre;
    primera = { id: slug + '_' + Date.now().toString(36), tipo, label: qLabel, opciones, config };
  }

  try {
    await crearSeccion(nombre);            // crea la marca (optimista + add_pregunta)
    if (primera) {
      schema.push(primera);
      const card = buildQuestionCard(primera, schema.length - 1);
      insertCardTras(card, null);
      try {
        await apiPost({ action: 'add_pregunta', eid: user.eid, nombre: user.nombre,
                        pinHash: user.pinHash, pregunta: primera });
        lastRaw = '';
      } catch (e2) {
        if (card) card.remove();
        const i = schema.indexOf(primera);
        if (i >= 0) schema.splice(i, 1);
        showStatus('La sección se creó, pero la primera pregunta no: ' + e2.message, 'err', 7000);
      }
    } else {
      showStatus(`Sección «${nombre}» creada`, 'ok', 3000);
    }
    // Limpiar el formulario y cerrar la tarjeta de creación.
    $('add-sec-nombre').value = '';
    $('add-sec-q-label').value = '';
    $('add-sec-q-opts-container').innerHTML =
      '<div class="add-q-opt-row"><input type="text" placeholder="Opción 1"><button class="btn-remove" type="button">✕</button></div>';
    $('add-sec-form').classList.remove('open');
    goToSectionDeNombre(nombre);
    await pollOnce();
    if (typeof refreshSecciones === 'function') refreshSecciones();
  } catch (e) {
    showStatus('No se pudo crear la sección: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Crear sección →';
  }
}

function bindForms() {
  $('btn-toggle-add-q').addEventListener('click', () => {
    const f = $('add-q-form');
    const opening = !f.classList.contains('open');
    f.classList.toggle('open');
    // Al abrir, el desplegable de secciones y el editor de condición se
    // pintan con el esquema actual.
    if (opening) { rebindAddQSeccion(); rebindAddQCond(); }
  });
  $('btn-submit-new-q').addEventListener('click', submitNewQuestion);

  // ── Tarjeta «Secciones del cuestionario» (#add-section-card) ──
  const btnToggleSec = $('btn-toggle-add-sec');
  if (btnToggleSec) {
    btnToggleSec.addEventListener('click', () => $('add-sec-form').classList.toggle('open'));
  }
  const btnSubmitSec = $('btn-submit-new-sec');
  if (btnSubmitSec) btnSubmitSec.addEventListener('click', submitNewSection);
  const inpSecNom = $('add-sec-nombre');
  if (inpSecNom) inpSecNom.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewSection(); }
  });
  const selSecQTipo = $('add-sec-q-tipo');
  if (selSecQTipo) selSecQTipo.addEventListener('change', function () {
    $('add-sec-q-opts-wrap').style.display =
      ['checkbox', 'radio', 'voto-ponderado'].includes(this.value) ? 'block' : 'none';
  });
  const btnSecOpt = $('btn-add-sec-q-opt');
  if (btnSecOpt) btnSecOpt.addEventListener('click', () => {
    const cont = $('add-sec-q-opts-container');
    const row  = div('add-q-opt-row');
    row.innerHTML = `<input type="text" placeholder="Opción ${cont.children.length + 1}"><button class="btn-remove" type="button">✕</button>`;
    cont.appendChild(row);
  });
  const contSecOpts = $('add-sec-q-opts-container');
  if (contSecOpts) contSecOpts.addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove')) e.target.closest('.add-q-opt-row').remove();
  });
  // Lista de gestión de secciones (render definido en secciones.js; el primer
  // pintado tras cargar el esquema — refreshSecciones la repinta después).
  if (typeof renderSecManageList === 'function') renderSecManageList();

  const aqSecSel = $('add-q-seccion');
  if (aqSecSel) aqSecSel.addEventListener('change', syncAddQSeccionField);

  $('add-q-tipo').addEventListener('change', function () {
    const v = this.value;
    $('add-q-opciones-wrap').style.display = ['checkbox', 'radio', 'voto-ponderado', 'casas'].includes(v) ? 'block' : 'none';
    $('add-q-slider-wrap').style.display   = v === 'slider' ? 'block' : 'none';
    $('add-q-horarios-wrap').style.display = v === 'horarios' ? 'block' : 'none';
    const first = document.querySelector('#add-q-opts-container input');
    if (first) first.placeholder = v === 'casas' ? 'Nombre de la casa (el precio se añade luego)' : 'Opción 1';
  });
  aqGetFranjas = buildFranjasEditor($('aq-franjas-host'), FRANJAS_HORARIAS);

  $('btn-add-q-opt').addEventListener('click', () => {
    const cont = $('add-q-opts-container');
    const row  = div('add-q-opt-row');
    row.innerHTML = `<input type="text" placeholder="Opción ${cont.children.length + 1}"><button class="btn-remove" type="button">✕</button>`;
    cont.appendChild(row);
  });

  // Delegado: sirve para las filas iniciales y las añadidas
  $('add-q-opts-container').addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove')) e.target.closest('.add-q-opt-row').remove();
  });
}
