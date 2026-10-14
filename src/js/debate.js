// ══════════════════════════════════════════════════════════════════════════
//  SALA DE DEBATE: DIFERIDO (PROPUESTAS E HILOS) + DIRECTO (js/debate.js)
// ══════════════════════════════════════════════════════════════════════════

let debateFilterQid = '';    // '' = Todos los temas, o ID de pregunta
let debateFilterOpt = '';    // '' = Todas las opciones, o clave de opción
let replyTargetId   = null;  // ID del mensaje al que se está respondiendo en hilo

function fmtTimeShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) + ' · ' +
           d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  } catch (e) { return ''; }
}

// Permite saltar desde cualquier opción del Reformulario al debate filtrado por esa opción
function openDebateFor(qid, optKey = '') {
  debateFilterQid = qid || '';
  debateFilterOpt = optKey || '';
  if (typeof switchMode === 'function') switchMode('debate');
  renderDebate();
}

// Permite enviar directamente una Solución Óptima del optimizador como Propuesta formal
async function createProposalFromConsensus(texto) {
  if (!user) return;
  if (typeof switchMode === 'function') switchMode('debate');
  try {
    await api({
      action: 'add_debate',
      eid: user.eid,
      nombre: user.nombre,
      pinHash: user.pinHash,
      qid: null,
      optKey: null,
      parentId: null,
      tipo: 'propuesta',
      texto,
    });
    showStatus('Propuesta publicada en la Sala de Debate', 'ok', 3000);
    pollOnce();
  } catch (e) {
    showStatus('No se pudo publicar la propuesta: ' + e.message, 'err');
  }
}

