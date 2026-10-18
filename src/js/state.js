// ── ESTADO ──────────────────────────────────────────────────────────────────
// `user.pinHash` vive SOLO en memoria (nunca en localStorage): si el hash
// circulara por disco, cualquiera con acceso al navegador podría reenviarlo
// y autenticarse sin conocer el PIN (el hash funciona como contraseña).
// NOTA: se usa `var` a propósito. Cada archivo .js es un <script> clásico
// independiente; con `const/let` estas variables quedarían en el "script
// scope" de ESTE archivo y serían invisibles para los demás (ReferenceError).
// Con `var` se cuelgan en window y son compartidas por toda la app.
var user            = null;  // { nombre, eid, pinHash? }
var encuestaTitulo  = 'Cuestionario de viaje';
var schema          = [];
var proscontras     = [];
var respondentes    = [];
var respuestas      = [];
var ausencias       = [];
var debate          = [];
var serverHasV2     = true;  // Detecta si _snapshot devuelve el campo `respuestas`
var activeMode      = 'survey';
var draftDirty      = false;
var weightByProb    = true;
var lastRaw         = '';
var saveTimer       = null;
var statusTimer     = null;

// ── UTILIDADES ──────────────────────────────────────────────────────────────
var $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Icono Font Awesome de uso general en toda la app (sustituye a emojis).
const faIcon = (cls, extraStyle = '') =>
  `<i class="fa-solid ${cls}" aria-hidden="true"${extraStyle ? ` style="${extraStyle}"` : ''}></i>`;

function safeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '';
  } catch (e) { return ''; }
}

function hoyLocal() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function showStatus(msg, kind = 'info', ms = 5000) {
  const el = $('gas-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-' + kind;
  el.style.display = 'block';
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

function applyData(data) {
  if (!data) return;
  serverHasV2    = ('respuestas' in data);
  encuestaTitulo = data.titulo       || 'Cuestionario de viaje';
  schema         = data.schema       || [];
  proscontras    = data.proscontras  || [];
  respondentes   = data.respondentes || [];
  respuestas     = data.respuestas   || [];
  ausencias      = data.ausencias    || [];
  debate         = data.debate       || [];

  // Garantiza que el usuario actual figure siempre en `respondentes` para poder votarse en ausencias
  if (user && user.nombre) {
    const exists = respondentes.some(r => r.nombre.toLowerCase() === user.nombre.toLowerCase());
    if (!exists) {
      respondentes.push({ nombre: user.nombre, ha_respondido: false, prob_asistencia: 80 });
    }
  }

  const h1Title = $('survey-main-title');
  if (h1Title) h1Title.textContent = encuestaTitulo;

  const cResp = $('count-resp');
  if (cResp) cResp.textContent = respuestas.length || respondentes.filter(r => r.ha_respondido !== false).length;
  const cDeb = $('count-debate');
  if (cDeb) cDeb.textContent = debate.length + proscontras.length;

  if (typeof renderParticipants === 'function') renderParticipants();

  // Si estamos viendo Consenso o Debate, repintar inmediatamente
  if (activeMode === 'consensus' && typeof renderReformulario === 'function') renderReformulario();
  if (activeMode === 'debate'    && typeof renderDebate === 'function')       renderDebate();
}

function _extractRaw(ansObj, q) {
  if (!ansObj) return null;
  if (ansObj.values && q.id in ansObj.values) {
    return ansObj.values[q.id];
  }
  switch (q.id) {
    case 'opciones-destino': return ansObj.opciones ?? null;
    case 'casas':            return ansObj.casas ?? null;
    case 'precio':           return ansObj.precioMaxPP ?? null;
    case 'transporte':       return ansObj.transporte ?? null;
    case 'disponibilidad': {
      if (!ansObj.disponibilidad && !ansObj.rangosFechas && !ansObj.diasMax) return null;
      const disp = ansObj.disponibilidad || {};
      return {
        ...disp,
        diasMax: disp.diasMax ?? ansObj.diasMax ?? 5,
        soloFinde: !!disp.soloFinde,
        soloEntreSemana: !!disp.soloEntreSemana,
        meDaIgual: !!disp.meDaIgual,
        preferirPuente: !!disp.preferirPuente,
        rangos: disp.rangos || ansObj.rangosFechas || [],
      };
    }
    default:
      return (ansObj.extras && q.id in ansObj.extras) ? ansObj.extras[q.id] : null;
  }
}
function extractAnswer(ansObj, q) {
  const v = _extractRaw(ansObj, q);
  return q.tipo === 'voto-ponderado' ? normPond(v) : v;
}
