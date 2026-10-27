// padel.js - Group sessions for the padel court
// Players join a session for a court slot. As soon as MIN_PLAYERS have joined, the bot books the court
// with the best-suited player's HSP account (free quota first, then whoever booked least recently),
// invites the others by email and exposes everything as an iCal feed.

import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getUser, getValidUserToken } from './user-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, 'data', 'padel-sessions.json');
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

const PADEL_PRODUCT_ID = 129; // "Padel Anlage Platzmiete" - linkedProductId of court bookings
const COURT_PRODUCT_ID = 108; // "Padel Tennis Platz" - the bookable court itself
const TIME_ZONE = 'Europe/Berlin';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const SLOT_MINUTES = 60;
const LOCATION = 'Padel Tennis Platz, Horstmarer Landweg, 48149 Münster';
const GEO = '51.971202;7.601082';

const POLL_INTERVAL_MS = 500;
const POLL_LEAD_MS = 5 * 1000;    // start polling 5s before the slot opens
const POLL_WINDOW_MS = 60 * 1000; // keep trying for 60s after it opened
const FAIRNESS_DAYS = 30;         // look-back for "who booked least recently"
const MAX_LOG_ENTRIES = 50;

const ACTIVE_STATUSES = ['open', 'scheduled', 'booking', 'booked'];
const STATUS_LABELS = {
  open: 'Warte auf Mitspieler',
  scheduled: 'Buchung geplant',
  booking: 'Buchung läuft',
  booked: 'Gebucht',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgesagt',
  expired: 'Verfallen'
};

// Booking rules of products 129 (rental) and 108 (court). Refreshed from the HSP API on startup;
// defaults are the values seen in Oct 2026.
const rules = {
  daysAhead: 7,
  openTime: '14:00',
  maxPerDay: 1,
  maxPerPeriod: 2,
  periodDays: 7
};

// Court opening hours per ISO weekday (1 = Monday) as [startMinute, endMinute) ranges, from the court's weekCalendar
let openingHours = {
  1: [[480, 1140]], 2: [[480, 1140]], 3: [[480, 1140]], 4: [[480, 1140]], 5: [[480, 1140]],
  6: [[600, 1020]], 7: [[600, 1020]]
};

let sessions = [];
const scheduledRuns = new Map(); // sessionId -> node-schedule job
const runningBookings = new Set();
const wsConnections = new Set();

// ============ TIME HELPERS (Europe/Berlin, independent of the server's TZ) ============

