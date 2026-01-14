// scheduler.js - Smart scheduling for HSP course bookings

import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getValidToken, getStoredMemberInfo } from './token-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULED_JOBS_FILE = path.join(__dirname, 'data', 'scheduled-jobs.json');
const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

// Active scheduled jobs
const scheduledJobs = new Map();

// WebSocket connections for broadcasting
let wsConnections = new Set();

/**
 * Calculate when booking becomes available
 * Course on Monday 19:00 -> Booking available Tuesday (next day) 19:00, 6 days before
 * Actually: Booking opens 6 days before the course start at the same time
 */
function calculateBookingAvailableTime(courseStartTime) {
  const courseStart = new Date(courseStartTime);
  // Booking opens 6 days before course start at the same time
  const bookingAvailable = new Date(courseStart);
  bookingAvailable.setDate(bookingAvailable.getDate() - 6);
  return bookingAvailable;
}

/**
 * Calculate when to start polling
 * Random 0-10 second offset within the minute before booking is available
 */
function calculatePollingStartTime(bookingAvailableTime) {
  const bookingTime = new Date(bookingAvailableTime);
  // Start 25-30 seconds before booking is available
  const startWindow = new Date(bookingTime.getTime() - 30 * 1000); // 30 seconds before
  // Add random 0-5 second offset
  const randomOffset = Math.floor(Math.random() * 5) * 1000;
  return new Date(startWindow.getTime() + randomOffset);
}

/**
 * Calculate when to stop polling (5 seconds after booking available)
 */
function calculatePollingStopTime(bookingAvailableTime) {
  const bookingTime = new Date(bookingAvailableTime);
  return new Date(bookingTime.getTime() + 5 * 1000);
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
function broadcast(message) {
  const messageStr = JSON.stringify(message);
  wsConnections.forEach(ws => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(messageStr);
    }
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
  const token = await getValidToken();
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
  const { id, bookingId, courseStartTime, bookingAvailableAt } = jobData;
  
  console.log(`\n🚀 Starting scheduled job ${id} for booking ${bookingId}`);
  
  const memberInfo = getStoredMemberInfo();
  if (!memberInfo.memberId) {
    broadcast({
      type: 'scheduleError',
      jobId: id,
      message: 'Keine Member-ID gefunden'
    });
    updateJobStatus(id, 'failed', 'Keine Member-ID gefunden');
    return;
  }

  const bookingTime = new Date(bookingAvailableAt);
  const stopTime = calculatePollingStopTime(bookingTime);
  const pollInterval = 100; // 100ms polling interval for aggressive booking
  let attempts = 0;
  let success = false;

  broadcast({
    type: 'scheduleTriggered',
    jobId: id,
    bookingId,
    message: 'Geplante Buchung gestartet',
    bookingAvailableAt,
    stopTime: stopTime.toISOString()
  });

  updateJobStatus(id, 'running');

  // Polling loop
  const pollLoop = async () => {
    while (new Date() < stopTime && !success) {
      attempts++;
      
      const result = await attemptRegistration(id, bookingId, memberInfo.memberId);
      
      broadcast({
        type: 'scheduleAttempt',
        jobId: id,
        bookingId,
        attempt: attempts,
        ...result
      });

      if (result.success) {
        success = true;
        console.log(`✅ Scheduled job ${id} succeeded after ${attempts} attempts`);
        broadcast({
          type: 'scheduleCompleted',
          jobId: id,
          bookingId,
          success: true,
          totalAttempts: attempts,
          message: result.message
        });
        updateJobStatus(id, 'completed', 'Erfolgreich angemeldet');
        break;
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    if (!success) {
      console.log(`❌ Scheduled job ${id} failed after ${attempts} attempts`);
      broadcast({
        type: 'scheduleCompleted',
        jobId: id,
        bookingId,
        success: false,
        totalAttempts: attempts,
        message: 'Zeitfenster abgelaufen ohne erfolgreiche Anmeldung'
      });
      updateJobStatus(id, 'failed', 'Zeitfenster abgelaufen');
    }

    // Clean up the job from active map
    if (scheduledJobs.has(id)) {
      const job = scheduledJobs.get(id);
      if (job.scheduleJob) {
        job.scheduleJob.cancel();
      }
      scheduledJobs.delete(id);
    }
  };

  pollLoop();
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
export function scheduleBooking(bookingId, courseStartTime, courseDescription = '') {
  const id = `schedule-${bookingId}-${Date.now()}`;
  
  const bookingAvailableAt = calculateBookingAvailableTime(courseStartTime);
  const pollingStartAt = calculatePollingStartTime(bookingAvailableAt);
  const pollingStopAt = calculatePollingStopTime(bookingAvailableAt);
  
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
    bookingAvailableAt: bookingAvailableAt.toISOString(),
    pollingStartAt: pollingStartAt.toISOString(),
    pollingStopAt: pollingStopAt.toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  // Save to persistence
  const jobs = loadScheduledJobs();
  // Check for duplicates
  const existingJob = jobs.find(j => 
    j.bookingId === bookingId && 
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
export function getScheduledJobs() {
  const jobs = loadScheduledJobs();
  // Filter out old completed/failed jobs (older than 24 hours)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return jobs.filter(j => 
    j.status === 'pending' || 
    j.status === 'running' || 
    new Date(j.updatedAt || j.createdAt) > cutoff
  );
}

/**
 * Initialize scheduler - restore pending jobs on server start
 */
export function initializeScheduler() {
  console.log('📅 Initializing scheduler...');
  
  const jobs = loadScheduledJobs();
  const now = new Date();
  let restoredCount = 0;
  let cleanedCount = 0;

  jobs.forEach(jobData => {
    if (jobData.status !== 'pending') {
      return; // Skip non-pending jobs
    }

    const pollingStartAt = new Date(jobData.pollingStartAt);
    const pollingStopAt = new Date(jobData.pollingStopAt);

    if (now > pollingStopAt) {
      // Job window has passed, mark as missed
      updateJobStatus(jobData.id, 'missed', 'Zeitfenster verpasst (Server war offline)');
      cleanedCount++;
      return;
    }

    if (now >= pollingStartAt && now < pollingStopAt) {
      // We're in the polling window, start immediately
      console.log(`⚡ Restoring active job ${jobData.id}`);
      executeScheduledJob(jobData);
      restoredCount++;
    } else {
      // Schedule for future
      const job = schedule.scheduleJob(pollingStartAt, () => {
        executeScheduledJob(jobData);
      });
      
      scheduledJobs.set(jobData.id, {
        ...jobData,
        scheduleJob: job
      });
      
      console.log(`📅 Restored scheduled job ${jobData.id} for ${pollingStartAt.toISOString()}`);
      restoredCount++;
    }
  });

  console.log(`📅 Scheduler initialized: ${restoredCount} jobs restored, ${cleanedCount} expired jobs cleaned`);
}

/**
 * Get booking available time for a course (for UI display)
 */
export function getBookingInfo(courseStartTime) {
  const bookingAvailableAt = calculateBookingAvailableTime(courseStartTime);
  const pollingStartAt = calculatePollingStartTime(bookingAvailableAt);
  const pollingStopAt = calculatePollingStopTime(bookingAvailableAt);
  
  return {
    bookingAvailableAt: bookingAvailableAt.toISOString(),
    pollingStartAt: pollingStartAt.toISOString(),
    pollingStopAt: pollingStopAt.toISOString(),
    isInPast: new Date() > pollingStopAt,
    isInWindow: new Date() >= pollingStartAt && new Date() < pollingStopAt
  };
}
