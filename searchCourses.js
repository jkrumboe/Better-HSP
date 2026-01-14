// searchCourses.js - Kurssuche mit flexiblen Filtern

const Volleyball_ID = 285;
const DAYS_OF_WEEK = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

async function fetchAllSports() {
  const filter = {
    allowAsLinkedProduct: true,
    isActive: 1
  };
  const encoded = encodeURIComponent(JSON.stringify(filter));
  const url = `https://backbone-web-api.production.munster.delcom.nl/products?s=${encoded}&limit=1000&sort=description,ASC`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        console.error('Fehler beim Laden der Sportarten:', res.status);
        return [];
    }
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    console.error('Fehler:', e);
    return [];
  }
}

async function findProducts(searchTerm) {
  const allSports = await fetchAllSports();
  const lowerTerm = searchTerm.toLowerCase();
  
  return allSports.filter(s => 
    s.description.toLowerCase().includes(lowerTerm)
  );
}

async function listAllSports() {
  console.log('Lade Liste aller Sportarten...');
  const sports = await fetchAllSports();
  
  console.log(`\nGefundene Sportarten: ${sports.length}\n`);
  sports.forEach(s => {
      console.log(`- ${s.description} (ID: ${s.id})`);
  });
  console.log('\nNutze "node searchCourses.js --course <NAME>" um Kurse zu suchen.');
}

function buildDateRange(startOffsetDays = 0, endOffsetDays = 8) {
  const start = new Date();
  start.setDate(start.getDate() + startOffsetDays);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setDate(end.getDate() + endOffsetDays);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function buildUrl({ page = 1, limit = 50, filter }) {
  const encoded = encodeURIComponent(JSON.stringify(filter));
  return `https://backbone-web-api.production.munster.delcom.nl/bookings?s=${encoded}&limit=${limit}&page=${page}&sort=startDate,ASC`;
}

async function fetchBookingsPage({ page = 1, limit = 50, filter }) {
  const url = buildUrl({ page, limit, filter });
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });

  if (!res.ok) {
    console.error('❌ Fehler beim Laden der Bookings:', res.status);
    console.error(await res.text());
    return [];
  }

  const data = await res.json();
  return data.data || [];
}

async function fetchBookings({ pages = 2, limit = 50, filter }) {
  const tasks = Array.from({ length: pages }, (_, idx) => fetchBookingsPage({ page: idx + 1, limit, filter }));
  const results = await Promise.all(tasks);
  return results.flat();
}

