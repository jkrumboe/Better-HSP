// user-store.js - Multi-user token store (used by the padel group booking)
// Every friend imports their own delcom_auth once. The imported token doubles as their login:
// the server hands out a random userKey for the browser and a calendarToken for the iCal feed.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isTokenValid, refreshAccessToken } from './token-manager.js';
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
 * Returns a valid access token for the given member, refreshing it if necessary
 */
export async function getValidUserToken(memberId) {
  const user = getUser(memberId);
  if (!user?.accessToken) return null;

  if (isTokenValid(user.accessToken)) {
    return user.accessToken;
  }

  const refreshed = await refreshAccessToken(user.refreshToken, {});
  if (!refreshed?.accessToken) {
    return null;
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
