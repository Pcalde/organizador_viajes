// ── AUSENCIAS ───────────────────────────────────────────────────────────────
// La lista se reconstruye solo si cambia el conjunto de respondentes, conservando
// lo que el usuario tenga marcado. El slider solo se rellena desde el servidor
// la primera vez: los sondeos ya no pisan lo que el usuario está tocando.

let ausListSig = null; // firma de la lista pintada; null = aún no construida

function resetAusencias() { ausListSig = null; }

function myVote() {
  return (user && ausencias.find(a => a.votante === user.nombre)) || null;
}

function setProb(v) {
  const s = $('aus-prob-slider');
  s.value = v;
  $('aus-prob-display').textContent = s.value + '%';
  s.style.setProperty('--pct', s.value + '%');
}

function readAusCandidatos() {
  return [...document.querySelectorAll('#aus-respondentes-list .aus-check:checked')].map(i => i.value);
}

// null si la sección está oculta
function readAusencias() {
  if ($('ausencias-card').style.display === 'none') return null;
  return {
    ausencias_predichas:    readAusCandidatos(),
    prob_asistencia_propia: +$('aus-prob-slider').value,
  };
}

function writeAusencias(d) {
  if (!d) return;
  if (Array.isArray(d.ausencias_predichas)) {
    const set = new Set(d.ausencias_predichas);
    document.querySelectorAll('#aus-respondentes-list .aus-check').forEach(i => { i.checked = set.has(i.value); });
  }
  if (d.prob_asistencia_propia !== undefined) setProb(d.prob_asistencia_propia);
}

function buildAusList(marcados) {
  const list = $('aus-respondentes-list');
  list.innerHTML = '';
  respondentes.forEach(r => {
    const item = div('opt-item');
    const lbl  = document.createElement('label'); lbl.className = 'opt-label';
    const inp  = document.createElement('input');
    inp.type = 'checkbox'; inp.value = r.nombre; inp.className = 'aus-check';
    inp.checked = marcados.has(r.nombre);
    const chk = document.createElement('span'); chk.className = 'check';
    const txt = document.createElement('span'); txt.textContent = r.nombre;
    lbl.append(inp, chk, txt);

    if (r.prob_asistencia != null) {
      const prob = document.createElement('span');
      prob.style.cssText = 'margin-left:auto;font-size:0.78rem;color:var(--muted)';
      prob.textContent = r.prob_asistencia + '% (su est.)';
      lbl.append(prob);
    }
    inp.addEventListener('change', triggerSave);
    item.appendChild(lbl);
    list.appendChild(item);
  });
}

function renderAusencias() {
  const card = $('ausencias-card');
  if (respondentes.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const sig = JSON.stringify(respondentes.map(r => [r.nombre, r.prob_asistencia]));
  if (sig !== ausListSig) {
    const primera  = ausListSig === null;
    const mv       = myVote();
    const marcados = primera ? new Set((mv && mv.candidatos) || []) : new Set(readAusCandidatos());
    ausListSig = sig;
    buildAusList(marcados);
    if (primera && mv && mv.mi_probabilidad != null && mv.mi_probabilidad !== '') setProb(mv.mi_probabilidad);
  }
  renderVotosPublicos();
}

function renderVotosPublicos() {
  const container = $('aus-votos-publicos');
  const lista     = $('aus-votos-candidatos');
  if (!ausencias || ausencias.length === 0) { container.style.display = 'none'; return; }

  container.style.display = 'block';
  lista.innerHTML = '';

  const conteo = {};
  ausencias.forEach(voto => {
    (Array.isArray(voto.candidatos) ? voto.candidatos : []).forEach(c => {
      (conteo[c] = conteo[c] || []).push(voto.votante);
    });
  });

  if (Object.keys(conteo).length === 0) {
    lista.innerHTML = '<div style="font-size:0.8rem;color:var(--muted)">Aún no hay predicciones de ausencias.</div>';
    return;
  }
  for (const [candidato, votantes] of Object.entries(conteo)) {
    const row = div('aus-voto-row');
    row.innerHTML = `
      <span class="aus-voto-name">${esc(candidato)}</span>
      <span style="color:var(--muted);font-size:0.75rem">sospechoso/a para:</span>
      <span class="aus-voto-victims">${esc(votantes.join(', '))}</span>`;
    lista.appendChild(row);
  }
}

function bindAusencias() {
  $('aus-prob-slider').addEventListener('input', function () {
    setProb(this.value);
    triggerSave();
  });
}