// scheduler.js - Smart scheduling for HSP course bookings

import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getValidUserToken, listRefreshableUsers } from './user-store.js';
import { isTokenValid } from './token-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULED_JOBS_FILE = path.join(__dirname, 'data', 'scheduled-jobs.json');
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

// Active scheduled jobs
const scheduledJobs = new Map();

// WebSocket connections for broadcasting
let wsConnections = new Set();

// Fallback, falls die API für eine Sportart keinen Vorlauf liefert (bisheriges Verhalten: 6 Tage)
const FALLBACK_MINUTES_AHEAD = 6 * 24 * 60;
// Job startet so lange vor der Öffnung (Zeit für Uhrenabgleich)
const LEAD_MS = 15 * 1000;
// So lange nach der Öffnung wird direkt per POST versucht. Danach übernimmt die Platz-Überwachung,
// die mit EINER öffentlichen Abfrage für alle Kurse auskommt und nur bei freiem Platz bucht -
// das schont den HSP-Server deutlich mehr als minutenlanges Dauer-POSTen.
const WINDOW_MS = 10 * 1000;
// Versuche relativ zur Öffnung (Serverzeit): dicht um den Öffnungszeitpunkt (deckt eine ungenaue
// Uhrenschätzung ab), danach 1s-Takt bis zum Fensterende. Insgesamt ~16 POSTs pro Plan.
const ATTEMPT_OFFSETS_MS = [-100, 50, 200, 400, 700, 1000, 1500, 2000];
const MIN_ATTEMPT_GAP_MS = 100;
const LATE_ATTEMPT_GAP_MS = 1000;
// Vorab-Prüfung (Token erneuern, Login-Probleme melden) so lange vor der Öffnung
const PREFLIGHT_MS = 10 * 60 * 1000;
// Der Token muss ab Job-Start mindestens so lange gültig sein, sonst wird er vorher erneuert
const TOKEN_MIN_VALIDITY_MS = WINDOW_MS + 10 * 60 * 1000;
const PARTICIPATION_BOOKED = 1;
const PARTICIPATION_WAITLIST = 3;
const PRODUCT_CACHE_TTL_MS = 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// linkedProductId -> { minutesAhead, fetchedAt }
const productWindowCache = new Map();

// IDs laufender Jobs (damit ein Abbruch auch während der Ausführung greift)
const runningJobs = new Set();

// Wird aufgerufen, wenn eine geplante Buchung auf der Warteliste landet oder im
// Öffnungsfenster keinen Platz bekommt (startet die Platz-Überwachung bis Kursbeginn)
let waitlistHandler = null;
export function setWaitlistHandler(fn) {
  waitlistHandler = fn;
}

async function fetchApiJson(pathAndQuery) {
  const res = await fetch(`${API_URL}${pathAndQuery}`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`API Fehler: ${res.status}`);
  return res.json();
}

/**
 * Vorlauf der Buchungsöffnung (Minuten vor Kursbeginn) einer Sportart aus der HSP-API
 */
async function getProductMinutesAhead(linkedProductId) {
  if (linkedProductId == null) return null;
  const cached = productWindowCache.get(linkedProductId);
  if (cached && Date.now() - cached.fetchedAt < PRODUCT_CACHE_TTL_MS) return cached.minutesAhead;

  const filter = encodeURIComponent(JSON.stringify({ id: { '$in': [linkedProductId] } }));
  const data = await fetchApiJson(`/products?s=${filter}&fields=id,bookableAvailableMinutesAhead`);
  const minutesAhead = data.data?.[0]?.bookableAvailableMinutesAhead ?? null;
  productWindowCache.set(linkedProductId, { minutesAhead, fetchedAt: Date.now() });
  return minutesAhead;
}

/**
 * Ermittelt, wann die Buchung eines Kurses öffnet.
 * Der Vorlauf ist pro Sportart verschieden (6, 7, 14, 28 Tage ...) und kommt aus
 * bookableAvailableMinutesAhead; nur wenn die API nichts liefert, gilt der 6-Tage-Fallback.
 */
