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
import { getMemberBookings, forgetMemberBookings } from './member-bookings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, 'data', 'padel-sessions.json');
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

const PADEL_PRODUCT_ID = 129; // "Padel Anlage Platzmiete" - linkedProductId of court bookings
const COURT_PRODUCT_ID = 108; // "Padel Tennis Platz" - the bookable court itself
const TIME_ZONE = 'Europe/Berlin';
const MIN_PLAYERS = 2;
const MIN_CARD_HOLDERS = 2; // HSP only accepts a court booking with at least 2 players holding a membership (booker + 1 invited)
const MAX_PLAYERS = 4;
const SLOT_MINUTES = 60;
const LOCATION = 'Padel Tennis Platz, Horstmarer Landweg, 48149 Münster';
const GEO = '51.971202;7.601082';

const POLL_INTERVAL_MS = 500;       // around the opening moment
const SLOW_POLL_INTERVAL_MS = 1000; // once the race is decided
const DENSE_WINDOW_MS = 3 * 1000;   // poll densely until 3s after the opening
const POLL_LEAD_MS = 2 * 1000;      // start polling 2s before the slot opens
const POLL_WINDOW_MS = 15 * 1000;   // give up 15s after it opened (or after the start, if already open)
const MAX_UNCLEAR_REJECTIONS = 3;   // per booker, for HSP answers we can't classify
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
    eligibility: session.eligibility && ['open', 'scheduled', 'failed'].includes(session.status)
      ? {
          ...session.eligibility,
          players: session.eligibility.players.filter(p => session.participants.some(x => x.memberId === p.memberId))
        }
      : null,
    bookingOpensAt: bookingOpensAt(session.startDate).toISOString(),
    minPlayers: MIN_PLAYERS,
    minCardHolders: MIN_CARD_HOLDERS,
    maxPlayers: MAX_PLAYERS,
    log: session.log.slice(-15)
  };
}

// ============ HSP API ============

async function fetchProduct(productId) {
  const res = await fetch(`${API_URL}/products/${productId}?join=linkedSubscriptions`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`API Fehler: ${res.status}`);
  return res.json();
}

// Memberships that allow booking (isLinkedSubsRequired). The court only lists "Rückschlagspiele Club",
// the rental additionally accepts e.g. Sportpass - whether that is enough for the court is unknown.
// Refreshed from the API on startup; defaults are the values seen in Nov 2026.
const membershipRules = {
  court: new Map([[12, 'Rückschlagspiele Club']]),
  rental: new Map([
    [12, 'Rückschlagspiele Club'], [69, 'Volunteer Mitgliedschaft'], [70, 'Sportpass Unlimited'],
    [72, 'Sportpass limited'], [67, 'Mitgliedschaft fachpraktische Prüfung Tennis']
  ])
};

const subscriptionMap = product => new Map(
  (product.linkedSubscriptions || []).map(sub => [sub.id, String(sub.description || '').trim()])
);

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

    // Both products define booking limits - the HSP booking dialog shows the rental's (1/day, 3 in 7 days)
    const limit = (key, fallback) => rental[key] > 0 ? rental[key] : court[key] > 0 ? court[key] : fallback;
    rules.maxPerDay = limit('bookableMaxBookingsPerDay', rules.maxPerDay);
    rules.maxPerPeriod = limit('bookableMaxBookingsPerPeriod', rules.maxPerPeriod);
    rules.periodDays = limit('bookableMaxBookingsPeriodDays', rules.periodDays);

    if (court.linkedSubscriptions?.length) membershipRules.court = subscriptionMap(court);
    if (rental.linkedSubscriptions?.length) membershipRules.rental = subscriptionMap(rental);

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
  return { ...rules, minPlayers: MIN_PLAYERS, minCardHolders: MIN_CARD_HOLDERS, maxPlayers: MAX_PLAYERS };
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

// Query padding: staff blocks can span a whole day, and HSP compares date filters in its local
// time (a "…Z" bound is shifted by the Berlin offset). The exact overlap is checked here instead.
const QUERY_PADDING_MS = 24 * 60 * 60 * 1000;

/**
 * Everything on the court (by anyone) overlapping a time range: rentals, but also courses and
 * staff blocks ("Sonderbelegung", product 524). Public endpoint, no token needed.
 * Note: status 2 is NOT "cancelled" here - staff blocks have status 2 and HSP rejects bookings
 * on them ("blocked by a booking"). Cancelled rentals don't show up at all.
 */
async function fetchCourtBookings(from, to) {
  const filter = {
    startDate: {
      '$gte': new Date(from.getTime() - QUERY_PADDING_MS).toISOString(),
      '$lt': new Date(to.getTime() + QUERY_PADDING_MS).toISOString()
    },
    productId: { '$in': [COURT_PRODUCT_ID] }
  };
  const encoded = encodeURIComponent(JSON.stringify(filter));
  const res = await fetch(`${API_URL}/bookings?s=${encoded}&limit=100&page=1&sort=startDate,ASC`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`API Fehler: ${res.status}`);
  const data = await res.json();
  return (data.data || []).filter(b => new Date(b.startDate) < to && new Date(b.endDate) > from);
}

/**
 * The booking that occupies the session's slot (someone else's rental, a course, a staff block), or null
 */
async function findSlotBlocker(session) {
  try {
    const taken = await fetchCourtBookings(new Date(session.startDate), new Date(session.endDate));
    return taken.find(b => b.id !== session.hspBookingId) || null;
  } catch {
    return null;
  }
}

