// background.js — BASS v5.3
// Handles fetch relay + ticket-verification relay + deep-link BID detection
// + async logging (never blocks the UI)

const APPS_SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbz1Ng1FExe3hfIgmoRiX5ENwb5LOLPQSC-3G1bYsEwfJmXoQgIpCvFCUSAEBjM3gNXmDw/exec";
const LOGGING_SHEET_URL = "https://script.google.com/a/macros/headout.com/s/AKfycbyIVELJuNXxJqSMYSxjFeRhW-DdyGCo4eULxKr0G7DWBXGkGerbacaf481lNsKpKVLi/exec";

// Cached identity — fetched once per service-worker lifetime
let cachedOwnerEmail = '';
let cachedOwnerName  = '';

// In-flight guard: prevents duplicate requests if user double-clicks
let fetchInFlight = false;

// ── Custom email + password authentication (BASS session tokens) ────────────
// Associates log in with their @headout.com email + a password (stored hashed on
// the backend sheet). A successful login mints a 24h HMAC-signed session token,
// which we keep in chrome.storage.local ('bassSession') and replay on every
// backend call. Access is gated by *identity* (a live login), not by the
// shipped, non-secret /exec URL.
const SESSION_KEY = 'bassSession';

function getSession() {
  return new Promise(res => {
    try { chrome.storage.local.get(SESSION_KEY, r => res((r && r[SESSION_KEY]) || null)); }
    catch (_) { res(null); }
  });
}
function setSession(sess) {
  return new Promise(res => {
    try { chrome.storage.local.set({ [SESSION_KEY]: sess }, res); } catch (_) { res(); }
  });
}
function clearSession() {
  return new Promise(res => {
    try { chrome.storage.local.remove(SESSION_KEY, res); } catch (_) { res(); }
  });
}
function sessionValid(s) {
  return !!(s && s.token && s.expiresAt && Date.now() < s.expiresAt);
}

// Generic POST to the Apps Script backend (no auth attached). Used for LOGIN /
// SIGNUP, which are how a session is obtained in the first place.
async function postBackend(payload, timeoutMs, timeoutMsg) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { error: timeoutMsg || 'Request timed out — please try again.' };
    return { error: 'Network error: ' + err.message };
  }
}

// Authenticated POST: requires a valid stored session and attaches its token. If
// the backend reports the session is no longer valid (needLogin), the stored
// session is cleared so the UI re-prompts for login.
async function postToAppsScript(payload, timeoutMs, timeoutMsg) {
  const s = await getSession();
  if (!sessionValid(s)) {
    return { error: 'Please log in to BASS to continue.', needLogin: true };
  }
  const result = await postBackend(
    Object.assign({}, payload, { sessionToken: s.token }), timeoutMs, timeoutMsg
  );
  if (result && result.needLogin) { await clearSession(); }
  return result;
}

// ── Display modes ──────────────────────────────────────────────────────────
// BASS can show up three ways (stored in chrome.storage.local as displayMode):
//   'panel'  — docked side panel (default; Chrome opens it on icon click)
//   'window' — a detached, movable/resizable popup window
//   'float'  — a draggable/resizable overlay injected into the active page
// In side-panel mode openPanelOnActionClick=true lets Chrome open the panel for
// us; in the other modes that flag is off and chrome.action.onClicked fires so
// we can open the chosen container instead.
const DEFAULT_WINDOW_BOUNDS = { width: 460, height: 760, left: 80, top: 80 };
let bassWindowId = null;

chrome.runtime.onInstalled.addListener(() => { applyModeBehavior(); });
chrome.runtime.onStartup.addListener(() => { applyModeBehavior(); });

chrome.action.onClicked.addListener(tab => {
  getDisplayMode().then(mode => {
    if (mode === 'window') openBassWindow();
    else if (mode === 'float') openFloatOverlay(tab);
    // 'panel' is handled natively by openPanelOnActionClick.
  });
});

