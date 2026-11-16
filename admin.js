// admin.js - Admin-Bereich auf einem EIGENEN Port, nur aus Heimnetz + Tailscale erreichbar.
//
// Schutz in drei Schichten:
//  1. Eigener Port (ADMIN_PORT), der nicht über den Nginx Proxy Manager / die Domain läuft
//     und am Router nicht freigegeben ist.
//  2. IP-Allowlist (automatisch: Heimnetz + Tailscale, siehe unten). Geprüft wird die echte
//     TCP-Quelladresse (req.socket.remoteAddress), NICHT X-Forwarded-For (wäre fälschbar).
//  3. Login: App-Account mit Rolle 'admin', eigenes Admin-Cookie (kurzlebig, SameSite=Strict).

import express from 'express';
import fs from 'fs';
import { createServer } from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  verifyLogin, getAccount, listAccounts, setRole, deleteAccount, bumpSessionVersion
} from './auth-store.js';
import { listUsersForAdmin } from './user-store.js';
import { getTokenInfo } from './token-manager.js';
import { getScheduledJobs, cancelScheduledJob } from './scheduler.js';
import { listSessions } from './padel.js';
import { signSession, verifySession, parseCookies, serializeCookie } from './crypto-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3004);
const ADMIN_COOKIE = 'hsp_admin';
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 12; // 12 Stunden
// Tailscale-Verkehr ist per WireGuard verschlüsselt, der Admin-Port läuft daher meist per http://
// -> Secure-Cookie standardmäßig aus (sonst würde der Browser das Cookie nicht speichern).
const ADMIN_COOKIE_SECURE = process.env.ADMIN_COOKIE_SECURE === 'true';

// ============ LOG-PUFFER ============
// Die letzten Konsolenausgaben im Speicher halten, damit sie im Admin-Bereich sichtbar sind.

const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const msg = args.map(a =>
          a instanceof Error ? (a.stack || a.message)
            : typeof a === 'string' ? a
              : JSON.stringify(a)
        ).join(' ');
        logBuffer.push({ ts: new Date().toISOString(), level, msg: msg.slice(0, 4000) });
        if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
      } catch { /* Logging darf nie den Server stören */ }
    };
  }
}
captureConsole();

// ============ NETZWERK-ERKENNUNG / IP-ALLOWLIST ============
//
// Ohne Konfiguration erlaubt: Heimnetz + Tailscale. Dazu zählen
//  - Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48)
//  - typische Heimnetze (10.0.0.0/8, 192.168.0.0/16, IPv6 ULA/link-local) und Loopback
//  - zusätzlich die Subnetze der echten Netzwerkkarten des Servers (z.B. ein 172.16.x-Heimnetz)
// Ausgeschlossen werden die Docker-Bridge-Netze des Servers: über docker-proxy/NAT kann dort
// auch Internet-Verkehr landen (z.B. IPv6), deshalb fehlt 172.16.0.0/12 in der Standardliste.
// ADMIN_ALLOWED_IPS (optional) ersetzt die automatische Liste komplett.

const TAILSCALE_RANGES = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
const HOME_RANGES = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'];
// Linux-Namen sind klein geschrieben (case-sensitive, damit z.B. Windows "vEthernet" nicht passt)
const DOCKER_IFACE = /^(docker|br-|veth|virbr|cni|flannel|cali|podman|lxc|lxd)/;
const IN_CONTAINER = fs.existsSync('/.dockerenv');

const ipType = (ip) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');

function makeList(cidrs) {
  const list = new net.BlockList();
  for (const entry of cidrs) {
    const [addr, prefix] = String(entry).split('/');
    if (!net.isIP(addr)) {
      console.warn(`⚠️  Admin-Allowlist: ungültiger Eintrag ignoriert: ${entry}`);
      continue;
    }
    if (prefix !== undefined) list.addSubnet(addr, Number(prefix), ipType(addr));
    else list.addAddress(addr, ipType(addr));
  }
  return list;
}

const tailscaleList = makeList(TAILSCALE_RANGES);
const privateList = makeList([...HOME_RANGES, '172.16.0.0/12']);
const isTailscaleIp = (ip) => net.isIP(ip) && tailscaleList.check(ip, ipType(ip));
const isPrivateIp = (ip) => net.isIP(ip) && privateList.check(ip, ipType(ip));

