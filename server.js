// server.js - Express Server mit WebSocket für HSP-Bot GUI

// Zuerst laden: der Admin-Bereich puffert ab hier die Konsolenausgaben
import { startAdminServer, getAdminLinks } from './admin.js';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Importiere die bestehenden Module
import { getTokenInfo, loadTokens } from './token-manager.js';
import {
  initializeScheduler,
  setWaitlistHandler,
  fetchParticipationStatus,
  startTokenKeepAlive,
  scheduleBooking,
  cancelScheduledJob,
  getScheduledJobs,
  jobBelongsToMember,
  registerWebSocket,
  getBookingInfo
} from './scheduler.js';
import {
  verifyAndUpsertUser, getUser, getUserByKey, getUserByCalendarToken,
  publicUser, getValidUserToken
} from './user-store.js';
import {
  registerAccount, verifyLogin, getAccount, changePassword,
  linkMember, bumpSessionVersion, publicAccount, recordLogin
} from './auth-store.js';
import {
  signSession, verifySession, parseCookies, serializeCookie,
  signState, randomToken
} from './crypto-util.js';
import {
  SSO_PROVIDERS, getProvider, buildSsoRedirect, parseTokenResponse
} from './sso.js';
import {
  initializePadel,
  registerPadelWebSocket,
  getPadelRules,
  getDaySlots,
  listSessions,
  createSession,
  joinSession,
  leaveSession,
  cancelSession,
  retrySession,
  getCalendarFeed,
  getSessionIcs,
  refreshPadelEligibilityFor
} from './padel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3003;
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';
const Volleyball_ID = 285;

// Hinter dem Reverse Proxy (Nginx Proxy Manager) steht HTTPS – trust proxy sorgt dafür,
// dass req.protocol/req.secure den X-Forwarded-Proto-Header auswerten.
app.set('trust proxy', 1);

const NODE_ENV = process.env.NODE_ENV || 'development';
// Secure-Cookies in Produktion (nur über HTTPS). Lokal ohne HTTPS abschaltbar.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : NODE_ENV === 'production';
const SESSION_COOKIE = 'hsp_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage

// Middleware
app.use(express.json());

// Frontend single-origin ausliefern – NUR index.html + resources/,
// niemals Server-Code, data/ oder andere Projektdateien.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/resources', express.static(path.join(__dirname, 'resources')));

// Basis-Sicherheitsheader
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'"
  );
  next();
});

// ============ SESSION / AUTH HELPERS ============

function issueSession(res, account) {
  recordLogin(account.id);
  const token = signSession({ sub: account.id, sv: account.sessionVersion || 1 }, SESSION_MAX_AGE);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: COOKIE_SECURE, path: '/', maxAge: SESSION_MAX_AGE
  }));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'Lax', secure: COOKIE_SECURE, path: '/', maxAge: 0
  }));
}

/**
 * Liest die Session aus dem Cookie und hängt req.account an (falls gültig).
 */
function attachAccount(req) {
  if (req._accountResolved) return req.account;
  req._accountResolved = true;
  req.account = null;
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySession(cookies[SESSION_COOKIE]);
  if (!payload?.sub) return null;
  const account = getAccount(payload.sub);
  if (!account) return null;
  // Session-Version prüfen (Passwortwechsel / "überall abmelden")
  if ((account.sessionVersion || 1) !== (payload.sv || 1)) return null;
  req.account = account;
  return account;
}

// Öffentliche API-Pfade (relativ zum /api-Mount), alles andere erfordert Login.
const PUBLIC_API = [
  /^\/auth\/(register|login|logout|me)$/,
  /^\/sso\/providers$/,
  /^\/padel\/calendar\//
];

app.use('/api', (req, res, next) => {
  attachAccount(req);
  if (PUBLIC_API.some(rx => rx.test(req.path))) return next();
  if (!req.account) {
    return res.status(401).json({ error: 'Nicht angemeldet', needLogin: true });
  }
  next();
});

// ============ HSP-TOKEN PRO ACCOUNT ============

/**
 * Gültiger HSP-Access-Token des eingeloggten Accounts (null, wenn nicht verknüpft).
 */
async function resolveHspToken(req) {
  const memberId = req.account?.linkedMemberId;
  if (!memberId) return null;
  return await getValidUserToken(memberId);
}

/**
 * Member-Infos des verknüpften HSP-Accounts.
 */
function resolveHspMember(req) {
  const memberId = req.account?.linkedMemberId;
  if (!memberId) return { memberId: null, memberEmail: null, memberName: null };
  const u = getUser(memberId);
  return u
    ? { memberId: u.memberId, memberEmail: u.email, memberName: u.name }
    : { memberId, memberEmail: null, memberName: null };
}

// Aktive Polling-Jobs speichern
const activePollingJobs = new Map();

// WebSocket connections for polling broadcasts
const pollingWsConnections = new Set();

// Max log entries to buffer per job (for reconnecting clients)
const MAX_JOB_LOG_ENTRIES = 50;

// Polling jobs persistence file
const POLLING_JOBS_FILE = path.join(__dirname, 'data', 'polling-jobs.json');

// ============ POLLING PERSISTENCE ============

