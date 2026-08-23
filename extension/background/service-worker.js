import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Direct fetch from the service worker — Chrome extensions bypass CORS for
// host_permissions URLs and share the browser's cookie jar, so BMS session
// cookies are attached automatically via credentials:'include'. No tab needed.

async function bmsApiFetch(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'x-platform': 'lego' },
    });
    clearTimeout(timer);
    let data = null, error = null;
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
  const result = await bmsApiFetch(url);
  if (!result.ok && result.status === 0) return { ...result, type: 'FETCH_ERROR' };
  if (result.status === 401) return { ...result, type: 'NOT_AUTHENTICATED',
    error: result.error || 'Not authenticated — log into Box Office.' };
  if (result.status === 403) return { ...result, type: 'SESSION_EXPIRED',
    error: result.error || 'Session expired — log into Box Office again.' };
  return result;
}

async function testAuthentication() {
  const result = await bmsApiCall(ENDPOINTS.booking('00000000'));
  if (result.type === 'FETCH_ERROR')       return 'TIMEOUT';
  if (result.type === 'NOT_AUTHENTICATED') return 'NOT_AUTHENTICATED';
  if (result.type === 'SESSION_EXPIRED')   return 'SESSION_EXPIRED';
  if (result.status > 0 || result.ok)     return 'AUTHENTICATED';
  return 'TIMEOUT';
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  if (request.action === 'CAPTURE_RESPONSE') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async tabs => {
      if (!tabs[0]) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => document.body.innerText,
        });
        sendResponse({ ok: true, text: results[0]?.result || '' });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }


  if (request.action === 'VERIFY_IMAGE') {
    const { imageBase64, mimeType, facts, workerUrl } = request;
    (async () => {
      try {
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64, mimeType, facts }),
        });
        const data = await res.json();
        sendResponse(res.ok ? { ok: true, ...data } : { ok: false, error: data.error || 'Worker error' });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'TEST_AUTH') {
    testAuthentication().then(sendResponse).catch(() => sendResponse('UNKNOWN'));
    return true;
  }

  if (request.action === 'FETCH_BOOKING') {
    const id = String(request.bookingId || '').trim();
    Promise.all([
      bmsApiCall(ENDPOINTS.booking(id)),
      bmsApiCall(ENDPOINTS.guestDetails(id)),
      bmsApiCall(ENDPOINTS.automationModal(id)),
    ]).then(([bookingResult, guestResult, modalResult]) => {
      if (!bookingResult.ok) {
        sendResponse({ ok: false, error: bookingResult.error, errorType: bookingResult.type, status: bookingResult.status });
      } else {
        const modalData = modalResult.ok ? modalResult.data : null;
        const showModal = modalData === true
          || modalData?.showAutomationFailureModal === true
          || modalData?.show === true;
        sendResponse({
          ok: true,
          data: bookingResult.data,
          guestData: guestResult.ok ? guestResult.data : null,
          showAutomationModal: showModal,
        });
      }
    }).catch(err => sendResponse({ ok: false, error: String(err), errorType: 'UNKNOWN' }));
    return true;
  }

});