// ── Message Handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ── Auth: login / signup / logout / session status ──────────────────────
  if (request.action === 'LOGIN' || request.action === 'SIGNUP') {
    postBackend(
      { action: request.action, email: request.email, password: request.password },
      20000,
      'Sign-in timed out — please try again.'
    ).then(async result => {
      if (result && result.success && result.sessionToken) {
        await setSession({ token: result.sessionToken, email: result.email, expiresAt: result.expiresAt });
      }
      sendResponse(result);
    }).catch(err => sendResponse({ error: String(err) }));
    return true;
  }
  // ── Password reset (pre-auth) ───────────────────────────────────────────
  // REQUEST_RESET emails a code; RESET_PASSWORD verifies it, sets a new password
  // and (on success) returns a fresh session token we store to auto-log-in.
  if (request.action === 'REQUEST_RESET') {
    postBackend(
      { action: 'REQUEST_RESET', email: request.email },
      20000,
      'Request timed out — please try again.'
    ).then(sendResponse).catch(err => sendResponse({ error: String(err) }));
    return true;
  }
  if (request.action === 'RESET_PASSWORD') {
    postBackend(
      { action: 'RESET_PASSWORD', email: request.email, code: request.code, password: request.password },
      20000,
      'Request timed out — please try again.'
    ).then(async result => {
      if (result && result.success && result.sessionToken) {
        await setSession({ token: result.sessionToken, email: result.email, expiresAt: result.expiresAt });
      }
      sendResponse(result);
    }).catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  if (request.action === 'GET_SESSION') {
    getSession().then(s => sendResponse({
      loggedIn: sessionValid(s), email: s ? s.email : '', expiresAt: s ? s.expiresAt : 0
    }));
    return true;
  }
  if (request.action === 'LOGOUT') {
    clearSession().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === 'FETCH_BOOKING') {
    // Silent (background) refreshes bypass the single-flight lock so they never
    // block — or get blocked by — a user-initiated fetch for another booking.
    // The side panel's _currentBid supersede guard discards any stale result.
    if (request.silent) {
      handleBookingFetch(request.bookingId)
        .then(result => { sendResponse(result); logBookingResult(request.bookingId, result); })
        .catch(err => sendResponse({ error: String(err) }));
      return true;
    }
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

  if (request.action === 'VERIFY_TICKET') {
    handleVerifyTicket(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  // Capture the underlying browser tab for window/float modes (the side panel
  // captures directly via activeTab, so it never sends this).
  if (request.action === 'CAPTURE_TAB') {
    handleCaptureTab(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }

  // Persist the chosen display mode and open the matching container.
  if (request.action === 'SET_DISPLAY_MODE') {
    handleSetDisplayMode(request.mode)
      .then(sendResponse)
      .catch(err => sendResponse({ error: String(err) }));
    return true;
  }
});

// ── Core Fetch ─────────────────────────────────────────────────────────────
async function handleBookingFetch(bookingId) {
  if (!bookingId) return { error: 'Booking ID required' };
  return postToAppsScript(
    { action: 'FETCH_BOOKING', bookingId },
    12000,
    'Request timed out — please try again.'
  );
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

// ── Tab BID Monitoring (deep-link auto-load) ──────────────────────────────
// Watches the active tab and detects a Booking ID from two link styles:
//   1. the BMS booking path   …/bms/booking/<BID>
//   2. a generic query param  ?bassBid=<BID>  (can be appended to any page)
// The detected BID is broadcast to the side panel (which auto-loads it) and
// persisted as `pendingBid` so a panel opened later — via the icon — can pick
// it up. Reading tab URLs only needs the existing "tabs" permission, so no
// extra host permissions are required for the generic param to work anywhere.

function extractBid(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/bms\/booking\/(\d+)/);
    if (m) return m[1];
    const q = (u.searchParams.get('bassBid') || '').trim();
    if (/^\d+$/.test(q)) return q;
    return null;
  } catch (_) { return null; }
}

function broadcastTabBid(bid) {
  const id = bid || null;
  // Remember the latest detected BID until a panel opens and consumes it.
  if (id) { try { chrome.storage.local.set({ pendingBid: id }); } catch (_) {} }
  chrome.runtime.sendMessage({ action: 'BMS_TAB_CHANGE', bmsBookingId: id }).catch(() => {});
}

chrome.tabs.onActivated.addListener(info => {
  chrome.tabs.get(info.tabId, tab => {
    if (chrome.runtime.lastError) return;
    broadcastTabBid(extractBid(tab.url || ''));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active || changeInfo.status !== 'complete') return;
  broadcastTabBid(extractBid(tab.url || ''));
});

// ── Ticket Verification relay ───────────────────────────────────────────────
// Forwards the screenshot + expected booking fields to the Apps Script
// VERIFY_TICKET action. The vision-model key lives in Apps Script properties —
// never in the extension. Vision calls are slow, so allow a longer timeout.
async function handleVerifyTicket(request) {
  if (!request || !request.image) return { error: 'Screenshot required' };
  return postToAppsScript(
    { action: 'VERIFY_TICKET', image: request.image, expected: request.expected || {} },
    50000,
    'Verification timed out — please try again.'
  );
}

let ownerIdentityPromise = null;
async function fetchOwnerIdentity() {
  // Coalesce concurrent callers onto a single request so a burst of
  // logBookingResult calls before the cache is warm fires only one fetch.
  // Cleared on completion so a later call can retry if this one failed.
  if (ownerIdentityPromise) return ownerIdentityPromise;
  ownerIdentityPromise = (async () => {
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
  })();
  try { return await ownerIdentityPromise; }
  finally { ownerIdentityPromise = null; }
}

// ── Display-mode helpers ────────────────────────────────────────────────────
function getDisplayMode() {
  return new Promise(res => {
    try { chrome.storage.local.get('displayMode', r => res((r && r.displayMode) || 'panel')); }
    catch (_) { res('panel'); }
  });
}

function getStored(key, dflt) {
  return new Promise(res => {
    try { chrome.storage.local.get(key, r => res((r && r[key]) || dflt)); }
    catch (_) { res(dflt); }
  });
}

// Toolbar icon opens the side panel only in 'panel' mode; otherwise onClicked
// fires and we open the chosen window/overlay ourselves.
async function applyModeBehavior() {
  const mode = await getDisplayMode();
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode === 'panel' }); } catch (_) {}
}