function loadPollingJobs() {
  try {
    if (fs.existsSync(POLLING_JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(POLLING_JOBS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading polling jobs:', error);
  }
  return [];
}

function savePollingJobs() {
  try {
    const dataDir = path.dirname(POLLING_JOBS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const jobs = [];
    activePollingJobs.forEach((job, id) => {
      jobs.push({
        id,
        bookingId: job.bookingId,
        intervalSeconds: job.intervalSeconds,
        maxAttempts: job.maxAttempts,
        attempts: job.attempts,
        startedAt: job.startedAt,
        lastAttempt: job.lastAttempt,
        memberId: job.memberId,
        title: job.title || null,
        courseStart: job.courseStart || null
      });
    });
    fs.writeFileSync(POLLING_JOBS_FILE, JSON.stringify(jobs, null, 2));
  } catch (error) {
    console.error('Error saving polling jobs:', error);
  }
}

/**
 * Broadcast a message to all connected WebSocket clients (polling-specific)
 */
function broadcastPolling(message, memberId = null) {
  const messageStr = JSON.stringify(message);
  pollingWsConnections.forEach(ws => {
    if (ws.readyState !== 1) return; // WebSocket.OPEN
    // Nur an den Besitzer des Jobs senden (wenn memberId bekannt)
    if (memberId != null && ws.account?.linkedMemberId !== memberId) return;
    ws.send(messageStr);
  });
}

/**
 * Send a polling message: broadcast to the owning client + buffer in job log
 */
function sendJobMessage(jobId, job, message) {
  if (message.message) job.lastMessage = message.message;
  // Buffer the message in the job's log
  if (!job.log) job.log = [];
  job.log.push({ ...message, timestamp: new Date().toISOString() });
  if (job.log.length > MAX_JOB_LOG_ENTRIES) {
    job.log = job.log.slice(-MAX_JOB_LOG_ENTRIES);
  }
  // Nur an den Besitzer des Jobs broadcasten
  broadcastPolling(message, job.memberId);
}

// ============ AUTH ENDPOINTS (App-Login) ============

// Einfacher In-Memory-Ratelimiter gegen Brute-Force (pro IP)
const loginAttempts = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, { max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > max) {
    res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
    return false;
  }
  return true;
}

// Registrierung (offen) – legt Account an und loggt direkt ein
app.post('/api/auth/register', (req, res) => {
  if (!rateLimit(req, res, { max: 20 })) return;
  try {
    const { email, password } = req.body || {};
    const account = registerAccount(email, password);
    issueSession(res, account);
    res.json({ account: publicAccount(account) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  if (!rateLimit(req, res)) return;
  const { email, password } = req.body || {};
  const account = verifyLogin(email, password);
  if (!account) {
    return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });
  }
  issueSession(res, account);
  res.json({ account: publicAccount(account) });
});

// Logout (aktuelles Gerät)
app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ success: true });
});

// Überall abmelden (invalidiert alle Sessions dieses Accounts)
app.post('/api/auth/logout-all', (req, res) => {
  bumpSessionVersion(req.account.id);
  clearSession(res);
  res.json({ success: true });
});

// Passwort ändern
app.post('/api/auth/change-password', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyLogin(req.account.email, currentPassword)) {
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch.' });
    }
    const updated = changePassword(req.account.id, newPassword);
    issueSession(res, updated); // neue Session-Version -> frisches Cookie
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Aktueller Account + HSP-Verknüpfung
app.get('/api/auth/me', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Nicht angemeldet', needLogin: true });
  const member = resolveHspMember(req);
  const linkedUser = req.account.linkedMemberId ? getUser(req.account.linkedMemberId) : null;
  let tokenInfo = null;
  if (linkedUser?.accessToken) {
    const info = getTokenInfo(linkedUser.accessToken);
    if (info) {
      tokenInfo = {
        email: info.email, name: info.name, expiresAt: info.expiresAt,
        remainingText: info.remainingText, isValid: info.isValid,
        canRefresh: !!linkedUser.refreshToken
      };
    }
  }
  res.json({
    account: publicAccount(req.account),
    // Admins bekommen die Adressen des Admin-Bereichs (nur im Heimnetz/Tailscale erreichbar)
    adminLinks: req.account.role === 'admin' ? getAdminLinks() : undefined,
    hspLinked: !!req.account.linkedMemberId,
    member: member.memberId ? member : null,
    tokenInfo
  });
});

// ============ SSO (Uni-Login) ============

app.get('/api/sso/providers', (req, res) => {
  res.json({ providers: SSO_PROVIDERS.map(p => ({ id: p.id, name: p.name })) });
});

function publicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Startet den SSO-Flow: leitet zum delcom-SAML-Discovery weiter.
// Ein signierter, an den App-Account gebundener state steckt im Pfad der Callback-URL
// (delcom hängt nur ?tokenReponse= an). Ohne gültigen state wird kein Callback akzeptiert
// -> schützt vor Login-CSRF (fremder Link verknüpft fremden HSP-Account mit deinem Account).
app.get('/api/sso/start', (req, res) => {
  const provider = getProvider(String(req.query.provider || ''));
  if (!provider) return res.status(400).send('Unbekannter SSO-Anbieter');
  const state = signState({ acct: req.account.id, n: randomToken(8) }, 15 * 60);
  const callbackUrl = `${publicBaseUrl(req)}/api/sso/callback/${encodeURIComponent(state)}`;
  res.redirect(buildSsoRedirect(provider.entityId, callbackUrl));
});

// Bereits eingelöste SSO-States (nonce -> Ablauf in ms). Jeder state ist nur EINMAL gültig.
// In-Memory genügt: nach einem Neustart sind höchstens 15 Min. alte States betroffen,
// und die sind ohnehin an den eigenen Account gebunden.
const usedSsoNonces = new Map();
function consumeSsoNonce(nonce, expSeconds) {
  const now = Date.now();
  for (const [n, exp] of usedSsoNonces) if (exp < now) usedSsoNonces.delete(n);
  if (!nonce || usedSsoNonces.has(nonce)) return false;
  usedSsoNonces.set(nonce, (expSeconds || 0) * 1000 || now + 15 * 60 * 1000);
  return true;
}

