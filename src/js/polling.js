// ── POLLING ─────────────────────────────────────────────────────────────────
// setTimeout encadenado (no solapa peticiones si el servidor tarda), pausa con la pestaña
// oculta, backoff ante errores y no repinta si la respuesta no cambió.

let pollTimer  = null;
let pollActive = false;
let polling    = false;
let pollFails  = 0;

function currentPollBaseInterval() {
  return (activeMode === 'consensus' || activeMode === 'debate')
    ? POLL_FAST_INTERVAL
    : POLL_INTERVAL;
}

function startPolling() {
  stopPolling();
  pollActive = true;
  pollFails  = 0;
  schedulePoll(currentPollBaseInterval());
}

function stopPolling() {
  pollActive = false;
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  if (pollActive) pollTimer = setTimeout(pollOnce, ms);
}

async function pollOnce() {
  if (!pollActive || !user || polling) return;
  if (document.hidden) return;

  polling = true;
  const dot = $('poll-dot');
  if (dot) dot.classList.add('syncing');
  try {
    const data = await api({ action: 'all', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash });
    if (!pollActive || !user) return;
    pollFails = 0;
    const raw = JSON.stringify(data);
    if (raw !== lastRaw) {
      lastRaw = raw;
      applyPollUpdate(data);
    }
  } catch (e) {
    pollFails++;
    console.warn('Polling error:', e);
  } finally {
    polling = false;
    if (dot) setTimeout(() => dot.classList.remove('syncing'), 800);
    const base = currentPollBaseInterval();
    schedulePoll(base * Math.pow(2, Math.min(pollFails, POLL_MAX_BACKOFF)));
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollActive) { clearTimeout(pollTimer); pollOnce(); }
});

function applyPollUpdate(data) {
  const oldSchema = JSON.stringify(schema);
  const oldPC     = JSON.stringify(proscontras);
  const oldResp   = JSON.stringify(respuestas);
  const oldDebate = JSON.stringify(debate);

  applyData(data);

  const schemaChanged = JSON.stringify(schema) !== oldSchema;
  const pcChanged     = JSON.stringify(proscontras) !== oldPC;
  const respChanged   = JSON.stringify(respuestas) !== oldResp;
  const debateChanged = JSON.stringify(debate) !== oldDebate;

  if (schemaChanged) syncSchemaToDOM();
  if (schemaChanged || pcChanged) refreshAllPC();
  if (typeof renderAusencias === 'function') renderAusencias();
  if ((schemaChanged || respChanged || pcChanged) && typeof renderReformulario === 'function') {
    renderReformulario();
  }
  if ((debateChanged || pcChanged || schemaChanged) && typeof renderDebate === 'function') {
    renderDebate();
  }
}