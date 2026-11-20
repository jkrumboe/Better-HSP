// token-manager.js
// Verwaltet Authentifizierungs-Tokens und generiert neue bei Bedarf

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Felder, die im Store verschlüsselt ruhen (AES-256-GCM)
const SECRET_FIELDS = ['accessToken', 'refreshToken', 'idToken'];
const API_BASE = 'https://backbone-web-api.production.munster.delcom.nl';
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_STORE_FILE = path.join(DATA_DIR, 'token-store.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default-Struktur für persistierte Daten
const EMPTY_STORE = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  expiresIn: null,
  memberId: null,
  memberEmail: null,
  memberName: null
};

/**
 * Dekodiert einen JWT Token
 */
function decodeToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload;
  } catch (error) {
    return null;
  }
}

/**
 * Prüft, ob ein Token noch gültig ist
 */
function isTokenValid(token, minValidityMs = 60000) {
  const payload = decodeToken(token);
  if (!payload || !payload.exp) return false;
  
  const expiresAt = new Date(payload.exp * 1000);
  const now = new Date();
  
  // Token ist gültig, wenn der Ablauf mindestens minValidityMs (Standard: 1 Minute) in der Zukunft liegt
  return expiresAt.getTime() - now.getTime() > minValidityMs;
}

/**
 * Gibt Informationen über einen Token aus
 */
function getTokenInfo(token) {
  const payload = decodeToken(token);
  if (!payload) return null;
  
  const issuedAt = new Date(payload.iat * 1000);
  const expiresAt = new Date(payload.exp * 1000);
  const now = new Date();
  
  const remainingMs = expiresAt.getTime() - now.getTime();
  const remainingMinutes = Math.floor(remainingMs / 60000);
  const remainingHours = Math.floor(remainingMinutes / 60);
  const remainingDays = Math.floor(remainingHours / 24);
  
  return {
    email: payload.email,
    name: `${payload.firstName} ${payload.lastName}`,
    userId: payload.sub,
    issuedAt: issuedAt.toLocaleString('de-DE'),
    expiresAt: expiresAt.toLocaleString('de-DE'),
    remainingMinutes,
    remainingHours,
    remainingDays,
    isValid: isTokenValid(token),
    remainingText: remainingDays > 0 
      ? `${remainingDays} Tage`
      : remainingHours > 0
        ? `${remainingHours} Stunden`
        : `${remainingMinutes} Minuten`
  };
}

/**
 * Holt gespeicherte Member-Informationen (fällt auf Token-Payload zurück)
 */
function getStoredMemberInfo() {
  const store = loadTokens();
  const fromToken = store.accessToken ? decodeToken(store.accessToken) : null;

  const memberId = store.memberId ?? fromToken?.sub ?? null;
  const memberEmail = store.memberEmail ?? fromToken?.email ?? null;
  const memberName = store.memberName ?? (fromToken ? `${fromToken.firstName ?? ''} ${fromToken.lastName ?? ''}`.trim() : null);

  return { memberId, memberEmail, memberName };
}

/**
 * Lädt die gespeicherten Tokens
 */
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_STORE_FILE)) {
      const data = fs.readFileSync(TOKEN_STORE_FILE, 'utf-8');
      const parsed = { ...EMPTY_STORE, ...JSON.parse(data) };

      // Verschlüsselte Token-Felder entschlüsseln
      let needsMigration = false;
      for (const field of SECRET_FIELDS) {
        if (parsed[field]) {
          if (!isEncrypted(parsed[field])) needsMigration = true; // Altbestand im Klartext
          parsed[field] = decryptSecret(parsed[field]);
        }
      }
      // Einmalige Migration: Klartext-Tokens verschlüsselt neu schreiben
      if (needsMigration) {
        console.log('🔐 Migriere token-store.json auf verschlüsselte Speicherung...');
        saveTokens(parsed);
      }
      return parsed;
    }
  } catch (error) {
    console.error('Fehler beim Laden der Tokens:', error.message);
  }
  return { ...EMPTY_STORE };
}

/**
 * Speichert die Tokens (sensible Felder verschlüsselt)
 */
function saveTokens(tokens) {
  try {
    const merged = { ...EMPTY_STORE, ...tokens };
    const toStore = { ...merged };
    for (const field of SECRET_FIELDS) {
      if (toStore[field]) toStore[field] = encryptSecret(toStore[field]);
    }
    fs.writeFileSync(TOKEN_STORE_FILE, JSON.stringify(toStore, null, 2));
    console.log('✅ Tokens gespeichert (verschlüsselt) in:', TOKEN_STORE_FILE);
  } catch (error) {
    console.error('Fehler beim Speichern der Tokens:', error.message);
  }
}

/**
 * Generiert einen neuen AccessToken mit dem RefreshToken
 */
