// ── PROS / CONTRAS ──────────────────────────────────────────────────────────

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

    entries.forEach(e => {
      const row  = div('pc-entry');
      const tipo = document.createElement('span'); tipo.className = `pc-tipo ${e.tipo}`; tipo.textContent = e.tipo === 'pro' ? '✓' : '✗';
      const txt  = document.createElement('span'); txt.className = 'pc-texto'; txt.textContent = e.texto;
      const aut  = document.createElement('span'); aut.className = 'pc-autor'; aut.textContent = '— ' + e.autor;
      row.append(tipo, txt, aut);
      panel.insertBefore(row, addRow);
    });
  });
}

async function submitPC(qid, optKey, tipo, inputEl) {
  const texto = inputEl.value.trim();
  if (!texto || !user) { inputEl.focus(); return; }

  // Optimista, con rollback si el servidor falla
  const entry = { qid, optKey, tipo, texto, autor: user.nombre, ts: new Date().toISOString() };
  proscontras.push(entry);
  refreshPC(qid);
  const card = cardFor(qid);
  const item = card && findItem(card, optKey);
  if (item) { const p = item.querySelector('.pc-panel'); if (p) p.classList.add('open'); }
  inputEl.value = '';

  try {
    await apiPost({ action: 'add_proscontra', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, questionId: qid, optKey, tipo, texto });
  } catch (e) {
    const i = proscontras.indexOf(entry);
    if (i >= 0) proscontras.splice(i, 1);
    refreshPC(qid);
    inputEl.value = texto;
    showStatus('No se pudo guardar tu argumento: ' + e.message, 'err');
  }
}
