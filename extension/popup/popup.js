// Field display config: map known API keys → human labels.
// Extend as more API response fields are discovered.
const FIELD_MAP = [
  // Top-level booking fields (adjust keys after inspecting real API responses)
  { key: 'bookingId',         label: 'Booking ID' },
  { key: 'status',            label: 'Status' },
  { key: 'fulfilmentType',    label: 'Fulfilment Type' },
  { key: 'fulfilmentStatus',  label: 'Fulfilment Status' },
  { key: 'productName',       label: 'Product' },
  { key: 'variantName',       label: 'Variant' },
  { key: 'inventoryDate',     label: 'Inventory Date' },
  { key: 'inventoryTime',     label: 'Inventory Time' },
  { key: 'ticketType',        label: 'Ticket Type' },
  { key: 'totalPax',          label: 'Total Pax' },
  { key: 'netPrice',          label: 'Net Price' },
  { key: 'currency',          label: 'Currency' },
  { key: 'guestName',         label: 'Guest Name' },
  { key: 'guestEmail',        label: 'Guest Email' },
  { key: 'createdAt',         label: 'Created At' },
  { key: 'updatedAt',         label: 'Updated At' },
];

const $ = (id) => document.getElementById(id);

// ── Auth check ───────────────────────────────────────────────────────────────

async function checkAuth() {
  const badge   = $('auth-badge');
  const warning = $('auth-warning');
  const input   = $('booking-id');
  const btn     = $('search-btn');

  const status = await sendMessage({ action: 'TEST_AUTH' });

  badge.className = 'badge';
  warning.hidden  = true;

  if (status === 'AUTHENTICATED') {
    badge.textContent = '✓ Box Office session active';
    badge.classList.add('badge--ok');
    input.disabled = false;
    btn.disabled   = false;
  } else if (status === 'NO_BMS_TAB') {
    badge.textContent = '⚠ No Box Office tab open';
    badge.classList.add('badge--warn');
    warning.textContent = 'Open box-office.headout.com in a Chrome tab and log in, then reload BASS.';
    warning.hidden = false;
    input.disabled = true;
    btn.disabled   = true;
  } else if (status === 'REFRESH_BMS_TAB') {
    badge.textContent = '⚠ Refresh Box Office tab';
    badge.classList.add('badge--warn');
    warning.textContent = 'Refresh your Box Office tab (F5), then reload BASS.';
    warning.hidden = false;
    input.disabled = true;
    btn.disabled   = true;
  } else if (status === 'NOT_AUTHENTICATED') {
    badge.textContent = '⚠ Not logged in';
    badge.classList.add('badge--warn');
    warning.textContent = 'Log into Box Office, then reload BASS.';
    warning.hidden = false;
    input.disabled = true;
    btn.disabled   = true;
  } else if (status === 'SESSION_EXPIRED') {
    badge.textContent = '⚠ Session expired';
    badge.classList.add('badge--warn');
    warning.textContent = 'Your Box Office session has expired — log in again, then reload BASS.';
    warning.hidden = false;
    input.disabled = true;
    btn.disabled   = true;
  } else {
    badge.textContent = '? Unknown — try refreshing Box Office tab';
    badge.classList.add('badge--warn');
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

$('search-btn').addEventListener('click', doSearch);
$('booking-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const id = $('booking-id').value.trim();
  if (!id) return;

  setError('');
  showSection('loading');

  const result = await sendMessage({ action: 'FETCH_BOOKING', bookingId: id });

  if (!result.ok) {
    showSection('search');
    if (result.errorType === 'NOT_AUTHENTICATED' || result.errorType === 'SESSION_EXPIRED') {
      setError('Your Box Office session has expired — log in and try again.');
      await checkAuth();
    } else {
      setError(`Error ${result.status || ''}: ${result.error || 'Unexpected error'}`);
    }
    return;
  }

  renderResult(id, result.data);
  showSection('result');
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderResult(bookingId, data) {
  $('result-booking-id').textContent = bookingId;
  $('raw-json').textContent = JSON.stringify(data, null, 2);

  const container = $('result-fields');
  container.innerHTML = '';

  // Flatten top-level booking object (API may nest under a key like "booking")
  const flat = data.booking || data.fulfillmentDetails || data;

  // Known fields first
  for (const { key, label } of FIELD_MAP) {
    const val = flat[key];
    if (val == null || val === '') continue;
    container.appendChild(makeField(label, String(val)));
  }

  // Vendor / booking instructions (nested under vendorsInfo array)
  const vendors = flat.vendorsInfo || data.vendorsInfo || [];
  vendors.forEach((v, i) => {
    const prefix = vendors.length > 1 ? `Vendor ${i + 1} — ` : '';
    if (v.vendorName)          container.appendChild(makeField(`${prefix}Vendor`, v.vendorName));
    if (v.vendorId)            container.appendChild(makeField(`${prefix}Vendor ID`, String(v.vendorId)));
    if (v.tourId)              container.appendChild(makeField(`${prefix}Tour ID`, String(v.tourId)));
    if (v.bookingInstructions) container.appendChild(makeField(`${prefix}Booking Instructions`, v.bookingInstructions, true));
  });

  // Any top-level keys not in FIELD_MAP and not already handled
  const handled = new Set([...FIELD_MAP.map(f => f.key), 'vendorsInfo', 'booking', 'fulfillmentDetails']);
  for (const [key, val] of Object.entries(flat)) {
    if (handled.has(key) || val == null || typeof val === 'object') continue;
    container.appendChild(makeField(humanise(key), String(val)));
  }
}

function makeField(label, value, pre = false) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = label;
  const v = document.createElement(pre ? 'pre' : 'span');
  v.className = 'field-value';
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function humanise(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function showSection(name) {
  $('search-section').hidden  = name !== 'search';
  $('loading-section').hidden = name !== 'loading';
  $('result-section').hidden  = name !== 'result';
  if (name === 'search') $('search-section').hidden = false;
  // Always show the search bar except when loading
  if (name !== 'loading') $('search-section').hidden = false;
}

function setError(msg) {
  const el = $('search-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

$('booking-id').disabled = true;
$('search-btn').disabled = true;
showSection('search');
checkAuth();
