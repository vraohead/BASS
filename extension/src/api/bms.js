// Centralised BMS/Box Office API endpoint definitions.
// All URLs go through the Box Office proxy, which handles auth, routing, and CORS.
// DO NOT scatter endpoint strings through UI code — always add new endpoints here.

export const BMS_BASE = 'https://box-office.headout.com';

export const ENDPOINTS = {
  // Phase 1 — read-only booking data
  booking:     (id) => `${BMS_BASE}/proxy/aries/apis/v2/order-fulfillment/booking/${id}`,

  // Phase 2 — to be discovered from Box Office network traffic
  // fulfilment:  (id) => `${BMS_BASE}/proxy/aries/...`,
  // tickets:     (id) => `${BMS_BASE}/proxy/aries/...`,
  // vendor:      (id) => `${BMS_BASE}/proxy/aries/...`,
  // cancellation:(id) => `${BMS_BASE}/proxy/aries/...`,
};

// Headers observed in Box Office requests.
// Extend after inspecting DevTools network traffic for additional required headers.
export const DEFAULT_HEADERS = {
  'x-platform': 'lego',
};
