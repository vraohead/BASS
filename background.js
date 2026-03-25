// background.js — BASS v5.1
// Handles fetch relay + async logging (never blocks the UI)

const APPS_SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbz1Ng1FExe3hfIgmoRiX5ENwb5LOLPQSC-3G1bYsEwfJmXoQgIpCvFCUSAEBjM3gNXmDw/exec";
const LOGGING_SHEET_URL = "https://script.google.com/a/macros/headout.com/s/AKfycbyIVELJuNXxJqSMYSxjFeRhW-DdyGCo4eULxKr0G7DWBXGkGerbacaf481lNsKpKVLi/exec";

// Cached identity — fetched once per service-worker lifetime
let cachedOwnerEmail = '';
let cachedOwnerName  = '';

// In-flight guard: prevents duplicate requests if user double-clicks
let fetchInFlight = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

// ── Message Handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'FETCH_BOOKING') {
    if (fetchInFlight) {
      sendResponse({ error: 'A fetch is already in progress.' });
      return true;
    }
    fetchInFlight = true;
    handleBookingFetch(request.bookingId)
      .then(result => {
        fetchInFlight = false;
        sendResponse(result);
        // Log asynchronously — never blocks the UI response
        logBookingResult(request.bookingId, result);
      })
      .catch(err => {
        fetchInFlight = false;
        sendResponse({ error: String(err) });
      });
    return true;
  }
});

// ── Core Fetch ─────────────────────────────────────────────────────────────
async function handleBookingFetch(bookingId) {
  if (!bookingId) return { error: 'Booking ID required' };

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ action: 'FETCH_BOOKING', bookingId }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { error: 'Request timed out — please try again.' };
    return { error: 'Network error: ' + err.message };
  }
}

// ── Async Logging — fire-and-forget, never blocks UI ──────────────────────
async function logBookingResult(bookingId, result) {
  try {
    // Lazy-fetch owner identity (cached after first call)
    if (!cachedOwnerEmail) await fetchOwnerIdentity();

    await fetch(LOGGING_SHEET_URL, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({
        action:     'LOG_BOOKING',
        bookingId,
        ticketId:   result?.ticket_id  || '',
        subject:    result?.subject    || '',
        success:    !!result?.success,
        error:      result?.error      || '',
        ownerEmail: cachedOwnerEmail,
        ownerName:  cachedOwnerName
      })
    });
  } catch (_) {
    // Logging failures are silent — never surface to the user
  }
}

// ── BMS Tab Monitoring ────────────────────────────────────────────────────
// Watches the active tab. When the user navigates to a BMS booking page,
// broadcasts the booking ID in that URL to the sidepanel for mismatch detection.

function extractBmsId(url) {
  try {
    const m = new URL(url).pathname.match(/\/bms\/booking\/(\d+)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function broadcastBmsTab(bmsBookingId) {
  chrome.runtime.sendMessage({ action: 'BMS_TAB_CHANGE', bmsBookingId: bmsBookingId || null }).catch(() => {});
}

chrome.tabs.onActivated.addListener(info => {
  chrome.tabs.get(info.tabId, tab => {
    if (chrome.runtime.lastError) return;
    broadcastBmsTab(extractBmsId(tab.url || ''));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active || changeInfo.status !== 'complete') return;
  broadcastBmsTab(extractBmsId(tab.url || ''));
});

async function fetchOwnerIdentity() {
  try {
    const r = await fetch(LOGGING_SHEET_URL, {
      method: 'POST', mode: 'cors', redirect: 'follow',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ action: 'GET_OWNER_EMAIL' })
    });
    if (r.ok) {
      const d = await r.json();
      cachedOwnerEmail = d.ownerEmail || '';
      cachedOwnerName  = d.ownerName  || '';
    }
  } catch (_) {}
}
