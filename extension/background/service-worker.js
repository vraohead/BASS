import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Content-script relay ─────────────────────────────────────────────────────
// All BMS API calls are routed through the content script injected into the
// Box Office tab. The content script runs in BMS's own origin context, so
// session cookies are included automatically — no cookie extraction needed.

async function findBmsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://box-office.headout.com/*' });
  return tabs[0] || null;
}

function sendToContentScript(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) {
        reject({ type: 'CONTENT_SCRIPT_ERROR', message: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

async function bmsApiCall(url) {
  const tab = await findBmsTab();
  if (!tab) {
    return { ok: false, status: null, type: 'NO_BMS_TAB',
      error: 'Open Box Office in a Chrome tab first, then try again.' };
  }
  try {
    const result = await sendToContentScript(tab.id, { action: 'BMS_FETCH', url });
    return result || { ok: false, status: null, type: 'NO_RESPONSE', error: 'No response from content script — refresh the Box Office tab.' };
  } catch (err) {
    // Content script not yet injected — user may need to refresh the BMS tab
    if (err.type === 'CONTENT_SCRIPT_ERROR') {
      return { ok: false, status: null, type: 'REFRESH_BMS_TAB',
        error: 'Refresh the Box Office tab, then try again.' };
    }
    return { ok: false, status: null, type: 'UNKNOWN', error: err.message };
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

async function testAuthentication() {
  const tab = await findBmsTab();
  if (!tab) return 'NO_BMS_TAB';

  // A 404 from the booking endpoint means authenticated (booking not found is fine).
  // 401/403 means session is invalid. Anything else we report UNKNOWN.
  const result = await bmsApiCall(ENDPOINTS.booking('00000000'));
  if (result.status === 404 || result.ok)   return 'AUTHENTICATED';
  if (result.status === 401)                return 'NOT_AUTHENTICATED';
  if (result.status === 403)                return 'SESSION_EXPIRED';
  if (result.type === 'NO_BMS_TAB')         return 'NO_BMS_TAB';
  if (result.type === 'REFRESH_BMS_TAB')    return 'REFRESH_BMS_TAB';
  return 'UNKNOWN';
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