/**
 * Liest die Netzwerkkarten des Servers. Läuft der Container mit network_mode: host, sind das
 * die echten Adressen des Servers (LAN + tailscale0) – daraus entstehen auch die Admin-Links.
 */
function detectNetwork() {
  const ifaces = os.networkInterfaces();
  const names = Object.keys(ifaces);
  // Docker-Bridge-Modus: im Container nur eth0 auf einem Docker-Netz, keine Host-Karten sichtbar
  const hostView = !IN_CONTAINER || names.some(n => DOCKER_IFACE.test(n) || /^tailscale/i.test(n));

  const addresses = []; // { kind: 'tailscale' | 'lan', address, iface }
  const homeCidrs = [];
  const dockerCidrs = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (!i.cidr || i.internal) continue;
      if (DOCKER_IFACE.test(name)) {
        // fe80::/64 teilen sich ALLE Netze – nie sperren, sonst fliegen echte Heimgeräte raus
        if (!i.address.toLowerCase().startsWith('fe80')) dockerCidrs.push(i.cidr);
        continue;
      }
      if (!hostView) continue;
      if (isTailscaleIp(i.address) || /^tailscale/i.test(name)) {
        addresses.push({ kind: 'tailscale', address: i.address, iface: name });
      } else if (isPrivateIp(i.address)) {
        addresses.push({ kind: 'lan', address: i.address, iface: name });
        if (!i.address.startsWith('fe80')) homeCidrs.push(i.cidr);
      }
    }
  }
  return { hostView, addresses, homeCidrs, dockerCidrs };
}

let netCache = null;
function getAccessRules() {
  if (netCache && Date.now() - netCache.at < 30 * 1000) return netCache; // Tailscale kann später starten
  const detected = detectNetwork();
  const override = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowEntries = override.length
    ? override
    : [...TAILSCALE_RANGES, ...HOME_RANGES, ...detected.homeCidrs];
  netCache = {
    at: Date.now(),
    detected,
    allowEntries: [...new Set(allowEntries)],
    denyEntries: override.length ? [] : detected.dockerCidrs,
    isOverride: override.length > 0,
    allow: makeList(allowEntries),
    deny: makeList(override.length ? [] : detected.dockerCidrs)
  };
  return netCache;
}

/** Normalisiert "::ffff:100.1.2.3" -> "100.1.2.3". */
function clientIp(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isAllowed(ip) {
  if (!net.isIP(ip)) return false;
  const rules = getAccessRules();
  return !rules.deny.check(ip, ipType(ip)) && rules.allow.check(ip, ipType(ip));
}

// ============ ADMIN-LINKS (für den Sprung aus der App) ============
// Erkannte Server-Adressen + Adressen, über die sich ein Admin schon erfolgreich angemeldet hat.

const HOSTS_FILE = path.join(__dirname, 'data', 'admin-hosts.json');
const VALID_HOST = /^(\[[0-9a-f:]+\]|[a-z0-9.-]{1,253})(:\d{1,5})?$/i;

function loadKnownHosts() {
  try {
    if (fs.existsSync(HOSTS_FILE)) return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  } catch { /* ignorieren */ }
  return [];
}

function rememberHost(host) {
  if (!host || !VALID_HOST.test(host)) return;
  try {
    const hosts = [host, ...loadKnownHosts().filter(h => h !== host)].slice(0, 6);
    fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2));
  } catch (error) {
    console.error('Admin-Hosts speichern fehlgeschlagen:', error.message);
  }
}

function hostLabel(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isTailscaleIp(bare) || /\.ts\.net$/i.test(bare)) return 'Tailscale';
  if (isPrivateIp(bare)) return 'Heimnetz';
  if (net.isIP(bare)) return 'Netzwerk';
  return 'Gerätename';
}

/**
 * Links zum Admin-Bereich, Tailscale zuerst (funktioniert zuhause UND unterwegs).
 */