function renderDebate() {
  const container = $('debate-container');
  if (!container) return;

  // Evitar destruir el foco si el usuario está escribiendo activamente en un input de debate
  const activeEl = document.activeElement;
  if (activeEl && container.contains(activeEl) && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && activeEl.value.trim() !== '') {
    return;
  }

  container.innerHTML = '';

  const propuestas = debate.filter(d => d.tipo === 'propuesta');
  const directos   = debate.filter(d => d.tipo === 'directo');
  const hilos      = debate.filter(d => d.tipo === 'comentario');

  // Layout en dos columnas adaptativas: Diferido (Propuestas + Hilos) y Directo (Chat en vivo)
  const layout = div('debate-layout');

  // ── COLUMNA IZQUIERDA: DEBATE EN DIFERIDO (PROPUESTAS + HILOS) ────────────
  const colAsync = div('debate-col-async');

  // 1. Tarjeta de Propuestas Formales
  const propCard = div('card');
  propCard.innerHTML = `
    <div class="card-title"><span class="num">📌</span> Propuestas de Decisión (Diferido)</div>
    <p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px">
      Plantea acuerdos concretos (fechas, casa elegida, presupuesto) para que el grupo los vote sin que se pierdan en la conversación.
    </p>
    <div class="propuestas-list" id="debate-propuestas-list">
      ${propuestas.length ? propuestas.map(renderPropuestaItem).join('') : `<div class="muted-note">No hay propuestas activas todavía. Puedes crear una aquí o desde las Soluciones Óptimas del Reformulario.</div>`}
    </div>
    <div class="add-prop-row" style="display:flex;gap:8px;margin-top:12px">
      <input type="text" id="inp-new-propuesta" placeholder="Ej: Cerramos del 12 al 15 con Casa del Río (tope 110€/pers)…" maxlength="500">
      <button type="button" class="btn-propose" id="btn-send-propuesta">Proponer</button>
    </div>
  `;
  colAsync.appendChild(propCard);

  // 2. Tarjeta de Hilos por Tema y Pros/Contras
  const threadsCard = div('card');
  const qOptionsHtml = schema.map(q => `<option value="${esc(q.id)}" ${debateFilterQid === q.id ? 'selected' : ''}>${esc(q.label)}</option>`).join('');

  threadsCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div class="card-title" style="margin-bottom:0"><span class="num">🗂️</span> Hilos y Argumentos por Sección</div>
      <div style="display:flex;gap:6px;align-items:center">
        <select id="sel-debate-filter-q" style="width:auto;padding:6px 10px;font-size:0.82rem">
          <option value="">Todas las preguntas</option>
          ${qOptionsHtml}
        </select>
        ${debateFilterOpt ? `<span class="voter-chip star" id="chip-clear-opt">${esc(debateFilterOpt)} ✕</span>` : ''}
      </div>
    </div>

    <div id="debate-threads-list" class="debate-threads-list"></div>

    <div class="debate-composer" style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border)">
      <div id="reply-banner" style="display:${replyTargetId ? 'flex' : 'none'};justify-content:space-between;align-items:center;background:var(--bg);padding:6px 10px;border-radius:6px;margin-bottom:8px;font-size:0.8rem">
        <span>↩ Respondiendo al mensaje #${replyTargetId}</span>
        <button type="button" id="btn-cancel-reply" class="btn-remove" style="font-size:0.85rem">✕</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="inp-new-thread" placeholder="Añade un argumento o comentario en diferido…" style="flex:1" maxlength="800">
        <button type="button" class="btn-propose" id="btn-send-thread">Publicar hilo →</button>
      </div>
    </div>
  `;
  colAsync.appendChild(threadsCard);

  // ── COLUMNA DERECHA: DEBATE EN DIRECTO (SALA RÁPIDA) ──────────────────────
  const colLive = div('debate-col-live');
  const liveCard = div('card live-chat-card');
  liveCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div class="card-title" style="margin-bottom:0"><span class="num" style="background:var(--accent2)">⚡</span> Sala en Directo</div>
      <span style="font-size:0.75rem;color:var(--accent2);font-weight:500">● Sincronización rápida (4s)</span>
    </div>
    <p style="font-size:0.78rem;color:var(--muted);margin-bottom:10px">
      Para negociar en vivo mientras miráis el Reformulario.
    </p>
    <div class="live-feed" id="debate-live-feed">
      ${directos.length ? directos.map(d => `
        <div class="live-msg ${user && d.autor.toLowerCase() === user.nombre.toLowerCase() ? 'mine' : ''}">
          <div class="live-msg-head">
            <strong>${esc(d.autor)}</strong>
            <span>${fmtTimeShort(d.ts)}</span>
          </div>
          <div class="live-msg-body">${esc(d.texto)}</div>
        </div>
      `).join('') : `<div class="muted-note" style="text-align:center;padding:24px 10px">Nadie ha escrito en el canal directo todavía. ¡Rompe el hielo!</div>`}
    </div>
    <div style="display:flex;gap:6px;margin-top:10px">
      <input type="text" id="inp-live-msg" placeholder="Mensaje en directo… (Enter para enviar)" maxlength="500">
      <button type="button" class="btn-propose" id="btn-send-live" style="padding:10px 14px">Enviar</button>
    </div>
  `;
  colLive.appendChild(liveCard);

  layout.append(colAsync, colLive);
  container.appendChild(layout);

  // Poblar lista combinada de hilos + pros/contras filtrados
  renderThreadsList(threadsCard.querySelector('#debate-threads-list'), hilos);

  // Auto-scroll al final del chat en directo
  const feed = liveCard.querySelector('#debate-live-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;

  bindDebateEvents(container);
}