function blockerReason(booking) {
  return booking.linkedProductId === PADEL_PRODUCT_ID ? 'Platz war schon vergeben' : 'Platz ist von HSP gesperrt';
}

/**
 * Sorts an HSP rejection (after the slot opened) into:
 *  'blocked' - the slot itself can't be booked by anyone -> stop
 *  'limit'   - this booker hit the per-day / per-period limit -> drop the booker
 *  'auth'    - this booker's token doesn't work -> drop the booker
 *  'unclear' - anything else -> retry a few times
 */
function classifyRejection(result) {
  const message = String(result.message || '');
  if (/blocked by a booking/i.test(message)) return 'blocked';
  if (/max(imum)? bookings/i.test(message)) return 'limit';
  // No accepted membership - or the membership is already "in use" by another upcoming padel booking
  // (all linked subscriptions have maxSimultaneousPerPerson = 1). Retrying won't change that.
  if (/required subscriptions?/i.test(message)) return 'subscription';
  if (result.status === 401 || message === 'Token abgelaufen') return 'auth';
  return 'unclear';
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

// ============ MEMBER BOOKINGS ============

/**
 * The member's padel court bookings, from the same (cached) query as "Meine Buchungen"
 * Returns { ok: true, bookings } or { ok: false, status }
 */
async function getMemberPadelBookings(token, memberId) {
  try {
    const bookings = await getMemberBookings(token, memberId);
    return { ok: true, bookings: bookings.filter(b => b.linkedProductId === PADEL_PRODUCT_ID && b.status !== 2) };
  } catch (error) {
    return { ok: false, status: error.status || error.message };
  }
}

/**
 * Is this court booking one of the session's players' (e.g. booked by hand in the HSP app)?
 * Asks one participant at a time and stops at the first hit. Returns the booking incl. participations, or null.
 */
async function findOwnBooking(session, courtBooking) {
  if (courtBooking.linkedProductId !== PADEL_PRODUCT_ID) return null; // course / staff block
  for (const participant of session.participants) {
    const token = getUser(participant.memberId) ? await getValidUserToken(participant.memberId) : null;
    if (!token) continue;
    try {
      const result = await getMemberPadelBookings(token, participant.memberId);
      const own = result.ok && result.bookings.find(b => b.id === courtBooking.id);
      if (own) return own;
    } catch {
      // HSP not reachable for this member - try the next one
    }
  }
  return null;
}

// ============ HSP BOOKING -> PLAYERS ============
// HSP stores one participation per invited player: memberId = who booked, invitedMemberId = the
// invitee. The booker's own row has no invitedMemberId. Every member only sees their own row(s),
// so only the booker's view lists everyone.

const activeParticipations = booking => (booking.participations || []).filter(p => p.status !== 2);

function bookingBookerId(booking) {
  const parts = activeParticipations(booking);
  return (parts.find(p => !p.invitedMemberId) || parts[0])?.memberId ?? null;
}

/**
 * Member ids in the booking as far as this view shows them, booker first
 */
function bookingMemberIds(booking) {
  const ids = new Set();
  const bookerId = bookingBookerId(booking);
  if (bookerId) ids.add(bookerId);
  for (const p of activeParticipations(booking)) {
    if (p.memberId) ids.add(p.memberId);
    if (p.invitedMemberId) ids.add(p.invitedMemberId);
  }
  return [...ids];
}

/**
 * Players of an HSP booking for "Meine Buchungen": the booking's participations plus the padel
 * session it belongs to, with names from the app. null for bookings with only the member themself.
 * Returns [{ memberId, name, isBooker }]
 */
export function getBookingPlayers(booking) {
  const session = sessions.find(s => s.hspBookingId === booking.id);
  const bookerId = session?.bookedBy ?? bookingBookerId(booking);
  const ids = [...new Set([...bookingMemberIds(booking), ...(session?.participants.map(p => p.memberId) || [])])];
  if (ids.length < 2 && booking.linkedProductId !== PADEL_PRODUCT_ID) return null;

  return ids.map(id => ({
    memberId: id,
    name: session?.participants.find(p => p.memberId === id)?.name || getUser(id)?.name || null,
    isBooker: id === bookerId
  })).sort((a, b) => b.isBooker - a.isBooker);
}

/**
 * App users in the booking who aren't in the session yet are playing too - add them
 */
function addBookingPlayers(session, booking) {
  for (const id of bookingMemberIds(booking)) {
    if (session.participants.length >= MAX_PLAYERS) break;
    const user = getUser(id);
    if (user && !session.participants.some(p => p.memberId === id)) {
      session.participants.push(participantFrom(user));
      addLog(session, `${user.name} ist in der HSP-Buchung – hinzugefügt`);
    }
  }
}

/**
 * Marks the session as booked with a booking that was made outside the bot (e.g. by hand in HSP)
 */
function adoptOwnBooking(session, booking) {
  const bookerId = bookingBookerId(booking);
  const bookerName = session.participants.find(p => p.memberId === bookerId)?.name
    || (bookerId && getUser(bookerId)?.name)
    || 'jemand außerhalb des Bots';
  const ids = bookingMemberIds(booking);

  addBookingPlayers(session, booking);
  session.bookedBy = bookerId;
  session.bookedByName = bookerName;
  session.bookedAt = new Date().toISOString();
  session.hspBookingId = booking.id;
  session.invitedMemberIds = session.participants.map(p => p.memberId).filter(id => id !== bookerId && ids.includes(id));
  delete session.failure;
  cancelRun(session.id);

  // Only the booker's view lists every invitee - from an invitee's view nobody can be called missing
  const bookersView = activeParticipations(booking).some(p => !p.invitedMemberId);
  const missing = session.participants.filter(p => !ids.includes(p.memberId));
  if (bookersView && missing.length > 0) {
    addLog(session, `Nicht in der HSP-Buchung: ${missing.map(p => p.name).join(', ')} – bitte in HSP einladen lassen`);
  }
  console.log(`🎾 Padel-Session ${session.id}: eigene HSP-Buchung ${booking.id} gefunden (${bookerName})`);
  setStatus(session, 'booked', `In HSP gebucht von ${bookerName} (Buchung ${booking.id})`);
}

/**
 * A court booking from HSP without a session (booked by hand): create a booked session for it,
 * so it shows up in the padel tab
 */
function createSessionFromBooking(booking, fallbackMemberId) {
  const bookerId = bookingBookerId(booking);
  const start = new Date(booking.startDate);
  const session = {
    id: crypto.randomUUID(),
    startDate: start.toISOString(),
    endDate: new Date(start.getTime() + SLOT_MINUTES * 60000).toISOString(),
    createdBy: getUser(bookerId) ? bookerId : fallbackMemberId,
    createdAt: new Date().toISOString(),
    participants: [],
    status: 'open',
    statusMessage: '',
    bookedBy: null,
    bookedByName: null,
    bookedAt: null,
    hspBookingId: null,
    sequence: 0,
    log: []
  };
  addLog(session, `Aus HSP übernommen (Buchung ${booking.id})`);
  sessions.push(session);
  adoptOwnBooking(session, booking);
}

/**
 * Takes over the member's upcoming padel bookings from HSP: links them to a waiting session for
 * that slot, or creates a booked session. Uses bookings that were fetched anyway - no extra request.
 */
export function importPadelBookings(memberId, bookings) {
  const now = Date.now();
  for (const booking of bookings) {
    if (booking.linkedProductId !== PADEL_PRODUCT_ID || booking.status === 2) continue;
    if (new Date(booking.endDate).getTime() <= now) continue;
    if (!activeParticipations(booking).some(p => p.memberId === memberId || p.invitedMemberId === memberId)) continue;
    if (sessions.some(s => s.hspBookingId === booking.id)) continue;

    const existing = sessionForSlot(new Date(booking.startDate).toISOString());
    if (!existing) {
      createSessionFromBooking(booking, memberId);
    } else if (['open', 'scheduled', 'failed'].includes(existing.status)) {
      adoptOwnBooking(existing, booking);
    }
    // 'booking' (run in progress) or 'booked' with another id: leave it
  }
}

/**
 * Someone opened the padel tab: pick up their HSP court bookings (cached request, at most 1/min)
 */
export async function syncMemberPadelBookings(memberId) {
  const token = getUser(memberId) ? await getValidUserToken(memberId) : null;
  if (!token) return;
  try {
    importPadelBookings(memberId, await getMemberBookings(token, memberId));
  } catch {
    // HSP not reachable - next time
  }
}

/**
 * Sessions that aren't marked booked, but whose slot holds a booking of their own players
 * (booked by hand in HSP): mark them booked. One public request for the whole range, then member
 * lookups only for slots that are actually taken.
 */
async function syncOwnBookings() {
  const now = Date.now();
  const candidates = sessions.filter(s =>
    ['open', 'scheduled', 'failed'].includes(s.status) && new Date(s.endDate).getTime() > now);
  if (candidates.length === 0) return [];

  const from = new Date(Math.min(...candidates.map(s => new Date(s.startDate).getTime())));
  const to = new Date(Math.max(...candidates.map(s => new Date(s.endDate).getTime())));
  const taken = await fetchCourtBookings(from, to);

  for (const session of candidates) {
    const start = new Date(session.startDate);
    const end = new Date(session.endDate);
    const booking = taken.find(b => b.linkedProductId === PADEL_PRODUCT_ID
      && new Date(b.startDate) < end && new Date(b.endDate) > start
      && !sessions.some(s => s.hspBookingId === b.id)); // already linked to another session
    if (!booking) continue;
    const own = await findOwnBooking(session, booking);
    // Status may have changed while we were asking HSP
    if (own && ['open', 'scheduled', 'failed'].includes(session.status)) adoptOwnBooking(session, own);
  }
  return taken;
}

/**
 * Checks the member's padel bookings against the HSP limits (per day / per period).
 * The exact HSP counting window isn't documented, so the period limit is checked as a rolling
 * window: every periodDays-long window that contains the slot day must still have room. That also
 * catches bookings made earlier for days *after* the slot. It is deliberately conservative - an
 * 'over' player is only tried last, never skipped.
 *
 * Returns { state: 'ok' | 'over' | 'unknown', note }
 */
async function checkQuota(token, memberId, slotStart, ignoreBookingId = null) {
  const day = berlinParts(slotStart);
  const dayStart = berlinToUtc(day.year, day.month, day.day);
  const dayEnd = berlinToUtc(day.year, day.month, day.day + 1);
  const P = rules.periodDays;
  const rangeStart = berlinToUtc(day.year, day.month, day.day - (P - 1));
  const rangeEnd = berlinToUtc(day.year, day.month, day.day + P);

  try {
    const result = await getMemberPadelBookings(token, memberId);
    if (!result.ok) return { state: 'unknown', note: `Kontingent nicht prüfbar (${result.status})` };

    const relevant = result.bookings
      .filter(b => b.id !== ignoreBookingId)
      .filter(b => {
        const t = new Date(b.startDate).getTime();
        return t >= rangeStart.getTime() && t < rangeEnd.getTime();
      })
      .filter(b => b.participations?.some(p =>
        (p.memberId === memberId || p.invitedMemberId === memberId) && p.status === 1));
    const starts = relevant.map(b => new Date(b.startDate).getTime());

    // A booking this member made themselves that isn't over yet blocks their membership
    const active = relevant
      .filter(b => b.participations.some(p => p.memberId === memberId && p.status === 1))
      .filter(b => new Date(b.endDate).getTime() > Date.now())
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    if (active) {
      return { state: 'busy', note: activeBookingNote(active.startDate) };
    }

    const sameDay = starts.filter(t => t >= dayStart.getTime() && t < dayEnd.getTime()).length;
    if (sameDay >= rules.maxPerDay) {
      return { state: 'over', note: `schon ${sameDay} Buchung(en) an dem Tag` };
    }

    for (let offset = -(P - 1); offset <= 0; offset++) {
      const windowStart = berlinToUtc(day.year, day.month, day.day + offset).getTime();
      const windowEnd = berlinToUtc(day.year, day.month, day.day + offset + P).getTime();
      const count = starts.filter(t => t >= windowStart && t < windowEnd).length;
      if (count >= rules.maxPerPeriod) {
        return { state: 'over', note: `schon ${count} Buchungen innerhalb von ${P} Tagen` };
      }
    }
    return { state: 'ok', note: null };
  } catch (error) {
    return { state: 'unknown', note: `Kontingent nicht prüfbar (${error.message})` };
  }
}

// ============ BOOKER SELECTION ============

function bookingHistory(memberId) {
  const cutoff = Date.now() - FAIRNESS_DAYS * 24 * 60 * 60 * 1000;
  const booked = sessions.filter(s => s.bookedBy === memberId && s.bookedAt && new Date(s.bookedAt).getTime() > cutoff);
  const last = booked.map(s => s.bookedAt).sort().pop() || '';
  return { count: booked.length, last };
}

// Booker states: 'ok' (token + membership + quota), 'unknown' (something not checkable),
// 'over' (quota probably used up), 'busy' (membership already used by another upcoming padel
// booking), 'noCard' (no membership that allows booking), 'noToken' (no usable HSP token / no account)
const BOOKER_STATE_ORDER = { ok: 0, unknown: 1, over: 2, busy: 3, noCard: 4, noToken: 5 };

function activeBookingNote(startDate) {
  return `hat schon eine offene Padel-Buchung (${formatBerlin(startDate)}) – HSP erlaubt pro Mitgliedschaft nur eine gleichzeitig`;
}

/**
 * HSP allows only one upcoming booking per membership (maxSimultaneousPerPerson = 1 on every linked
 * subscription): a member who booked another slot through the bot can't book again until it's over.
 */
function activeBotBooking(memberId, excludeSessionId) {
  return sessions
    .filter(s => s.id !== excludeSessionId && s.status === 'booked' && s.bookedBy === memberId)
    .filter(s => new Date(s.endDate).getTime() > Date.now())
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null;
}
const canProbablyBook = state => state === 'ok' || state === 'unknown';

// Everyone except 'noCard' may hold a membership (noToken: can't be checked, so give the benefit of the doubt)
const mayHoldCard = state => state !== 'noCard';
const cardHolderCount = players => players.filter(p => mayHoldCard(p.state)).length;

/**
 * Can this group book at all? Needs one player who can book and at least MIN_CARD_HOLDERS players
 * with a membership in total (the booker counts, so at least one invited player needs one too).
 */
function eligibilityOf(players) {
  const list = players.map(({ memberId, name, state, note }) => ({ memberId, name, state, note }));
  const enoughCards = cardHolderCount(list) >= MIN_CARD_HOLDERS;
  return {
    checkedAt: new Date().toISOString(),
    anyCanBook: enoughCards && list.some(p => canProbablyBook(p.state)),
    enoughCards,
    cardHolders: cardHolderCount(list),
    minCardHolders: MIN_CARD_HOLDERS,
    players: list
  };
}

const NOT_ENOUGH_CARDS = `zu wenige Spieler mit Mitgliedschaft (mind. ${MIN_CARD_HOLDERS})`;

// ============ MEMBERSHIP CHECK ============

const MEMBERSHIP_CACHE_MS = 15 * 60 * 1000;
const membershipCache = new Map(); // memberId -> { at, result }
let membershipShapeLogged = false;

const normalizeName = text => String(text ?? '').trim().toLowerCase();

/**
 * The response format of /subscribers/my-memberships isn't documented - accept the usual list
 * wrappers and the usual places for the subscription id/name. Returns null if unrecognizable.
 */
function parseMemberships(body) {
  const items = Array.isArray(body) ? body
    : ['data', 'items', 'results', 'memberships', 'subscribers'].map(k => body?.[k]).find(Array.isArray);
  if (!items) return null;

  return items.map(item => {
    const sub = item.subscription || item.membership || item.product || {};
    const ids = [item.subscriptionId, sub.id, item.membershipId]
      .map(Number).filter(id => Number.isInteger(id) && id > 0);
    const name = String(sub.description || sub.name || item.description || item.name || '').trim();
    const endDate = item.endDate || item.validUntil || item.endDateTime || null;
    return { ids, name, endDate };
  });
}

function findAccepted(memberships, accepted) {
  const names = new Set([...accepted.values()].map(normalizeName));
  return memberships.find(m => m.ids.some(id => accepted.has(id)) || (m.name && names.has(normalizeName(m.name))));
}

/**
 * Does the member hold an active membership that allows booking the padel court?
 * Returns { state: 'ok' | 'noCard' | 'unknown', note }
 */
async function checkMembership(token, memberId, slotStart) {
  const cached = membershipCache.get(memberId);
  let memberships;

  if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) {
    memberships = cached.memberships;
  } else {
    try {
      const res = await fetch(`${API_URL}/subscribers/my-memberships?membershipFilter=active&page=1&pageSize=50&memberIds=${memberId}`, {
        headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return { state: 'unknown', note: `Mitgliedschaft nicht prüfbar (${res.status})` };
      const body = await res.json();

      if (!membershipShapeLogged) {
        // Field names only (no values) to verify the parser against the real response
        const list = Array.isArray(body) ? body : Object.values(body || {}).find(Array.isArray);
        console.log(`🎾 my-memberships Antwort: top=${Array.isArray(body) ? 'array' : Object.keys(body || {}).join(',')} item=${list?.[0] ? Object.keys(list[0]).join(',') : '-'}`);
        membershipShapeLogged = true;
      }

      memberships = parseMemberships(body);
      if (!memberships) return { state: 'unknown', note: 'Mitgliedschaft nicht prüfbar (unbekanntes Format)' };
      membershipCache.set(memberId, { at: Date.now(), memberships });
    } catch (error) {
      return { state: 'unknown', note: `Mitgliedschaft nicht prüfbar (${error.message})` };
    }
  }

  // HSP accepts the rental's memberships for the court too (the booking dialog lists e.g. Sportpass Unlimited)
  const match = findAccepted(memberships, membershipRules.court) || findAccepted(memberships, membershipRules.rental);
  if (!match) {
    return { state: 'noCard', note: 'keine Mitgliedschaft, die Padel-Buchungen erlaubt' };
  }
  if (match.endDate && new Date(match.endDate).getTime() < new Date(slotStart).getTime()) {
    return { state: 'unknown', note: `Mitgliedschaft endet vor dem Termin (${formatBerlin(match.endDate)})` };
  }
  return { state: 'ok', note: null };
}

/**
 * Checks for every participant whether they could book this slot with their own HSP account
 */
async function checkBookers(session) {
  const results = [];
  for (const participant of session.participants) {
    const base = { memberId: participant.memberId, name: participant.name, joinedAt: participant.joinedAt };

    const token = getUser(participant.memberId) ? await getValidUserToken(participant.memberId) : null;
    if (!token) {
      results.push({ ...base, state: 'noToken', note: 'kein gültiger HSP-Token' });
      continue;
    }

    const membership = await checkMembership(token, participant.memberId, session.startDate);
    if (membership.state === 'noCard') {
      results.push({ ...base, state: 'noCard', note: membership.note });
      continue;
    }

    const ownBooking = activeBotBooking(participant.memberId, session.id);
    if (ownBooking) {
      results.push({ ...base, state: 'busy', note: activeBookingNote(ownBooking.startDate) });
      continue;
    }

    const quota = await checkQuota(token, participant.memberId, session.startDate, session.hspBookingId);
    // A definite quota problem wins; otherwise any uncertainty (membership or quota) makes it 'unknown'
    if (quota.state === 'busy' || quota.state === 'over' || (quota.state === 'ok' && membership.state === 'ok')) {
      results.push({ ...base, state: quota.state, note: quota.note });
    } else {
      results.push({ ...base, state: 'unknown', note: [membership.note, quota.note].filter(Boolean).join('; ') });
    }
  }
  return results;
}

/**
 * Forget cached memberships, e.g. after a member re-imported their token (maybe they just bought one)
 */
function clearMembershipCache(memberId) {
  membershipCache.delete(memberId);
}

/**
 * Best booker first: free quota > quota unknown > over quota, then booked least often / least
 * recently, then joined earliest. Players without a token are dropped.
 */
async function rankBookers(session) {
  const checked = await checkBookers(session);
  for (const c of checked.filter(c => c.state === 'noToken')) {
    addLog(session, `${c.name}: kein gültiger HSP-Token – übersprungen`);
  }

  const ranked = checked
    .filter(c => c.state !== 'noToken')
    .map(c => {
      const history = bookingHistory(c.memberId);
      return { ...c, recentBookings: history.count, lastBookedAt: history.last };
    });

  ranked.sort((a, b) =>
    (BOOKER_STATE_ORDER[a.state] - BOOKER_STATE_ORDER[b.state]) ||
    (a.recentBookings - b.recentBookings) ||
    a.lastBookedAt.localeCompare(b.lastBookedAt) ||
    a.joinedAt.localeCompare(b.joinedAt)
  );
  return { ranked, checked };
}

// ============ ELIGIBILITY (can anyone in the session book at all?) ============

const ELIGIBILITY_INTERVAL_MS = 30 * 60 * 1000;
const eligibilityChecks = new Map(); // sessionId -> running promise
const eligibilityRechecks = new Set(); // sessionIds that changed while a check was running

function describeBookers(players) {
  return players.map(p => `${p.name} – ${p.note}`).join(', ');
}

const SHORT_REASONS = { noToken: 'Token abgelaufen', noCard: 'keine Mitgliedschaft', over: 'Limit erreicht', busy: 'schon eine offene Buchung' };

// Why HSP turned a booker down for good (see classifyRejection)
const DROP_REASONS = { limit: 'Limit erreicht', auth: 'Token abgelaufen', subscription: 'Mitgliedschaft fehlt oder ist durch eine andere Buchung belegt' };

/**
 * One short line for the status when nobody could book, e.g. "Niemand konnte buchen (Limit erreicht)".
 * Who had which problem is shown on the player chips.
 */
function shortFailReason(players) {
  if (cardHolderCount(players) < MIN_CARD_HOLDERS) return `Niemand konnte buchen (${NOT_ENOUGH_CARDS})`;
  const reasons = [...new Set(players.map(p => SHORT_REASONS[p.state]).filter(Boolean))];
  return reasons.length > 0 ? `Niemand konnte buchen (${reasons.join(', ')})` : 'Niemand konnte buchen';
}

/**
 * Re-checks token + quota of all participants and stores the result on the session, so players
 * see *before* the booking window opens that nobody will be able to book.
 */
function refreshEligibility(session) {
  if (!['open', 'scheduled'].includes(session.status)) return Promise.resolve();
  if (eligibilityChecks.has(session.id)) {
    eligibilityRechecks.add(session.id);
    return eligibilityChecks.get(session.id);
  }

  const promise = (async () => {
    const checked = await checkBookers(session);
    if (!['open', 'scheduled'].includes(session.status)) return;

    const previous = session.eligibility;
    const eligibility = eligibilityOf(checked);
    const { anyCanBook, players } = eligibility;
    const changed = JSON.stringify(previous?.players) !== JSON.stringify(players);
    session.eligibility = eligibility;

    if (!changed) return;
    const blocked = players.filter(p => !canProbablyBook(p.state));
    if (!eligibility.enoughCards && players.length >= MIN_PLAYERS) {
      addLog(session, `⚠️ Buchung nicht möglich: ${NOT_ENOUGH_CARDS}${blocked.length ? ` – ${describeBookers(blocked)}` : ''}`);
    } else if (!anyCanBook && players.length > 0 && eligibility.enoughCards) {
      addLog(session, `⚠️ Aktuell kann voraussichtlich niemand buchen: ${describeBookers(blocked)}`);
    } else if (previous && !previous.anyCanBook && anyCanBook) {
      addLog(session, `Buchung wieder möglich über ${players.filter(p => canProbablyBook(p.state)).map(p => p.name).join(', ')}`);
    }
    touch(session);
  })()
    .catch(error => console.error(`Padel eligibility check failed (${session.id}):`, error))
    .finally(() => {
      eligibilityChecks.delete(session.id);
      if (eligibilityRechecks.delete(session.id)) refreshEligibility(session);
    });

  eligibilityChecks.set(session.id, promise);
  return promise;
}

function refreshAllEligibility() {
  for (const session of sessions.filter(s => ['open', 'scheduled'].includes(s.status))) {
    refreshEligibility(session);
  }
}

/**
 * Re-check all sessions a member is in (e.g. after they imported a fresh HSP token)
 */
export function refreshPadelEligibilityFor(memberId) {
  clearMembershipCache(memberId);
  for (const session of sessions) {
    if (session.participants.some(p => p.memberId === memberId)) refreshEligibility(session);
  }
}

// ============ AUTO RETRY (failed sessions whose slot became bookable again) ============

const AUTO_RETRY_INTERVAL_MS = 60 * 60 * 1000;   // background check
const VIEW_RECHECK_THROTTLE_MS = 5 * 60 * 1000;  // extra check when someone opens the padel tab
const AUTO_RETRY_COOLDOWN_MS = 60 * 60 * 1000;   // nothing changed since the failure: retry at most hourly
const AUTO_RETRY_MIN_LEAD_MS = 15 * 60 * 1000;   // don't start a run right before the slot
const MAX_AUTO_RETRIES = 5;                      // per session, reset by a manual retry

let lastFailedRecheckAt = 0;
let failedRecheck = null;

function failSession(session, reason, { slotTaken = false } = {}) {
  session.failure = { at: new Date().toISOString(), slotTaken };
  setStatus(session, 'failed', reason);
}

function isAutoRetryCandidate(session) {
  return session.status === 'failed'
    && new Date(session.startDate).getTime() > Date.now() + AUTO_RETRY_MIN_LEAD_MS
    && session.participants.length >= MIN_PLAYERS
    && (session.autoRetries || 0) < MAX_AUTO_RETRIES;
}

/**
 * Restarts a failed session once its slot is free and someone in it can probably book.
 * Cheap when nothing changed: one public GET per session, the player check only once the slot is free.
 */
async function recheckFailedSession(session, taken) {
  const start = new Date(session.startDate);
  const end = new Date(session.endDate);
  const blocker = taken.find(b => b.id !== session.hspBookingId && new Date(b.startDate) < end && new Date(b.endDate) > start);
  if (blocker || !isAutoRetryCandidate(session)) return;

  // The slot was free at the last failure too: don't hammer HSP with the same situation
  const failure = session.failure || {};
  const sinceFailure = Date.now() - new Date(failure.at || 0).getTime();
  if (!failure.slotTaken && sinceFailure < AUTO_RETRY_COOLDOWN_MS) return;

  const checked = await checkBookers(session);
  if (!isAutoRetryCandidate(session)) return; // changed while we were checking

  const eligibility = eligibilityOf(checked);
  const { anyCanBook, players } = eligibility;
  const changed = JSON.stringify(session.eligibility?.players) !== JSON.stringify(players);
  session.eligibility = eligibility;
  if (!anyCanBook) {
    if (changed) {
      const why = eligibility.enoughCards ? describeBookers(players) : NOT_ENOUGH_CARDS;
      addLog(session, `Platz ist frei, aber niemand kann buchen: ${why}`);
      touch(session);
    }
    return;
  }

  session.autoRetries = (session.autoRetries || 0) + 1;
  setStatus(session, 'open', failure.slotTaken
    ? 'Platz ist wieder frei – automatischer neuer Versuch'
    : 'Automatischer neuer Versuch');
  evaluateSession(session);
}

function recheckFailedSessions() {
  if (failedRecheck) return failedRecheck;
  lastFailedRecheckAt = Date.now();
  failedRecheck = (async () => {
    // One public request covers all sessions: first pick up bookings made by hand in HSP,
    // then restart failed sessions whose slot is free again
    let taken;
    try {
      taken = await syncOwnBookings();
    } catch {
      return; // HSP not reachable - next check
    }
    for (const session of sessions.filter(isAutoRetryCandidate)) {
      await recheckFailedSession(session, taken);
    }
  })()
    .catch(error => console.error('Padel failed-session recheck failed:', error))
    .finally(() => { failedRecheck = null; });
  return failedRecheck;
}

/**
 * Someone looks at the sessions - check failed ones again, but at most every few minutes
 */
function recheckFailedSessionsSoon() {
  if (Date.now() - lastFailedRecheckAt >= VIEW_RECHECK_THROTTLE_MS) recheckFailedSessions();
}

// ============ BOOKING RUN ============

/**
 * The slot is taken - if it's by the session's own players (e.g. booked by hand in HSP), mark the
 * session booked instead of failing. Returns true if adopted.
 */
async function adoptIfOwn(session, blocker) {
  const own = await findOwnBooking(session, blocker).catch(() => null);
  if (!own) return false;
  adoptOwnBooking(session, own);
  return true;
}

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

    const { ranked: candidates, checked } = await rankBookers(session);
    session.eligibility = eligibilityOf(checked);
    if (candidates.length === 0) {
      addLog(session, `Niemand konnte buchen: ${describeBookers(checked)}`);
      failSession(session, shortFailReason(checked));
      return;
    }

    // A slot that is already occupied (rental, course, staff block) can't be booked - don't even try
    const blocker = await findSlotBlocker(session);
    if (blocker && await adoptIfOwn(session, blocker)) return;
    if (blocker) {
      addLog(session, `Slot belegt durch HSP-Buchung ${blocker.id}${blocker.description ? ` („${blocker.description}“)` : ''} – keine Buchungsversuche`);
      failSession(session, blockerReason(blocker), { slotTaken: true });
      return;
    }

    // Players over quota are only tried once everyone else was rejected (or if there is nobody else)
    const preferred = candidates.filter(c => canProbablyBook(c.state));
    const fallback = candidates.filter(c => !canProbablyBook(c.state));
    let rotation = preferred.length > 0 ? preferred : fallback;
    if (preferred.length === 0) {
      addLog(session, `⚠️ Laut Prüfung hat niemand freies Kontingent (${describeBookers(fallback)}) – versuche es trotzdem`);
    }
    // The membership check is only an estimate (undocumented response format) - warn, but still try
    if (!session.eligibility.enoughCards) {
      addLog(session, `⚠️ Laut Prüfung ${NOT_ENOUGH_CARDS} – HSP lehnt die Buchung vermutlich ab, versuche es trotzdem`);
    }
    addLog(session, `Booker-Reihenfolge: ${candidates.map(c => c.note ? `${c.name} (${c.note})` : c.name).join(' → ')}`);
    touch(session);

    const opensAt = bookingOpensAt(session.startDate).getTime();
    const deadline = Math.max(opensAt, Date.now()) + POLL_WINDOW_MS;
    let index = 0;
    let attempts = 0;
    let lastMessage = '';
    let slotBlocker; // undefined = not checked yet, null = slot is free
    const loggedFailures = new Set(); // log each booker/error combination once
    const rejectedBookers = new Set();
    const droppedBookers = new Map(); // memberId -> 'limit' | 'auth' | 'unclear' - HSP said a definite no
    const unclearRejections = new Map(); // memberId -> count

    while (Date.now() < deadline) {
      // Everyone with quota was rejected - now also try the ones we thought were over quota
      if (rotation === preferred && fallback.length > 0 && preferred.every(c => rejectedBookers.has(c.memberId))) {
        rotation = [...preferred, ...fallback];
        addLog(session, `Alle mit freiem Kontingent abgelehnt – versuche auch ${fallback.map(c => c.name).join(', ')}`);
        touch(session);
      }
      const pool = rotation.filter(c => !droppedBookers.has(c.memberId));
      if (pool.length === 0) break; // nobody left who could still succeed

      const booker = pool[index % pool.length];
      const invited = session.participants.filter(p => p.memberId !== booker.memberId);
      attempts++;

      const result = await postSlotBooking(session, booker, invited);

      if (result.success) {
        session.bookedBy = booker.memberId;
        session.bookedByName = booker.name;
        session.bookedAt = new Date().toISOString();
        session.hspBookingId = result.bookingId;
        session.invitedMemberIds = invited.map(p => p.memberId);
        forgetMemberBookings(session.participants.map(p => p.memberId));
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
        rejectedBookers.add(booker.memberId);
        index++;

        let kind = classifyRejection(result);
        if (kind === 'blocked') {
          // "blocked by a booking on <date>" names only the day: it can be a booking on the slot
          // (nobody can book - stop) or the booker's own booking that day (only this booker is out)
          if (slotBlocker === undefined) slotBlocker = await findSlotBlocker(session);
          if (slotBlocker && await adoptIfOwn(session, slotBlocker)) return;
          if (slotBlocker) {
            lastMessage = result.message;
            break; // retrying a taken slot only burdens the HSP server
          }
          kind = 'limit';
        }
        if (kind === 'unclear') {
          const count = (unclearRejections.get(booker.memberId) || 0) + 1;
          unclearRejections.set(booker.memberId, count);
          if (count >= MAX_UNCLEAR_REJECTIONS) droppedBookers.set(booker.memberId, kind);
        } else {
          droppedBookers.set(booker.memberId, kind);
        }
      }
      lastMessage = result.message;
      const dense = Date.now() < opensAt + DENSE_WINDOW_MS;
      await sleep(dense ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS);
    }

    // Details (attempt count, raw HSP message) go to the log; the status line stays short
    addLog(session, `Abbruch nach ${attempts} Versuch(en), letzte Antwort: ${lastMessage}`);
    const drops = [...droppedBookers.values()];
    const everyoneDropped = rotation.every(c => droppedBookers.has(c.memberId));
    if (slotBlocker) {
      // The own-booking check already ran when slotBlocker was found
      failSession(session, blockerReason(slotBlocker), { slotTaken: true });
    } else if (everyoneDropped && drops.length > 0 && drops.every(kind => DROP_REASONS[kind])) {
      failSession(session, `Niemand konnte buchen (${[...new Set(drops.map(kind => DROP_REASONS[kind]))].join(', ')})`);
    } else {
      const blocker = await findSlotBlocker(session);
      if (blocker && await adoptIfOwn(session, blocker)) return;
      if (blocker) failSession(session, blockerReason(blocker), { slotTaken: true });
      else if (preferred.length === 0 || !session.eligibility.enoughCards) failSession(session, shortFailReason(checked));
      else failSession(session, 'HSP hat die Buchung abgelehnt');
    }
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
      failSession(session, `Interner Fehler: ${error.message}`);
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

// A failed session still owns its slot: it can be retried (also automatically), and a second
// session for the same slot would book it while the failed card still says "abgelehnt"
const SLOT_HOLDING_STATUSES = [...ACTIVE_STATUSES, 'failed'];

function sessionForSlot(startIso) {
  return sessions.find(s => s.startDate === startIso && SLOT_HOLDING_STATUSES.includes(s.status)) || null;
}

export async function getDaySlots(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) throw new Error('Ungültiges Datum');

  const taken = await fetchCourtBookings(berlinToUtc(year, month, day), berlinToUtc(year, month, day + 1));
  const slots = [];

  for (const minute of slotStartMinutes(year, month, day)) {
    const start = berlinToUtc(year, month, day, 0, minute);
    const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
    const session = sessionForSlot(start.toISOString());
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
  recheckFailedSessionsSoon(); // runs in the background, changes arrive via WebSocket
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
  const existing = sessionForSlot(startIso);
  if (existing) {
    return {
      error: existing.status === 'failed'
        ? 'Für diesen Slot gibt es schon eine fehlgeschlagene Session – tritt ihr bei und versuche es dort erneut'
        : 'Für diesen Slot gibt es schon eine Session – tritt ihr bei',
      sessionId: existing.id
    };
  }

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
  refreshEligibility(session);
  return { session: sessionView(session) };
}

export function joinSession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (!SLOT_HOLDING_STATUSES.includes(session.status)) return { error: `Session ist ${STATUS_LABELS[session.status].toLowerCase()}` };
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
    refreshEligibility(session);
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
    refreshEligibility(session);
  }
  return { session: sessionView(session) };
}

