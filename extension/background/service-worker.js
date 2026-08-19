import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Content-script relay ─────────────────────────────────────────────────────
// All BMS API calls go through the content script in the Box Office tab.
// Content script runs in BMS's own origin so session cookies attach automatically.

async function findBmsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://box-office.headout.com/*' });
  return tabs[0] || null;
}

// Send a message to the content script with a 20-second hard timeout.
// If the script hasn't registered yet (tab just refreshed), inject it
// programmatically via chrome.scripting and retry once.
function sendToContentScript(tabId, msg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const doSend = (allowInject) => {
      const timer = setTimeout(() => {
        settle(reject, { type: 'TIMEOUT', message: 'Content script did not respond within 20 s.' });
      }, 20000);

      chrome.tabs.sendMessage(tabId, msg, response => {
        clearTimeout(timer);
        if (settled) return; // timer already fired

        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message || '';
          const notReady =
            err.includes('Receiving end does not exist') ||
            err.includes('Could not establish connection');

          if (allowInject && notReady) {
            // Inject the content script and retry once
            chrome.scripting.executeScript(
              { target: { tabId }, files: ['content/content.js'] },
              () => {
                if (chrome.runtime.lastError) {
                  settle(reject, { type: 'CONTENT_SCRIPT_ERROR', message: chrome.runtime.lastError.message });
                } else {
                  setTimeout(() => doSend(false), 150);
                }
              }
            );
          } else {
            settle(reject, { type: 'CONTENT_SCRIPT_ERROR', message: err });
          }
          return;
        }

        settle(resolve, response);
      });
    };

    doSend(true);
  });
}

async function bmsApiCall(url) {
  const tab = await findBmsTab();
  if (!tab) {
    return { ok: false, status: null, type: 'NO_BMS_TAB',
      error: 'Open box-office.headout.com in a Chrome tab first.' };
  }
  try {
    const result = await sendToContentScript(tab.id, { action: 'BMS_FETCH', url });
    if (!result) {
      return { ok: false, status: null, type: 'NO_RESPONSE',
        error: 'No response from content script — refresh the Box Office tab.' };
    }
    // Tag status:0 responses (fetch timeout or network error inside content script)
    if (!result.ok && result.status === 0) {
      return { ...result, type: 'FETCH_ERROR' };
    }
    return result;
  } catch (err) {
    if (err.type === 'TIMEOUT') {
      return { ok: false, status: null, type: 'TIMEOUT', error: err.message };
    }
    return { ok: false, status: null, type: 'REFRESH_BMS_TAB',
      error: 'Refresh the Box Office tab and try again.' };
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

async function testAuthentication() {
  const tab = await findBmsTab();
  if (!tab) return 'NO_BMS_TAB';

  const result = await bmsApiCall(ENDPOINTS.booking('00000000'));

  // Connection/injection errors first
  if (result.type === 'NO_BMS_TAB')      return 'NO_BMS_TAB';
  if (result.type === 'REFRESH_BMS_TAB') return 'REFRESH_BMS_TAB';
  if (result.type === 'NO_RESPONSE')     return 'REFRESH_BMS_TAB';
  if (result.type === 'TIMEOUT')         return 'TIMEOUT';
  if (result.type === 'FETCH_ERROR')     return 'TIMEOUT'; // content script fetch timed out

  // HTTP-level auth failures
  if (result.status === 401)             return 'NOT_AUTHENTICATED';
  if (result.status === 403)             return 'SESSION_EXPIRED';

  // Any real HTTP response (200, 400, 404, 422, 500 …) means:
  // - the content script is working
  // - the BMS server responded
  // - the session cookie was accepted (otherwise we'd get 401/403)
  if (result.status > 0 || result.ok)   return 'AUTHENTICATED';

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