export function getAdminLinks() {
  const { detected } = getAccessRules();
  const links = [];
  const seen = new Set();
  const add = (host, label) => {
    const key = host.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ label, url: `http://${host}/admin` });
  };
  const fmt = (a) => (net.isIPv6(a) ? `[${a}]` : a);
  const order = { tailscale: 0, lan: 1 };
  detected.addresses
    .filter(a => !a.address.startsWith('fe80') && net.isIPv4(a.address)) // IPv4-Links sind am robustesten
    .sort((a, b) => order[a.kind] - order[b.kind])
    .forEach(a => add(`${fmt(a.address)}:${ADMIN_PORT}`, a.kind === 'tailscale' ? 'Tailscale' : 'Heimnetz'));
  for (const host of loadKnownHosts()) add(host, hostLabel(host.replace(/:\d+$/, '')));
  links.sort((a, b) => (a.label === 'Tailscale' ? 0 : 1) - (b.label === 'Tailscale' ? 0 : 1));
  return links;
}

// ============ ADMIN-SESSION ============

function issueAdminSession(res, account) {
  const token = signSession({ sub: account.id, sv: account.sessionVersion || 1, adm: 1 }, ADMIN_SESSION_MAX_AGE);
  res.setHeader('Set-Cookie', serializeCookie(ADMIN_COOKIE, token, {
    httpOnly: true, sameSite: 'Strict', secure: ADMIN_COOKIE_SECURE, path: '/', maxAge: ADMIN_SESSION_MAX_AGE
  }));
}

function clearAdminSession(res) {
  res.setHeader('Set-Cookie', serializeCookie(ADMIN_COOKIE, '', {
    httpOnly: true, sameSite: 'Strict', secure: ADMIN_COOKIE_SECURE, path: '/', maxAge: 0
  }));
}

function adminFromRequest(req) {
  const payload = verifySession(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
  if (!payload?.sub || payload.adm !== 1) return null; // normale App-Sessions zählen nicht
  const account = getAccount(payload.sub);
  if (!account || account.role !== 'admin') return null;
  if ((account.sessionVersion || 1) !== (payload.sv || 1)) return null;
  return account;
}

// Einfacher Brute-Force-Schutz für den Admin-Login
const loginAttempts = new Map();
function loginRateLimited(ip) {
  const now = Date.now();
  let e = loginAttempts.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + 15 * 60 * 1000 };
    loginAttempts.set(ip, e);
  }
  return ++e.count > 5;
}

// ============ DATEN-AUFBEREITUNG ============

function tokenStatus(accessToken, hasRefreshToken) {
  if (!accessToken) return { state: 'none', label: 'kein Token' };
  const info = getTokenInfo(accessToken);
  if (info?.isValid) return { state: 'valid', label: `gültig (${info.remainingText})`, expiresAt: info.expiresAt };
  if (hasRefreshToken) return { state: 'refreshable', label: 'abgelaufen, erneuerbar', expiresAt: info?.expiresAt };
  return { state: 'expired', label: 'abgelaufen', expiresAt: info?.expiresAt };
}

/**
 * @param {object} hooks  Zugriff auf In-Memory-Zustand aus server.js
 * @param {() => Array} hooks.getPollingJobs
 * @param {(jobId: string) => boolean} hooks.stopPollingJob
 * @param {() => number} hooks.getWsClientCount
 */
