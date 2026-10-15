// ── CRIPTOGRAFÍA (WebCrypto) ────────────────────────────────────────────────
// Primitivas usadas por la capa de sesión (session.js): hash de PIN y
// cifrado AES-GCM del pinHash en reposo.

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function _ab2hex(buf) {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function _hex2ab(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

// Clave AES a partir de material de 32 bytes (secreto aleatorio exportado o
// sha256 del token). Se importa como extractable y se re-importa el export
// resultante: así AES-GCM queda con una clave dependiente del salt/contexto
// sin necesitar HKDF (que no permite exportar la clave base).
async function deriveAesKey(b64urlKey, saltStr) {
  const tmp = await crypto.subtle.importKey(
    'raw', _b64url2ab(b64urlKey), { name: 'AES-GCM' }, true, ['encrypt']);
  const raw = await crypto.subtle.exportKey('raw', tmp);
  // Mezcla del salt en el material final (dominio por encuesta/sesión)
  const mixed = new Uint8Array(raw);
  const s = new TextEncoder().encode(saltStr);
  for (let i = 0; i < s.length; i++) mixed[i % 32] ^= s[i];
  return crypto.subtle.importKey('raw', mixed, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function aesEncrypt(keyB64url, plaintext, saltStr) {
  const key = await deriveAesKey(keyB64url, saltStr);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return _ab2hex(iv) + '.' + _ab2hex(ct);   // hex:iv(24) . ciphertext
}

async function aesDecrypt(keyB64url, blob, saltStr) {
  const i = blob.indexOf('.');
  if (i < 0) throw new Error('blob inválido');
  const key = await deriveAesKey(keyB64url, saltStr);
  const pt  = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: _hex2ab(blob.slice(0, i)) },
    key, _hex2ab(blob.slice(i + 1)));
  return new TextDecoder().decode(pt);
}

function _b64url2ab(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

function _ab2b64url(ab) {
  let bin = '';
  new Uint8Array(ab).forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}