function renderPropuestaItem(p) {
  const votos = Array.isArray(p.votosUp) ? p.votosUp : [];
  const votedByMe = user && votos.some(n => String(n).toLowerCase() === user.nombre.toLowerCase());
  return `
    <div class="propuesta-item ${p.resuelto ? 'resuelta' : ''}" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1">
          <span class="prop-status-badge ${p.resuelto ? 'ok' : ''}">${p.resuelto ? '✓ Acordada' : 'En votación'}</span>
          <span style="font-size:0.9rem;font-weight:500">${esc(p.texto)}</span>
          <div style="font-size:0.75rem;color:var(--muted);margin-top:4px">
            Propuesto por <b>${esc(p.autor)}</b> · ${fmtTimeShort(p.ts)}
            ${votos.length ? ` · Apoyan: <b>${votos.map(esc).join(', ')}</b>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button type="button" class="btn-ref-toggle btn-vote-debate ${votedByMe ? 'active' : ''}" data-id="${p.id}">
            👍 ${votos.length}
          </button>
          <button type="button" class="btn-pc btn-resolve-debate" data-id="${p.id}" data-res="${p.resuelto ? '0' : '1'}" title="Marcar como acordada/pendiente">
            ${p.resuelto ? 'Reabrir' : '✓ Cerrar acuerdo'}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderThreadsList(listEl, hilos) {
  const qMap = new Map(schema.map(q => [q.id, q.label]));

  // Filtrar pros/contras e hilos según selector activo
  const pcFiltered = proscontras.filter(pc => {
    if (debateFilterQid && pc.qid !== debateFilterQid) return false;
    if (debateFilterOpt && pc.optKey !== debateFilterOpt) return false;
    return true;
  });

  const roots = hilos.filter(h => {
    if (h.parentId) return false;
    if (debateFilterQid && h.qid !== debateFilterQid) return false;
    if (debateFilterOpt && h.optKey !== debateFilterOpt) return false;
    return true;
  });

  const repliesByParent = new Map();
  hilos.filter(h => h.parentId).forEach(r => {
    const arr = repliesByParent.get(r.parentId) || [];
    arr.push(r);
    repliesByParent.set(r.parentId, arr);
  });

  let html = '';

  // Mostrar resumen de Pros/Contras de opciones si aplican al filtro
  if (pcFiltered.length) {
    html += `<div class="pc-summary-block">
      <div style="font-size:0.75rem;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase">Pros y Contras registrados en las tarjetas (${pcFiltered.length})</div>
      ${pcFiltered.map(e => `
        <div class="pc-entry" style="padding:4px 0;border-bottom:1px solid var(--border)">
          <span class="pc-tipo ${e.tipo}">${e.tipo === 'pro' ? '✓ PRO' : '✗ CONTRA'}</span>
          <span class="voter-chip">${esc(e.optKey)}</span>
          <span class="pc-texto">${esc(e.texto)}</span>
          <span class="pc-autor">— ${esc(e.autor)}</span>
        </div>
      `).join('')}
    </div>`;
  }

  if (!roots.length && !pcFiltered.length) {
    html += `<div class="muted-note">No hay hilos abiertos para este filtro. Inicia la discusión abajo.</div>`;
  }

  roots.forEach(h => {
    const votos = Array.isArray(h.votosUp) ? h.votosUp : [];
    const voted = user && votos.some(n => String(n).toLowerCase() === user.nombre.toLowerCase());
    const replies = repliesByParent.get(h.id) || [];
    const qLabel = h.qid ? (qMap.get(h.qid) || h.qid) : 'General';

    html += `
      <div class="thread-item">
        <div class="thread-head">
          <span class="voter-chip">${esc(qLabel)}${h.optKey ? ` · ${esc(h.optKey)}` : ''}</span>
          <strong>${esc(h.autor)}</strong>
          <span style="color:var(--muted);font-size:0.75rem">${fmtTimeShort(h.ts)}</span>
        </div>
        <div class="thread-body">${esc(h.texto)}</div>
        <div class="thread-actions">
          <button type="button" class="btn-vote-debate btn-thread-act ${voted ? 'active' : ''}" data-id="${h.id}">
            ▲ Apoyar (${votos.length})
          </button>
          <button type="button" class="btn-reply-thread btn-thread-act" data-id="${h.id}">
            ↩ Responder (${replies.length})
          </button>
        </div>
        ${replies.length ? `
          <div class="thread-replies">
            ${replies.map(r => `
              <div class="thread-reply-item">
                <strong>${esc(r.autor)}:</strong> <span>${esc(r.texto)}</span>
                <small style="color:var(--muted);margin-left:6px">${fmtTimeShort(r.ts)}</small>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  });

  listEl.innerHTML = html;
}

function bindDebateEvents(container) {
  const sendDebateMsg = async (tipo, inputEl, parentId = null) => {
    const texto = inputEl.value.trim();
    if (!texto || !user) { inputEl.focus(); return; }
    inputEl.value = '';

    // Optimista
    const temp = {
      id: Date.now(),
      qid: tipo === 'comentario' ? (debateFilterQid || null) : null,
      optKey: tipo === 'comentario' ? (debateFilterOpt || null) : null,
      parentId,
      tipo,
      texto,
      autor: user.nombre,
      votosUp: [],
      resuelto: false,
      ts: new Date().toISOString(),
    };
    debate.push(temp);
    replyTargetId = null;
    renderDebate();

    try {
      await api({
        action: 'add_debate',
        eid: user.eid,
        nombre: user.nombre,
        pinHash: user.pinHash,
        qid: temp.qid,
        optKey: temp.optKey,
        parentId,
        tipo,
        texto,
      });
      pollOnce();
    } catch (e) {
      showStatus('Error al publicar en el debate: ' + e.message, 'err');
    }
  };

  const btnProp = container.querySelector('#btn-send-propuesta');
  const inpProp = container.querySelector('#inp-new-propuesta');
  if (btnProp && inpProp) {
    btnProp.addEventListener('click', () => sendDebateMsg('propuesta', inpProp));
    inpProp.addEventListener('keydown', e => { if (e.key === 'Enter') btnProp.click(); });
  }

  const btnThread = container.querySelector('#btn-send-thread');
  const inpThread = container.querySelector('#inp-new-thread');
  if (btnThread && inpThread) {
    btnThread.addEventListener('click', () => sendDebateMsg('comentario', inpThread, replyTargetId));
    inpThread.addEventListener('keydown', e => { if (e.key === 'Enter') btnThread.click(); });
  }

  const btnLive = container.querySelector('#btn-send-live');
  const inpLive = container.querySelector('#inp-live-msg');
  if (btnLive && inpLive) {
    btnLive.addEventListener('click', () => sendDebateMsg('directo', inpLive));
    inpLive.addEventListener('keydown', e => { if (e.key === 'Enter') btnLive.click(); });
  }

  const selQ = container.querySelector('#sel-debate-filter-q');
  if (selQ) {
    selQ.addEventListener('change', () => {
      debateFilterQid = selQ.value;
      debateFilterOpt = '';
      renderDebate();
    });
  }

  const chipClearOpt = container.querySelector('#chip-clear-opt');
  if (chipClearOpt) {
    chipClearOpt.style.cursor = 'pointer';
    chipClearOpt.addEventListener('click', () => {
      debateFilterOpt = '';
      renderDebate();
    });
  }

  const btnCancelReply = container.querySelector('#btn-cancel-reply');
  if (btnCancelReply) {
    btnCancelReply.addEventListener('click', () => {
      replyTargetId = null;
      renderDebate();
    });
  }

  container.querySelectorAll('.btn-reply-thread').forEach(btn => {
    btn.addEventListener('click', () => {
      replyTargetId = parseInt(btn.dataset.id, 10);
      renderDebate();
      const inp = $('inp-new-thread');
      if (inp) inp.focus();
    });
  });

  container.querySelectorAll('.btn-vote-debate').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!user) return;
      const id = parseInt(btn.dataset.id, 10);
      try {
        await api({ action: 'vote_debate', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, id });
        pollOnce();
      } catch (e) {
        showStatus('Error al votar: ' + e.message, 'err');
      }
    });
  });

  container.querySelectorAll('.btn-resolve-debate').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!user) return;
      const id = parseInt(btn.dataset.id, 10);
      const resuelto = btn.dataset.res === '1';
      try {
        await api({ action: 'resolve_debate', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, id, resuelto });
        pollOnce();
      } catch (e) {
        showStatus('Error al actualizar estado: ' + e.message, 'err');
      }
    });
  });
}