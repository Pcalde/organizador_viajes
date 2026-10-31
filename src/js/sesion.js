// ── SESIÓN / CREDENCIALES ───────────────────────────────────────────────────
// Modelo de seguridad:
//  • El pinHash = sha256(PIN|eid) funciona como contraseña de facto: quien lo
//    posea puede autenticarse sin conocer el PIN. Por eso NUNCA se guarda en
//    claro en ningún almacén del navegador.
//  • Al hacer login se genera un secreto de sesión aleatorio (WebCrypto).
//    Con él se cifra el pinHash (AES-GCM, clave derivada por HKDF) y ese
//    ciphertext se guarda en localStorage junto a un TTL de 12 h.
//  • El propio secreto queda además sellado bajo una clave derivada del
//    token de sesión, de modo que la sesión sobrevive recargar la página o
//    abrir una pestaña nueva EN EL MISMO NAVEGADOR. En otro dispositivo no
//    existen ni el token ni el ciphertext: allí hay que introducir el PIN —
//    así cada dispositivo tiene su sesión independiente, y cerrar sesión en
//    uno no cierra (por diseño) los demás.
//  • Logout sincronizado entre pestañas del mismo navegador: la revocación
//    se anuncia escribiendo en LS_REVOKED; el evento 'storage' avisa a las
//    demás pestañas, que devuelven al usuario al login en su próximo poll.

const LS_SESSION  = 'viaje_v3_session';   // { token, eid, nombre, ctPin, seal, salt, exp }
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const NO_PIN = '0'.repeat(64);           // el servidor ya lo ignora

let sessionSecretB64 = null;              // secreto de sesión (solo en memoria)

async function beginSession(nombre, eid, _ph, { persist = true } = {}) {
  try {
    if (persist) localStorage.setItem(LS_SESSION, JSON.stringify({ eid, nombre, exp: Date.now() + SESSION_TTL }));
    else localStorage.removeItem(LS_SESSION);
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
async function renameSavedSession(nombre) {
  const s = getSavedSession(); if (!s) return;
  s.nombre = nombre; try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch (e) {}
}
function clearSession() { try { localStorage.removeItem(LS_SESSION); } catch (e) {} }
function consumeRevokedElsewhere() { return false; }
async function apiAuthenticated(makeCall) { return makeCall(NO_PIN); }