function buildSnapshot(hooks) {
  const accounts = listAccounts();
  const members = listUsersForAdmin();
  const membersById = new Map(members.map(m => [String(m.memberId), m]));
  const polling = hooks.getPollingJobs();
  const scheduled = getScheduledJobs(null);
  const padel = listSessions();

  const countBy = (arr, memberId) => arr.filter(j => String(j.memberId) === String(memberId)).length;

  const users = accounts.map(a => {
    const m = a.linkedMemberId != null ? membersById.get(String(a.linkedMemberId)) : null;
    return {
      ...a,
      member: m ? { memberId: m.memberId, name: m.name, email: m.email } : null,
      token: m ? tokenStatus(m.accessToken, m.hasRefreshToken) : null,
      pollingJobs: a.linkedMemberId != null ? countBy(polling, a.linkedMemberId) : 0,
      scheduledJobs: a.linkedMemberId != null
        ? scheduled.filter(j => String(j.memberId) === String(a.linkedMemberId) && j.status === 'pending').length
        : 0
    };
  });

  const linkedIds = new Set(accounts.map(a => String(a.linkedMemberId)));
  const orphanMembers = members
    .filter(m => !linkedIds.has(String(m.memberId)))
    .map(m => ({ memberId: m.memberId, name: m.name, email: m.email, token: tokenStatus(m.accessToken, m.hasRefreshToken), updatedAt: m.updatedAt }));

  const memberName = (id) => {
    const m = membersById.get(String(id));
    return m ? (m.name || m.email || String(id)) : (id == null ? '–' : String(id));
  };

  const mem = process.memoryUsage();
  const tokenStates = users.reduce((acc, u) => {
    if (u.token) acc[u.token.state] = (acc[u.token.state] || 0) + 1;
    return acc;
  }, {});

  return {
    overview: {
      accounts: accounts.length,
      admins: accounts.filter(a => a.role === 'admin').length,
      linkedAccounts: accounts.filter(a => a.linkedMemberId != null).length,
      hspMembers: members.length,
      tokenStates,
      pollingJobs: polling.length,
      scheduledPending: scheduled.filter(j => j.status === 'pending').length,
      scheduledRunning: scheduled.filter(j => j.status === 'running').length,
      padelActive: padel.filter(s => ['open', 'scheduled'].includes(s.status)).length,
      wsClients: hooks.getWsClientCount(),
      errorsInLog: logBuffer.filter(l => l.level === 'error').length
    },
    system: {
      uptimeSec: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      node: process.version,
      env: process.env.NODE_ENV || 'development',
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      loadAvg: os.loadavg().map(n => Math.round(n * 100) / 100),
      hostname: os.hostname(),
      publicUrl: process.env.PUBLIC_URL || null,
      allowList: getAccessRules().allowEntries,
      denyList: getAccessRules().denyEntries,
      allowListIsOverride: getAccessRules().isOverride,
      networkDetected: getAccessRules().detected.hostView,
      adminLinks: getAdminLinks()
    },
    users,
    orphanMembers,
    pollingJobs: polling.map(j => ({ ...j, memberName: memberName(j.memberId) })),
    scheduledJobs: scheduled.map(j => ({
      id: j.id,
      bookingId: j.bookingId,
      courseDescription: j.courseDescription,
      courseStartTime: j.courseStartTime,
      pollingStartAt: j.pollingStartAt,
      status: j.status,
      memberId: j.memberId,
      memberName: memberName(j.memberId),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt
    })),
    padelSessions: padel.map(s => ({
      id: s.id, startDate: s.startDate, status: s.status, statusLabel: s.statusLabel,
      statusMessage: s.statusMessage, participants: (s.participants || []).map(p => p.name || p.email),
      bookedByName: s.bookedByName
    }))
  };
}

// ============ SERVER ============

