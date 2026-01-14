// token-manager.js
// Verwaltet Authentifizierungs-Tokens und generiert neue bei Bedarf

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
function isTokenValid(token) {
  const payload = decodeToken(token);
  if (!payload || !payload.exp) return false;
  
  const expiresAt = new Date(payload.exp * 1000);
  const now = new Date();
  
  // Token ist gültig, wenn Ablauf mindestens 1 Minute in der Zukunft liegt
  return expiresAt.getTime() - now.getTime() > 60000;
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
      return { ...EMPTY_STORE, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('Fehler beim Laden der Tokens:', error.message);
  }
  return { ...EMPTY_STORE };
}

/**
 * Speichert die Tokens
 */
function saveTokens(tokens) {
  try {
    const merged = { ...EMPTY_STORE, ...tokens };
    fs.writeFileSync(TOKEN_STORE_FILE, JSON.stringify(merged, null, 2));
    console.log('✅ Tokens gespeichert in:', TOKEN_STORE_FILE);
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
    
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        refreshToken: refreshToken
      })
    });

    if (!res.ok) {
      const error = await res.text();
      console.error('❌ Fehler beim Token-Refresh:', res.status, error);
      return null;
    }

    const data = await res.json();
    console.log('✅ Neuer Token generiert!');
    
    return {
      accessToken: data.accessToken,
      idToken: data.idToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn,
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
