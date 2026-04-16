// server.js - Express Server mit WebSocket für HSP-Bot GUI

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Importiere die bestehenden Module
import { getValidToken, getStoredMemberInfo, loadTokens, saveTokens, getTokenInfo, decodeToken } from './token-manager.js';
import { 
  initializeScheduler, 
  scheduleBooking, 
  cancelScheduledJob, 
  getScheduledJobs, 
  registerWebSocket,
  getBookingInfo 
} from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';
const Volleyball_ID = 285;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
        memberId: job.memberId
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
function broadcastPolling(message) {
  const messageStr = JSON.stringify(message);
  pollingWsConnections.forEach(ws => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(messageStr);
    }
  });
}

/**
 * Send a polling message: broadcast to all WS clients + buffer in job log
 */
function sendJobMessage(jobId, job, message) {
  // Buffer the message in the job's log
  if (!job.log) job.log = [];
  job.log.push({ ...message, timestamp: new Date().toISOString() });
  if (job.log.length > MAX_JOB_LOG_ENTRIES) {
    job.log = job.log.slice(-MAX_JOB_LOG_ENTRIES);
  }
  // Broadcast to all connected clients
  broadcastPolling(message);
}

// ============ API ENDPOINTS ============

// Status-Check
app.get('/api/status', (req, res) => {
  const memberInfo = getStoredMemberInfo();
  const tokens = loadTokens();
  let tokenInfo = null;
  
  if (tokens.accessToken) {
    tokenInfo = getTokenInfo(tokens.accessToken);
  }

  res.json({
    authenticated: !!tokens.accessToken,
    member: memberInfo,
    tokenInfo: tokenInfo ? {
      email: tokenInfo.email,
      name: tokenInfo.name,
      expiresAt: tokenInfo.expiresAt,
      remainingText: tokenInfo.remainingText,
      isValid: tokenInfo.isValid
    } : null,
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

// Auth-Daten importieren
app.post('/api/auth/import', async (req, res) => {
  try {
    let authData = req.body;
    const skipServerFix = authData._skipServerFix;

    if (!skipServerFix) {
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

    if (!authData || !authData.tokenResponse || !authData.member) {
      return res.status(400).json({ error: 'Ungültige Auth-Daten. Bitte kompletten JSON-Inhalt einfügen.' });
    }

    const tokenResponse = authData.tokenResponse;
    const member = authData.member;

    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Speichere auth-data.json
    fs.writeFileSync(path.join(dataDir, 'auth-data.json'), JSON.stringify(authData, null, 2));

    // Speichere in token-store.json
    saveTokens({
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      idToken: tokenResponse.idToken,
      expiresIn: tokenResponse.expiresIn,
      memberId: member.id,
      memberEmail: member.email,
      memberName: `${member.firstName || ''} ${member.lastName || ''}`.trim()
    });

    res.json({
      success: true,
      member: {
        id: member.id,
        email: member.email,
        name: `${member.firstName || ''} ${member.lastName || ''}`.trim()
      }
    });
  } catch (error) {
    console.error('Auth-Import Fehler:', error);
    res.status(500).json({ error: error.message });
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
    const { days = 8, level, minAvailable, sportId } = req.query;

    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setDate(end.getDate() + parseInt(days));
    end.setHours(23, 59, 59, 999);

    let linkedProductIds = [Volleyball_ID];
    
    // If sportId provided, use it
    if (sportId) {
      linkedProductIds = [parseInt(sportId)];
    }

    const filter = {
      startDate: { "$gte": start.toISOString(), "$lte": end.toISOString() },
      linkedProductId: { "$in": linkedProductIds },
      status: { "$ne": 2 }
    };

    const encoded = encodeURIComponent(JSON.stringify(filter));
    const url = `${API_URL}/bookings?s=${encoded}&limit=100&page=1&sort=startDate,ASC`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`API Fehler: ${response.status}`);
    }

    const data = await response.json();
    let courses = data.data || [];

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
    const memberInfo = getStoredMemberInfo();
    if (memberInfo && memberInfo.memberId && courses.length > 0) {
      try {
        const token = await getValidToken();
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
    const formatted = courses.map(c => ({
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

    res.json({ courses: formatted, total: formatted.length });
  } catch (error) {
    console.error('Kurse laden Fehler:', error);
    res.status(500).json({ error: error.message });
  }
});

// Einmalige Anmeldung
app.post('/api/register', async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'bookingId erforderlich' });
    }

    const token = await getValidToken();
    if (!token) {
      return res.status(401).json({ error: 'Nicht authentifiziert. Bitte Token importieren.' });
    }

    const memberInfo = getStoredMemberInfo();
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
      
      res.json({
        success: !isWaitlist,
        isWaitlist: isWaitlist,
        message: isWaitlist ? 'Auf Warteliste gesetzt' : 'Erfolgreich angemeldet!',
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

// Polling Job starten
app.post('/api/register/polling', (req, res) => {
  const { bookingId, intervalSeconds = 60, maxAttempts } = req.body;

  if (!bookingId) {
    return res.status(400).json({ error: 'bookingId erforderlich' });
  }

  const jobId = `${bookingId}-${Date.now()}`;
  
  res.json({
    success: true,
    jobId,
    message: `Polling-Job gestartet. Verbinde via WebSocket für Updates.`
  });
});

// Polling Job stoppen
app.post('/api/register/stop', (req, res) => {
  const { jobId } = req.body;

  if (activePollingJobs.has(jobId)) {
    const job = activePollingJobs.get(jobId);
    clearInterval(job.interval);
    activePollingJobs.delete(jobId);
    res.json({ success: true, message: 'Job gestoppt' });
  } else {
    res.status(404).json({ error: 'Job nicht gefunden' });
  }
});

// Aktive Jobs abrufen (inkl. gepufferter Logs für reconnect)
app.get('/api/jobs', (req, res) => {
  const jobs = [];
  activePollingJobs.forEach((job, id) => {
    jobs.push({
      id,
      bookingId: job.bookingId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      intervalSeconds: job.intervalSeconds,
      startedAt: job.startedAt,
      lastAttempt: job.lastAttempt,
      log: job.log || []
    });
  });
  res.json({ jobs });
});

// ============ SCHEDULING ENDPOINTS ============

// Get booking availability info for a course
app.get('/api/schedule/info', (req, res) => {
  const { courseStartTime } = req.query;
  
  if (!courseStartTime) {
    return res.status(400).json({ error: 'courseStartTime erforderlich' });
  }
  
  try {
    const info = getBookingInfo(courseStartTime);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule a booking
app.post('/api/schedule', (req, res) => {
  const { bookingId, courseStartTime, courseDescription } = req.body;
  
  if (!bookingId || !courseStartTime) {
    return res.status(400).json({ error: 'bookingId und courseStartTime erforderlich' });
  }
  
  const memberInfo = getStoredMemberInfo();
  if (!memberInfo.memberId) {
    return res.status(401).json({ error: 'Nicht authentifiziert. Bitte Token importieren.' });
  }
  
  const result = scheduleBooking(bookingId, courseStartTime, courseDescription);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Get all scheduled jobs
app.get('/api/schedule', (req, res) => {
  const jobs = getScheduledJobs();
  res.json({ jobs });
});

// Cancel a scheduled job
app.delete('/api/schedule/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  const result = cancelScheduledJob(jobId);
  
  if (result.success) {
    res.json({ success: true, message: 'Geplante Buchung abgebrochen' });
  } else {
    res.status(404).json({ error: result.error });
  }
});

// ============ WEBSOCKET ============

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket Client verbunden');
  
  // Register WebSocket for scheduler broadcasts
  registerWebSocket(ws);

  // Register for polling broadcasts
  pollingWsConnections.add(ws);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'startPolling') {
        await handlePollingStart(ws, data);
      } else if (data.type === 'stopPolling') {
        handlePollingStop(ws, data.jobId);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket Client getrennt');
    pollingWsConnections.delete(ws);
  });
});

async function handlePollingStart(ws, data) {
  const { bookingId, intervalSeconds = 1000, maxAttempts } = data;
  const jobId = `${bookingId}-${Date.now()}`;

  const token = await getValidToken();
  if (!token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Nicht authentifiziert' }));
    return;
  }

  const memberInfo = getStoredMemberInfo();
  if (!memberInfo.memberId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Keine Member-ID' }));
    return;
  }

  startPollingJob(jobId, bookingId, intervalSeconds, maxAttempts, memberInfo.memberId);
}

/**
 * Start a polling job (decoupled from WebSocket — works even without connected clients)
 */
function startPollingJob(jobId, bookingId, intervalSeconds, maxAttempts, memberId) {
  const job = {
    bookingId,
    intervalSeconds,
    maxAttempts: maxAttempts || null,
    attempts: 0,
    startedAt: new Date().toISOString(),
    lastAttempt: null,
    memberId,
    log: [],
    interval: null
  };

  activePollingJobs.set(jobId, job);
  savePollingJobs();

  const startMsg = {
    type: 'jobStarted',
    jobId,
    bookingId,
    intervalSeconds,
    maxAttempts: maxAttempts || 'unbegrenzt'
  };
  sendJobMessage(jobId, job, startMsg);

  // Ersten Versuch sofort starten
  attemptRegistration(jobId, job, memberId);

  // Polling Interval
  job.interval = setInterval(async () => {
    await attemptRegistration(jobId, job, memberId);
  }, intervalSeconds);
}

async function attemptRegistration(jobId, job, memberId) {
  job.attempts++;
  job.lastAttempt = new Date().toISOString();
  // Persist updated attempt count every 10 attempts
  if (job.attempts % 10 === 0) savePollingJobs();

  const token = await getValidToken();
  if (!token) {
    sendJobMessage(jobId, job, {
      type: 'attempt',
      jobId,
      attempt: job.attempts,
      success: false,
      message: 'Token abgelaufen'
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
      
      // Job nur bei echter Anmeldung beenden, bei Warteliste weiter versuchen
      if (!isWaitlist) {
        clearInterval(job.interval);
        sendJobMessage(jobId, job, {
          type: 'jobCompleted',
          jobId,
          success: true,
          totalAttempts: job.attempts
        });
        activePollingJobs.delete(jobId);
        savePollingJobs();
      }
    } else if (response.status === 429) {
      sendJobMessage(jobId, job, {
        type: 'attempt',
        jobId,
        attempt: job.attempts,
        success: false,
        rateLimited: true,
        message: 'Rate-Limit erreicht, warte...'
      });
    } else {
      sendJobMessage(jobId, job, {
        type: 'attempt',
        jobId,
        attempt: job.attempts,
        success: false,
        status: response.status,
        message: responseData.message || 'Anmeldung fehlgeschlagen'
      });
    }

    // Max Attempts Check
    if (job.maxAttempts && job.attempts >= job.maxAttempts) {
      clearInterval(job.interval);
      sendJobMessage(jobId, job, {
        type: 'jobCompleted',
        jobId,
        success: false,
        message: `Max. Versuche (${job.maxAttempts}) erreicht`,
        totalAttempts: job.attempts
      });
      activePollingJobs.delete(jobId);
      savePollingJobs();
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

function handlePollingStop(ws, jobId) {
  if (activePollingJobs.has(jobId)) {
    const job = activePollingJobs.get(jobId);
    clearInterval(job.interval);
    sendJobMessage(jobId, job, {
      type: 'jobStopped',
      jobId,
      totalAttempts: job.attempts
    });
    activePollingJobs.delete(jobId);
    savePollingJobs();
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Job nicht gefunden'
    }));
  }
}

/**
 * Restore polling jobs from disk after server restart
 */
function restorePollingJobs() {
  const savedJobs = loadPollingJobs();
  if (savedJobs.length === 0) return;

  console.log(`🔄 Stelle ${savedJobs.length} Polling-Job(s) wieder her...`);
  for (const saved of savedJobs) {
    startPollingJob(saved.id, saved.bookingId, saved.intervalSeconds, saved.maxAttempts, saved.memberId);
    // Restore attempt count from saved state
    const job = activePollingJobs.get(saved.id);
    if (job) {
      job.attempts = saved.attempts || 0;
      job.startedAt = saved.startedAt;
    }
  }
}

// Server starten
server.listen(PORT, () => {
  console.log(`\n🚀 HSP-Bot Backend Server läuft auf http://localhost:${PORT}`);
  console.log(`📡 WebSocket bereit für Live-Updates`);
  
  // Initialize the scheduler and restore pending jobs
  initializeScheduler();

  // Restore polling jobs from disk
  restorePollingJobs();
  console.log('');
});
