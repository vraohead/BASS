// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanise(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function isHtml(str) {
  return /<[a-z][\s\S]*>/i.test(str);
}

// ── Theme ──────────────────────────────────────────────────────────────────────
const themeBtn = $('theme-toggle');

async function loadTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  applyTheme(theme || 'light');
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
}

themeBtn.addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
});

// ── Auth ───────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const pill     = $('auth-pill');
  const warning  = $('auth-warning');
  const recheck  = $('recheck-btn');
  const fetchBtn = $('fetch-ticket');

  pill.className   = 'auth-pill auth-pill--checking';
  pill.textContent = 'checking…';
  warning.classList.add('hidden');
  recheck.classList.add('hidden');

  const status = await sendMessage({ action: 'TEST_AUTH' }) ?? 'UNKNOWN';

  if (status === 'AUTHENTICATED') {
    pill.className   = 'auth-pill auth-pill--ok';
    pill.textContent = '✓ Active';
    fetchBtn.disabled = false;
  } else {
    pill.className   = 'auth-pill auth-pill--warn';
    fetchBtn.disabled = true;
    recheck.classList.remove('hidden');

    const messages = {
      TIMEOUT:           ['⚠ Timeout',      'Box Office did not respond. Check your connection, then click ↺.'],
      NOT_AUTHENTICATED: ['⚠ Not logged in', 'Log into Box Office, then click ↺ to re-check.'],
      SESSION_EXPIRED:   ['⚠ Expired',       'Your Box Office session expired — log in again, then click ↺.'],
    };
    const [label, msg] = messages[status] || ['? Unknown', 'Refresh Box Office, then click ↺ to re-check.'];
    pill.textContent      = label;
    warning.textContent   = msg;
    warning.classList.remove('hidden');
  }

  return status;
}

$('recheck-btn').addEventListener('click', () => checkAuth());