// The active tab of the page the associate was last looking at — never the BASS
// popup. In window mode the detached BASS popup is the focused window, so we
// prefer the most-recently-focused *normal* window (the SP-portal), falling back
// to scanning all windows. This is what window/float modes capture/inject into.
async function getTargetTab() {
  try {
    let win = null;
    try { win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] }); } catch (_) {}
    if (!win || win.type !== 'normal' || !win.tabs) {
      const wins = await chrome.windows.getAll({ populate: true });
      const normal = wins.filter(w => w.type === 'normal');
      win = normal.find(w => w.focused) || normal[0];
    }
    if (!win || !win.tabs) return null;
    return win.tabs.find(t => t.active) || win.tabs[0] || null;
  } catch (_) { return null; }
}

// Survive a service-worker restart (bassWindowId is lost): re-find an existing
// BASS popup by its URL before creating a new one.
async function findExistingBassWindow() {
  const base = chrome.runtime.getURL('sidepanel.html');
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.type !== 'popup' || !w.tabs) continue;
      if (w.tabs.some(t => (t.url || '').indexOf(base) === 0)) return w.id;
    }
  } catch (_) {}
  return null;
}

async function openBassWindow() {
  let id = bassWindowId;
  if (id == null) id = await findExistingBassWindow();
  if (id != null) {
    try { await chrome.windows.update(id, { focused: true }); bassWindowId = id; return; }
    catch (_) { bassWindowId = null; }
  }
  const b = await getStored('windowBounds', DEFAULT_WINDOW_BOUNDS);
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html?mode=window'),
      type: 'popup',
      width: b.width, height: b.height, left: b.left, top: b.top
    });
    bassWindowId = win.id;
  } catch (_) {}
}

async function injectFloat(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['float.js'] });
    return true;
  } catch (_) { return false; }
}

async function openFloatOverlay(tab) {
  const t = (tab && tab.id) ? tab : await getTargetTab();
  if (!t || !t.id || !/^https?:/.test(t.url || '')) return false;
  return injectFloat(t.id);
}

async function handleSetDisplayMode(mode) {
  if (mode !== 'panel' && mode !== 'window' && mode !== 'float') return { error: 'Unknown mode' };
  await new Promise(res => { try { chrome.storage.local.set({ displayMode: mode }, res); } catch (_) { res(); } });
  await applyModeBehavior();
  if (mode === 'window') { await openBassWindow(); return { ok: true, opened: true }; }
  if (mode === 'float') {
    const t = await getTargetTab();
    if (!t || !/^https?:/.test(t.url || '')) return { ok: true, opened: false, reason: 'restricted' };
    const ok = await injectFloat(t.id);
    return { ok: true, opened: ok, reason: ok ? '' : 'inject-failed' };
  }
  return { ok: true, opened: false }; // panel: opened via the toolbar icon
}

function captureWindowTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 }, dataUrl => {
      const e = chrome.runtime.lastError;
      if (e || !dataUrl) reject(new Error(e ? e.message : 'No image captured'));
      else resolve(dataUrl);
    });
  });
}

async function handleCaptureTab(request) {
  const t = await getTargetTab();
  if (!t) return { error: 'No active browser tab to capture.' };
  const isFloat = request && request.mode === 'float';
  // Hide the floating overlay so BASS itself isn't in the screenshot.
  if (isFloat) {
    try { await chrome.tabs.sendMessage(t.id, { action: 'FLOAT_SET_VISIBLE', visible: false }); } catch (_) {}
    // Give the overlay time to actually hide and the page to repaint before the
    // capture, so BASS itself never lands in the screenshot.
    await new Promise(r => setTimeout(r, 250));
  }
  let img = null, err = null;
  try { img = await captureWindowTab(t.windowId); } catch (e) { err = e; }
  if (isFloat) {
    try { await chrome.tabs.sendMessage(t.id, { action: 'FLOAT_SET_VISIBLE', visible: true }); } catch (_) {}
  }
  if (err || !img) {
    return { error: 'Couldn\u2019t capture the tab' + (err ? ' (' + err.message + ')' : '') +
      '. Make sure the SP-portal details are visible' +
      (isFloat ? '.' : ', and that you\u2019ve granted BASS access to this site.') };
  }
  return { image: img };
}

// Remember the BASS popup's size/position so it reopens where it was left.
chrome.windows.onRemoved.addListener(id => { if (id === bassWindowId) bassWindowId = null; });
if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(win => {
    if (win.id !== bassWindowId) return;
    try {
      chrome.storage.local.set({
        windowBounds: { width: win.width, height: win.height, left: win.left, top: win.top }
      });
    } catch (_) {}
  });
}