export function startAdminServer(hooks) {
  if (process.env.ADMIN_ENABLED === 'false') {
    console.log('🛡️  Admin-Bereich deaktiviert (ADMIN_ENABLED=false)');
    return null;
  }

  const app = express();
  // Bewusst KEIN 'trust proxy': der Admin-Port wird nie über einen Proxy angesprochen,
  // und X-Forwarded-For darf die IP-Prüfung nicht beeinflussen.
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    next();
  });

  // Schicht 2: IP-Allowlist – VOR allem anderen
  app.use((req, res, next) => {
    const ip = clientIp(req);
    if (isAllowed(ip)) return next();
    console.warn(`🚫 Admin-Zugriff abgelehnt von ${ip || 'unbekannt'} (${req.method} ${req.path})`);
    res.status(403).type('text/plain').send(
      `403 – Zugriff verweigert.\nDeine IP (${ip || 'unbekannt'}) steht nicht in ADMIN_ALLOWED_IPS.`
    );
  });

  app.use(express.json({ limit: '10kb' }));

  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
  app.use('/resources', express.static(path.join(__dirname, 'resources')));

  // CSRF-Schutz: alle schreibenden Requests brauchen den Custom-Header (Browser setzen ihn
  // cross-site nicht ohne CORS-Preflight) zusätzlich zum SameSite=Strict-Cookie.
  app.use('/admin/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Admin-Request') !== '1') {
      return res.status(403).json({ error: 'Ungültiger Request' });
    }
    next();
  });

  app.post('/admin/api/login', (req, res) => {
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
    }
    const { email, password } = req.body || {};
    const account = verifyLogin(email, password);
    if (!account || account.role !== 'admin') {
      console.warn(`🚫 Fehlgeschlagener Admin-Login von ${ip}`);
      return res.status(401).json({ error: 'Login fehlgeschlagen oder keine Admin-Rechte.' });
    }
    loginAttempts.delete(ip);
    issueAdminSession(res, account);
    rememberHost(req.headers.host); // damit die App später direkt hierher verlinken kann
    console.log(`🛡️  Admin-Login: ${account.email} von ${ip}`);
    res.json({ email: account.email });
  });

  app.post('/admin/api/logout', (req, res) => {
    clearAdminSession(res);
    res.json({ success: true });
  });

  // Ab hier: Admin-Session erforderlich
  app.use('/admin/api', (req, res, next) => {
    const admin = adminFromRequest(req);
    if (!admin) return res.status(401).json({ error: 'Nicht angemeldet', needLogin: true });
    req.admin = admin;
    next();
  });

  app.get('/admin/api/me', (req, res) => {
    res.json({
      id: req.admin.id, email: req.admin.email, ip: clientIp(req),
      // Rücksprung in die App: öffentliche URL, sonst gleicher Host auf dem App-Port
      appUrl: process.env.PUBLIC_URL || null,
      appPort: Number(process.env.PORT || 3003)
    });
  });

  app.get('/admin/api/snapshot', (req, res) => {
    try {
      res.json(buildSnapshot(hooks));
    } catch (error) {
      console.error('Admin-Snapshot fehlgeschlagen:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/admin/api/logs', (req, res) => {
    const since = req.query.since ? String(req.query.since) : null;
    res.json({ logs: since ? logBuffer.filter(l => l.ts > since) : logBuffer });
  });

  const audit = (req, what) => console.log(`🛡️  Admin ${req.admin.email}: ${what}`);

  app.post('/admin/api/users/:id/role', (req, res) => {
    try {
      const acc = setRole(req.params.id, req.body?.role);
      audit(req, `Rolle von ${acc.email} -> ${acc.role}`);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/admin/api/users/:id/logout-all', (req, res) => {
    const acc = bumpSessionVersion(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Account nicht gefunden.' });
    audit(req, `alle Sessions von ${acc.email} beendet`);
    res.json({ success: true });
  });

  app.delete('/admin/api/users/:id', (req, res) => {
    if (req.params.id === req.admin.id) {
      return res.status(400).json({ error: 'Du kannst deinen eigenen Account hier nicht löschen.' });
    }
    try {
      const acc = deleteAccount(req.params.id);
      audit(req, `Account ${acc.email} gelöscht`);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/admin/api/polling/:jobId', (req, res) => {
    if (!hooks.stopPollingJob(req.params.jobId)) return res.status(404).json({ error: 'Job nicht gefunden' });
    audit(req, `Platz-Überwachung ${req.params.jobId} gestoppt`);
    res.json({ success: true });
  });

  app.delete('/admin/api/schedule/:jobId', (req, res) => {
    const result = cancelScheduledJob(req.params.jobId);
    if (!result.success) return res.status(404).json({ error: result.error });
    audit(req, `geplante Buchung ${req.params.jobId} abgebrochen`);
    res.json({ success: true });
  });

  const server = createServer(app);
  server.listen(ADMIN_PORT, () => {
    const rules = getAccessRules();
    console.log(`🛡️  Admin-Bereich auf Port ${ADMIN_PORT} (/admin) – erlaubt: Heimnetz + Tailscale` +
      (rules.isOverride ? ` (manuell: ${rules.allowEntries.join(', ')})` : ''));
    const links = getAdminLinks();
    if (links.length) links.forEach(l => console.log(`   ${l.label}: ${l.url}`));
    else if (!rules.detected.hostView) {
      console.log('   Hinweis: Server-Adressen nicht erkennbar (Docker-Bridge). Mit network_mode: host ' +
        'erscheinen die Admin-Links automatisch in der App.');
    }
  });
  return server;
}
