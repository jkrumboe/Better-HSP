// scheduler.js - Smart scheduling for HSP course bookings

import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getValidUserToken } from './user-store.js';

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
// So lange nach der Öffnung wird weiter versucht
const WINDOW_MS = 60 * 1000;
// Erste Versuche relativ zur Öffnung (Serverzeit); danach 1s-Takt bis +15s, dann 3s-Takt
const ATTEMPT_OFFSETS_MS = [-50, 100, 300, 700];
const MIN_ATTEMPT_GAP_MS = 200;
const PRODUCT_CACHE_TTL_MS = 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// linkedProductId -> { minutesAhead, fetchedAt }
const productWindowCache = new Map();

// IDs laufender Jobs (damit ein Abbruch auch während der Ausführung greift)
const runningJobs = new Set();

// Wird aufgerufen, wenn eine geplante Buchung auf der Warteliste landet
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
async function attemptRegistration(jobId, bookingId, memberId) {
  const token = await getValidUserToken(memberId);
  if (!token) {
    return { success: false, message: 'Token expired' };
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
  updateJobStatus(id, 'running');

  try {
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

    let attempts = 0;
    let nextAt = localOpen + ATTEMPT_OFFSETS_MS[0];

    while (true) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);

      if (!runningJobs.has(id)) {
        console.log(`🛑 Scheduled job ${id} cancelled`);
        return;
      }
      if (Date.now() > deadline) break;

      attempts++;
      const result = await attemptRegistration(id, bookingId, memberId);

      broadcast({
        type: 'scheduleAttempt',
        jobId: id,
        bookingId,
        attempt: attempts,
        ...result
      }, memberId);

      if (result.success) {
        console.log(`✅ Scheduled job ${id} succeeded after ${attempts} attempts`);
        broadcast({
          type: 'scheduleCompleted',
          jobId: id,
          bookingId,
          success: true,
          totalAttempts: attempts,
          message: result.message
        }, memberId);
        updateJobStatus(id, 'completed', 'Erfolgreich angemeldet');
        return;
      }

      if (result.isWaitlist) {
        // Kurs war sofort voll: weitere Versuche bringen nichts -> an die Platz-Überwachung übergeben
        console.log(`⚠️ Scheduled job ${id} landed on the waitlist after ${attempts} attempts`);
        const watching = !!waitlistHandler;
        broadcast({
          type: 'scheduleCompleted',
          jobId: id,
          bookingId,
          success: false,
          isWaitlist: true,
          totalAttempts: attempts,
          message: watching
            ? 'Auf Warteliste gesetzt - frei werdende Plätze werden überwacht'
            : 'Auf Warteliste gesetzt'
        }, memberId);
        updateJobStatus(id, 'waitlist', watching ? 'Auf Warteliste - Platz-Überwachung aktiv' : 'Auf Warteliste');
        if (watching) {
          try {
            waitlistHandler(bookingId, memberId);
          } catch (error) {
            console.error('Waitlist handover failed:', error);
          }
        }
        return;
      }

      // Nächsten Versuch planen: erst die festen Offsets um die Öffnung, dann 1s-, später 3s-Takt
      if (attempts < ATTEMPT_OFFSETS_MS.length) {
        nextAt = localOpen + ATTEMPT_OFFSETS_MS[attempts];
      } else {
        nextAt = Date.now() + (Date.now() - localOpen < 15 * 1000 ? 1000 : 3000);
      }
      nextAt = Math.max(nextAt, Date.now() + (result.rateLimited ? 2000 : MIN_ATTEMPT_GAP_MS));
    }

    console.log(`❌ Scheduled job ${id} failed after ${attempts} attempts`);
    broadcast({
      type: 'scheduleCompleted',
      jobId: id,
      bookingId,
      success: false,
      totalAttempts: attempts,
      message: 'Zeitfenster abgelaufen ohne erfolgreiche Anmeldung'
    }, memberId);
    updateJobStatus(id, 'failed', 'Zeitfenster abgelaufen');
  } catch (error) {
    console.error(`Scheduled job ${id} crashed:`, error);
    broadcast({ type: 'scheduleError', jobId: id, message: error.message }, memberId);
    updateJobStatus(id, 'failed', error.message);
  } finally {
    runningJobs.delete(id);
  }
}

/**
 * Update job status in persistence
 */
function updateJobStatus(jobId, status, message = null) {
  const jobs = loadScheduledJobs();
  const jobIndex = jobs.findIndex(j => j.id === jobId);
  if (jobIndex !== -1) {
    jobs[jobIndex].status = status;
    if (message) {
      jobs[jobIndex].statusMessage = message;
    }
    jobs[jobIndex].updatedAt = new Date().toISOString();
    saveScheduledJobs(jobs);
  }
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
    const job = schedule.scheduleJob(pollingStartAt, () => {
      executeScheduledJob(jobData);
    });
    
    scheduledJobs.set(id, {
      ...jobData,
      scheduleJob: job
    });
    
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
  // Filter out old completed/failed jobs (older than 24 hours)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
      const job = schedule.scheduleJob(pollingStartAt, () => {
        executeScheduledJob(jobData);
      });
      scheduledJobs.set(jobData.id, { ...jobData, scheduleJob: job });
      console.log(`📅 Restored scheduled job ${jobData.id} for ${pollingStartAt.toISOString()}`);
    }
    restoredCount++;
  }

  saveScheduledJobs(jobs);
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
