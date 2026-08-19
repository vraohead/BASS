const FIELD_MAP = [
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
  const recheck = $('recheck-btn');
  const input   = $('booking-id');
  const btn     = $('search-btn');

  badge.className   = 'badge badge--checking';
  badge.textContent = 'checking session…';
  warning.hidden    = true;
  recheck.hidden    = true;

  const status = await sendMessage({ action: 'TEST_AUTH' });

  badge.className = 'badge';

  if (status === 'AUTHENTICATED') {
    badge.textContent = '✓ Box Office session active';
    badge.classList.add('badge--ok');
    input.disabled = false;
    btn.disabled   = false;
  } else if (status === 'NO_BMS_TAB') {
    badge.textContent = '⚠ No Box Office tab open';
    badge.classList.add('badge--warn');
    warning.textContent = 'Open box-office.headout.com in a Chrome tab and log in, then click Re-check.';
    warning.hidden  = false;
    recheck.hidden  = false;
    input.disabled  = true;
    btn.disabled    = true;
  } else if (status === 'REFRESH_BMS_TAB') {
    badge.textContent = '⚠ Refresh Box Office tab';
    badge.classList.add('badge--warn');
    warning.textContent = 'Refresh your Box Office tab (F5), wait for it to load, then click Re-check.';
    warning.hidden  = false;
    recheck.hidden  = false;
    input.disabled  = true;
    btn.disabled    = true;
  } else if (status === 'TIMEOUT') {
    badge.textContent = '⚠ Connection timed out';
    badge.classList.add('badge--warn');
    warning.textContent = 'Box Office did not respond. Check your connection, then click Re-check.';
    warning.hidden  = false;
    recheck.hidden  = false;
    input.disabled  = true;
    btn.disabled    = true;
  } else if (status === 'NOT_AUTHENTICATED') {
    badge.textContent = '⚠ Not logged in';
    badge.classList.add('badge--warn');
    warning.textContent = 'Log into Box Office, then click Re-check.';
    warning.hidden  = false;
    recheck.hidden  = false;
    input.disabled  = true;
    btn.disabled    = true;
  } else if (status === 'SESSION_EXPIRED') {
    badge.textContent = '⚠ Session expired';
    badge.classList.add('badge--warn');
    warning.textContent = 'Your Box Office session has expired — log in again, then click Re-check.';
    warning.hidden  = false;
    recheck.hidden  = false;
    input.disabled  = true;
    btn.disabled    = true;
  } else {
    badge.textContent = '? Unknown — click Re-check after refreshing Box Office';
    badge.classList.add('badge--warn');
    recheck.hidden  = false;
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

$('search-btn').addEventListener('click', doSearch);
$('booking-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('recheck-btn').addEventListener('click', () => checkAuth());

async function doSearch() {
  const id = $('booking-id').value.trim();
  if (!id) return;

  setError('');
  showSection('loading');

  const result = await sendMessage({ action: 'FETCH_BOOKING', bookingId: id });

  if (!result || !result.ok) {
    showSection('search');
    const errType = result?.errorType;
    if (errType === 'NOT_AUTHENTICATED' || errType === 'SESSION_EXPIRED') {
      setError('Your Box Office session has expired — log in and try again.');
      await checkAuth();
    } else if (errType === 'TIMEOUT') {
      setError('Request timed out. Check the Box Office tab is loaded, then try again.');
    } else if (errType === 'NO_BMS_TAB' || errType === 'REFRESH_BMS_TAB') {
      setError(result.error || 'Box Office tab not ready. Refresh it and try again.');
      await checkAuth();
    } else {
      setError(`Error ${result?.status || ''}: ${result?.error || 'Unexpected error'}`);
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

  const flat = data.booking || data.fulfillmentDetails || data;

  for (const { key, label } of FIELD_MAP) {
    const val = flat[key];
    if (val == null || val === '') continue;
    container.appendChild(makeField(label, String(val)));
  }

  const vendors = flat.vendorsInfo || data.vendorsInfo || [];
  vendors.forEach((v, i) => {
    const prefix = vendors.length > 1 ? `Vendor ${i + 1} — ` : '';
    if (v.vendorName)          container.appendChild(makeField(`${prefix}Vendor`, v.vendorName));
    if (v.vendorId)            container.appendChild(makeField(`${prefix}Vendor ID`, String(v.vendorId)));
    if (v.tourId)              container.appendChild(makeField(`${prefix}Tour ID`, String(v.tourId)));
    if (v.bookingInstructions) container.appendChild(makeField(`${prefix}Booking Instructions`, v.bookingInstructions, true));
  });

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
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function showSection(name) {
  $('search-section').hidden  = (name === 'loading');
  $('loading-section').hidden = (name !== 'loading');
  $('result-section').hidden  = (name !== 'result');
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