export function cancelSession(user, sessionId) {
  const session = findSession(sessionId);
  if (!session) return { error: 'Session nicht gefunden' };
  if (session.createdBy !== user.memberId) return { error: 'Nur der Ersteller kann die Session absagen' };
  if (!['open', 'scheduled', 'failed'].includes(session.status)) return { error: `Session ist ${STATUS_LABELS[session.status].toLowerCase()} und kann nicht mehr abgesagt werden` };

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

  session.autoRetries = 0;
  setStatus(session, 'open', `Neuer Versuch gestartet von ${user.name}`);
  evaluateSession(session);
  refreshEligibility(session);
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

/**
 * Failure texts from older versions were long (attempt counts, every player's reason) - shorten them
 * to the current format. The details are still in the session log.
 */
function shortenLegacyFailMessage(message = '') {
  if (message.includes('vermutlich hatte niemand freies Kontingent')) return 'Niemand konnte buchen (Limit erreicht)';
  if (/^Buchung nach \d+ Versuchen fehlgeschlagen/.test(message)) return 'HSP hat die Buchung abgelehnt';
  if (message === 'Platz wurde von jemand anderem gebucht') return 'Platz war schon vergeben';
  if (message === 'Kein Teilnehmer mit gültigem HSP-Token') return 'Niemand konnte buchen (Token abgelaufen)';
  if (message.startsWith('Niemand konnte buchen: ')) return 'Niemand konnte buchen';
  return message;
}

export async function initializePadel() {
  console.log('🎾 Initializing padel sessions...');
  await loadRules();
  sessions = loadSessions();

  for (const session of sessions) {
    if (session.status === 'failed') {
      session.statusMessage = shortenLegacyFailMessage(session.statusMessage);
    }
    // A booking run was interrupted by a restart - retry it
    if (session.status === 'booking') {
      session.status = 'open';
    }
    evaluateSession(session);
  }
  refreshAllEligibility();
  setInterval(refreshAllEligibility, ELIGIBILITY_INTERVAL_MS);
  recheckFailedSessions();
  setInterval(recheckFailedSessions, AUTO_RETRY_INTERVAL_MS);

  const active = sessions.filter(s => ['open', 'scheduled'].includes(s.status)).length;
  console.log(`🎾 Padel: ${active} offene Session(s), Slots öffnen ${rules.daysAhead} Tage vorher um ${rules.openTime}`);
}