// Feste Fehlercodes für den Rücksprung – die URL transportiert nie freien Text,
// damit niemand per präpariertem Link beliebige Meldungen in der App anzeigen kann.
class SsoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Rückkehr vom SSO: delcom hängt ?tokenReponse=<base64> an
app.get('/api/sso/callback/:state', async (req, res) => {
  try {
    const payload = verifySession(req.params.state);
    const st = payload?.st;
    if (!st || st.acct !== req.account.id) {
      throw new SsoError('state', 'Ungültiger oder abgelaufener SSO-State');
    }
    if (!consumeSsoNonce(st.n, payload.exp)) {
      throw new SsoError('state', 'SSO-State wurde bereits verwendet');
    }

    let tokens;
    try {
      tokens = parseTokenResponse(req.query.tokenReponse);
    } catch {
      throw new SsoError('no_token', 'tokenReponse fehlt oder ist nicht lesbar');
    }
    if (!tokens.accessToken) throw new SsoError('no_token', 'Kein Access-Token erhalten');

    // Tokens bei delcom verifizieren; memberId stammt aus dem frisch ausgestellten Token
    let user;
    try {
      user = await verifyAndUpsertUser(tokens);
    } catch (error) {
      throw new SsoError('verify', error.message);
    }
    linkMember(req.account.id, user.memberId);
    refreshPadelEligibilityFor(user.memberId); // fresh token may make padel bookings possible again
    res.redirect('/?linked=1');
  } catch (error) {
    console.error('SSO-Callback Fehler:', error.message);
    const code = error instanceof SsoError ? error.code : 'unknown';
    res.redirect('/?sso_error=' + code);
  }
});

// ============ API ENDPOINTS ============

// Status-Check (account-zentriert)
app.get('/api/status', (req, res) => {
  const member = resolveHspMember(req);
  const linkedUser = req.account.linkedMemberId ? getUser(req.account.linkedMemberId) : null;
  let tokenInfo = null;
  if (linkedUser?.accessToken) {
    const info = getTokenInfo(linkedUser.accessToken);
    if (info) {
      tokenInfo = {
        email: info.email, name: info.name, expiresAt: info.expiresAt,
        remainingText: info.remainingText, isValid: info.isValid
      };
    }
  }
  res.json({
    authenticated: !!req.account.linkedMemberId,
    account: publicAccount(req.account),
    member: member.memberId ? member : null,
    tokenInfo,
    activeJobs: activePollingJobs.size
  });
});

