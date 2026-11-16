// auth-store.js
// App-Accounts (E-Mail + Passwort) für den Zugang zur Web-App.
// Passwörter werden mit scrypt gehasht (siehe crypto-util.js), nie im Klartext gespeichert.
// Ein App-Account kann mit einem HSP-Mitglied (memberId) verknüpft sein; die HSP-Tokens
// selbst liegen verschlüsselt im user-store (users.json).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword, verifyPassword, randomToken } from './crypto-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.join(__dirname, 'data', 'accounts.json');

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading accounts:', error);
  }
  return {};
}

function saveAccounts(accounts) {
  const dataDir = path.dirname(ACCOUNTS_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function getAccount(id) {
  if (!id) return null;
  return loadAccounts()[id] || null;
}

export function getAccountByEmail(email) {
  const e = normalizeEmail(email);
  return Object.values(loadAccounts()).find(a => a.email === e) || null;
}

/**
 * Legt einen neuen Account an. Wirft einen Error mit sprechender Nachricht bei Problemen.
 * Der erste Account im System wird automatisch 'admin'.
 */
export function registerAccount(email, password) {
  const e = normalizeEmail(email);
  if (!isValidEmail(e)) throw new Error('Bitte eine gültige E-Mail-Adresse angeben.');
  if (!password || String(password).length < 8) {
    throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }

  const accounts = loadAccounts();
  if (Object.values(accounts).some(a => a.email === e)) {
    throw new Error('Für diese E-Mail existiert bereits ein Account.');
  }

  const id = randomToken(16);
  const isFirst = Object.keys(accounts).length === 0;
  const account = {
    id,
    email: e,
    passwordHash: hashPassword(password),
    role: isFirst ? 'admin' : 'user',
    sessionVersion: 1,
    linkedMemberId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  accounts[id] = account;
  saveAccounts(accounts);
  return account;
}

/**
 * Prüft Login-Daten. Gibt den Account zurück oder null.
 */
export function verifyLogin(email, password) {
  const account = getAccountByEmail(email);
  if (!account) return null;
  if (!verifyPassword(password, account.passwordHash)) return null;
  return account;
}

/**
 * Ändert das Passwort und invalidiert bestehende Sessions.
 */
export function changePassword(accountId, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) throw new Error('Account nicht gefunden.');
  acc.passwordHash = hashPassword(newPassword);
  acc.sessionVersion = (acc.sessionVersion || 1) + 1; // alle alten Sessions ungültig
  acc.updatedAt = new Date().toISOString();
  saveAccounts(accounts);
  return acc;
}

/**
 * Verknüpft den App-Account mit einem HSP-Mitglied.
 */
export function linkMember(accountId, memberId) {
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) throw new Error('Account nicht gefunden.');
  acc.linkedMemberId = memberId;
  acc.updatedAt = new Date().toISOString();
  saveAccounts(accounts);
  return acc;
}

/**
 * Erhöht die sessionVersion -> alle bestehenden Sessions werden ungültig ("überall abmelden").
 */
export function bumpSessionVersion(accountId) {
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) return null;
  acc.sessionVersion = (acc.sessionVersion || 1) + 1;
  acc.updatedAt = new Date().toISOString();
  saveAccounts(accounts);
  return acc;
}

/**
 * Öffentliche Sicht auf einen Account (nie passwordHash).
 */
export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    linkedMemberId: account.linkedMemberId || null,
    createdAt: account.createdAt
  };
}

// ============ ADMIN ============

/**
 * Alle Accounts (öffentliche Sicht + Admin-relevante Felder, nie passwordHash).
 */
export function listAccounts() {
  return Object.values(loadAccounts()).map(a => ({
    ...publicAccount(a),
    updatedAt: a.updatedAt || null,
    lastLoginAt: a.lastLoginAt || null
  }));
}

/**
 * Merkt sich den Zeitpunkt des letzten Logins (für die Admin-Übersicht).
 */
export function recordLogin(accountId) {
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) return;
  acc.lastLoginAt = new Date().toISOString();
  saveAccounts(accounts);
}

const countAdmins = (accounts) => Object.values(accounts).filter(a => a.role === 'admin').length;

/**
 * Setzt die Rolle ('admin' | 'user'). Der letzte Admin kann nicht herabgestuft werden.
 */
export function setRole(accountId, role) {
  if (!['admin', 'user'].includes(role)) throw new Error('Ungültige Rolle.');
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) throw new Error('Account nicht gefunden.');
  if (acc.role === 'admin' && role !== 'admin' && countAdmins(accounts) <= 1) {
    throw new Error('Der letzte Admin kann nicht herabgestuft werden.');
  }
  acc.role = role;
  acc.sessionVersion = (acc.sessionVersion || 1) + 1; // Rechte sofort wirksam
  acc.updatedAt = new Date().toISOString();
  saveAccounts(accounts);
  return acc;
}

/**
 * Löscht einen Account. Der letzte Admin kann nicht gelöscht werden.
 */
export function deleteAccount(accountId) {
  const accounts = loadAccounts();
  const acc = accounts[accountId];
  if (!acc) throw new Error('Account nicht gefunden.');
  if (acc.role === 'admin' && countAdmins(accounts) <= 1) {
    throw new Error('Der letzte Admin kann nicht gelöscht werden.');
  }
  delete accounts[accountId];
  saveAccounts(accounts);
  return acc;
}