async function refreshAccessToken(refreshToken, memberMeta = {}) {
  if (!refreshToken) {
    console.error('❌ Kein Refresh-Token vorhanden!');
    return null;
  }

  try {
    console.log('🔄 Generiere neuen Access-Token mit Refresh-Token...');
    
    // Endpoint wie im aktuellen HSP-Frontend (das alte /auth/refresh liefert 404)
    const res = await fetch(`${API_BASE}/auth/token-refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        refresh_token: refreshToken
      })
    });

    if (!res.ok) {
      const error = await res.text();
      console.error('❌ Fehler beim Token-Refresh:', res.status, error);
      return null;
    }

    const data = await res.json();
    const accessToken = data.access_token || data.accessToken;
    if (!accessToken) {
      console.error('❌ Token-Refresh ohne Access-Token in der Antwort');
      return null;
    }
    console.log('✅ Neuer Token generiert!');

    return {
      accessToken,
      idToken: data.id_token || data.idToken,
      refreshToken: data.refresh_token || data.refreshToken || refreshToken,
      expiresIn: data.expires_in ?? data.expiresIn,
      memberId: memberMeta.memberId || null,
      memberEmail: memberMeta.memberEmail || null,
      memberName: memberMeta.memberName || null
    };
  } catch (error) {
    console.error('❌ Fehler beim Token-Refresh:', error.message);
    return null;
  }
}

/**
 * Prüft einen Access-Token direkt bei delcom (ohne Refresh).
 *
 * Ein JWT ist nur Base64 – sein Inhalt (sub, email) ist erst vertrauenswürdig, wenn delcom die
 * Signatur akzeptiert. Damit das auch dann aussagekräftig ist, wenn ein Endpoint ungültige Tokens
 * stillschweigend ignorieren würde, gilt ein Token nur als echt, wenn
 *   (a) der Request mit dem Token erfolgreich ist UND
 *   (b) derselbe Request mit absichtlich kaputter Signatur abgelehnt wird (401/403).
 */
async function verifyAccessTokenWithDelcom(accessToken) {
  const payload = decodeToken(accessToken);
  if (!payload?.sub || !isTokenValid(accessToken)) return false;

  const parts = String(accessToken).split('.');
  if (parts.length !== 3) return false;
  const sig = parts[2];
  const tampered = `${parts[0]}.${parts[1]}.${(sig[0] === 'A' ? 'B' : 'A')}${sig.slice(1)}`;

  const filter = encodeURIComponent(JSON.stringify({ memberId: payload.sub }));
  const probes = [
    `${API_BASE}/participations?s=${filter}&limit=1`,
    `${API_BASE}/bookings?s=${encodeURIComponent(JSON.stringify({ 'participations.memberId': payload.sub }))}&join=participations&limit=1`
  ];
  const call = (url, token) => fetch(url, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
  }).then(r => r.status).catch(() => 0);

  for (const url of probes) {
    const [good, bad] = await Promise.all([call(url, accessToken), call(url, tampered)]);
    if (good >= 200 && good < 300 && (bad === 401 || bad === 403)) return true;
    if (good === 401 || good === 403) return false; // delcom lehnt den echten Token ab
  }
  return false;
}

/**
 * Holt einen gültigen Token (erstellt neuen falls nötig)
 */
async function getValidToken() {
  const tokens = loadTokens();
  
  if (!tokens.accessToken) {
    console.error('❌ Kein Token vorhanden. Bitte über die Website anmelden.');
    return null;
  }

  const info = getTokenInfo(tokens.accessToken);
  if (!info) {
    console.error('❌ Token konnte nicht dekodiert werden');
    return null;
  }

  console.log(`\n📋 Token-Info:`);
  console.log(`   Email: ${info.email}`);
  console.log(`   Name: ${info.name}`);
  console.log(`   Gültig bis: ${info.expiresAt}`);
  console.log(`   Noch gültig: ${info.remainingText}`);

  if (info.isValid) {
    console.log('✅ Token ist noch gültig\n');
    return tokens.accessToken;
  } else {
    console.log('⚠️  Token ist abgelaufen. Versuche zu erneuern...\n');
    
    const newTokenData = await refreshAccessToken(tokens.refreshToken, {
      memberId: tokens.memberId,
      memberEmail: tokens.memberEmail,
      memberName: tokens.memberName
    });
    if (newTokenData) {
      saveTokens(newTokenData);
      return newTokenData.accessToken;
    }
    return null;
  }
}

/**
 * Speichert Token aus dem LocalStorage-Export
 */
function importFromLocalStorage(jsonData) {
  try {
    const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    
    if (data.tokenResponse && data.tokenResponse.accessToken) {
      const tokens = {
        accessToken: data.tokenResponse.accessToken,
        refreshToken: data.tokenResponse.refreshToken,
        idToken: data.tokenResponse.idToken,
        expiresIn: data.tokenResponse.expiresIn,
        memberId: data.member?.id ?? null,
        memberEmail: data.member?.email ?? null,
        memberName: data.member ? `${data.member.firstName ?? ''} ${data.member.lastName ?? ''}`.trim() : null
      };
      
      saveTokens(tokens);
      
      const info = getTokenInfo(tokens.accessToken);
      console.log('✅ Token aus LocalStorage importiert!');
      console.log(`   Gültig für: ${info.remainingText}`);
      
      return tokens;
    }
  } catch (error) {
    console.error('❌ Fehler beim Import:', error.message);
  }
  return null;
}

/**
 * Exportiere die Funktion für die Anmeldungs-Skripte
 */
export {
  decodeToken,
  isTokenValid,
  getTokenInfo,
  getStoredMemberInfo,
  loadTokens,
  saveTokens,
  refreshAccessToken,
  verifyAccessTokenWithDelcom,
  getValidToken,
  importFromLocalStorage,
  TOKEN_STORE_FILE
};

// Wenn direkt ausgeführt, zeige aktuelle Token-Info
const currentModule = import.meta.url;
const args = process.argv[1];
const isMainModule = args && args.includes('token-manager.js');

if (isMainModule) {
  const token = await getValidToken();
  if (token) {
    const info = getTokenInfo(token);
    console.log('\n🔐 Token-Details:');
    console.log(JSON.stringify(info, null, 2));
  }
}
