// user-store.js - Multi-user token store (used by the padel group booking)
// Every friend imports their own delcom_auth once. The imported token doubles as their login:
// the server hands out a random userKey for the browser and a calendarToken for the iCal feed.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isTokenValid, refreshAccessToken, decodeToken, verifyAccessTokenWithDelcom } from './token-manager.js';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// HSP-Token-Felder, die verschlüsselt ruhen
const SECRET_FIELDS = ['accessToken', 'refreshToken', 'idToken'];

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      let needsMigration = false;
      for (const user of Object.values(users)) {
        for (const field of SECRET_FIELDS) {
          if (user[field]) {
            if (!isEncrypted(user[field])) needsMigration = true;
            user[field] = decryptSecret(user[field]);
          }
        }
      }
      if (needsMigration) {
        console.log('🔐 Migriere users.json auf verschlüsselte Token-Speicherung...');
        saveUsers(users); // schreibt verschlüsselt zurück
      }
      return users;
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
  return {};
}

function saveUsers(users) {
  try {
    const dataDir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    // Tiefe Kopie mit verschlüsselten Token-Feldern
    const toStore = {};
    for (const [key, user] of Object.entries(users)) {
      toStore[key] = { ...user };
      for (const field of SECRET_FIELDS) {
        if (toStore[key][field]) toStore[key][field] = encryptSecret(toStore[key][field]);
      }
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(toStore, null, 2));
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

const randomKey = () => crypto.randomBytes(24).toString('hex');

/**
 * Public view of a user (never exposes tokens or keys)
 */
export function publicUser(user) {
  if (!user) return null;
  return {
    memberId: user.memberId,
    name: user.name,
    email: user.email,
    // A refresh token lets us mint a new access token at booking time
    canBook: isTokenValid(user.accessToken) || !!user.refreshToken
  };
}

/**
 * Create or update a user from an imported delcom_auth object.
 * Keeps existing userKey/calendarToken so calendar subscriptions survive a re-import.
 */
export function upsertUserFromAuth(authData) {
  const { tokenResponse, member } = authData;
  const users = loadUsers();
  const existing = users[member.id];

  const user = {
    memberId: member.id,
    email: member.email,
    name: `${member.firstName || ''} ${member.lastName || ''}`.trim() || member.email,
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    idToken: tokenResponse.idToken,
    userKey: existing?.userKey || randomKey(),
    calendarToken: existing?.calendarToken || randomKey(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  users[member.id] = user;
  saveUsers(users);
  return user;
}

// delcom-Member-IDs sind numerisch; JWT-sub kann als String kommen
const normalizeMemberId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : id);

/**
 * Verifiziert eingereichte HSP-Tokens bei delcom und legt den User an.
 *
 * Eingereichte Tokens (SSO-Callback-URL, eingefügtes delcom_auth-JSON) sind nur Base64/JWT
 * und können gefälscht sein. Deshalb wird der Refresh-Token bei delcom eingelöst: nur ein
 * echter Token liefert einen neuen, von delcom ausgestellten Access-Token. Dessen `sub` ist
 * die maßgebliche memberId – nie die vom Client mitgeschickte member.id.
 */
export async function verifyAndUpsertUser(tokenResponse) {
  if (!tokenResponse?.refreshToken && !tokenResponse?.accessToken) {
    throw new Error('Kein Token übermittelt – bitte kompletten JSON-Inhalt einfügen.');
  }

  // 1. Weg: Refresh-Token bei delcom einlösen (liefert frisch ausgestellte Tokens)
  let refreshed = tokenResponse.refreshToken
    ? await refreshAccessToken(tokenResponse.refreshToken, {})
    : null;

  // 2. Weg (Fallback): eingereichten Access-Token direkt bei delcom prüfen
  if (!refreshed?.accessToken) {
    if (!tokenResponse.accessToken || !isTokenValid(tokenResponse.accessToken)) {
      throw new Error('HSP-Token ist abgelaufen. Bitte im HSP-Portal neu anmelden und die Daten erneut kopieren.');
    }
    if (!(await verifyAccessTokenWithDelcom(tokenResponse.accessToken))) {
      throw new Error('HSP-Token wurde von delcom nicht akzeptiert (ungültig oder abgelaufen). Bitte erneut anmelden.');
    }
    console.log('✅ HSP-Token direkt bei delcom verifiziert (Refresh nicht verfügbar)');
    refreshed = {
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken || null,
      idToken: tokenResponse.idToken || null
    };
  }

  const payload = decodeToken(refreshed.accessToken);
  if (!payload || payload.sub === undefined || payload.sub === null) {
    throw new Error('Von delcom ausgestellter Token konnte nicht gelesen werden.');
  }

  // Eingereichter Access-Token muss zum selben Mitglied gehören
  const claimed = tokenResponse.accessToken ? decodeToken(tokenResponse.accessToken) : null;
  if (claimed?.sub !== undefined && claimed?.sub !== null && String(claimed.sub) !== String(payload.sub)) {
    throw new Error('Access-Token und Refresh-Token gehören zu unterschiedlichen Accounts.');
  }

  return upsertUserFromAuth({
    tokenResponse: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken || tokenResponse.idToken || null
    },
    member: {
      id: normalizeMemberId(payload.sub),
      email: payload.email || null,
      firstName: payload.firstName || '',
      lastName: payload.lastName || ''
    }
  });
}

export function getUser(memberId) {
  return loadUsers()[memberId] || null;
}

export function getUserByKey(userKey) {
  if (!userKey) return null;
  return Object.values(loadUsers()).find(u => u.userKey === userKey) || null;
}

export function getUserByCalendarToken(calendarToken) {
  if (!calendarToken) return null;
  return Object.values(loadUsers()).find(u => u.calendarToken === calendarToken) || null;
}

/**
 * Returns a valid access token for the given member, refreshing it if necessary.
 * minValidityMs: the token must stay valid at least this long, otherwise it is refreshed early.
 */
export async function getValidUserToken(memberId, { minValidityMs = 60000 } = {}) {
  const user = getUser(memberId);
  if (!user?.accessToken) return null;

  if (isTokenValid(user.accessToken, minValidityMs)) {
    return user.accessToken;
  }

  // Nur ein Refresh pro Mitglied gleichzeitig: parallele Refreshes mit demselben (rotierenden)
  // Refresh-Token würden sich gegenseitig entwerten (z.B. Keep-Alive + laufender Job)
  if (refreshInFlight.has(memberId)) {
    return refreshInFlight.get(memberId);
  }
  const promise = refreshUserToken(memberId, user)
    .finally(() => refreshInFlight.delete(memberId));
  refreshInFlight.set(memberId, promise);
  return promise;
}

// memberId -> laufender Refresh
const refreshInFlight = new Map();

async function refreshUserToken(memberId, user) {
  const refreshed = await refreshAccessToken(user.refreshToken, {});
  if (!refreshed?.accessToken) {
    // Refresh fehlgeschlagen: den alten Token weiterverwenden, solange er überhaupt noch gilt
    return isTokenValid(user.accessToken) ? user.accessToken : null;
  }

  // Re-read before writing so we don't clobber concurrent updates of other users
  const users = loadUsers();
  users[memberId] = {
    ...users[memberId],
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    idToken: refreshed.idToken,
    updatedAt: new Date().toISOString()
  };
  saveUsers(users);
  return refreshed.accessToken;
}

/**
 * Mitglieder, deren Token der Server selbst erneuern kann (für den Token-Keep-Alive).
 * Liefert pro Mitglied den Refresh-Token (nur zum Erkennen eines neuen Logins) und die
 * Laufzeit des aktuellen Access-Tokens (exp - iat) in ms, falls bekannt.
 */
export function listRefreshableUsers() {
  return Object.values(loadUsers())
    .filter(u => u.refreshToken)
    .map(u => {
      const payload = u.accessToken ? decodeToken(u.accessToken) : null;
      const lifetimeMs = payload?.exp && payload?.iat ? (payload.exp - payload.iat) * 1000 : null;
      return { memberId: u.memberId, refreshToken: u.refreshToken, lifetimeMs };
    });
}

/**
 * Alle HSP-Mitglieder ohne Token-Inhalte (für die Admin-Übersicht).
 */
export function listUsersForAdmin() {
  return Object.values(loadUsers()).map(u => ({
    memberId: u.memberId,
    name: u.name || null,
    email: u.email || null,
    accessToken: u.accessToken || null, // nur serverseitig zur Statusberechnung, wird nicht ausgeliefert
    hasRefreshToken: !!u.refreshToken,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null
  }));
}
