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
const LS_REVOKED  = 'viaje_v3_revoked';   // { [eid]: ["token:salt", ...] }
const SESSION_TTL = 12 * 60 * 60 * 1000;  // 12 horas

let sessionSecretB64 = null;              // secreto de sesión (solo en memoria)

// ── utilidades de codificación ──────────────────────────────────────────────
function _b64urlEncode(bytes) {
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _shaHexToB64url(hex) {
  const a = new Uint8Array(32);
  for (let i = 0; i < 32; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return _b64urlEncode(a);
}
async function _keyFromToken(token) {          // clave estable tras recargar
  return _shaHexToB64url(await sha256('seal|' + token));
}

// ── alta de sesión (login / crear encuesta con éxito) ───────────────────────
// persist=false → sesión efímera: nada toca el disco (el pinHash solo vive
// en memoria y muere al cerrar la pestaña).
async function beginSession(nombre, eid, pinHash, { persist = true } = {}) {
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  sessionSecretB64 = _b64urlEncode(secretBytes);

  if (!persist) {
    try { localStorage.removeItem(LS_SESSION); } catch (e) {}
    return;
  }

  const token = randomHex(32);
  const salt  = eid + '|' + Date.now();
  const saved = {
    token, eid, nombre, salt,
    exp:   Date.now() + SESSION_TTL,
    ctPin: await aesEncrypt(sessionSecretB64, pinHash, salt),   // pinHash cifrado
    seal:  await aesEncrypt(await _keyFromToken(token),         // secreto sellable
                             sessionSecretB64, salt),
  };
  try { localStorage.setItem(LS_SESSION, JSON.stringify(saved)); } catch (e) {}
}

// ── lectura de datos NO sensibles de la sesión guardada ─────────────────────
function getSavedSessionRaw() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    return (s && s.token && s.eid && s.nombre && s.ctPin && s.seal && s.salt && s.exp) ? s : null;
  } catch (e) { return null; }
}

function _revokedList(s) {
  try {
    const map = JSON.parse(localStorage.getItem(LS_REVOKED) || '{}');
    return map[s.eid] || [];
  } catch (e) { return []; }
}
function _isRevoked(s) {
  return !!s && _revokedList(s).includes(s.token + ':' + s.salt);
}

function getSavedSession() {
  const s = getSavedSessionRaw();
  if (!s) return null;
  if (Date.now() > s.exp) { _dropSessionRecord(); return null; }   // TTL caducado
  if (_isRevoked(s)) return null;                                  // cerrada en otra pestaña
  return s;
}

// ── obtención del pinHash para restaurar la sesión ──────────────────────────
// Primero la memoria de esta pestaña; si no, descifra desde localStorage.
async function getSessionPinHash(eid, nombre) {
  if (user && user.eid === eid && user.pinHash) return user.pinHash;
  const s = getSavedSession();
  if (!s || s.eid !== eid) return null;
  try {
    if (!sessionSecretB64) {
      sessionSecretB64 = await aesDecrypt(await _keyFromToken(s.token), s.seal, s.salt);
    }
    const hex = await aesDecrypt(sessionSecretB64, s.ctPin, s.salt);
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch (e) {
    _dropSessionRecord();
    return null;
  }
}

// Refresca el ciphertext del pinHash (p. ej. tras rotar credencial).
// La persistencia inicial la hace siempre beginSession.
async function storePinHash(eid, pinHash) {
  const s = getSavedSessionRaw();
  if (!s || s.eid !== eid || !sessionSecretB64) return;
  try {
    s.ctPin = await aesEncrypt(sessionSecretB64, pinHash, s.salt);
    localStorage.setItem(LS_SESSION, JSON.stringify(s));
  } catch (e) {}
}

// ── revocación sincronizada entre pestañas del mismo navegador ──────────────
function _announceRevocation(s) {
  try {
    const map = JSON.parse(localStorage.getItem(LS_REVOKED) || '{}');
    const list = (map[s.eid] = map[s.eid] || []);
    const tag = s.token + ':' + s.salt;
    if (!list.includes(tag)) list.push(tag);
    if (list.length > 50) map[s.eid] = list.slice(-50);   // saneo
    localStorage.setItem(LS_REVOKED, JSON.stringify(map));
  } catch (e) {}
}

function _dropSessionRecord() {
  sessionSecretB64 = null;
  try { localStorage.removeItem(LS_SESSION); } catch (e) {}
}

// Cierra la sesión GUARDADA y avisa a las demás pestañas de este navegador.
// (El estado en memoria de la pestaña que llama se limpia aparte en logout().)
function clearSession() {
  const s = getSavedSessionRaw();
  if (s) _announceRevocation(s);
  _dropSessionRecord();
}

// ¿Otra pestaña cerró nuestra sesión mientras esta seguía abierta?
// Se alimenta del evento 'storage' (dispara SOLO en las otras pestañas).
let _revokedElsewhere = false;
window.addEventListener('storage', e => {
  if (e.key !== LS_REVOKED || !e.newValue) return;
  const s = getSavedSessionRaw();
  if (s && _isRevoked(s) && user) _revokedElsewhere = true;
});

function consumeRevokedElsewhere() {
  const v = _revokedElsewhere;
  _revokedElsewhere = false;
  return v;
}

// ── reintento autenticado ───────────────────────────────────────────────────
// Si el servidor rechaza la credencial en memoria, reintentamos una vez con
// el pinHash descifrado desde el almacén cifrado antes de dar la sesión por
// perdida. Un bloqueo por intentos debe respetarse sin generar más tráfico.
async function apiAuthenticated(makeCall) {
  try {
    return await makeCall(user && user.pinHash);
  } catch (e) {
    const msg = String((e && e.message) || '');
    const authFail = /PIN incorrecto|Usuario no registrado/i.test(msg);
    if (!authFail || !user) throw e;
    const fresh = await getSessionPinHash(user.eid, user.nombre);
    if (!fresh || fresh === user.pinHash) throw e;
    const res = await makeCall(fresh);
    user.pinHash = fresh;
    await storePinHash(user.eid, fresh);
    return res;
  }
}
