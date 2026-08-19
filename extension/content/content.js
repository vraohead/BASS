// Injected into https://box-office.headout.com/* pages.
// Runs in the page's own origin context so session cookies attach automatically.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'BMS_FETCH') return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  fetch(msg.url, {
    method: msg.method || 'GET',
    credentials: 'include',
    signal: controller.signal,
    headers: { 'x-platform': 'lego', ...(msg.headers || {}) },
  })
  .then(async res => {
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    sendResponse({ ok: res.ok, status: res.status, data });
  })
  .catch(err => {
    clearTimeout(timer);
    sendResponse({
      ok: false, status: 0,
      error: err.name === 'AbortError' ? 'Request timed out (15s)' : err.message,
    });
  });

  return true; // keep channel open for async response
});
