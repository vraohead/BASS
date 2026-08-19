import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── BMS API calls via executeScript ──────────────────────────────────────────
// We inject an inline async function into the BMS tab instead of using a
// persistent content script + message passing. This avoids all timing issues:
// - No need to wait for document_idle to register a listener
// - No stale listeners after extension reload
// - Works immediately on any already-open BMS tab
// The injected function runs in the tab's isolated world with the page's
// origin, so session cookies are included automatically (same-origin fetch).

async function findBmsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://box-office.headout.com/*' });
  return tabs[0] || null;
}

// The fetch function injected into the BMS tab.
// Must be a self-contained function (no closures over external vars).
async function bmsTabFetch(fetchUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(fetchUrl, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'x-platform': 'lego' },
    });
    clearTimeout(timer);
    let data = null;
    let error = null;
    try {
      data = await res.json();
      if (!res.ok) {
        error = data?.error || data?.message || data?.errorMessage
          || data?.errors?.[0]?.message || null;
      }
    } catch (_) {}
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    return {
      ok: false, status: 0, data: null,
      error: err.name === 'AbortError' ? 'Request timed out (15 s)' : err.message,
    };
  }
}

async function bmsApiCall(url) {
  const tab = await findBmsTab();
  if (!tab) {
    return { ok: false, status: null, type: 'NO_BMS_TAB',
      error: 'Open box-office.headout.com in a Chrome tab first.' };
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: bmsTabFetch,
      args: [url],
    });
  } catch (err) {
    return { ok: false, status: null, type: 'REFRESH_BMS_TAB',
      error: 'Could not run in Box Office tab — refresh it and try again. (' + err.message + ')' };
  }

  const result = results?.[0]?.result;
  if (!result) {
    return { ok: false, status: null, type: 'NO_RESPONSE',
      error: 'No response from Box Office tab — refresh it and try again.' };
  }

  if (!result.ok && result.status === 0) {
    return { ...result, type: 'FETCH_ERROR' };
  }
  if (result.status === 401) {
    return { ...result, type: 'NOT_AUTHENTICATED',
      error: result.error || 'Not authenticated — log into Box Office.' };
  }
  if (result.status === 403) {
    return { ...result, type: 'SESSION_EXPIRED',
      error: result.error || 'Session expired — log into Box Office again.' };
  }
  return result;
}

// ── Auth check ───────────────────────────────────────────────────────────────

async function testAuthentication() {
  const tab = await findBmsTab();
  if (!tab) return 'NO_BMS_TAB';

  const result = await bmsApiCall(ENDPOINTS.booking('00000000'));

  if (result.type === 'NO_BMS_TAB')        return 'NO_BMS_TAB';
  if (result.type === 'REFRESH_BMS_TAB')   return 'REFRESH_BMS_TAB';
  if (result.type === 'NO_RESPONSE')       return 'REFRESH_BMS_TAB';
  if (result.type === 'TIMEOUT')           return 'TIMEOUT';
  if (result.type === 'FETCH_ERROR')       return 'TIMEOUT';
  if (result.type === 'NOT_AUTHENTICATED') return 'NOT_AUTHENTICATED';
  if (result.type === 'SESSION_EXPIRED')   return 'SESSION_EXPIRED';

  // Any real HTTP response = content script working + session valid
  if (result.status > 0 || result.ok)     return 'AUTHENTICATED';

  return 'REFRESH_BMS_TAB';
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  if (request.action === 'TEST_AUTH') {
    testAuthentication().then(sendResponse).catch(() => sendResponse('UNKNOWN'));
    return true;
  }

  if (request.action === 'FETCH_BOOKING') {
    const url = ENDPOINTS.booking(String(request.bookingId || '').trim());
    bmsApiCall(url)
      .then(result => {
        if (!result.ok) {
          sendResponse({ ok: false, error: result.error, errorType: result.type, status: result.status });
        } else {
          sendResponse({ ok: true, data: result.data });
        }
      })
      .catch(err => sendResponse({ ok: false, error: String(err), errorType: 'UNKNOWN' }));
    return true;
  }

});
