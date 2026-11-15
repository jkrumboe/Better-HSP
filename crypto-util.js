// crypto-util.js
// Zentrale Sicherheits-Helfer – komplett mit Node-Boardmitteln (kein npm-Paket nötig):
//  - Passwort-Hashing (scrypt, einseitig) für App-Logins
//  - Verschlüsselung ruhender HSP-Tokens (AES-256-GCM, umkehrbar)
//  - Signierte Session-Cookies (HMAC-SHA256)
//  - Cookie-Parsing/-Serialisierung
//
// Secrets kommen aus Umgebungsvariablen (SESSION_SECRET, TOKEN_ENCRYPTION_KEY)
// oder werden einmalig erzeugt und in data/.secrets.json abgelegt (git-ignoriert,
// im Docker-Volume persistent). So funktioniert es ohne manuelle Konfiguration,
// lässt sich aber per ENV fest vorgeben.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SECRETS_FILE = path.join(DATA_DIR, '.secrets.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Normalisiert einen Schlüssel aus ENV in 32 Bytes (hex, base64 oder Passphrase).
 */
function coerceKey(raw) {
  if (!raw) return null;
  // 64 hex chars -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // base64, die 32 Bytes ergibt
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* ignore */ }
  // Fallback: beliebige Passphrase auf 32 Byte ableiten
  return crypto.createHash('sha256').update(String(raw)).digest();
}

/**
 * Lädt Secrets aus ENV, fällt auf data/.secrets.json zurück, erzeugt Fehlendes.
 */
function loadOrCreateSecrets() {
  ensureDataDir();

  let stored = {};
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('⚠️  data/.secrets.json konnte nicht gelesen werden:', error.message);
  }

  let changed = false;

  // Session-Secret (für signierte Cookies)
  let sessionSecret = process.env.SESSION_SECRET || stored.sessionSecret;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(48).toString('hex');
    stored.sessionSecret = sessionSecret;
    changed = true;
  }

  // Token-Verschlüsselungs-Key (für AES-256-GCM)
  let tokenKey = coerceKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!tokenKey) {
    if (stored.tokenKey) {
      tokenKey = Buffer.from(stored.tokenKey, 'hex');
    } else {
      tokenKey = crypto.randomBytes(32);
      stored.tokenKey = tokenKey.toString('hex');
      changed = true;
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
      try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* best effort on Windows */ }
      console.log('🔐 Neue Secrets erzeugt und in data/.secrets.json gespeichert.');
    } catch (error) {
      console.error('⚠️  Konnte data/.secrets.json nicht schreiben:', error.message);
    }
  }

  return { sessionSecret, tokenKey };
}

const { sessionSecret: SESSION_SECRET, tokenKey: TOKEN_KEY } = loadOrCreateSecrets();

// ============ PASSWORT-HASHING (scrypt, einseitig) ============

const SCRYPT_N = 16384; // CPU/Memory-Kosten
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;

/**
 * Hasht ein Passwort. Format: scrypt$N$r$p$saltB64$hashB64
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Prüft ein Passwort gegen einen gespeicherten Hash (timing-safe).
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ============ TOKEN-VERSCHLÜSSELUNG (AES-256-GCM, umkehrbar) ============

const ENC_PREFIX = 'enc:1:';

/**
 * Verschlüsselt einen String. Rückgabe: enc:1:ivB64:tagB64:ctB64
 * Leere/Nullwerte bleiben unverändert.
 */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  const str = String(plaintext);
  if (str.startsWith(ENC_PREFIX)) return str; // schon verschlüsselt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ct = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Entschlüsselt einen String. Nicht verschlüsselte Werte (Altbestand) werden
 * unverändert zurückgegeben, damit die Migration transparent bleibt.
 */
export function decryptSecret(value) {
  if (value === null || value === undefined || value === '') return value;
  const str = String(value);
  if (!str.startsWith(ENC_PREFIX)) return str; // Klartext (Altbestand)
  try {
    const [, , ivB64, tagB64, ctB64] = str.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('⚠️  Token-Entschlüsselung fehlgeschlagen (falscher TOKEN_ENCRYPTION_KEY?):', error.message);
    return null;
  }
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

// ============ SESSION-TOKENS (HMAC-signiert, zustandslos) ============

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Erzeugt ein signiertes Session-Token. payload z.B. { sub, sv }.
 */
export function signSession(payload, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + maxAgeSeconds };
  const bodyB64 = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(bodyB64).digest());
  return `${bodyB64}.${sig}`;
}

/**
 * Verifiziert ein Session-Token. Gibt das Payload zurück oder null.
 */
export function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [bodyB64, sig] = token.split('.');
  if (!bodyB64 || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(bodyB64).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(b64urlToBuf(bodyB64).toString('utf8'));
    if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Signiert kurze State-Werte (z.B. für den SSO-Redirect).
 */
export function signState(value, maxAgeSeconds = 600) {
  return signSession({ st: value }, maxAgeSeconds);
}
export function verifyState(token) {
  const payload = verifySession(token);
  return payload ? payload.st : null;
}

// ============ COOKIES ============

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}
