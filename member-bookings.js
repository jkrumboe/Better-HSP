/**
 * A member's own HSP bookings - courses and padel court rentals alike (HSP's "Meine Termine").
 * One request per member, shared by "Meine Buchungen" and the padel code (limit check, detecting
 * courts booked by hand in HSP).
 */

const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';
const PAST_DAYS = 30;           // "Meine Buchungen" shows the last 30 days
const CACHE_MS = 60 * 1000;

const cache = new Map(); // memberId -> { at, bookings }

/**
 * Bookings the member takes part in (booked themselves or invited, HSP stores those with
 * invitedMemberId), from 30 days ago on, with participations.
 * fresh: true skips the cache (e.g. when the member looks at their own bookings).
 * Throws on HSP errors; the error carries .status.
 */
export async function getMemberBookings(token, memberId, { fresh = false } = {}) {
  const cached = cache.get(memberId);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.bookings;

  const from = new Date();
  from.setDate(from.getDate() - PAST_DAYS);
  from.setHours(0, 0, 0, 0);

  const filter = {
    '$or': [
      { 'participations.memberId': memberId },
      { 'participations.invitedMemberId': memberId }
    ],
    startDate: { '$gte': from.toISOString() }
  };
  const encoded = encodeURIComponent(JSON.stringify(filter));
  const res = await fetch(`${API_URL}/bookings?s=${encoded}&join=participations&limit=100&page=1&sort=startDate,ASC`, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const error = new Error(`API Fehler: ${res.status}`);
    error.status = res.status;
    throw error;
  }

  const data = await res.json();
  const bookings = data.data || [];
  cache.set(memberId, { at: Date.now(), bookings });
  return bookings;
}

/**
 * The member's own participation in a booking (1 = booked, 3 = waiting list), or undefined
 */
export function participationOf(booking, memberId) {
  return booking.participations?.find(p => p.memberId === memberId || p.invitedMemberId === memberId);
}

/**
 * Bookings changed (booked, cancelled) - the next call asks HSP again
 */
export function forgetMemberBookings(memberIds) {
  for (const id of memberIds) cache.delete(id);
}
