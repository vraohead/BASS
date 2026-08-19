import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Content-script relay ─────────────────────────────────────────────────────
// All BMS API calls go through the content script in the Box Office tab.
// The content script runs in BMS's own origin so session cookies attach automatically.

async function findBmsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://box-office.headout.com/*' });
  return tabs[0] || null;
}

// Send a message to the content script. If the script isn't registered yet
// (tab just refreshed), inject it programmatically and retry once.
function sendToContentScript(tabId, msg) {
  return new Promise((resolve, reject) => {
    trySend(tabId, msg, resolve, reject, /* allowInject */ true);
  });
}

function trySend(tabId, msg, resolve, reject, allowInject) {
  // Overall 20-second hard timeout (covers network latency in content script fetch)
  const timer = setTimeout(() => {
    reject({ type: 'TIMEOUT', message: 'Content script did not respond within 20 s.' });
  }, 20000);

  chrome.tabs.sendMessage(tabId, msg, response => {
    clearTimeout(timer);

    if (chrome.runtime.lastError) {
      const err = chrome.runtime.lastError.message || '';
      const notReady =
        err.includes('Receiving end does not exist') ||
        err.includes('Could not establish connection');

      if (allowInject && notReady) {
        // Content script hasn't registered yet — inject it then retry
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content/content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              reject({ type: 'CONTENT_SCRIPT_ERROR', message: chrome.runtime.lastError.message });
            } else {
              // Brief pause for the listener to register before retrying
              setTimeout(() => trySend(tabId, msg, resolve, reject, false), 150);
            }
          }
        );
      } else {
        reject({ type: 'CONTENT_SCRIPT_ERROR', message: err });
      }
      return;
    }

    resolve(response);
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
    return result || { ok: false, status: null, type: 'NO_RESPONSE',
      error: 'No response from content script — refresh the Box Office tab.' };
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

  // 404 = endpoint reached (booking not found is fine), confirms session is valid.
  // 401/403 = not authenticated / session expired.
  const result = await bmsApiCall(ENDPOINTS.booking('00000000'));
  if (result.ok || result.status === 404) return 'AUTHENTICATED';
  if (result.status === 401)              return 'NOT_AUTHENTICATED';
  if (result.status === 403)              return 'SESSION_EXPIRED';
  if (result.type === 'NO_BMS_TAB')       return 'NO_BMS_TAB';
  if (result.type === 'TIMEOUT')          return 'TIMEOUT';
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