async function resolveBookingWindow(bookingId, courseStartTime) {
  let start = courseStartTime;
  let minutesAhead = null;

  try {
    const id = parseInt(bookingId);
    if (Number.isFinite(id)) {
      const filter = encodeURIComponent(JSON.stringify({ id: { '$in': [id] } }));
      const data = await fetchApiJson(`/bookings?s=${filter}&fields=id,startDate,linkedProductId`);
      const booking = data.data?.[0];
      if (booking) {
        start = booking.startDate || start;
        minutesAhead = await getProductMinutesAhead(booking.linkedProductId);
      }
    }
  } catch (error) {
    console.warn(`⚠️ Buchungsfenster für ${bookingId} nicht ermittelbar (${error.message}) - nutze Fallback`);
  }

  const known = Number.isFinite(minutesAhead) && minutesAhead > 0;
  const usedMinutes = known ? minutesAhead : FALLBACK_MINUTES_AHEAD;
  const bookingAvailableAt = new Date(new Date(start).getTime() - usedMinutes * 60 * 1000);

  return {
    bookingAvailableAt,
    pollingStartAt: new Date(bookingAvailableAt.getTime() - LEAD_MS),
    pollingStopAt: new Date(bookingAvailableAt.getTime() + WINDOW_MS),
    minutesAhead: usedMinutes,
    windowSource: known ? 'api' : 'fallback'
  };
}

/**
 * Schätzt die Abweichung der lokalen Uhr zur HSP-Serveruhr (ms, positiv = Server geht vor).
 * Der Date-Header hat nur Sekundenauflösung: jede Messung grenzt den Offset auf ein
 * Intervall ein, der Schnitt mehrerer Messungen in verschiedenen Sekundenphasen ist enger.
 */