function tzOffsetMs(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(ts).map(p => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Berlin wall-clock time -> Date. Day overflow (e.g. day 0 or -3) is handled like Date.UTC does.
 */
function berlinToUtc(year, month, day, hour = 0, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - tzOffsetMs(guess);
  return new Date(guess - tzOffsetMs(first));
}

function berlinParts(date) {
  const ts = new Date(date).getTime();
  const local = new Date(ts + tzOffsetMs(ts));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes()
  };
}

function formatBerlin(date) {
  return new Date(date).toLocaleString('de-DE', {
    timeZone: TIME_ZONE, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Slots for day D can be booked from (D - daysAhead) at openTime
 */
export function bookingOpensAt(slotStart) {
  const p = berlinParts(slotStart);
  const [hour, minute] = rules.openTime.split(':').map(Number);
  return berlinToUtc(p.year, p.month, p.day - rules.daysAhead, hour, minute);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============ PERSISTENCE & BROADCAST ============

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading padel sessions:', error);
  }
  return [];
}

function saveSessions() {
  try {
    const dataDir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Error saving padel sessions:', error);
  }
}

export function registerPadelWebSocket(ws) {
  wsConnections.add(ws);
  ws.on('close', () => wsConnections.delete(ws));
}

/**
 * Only the session id is broadcast - clients refetch with their userKey, so emails never go to anonymous sockets
 */
function broadcastUpdate(sessionId) {
  const message = JSON.stringify({ type: 'padelUpdate', sessionId });
  wsConnections.forEach(ws => {
    if (ws.readyState === 1) ws.send(message);
  });
}

function addLog(session, message) {
  session.log.push({ at: new Date().toISOString(), message });
  if (session.log.length > MAX_LOG_ENTRIES) {
    session.log = session.log.slice(-MAX_LOG_ENTRIES);
  }
}

function touch(session) {
  session.updatedAt = new Date().toISOString();
  session.sequence = (session.sequence || 0) + 1; // lets calendar apps pick up changes
  saveSessions();
  broadcastUpdate(session.id);
}

function setStatus(session, status, message) {
  session.status = status;
  session.statusMessage = message;
  addLog(session, message);
  touch(session);
}

const findSession = id => sessions.find(s => s.id === id);

function sessionView(session) {
  return {
    id: session.id,
    startDate: session.startDate,
    endDate: session.endDate,
    status: session.status,
    statusLabel: STATUS_LABELS[session.status],
    statusMessage: session.statusMessage,
    createdBy: session.createdBy,
    participants: session.participants,
    bookedBy: session.bookedBy,
    bookedByName: session.bookedByName,
    hspBookingId: session.hspBookingId,
    bookingOpensAt: bookingOpensAt(session.startDate).toISOString(),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    log: session.log.slice(-15)
  };
}

// ============ HSP API ============

async function fetchProduct(productId) {
  const res = await fetch(`${API_URL}/products/${productId}`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`API Fehler: ${res.status}`);
  return res.json();
}

const toMinutes = time => {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
};

async function loadRules() {
  try {
    const [rental, court] = await Promise.all([fetchProduct(PADEL_PRODUCT_ID), fetchProduct(COURT_PRODUCT_ID)]);

    // When slots open comes from the rental product (verified: rentals only exist up to today + 7 days)
    rules.daysAhead = rental.bookableAvailableFixedDaysAhead ?? rules.daysAhead;
    rules.openTime = rental.bookableAvailableFixedTimeAhead?.slice(0, 5) ?? rules.openTime;

    // Both products define booking limits - which one HSP enforces is unknown, so use the stricter one
    const strictest = (key, fallback) => {
      const values = [rental[key], court[key]].filter(v => v > 0);
      return values.length > 0 ? Math.min(...values) : fallback;
    };
    rules.maxPerDay = strictest('bookableMaxBookingsPerDay', rules.maxPerDay);
    rules.maxPerPeriod = strictest('bookableMaxBookingsPerPeriod', rules.maxPerPeriod);
    rules.periodDays = court.bookableMaxBookingsPeriodDays || rental.bookableMaxBookingsPeriodDays || rules.periodDays;

    // weekCalendar end times are inclusive ("18:59"), so +1 minute
    if (Array.isArray(court.weekCalendar) && court.weekCalendar.length > 0) {
      const hours = {};
      for (const block of court.weekCalendar.filter(b => b.isAvailable)) {
        (hours[block.isoWeekDayNumber] ??= []).push([toMinutes(block.startTime), toMinutes(block.endTime) + 1]);
      }
      openingHours = hours;
    }
  } catch (error) {
    console.error('⚠️  Padel-Regeln konnten nicht geladen werden, nutze Standardwerte:', error.message);
  }
}

export function getPadelRules() {
  return { ...rules, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS };
}

/**
 * Slot start times (minutes after midnight) within the court's opening hours on a Berlin date
 */
function slotStartMinutes(year, month, day) {
  const isoWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  const starts = [];
  for (const [open, close] of openingHours[isoWeekday] || []) {
    for (let minute = Math.ceil(open / 60) * 60; minute + SLOT_MINUTES <= close; minute += 60) {
      starts.push(minute);
    }
  }
  return starts;
}

/**
 * Everything on the court (by anyone) in a time range: rentals, but also courses and other
 * products that block the court. Public endpoint, no token needed.
 */
async function fetchCourtBookings(from, to) {
  const filter = {
    startDate: { '$gte': from.toISOString(), '$lt': to.toISOString() },
    productId: { '$in': [COURT_PRODUCT_ID] },
    status: { '$ne': 2 }
  };
  const encoded = encodeURIComponent(JSON.stringify(filter));
  const res = await fetch(`${API_URL}/bookings?s=${encoded}&limit=100&page=1&sort=startDate,ASC`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`API Fehler: ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

async function isSlotTaken(session) {
  try {
    const taken = await fetchCourtBookings(new Date(session.startDate), new Date(session.endDate));
    return taken.some(b => b.id !== session.hspBookingId);
  } catch {
    return false;
  }
}

/**
 * Request body for booking a free court slot. Mirrors what the HSP web app sends (see book.js).
 * If HSP changes the booking flow, this is the one place to adjust.
 */
function buildSlotBookingPayload(session, memberId, invitedMemberEmails) {
  // HSP stores court slots as hh:00 - hh:59
  const endDate = new Date(new Date(session.startDate).getTime() + (SLOT_MINUTES - 1) * 60000).toISOString();
  return {
    organizationId: null,
    memberId,
    bookingId: null,
    primaryPurchaseMessage: null,
    secondaryPurchaseMessage: null,
    params: {
      startDate: session.startDate,
      endDate,
      bookableProductId: COURT_PRODUCT_ID,
      bookableLinkedProductId: PADEL_PRODUCT_ID,
      bookingId: null,
      invitedMemberEmails,
      invitedGuests: [],
      invitedOthers: [],
      primaryPurchaseMessage: null,
      secondaryPurchaseMessage: null,
      clickedOnBook: true
    },
    dateOfRegistration: null
  };
}

async function postParticipation(token, payload) {
  try {
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
      // status: 1 = Angemeldet, status: 3 = Warteliste
      const isWaitlist = responseData.status === 3;
      return {
        success: !isWaitlist,
        message: isWaitlist ? 'Auf Warteliste gesetzt' : 'Erfolgreich gebucht',
        bookingId: responseData.bookingId ?? responseData.booking?.id ?? null
      };
    } else if (response.status === 429) {
      return { success: false, rateLimited: true, message: 'Rate-Limit erreicht' };
    }
    return {
      success: false,
      status: response.status,
      message: responseData.message || `Buchung fehlgeschlagen (${response.status})`
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * Checks the member's own padel bookings against the HSP limits (per day / per period).
 * The exact HSP counting window isn't documented, so this is a best guess - a rejected booking
 * simply falls through to the next candidate anyway.
 */
async function checkQuota(token, memberId, slotStart) {
  const day = berlinParts(slotStart);
  const dayStart = berlinToUtc(day.year, day.month, day.day);
  const dayEnd = berlinToUtc(day.year, day.month, day.day + 1);
  const periodStart = berlinToUtc(day.year, day.month, day.day - (rules.periodDays - 1));

  try {
    const filter = {
      'participations.memberId': memberId,
      linkedProductId: { '$in': [PADEL_PRODUCT_ID] },
      status: { '$ne': 2 },
      startDate: { '$gte': periodStart.toISOString(), '$lt': dayEnd.toISOString() }
    };
    const encoded = encodeURIComponent(JSON.stringify(filter));
    const res = await fetch(`${API_URL}/bookings?s=${encoded}&join=participations&limit=100&page=1`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return { ok: true, note: 'Kontingent nicht prüfbar' };

    const data = await res.json();
    const bookings = (data.data || []).filter(b =>
      b.participations?.some(p => p.memberId === memberId && p.status === 1)
    );
    const sameDay = bookings.filter(b => new Date(b.startDate) >= dayStart).length;

    if (sameDay >= rules.maxPerDay) {
      return { ok: false, note: `schon ${sameDay} Buchung(en) an dem Tag` };
    }
    if (bookings.length >= rules.maxPerPeriod) {
      return { ok: false, note: `schon ${bookings.length} Buchungen in ${rules.periodDays} Tagen` };
    }
    return { ok: true };
  } catch {
    return { ok: true, note: 'Kontingent nicht prüfbar' };
  }
}

// ============ BOOKER SELECTION ============

function bookingHistory(memberId) {
  const cutoff = Date.now() - FAIRNESS_DAYS * 24 * 60 * 60 * 1000;
  const booked = sessions.filter(s => s.bookedBy === memberId && s.bookedAt && new Date(s.bookedAt).getTime() > cutoff);
  const last = booked.map(s => s.bookedAt).sort().pop() || '';
  return { count: booked.length, last };
}

/**
 * Best booker first: has a usable token, has free quota, booked least often / least recently, joined earliest.
 * Players over quota stay at the end as a last resort (our quota check is only an estimate).
 */
async function rankBookers(session) {
  const ranked = [];

  for (const participant of session.participants) {
    if (!getUser(participant.memberId)) continue;

    const token = await getValidUserToken(participant.memberId);
    if (!token) {
      addLog(session, `${participant.name}: kein gültiger HSP-Token – übersprungen`);
      continue;
    }

    const quota = await checkQuota(token, participant.memberId, session.startDate);
    const history = bookingHistory(participant.memberId);
    ranked.push({
      memberId: participant.memberId,
      name: participant.name,
      quotaOk: quota.ok,
      quotaNote: quota.note,
      recentBookings: history.count,
      lastBookedAt: history.last,
      joinedAt: participant.joinedAt
    });
  }

  ranked.sort((a, b) =>
    (b.quotaOk - a.quotaOk) ||
    (a.recentBookings - b.recentBookings) ||
    a.lastBookedAt.localeCompare(b.lastBookedAt) ||
    a.joinedAt.localeCompare(b.joinedAt)
  );
  return ranked;
}

// ============ BOOKING RUN ============

async function runBooking(sessionId) {
  if (runningBookings.has(sessionId)) return;
  const session = findSession(sessionId);
  if (!session || !['open', 'scheduled'].includes(session.status)) return;
  if (session.participants.length < MIN_PLAYERS) {
    evaluateSession(session);
    return;
  }

  runningBookings.add(sessionId);
  try {
    setStatus(session, 'booking', 'Buchung läuft...');

    const candidates = await rankBookers(session);
    if (candidates.length === 0) {
      setStatus(session, 'failed', 'Kein Teilnehmer mit gültigem HSP-Token');
      return;
    }
    addLog(session, `Booker-Reihenfolge: ${candidates.map(c => c.quotaNote ? `${c.name} (${c.quotaNote})` : c.name).join(' → ')}`);
    touch(session);

    const opensAt = bookingOpensAt(session.startDate).getTime();
    const deadline = Math.max(opensAt, Date.now()) + POLL_WINDOW_MS;
    let index = 0;
    let attempts = 0;
    let lastMessage = '';
    const loggedFailures = new Set(); // polling runs at 2/s - log each booker/error combination once

    while (Date.now() < deadline) {
      const booker = candidates[index % candidates.length];
      const invited = session.participants.filter(p => p.memberId !== booker.memberId);
      attempts++;

      const result = await postSlotBooking(session, booker, invited);

      if (result.success) {
        session.bookedBy = booker.memberId;
        session.bookedByName = booker.name;
        session.bookedAt = new Date().toISOString();
        session.hspBookingId = result.bookingId;
        session.invitedMemberIds = invited.map(p => p.memberId);
        console.log(`🎾 Padel-Session ${session.id} gebucht von ${booker.name} nach ${attempts} Versuch(en)`);
        setStatus(session, 'booked', `Gebucht von ${booker.name} (${attempts} Versuch(e))`);

        // Players who joined while the booking was running weren't part of the invite
        for (const p of session.participants) {
          if (p.memberId !== booker.memberId && !session.invitedMemberIds.includes(p.memberId)) {
            await addLateJoiner(session, p);
          }
        }
        return;
      }

      // Before the slot opens, rejections are expected - only rotate bookers once it's open
      if (Date.now() >= opensAt && !result.rateLimited) {
        const key = `${booker.memberId}:${result.message}`;
        if (!loggedFailures.has(key)) {
          loggedFailures.add(key);
          addLog(session, `${booker.name}: ${result.message}`);
          touch(session);
        }
        index++;
      }
      lastMessage = result.message;
      await sleep(POLL_INTERVAL_MS);
    }

    const taken = await isSlotTaken(session);
    setStatus(session, 'failed', taken
      ? 'Platz wurde von jemand anderem gebucht'
      : `Buchung nach ${attempts} Versuchen fehlgeschlagen: ${lastMessage}`);
  } finally {
    runningBookings.delete(sessionId);
  }
}

async function postSlotBooking(session, booker, invited) {
  const token = await getValidUserToken(booker.memberId);
  if (!token) return { success: false, message: 'Token abgelaufen' };
  const payload = buildSlotBookingPayload(session, booker.memberId, invited.map(p => p.email));
  return postParticipation(token, payload);
}

/**
 * Someone joined after the court was booked: add them to the existing HSP booking with their own account
 */
async function addLateJoiner(session, participant) {
  const token = await getValidUserToken(participant.memberId);
  if (!token || !session.hspBookingId) {
    addLog(session, `${participant.name} konnte nicht automatisch hinzugefügt werden – bitte von ${session.bookedByName} in HSP einladen lassen`);
    touch(session);
    return;
  }

  const result = await postParticipation(token, {
    memberId: participant.memberId,
    bookingId: parseInt(session.hspBookingId),
    organizationId: null
  });
  addLog(session, result.success
    ? `${participant.name} zur HSP-Buchung hinzugefügt`
    : `${participant.name} konnte nicht hinzugefügt werden (${result.message}) – bitte von ${session.bookedByName} in HSP einladen lassen`);
  touch(session);
}

function cancelRun(sessionId) {
  const job = scheduledRuns.get(sessionId);
  if (job) {
    job.cancel();
    scheduledRuns.delete(sessionId);
  }
}

function startBooking(sessionId) {
  runBooking(sessionId).catch(error => {
    console.error(`Padel booking error (${sessionId}):`, error);
    const session = findSession(sessionId);
    if (session?.status === 'booking') {
      setStatus(session, 'failed', `Interner Fehler: ${error.message}`);
    }
  });
}

/**
 * Moves a session forward: schedule the booking once enough players joined, unschedule if they left
 */
function evaluateSession(session) {
  if (!['open', 'scheduled'].includes(session.status)) return;

  const now = Date.now();
  if (new Date(session.startDate).getTime() <= now) {
    cancelRun(session.id);
    setStatus(session, 'expired', 'Termin verstrichen ohne Buchung');
    return;
  }

  if (session.participants.length < MIN_PLAYERS) {
    if (session.status === 'scheduled') {
      cancelRun(session.id);
      setStatus(session, 'open', `Warte auf mind. ${MIN_PLAYERS} Spieler`);
    }
    return;
  }

  const opensAt = bookingOpensAt(session.startDate);
  const runAt = new Date(opensAt.getTime() - POLL_LEAD_MS);

  if (now >= runAt.getTime()) {
    cancelRun(session.id);
    startBooking(session.id);
    return;
  }

  if (!scheduledRuns.has(session.id)) {
    scheduledRuns.set(session.id, schedule.scheduleJob(runAt, () => {
      scheduledRuns.delete(session.id);
      startBooking(session.id);
    }));
  }
  if (session.status !== 'scheduled') {
    setStatus(session, 'scheduled', `Bot bucht automatisch am ${formatBerlin(opensAt)} Uhr`);
  }
}

// ============ PUBLIC API ============

export async function getDaySlots(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) throw new Error('Ungültiges Datum');

  const taken = await fetchCourtBookings(berlinToUtc(year, month, day), berlinToUtc(year, month, day + 1));
  const slots = [];

  for (const minute of slotStartMinutes(year, month, day)) {
    const start = berlinToUtc(year, month, day, 0, minute);
    const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
    const session = sessions.find(s => s.startDate === start.toISOString() && ACTIVE_STATUSES.includes(s.status));
    const takenBooking = taken.find(b => new Date(b.startDate) < end && new Date(b.endDate) > start);

    slots.push({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      taken: !!takenBooking && takenBooking.id !== session?.hspBookingId,
      sessionId: session?.id || null,
      bookingOpensAt: bookingOpensAt(start).toISOString(),
      isPast: start.getTime() <= Date.now()
    });
  }
  return slots;
}

export function listSessions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return sessions
    .filter(s => ACTIVE_STATUSES.includes(s.status) || new Date(s.startDate).getTime() > cutoff)
    .filter(s => new Date(s.endDate).getTime() > cutoff)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map(sessionView);
}

function participantFrom(user) {
  return { memberId: user.memberId, name: user.name, email: user.email, joinedAt: new Date().toISOString() };
}

export function createSession(user, startDate) {
  const start = new Date(startDate);
  if (isNaN(start)) return { error: 'Ungültige Startzeit' };

  const p = berlinParts(start);
  if (!slotStartMinutes(p.year, p.month, p.day).includes(p.hour * 60 + p.minute)) {
    return { error: 'Zu dieser Zeit ist der Platz nicht buchbar (außerhalb der Öffnungszeiten)' };
  }
  if (start.getTime() <= Date.now()) return { error: 'Der Termin liegt in der Vergangenheit' };

  const startIso = start.toISOString();
  const existing = sessions.find(s => s.startDate === startIso && ACTIVE_STATUSES.includes(s.status));
  if (existing) return { error: 'Für diesen Slot gibt es schon eine Session – tritt ihr bei', sessionId: existing.id };

  const session = {
    id: crypto.randomUUID(),
    startDate: startIso,
    endDate: new Date(start.getTime() + SLOT_MINUTES * 60000).toISOString(),
    createdBy: user.memberId,
    createdAt: new Date().toISOString(),
    participants: [participantFrom(user)],
    status: 'open',
    statusMessage: `Warte auf mind. ${MIN_PLAYERS} Spieler`,
    bookedBy: null,
    bookedByName: null,
    bookedAt: null,
    hspBookingId: null,
    sequence: 0,
    log: []
  };
  addLog(session, `Session erstellt von ${user.name}`);
  sessions.push(session);
  touch(session);
  evaluateSession(session);
  return { session: sessionView(session) };
}

export function joinSession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (!ACTIVE_STATUSES.includes(session.status)) return { error: `Session ist ${STATUS_LABELS[session.status].toLowerCase()}` };
  if (session.participants.some(p => p.memberId === user.memberId)) return { error: 'Du bist schon dabei' };
  if (session.participants.length >= MAX_PLAYERS) return { error: 'Session ist voll' };

  session.participants.push(participantFrom(user));
  session.leftMemberIds = (session.leftMemberIds || []).filter(id => id !== user.memberId);
  addLog(session, `${user.name} ist beigetreten`);
  touch(session);

  if (session.status === 'booked') {
    addLateJoiner(session, session.participants.at(-1)).catch(error => console.error('Padel late join error:', error));
  } else {
    evaluateSession(session);
  }
  return { session: sessionView(session) };
}

export function leaveSession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (!session.participants.some(p => p.memberId === user.memberId)) return { error: 'Du bist nicht dabei' };
  if (session.status === 'booking') return { error: 'Buchung läuft gerade – bitte kurz warten' };

  session.participants = session.participants.filter(p => p.memberId !== user.memberId);
  session.leftMemberIds = [...new Set([...(session.leftMemberIds || []), user.memberId])];

  if (session.status === 'booked') {
    addLog(session, `${user.name} hat abgesagt – die HSP-Buchung bleibt bestehen, ggf. in HSP stornieren (bis 2h vorher)`);
    touch(session);
  } else if (session.participants.length === 0) {
    cancelRun(session.id);
    setStatus(session, 'cancelled', `${user.name} hat abgesagt – keine Spieler mehr`);
  } else {
    addLog(session, `${user.name} hat abgesagt`);
    touch(session);
    evaluateSession(session);
  }
  return { session: sessionView(session) };
}

export function cancelSession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (session.createdBy !== user.memberId) return { error: 'Nur der Ersteller kann die Session absagen' };
  if (!['open', 'scheduled'].includes(session.status)) return { error: `Session ist ${STATUS_LABELS[session.status].toLowerCase()} und kann nicht mehr abgesagt werden` };

  cancelRun(session.id);
  setStatus(session, 'cancelled', `Abgesagt von ${user.name}`);
  return { session: sessionView(session) };
}

/**
 * Retry a failed booking (e.g. after re-importing an expired token) - any participant may do this
 */
export function retrySession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (!session.participants.some(p => p.memberId === user.memberId)) return { error: 'Du bist nicht dabei' };
  if (session.status !== 'failed') return { error: 'Nur fehlgeschlagene Sessions können erneut versucht werden' };

  setStatus(session, 'open', `Neuer Versuch gestartet von ${user.name}`);
  evaluateSession(session);
  return { session: sessionView(session) };
}

// ============ ICAL ============

function icsEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const icsDate = date => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * RFC 5545: lines longer than 75 octets are folded with CRLF + space
 */
function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > 75) {
      out.push(current);
      current = ' ' + ch;
      bytes = 1 + len;
    } else {
      current += ch;
      bytes += len;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

function icsEvent(session, memberId) {
  // Players who left see the event as cancelled so their calendar app removes it
  const isParticipant = session.participants.some(p => p.memberId === memberId);
  const isBooked = isParticipant && session.status === 'booked';
  const isPlanned = isParticipant && ['open', 'scheduled', 'booking'].includes(session.status);
  const status = isBooked ? 'CONFIRMED' : isPlanned ? 'TENTATIVE' : 'CANCELLED';
  const summary = isBooked ? 'Padel 🎾' : `Padel (${STATUS_LABELS[session.status]})`;
  const description = [
    `Status: ${STATUS_LABELS[session.status]}`,
    `Spieler: ${session.participants.map(p => p.name).join(', ') || '-'}`,
    session.bookedByName ? `Gebucht von: ${session.bookedByName}` : null,
    session.hspBookingId ? `HSP-Buchung: ${session.hspBookingId}` : null
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VEVENT',
    `UID:padel-${session.id}@hsp-bot`,
    `DTSTAMP:${icsDate(session.updatedAt || session.createdAt)}`,
    `SEQUENCE:${session.sequence || 0}`,
    `DTSTART:${icsDate(session.startDate)}`,
    `DTEND:${icsDate(session.endDate)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(LOCATION)}`,
    `GEO:${GEO}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `STATUS:${status}`
  ];
  if (isBooked) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Padel', 'TRIGGER:-PT60M', 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

function buildIcs(calendarSessions, memberId, calendarName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HSP-Bot//Padel//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
    `X-WR-TIMEZONE:${TIME_ZONE}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...calendarSessions.flatMap(s => icsEvent(s, memberId)),
    'END:VCALENDAR'
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Subscription feed: every session the user is (or was) part of
 */
export function getCalendarFeed(user) {
  const mine = sessions.filter(s =>
    s.participants.some(p => p.memberId === user.memberId) ||
    s.leftMemberIds?.includes(user.memberId)
  );
  return buildIcs(mine, user.memberId, 'Padel (HSP-Bot)');
}

export function getSessionIcs(user, sessionId) {
  const session = findSession(sessionId);
  if (!session || !session.participants.some(p => p.memberId === user.memberId)) return null;
  return buildIcs([session], user.memberId, 'Padel');
}

// ============ INIT ============

export async function initializePadel() {
  console.log('🎾 Initializing padel sessions...');
  await loadRules();
  sessions = loadSessions();

  for (const session of sessions) {
    // A booking run was interrupted by a restart - retry it
    if (session.status === 'booking') {
      session.status = 'open';
    }
    evaluateSession(session);
  }

  const active = sessions.filter(s => ['open', 'scheduled'].includes(s.status)).length;
  console.log(`🎾 Padel: ${active} offene Session(s), Slots öffnen ${rules.daysAhead} Tage vorher um ${rules.openTime}`);
}
