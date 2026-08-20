// Injected into https://box-office.headout.com/* pages.
// Runs in the page's own origin context so session cookies attach automatically.
//
// NOTE: content scripts don't support ES module imports, so BMS_HEADERS is
// duplicated here. Keep it in sync with src/api/bms.js DEFAULT_HEADERS.
const BMS_HEADERS = { 'x-platform': 'lego' };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'BMS_FETCH') return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  fetch(msg.url, {
    method: msg.method || 'GET',
    credentials: 'include',
    signal: controller.signal,
    headers: { ...BMS_HEADERS, ...(msg.headers || {}) },
  })
  .then(async res => {
    clearTimeout(timer);
    let data = null;
    let error = null;
    try {
      data = await res.json();
      // Try to surface a human-readable error from the response body
      if (!res.ok) {
        error = data?.error || data?.message || data?.errorMessage
          || data?.errors?.[0]?.message || null;
      }
    } catch (_) {}
    sendResponse({ ok: res.ok, status: res.status, data, error });
  })
  .catch(err => {
    clearTimeout(timer);
    sendResponse({
      ok: false, status: 0, data: null,
      error: err.name === 'AbortError' ? 'Request timed out (15 s)' : err.message,
    });
  });

  return true; // keep message channel open for async response
});