// Get locations data
app.get('/api/locations', (req, res) => {
  try {
    const locationsPath = path.join(__dirname, 'locations.json');
    if (!fs.existsSync(locationsPath)) {
      return res.status(404).json({ error: 'Locations data not found' });
    }
    const locations = JSON.parse(fs.readFileSync(locationsPath, 'utf8'));
    res.json(locations);
  } catch (error) {
    console.error('Error loading locations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Bereinigt importierte delcom_auth-Daten (doppelt escapte Strings, internes Flag)
 */
function normalizeAuthData(body) {
  let authData = body;

  if (!authData._skipServerFix) {
    // Korrigiere doppelt escapte Strings (z.B. im userAgents-Feld)
    const jsonStr = JSON.stringify(authData);
    const fixedStr = jsonStr.replace(/\\\\/g, '\\').replace(/\\"\[/g, '[').replace(/\]\\"(,|})/g, ']$1');
    try {
      authData = JSON.parse(fixedStr);
    } catch {
      // Falls Korrektur fehlschlägt, nutze Original
    }
  }

  // Bereinige das interne Flag
  if (authData._skipServerFix !== undefined) delete authData._skipServerFix;
  return authData;
}

// HSP-Account per eingefügten delcom_auth-Daten verknüpfen (Fallback zum SSO)
app.post('/api/auth/import', async (req, res) => {
  try {
    const authData = normalizeAuthData(req.body);

    if (!authData || !authData.tokenResponse || !authData.member) {
      return res.status(400).json({ error: 'Ungültige Auth-Daten. Bitte kompletten JSON-Inhalt einfügen.' });
    }

    // Token bei delcom verifizieren, verschlüsselt ablegen und mit dem App-Account verknüpfen
    const user = await verifyAndUpsertUser(authData.tokenResponse);
    linkMember(req.account.id, user.memberId);
    refreshPadelEligibilityFor(user.memberId); // fresh token may make padel bookings possible again

    res.json({
      success: true,
      member: {
        id: user.memberId,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Auth-Import Fehler:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Sportarten abrufen
app.get('/api/sports', async (req, res) => {
  try {
    const filter = {
      allowAsLinkedProduct: true,
      isActive: 1
    };
    const encoded = encodeURIComponent(JSON.stringify(filter));
    const url = `${API_URL}/products?s=${encoded}&limit=1000&sort=description,ASC`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`API Fehler: ${response.status}`);
    }

    const data = await response.json();
    const sports = data.data || [];
    
    res.json(sports.map(s => ({
      id: s.id,
      name: s.description
    })));
  } catch (error) {
    console.error('Sportarten laden Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// Kurse suchen
app.get('/api/courses', async (req, res) => {
  try {
    const { level, minAvailable } = req.query;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 8, 0), 60);

    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setDate(end.getDate() + days);
    end.setHours(23, 59, 59, 999);

    // sportIds=1,2,3 (mehrere Produkte mit gleichem Namen) oder legacy sportId=1
    const rawIds = String(req.query.sportIds || req.query.sportId || '')
      .split(',')
      .map(v => parseInt(v, 10))
      .filter(Number.isInteger);
    const linkedProductIds = rawIds.length ? [...new Set(rawIds)].slice(0, 20) : [Volleyball_ID];

    const filter = {
      startDate: { "$gte": start.toISOString(), "$lte": end.toISOString() },
      linkedProductId: { "$in": linkedProductIds },
      status: { "$ne": 2 }
    };

    const encoded = encodeURIComponent(JSON.stringify(filter));
    // Alle Seiten laden statt nach 100 Einträgen abzuschneiden (max. 5 Seiten)
    let courses = [];
    for (let page = 1; page <= 5; page++) {
      const response = await fetch(`${API_URL}/bookings?s=${encoded}&limit=100&page=${page}&sort=startDate,ASC`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`API Fehler: ${response.status}`);
      }
      const data = await response.json();
      courses.push(...(data.data || []));
      if (!data.pageCount || page >= data.pageCount) break;
    }

    // Level Filter
    if (level) {
      const levelInt = parseInt(level);
      courses = courses.filter(c => {
        const match = c.description?.match(/Level\s+(\d+)/i);
        return match && parseInt(match[1]) === levelInt;
      });
    }

    // Min Available Filter
    if (minAvailable) {
      const minInt = parseInt(minAvailable);
      courses = courses.filter(c => c.availableParticipantCount >= minInt);
    }

    // Filter out past courses
    const now = new Date();
    courses = courses.filter(c => new Date(c.startDate) > now);

    // Get user's existing bookings to check participation status
    let userBookings = {};
    const memberInfo = resolveHspMember(req);
    const token = memberInfo.memberId ? await resolveHspToken(req) : null;
    if (token && memberInfo.memberId && courses.length > 0) {
      try {
        const bookingFilter = {
          "$or": [
            { "participations.memberId": memberInfo.memberId },
            { "participations.invitedMemberId": memberInfo.memberId }
          ],
          "startDate": { "$gte": now.toISOString() }
        };
        const encoded = encodeURIComponent(JSON.stringify(bookingFilter));
        const userBookingsUrl = `${API_URL}/bookings?s=${encoded}&join=participations&limit=100&page=1&sort=startDate,ASC`;
        
        const userBookingsRes = await fetch(userBookingsUrl, {
          method: 'GET',
          headers: { 
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (userBookingsRes.ok) {
          const userBookingsData = await userBookingsRes.json();
          userBookingsData.data?.forEach(booking => {
            const participation = booking.participations?.find(p => 
              p.memberId === memberInfo.memberId || p.invitedMemberId === memberInfo.memberId
            );
            if (participation) {
              userBookings[booking.id] = {
                participationStatus: participation.status, // 1 = booked, 3 = waiting list
                participationId: participation.id
              };
            }
          });
        }
      } catch (error) {
        console.error('Fehler beim Laden der User-Bookings:', error);
      }
    }

    const formatted = await formatCourses(courses, userBookings);
    res.json({ courses: formatted, total: formatted.length });
  } catch (error) {
    console.error('Kurse laden Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// Eigene Buchungen (kommende + letzte 30 Tage)
app.get('/api/my-bookings', async (req, res) => {
  try {
    const memberInfo = resolveHspMember(req);
    const token = await resolveHspToken(req);
    if (!token || !memberInfo.memberId) {
      return res.status(401).json({ error: 'HSP-Account nicht verknüpft. Bitte via Uni-SSO anmelden oder Token importieren.' });
    }

    const from = new Date();
    from.setDate(from.getDate() - 30);
    from.setHours(0, 0, 0, 0);

    const filter = {
      'participations.memberId': memberInfo.memberId,
      startDate: { '$gte': from.toISOString() }
    };
    const encoded = encodeURIComponent(JSON.stringify(filter));
    const response = await fetch(`${API_URL}/bookings?s=${encoded}&join=participations&limit=100&page=1&sort=startDate,ASC`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`API Fehler: ${response.status}`);
    }

    const data = await response.json();
    const bookings = data.data || [];
    const userBookings = {};
    bookings.forEach(booking => {
      const participation = booking.participations?.find(p => p.memberId === memberInfo.memberId);
      if (participation) {
        userBookings[booking.id] = {
          participationStatus: participation.status, // 1 = booked, 3 = waiting list
          participationId: participation.id
        };
      }
    });

    const formatted = await formatCourses(bookings.filter(b => userBookings[b.id]), userBookings);
    res.json({ bookings: formatted, total: formatted.length });
  } catch (error) {
    console.error('Eigene Buchungen laden Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Ergänzt rohe HSP-Bookings um Trainer, Ort und Kurstitel und bringt sie ins Frontend-Format
 */
async function formatCourses(courses, userBookings = {}) {
  // Fetch supervisor names
  let supervisorNames = {};
  if (courses.length > 0) {
    try {
      const bookingIds = courses.map(c => c.id).join(',');
      const supervisorUrl = `${API_URL}/bookings/query/supervisorNamesByBookingId?bookingIds=${bookingIds}`;
      const supervisorRes = await fetch(supervisorUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (supervisorRes.ok) {
        supervisorNames = await supervisorRes.json();
      }
    } catch (error) {
      console.error('Fehler beim Laden der Supervisor-Namen:', error);
    }
  }

  // Fetch location names from products
  let locationNames = {};
  let productLocationIds = {};
  if (courses.length > 0) {
    try {
      const productIds = [...new Set(courses.map(c => c.productId).filter(id => id))];
      if (productIds.length > 0) {
        const filter = { id: { "$in": productIds } };
        const encoded = encodeURIComponent(JSON.stringify(filter));
        const productsUrl = `${API_URL}/products?s=${encoded}`;
        const productsRes = await fetch(productsUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (productsRes.ok) {
          const productsData = await productsRes.json();
          productsData.data?.forEach(product => {
            locationNames[product.id] = product.description;
            if (product.locationId) {
              productLocationIds[product.id] = product.locationId;
            }
          });
        }
      }
    } catch (error) {
      console.error('Fehler beim Laden der Locations:', error);
    }
  }

  // Load course titles from products.json using linkedProductId
  let courseTitles = {};
  try {
    const productsPath = path.join(__dirname, 'products.json');
    if (fs.existsSync(productsPath)) {
      const productsData = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
      courseTitles = Object.keys(productsData).reduce((acc, key) => {
        acc[key] = productsData[key].description;
        return acc;
      }, {});
    } else {
      console.warn('products.json not found. Run fetch-products.js to create it.');
    }
  } catch (error) {
    console.error('Fehler beim Laden von products.json:', error);
  }

  // Format für Frontend
  return courses.map(c => ({
    id: c.id,
    description: courseTitles[c.linkedProductId] || c.description,
    level: c.description,
    startDate: c.startDate,
    endDate: c.endDate,
    location: locationNames[c.productId] || c.location || 'Unbekannt',
    locationId: productLocationIds[c.productId] || null,
    available: c.availableParticipantCount,
    maxParticipants: c.maxParticipantCount,
    status: c.status,
    supervisors: supervisorNames[c.id] || [],
    userParticipation: userBookings[c.id] || null // null, { participationStatus: 1 } (booked), or { participationStatus: 3 } (waiting)
  }));
}

// Einmalige Anmeldung
app.post('/api/register', async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'bookingId erforderlich' });
    }

    const token = await resolveHspToken(req);
    if (!token) {
      return res.status(401).json({ error: 'HSP-Account nicht verknüpft. Bitte via Uni-SSO anmelden oder Token importieren.' });
    }

    const memberInfo = resolveHspMember(req);
    if (!memberInfo.memberId) {
      return res.status(401).json({ error: 'Keine Member-ID gefunden.' });
    }

    const payload = {
      memberId: memberInfo.memberId,
      bookingId: parseInt(bookingId),
      organizationId: null
    };

    const response = await fetch(`${API_URL}/participations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { message: responseText };
    }

    if (response.status === 201) {
      // Prüfe ob Warteliste oder echte Anmeldung anhand status-Feld
      // status: 1 = Angemeldet, status: 3 = Warteliste
      const isWaitlist = responseData.status === 3;

      // Auf der Warteliste: frei werdende Plätze automatisch überwachen
      let watchJobId = null;
      if (isWaitlist) {
        const { title, courseStart } = req.body;
        watchJobId = startWaitlistWatch(bookingId, memberInfo.memberId, { title, courseStart }).jobId;
      }

      res.json({
        success: !isWaitlist,
        isWaitlist: isWaitlist,
        watchJobId,
        message: isWaitlist ? 'Auf Warteliste gesetzt - Platz-Überwachung aktiv' : 'Erfolgreich angemeldet!',
        participationStatus: responseData.status,
        data: responseData,
        fullResponse: responseData
      });
    } else if (response.status === 403) {
      res.json({
        success: false,
        message: responseData.message || 'Bereits angemeldet oder nicht erlaubt',
        status: 403,
        fullResponse: responseData
      });
    } else {
      res.json({
        success: false,
        message: responseData.message || 'Anmeldung fehlgeschlagen',
        status: response.status,
        fullResponse: responseData
      });
    }
  } catch (error) {
    console.error('Anmeldung Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// Platz-Überwachung für einen Kurs starten (z.B. für einen bestehenden Wartelisten-Eintrag)
app.post('/api/watch', async (req, res) => {
  const { bookingId, title, courseStart } = req.body;
  if (!bookingId) {
    return res.status(400).json({ error: 'bookingId erforderlich' });
  }
  const { memberId } = resolveHspMember(req);
  if (!memberId) {
    return res.status(401).json({ error: 'HSP-Account nicht verknüpft. Bitte via Uni-SSO anmelden oder Token importieren.' });
  }
  if (!(await getValidUserToken(memberId))) {
    return res.status(401).json({ error: 'Kein gültiger HSP-Token (bitte neu anmelden)' });
  }
  const result = startWaitlistWatch(bookingId, memberId, { title, courseStart });
  res.json({ success: true, ...result });
});

// Platz-Überwachung stoppen (nur eigene)
app.delete('/api/watch/:jobId', (req, res) => {
  const { memberId } = resolveHspMember(req);
  if (!memberId) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  const result = stopWatchJob(req.params.jobId, memberId);
  if (result === 'forbidden') return res.status(403).json({ error: 'Nicht berechtigt für diesen Job' });
  if (result === 'notFound') return res.status(404).json({ error: 'Job nicht gefunden' });
  res.json({ success: true });
});

// Laufende Platz-Überwachungen abrufen (nur eigene)
app.get('/api/jobs', (req, res) => {
  const { memberId } = resolveHspMember(req);
  if (!memberId) return res.json({ jobs: [] });
  const jobs = [];
  activePollingJobs.forEach((job, id) => {
    if (job.memberId !== memberId) return;
    jobs.push({
      id,
      bookingId: job.bookingId,
      title: job.title,
      courseStart: job.courseStart,
      attempts: job.attempts,
      startedAt: job.startedAt,
      lastAttempt: job.lastAttempt,
      lastMessage: job.lastMessage
    });
  });
  res.json({ jobs });
});

// ============ SCHEDULING ENDPOINTS ============

// Get booking availability info for a course
app.get('/api/schedule/info', async (req, res) => {
  const { courseStartTime, bookingId } = req.query;
  
  if (!courseStartTime) {
    return res.status(400).json({ error: 'courseStartTime erforderlich' });
  }
  
  try {
    const info = await getBookingInfo(courseStartTime, bookingId);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule a booking
app.post('/api/schedule', async (req, res) => {
  const { bookingId, courseStartTime, courseDescription } = req.body;
  
  if (!bookingId || !courseStartTime) {
    return res.status(400).json({ error: 'bookingId und courseStartTime erforderlich' });
  }
  
  const memberInfo = resolveHspMember(req);
  if (!memberInfo.memberId) {
    return res.status(401).json({ error: 'HSP-Account nicht verknüpft. Bitte via Uni-SSO anmelden oder Token importieren.' });
  }

  const result = await scheduleBooking(bookingId, courseStartTime, courseDescription, memberInfo.memberId);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Get all scheduled jobs (nur eigene)
app.get('/api/schedule', (req, res) => {
  const { memberId } = resolveHspMember(req);
  const jobs = getScheduledJobs(memberId);
  res.json({ jobs });
});

// Cancel a scheduled job (nur eigene)
app.delete('/api/schedule/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { memberId } = resolveHspMember(req);

  if (!jobBelongsToMember(jobId, memberId)) {
    return res.status(403).json({ error: 'Nicht berechtigt für diesen Job' });
  }

  const result = cancelScheduledJob(jobId);
  
  if (result.success) {
    res.json({ success: true, message: 'Geplante Buchung abgebrochen' });
  } else {
    res.status(404).json({ error: result.error });
  }
});

// ============ PADEL ENDPOINTS ============

// Spieler werden über die App-Session (verknüpfter HSP-Account) identifiziert.
// Fallback: expliziter x-user-key (Altpfad, für Kalender-Clients ohne Session).
function requireUser(req, res, next) {
  if (req.account?.linkedMemberId) {
    const linked = getUser(req.account.linkedMemberId);
    if (linked) {
      req.user = linked;
      return next();
    }
  }
  const user = getUserByKey(req.get('x-user-key'));
  if (!user) {
    return res.status(401).json({ error: 'Bitte zuerst deinen HSP-Account via Uni-SSO verknüpfen' });
  }
  req.user = user;
  next();
}

function sendPadelResult(res, result) {
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
}

app.post('/api/padel/login', async (req, res) => {
  const authData = normalizeAuthData(req.body);
  if (!authData?.tokenResponse?.accessToken || !authData.member?.id) {
    return res.status(400).json({ error: 'Ungültige Auth-Daten. Bitte kompletten JSON-Inhalt einfügen.' });
  }

  let user;
  try {
    user = await verifyAndUpsertUser(authData.tokenResponse);
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
  linkMember(req.account.id, user.memberId); // zugleich mit dem App-Account verknüpfen
  refreshPadelEligibilityFor(user.memberId);
  res.json({ userKey: user.userKey, user: publicUser(user), calendarToken: user.calendarToken });
});

// Nutzt den bereits verknüpften HSP-Account dieses App-Logins
app.post('/api/padel/login-main', (req, res) => {
  const user = req.account.linkedMemberId ? getUser(req.account.linkedMemberId) : null;
  if (!user) {
    return res.status(400).json({ error: 'Kein HSP-Account verknüpft. Bitte via Uni-SSO anmelden.' });
  }
  res.json({ userKey: user.userKey, user: publicUser(user), calendarToken: user.calendarToken });
});

app.get('/api/padel/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user), calendarToken: req.user.calendarToken, rules: getPadelRules() });
});

app.get('/api/padel/slots', requireUser, async (req, res) => {
  try {
    res.json({ slots: await getDaySlots(String(req.query.date || '')) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/padel/sessions', requireUser, (req, res) => {
  res.json({ sessions: listSessions() });
});

app.post('/api/padel/sessions', requireUser, (req, res) => {
  sendPadelResult(res, createSession(req.user, req.body.startDate));
});

app.post('/api/padel/sessions/:id/join', requireUser, (req, res) => {
  sendPadelResult(res, joinSession(req.user, req.params.id));
});

app.post('/api/padel/sessions/:id/leave', requireUser, (req, res) => {
  sendPadelResult(res, leaveSession(req.user, req.params.id));
});

app.post('/api/padel/sessions/:id/retry', requireUser, (req, res) => {
  sendPadelResult(res, retrySession(req.user, req.params.id));
});

app.delete('/api/padel/sessions/:id', requireUser, (req, res) => {
  sendPadelResult(res, cancelSession(req.user, req.params.id));
});

// Calendar endpoints are authenticated by the secret calendar token in the URL,
// because calendar apps (webcal subscriptions, .ics links on phones) can't send headers
app.get('/api/padel/calendar/:calendarToken.ics', (req, res) => {
  const user = getUserByCalendarToken(req.params.calendarToken);
  if (!user) return res.status(404).send('Kalender nicht gefunden');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="padel.ics"');
  res.send(getCalendarFeed(user));
});

app.get('/api/padel/calendar/:calendarToken/:sessionId.ics', (req, res) => {
  const user = getUserByCalendarToken(req.params.calendarToken);
  const ics = user && getSessionIcs(user, req.params.sessionId);
  if (!ics) return res.status(404).send('Termin nicht gefunden');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="padel.ics"');
  res.send(ics);
});

// ============ WEBSOCKET ============

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket Client verbunden');

  // WebSocket über das Session-Cookie authentifizieren
  try {
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifySession(cookies[SESSION_COOKIE]);
    const account = payload?.sub ? getAccount(payload.sub) : null;
    if (account && (account.sessionVersion || 1) === (payload.sv || 1)) {
      ws.account = account;
    }
  } catch { /* nicht authentifiziert -> ws.account bleibt undefined */ }

  // Register WebSocket for scheduler broadcasts
  registerWebSocket(ws);
  registerPadelWebSocket(ws);

  // Register for polling broadcasts
  pollingWsConnections.add(ws);

  // Der Kanal ist nur noch Server -> Client (Jobs werden per HTTP gestartet/gestoppt)
  ws.on('close', () => {
    console.log('🔌 WebSocket Client getrennt');
    pollingWsConnections.delete(ws);
  });
});

// ============ PLATZ-ÜBERWACHUNG (gemeinsamer Watcher) ============
//
// Die HSP-API bietet keinen Push-Kanal. Statt pro Job im Sekundentakt eine Anmeldung zu
// versuchen (authentifizierter POST), fragt EIN Watcher die freien Plätze aller beobachteten
// Kurse mit einem einzigen öffentlichen GET ab. Angemeldet wird nur, wenn wirklich ein Platz frei ist.

const WATCH_TICK_MS = 1000;
// Untergrenze für das Prüfintervall eines Jobs
const MIN_CHECK_INTERVAL_MS = 1000;
// Pause nach einem fehlgeschlagenen Anmeldeversuch trotz freiem Platz
const POST_COOLDOWN_MS = 5 * 1000;
// Pause für alle Jobs, wenn die Abfrage selbst ins Rate-Limit läuft
const WATCH_RATE_LIMIT_PAUSE_MS = 15 * 1000;
// Prüfintervall für Jobs, die der Planen-Modus nach einer Wartelisten-Platzierung übergibt
const HANDOVER_CHECK_INTERVAL_MS = 2000;

let watcherTimer = null;
let watcherBusy = false;

function ensureWatcher() {
  if (!watcherTimer) {
    watcherTimer = setInterval(watchTick, WATCH_TICK_MS);
  }
}

function stopWatcherIfIdle() {
  if (watcherTimer && activePollingJobs.size === 0) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

/**
 * Start a polling job (decoupled from WebSocket — works even without connected clients)
 */
function startPollingJob(jobId, bookingId, intervalSeconds, maxAttempts, memberId, meta = {}) {
  const job = {
    bookingId,
    title: meta.title || null,
    courseStart: meta.courseStart || null,
    lastMessage: null,
    intervalSeconds, // historischer Name - der Wert ist in Millisekunden
    maxAttempts: maxAttempts || null,
    attempts: 0,
    startedAt: new Date().toISOString(),
    lastAttempt: null,
    memberId,
    log: [],
    nextCheckAt: 0,
    postCooldownUntil: 0
  };

  activePollingJobs.set(jobId, job);
  savePollingJobs();

  sendJobMessage(jobId, job, {
    type: 'jobStarted',
    jobId,
    bookingId,
    title: job.title,
    courseStart: job.courseStart,
    intervalSeconds,
    maxAttempts: maxAttempts || 'unbegrenzt'
  });

  ensureWatcher();
  // Erste Prüfung sofort
  watchTick();
}

/**
 * Platz-Überwachung für einen Wartelisten-Kurs starten (ohne Duplikate pro Nutzer + Kurs).
 * @returns {{ jobId: string, created: boolean }}
 */
function startWaitlistWatch(bookingId, memberId, meta = {}) {
  const existing = [...activePollingJobs.entries()].find(([, j]) =>
    String(j.bookingId) === String(bookingId) && j.memberId === memberId);
  if (existing) {
    const [jobId, job] = existing;
    if (!job.title && meta.title) job.title = meta.title;
    if (!job.courseStart && meta.courseStart) job.courseStart = meta.courseStart;
    return { jobId, created: false };
  }
  const jobId = `${bookingId}-${Date.now()}`;
  startPollingJob(jobId, bookingId, HANDOVER_CHECK_INTERVAL_MS, null, memberId, meta);
  return { jobId, created: true };
}

/**
 * Platz-Überwachung stoppen. Mit memberId nur eigene Jobs.
 * @returns {'ok' | 'notFound' | 'forbidden'}
 */
function stopWatchJob(jobId, memberId = null) {
  const job = activePollingJobs.get(jobId);
  if (!job) return 'notFound';
  if (memberId != null && job.memberId !== memberId) return 'forbidden';
  sendJobMessage(jobId, job, { type: 'jobStopped', jobId, totalAttempts: job.attempts });
  activePollingJobs.delete(jobId);
  savePollingJobs();
  return 'ok';
}

function finishPollingJob(jobId, job, success, message) {
  if (!activePollingJobs.has(jobId)) return;
  sendJobMessage(jobId, job, {
    type: 'jobCompleted',
    jobId,
    success,
    message,
    totalAttempts: job.attempts
  });
  activePollingJobs.delete(jobId);
  savePollingJobs();
}

/**
 * Ein Watcher-Durchlauf: alle fälligen Jobs mit einer einzigen Abfrage prüfen
 */
async function watchTick() {
  if (watcherBusy) return;
  watcherBusy = true;

  try {
    const now = Date.now();
    const due = [...activePollingJobs.entries()].filter(([, job]) => now >= job.nextCheckAt);
    if (due.length === 0) return;

    for (const [, job] of due) {
      job.attempts++;
      job.lastAttempt = new Date().toISOString();
      job.nextCheckAt = now + Math.max(parseInt(job.intervalSeconds) || 0, MIN_CHECK_INTERVAL_MS);
    }
    if (due.some(([, job]) => job.attempts % 10 === 0)) savePollingJobs();

    const ids = [...new Set(due.map(([, job]) => parseInt(job.bookingId)).filter(Number.isFinite))];
    let bookingsById = new Map();
    let fetchError = null;

    if (ids.length > 0) {
      try {
        const filter = encodeURIComponent(JSON.stringify({ id: { '$in': ids } }));
        const response = await fetch(
          `${API_URL}/bookings?s=${filter}&limit=${ids.length}&fields=id,startDate,availableParticipantCount,currentParticipantCount`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (response.status === 429) {
          fetchError = { rateLimited: true, message: 'Rate-Limit bei der Platz-Abfrage, pausiere...' };
          for (const job of activePollingJobs.values()) {
            job.nextCheckAt = Math.max(job.nextCheckAt, Date.now() + WATCH_RATE_LIMIT_PAUSE_MS);
          }
        } else if (!response.ok) {
          fetchError = { message: `Platz-Abfrage fehlgeschlagen (API ${response.status})` };
        } else {
          const data = await response.json();
          bookingsById = new Map((data.data || []).map(b => [b.id, b]));
        }
      } catch (error) {
        fetchError = { message: `Platz-Abfrage fehlgeschlagen: ${error.message}` };
      }
    }

    await Promise.all(due.map(([jobId, job]) =>
      checkPollingJob(jobId, job, bookingsById.get(parseInt(job.bookingId)), fetchError)
        .catch(error => console.error(`Polling-Job ${jobId} Fehler:`, error))
    ));
  } finally {
    watcherBusy = false;
    stopWatcherIfIdle();
  }
}

async function checkPollingJob(jobId, job, booking, fetchError) {
  if (!activePollingJobs.has(jobId)) return; // zwischenzeitlich gestoppt

  // Startzeit für die Anzeige im Jobs-Tab nachtragen
  if (booking?.startDate && !job.courseStart) job.courseStart = booking.startDate;

  if (fetchError) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      rateLimited: !!fetchError.rateLimited,
      message: fetchError.message
    });
  } else if (!booking) {
    finishPollingJob(jobId, job, false, 'Kurs nicht gefunden');
    return;
  } else if (new Date(booking.startDate) <= new Date()) {
    finishPollingJob(jobId, job, false, 'Kurs hat bereits begonnen');
    return;
  } else if (!(booking.availableParticipantCount > 0)) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      watching: true,
      message: `Kein Platz frei (${booking.currentParticipantCount ?? '?'} belegt)`
    });
  } else if (Date.now() < job.postCooldownUntil) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      watching: true,
      message: `${booking.availableParticipantCount} Platz/Plätze frei - nächster Anmeldeversuch in Kürze`
    });
  } else {
    await attemptRegistration(jobId, job, job.memberId, booking.availableParticipantCount);
  }

  // Max Attempts Check
  if (activePollingJobs.has(jobId) && job.maxAttempts && job.attempts >= job.maxAttempts) {
    finishPollingJob(jobId, job, false, `Max. Versuche (${job.maxAttempts}) erreicht`);
  }
}

/**
 * Anmeldeversuch - wird nur aufgerufen, wenn die Platz-Abfrage einen freien Platz gemeldet hat
 */
async function attemptRegistration(jobId, job, memberId, freeSpots) {
  // Bis zum Erfolg gilt die Pause, damit ein dauerhaft abgelehnter Versuch nicht jede Sekunde feuert
  job.postCooldownUntil = Date.now() + POST_COOLDOWN_MS;

  const token = await getValidUserToken(memberId);
  if (!token) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      message: 'Platz frei, aber Token abgelaufen (bitte neu anmelden)'
    });
    return;
  }

  try {
    const payload = {
      memberId,
      bookingId: parseInt(job.bookingId),
      organizationId: null
    };

    const response = await fetch(`${API_URL}/participations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { message: responseText };
    }

    if (response.status === 201) {
      // Prüfe ob Warteliste oder echte Anmeldung anhand status-Feld
      // status: 1 = Angemeldet, status: 3 = Warteliste
      const isWaitlist = responseData.status === 3;

      sendJobMessage(jobId, job, {
        type: 'success',
        jobId,
        attempt: job.attempts,
        isWaitlist: isWaitlist,
        message: isWaitlist ? 'Auf Warteliste gesetzt' : 'Erfolgreich angemeldet!',
        participationStatus: responseData.status,
        data: responseData,
        fullResponse: responseData
      });

      // Job nur bei echter Anmeldung beenden, bei Warteliste weiter überwachen
      if (!isWaitlist) {
        finishPollingJob(jobId, job, true, 'Erfolgreich angemeldet!');
      }
    } else if (response.status === 429) {
      job.postCooldownUntil = Date.now() + WATCH_RATE_LIMIT_PAUSE_MS;
      sendJobMessage(jobId, job, {
        type: 'attempt',
        jobId,
        attempt: job.attempts,
        success: false,
        rateLimited: true,
        message: 'Platz frei, aber Rate-Limit erreicht - warte...'
      });
    } else {
      // Abgelehnt - evtl. weil HSP die Person schon angemeldet hat (z.B. von der Warteliste nachgerückt)
      if (await fetchParticipationStatus(job.bookingId, memberId, token) === 1) {
        sendJobMessage(jobId, job, {
          type: 'success',
          jobId,
          attempt: job.attempts,
          isWaitlist: false,
          message: 'Erfolgreich angemeldet!',
          participationStatus: 1
        });
        finishPollingJob(jobId, job, true, 'Erfolgreich angemeldet!');
        return;
      }
      sendJobMessage(jobId, job, {
        type: 'attempt',
        jobId,
        attempt: job.attempts,
        success: false,
        status: response.status,
        message: `${freeSpots} Platz/Plätze frei, Anmeldung abgelehnt: ${responseData.message || response.status}`
      });
    }
  } catch (error) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      message: error.message
    });
  }
}

/**
 * Stoppt eine Platz-Überwachung ohne Besitzer-Prüfung (nur für den Admin-Bereich).
 */
function adminStopPollingJob(jobId) {
  return stopWatchJob(jobId) === 'ok';
}

/**
 * Restore polling jobs from disk after server restart
 */
function restorePollingJobs() {
  const savedJobs = loadPollingJobs();
  if (savedJobs.length === 0) return;

  console.log(`🔄 Stelle ${savedJobs.length} Polling-Job(s) wieder her...`);
  for (const saved of savedJobs) {
    startPollingJob(saved.id, saved.bookingId, saved.intervalSeconds, saved.maxAttempts, saved.memberId,
      { title: saved.title, courseStart: saved.courseStart });
    // Restore attempt count from saved state
    const job = activePollingJobs.get(saved.id);
    if (job) {
      job.attempts = saved.attempts || 0;
      job.startedAt = saved.startedAt;
    }
  }
}

// Server starten
server.listen(PORT, async () => {
  console.log(`\n🚀 HSP-Bot Backend Server läuft auf http://localhost:${PORT}`);
  console.log(`📡 WebSocket bereit für Live-Updates`);
  
  // Einmalige Migration: eventuellen Alt-Token-Store verschlüsseln
  loadTokens();

  // Geplante Buchung auf Warteliste gelandet -> Platz-Überwachung übernimmt
  setWaitlistHandler((bookingId, memberId, meta) => startWaitlistWatch(bookingId, memberId, meta));

  // Initialize the scheduler and restore pending jobs
  await initializeScheduler();

  // Restore polling jobs from disk
  restorePollingJobs();

  // HSP-Tokens für geplante Buchungen und Platz-Überwachungen serverseitig aktiv halten
  // (funktioniert auch, wenn niemand die App offen hat)
  startTokenKeepAlive(() => [...activePollingJobs.values()].map(job => job.memberId));

  // Restore padel sessions and their scheduled bookings
  await initializePadel();

  // Admin-Bereich auf eigenem Port (nur über Tailscale erreichbar, siehe admin.js)
  startAdminServer({
    getPollingJobs: () => [...activePollingJobs.entries()].map(([id, job]) => ({
      id,
      bookingId: job.bookingId,
      memberId: job.memberId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      intervalSeconds: job.intervalSeconds,
      startedAt: job.startedAt,
      lastAttempt: job.lastAttempt
    })),
    stopPollingJob: adminStopPollingJob,
    getWsClientCount: () => wss.clients.size
  });
  console.log('');
});
