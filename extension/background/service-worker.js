import { testAuthentication } from '../src/auth/browser-session.js';
import { fetchBooking }       from '../src/api/bookings.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  if (request.action === 'TEST_AUTH') {
    testAuthentication()
      .then(sendResponse)
      .catch(() => sendResponse('UNKNOWN'));
    return true;
  }

  if (request.action === 'FETCH_BOOKING') {
    fetchBooking(request.bookingId)
      .then(data  => sendResponse({ ok: true,  data }))
      .catch(err  => sendResponse({
        ok:        false,
        error:     err.message  || 'Unknown error',
        errorType: err.type     || null,
        status:    err.status   || null,
      }));
    return true;
  }

});