// ── Search ─────────────────────────────────────────────────────────────────────
$('fetch-ticket').addEventListener('click', doSearch);
$('ticket-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('clear-ticket').addEventListener('click', clearResult);

async function doSearch() {
  const id = $('ticket-input').value.trim();
  if (!id) return;

  setError('');
  showLoading(true);

  const result = await sendMessage({ action: 'FETCH_BOOKING', bookingId: id });
  showLoading(false);

  if (!result || !result.ok) {
    const errType = result?.errorType;
    if (errType === 'NOT_AUTHENTICATED' || errType === 'SESSION_EXPIRED') {
      setError('Your Box Office session has expired — log in and try again.');
      await checkAuth();
    } else if (errType === 'TIMEOUT' || errType === 'FETCH_ERROR') {
      setError('Request timed out. Check the Box Office tab is loaded, then try again.');
    } else {
      setError(`Error ${result?.status || ''}: ${result?.error || 'Unexpected error'}`);
    }
    return;
  }

  renderResult(id, result.data);
}

function clearResult() {
  $('ticket-input').value = '';
  setError('');
  $('booking-summary').classList.add('hidden');
  $('tab-nav').classList.add('hidden');
  $('ticket-details').innerHTML = '';
}

// ── Rendering ──────────────────────────────────────────────────────────────────
let currentTab = 'booking';

function renderResult(bookingId, data) {
  const flat    = data.booking || data.fulfillmentDetails || data;
  const vendors = flat.vendorsInfo || data.vendorsInfo || [];

  renderSummary(bookingId, flat);
  renderTabs(flat, vendors, data);

  $('booking-summary').classList.remove('hidden');
  $('tab-nav').classList.remove('hidden');
  switchTab(currentTab);
}

function renderSummary(bookingId, flat) {
  const setFact = (id, val) => {
    const el = $(id);
    if (val != null && val !== '') { el.textContent = String(val); el.classList.remove('na'); }
    else                           { el.textContent = '—';         el.classList.add('na'); }
  };

  const tourEl = $('bs-tour');
  const product = flat.productName || flat.variantName;
  if (product) { tourEl.textContent = product; tourEl.classList.remove('na'); }
  else         { tourEl.textContent = '—';     tourEl.classList.add('na'); }

  setFact('bs-id',     flat.bookingId || bookingId);
  setFact('bs-status', flat.status);
  setFact('bs-date',   flat.inventoryDate || flat.inventoryTime);
  setFact('bs-pax',    flat.totalPax != null ? String(flat.totalPax) : null);
}

function renderTabs(flat, vendors, rawData) {
  const details = $('ticket-details');
  details.innerHTML = '';

  // ── Booking ──
  const bookSection = makeSection('full-booking', '📋', 'Booking Details', 'booking');
  const bookBody    = bookSection.querySelector('.section-body');
  const FIELDS = [
    ['Booking ID',        flat.bookingId],
    ['Status',            flat.status],
    ['Fulfilment Type',   flat.fulfilmentType],
    ['Fulfilment Status', flat.fulfilmentStatus],
    ['Product',           flat.productName],
    ['Variant',           flat.variantName],
    ['Inventory Date',    flat.inventoryDate],
    ['Inventory Time',    flat.inventoryTime],
    ['Ticket Type',       flat.ticketType],
    ['Total Pax',         flat.totalPax != null ? String(flat.totalPax) : null],
    ['Net Price',         flat.netPrice  != null ? String(flat.netPrice)  : null],
    ['Currency',          flat.currency],
    ['Created At',        flat.createdAt],
    ['Updated At',        flat.updatedAt],
  ];
  const knownKeys = new Set(['bookingId','status','fulfilmentType','fulfilmentStatus','productName','variantName','inventoryDate','inventoryTime','ticketType','totalPax','netPrice','currency','guestName','guestEmail','createdAt','updatedAt','vendorsInfo']);
  FIELDS.forEach(([label, val]) => { if (val != null && val !== '') bookBody.appendChild(makeFieldRow(label, val)); });
  for (const [k, v] of Object.entries(flat)) {
    if (!knownKeys.has(k) && v != null && typeof v !== 'object') bookBody.appendChild(makeFieldRow(humanise(k), String(v)));
  }
  details.appendChild(bookSection);

  // ── Instructions ──
  const instrSection = makeSection('instructions', '📌', 'Booking Instructions', 'instructions');
  const instrBody    = instrSection.querySelector('.section-body');
  if (vendors.length === 0) {
    instrBody.innerHTML = '<p class="instruction-empty">No booking instructions available.</p>';
  } else {
    vendors.forEach((v, i) => {
      const label = vendors.length > 1 ? `Vendor ${i + 1}: ${v.vendorName || ''}` : (v.vendorName || 'Instructions');
      const block = document.createElement('div');
      block.className = 'instr-block instr-block--important';
      block.innerHTML = `<div class="instr-block__header"><span class="instr-block__icon">🏢</span><span class="instr-block__title">${escHtml(label)}</span></div>`;
      const body = document.createElement('div');
      body.className = 'instr-block__body';
      if (v.bookingInstructions) {
        const wrapper = document.createElement('div');
        wrapper.className = 'rich-instruction-wrapper';
        if (isHtml(v.bookingInstructions)) wrapper.innerHTML = v.bookingInstructions;
        else wrapper.textContent = v.bookingInstructions;
        body.appendChild(wrapper);
      } else {
        body.innerHTML = '<p class="instruction-empty">No instructions for this vendor.</p>';
      }
      block.appendChild(body);
      instrBody.appendChild(block);
    });
  }
  details.appendChild(instrSection);

  // ── Customer ──
  const custSection = makeSection('customer-details', '👤', 'Customer Details', 'customer');
  const custBody    = custSection.querySelector('.section-body');
  let hasCust = false;
  if (flat.guestName)  { custBody.appendChild(makeFieldRow('Guest Name',  flat.guestName));  hasCust = true; }
  if (flat.guestEmail) { custBody.appendChild(makeFieldRow('Guest Email', flat.guestEmail)); hasCust = true; }
  if (!hasCust) custBody.innerHTML = '<p class="instruction-empty">No customer details available.</p>';
  details.appendChild(custSection);

  // ── Vendors ──
  const vendSection = makeSection('important-links', '🏢', 'Vendor Info', 'vendors');
  const vendBody    = vendSection.querySelector('.section-body');
  if (vendors.length === 0) {
    vendBody.innerHTML = '<p class="instruction-empty">No vendor information available.</p>';
  } else {
    vendors.forEach((v, i) => {
      const card  = document.createElement('div');
      card.className = 'guest-card';
      const badge = vendors.length > 1 ? `Vendor ${i + 1}` : 'Vendor';
      card.innerHTML = `<div class="guest-type-badge">${escHtml(badge)}</div>`;
      if (v.vendorName) card.appendChild(makeFieldRow('Vendor Name', v.vendorName));
      if (v.vendorId)   card.appendChild(makeFieldRow('Vendor ID',   String(v.vendorId)));
      if (v.tourId)     card.appendChild(makeFieldRow('Tour ID',     String(v.tourId)));
      vendBody.appendChild(card);
    });
  }
  details.appendChild(vendSection);

  // ── Raw ──
  const rawSection = makeSection('raw', '{ }', 'Raw API Response', 'raw');
  rawSection.querySelector('.section-body').textContent = JSON.stringify(rawData, null, 2);
  details.appendChild(rawSection);
}

function makeSection(sectionId, icon, title, tabId) {
  const sec = document.createElement('div');
  sec.className = 'section tab-section-hidden';
  sec.dataset.sectionId = sectionId;
  sec.dataset.tabId     = tabId;
  sec.innerHTML = `
    <div class="section-header">
      <div class="section-title">
        <span class="section-icon">${icon}</span>
        ${escHtml(title)}
      </div>
    </div>
    <div class="section-body"></div>
  `;
  return sec;
}

function makeFieldRow(label, value) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const l = document.createElement('span');
  l.className   = 'field-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className   = 'field-value';
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.tab === tabId);
  });
  document.querySelectorAll('#ticket-details .section').forEach(sec => {
    sec.classList.toggle('tab-section-hidden', sec.dataset.tabId !== tabId);
  });
}

$('tab-nav').addEventListener('click', (e) => {
  const pill = e.target.closest('.tab-pill');
  if (pill) switchTab(pill.dataset.tab);
});

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showLoading(show) {
  $('loading-spinner').classList.toggle('hidden', !show);
}

function setError(msg) {
  const el = $('error-message');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── Auto-detect booking ID from active BMS tab ─────────────────────────────────
async function autoDetect() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url  = tabs[0]?.url || '';
    if (!url.startsWith('https://box-office.headout.com/')) return;
    const match = url.match(/\/(\d{6,})/);
    if (!match) return;
    $('ticket-input').value = match[1];
    doSearch();
  } catch (_) {}
}

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  await loadTheme();
  const status = await checkAuth();
  if (status === 'AUTHENTICATED') await autoDetect();
})();
