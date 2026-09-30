import { ENDPOINTS } from '../src/api/bms.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Sent as X-Extension-Secret on every call to the Worker's /verify,
// /confirm-flag, /record-fetch, and /verify-code — must match the
// EXTENSION_SHARED_SECRET Cloudflare secret exactly (generate a shared value
// with `openssl rand -hex 32` and set it in both places). This is a soft
// barrier, not a real secret: anyone who unpacks this extension can read it
// here. Its purpose is to stop casual/automated internet-wide abuse of the
// Worker's public URL (scripts that never looked at this code), not a
// targeted attacker — the Worker's CORS restriction (ALLOWED_EXTENSION_ORIGIN)
// and rate limiting are the other two independent layers on those routes.
const EXTENSION_SHARED_SECRET = 'Vivek@567*98';

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
    let data = null, error = null, parseFailed = false;
    try {
      data = await res.json();
      if (!res.ok) {
        error = data?.error || data?.message || data?.errorMessage
          || data?.errors?.[0]?.message || null;
      }
    } catch (_) {
      parseFailed = true;
    }
    return { ok: res.ok, status: res.status, data, error, parseFailed, redirected: res.redirected };
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
  // A logged-out session often gets redirected to the login page instead of
  // an API 401/403 — that comes back as an HTTP 200 whose body isn't valid
  // JSON. Treat that as logged-out rather than a real successful response.
  if (result.ok && result.parseFailed) return { ...result, ok: false, type: 'NOT_AUTHENTICATED',
    error: 'Not authenticated — log into Box Office.' };
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

  if (request.action === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async tabs => {
      if (!tabs[0]) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' });
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (request.action === 'CAPTURE_RESPONSE') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async tabs => {
      if (!tabs[0]) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      try {
        // Every frame, not just the top one (checkout widgets often live in
        // iframes), plus the current values of inputs/selects — those are
        // not part of innerText, and a chosen date or guest count is often
        // only there. Password/card-style fields are never read.
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id, allFrames: true },
          func: () => {
            const text = document.body ? document.body.innerText : '';
            const fields = [];
            document.querySelectorAll('input, select, textarea').forEach(el => {
              const type = (el.type || '').toLowerCase();
              if (['password', 'hidden', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) return;
              const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
              if (ac.startsWith('cc-') || /card|cvv|cvc|iban|ssn|passw/i.test((el.name || '') + ' ' + (el.id || ''))) return;
              let value = '';
              if (el.tagName === 'SELECT') value = el.options[el.selectedIndex]?.text || '';
              else if (type === 'checkbox' || type === 'radio') { if (!el.checked) return; value = el.value || 'checked'; }
              else value = el.value || '';
              value = String(value).trim();
              if (!value) return;
              const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.name || el.id || el.placeholder || type;
              fields.push(String(label).trim().slice(0, 60) + ': ' + value.slice(0, 120));
            });
            return { text, fields };
          },
        });
        const frames = results.map(r => r?.result).filter(Boolean);
        const texts = frames.map(f => (f.text || '').trim()).filter(Boolean);
        const fields = frames.flatMap(f => f.fields || []);
        let text = texts.join('\n\n--- another frame ---\n\n');
        if (fields.length) text += '\n\n--- Form values (currently selected/typed) ---\n' + fields.join('\n');
        sendResponse({ ok: true, text: text.slice(0, 30000) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }


  // Handles both code kinds — the worker tells us via adminMode which pool
  // (if either) matched: true for a redeemed one-time admin code, false
  // for the shared daily code.
  if (request.action === 'VERIFY_CODE') {
    const { code, workerUrl } = request;
    (async () => {
      try {
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/verify-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Extension-Secret': EXTENSION_SHARED_SECRET },
          body: JSON.stringify({ code }),
        });
        const data = await res.json().catch(() => ({}));
        sendResponse(res.ok
          ? { ok: true, valid: !!data.valid, adminMode: !!data.adminMode }
          : { ok: false, error: data.error || 'Worker error' });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'VERIFY_IMAGE') {
    const { imageBase64, mimeType, facts, bookingId, agentEmail, vendor, workerUrl, pageText } = request;
    (async () => {
      try {
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Extension-Secret': EXTENSION_SHARED_SECRET },
          body: JSON.stringify({ imageBase64, mimeType, facts, bookingId, agentEmail, vendor, pageText }),
        });
        const data = await res.json();
        sendResponse(res.ok
          ? { ok: true, ...data }
          : { ok: false, error: data.error || 'Worker error', raw: data.raw, steps: data.steps });
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
    (async () => {
      try {
        const [bookingResult, guestResult, modalResult] = await Promise.all([
          bmsApiCall(ENDPOINTS.booking(id)),
          bmsApiCall(ENDPOINTS.guestDetails(id)),
          bmsApiCall(ENDPOINTS.automationModal(id)),
        ]);

        if (!bookingResult.ok) {
          sendResponse({ ok: false, error: bookingResult.error, errorType: bookingResult.type, status: bookingResult.status });
          return;
        }

        const modalData = modalResult.ok ? modalResult.data : null;
        const showModal = modalData === true
          || modalData?.showAutomationFailureModal === true
          || modalData?.show === true;

        // Vendor-tour records carry each vendor's important/manual-fulfilment instructions
        const flat = bookingResult.data.booking || bookingResult.data.fulfillmentDetails || bookingResult.data;
        const vendors = bookingResult.data.vendorsInfo || flat.vendorsInfo || [];
        const vendorTourResults = await Promise.all(
          vendors.map(v => {
            const vendorId = v.vendorId;
            const tourId = v.tourId || flat.tourId;
            if (!vendorId || !tourId) return Promise.resolve(null);
            return bmsApiCall(ENDPOINTS.vendorTour(vendorId, tourId));
          })
        );
        // The Calipso API returns an array (usually one matching record) — unwrap it
        const vendorTourData = vendorTourResults.map(r => {
          if (!r || !r.ok) return null;
          const d = r.data;
          return Array.isArray(d) ? (d[0] || null) : d;
        });

        sendResponse({
          ok: true,
          data: bookingResult.data,
          guestData: guestResult.ok ? guestResult.data : null,
          showAutomationModal: showModal,
          vendorTourData,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err), errorType: 'UNKNOWN' });
      }
    })();
    return true;
  }

  if (request.action === 'SEND_VERIFY_FLAG') {
    // No BMS endpoint exists for this yet — posts to Slack via the Cloudflare
    // worker instead (chat.postMessage + screenshot upload). Swap back to a
    // direct BMS call once/if that endpoint is built.
    const { bookingId, agentEmail, confirmed, skipped, overridden, retroactive, imageBase64, mimeType, verifiedAt, workerUrl, vendor, product, vendorId, tourId, pageType } = request;
    (async () => {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20000);
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/confirm-flag`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Extension-Secret': EXTENSION_SHARED_SECRET },
          body: JSON.stringify({ bookingId, agentEmail, confirmed, skipped, overridden, retroactive, imageBase64, mimeType, verifiedAt, vendor, product, vendorId, tourId, pageType }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          sendResponse({ ok: true, screenshotError: data.screenshotError || null, steps: data.steps });
        } else {
          sendResponse({ ok: false, error: data?.error || `HTTP ${res.status}`, steps: data?.steps });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'RECORD_FETCH') {
    // Fire-and-forget usage log — logged the instant a booking is pulled up,
    // before any verification runs. Never blocks the UI on this.
    const { bookingId, agentEmail, workerUrl } = request;
    (async () => {
      try {
        await fetch(`${workerUrl.replace(/\/$/, '')}/record-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Extension-Secret': EXTENSION_SHARED_SECRET },
          body: JSON.stringify({ bookingId, agentEmail }),
        });
      } catch (_) {
        // Best-effort only — a failed log write should never surface to the agent.
      }
    })();
    return false;
  }

});
