// ── PROS / CONTRAS ──────────────────────────────────────────────────────────


const PC_COTA_CIERTO = 0.6;   // p ≥ → cuenta
const PC_COTA_FALSO  = 0.4;   // p ≤ → refutado (tachado)
const PC_PESO = 0.5;          // puntos por argumento creíble (× p)
const PC_TOPE = 1.5;          // ajuste máximo por opción (±)

function pcCred(e) {
  let a = 1, d = 0;           // el autor cuenta como "de acuerdo"
  Object.values(e.votos || {}).forEach(v => { if (v > 0) a++; else if (v < 0) d++; });
  return { a, d, p: (a + 1) / (a + d + 2) };
}
const pcEstado = p => p >= PC_COTA_CIERTO ? 'cierto' : p <= PC_COTA_FALSO ? 'falso' : 'disputado';

function pcAjuste(entries) {
  let s = 0;
  entries.forEach(e => {
    const { p } = pcCred(e);
    if (p >= PC_COTA_CIERTO) s += (e.tipo === 'pro' ? 1 : -1) * PC_PESO * p;
  });
  return Math.max(-PC_TOPE, Math.min(PC_TOPE, s));
}

function buildPCRow(e) {
  const { a, d, p } = pcCred(e);
  const est   = pcEstado(p);
  const mine  = !!user && e.autor.toLowerCase() === user.nombre.toLowerCase();
  const miVoto = (user && e.votos && e.votos[user.nombre]) || 0;
  const row = div('pc-entry pc-' + est);
  const btn = (cls, txt, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = txt; b.title = title;
    b.disabled = !e.id;                       // aún sin id (guardándose)
    b.addEventListener('click', fn);
    return b;
  };
  const tipo = document.createElement('span'); tipo.className = `pc-tipo ${e.tipo}`; tipo.textContent = e.tipo === 'pro' ? '✓' : '✗';
  const txt  = document.createElement('span'); txt.className = 'pc-texto'; txt.textContent = e.texto;
  const aut  = document.createElement('span'); aut.className = 'pc-autor'; aut.textContent = '— ' + e.autor;
  const cred = document.createElement('span'); cred.className = 'pc-cred ' + est;
  cred.textContent = Math.round(p * 100) + '% cierto';
  cred.title = `${a} de acuerdo (incl. autor) · ${d} en desacuerdo`;
  row.append(tipo, txt, aut, cred);
  if (mine) {
    row.append(btn('pc-act', '✎', 'Editar (reinicia los votos)', () => editPC(e, txt)),
               btn('pc-act', '<i class="fa-solid fa-trash" aria-hidden="true"></i>', 'Borrar', ev => delPC(e, ev.currentTarget)));
  } else {
    row.append(btn('pc-act' + (miVoto === 1 ? ' active' : ''), '👍', 'De acuerdo', () => votePC(e, 1)),
               btn('pc-act neg' + (miVoto === -1 ? ' active' : ''), '👎', 'En desacuerdo', () => votePC(e, -1)));
  }
  return row;
}

async function votePC(e, v) {
  if (!user || !e.id) return;
  const before = e.votos || {};
  const nuevo  = before[user.nombre] === v ? 0 : v;       // pulsar de nuevo = quitar
  e.votos = { ...before };
  if (nuevo) e.votos[user.nombre] = nuevo; else delete e.votos[user.nombre];
  refreshPC(e.qid);
  try {
    await apiAuth({ action: 'vote_proscontra', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, id: e.id, voto: nuevo });
    pollOnce();
  } catch (err) {
    e.votos = before; refreshPC(e.qid);
    showStatus('No se pudo votar: ' + err.message, 'err');
  }
}

function editPC(e, txtEl) {
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'pc-edit-inp'; inp.value = e.texto; inp.maxLength = 500;
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'pc-act'; ok.textContent = '✓ Guardar';
  txtEl.replaceWith(inp); inp.after(ok); inp.focus(); inp.select();
  const cancel = () => { inp.remove(); ok.remove(); refreshPC(e.qid); };
  const save = async () => {
    const t = inp.value.trim();
    if (!t || t === e.texto) return cancel();
    ok.disabled = true;
    try {
      await apiAuth({ action: 'edit_proscontra', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, id: e.id, texto: t });
      e.texto = t; e.votos = {};
      inp.remove(); ok.remove(); refreshPC(e.qid); pollOnce();
    } catch (err) { ok.disabled = false; showStatus('No se pudo editar: ' + err.message, 'err'); }
  };
  ok.addEventListener('click', save);
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') cancel(); });
}

