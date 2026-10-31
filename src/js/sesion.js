// ── SESIÓN (sin PIN) ────────────────────────────────────────────────────────
// El acceso depende solo de conocer el código del viaje (eid) y un nombre.
// El servidor ignora la credencial; se envía siempre la constante NO_PIN para
// no cambiar la firma de las RPC. Solo se recuerda { eid, nombre } en este
// navegador. (Borra src/js/session.js: era un duplicado y no se carga.)

var LS_SESSION  = 'viaje_v4_session';
var SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 días
var NO_PIN = '0'.repeat(64);               // formato de hash válido, sin significado
var sessionSecretB64 = null;               // se mantiene por compatibilidad

async function beginSession(nombre, eid, _pinHash, { persist = true } = {}) {
  try {
    if (persist) {
      localStorage.setItem(LS_SESSION, JSON.stringify({ eid, nombre, exp: Date.now() + SESSION_TTL }));
    } else {
      localStorage.removeItem(LS_SESSION);
    }
  } catch (e) {}
}

function getSavedSession() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    return (s && s.eid && s.nombre && Date.now() < s.exp) ? s : null;
  } catch (e) { return null; }
}

async function getSessionPinHash() { return NO_PIN; }
async function storePinHash() {}

async function renameSavedSession(nuevoNombre) {
  const s = getSavedSession();
  if (!s) return;
  s.nombre = nuevoNombre;
  try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch (e) {}
}

function clearSession() {
  try { localStorage.removeItem(LS_SESSION); } catch (e) {}
}

function consumeRevokedElsewhere() { return false; }

async function apiAuthenticated(makeCall) {
  return makeCall(NO_PIN);
}
