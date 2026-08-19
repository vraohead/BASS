// Injected into https://box-office.headout.com/* pages.
// Runs in the page's own origin context, so session cookies are sent automatically.
// The service worker routes all BMS API calls here via chrome.tabs.sendMessage.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== 'BMS_FETCH') return;

  fetch(msg.url, {
    method: msg.method || 'GET',
    credentials: 'include',
    headers: {
      'x-platform': 'lego',
      ...(msg.headers || {}),
    },
  })
  .then(async res => {
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}
    sendResponse({ ok: res.ok, status, data });
  })
  .catch(err => {
    sendResponse({ ok: false, status: 0, error: err.message });
  });

  return true; // keep message channel open for async response
});