function parseLevel(description) {
  const match = description.match(/Level\s+(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function filterActivities(activities, { level, minAvailable }) {
  return activities.filter(a => {
    if (level !== undefined) {
      const courseLevel = parseLevel(a.description);
      if (courseLevel !== level) return false;
    }

    if (minAvailable !== undefined) {
      if (a.availableParticipantCount < minAvailable) return false;
    }

    return true;
  });
}

async function searchCourses({
  linkedProductIds = [Volleyball_ID],
  startOffsetDays = 0,
  endOffsetDays = 8,
  pages = 2,
  limit = 50,
  level,           // z.B. 1, 2, 3 für Level-Filter
  minAvailable,    // Mindestanzahl freier Plätze
  statusNot = 2    // 2 = abgesagt
} = {}) {
  const { start, end } = buildDateRange(startOffsetDays, endOffsetDays);

  const filter = {
    startDate: { "$gte": start.toISOString(), "$lte": end.toISOString() },
    linkedProductId: { "$in": linkedProductIds },
  };

  if (statusNot !== undefined) {
    filter.status = { "$ne": statusNot };
  }

  const bookings = await fetchBookings({ pages, limit, filter });
  const filtered = filterActivities(bookings, { level, minAvailable });

  // Fetch supervisor names
  let supervisorNames = {};
  if (filtered.length > 0) {
    try {
      const bookingIds = filtered.map(b => b.id).join(',');
      const supervisorUrl = `https://backbone-web-api.production.munster.delcom.nl/bookings/query/supervisorNamesByBookingId?bookingIds=${bookingIds}`;
      const res = await fetch(supervisorUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        supervisorNames = await res.json();
      }
    } catch (error) {
      console.error('Fehler beim Laden der Supervisor-Namen:', error);
    }
  }

  // Fetch location names from products
  let locationNames = {};
  if (filtered.length > 0) {
    try {
      const productIds = [...new Set(filtered.map(b => b.productId).filter(id => id))];
      if (productIds.length > 0) {
        const filter = { id: { "$in": productIds } };
        const encoded = encodeURIComponent(JSON.stringify(filter));
        const productsUrl = `https://backbone-web-api.production.munster.delcom.nl/products?s=${encoded}`;
        const res = await fetch(productsUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (res.ok) {
          const productsData = await res.json();
          productsData.data?.forEach(product => {
            locationNames[product.id] = product.description;
          });
        }
      }
    } catch (error) {
      console.error('Fehler beim Laden der Locations:', error);
    }
  }

  // Add supervisor names and locations to filtered bookings
  const now = new Date();
  filtered.forEach(booking => {
    booking.supervisors = supervisorNames[booking.id] || [];
    booking.location = locationNames[booking.productId] || booking.location || 'Unbekannt';
  });

  // Filter out past courses
  const futureCourses = filtered.filter(booking => new Date(booking.startDate) > now);

  return { bookings, filtered: futureCourses };
}

function formatCourse(course) {
  const date = new Date(course.startDate);
  const dayName = DAYS_OF_WEEK[date.getUTCDay()];
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = date.toLocaleDateString('de-DE');

  const location = course.location ? ` | ${course.location}` : '';
  const available = course.availableParticipantCount > 0 ? `✅ ${course.availableParticipantCount} frei` : '❌ Voll';
  const supervisors = course.supervisors && course.supervisors.length > 0 
    ? ` | 👤 ${course.supervisors.map(s => `${s.firstName} ${s.lastName}`).join(', ')}` 
    : '';

  return {
    id: course.id,
    display: `[${course.id}] ${dayName} ${time} (${dateStr})${location} | ${course.description} | ${available}${supervisors}`
  };
}

function printUsage() {
  console.log(`
📚 Kurssuche - Verwendung
========================

node searchCourses.js [--course NAME] [--list-sports] [--level LEVEL] [--min-available COUNT] [--days DAYS] [--help]

Parameter:
  --course NAME           Name des Sportkurses (z.B. "Volleyball", "Pilates")
  --list-sports           Listet alle verfügbaren Sportarten auf
  --level LEVEL           Filter nach Niveau (z.B. 1, 2, 3)
  --min-available COUNT   Nur Kurse mit mindestens COUNT freien Plätzen
  --days DAYS             Zeitraum in Tagen (Standard: 8)
  --help                  Diese Hilfe anzeigen

Beispiele:
  node searchCourses.js
  → Alle Volleyball-Kurse (Standard)

  node searchCourses.js --course Pilates
  → Alle Pilates-Kurse


  node searchCourses.js --level 3
  → Nur Level 3 Kurse

  node searchCourses.js --min-available 5
  → Nur Kurse mit mindestens 5 freien Plätzen

  node searchCourses.js --level 2 --days 14 --min-available 3
  → Level 2, nächste 14 Tage, mindestens 3 frei
  `);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    course: null,
    listSports: false,
    level: undefined,
    minAvailable: undefined,
    days: 8
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (arg === '--list-sports') {
      options.listSports = true;
    } else if (arg === '--course' && args[i + 1]) {
      options.course = args[++i];
    } else if (arg === '--level' && args[i + 1]) {
      options.level = parseInt(args[++i]);
    } else if (arg === '--min-available' && args[i + 1]) {
      options.minAvailable = parseInt(args[++i]);
    } else if (arg === '--days' && args[i + 1]) {
      options.days = parseInt(args[++i]);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (options.listSports) {
    await listAllSports();
    return;
  }

  let productIds = [Volleyball_ID];
  let courseName = 'Volleyball';

  if (options.course) {
    console.log(`🔍 Suche nach Sportart: "${options.course}"...`);
    let products = await findProducts(options.course);
    
    if (products.length === 0) {
       console.error(`Keine Sportart gefunden, die "${options.course}" enthält.`);
       return;
    }
    
    productIds = products.map(p => p.id);
    courseName = products.map(p => p.description).join(', ');
    console.log(`Gefundene Sportarten: ${products.map(p => `${p.description} (ID: ${p.id})`).join(', ')}\n`);
  } else {
    console.log('Suche nach Volleyball-Kursen (Standard). Nutze --course für andere Sportarten.\n');
  }

  const { bookings, filtered } = await searchCourses({
    linkedProductIds: productIds,
    startOffsetDays: 0,
    endOffsetDays: options.days,
    level: options.level,
    minAvailable: options.minAvailable,
    pages: 2,
  });

  console.log(`📊 Ergebnis: ${filtered.length} Kurse gefunden (von ${bookings.length} insgesamt)\n`);

  if (filtered.length === 0) {
    console.log('❌ Keine Kurse mit diesen Kriterien gefunden.\n');
    return;
  }

  // Sortiere nach Startdatum
  filtered.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  for (const course of filtered) {
    const { display } = formatCourse(course);
    console.log(display);
  }

  console.log(`\n💡 Tipp: node register-course-auto.js [memberId] <bookingId> [intervalSeconds] [maxAttempts]`);
}

main().catch(console.error);