async function delPC(e, b) {
  if (!b.dataset.armed) {                                  // doble clic de confirmación
    b.dataset.armed = '1'; b.textContent = '¿Borrar?';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>'; } }, 3000);
    return;
  }
  try {
    await apiAuth({ action: 'delete_proscontra', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, id: e.id });
    const i = proscontras.indexOf(e); if (i >= 0) proscontras.splice(i, 1);
    refreshPC(e.qid); pollOnce();
  } catch (err) { showStatus('No se pudo borrar: ' + err.message, 'err'); }
}

// Índice qid|optKey → entradas. Se construye una vez por refresco: O(P) en vez de O(Q·O·P).
function pcIndex() {
  const idx = new Map();
  for (const e of proscontras) {
    const k = e.qid + '\u0000' + e.optKey;
    let arr = idx.get(k);
    if (!arr) idx.set(k, arr = []);
    arr.push(e);
  }
  return idx;
}

function refreshAllPC() {
  const idx = pcIndex();
  schema.forEach(q => refreshPC(q.id, idx));
}

function refreshPC(qid, idx = pcIndex()) {
  const card = cardFor(qid);
  if (!card) return;

  card.querySelectorAll('.opt-item').forEach(item => {
    const val     = item.dataset.val;
    const entries = idx.get(qid + '\u0000' + val) || [];
    const panel   = item.querySelector('.pc-panel');
    const badge   = item.querySelector('.pc-badge');
    if (!panel || !badge) return;
    if (panel.querySelector('.pc-edit-inp')) return;   // editando: no repintar

    const pros = entries.filter(e => e.tipo === 'pro').length;
    const cons = entries.filter(e => e.tipo === 'contra').length;
    badge.innerHTML = pros + cons === 0
      ? `<span style="color:var(--muted);font-size:0.75rem">+ pros/contras</span>`
      : (pros ? `<span class="pc-pro">▲ ${pros}</span>` : '') +
        (cons ? `<span class="pc-con">▼ ${cons}</span>` : '');

    // Quita solo las entradas; el formulario se conserva (así no se pierde el foco)
    panel.querySelectorAll('.pc-entry').forEach(el => el.remove());

    let addRow = panel.querySelector('.pc-add-row');
    if (!addRow) {
      addRow = div('pc-add-row');
      const inp  = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Escribe tu argumento…';
      const bPro = document.createElement('button'); bPro.type = 'button'; bPro.className = 'btn-pc btn-pc-pro';    bPro.textContent = '✓ Pro';
      const bCon = document.createElement('button'); bCon.type = 'button'; bCon.className = 'btn-pc btn-pc-contra'; bCon.textContent = '✗ Contra';
      bPro.addEventListener('click', () => submitPC(qid, val, 'pro', inp));
      bCon.addEventListener('click', () => submitPC(qid, val, 'contra', inp));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') bPro.click(); });
      addRow.append(inp, bPro, bCon);
      panel.appendChild(addRow);
    }

    entries.forEach(e => panel.insertBefore(buildPCRow(e), addRow));
  });
}

async function submitPC(qid, optKey, tipo, inputEl) {
    const texto = inputEl.value.trim();
    if (!texto || !user) { inputEl.focus(); return; }

    const entry = { qid, optKey, tipo, texto, autor: user.nombre, votos: {}, ts: new Date().toISOString() };
    proscontras.push(entry);
    refreshPC(qid);
    const card = cardFor(qid);
    const item = card && findItem(card, optKey);
    if (item) { const p = item.querySelector('.pc-panel'); if (p) p.classList.add('open'); }
    inputEl.value = '';

    try {
      const res = await apiPost({ action: 'add_proscontra', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: qid, optKey, tipo, texto });
      if (res && res.id) entry.id = res.id;
      refreshPC(qid);
      pollOnce();
    } catch (e) {
      const i = proscontras.indexOf(entry);
      if (i >= 0) proscontras.splice(i, 1);
      refreshPC(qid);
      inputEl.value = texto;
      showStatus('No se pudo guardar tu argumento: ' + e.message, 'err');
    }
  }