async function measureClockOffset(samples = 6) {
  let lo = -Infinity;
  let hi = Infinity;

  for (let i = 0; i < samples; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${API_URL}/bookings?limit=1&fields=id`, { headers: { 'Accept': 'application/json' } });
      const t1 = Date.now();
      await res.arrayBuffer();
      const serverSecond = Date.parse(res.headers.get('date') || '');
      if (Number.isFinite(serverSecond)) {
        // Serverzeit lag beim Stempeln in [serverSecond, serverSecond + 1s), lokal in [t0, t1]
        lo = Math.max(lo, serverSecond - t1);
        hi = Math.min(hi, serverSecond + 1000 - t0);
      }
    } catch { /* Messung überspringen */ }
    await sleep(120 + Math.random() * 160);
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    return { offset: 0, uncertainty: null };
  }
  return { offset: Math.round((lo + hi) / 2), uncertainty: Math.round((hi - lo) / 2) };
}

/**
 * Load scheduled jobs from file
 */
function loadScheduledJobs() {
  try {
    if (fs.existsSync(SCHEDULED_JOBS_FILE)) {
      const data = fs.readFileSync(SCHEDULED_JOBS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading scheduled jobs:', error);
  }
  return [];
}

/**
 * Save scheduled jobs to file
 */
function saveScheduledJobs(jobs) {
  try {
    const dataDir = path.dirname(SCHEDULED_JOBS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SCHEDULED_JOBS_FILE, JSON.stringify(jobs, null, 2));
  } catch (error) {
    console.error('Error saving scheduled jobs:', error);
  }
}

/**
 * Broadcast message to all connected WebSocket clients
 */
function broadcast(message, memberId = null) {
  const messageStr = JSON.stringify(message);
  wsConnections.forEach(ws => {
    if (ws.readyState !== 1) return; // WebSocket.OPEN
    // Scheduler-Events nur an den Besitzer senden (wenn memberId bekannt)
    if (memberId != null && ws.account?.linkedMemberId !== memberId) return;
    ws.send(messageStr);
  });
}

/**
 * Register a WebSocket connection for broadcasts
 */
export function registerWebSocket(ws) {
  wsConnections.add(ws);
  ws.on('close', () => {
    wsConnections.delete(ws);
  });
}

/**
 * Attempt registration for a booking
 */
async function attemptRegistration(bookingId, memberId, token) {
  if (!token) {
    return { success: false, noToken: true, message: 'HSP-Login abgelaufen - bitte in der App neu anmelden' };
  }

  try {
    const payload = {
      memberId,
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
      const isWaitlist = responseData.status === 3;
      return {
        success: !isWaitlist,
        isWaitlist,
        message: isWaitlist ? 'Auf Warteliste gesetzt' : 'Erfolgreich angemeldet!',
        participationStatus: responseData.status,
        data: responseData
      };
    } else if (response.status === 429) {
      return { success: false, rateLimited: true, message: 'Rate-Limit erreicht' };
    } else if (response.status === 401) {
      return { success: false, unauthorized: true, status: 401, message: 'Token abgelehnt - wird erneuert' };
    } else {
      return {
        success: false,
        status: response.status,
        message: responseData.message || 'Anmeldung fehlgeschlagen'
      };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * Echten Anmeldestatus eines Mitglieds für einen Kurs bei HSP abfragen.
 * @returns {Promise<number|null>} 1 = angemeldet, 3 = Warteliste, null = keine Teilnahme / unbekannt
 */
export async function fetchParticipationStatus(bookingId, memberId, token) {
  const id = parseInt(bookingId);
  if (!token || !Number.isFinite(id) || memberId == null) return null;
  try {
    const filter = encodeURIComponent(JSON.stringify({ id: { '$in': [id] } }));
    const res = await fetch(`${API_URL}/bookings?s=${filter}&join=participations&limit=1`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const participation = data.data?.[0]?.participations?.find(p =>
      (p.memberId === memberId || p.invitedMemberId === memberId) &&
      (p.status === PARTICIPATION_BOOKED || p.status === PARTICIPATION_WAITLIST));
    return participation ? participation.status : null;
  } catch {
    return null;
  }
}

/**
 * Platz-Überwachung übernehmen lassen. Gibt true zurück, wenn sie läuft.
 */
function handOverToWatcher(jobData) {
  if (!waitlistHandler) return false;
  try {
    waitlistHandler(jobData.bookingId, jobData.memberId, {
      title: jobData.courseDescription || null,
      courseStart: jobData.courseStartTime || null
    });
    return true;
  } catch (error) {
    console.error('Watcher handover failed:', error);
    return false;
  }
}

/**
 * Vorab-Prüfung einige Minuten vor der Öffnung: Token erneuern, damit er im Fenster sicher gilt,
 * und den Nutzer rechtzeitig warnen, wenn der HSP-Login nicht mehr funktioniert.
 */
async function runPreflight(jobData) {
  const { id, memberId, bookingAvailableAt } = jobData;
  if (!loadScheduledJobs().some(j => j.id === id && j.status === 'pending')) return;

  const token = await getValidUserToken(memberId, { minValidityMs: PREFLIGHT_MS + TOKEN_MIN_VALIDITY_MS });
  if (token) {
    console.log(`✅ Preflight ${id}: Token gültig`);
    updateJobStatus(id, 'pending', null, { clearMessage: true });
    return;
  }

  const openAt = new Date(bookingAvailableAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  const message = `HSP-Login abgelaufen - bitte vor ${openAt} Uhr neu anmelden, sonst kann nicht gebucht werden`;
  console.warn(`⚠️ Preflight ${id}: kein gültiger Token`);
  updateJobStatus(id, 'pending', message);
  broadcast({ type: 'scheduleWarning', jobId: id, bookingId: jobData.bookingId, message }, memberId);
}

// ============ TOKEN-KEEP-ALIVE ============
// Ohne offene App fragt niemand den Token ab: er würde erst erneuert, wenn der Refresh-Token
// womöglich schon verfallen ist. Daher erneuert der Server die Tokens ALLER Mitglieder mit
// Refresh-Token selbst, kurz bevor sie ablaufen – so bleiben alle dauerhaft angemeldet.

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
// Erneuern, sobald der Access-Token in weniger als 1 Tag abläuft. Schlägt der Refresh fehl,
// bleibt so noch ein Tag, um sich neu anzumelden.
const KEEPALIVE_MIN_VALIDITY_MS = 24 * 60 * 60 * 1000;
// Mitglieder ohne geplante Buchung: nach einem fehlgeschlagenen Refresh erst nach dieser Pause
// erneut versuchen (ein verfallener Refresh-Token wird nicht wieder gültig – erst ein neuer Login)
const KEEPALIVE_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const KEEPALIVE_WARNING_PREFIX = 'HSP-Login abgelaufen';

let keepAliveTimer = null;
let keepAliveBusy = false;
// memberId -> { refreshToken, at }: letzter fehlgeschlagener Refresh
const keepAliveFailures = new Map();

/**
 * Ab welcher Restlaufzeit erneuert wird: 1 Tag, aber höchstens die halbe Token-Laufzeit.
 * Gilt ein neuer Token kürzer als 1 Tag, würde sonst bei jedem Tick (alle 5 Min.) erneuert.
 */
function keepAliveThresholdMs(lifetimeMs) {
  if (!lifetimeMs || lifetimeMs <= 0) return KEEPALIVE_MIN_VALIDITY_MS;
  return Math.min(KEEPALIVE_MIN_VALIDITY_MS, lifetimeMs / 2);
}

/**
 * Startet die serverseitige Token-Erneuerung.
 * getExtraMemberIds: liefert weitere Mitglieder, deren Token aktiv gehalten werden soll
 * (z.B. laufende Platz-Überwachungen aus server.js).
 */
export function startTokenKeepAlive(getExtraMemberIds = () => []) {
  if (keepAliveTimer) return;
  const tick = () => {
    keepAliveTick(getExtraMemberIds).catch(error => console.error('Token-Keep-Alive fehlgeschlagen:', error));
  };
  keepAliveTimer = setInterval(tick, KEEPALIVE_INTERVAL_MS);
  tick();
}

async function keepAliveTick(getExtraMemberIds) {
  if (keepAliveBusy) return;
  keepAliveBusy = true;
  try {
    const pendingJobs = loadScheduledJobs().filter(j => j.memberId != null && j.status === 'pending');
    // Mitglieder, die gerade buchen wollen: immer prüfen (und ggf. warnen)
    const activeIds = new Set(pendingJobs.map(j => j.memberId));
    for (const memberId of getExtraMemberIds() || []) {
      if (memberId != null) activeIds.add(memberId);
    }

    const refreshable = new Map(listRefreshableUsers().map(u => [u.memberId, u]));
    const memberIds = new Set([...activeIds, ...refreshable.keys()]);
    const now = Date.now();

    for (const memberId of memberIds) {
      const info = refreshable.get(memberId);
      const isActive = activeIds.has(memberId);

      // Inaktive Mitglieder mit kürzlich fehlgeschlagenem Refresh (gleicher Refresh-Token) überspringen
      const failure = keepAliveFailures.get(memberId);
      if (!isActive && failure && failure.refreshToken === info?.refreshToken
          && now - failure.at < KEEPALIVE_FAILURE_BACKOFF_MS) {
        continue;
      }

      const minValidityMs = keepAliveThresholdMs(info?.lifetimeMs);
      const token = await getValidUserToken(memberId, { minValidityMs });
      // Kein Token, oder Refresh fehlgeschlagen (es kam nur der alte, bald ablaufende Token zurück)
      if (!token || !isTokenValid(token, minValidityMs)) {
        keepAliveFailures.set(memberId, { refreshToken: info?.refreshToken, at: now });
      } else {
        keepAliveFailures.delete(memberId);
      }

      if (!isActive) continue;
      const memberJobs = pendingJobs.filter(j => j.memberId === memberId);

      if (token) {
        // Login funktioniert (wieder) -> eine frühere Login-Warnung entfernen
        for (const job of memberJobs) {
          if (job.statusMessage?.startsWith(KEEPALIVE_WARNING_PREFIX)) {
            updateJobStatus(job.id, 'pending', null, { clearMessage: true });
          }
        }
        continue;
      }

      console.warn(`⚠️ Token-Keep-Alive: kein gültiger Token für Mitglied ${memberId}`);
      for (const job of memberJobs) {
        if (job.statusMessage?.startsWith(KEEPALIVE_WARNING_PREFIX)) continue; // schon gewarnt
        const message = `${KEEPALIVE_WARNING_PREFIX} - bitte in der App neu anmelden, sonst kann nicht gebucht werden`;
        updateJobStatus(job.id, 'pending', message);
        broadcast({ type: 'scheduleWarning', jobId: job.id, bookingId: job.bookingId, message }, memberId);
      }
    }
  } finally {
    keepAliveBusy = false;
  }
}

/**
 * Execute the scheduled booking job
 */
async function executeScheduledJob(jobData) {
  const { id, bookingId, bookingAvailableAt, memberId } = jobData;

  console.log(`\n🚀 Starting scheduled job ${id} for booking ${bookingId}`);

  if (!memberId) {
    broadcast({
      type: 'scheduleError',
      jobId: id,
      message: 'Keine Member-ID gefunden'
    });
    updateJobStatus(id, 'failed', 'Keine Member-ID gefunden');
    return;
  }

  runningJobs.add(id);
  scheduledJobs.delete(id);
  updateJobStatus(id, 'running', null, { clearMessage: true });

  let attempts = 0;
  const finish = (status, statusMessage, event) => {
    broadcast({ type: 'scheduleCompleted', jobId: id, bookingId, totalAttempts: attempts, ...event }, memberId);
    updateJobStatus(id, status, statusMessage);
  };
  // Echte Anmeldung oder Warteliste abschließen. Gibt true zurück, wenn der Job damit erledigt ist.
  const settle = (participationStatus) => {
    if (participationStatus === PARTICIPATION_BOOKED) {
      console.log(`✅ Scheduled job ${id} succeeded after ${attempts} attempts`);
      finish('completed', 'Erfolgreich angemeldet', { success: true, message: 'Erfolgreich angemeldet!' });
      return true;
    }
    if (participationStatus === PARTICIPATION_WAITLIST) {
      // Kurs war sofort voll: weitere Versuche bringen nichts -> an die Platz-Überwachung übergeben
      console.log(`⚠️ Scheduled job ${id} landed on the waitlist after ${attempts} attempts`);
      const watching = handOverToWatcher(jobData);
      finish('waitlist', watching ? 'Auf Warteliste - Platz-Überwachung aktiv' : 'Auf Warteliste', {
        success: false,
        isWaitlist: true,
        handedOver: watching,
        message: watching
          ? 'Auf Warteliste gesetzt - frei werdende Plätze werden überwacht'
          : 'Auf Warteliste gesetzt'
      });
      return true;
    }
    return false;
  };

  try {
    // Token schon jetzt so erneuern, dass er das ganze Fenster über gilt (kein Refresh zur Öffnung)
    let token = await getValidUserToken(memberId, { minValidityMs: TOKEN_MIN_VALIDITY_MS });
    if (!token) {
      broadcast({
        type: 'scheduleWarning',
        jobId: id,
        bookingId,
        message: 'HSP-Login abgelaufen - bitte jetzt neu anmelden, der Bot versucht es weiter'
      }, memberId);
    }

    // Bereits angemeldet (z.B. manuell oder durch einen früheren Lauf vor einem Neustart)?
    if (settle(await fetchParticipationStatus(bookingId, memberId, token))) return;

    // Uhr mit dem HSP-Server abgleichen, damit die Versuche zur Server-Öffnungszeit ankommen
    const { offset, uncertainty } = await measureClockOffset();
    const localOpen = new Date(bookingAvailableAt).getTime() - offset;
    const deadline = Math.max(localOpen, Date.now()) + WINDOW_MS;
    console.log(`⏱️ Job ${id}: Uhren-Offset ${offset}ms (±${uncertainty ?? '?'}ms)`);

    broadcast({
      type: 'scheduleTriggered',
      jobId: id,
      bookingId,
      message: 'Geplante Buchung gestartet',
      bookingAvailableAt,
      clockOffsetMs: offset,
      stopTime: new Date(deadline).toISOString()
    }, memberId);

    let nextAt = localOpen + ATTEMPT_OFFSETS_MS[0];
    let statusChecked = false;

    while (true) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);

      if (!runningJobs.has(id)) {
        console.log(`🛑 Scheduled job ${id} cancelled`);
        return;
      }
      if (Date.now() > deadline) break;

      // Nutzer kann sich während des Fensters neu anmelden -> neuen Token aufgreifen
      if (!token) token = await getValidUserToken(memberId);

      attempts++;
      const result = await attemptRegistration(bookingId, memberId, token);

      broadcast({
        type: 'scheduleAttempt',
        jobId: id,
        bookingId,
        attempt: attempts,
        ...result
      }, memberId);

      if (result.success) {
        settle(PARTICIPATION_BOOKED);
        return;
      }
      if (result.isWaitlist) {
        settle(PARTICIPATION_WAITLIST);
        return;
      }

      if (result.unauthorized) {
        // Token wurde abgelehnt: sofort erneuern (erzwingt Refresh)
        token = await getValidUserToken(memberId, { minValidityMs: Number.MAX_SAFE_INTEGER });
      } else if (result.status && !result.rateLimited && !statusChecked && Date.now() >= localOpen + 1000) {
        // Auch nach der Öffnung abgelehnt - evtl. "bereits angemeldet": einmal den echten Status prüfen
        statusChecked = true;
        if (settle(await fetchParticipationStatus(bookingId, memberId, token))) return;
      }

      // Nächsten Versuch planen: erst die festen Offsets um die Öffnung, dann 1s-, später 3s-Takt
      if (attempts < ATTEMPT_OFFSETS_MS.length) {
        nextAt = localOpen + ATTEMPT_OFFSETS_MS[attempts];
      } else {
        nextAt = Date.now() + LATE_ATTEMPT_GAP_MS;
      }
      nextAt = Math.max(nextAt, Date.now() + (result.rateLimited ? 2000 : MIN_ATTEMPT_GAP_MS));
    }

    // Letzter Abgleich, bevor wir aufgeben
    token = token || await getValidUserToken(memberId);
    if (settle(await fetchParticipationStatus(bookingId, memberId, token))) return;

    console.log(`❌ Scheduled job ${id}: no spot after ${attempts} attempts - handing over to watcher`);
    handOverAfterFailure('Im Öffnungsfenster kein Platz bekommen');
  } catch (error) {
    console.error(`Scheduled job ${id} crashed:`, error);
    broadcast({ type: 'scheduleError', jobId: id, message: error.message }, memberId);
    handOverAfterFailure(`Fehler: ${error.message}`);
  } finally {
    runningJobs.delete(id);
  }

  // Nicht aufgeben: die Platz-Überwachung meldet an, sobald bis Kursbeginn ein Platz frei wird
  function handOverAfterFailure(reason) {
    if (!runningJobs.has(id)) return; // abgebrochen
    const watching = handOverToWatcher(jobData);
    finish(watching ? 'watching' : 'failed',
      watching ? `${reason} - Platz-Überwachung läuft bis Kursbeginn` : reason, {
        success: false,
        handedOver: watching,
        message: watching
          ? `${reason} - frei werdende Plätze werden bis Kursbeginn überwacht`
          : reason
      });
  }
}

/**
 * Update job status in persistence
 */
function updateJobStatus(jobId, status, message = null, { clearMessage = false } = {}) {
  const jobs = loadScheduledJobs();
  const jobIndex = jobs.findIndex(j => j.id === jobId);
  if (jobIndex !== -1) {
    jobs[jobIndex].status = status;
    if (message) {
      jobs[jobIndex].statusMessage = message;
    } else if (clearMessage) {
      delete jobs[jobIndex].statusMessage;
    }
    jobs[jobIndex].updatedAt = new Date().toISOString();
    saveScheduledJobs(jobs);
  }
}

/**
 * Vorab-Prüfung und Haupt-Job bei node-schedule einplanen
 */
function armJob(jobData, pollingStartAt) {
  const preflightAt = new Date(new Date(jobData.bookingAvailableAt).getTime() - PREFLIGHT_MS);
  let preflightJob = null;
  if (preflightAt > new Date()) {
    preflightJob = schedule.scheduleJob(preflightAt, () => {
      runPreflight(jobData).catch(error => console.error(`Preflight ${jobData.id} failed:`, error));
    });
  } else {
    runPreflight(jobData).catch(error => console.error(`Preflight ${jobData.id} failed:`, error));
  }
  const job = schedule.scheduleJob(pollingStartAt, () => {
    executeScheduledJob(jobData);
  });
  scheduledJobs.set(jobData.id, { ...jobData, scheduleJob: job, preflightJob });
}

/**
 * Schedule a new booking job
 */
export async function scheduleBooking(bookingId, courseStartTime, courseDescription = '', memberId = null) {
  const id = `schedule-${bookingId}-${Date.now()}`;

  const { bookingAvailableAt, pollingStartAt, pollingStopAt, minutesAhead, windowSource } =
    await resolveBookingWindow(bookingId, courseStartTime);

  // Check if already past the stop time
  if (new Date() > pollingStopAt) {
    return {
      success: false,
      error: 'Der Buchungszeitraum ist bereits abgelaufen'
    };
  }

  // Check if polling should start immediately (we're in the window)
  const now = new Date();
  const shouldStartImmediately = now >= pollingStartAt && now < pollingStopAt;

  const jobData = {
    id,
    bookingId,
    courseStartTime,
    courseDescription,
    memberId,
    bookingAvailableAt: bookingAvailableAt.toISOString(),
    pollingStartAt: pollingStartAt.toISOString(),
    pollingStopAt: pollingStopAt.toISOString(),
    minutesAhead,
    windowSource,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  // Save to persistence
  const jobs = loadScheduledJobs();
  // Check for duplicates
  const existingJob = jobs.find(j =>
    j.bookingId === bookingId &&
    j.memberId === memberId &&
    j.status === 'pending'
  );
  if (existingJob) {
    return {
      success: false,
      error: 'Für diesen Kurs existiert bereits eine geplante Buchung'
    };
  }
  
  jobs.push(jobData);
  saveScheduledJobs(jobs);

  // Schedule the job
  if (shouldStartImmediately) {
    console.log(`⚡ Job ${id} starting immediately (within polling window)`);
    executeScheduledJob(jobData);
  } else {
    armJob(jobData, pollingStartAt);
    console.log(`📅 Scheduled job ${id} for ${pollingStartAt.toISOString()}`);
  }

  return {
    success: true,
    job: jobData
  };
}

/**
 * Cancel a scheduled job
 */
export function cancelScheduledJob(jobId) {
  // Laufenden Job stoppen (die Schleife prüft das vor jedem Versuch)
  runningJobs.delete(jobId);

  // Cancel from node-schedule
  if (scheduledJobs.has(jobId)) {
    const job = scheduledJobs.get(jobId);
    if (job.scheduleJob) {
      job.scheduleJob.cancel();
    }
    if (job.preflightJob) {
      job.preflightJob.cancel();
    }
    scheduledJobs.delete(jobId);
  }

  // Remove from persistence
  const jobs = loadScheduledJobs();
  const jobIndex = jobs.findIndex(j => j.id === jobId);
  if (jobIndex !== -1) {
    jobs.splice(jobIndex, 1);
    saveScheduledJobs(jobs);
    return { success: true };
  }

  return { success: false, error: 'Job nicht gefunden' };
}

/**
 * Get all scheduled jobs
 */
export function getScheduledJobs(memberId = null) {
  const jobs = loadScheduledJobs();
  // Beendete Jobs 7 Tage zeigen, damit auch wer die App erst später öffnet das Ergebnis sieht
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return jobs.filter(j =>
    (memberId == null || j.memberId === memberId) &&
    (j.status === 'pending' ||
     j.status === 'running' ||
     new Date(j.updatedAt || j.createdAt) > cutoff)
  );
}

/**
 * Prüft, ob ein geplanter Job einem Mitglied gehört (für Lösch-Berechtigung).
 */
export function jobBelongsToMember(jobId, memberId) {
  const job = loadScheduledJobs().find(j => j.id === jobId);
  // Alt-Jobs ohne memberId gehören niemandem exklusiv -> erlauben
  return !!job && (job.memberId == null || job.memberId === memberId);
}

/**
 * Initialize scheduler - restore pending jobs on server start
 */
export async function initializeScheduler() {
  console.log('📅 Initializing scheduler...');

  const jobs = loadScheduledJobs();
  const toStart = [];
  const toArm = [];
  let restoredCount = 0;
  let cleanedCount = 0;

  for (const jobData of jobs) {
    // 'running' = Server wurde mitten in der Ausführung neu gestartet -> wie pending behandeln
    if (jobData.status !== 'pending' && jobData.status !== 'running') continue;
    jobData.status = 'pending';

    // Öffnungszeit neu aus der API ermitteln (Alt-Jobs wurden pauschal mit 6 Tagen berechnet)
    const window = await resolveBookingWindow(jobData.bookingId, jobData.courseStartTime);
    if (window.windowSource === 'api') {
      const fresh = window.bookingAvailableAt.toISOString();
      if (fresh !== jobData.bookingAvailableAt) {
        console.log(`🔧 Job ${jobData.id}: Öffnungszeit korrigiert ${jobData.bookingAvailableAt} -> ${fresh}`);
      }
      jobData.bookingAvailableAt = fresh;
      jobData.minutesAhead = window.minutesAhead;
      jobData.windowSource = 'api';
    }
    const openMs = new Date(jobData.bookingAvailableAt).getTime();
    const pollingStartAt = new Date(openMs - LEAD_MS);
    const pollingStopAt = new Date(openMs + WINDOW_MS);
    jobData.pollingStartAt = pollingStartAt.toISOString();
    jobData.pollingStopAt = pollingStopAt.toISOString();

    const now = new Date();
    if (now > pollingStopAt) {
      // Job window has passed, mark as missed
      jobData.status = 'missed';
      jobData.statusMessage = 'Zeitfenster verpasst (Server war offline)';
      jobData.updatedAt = now.toISOString();
      cleanedCount++;
      continue;
    }

    if (now >= pollingStartAt) {
      // We're in the window, start right after the corrected jobs are saved
      console.log(`⚡ Restoring active job ${jobData.id}`);
      toStart.push(jobData);
    } else {
      toArm.push([jobData, pollingStartAt]);
      console.log(`📅 Restored scheduled job ${jobData.id} for ${pollingStartAt.toISOString()}`);
    }
    restoredCount++;
  }

  saveScheduledJobs(jobs);
  // Erst nach dem Speichern einplanen, damit eine sofortige Vorab-Prüfung den aktuellen Stand sieht
  toArm.forEach(([jobData, pollingStartAt]) => armJob(jobData, pollingStartAt));
  toStart.forEach(jobData => executeScheduledJob(jobData));

  console.log(`📅 Scheduler initialized: ${restoredCount} jobs restored, ${cleanedCount} expired jobs cleaned`);
}

/**
 * Get booking available time for a course (for UI display)
 */
export async function getBookingInfo(courseStartTime, bookingId = null) {
  const { bookingAvailableAt, pollingStartAt, pollingStopAt, minutesAhead, windowSource } =
    await resolveBookingWindow(bookingId, courseStartTime);
  const now = new Date();

  return {
    bookingAvailableAt: bookingAvailableAt.toISOString(),
    pollingStartAt: pollingStartAt.toISOString(),
    pollingStopAt: pollingStopAt.toISOString(),
    minutesAhead,
    windowSource,
    isInPast: now > pollingStopAt,
    isInWindow: now >= pollingStartAt && now < pollingStopAt
  };
}
