// popup.js — BASS v10.0  (ES module, type="module")
// Communicates with background/service-worker.js via chrome.runtime.sendMessage.
// Handlers: TEST_AUTH → status string, FETCH_BOOKING → { ok, data } | { ok:false, ... }

const $ = id => document.getElementById(id);

// ── Utilities ─────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHtmlContent(str) {
  return /<[a-z][\s\S]*>/i.test(str);
}

function humanise(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// ── Theme ─────────────────────────────────────────────────────────────────────

async function initTheme() {
  try {
    const { theme } = await chrome.storage.local.get('theme');
    applyTheme(theme || 'light');
  } catch (_) {
    applyTheme('light');
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

$('theme-toggle').addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { await chrome.storage.local.set({ theme: next }); } catch (_) {}
});

// ── Auth ──────────────────────────────────────────────────────────────────────

async function checkAuth() {
  const pill    = $('auth-status');
  const warning = $('auth-warning');
  const warnTxt = $('auth-warning-text');
  const input   = $('booking-id');
  const btn     = $('search-btn');

  pill.className   = 'auth-pill auth-pill--checking';
  pill.textContent = '● checking…';
  warning.hidden   = true;

  const status = await sendMessage({ action: 'TEST_AUTH' }) ?? 'UNKNOWN';

  if (status === 'AUTHENTICATED') {
    pill.className   = 'auth-pill auth-pill--ok';
    pill.textContent = '✓ BMS active';
    warning.hidden   = true;
    input.disabled   = false;
    btn.disabled     = false;
  } else {
    pill.className   = 'auth-pill auth-pill--warn';
    pill.textContent = '⚠ Not authenticated';
    const msgs = {
      NOT_AUTHENTICATED: 'Not logged in to Box Office — log in, then Re-check.',
      SESSION_EXPIRED:   'Box Office session expired — log in again, then Re-check.',
      TIMEOUT:           'Box Office did not respond. Check your connection, then Re-check.',
    };
    warnTxt.textContent = msgs[status] || 'Could not verify Box Office session. Try Re-check.';
    warning.hidden   = false;
    input.disabled   = true;
    btn.disabled     = true;

    // Clear any stale results and show the auth gate
    showAuthGate(status);
  }

  return status;
}

function showAuthGate(status) {
  $('error-message').hidden     = true;
  $('booking-summary').hidden   = true;
  $('tab-nav').hidden           = true;

  const isTimeout = status === 'TIMEOUT';
  $('ticket-details').innerHTML = `
    <div class="auth-gate">
      <div class="auth-gate-icon">${isTimeout ? '⏱️' : '🔒'}</div>
      <p class="auth-gate-title">${isTimeout ? 'Box Office unreachable' : 'Sign in to Box Office'}</p>
      <p class="auth-gate-sub">${isTimeout
        ? 'Could not reach Box Office. Check your connection, then click <strong>Re-check</strong>.'
        : 'Open <a href="https://box-office.headout.com" target="_blank" rel="noopener">box-office.headout.com</a>, log in, then click <strong>Re-check</strong>.'
      }</p>
    </div>
  `;
}

$('recheck-btn').addEventListener('click', async () => {
  const status = await checkAuth();
  if (status === 'AUTHENTICATED') await autoDetect();
});

// ── Search ────────────────────────────────────────────────────────────────────

$('search-btn').addEventListener('click', doSearch);
$('booking-id').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
$('clear-btn').addEventListener('click', clearResults);

function clearResults() {
  $('booking-id').value = '';
  $('error-message').hidden = true;
  $('booking-summary').hidden = true;
  $('tab-nav').hidden = true;
  $('ticket-details').innerHTML =
    '<div class="welcome-placeholder"><p>Search for a booking above to get started.</p></div>';
  $('booking-id').focus();
}

async function doSearch() {
  const id = $('booking-id').value.trim();
  if (!id) return;

  $('error-message').hidden   = true;
  $('loading-spinner').hidden = false;
  $('booking-summary').hidden = true;
  $('tab-nav').hidden         = true;
  $('ticket-details').innerHTML = '';

  const result = await sendMessage({ action: 'FETCH_BOOKING', bookingId: id });

  $('loading-spinner').hidden = true;

  if (!result || !result.ok) {
    const errType = result?.errorType;
    let msg;
    if (errType === 'NOT_AUTHENTICATED' || errType === 'SESSION_EXPIRED') {
      msg = 'Your Box Office session has expired — log in and try again.';
      await checkAuth();
    } else if (errType === 'TIMEOUT' || errType === 'FETCH_ERROR') {
      msg = 'Request timed out. Check Box Office is reachable, then try again.';
    } else {
      const code = result?.status || '';
      msg = `Error${code ? ' ' + code : ''}: ${result?.error || 'Unexpected error'}`;
    }
    const errEl = $('error-message');
    errEl.textContent = msg;
    errEl.hidden = false;
    return;
  }

  renderBooking(id, result.data, result.guestData);
}

// ── Render booking ────────────────────────────────────────────────────────────

function renderBooking(id, data, guestData) {
  const flat    = data.booking || data.fulfillmentDetails || data;
  const vendors = data.vendorsInfo || flat.vendorsInfo || [];

  renderSummaryBar(id, flat);

  const details = $('ticket-details');
  details.innerHTML = '';
  details.appendChild(buildBookingSection(flat));
  details.appendChild(buildInstructionsSection(vendors));
  details.appendChild(buildCustomerSection(flat, guestData));
  details.appendChild(buildVendorsSection(vendors));
  details.appendChild(buildRawSection(data, guestData));

  // Wire up tab pills (re-added each render)
  document.querySelectorAll('#tab-nav .tab-pill').forEach(pill => {
    pill.addEventListener('click', () => switchTab(pill.dataset.tab));
  });

  $('tab-nav').hidden = false;
  switchTab('full-booking');
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function renderSummaryBar(id, flat) {
  const bar = $('booking-summary');

  const status = flat.status || '';
  const statusClass = /COMPLETED/i.test(status) ? 'yes'
    : /CANCELLED|REFUNDED/i.test(status) ? 'no' : 'na';

  const date  = flat.inventoryDate || flat.bookingDate || '';
  const time  = flat.inventoryTime || '';
  const pax   = flat.totalPax != null ? String(flat.totalPax) : '';
  const price = flat.netPrice != null
    ? `${flat.currency || ''} ${flat.netPrice}`.trim() : '';

  const fact = (label, valueHtml) =>
    valueHtml ? `<div class="bs-fact">
      <span class="bs-fact-label">${label}</span>
      <span class="bs-fact-value">${valueHtml}</span>
    </div>` : '';

  bar.innerHTML = `
    <div class="bs-tour">${escHtml(flat.productName || '—')}</div>
    <div class="bs-facts">
      ${fact('Booking ID', `<span class="booking-id-badge">#${escHtml(id)}</span>`)}
      ${status ? fact('Status', `<span class="status-badge ${statusClass}">${escHtml(status)}</span>`) : ''}
      ${date  ? fact('Date',   escHtml(date))  : ''}
      ${time  ? fact('Time',   escHtml(time))  : ''}
      ${pax   ? fact('Pax',   escHtml(pax))   : ''}
      ${price ? fact('Net',   escHtml(price)) : ''}
    </div>
  `;
  bar.hidden = false;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll('#tab-nav .tab-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.tab === tabId);
  });
  document.querySelectorAll('#ticket-details .section').forEach(sec => {
    sec.classList.toggle('tab-section-hidden', sec.dataset.sectionId !== tabId);
  });
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildSection(sectionId, title, iconEmoji, bodyHtml) {
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.dataset.sectionId = sectionId;
  sec.innerHTML = `
    <div class="section-header">
      <span class="section-title">
        <span class="section-icon">${iconEmoji}</span>${escHtml(title)}
      </span>
    </div>
    <div class="section-body">${bodyHtml}</div>
  `;
  return sec;
}

function fieldRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="field-row">
    <span class="field-label">${escHtml(label)}</span>
    <span class="field-value">${escHtml(String(value))}</span>
  </div>`;
}

// Booking tab ──────────────────────────────────────────────────────────────────
const BOOKING_FIELDS = [
  ['bookingId',        'Booking ID'],
  ['status',           'Status'],
  ['fulfilmentType',   'Fulfilment Type'],
  ['fulfilmentStatus', 'Fulfilment Status'],
  ['productName',      'Product'],
  ['variantName',      'Variant'],
  ['inventoryDate',    'Date'],
  ['inventoryTime',    'Time'],
  ['ticketType',       'Ticket Type'],
  ['totalPax',         'Total Pax'],
  ['netPrice',         'Net Price'],
  ['currency',         'Currency'],
  ['createdAt',        'Created'],
  ['updatedAt',        'Updated'],
];

function buildBookingSection(flat) {
  const handled = new Set([...BOOKING_FIELDS.map(f => f[0]), 'guestName', 'guestEmail', 'vendorsInfo']);
  let html = BOOKING_FIELDS.map(([key, label]) => fieldRow(label, flat[key])).join('');

  // Extra scalar fields not in the standard list
  for (const [key, v] of Object.entries(flat)) {
    if (handled.has(key) || v == null || typeof v === 'object') continue;
    html += fieldRow(humanise(key), v);
  }

  if (!html) html = '<p class="instruction-empty">No booking fields available.</p>';
  return buildSection('full-booking', 'Booking Details', '📋', html);
}

// Instructions tab ─────────────────────────────────────────────────────────────
function buildInstructionsSection(vendors) {
  const withInstr = vendors.filter(v => v.bookingInstructions);
  if (!withInstr.length) {
    return buildSection('instructions', 'Instructions', '📌',
      '<p class="instruction-empty">No booking instructions available.</p>');
  }

  let html = '';
  withInstr.forEach((v, i) => {
    const title = vendors.length > 1
      ? (v.vendorName || `Vendor ${i + 1}`)
      : (v.vendorName || 'Booking Instructions');
    const instr = v.bookingInstructions;
    let bodyHtml;
    if (isHtmlContent(instr)) {
      bodyHtml = `<div class="rich-instruction-wrapper">${instr}</div>`;
    } else {
      const paras = instr.split(/\n\n+/).filter(Boolean);
      bodyHtml = `<div class="instruction-text">${
        paras.map(p => `<p class="instruction-para">${escHtml(p)}</p>`).join('')
      }</div>`;
    }
    html += `<div class="instr-block instr-block--booking">
      <div class="instr-block__header">
        <span class="instr-block__icon">📌</span>
        <span class="instr-block__title">${escHtml(title)}</span>
      </div>
      <div class="instr-block__body">${bodyHtml}</div>
    </div>`;
  });

  return buildSection('instructions', 'Instructions', '📌', html);
}

// Customer tab ─────────────────────────────────────────────────────────────────
function buildCustomerSection(flat, guestData) {
  let html = '';

  if (guestData) {
    // Primary guest identity
    const pg = guestData.primaryGuest;
    if (pg) {
      const fullName = [pg.firstName, pg.lastName].filter(Boolean).join(' ');
      html += fieldRow('Name', fullName);
      html += fieldRow('Email', pg.email);
    }

    // Additional user-provided fields (phone, custom fields — skip NAME and EMAIL already shown)
    const shownTypes = new Set(['NAME', 'EMAIL']);
    const mainGuest = guestData.guests?.[0];
    if (mainGuest?.bookingUserFields?.length) {
      mainGuest.bookingUserFields.forEach(f => {
        const type = f.tourUserFieldType?.name;
        if (!shownTypes.has(type) && f.value) {
          html += fieldRow(f.name || humanise(type || ''), f.value);
          if (type) shownTypes.add(type);
        }
      });
    }

    // Pax breakdown
    if (guestData.paxDetails?.length) {
      const paxLabel = guestData.paxDetails
        .filter(p => p.count > 0)
        .map(p => `${p.count} ${p.count === 1 ? p.displayName : p.pluralDisplayName}`)
        .join(', ');
      if (paxLabel) html += fieldRow('Pax Breakdown', paxLabel);
    }

    // Device & login status
    if (guestData.device)      html += fieldRow('Device',       guestData.device);
    if (guestData.loginStatus) html += fieldRow('Login Status', guestData.loginStatus.replace(/_/g, ' '));

  } else {
    // Fallback: basic fields from the booking response
    html += fieldRow('Guest Name',  flat.guestName);
    html += fieldRow('Guest Email', flat.guestEmail);
  }

  if (!html) html = '<p class="instruction-empty">No customer details available.</p>';
  return buildSection('customer-details', 'Customer Details', '👤', html);
}

// Vendors tab ──────────────────────────────────────────────────────────────────
function buildVendorsSection(vendors) {
  if (!vendors.length) {
    return buildSection('important-links', 'Vendors', '🏢',
      '<p class="instruction-empty">No vendor information available.</p>');
  }
  let html = '';
  vendors.forEach((v, i) => {
    const rows = [
      fieldRow('Name', v.vendorName),
      fieldRow('Vendor ID', v.vendorId),
      fieldRow('Tour ID', v.tourId),
    ].join('');
    html += `<div class="guest-card">
      <span class="guest-type-badge">Vendor ${i + 1}</span>
      ${rows || '<p class="instruction-empty">No details.</p>'}
    </div>`;
  });
  return buildSection('important-links', 'Vendors', '🏢', html);
}

// Raw tab ──────────────────────────────────────────────────────────────────────
function buildRawSection(data, guestData) {
  const payload = guestData ? { booking: data, guestDetails: guestData } : data;
  return buildSection('raw', 'Raw API Response', '{ }',
    `<pre>${escHtml(JSON.stringify(payload, null, 2))}</pre>`);
}

// ── Auto-detect booking from active tab URL ────────────────────────────────────

async function autoDetect() {
  try {
    const tabs  = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url   = tabs[0]?.url || '';
    const match = url.match(/\/(\d{6,})/);
    if (!match) return;
    $('booking-id').value = match[1];
    await doSearch();
  } catch (_) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────

$('ticket-details').innerHTML =
  '<div class="welcome-placeholder"><p>Search for a booking above to get started.</p></div>';

(async () => {
  await initTheme();
  const status = await checkAuth();
  if (status === 'AUTHENTICATED') await autoDetect();
})();
