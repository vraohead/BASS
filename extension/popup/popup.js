// popup.js — Booking Assistant v10.0  (ES module, type="module")
// Communicates with background/service-worker.js via chrome.runtime.sendMessage.
// Handlers: TEST_AUTH → status string, FETCH_BOOKING → { ok, data } | { ok:false, ... }

const $ = id => document.getElementById(id);

const DEFAULT_WORKER_URL = 'https://bass-verify.vivek-rao.workers.dev';

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


// ── Agent identity (for Confirm & Flag) ────────────────────────────────────────
// Booking Assistant has no way to read the logged-in Box Office user directly (it only ever
// proxies session cookies for read requests) — so ask once, then remember it.
async function getAgentEmail() {
  try {
    const { agentEmail } = await chrome.storage.local.get('agentEmail');
    if (agentEmail) return agentEmail;
  } catch (_) {}
  const entered = window.prompt('Enter your Box Office login email (asked once, saved locally on this device):');
  const trimmed = (entered || '').trim();
  if (trimmed) {
    try { await chrome.storage.local.set({ agentEmail: trimmed }); } catch (_) {}
  }
  return trimmed;
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
  const toggle = $('theme-toggle');
  toggle.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
  toggle.querySelector('.theme-switch-thumb').textContent = theme === 'dark' ? '🌙' : '☀️';
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

// ── Persist last-viewed booking across close/reopen ────────────────────────────
// Closing the side panel to look at the portal shouldn't lose your place.
// A sliding 1-hour window: every successful fetch refreshes the timestamp, so
// active use never expires it — only 1 hour of no activity clears it.
const RESTORE_TTL_MS = 60 * 60 * 1000;

async function saveLastBooking(id) {
  try { await chrome.storage.local.set({ lastBookingId: id, lastUsedAt: Date.now() }); } catch (_) {}
}

async function clearLastBooking() {
  try { await chrome.storage.local.remove(['lastBookingId', 'lastUsedAt']); } catch (_) {}
}

async function restoreLastBooking() {
  try {
    const { lastBookingId, lastUsedAt } = await chrome.storage.local.get(['lastBookingId', 'lastUsedAt']);
    if (!lastBookingId || !lastUsedAt) return false;
    if (Date.now() - lastUsedAt > RESTORE_TTL_MS) {
      await clearLastBooking();
      return false;
    }
    $('booking-id').value = lastBookingId;
    await doSearch();
    return true;
  } catch (_) {
    return false;
  }
}

function clearResults() {
  $('booking-id').value = '';
  $('error-message').hidden = true;
  $('booking-summary').hidden = true;
  $('tab-nav').hidden = true;
  $('ticket-details').innerHTML =
    '<div class="welcome-placeholder"><p>Search for a booking above to get started.</p></div>';
  $('booking-id').focus();
  clearLastBooking();
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

  renderBooking(id, result.data, result.guestData, result.showAutomationModal, result.vendorTourData);
  saveLastBooking(id);
}

// ── Render booking ────────────────────────────────────────────────────────────

function renderBooking(id, data, guestData, showAutomationModal, vendorTourData) {
  const flat    = data.booking || data.fulfillmentDetails || data;
  const vendors = data.vendorsInfo || flat.vendorsInfo || [];

  renderSummaryBar(id, flat, guestData);

  $('automation-modal-banner').hidden = true;

  if (showAutomationModal) {
    const bmsLink = `https://box-office.headout.com/bms/${id}`;
    $('tab-nav').hidden = true;
    const details = $('ticket-details');
    details.innerHTML = '';
    const lockout = document.createElement('div');
    lockout.className = 'automation-lockout';
    lockout.innerHTML = `
      <div class="automation-lockout-icon">⚠️</div>
      <p class="automation-lockout-title">Action Required</p>
      <p class="automation-lockout-body">This booking has an automation failure. Complete the automation failure modal in BMS before processing this booking.</p>
      <button class="btn btn-primary automation-lockout-btn" data-url="${escHtml(bmsLink)}">Open Booking in BMS ↗</button>
    `;
    lockout.querySelector('.automation-lockout-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: bmsLink });
    });
    details.appendChild(lockout);
    return;
  }

  const details = $('ticket-details');
  details.innerHTML = '';
  details.appendChild(buildBookingSection(flat));
  details.appendChild(buildInstructionsSection(flat, vendors, vendorTourData));
  details.appendChild(buildCustomerSection(flat, guestData));
  details.appendChild(buildVerifySection(flat, guestData));
  details.appendChild(buildLateConfirmSection(flat));

  // Wire up tab pills (re-added each render)
  document.querySelectorAll('#tab-nav .tab-pill').forEach(pill => {
    pill.addEventListener('click', () => switchTab(pill.dataset.tab));
  });

  $('tab-nav').hidden = false;
  switchTab('full-booking');
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function renderSummaryBar(id, flat, guestData) {
  const bar = $('booking-summary');

  const date  = formatDateShort(flat.inventoryDate || flat.bookingDate || '') || '';
  const time  = formatTime(flat.inventoryTime || '') || '';
  const currency = flat.currency || flat.currencyName || flat.tourCurrency || '';
  const price = flat.netPrice != null
    ? `${currency} ${flat.netPrice}`.trim() : '';

  let pax = flat.totalPax != null ? String(flat.totalPax) : '';
  if (!pax && guestData?.paxDetails?.length) {
    const total = guestData.paxDetails.reduce((s, p) => s + (p.count || 0), 0);
    if (total) pax = String(total);
  }
  if (!pax) {
    const total = (flat.guestNumbers || []).reduce((s, g) => s + (g.persons || 0), 0);
    if (total) pax = String(total);
  }

  // Time to Experience — a full-width one-line banner, only for actionable tiers (hide ON TIME)
  let tteBanner = '';
  if (flat.actualLeadTimeInHours != null) {
    const h = flat.actualLeadTimeInHours;
    const totalH = Math.abs(h);
    const d = Math.floor(totalH / 24);
    const rem = Math.round(totalH % 24);
    const dPart = d > 0 ? `${d}d ` : '';
    const tteLabel = h < 0 ? `${dPart}${rem}h ago` : `in ${dPart}${rem}h`;
    let tier, tierLabel, icon;
    if      (h < 0)   { tier = 'past';   tierLabel = 'PAST DUE'; icon = '⚠️'; }
    else if (h < 4)   { tier = 'urgent'; tierLabel = 'URGENT';   icon = '🔥'; }
    else if (h < 24)  { tier = 'today';  tierLabel = 'TODAY';    icon = '⏰'; }
    else if (h < 72)  { tier = 'soon';   tierLabel = 'SOON';     icon = '⏱️'; }
    else              { tier = null; }
    if (tier) {
      tteBanner = `<div class="tte-banner tte-banner--${tier}">
        <span class="tte-banner-icon">${icon}</span>
        <span class="tte-banner-label">${tierLabel}</span>
        <span class="tte-banner-sep">·</span>
        <span class="tte-banner-val">Experience ${escHtml(tteLabel)}</span>
      </div>`;
    }
  }

  const fact = (label, valueHtml) =>
    valueHtml ? `<div class="bs-fact">
      <span class="bs-fact-label">${label}</span>
      <span class="bs-fact-value">${valueHtml}</span>
    </div>` : '';

  const tourRow = flat.productName
    ? `<div class="bs-tour">${escHtml(flat.productName)}</div>`
    : '';

  bar.innerHTML = `
    ${tteBanner}
    ${tourRow}
    <div class="bs-facts">
      ${fact('Date', escHtml(date))}
      ${fact('Time', escHtml(time))}
      ${fact('Pax',  escHtml(pax))}
      ${fact('Net',  escHtml(price))}
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

const COPY_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function fieldRow(label, value, copyable = false) {
  if (value == null || value === '') return '';
  const valStr = String(value);
  const copyBtn = copyable
    ? `<button type="button" class="copy-btn" data-copy-value="${escHtml(valStr)}" title="Copy" aria-label="Copy ${escHtml(label)}">${COPY_ICON}</button>`
    : '';
  return `<div class="field-row">
    <span class="field-label">${escHtml(label)}</span>
    <span class="field-value-group">
      <span class="field-value">${escHtml(valStr)}</span>
      ${copyBtn}
    </span>
  </div>`;
}

function wireCopyButtons(container) {
  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const val = btn.dataset.copyValue || '';
      try {
        await navigator.clipboard.writeText(val);
        const original = btn.innerHTML;
        btn.innerHTML = CHECK_ICON;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = original; btn.classList.remove('copied'); }, 1200);
      } catch (_) {}
    });
  });
}

// ── Date / time formatters ────────────────────────────────────────────────────

const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _ordinal(d) {
  return d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th';
}

function formatDate(dateStr) {
  if (!dateStr) return dateStr;
  const parts = dateStr.split('-').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return dateStr;
  const [year, month, day] = parts;
  return `${day}${_ordinal(day)} ${MONTHS_LONG[month - 1]} ${year}`;
}

function formatDateShort(dateStr) {
  if (!dateStr) return dateStr;
  const parts = dateStr.split('-').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return dateStr;
  const [year, month, day] = parts;
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

function formatTime(timeStr) {
  if (!timeStr) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Booking tab ──────────────────────────────────────────────────────────────────
const BOOKING_FIELDS = [
  ['bookingId',        'Booking ID'],
  ['status',           'Status'],
  ['fulfilmentType',   'Fulfilment Type'],
  ['fulfilmentStatus', 'Fulfilment Status'],
  ['productName',      'Product'],
  ['variantName',      'Variant'],
  ['inventoryDate',    'Date',    formatDate],
  ['inventoryTime',    'Time',    formatTime],
  ['ticketType',       'Ticket Type'],
  ['totalPax',         'Total Pax'],
];

function linkRow(label, url) {
  return `<div class="field-row">
    <span class="field-label">${escHtml(label)}</span>
    <span class="field-value"><a href="${escHtml(url)}" target="_blank" rel="noopener" class="quick-link">${escHtml(label)} ↗</a></span>
  </div>`;
}

function getPrimaryVendor(flat) {
  const vendors = flat.vendorsInfo || [];
  if (!vendors.length) return null;
  return vendors.find(v => v.vendorId === flat.vendorId) || vendors[0];
}

function buildBookingSection(flat) {
  const tourId      = flat.tourId;
  const tourGroupId = flat.tourGroupId;
  const primary     = getPrimaryVendor(flat);

  // ── Quick Links (primary vendor only) ───────────────────────────────────
  let linksHtml = '';

  if (tourId && tourGroupId) {
    linksHtml += linkRow('Inventory', `https://aries.headout.com/inventory?tourId=${tourId}&tourGroupId=${tourGroupId}`);
  }

  if (primary?.tourId && primary?.vendorId) {
    linksHtml += `<div class="field-row">
      <span class="field-label">Scorpio</span>
      <span class="field-value"><a href="https://scorpio.headout.com/admin/vendor/vendortour/?tour=${primary.tourId}&vendor_id=${primary.vendorId}" target="_blank" rel="noopener" class="quick-link">Scorpio ↗</a></span>
    </div>`;
  }

  let html = linksHtml
    ? `<div class="quick-links-group">${linksHtml}</div><div class="quick-links-divider"></div>`
    : '';

  // ── Standard fields ──────────────────────────────────────────────────────
  const ACCORDION_FIELDS = new Set(['couponDiscount', 'convenienceFee', 'walletAmountUsed']);
  const HIDDEN = new Set([
    ...BOOKING_FIELDS.map(f => f[0]),
    ...ACCORDION_FIELDS,
    'guestName', 'guestEmail', 'vendorsInfo',
    'tourId', 'tourGroupId', 'vendorId', 'guestNumbers',
    'currency', 'netPrice', 'currencyName', 'tourCurrency',
    'itineraryId', 'automateRiskyBooking', 'deskCaseId', 'twoStepFulfillmentEnabled',
    'whatsAppOptIn', 'netPriceEditable', 'noTicketDataBooking',
    'ticketUnblurred', 'meetingPointAddress', 'meetingPointUrl', 'appPushMode',
    'timezone', 'timeZone', 'tourTimezone', 'inventoryTimezone',
    'siblingBookings', 'tickets', 'vouchers', 'ticketTypes',
    'oopCancelRischeduleConfig', 'oopCancelRescheduleConfig',
    'itineraryPricing', 'bookingPricing',
    'actualLeadTimeInHours',
    'productValue', 'fulfilmentId', 'fulfillmentId',
    'pending', 'rmsName', 'bookingCreationTimestamp', 'createdAt', 'updatedAt',
  ]);

  html += BOOKING_FIELDS.map(([key, label, fmt]) => {
    const v = flat[key];
    return fieldRow(label, fmt ? fmt(v) : v);
  }).join('');

  // Net price with currency combined
  if (flat.netPrice != null) {
    const cur = flat.currency || flat.currencyName || flat.tourCurrency || '';
    html += fieldRow('Net Price', cur ? `${cur} ${flat.netPrice}` : String(flat.netPrice));
  }

  // Two-step only when enabled
  if (flat.twoStepFulfillmentEnabled === true) {
    html += fieldRow('Two-Step Fulfilment', 'Yes');
  }

  // Vendor product name if top-level productName missing
  if (!flat.productName && primary?.productName) {
    html += fieldRow('Product (Vendor)', primary.productName);
  }

  const PRICE_FIELDS = new Set(['finalPricePaid', 'totalPrice', 'basePrice']);
  const cur = flat.currency || flat.currencyName || flat.tourCurrency || '';

  for (const [key, v] of Object.entries(flat)) {
    if (HIDDEN.has(key) || v == null || typeof v === 'object') continue;
    const display = PRICE_FIELDS.has(key) && cur ? `${cur} ${v}` : v;
    html += fieldRow(humanise(key), display);
  }

  // Accordion for discount / fee details
  const accordionRows = ['couponDiscount', 'convenienceFee', 'walletAmountUsed']
    .map(key => {
      const v = flat[key];
      if (v == null) return '';
      const display = cur ? `${cur} ${v}` : String(v);
      return fieldRow(humanise(key), display);
    }).join('');
  if (accordionRows) {
    html += `<details class="price-accordion">
      <summary class="price-accordion-summary">Discounts &amp; fees ▾</summary>
      <div class="price-accordion-body">${accordionRows}</div>
    </details>`;
  }

  if (!html) html = '<p class="instruction-empty">No booking fields available.</p>';
  return buildSection('full-booking', 'Booking Details', '📋', html);
}

// Verify tab ───────────────────────────────────────────────────────────────────
let _verifySection = null;

document.addEventListener('paste', e => {
  if (!_verifySection || _verifySection.classList.contains('tab-section-hidden')) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => _setVerifyImage(_verifySection, ev.target.result);
      reader.readAsDataURL(item.getAsFile());
      break;
    }
  }
});

function renderVerifyRow(c, i) {
  const matched = c.found;
  const skipId = `vr-skip-${i}`;
  const skipChk = matched ? '' : `
    <label class="vr-skip-label" for="${skipId}">
      <input type="checkbox" class="vr-skip-chk" id="${skipId}"> Skip
    </label>`;
  return `<div class="verify-result-row ${matched ? 'match' : 'nomatch'}" data-idx="${i}">
    <span class="vr-icon">${matched ? '✓' : '✗'}</span>
    <span class="vr-label">${escHtml(c.label)}</span>
    <span class="vr-value">${escHtml(String(c.expected ?? ''))}</span>
    <span class="vr-status">${matched ? 'Found' : 'Not found'}</span>
    ${skipChk}
  </div>`;
}

function wireSkipBoxes(container, confirmRow) {
  const totalMismatches = container.querySelectorAll('.verify-result-row.nomatch').length;
  const update = () => {
    const skipped = [...container.querySelectorAll('.verify-result-row.nomatch.skipped')];
    if (confirmRow) {
      // Only reveal Confirm & Flag once EVERY mismatched field has been
      // explicitly skipped — partial acknowledgement isn't enough.
      const allSkipped = totalMismatches > 0 && skipped.length === totalMismatches;
      confirmRow.hidden = !allSkipped;
      const lbl = confirmRow.querySelector('.verify-confirm-count');
      if (lbl) lbl.textContent = `${skipped.length}/${totalMismatches} skipped`;
    }
  };
  container.querySelectorAll('.vr-skip-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      chk.closest('.verify-result-row').classList.toggle('skipped', chk.checked);
      update();
    });
  });
}

function _setVerifyImage(sec, dataUrl) {
  sec.querySelector('.verify-img').src = dataUrl;
  sec.querySelector('.verify-img-wrap').hidden = false;
  sec.querySelector('.verify-ai-row').hidden = false;
  sec.querySelector('.verify-ai-results').hidden = true;
  sec.querySelector('.verify-ai-results').innerHTML = '';
}

function _getVerifyFacts(flat, guestData) {
  const date  = flat.inventoryDate || flat.bookingDate || '';
  const time  = flat.inventoryTime || '';
  const price = flat.netPrice != null ? String(flat.netPrice) : '';
  let pax = flat.totalPax != null ? String(flat.totalPax) : '';
  if (!pax && guestData?.paxDetails?.length) {
    const t = guestData.paxDetails.reduce((s, p) => s + (p.count || 0), 0);
    if (t) pax = String(t);
  }
  if (!pax) {
    const t = (flat.guestNumbers || []).reduce((s, g) => s + (g.persons || 0), 0);
    if (t) pax = String(t);
  }
  return { date, time, pax: pax || '', price };
}

function buildVerifySection(flat, guestData) {
  const { date, time, pax, price } = _getVerifyFacts(flat, guestData);
  const cur2 = flat.currency || flat.currencyName || flat.tourCurrency || '';
  const displayPrice = price ? `${cur2} ${price}`.trim() : '—';

  const html = `
    <div class="verify-facts">
      <div class="verify-fact"><div class="verify-fact-label">Date</div><div class="verify-fact-value">${escHtml(date || '—')}</div></div>
      <div class="verify-fact"><div class="verify-fact-label">Time</div><div class="verify-fact-value">${escHtml(time || '—')}</div></div>
      <div class="verify-fact"><div class="verify-fact-label">Pax</div><div class="verify-fact-value">${escHtml(pax || '—')}</div></div>
      <div class="verify-fact"><div class="verify-fact-label">Net</div><div class="verify-fact-value">${escHtml(displayPrice)}</div></div>
    </div>

    <div class="verify-mode-btns">
      <button class="verify-mode-btn active" data-mode="screenshot">📸 Screenshot</button>
      <button class="verify-mode-btn" data-mode="response">🔍 Capture Response</button>
    </div>

    <div class="verify-pane" data-pane="screenshot">
      <button class="btn btn-primary verify-capture-tab-btn" style="width:100%;margin-bottom:8px">📸 Capture Current Tab</button>
      <div class="drop-zone">
        <input type="file" class="verify-file-input" accept="image/*">
        <div class="drop-zone-inner">
          <div class="drop-zone-icon">🖼️</div>
          <p class="drop-zone-text">Or drop / upload / paste (Ctrl+V)</p>
        </div>
      </div>
      <div class="verify-img-wrap" hidden>
        <img class="verify-img" alt="Ticket screenshot">
        <button class="verify-clear-btn">✕ Clear</button>
      </div>
      <div class="verify-ai-row" hidden>
        <button class="btn btn-primary verify-ai-btn">🤖 AI Verify</button>
      </div>
      <div class="verify-ai-results" hidden></div>
    </div>

    <div class="verify-pane" data-pane="response" hidden>
      <p class="verify-paste-hint">Navigate to the vendor portal or ticket page, then click:</p>
      <button class="btn btn-primary verify-capture-resp-btn" style="width:100%">🔍 Capture Active Tab Response</button>
      <div class="verify-results" hidden></div>
    </div>

    <div class="verify-confirm-row" hidden>
      <span class="verify-confirm-count"></span>
      <button class="btn btn-primary verify-confirm-btn">✓ Confirm &amp; Flag</button>
      <span class="verify-confirm-status"></span>
    </div>
  `;

  const sec = buildSection('verify', 'Verify Ticket', '✓', html);
  _verifySection = sec;

  // Mode toggle
  sec.querySelectorAll('.verify-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sec.querySelectorAll('.verify-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sec.querySelectorAll('.verify-pane').forEach(p => {
        p.hidden = p.dataset.pane !== btn.dataset.mode;
      });
    });
  });

  // Drop zone — click to open file picker
  const dropZone = sec.querySelector('.drop-zone');
  const fileInput = sec.querySelector('.verify-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => _setVerifyImage(sec, ev.target.result);
      reader.readAsDataURL(file);
    }
  });
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => _setVerifyImage(sec, ev.target.result);
    reader.readAsDataURL(file);
  });

  // Capture current tab screenshot
  sec.querySelector('.verify-capture-tab-btn').addEventListener('click', async () => {
    const btn = sec.querySelector('.verify-capture-tab-btn');
    const errEl = sec.querySelector('.verify-ai-results');
    btn.disabled = true;
    btn.textContent = '⏳ Capturing…';

    // Chrome withholds broad host permissions on new installs — request here
    // (side panel button click is a valid user-gesture context for this call)
    let permGranted = true;
    try {
      permGranted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (_) {}

    if (!permGranted) {
      btn.disabled = false;
      btn.textContent = '📸 Capture Current Tab';
      errEl.innerHTML = `<p class="verify-result-error">Permission denied. Go to chrome://extensions → Booking Assistant → Details → Site access → On all sites.</p>`;
      errEl.hidden = false;
      return;
    }

    const result = await sendMessage({ action: 'CAPTURE_SCREENSHOT' });
    btn.disabled = false;
    btn.textContent = '📸 Capture Current Tab';
    if (result?.ok) {
      _setVerifyImage(sec, result.dataUrl);
    } else {
      errEl.innerHTML = `<p class="verify-result-error">Screenshot failed: ${escHtml(result?.error || 'unknown')}</p>`;
      errEl.hidden = false;
    }
  });

  // Clear image
  sec.querySelector('.verify-clear-btn').addEventListener('click', () => {
    sec.querySelector('.verify-img-wrap').hidden = true;
    sec.querySelector('.verify-ai-row').hidden = true;
    sec.querySelector('.verify-ai-results').hidden = true;
    sec.querySelector('.verify-img').src = '';
    fileInput.value = '';
  });

  // AI Verify
  sec.querySelector('.verify-ai-btn').addEventListener('click', async () => {
    const workerUrl = DEFAULT_WORKER_URL;
    const imgEl = sec.querySelector('.verify-img');
    if (!imgEl.src || imgEl.src === window.location.href) return;

    const aiBtn = sec.querySelector('.verify-ai-btn');
    const resultsEl = sec.querySelector('.verify-ai-results');
    aiBtn.disabled = true;
    aiBtn.textContent = '⏳ Verifying…';
    resultsEl.hidden = true;

    const [header, imageBase64] = imgEl.src.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';

    const result = await sendMessage({
      action: 'VERIFY_IMAGE',
      imageBase64,
      mimeType,
      facts: { date, time, pax, price },
      workerUrl,
    });

    aiBtn.disabled = false;
    aiBtn.textContent = '🤖 AI Verify';

    if (!result?.ok) {
      if (result?.steps) console.log('[BA] /verify steps:', result.steps);
      const rawLine = result?.raw ? `<p class="verify-result-error">Raw AI response: ${escHtml(result.raw)}</p>` : '';
      resultsEl.innerHTML = `<p class="verify-result-error">Error: ${escHtml(result?.error || 'unknown')}</p>${rawLine}`;
      resultsEl.hidden = false;
      return;
    }

    const checks = result.checks || [];
    if (!checks.length) {
      resultsEl.innerHTML = '<p class="verify-result-error">No results returned from AI.</p>';
    } else {
      resultsEl.innerHTML = checks.map((c, i) => renderVerifyRow(c, i)).join('');
      wireSkipBoxes(resultsEl, confirmRow);
    }
    resultsEl.hidden = false;
  });

  // Capture response
  sec.querySelector('.verify-capture-resp-btn').addEventListener('click', async () => {
    const btn = sec.querySelector('.verify-capture-resp-btn');
    btn.disabled = true;
    btn.textContent = 'Reading page…';
    const result = await sendMessage({ action: 'CAPTURE_RESPONSE' });
    btn.disabled = false;
    btn.textContent = '🔍 Capture Active Tab Response';

    const resultsEl = sec.querySelector('.verify-results');
    if (!result?.ok) {
      resultsEl.innerHTML = `<p class="verify-result-error">Could not read tab: ${escHtml(result?.error || 'unknown')}</p>`;
      resultsEl.hidden = false;
      return;
    }

    const text = result.text;
    const checks = [
      { label: 'Date',      expected: date,  found: date  ? text.includes(date)  : null },
      { label: 'Time',      expected: time,  found: time  ? text.includes(time.substring(0,5)) : null },
      { label: 'Pax',       expected: pax,   found: pax   ? new RegExp(`\\b${pax}\\b`).test(text) : null },
      { label: 'Net Price', expected: price, found: price ? text.includes(price) : null },
    ].filter(c => c.expected && c.found !== null);

    if (!checks.length) {
      resultsEl.innerHTML = '<p class="verify-result-error">No booking values to match against.</p>';
    } else {
      resultsEl.innerHTML = checks.map((c, i) => renderVerifyRow(c, i)).join('');
      wireSkipBoxes(resultsEl, confirmRow);
    }
    resultsEl.hidden = false;
  });

  // Confirm & Flag button
  const confirmRow = sec.querySelector('.verify-confirm-row');
  const confirmBtn = sec.querySelector('.verify-confirm-btn');
  const confirmStatus = sec.querySelector('.verify-confirm-status');
  const bookingId = String(flat.bookingId || '');

  confirmBtn.addEventListener('click', async () => {
    // Defense in depth: even though the button is only revealed once every
    // mismatch is skipped, never allow a partial confirmation through.
    const totalMismatches = sec.querySelectorAll('.verify-result-row.nomatch').length;
    const skippedMismatches = sec.querySelectorAll('.verify-result-row.nomatch.skipped').length;
    if (totalMismatches > 0 && skippedMismatches < totalMismatches) {
      confirmStatus.textContent = `Check "Skip" for all ${totalMismatches} mismatched field(s) before confirming.`;
      confirmStatus.className = 'verify-confirm-status status-err';
      return;
    }

    const rowData = row => ({
      label: row.querySelector('.vr-label')?.textContent.trim() || '',
      value: row.querySelector('.vr-value')?.textContent.trim() || '',
    });
    const allRows = [...sec.querySelectorAll('.verify-result-row')];
    const confirmed = allRows.filter(r => r.classList.contains('match')).map(rowData);
    const skipped = allRows.filter(r => r.classList.contains('skipped')).map(rowData);

    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ Sending…';
    confirmStatus.textContent = '';

    const agentEmail = await getAgentEmail();

    // Use whichever screenshot was already captured/uploaded for AI Verify —
    // not a fresh one taken at confirm-time.
    const imgEl = sec.querySelector('.verify-img');
    let imageBase64 = null, mimeType = null;
    console.log('[BA] confirm screenshot debug:', {
      imgElFound: !!imgEl,
      srcPrefix: imgEl?.src?.slice(0, 30) || null,
      srcLength: imgEl?.src?.length || 0,
    });
    if (imgEl?.src?.startsWith('data:')) {
      const [header, b64] = imgEl.src.split(',');
      mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
      imageBase64 = b64;
    }

    const result = await sendMessage({
      action: 'SEND_VERIFY_FLAG',
      bookingId,
      agentEmail,
      confirmed,
      skipped,
      imageBase64,
      mimeType,
      verifiedAt: new Date().toISOString(),
      workerUrl: DEFAULT_WORKER_URL,
    });

    confirmBtn.disabled = false;
    confirmBtn.textContent = '✓ Confirm & Flag';

    if (result?.steps) console.log('[BA] /confirm-flag steps:', result.steps);

    if (result?.ok) {
      confirmStatus.textContent = result.screenshotError ? `✓ Flagged (screenshot: ${result.screenshotError})` : '✓ Flagged';
      confirmStatus.className = result.screenshotError ? 'verify-confirm-status status-warn' : 'verify-confirm-status status-ok';
    } else {
      confirmStatus.textContent = result?.error || 'Failed';
      confirmStatus.className = 'verify-confirm-status status-err';
    }
  });

  return sec;
}

// Late Confirm tab ──────────────────────────────────────────────────────────────
// For bookings that were already fulfilled without ever running the Verify
// flow (e.g. ticketed before this extension was used, or the step was simply
// missed) — lets an agent retroactively attach a screenshot and send the same
// Confirm & Flag Slack notification, unblocking whatever future Box Office
// workflow depends on that flag, without needing to re-run AI Verify checks.
function buildLateConfirmSection(flat) {
  const bookingId = String(flat.bookingId || '');

  const html = `
    <p class="instruction-empty" style="margin-bottom:10px;">
      Already booked and ticketed, but the Verify step got skipped? Attach a
      screenshot if you have one (optional), then confirm — this still sends
      the same Slack notification as Confirm &amp; Flag on the Verify tab.
    </p>

    <button class="btn btn-primary late-confirm-capture-btn" style="width:100%;margin-bottom:8px">📸 Capture Current Tab</button>
    <div class="drop-zone late-confirm-drop-zone">
      <input type="file" class="late-confirm-file-input" accept="image/*">
      <div class="drop-zone-inner">
        <div class="drop-zone-icon">🖼️</div>
        <p class="drop-zone-text">Or drop / upload / paste (Ctrl+V) — optional</p>
      </div>
    </div>
    <div class="verify-img-wrap late-confirm-img-wrap" hidden>
      <img class="late-confirm-img" alt="Ticket screenshot">
      <button class="verify-clear-btn late-confirm-clear-btn">✕ Clear</button>
    </div>

    <div class="verify-confirm-row late-confirm-row" style="margin-top:14px;">
      <button class="btn btn-primary late-confirm-btn">✓ Confirm &amp; Flag</button>
      <span class="verify-confirm-status late-confirm-status"></span>
    </div>
  `;

  const sec = buildSection('late-confirm', 'Late Confirm', '🚩', html);

  const imgEl = sec.querySelector('.late-confirm-img');
  const setImage = dataUrl => {
    imgEl.src = dataUrl;
    sec.querySelector('.late-confirm-img-wrap').hidden = false;
  };

  // Capture current tab
  sec.querySelector('.late-confirm-capture-btn').addEventListener('click', async () => {
    const btn = sec.querySelector('.late-confirm-capture-btn');
    const statusEl = sec.querySelector('.late-confirm-status');
    btn.disabled = true;
    btn.textContent = '⏳ Capturing…';

    let permGranted = true;
    try { permGranted = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (_) {}

    btn.disabled = false;
    btn.textContent = '📸 Capture Current Tab';

    if (!permGranted) {
      statusEl.textContent = 'Permission denied. Go to chrome://extensions → Booking Assistant → Details → Site access → On all sites.';
      statusEl.className = 'verify-confirm-status late-confirm-status status-err';
      return;
    }

    const result = await sendMessage({ action: 'CAPTURE_SCREENSHOT' });
    if (result?.ok) {
      setImage(result.dataUrl);
    } else {
      statusEl.textContent = `Screenshot failed: ${result?.error || 'unknown'}`;
      statusEl.className = 'verify-confirm-status late-confirm-status status-err';
    }
  });

  // Upload / drop / paste
  const dropZone = sec.querySelector('.late-confirm-drop-zone');
  const fileInput = sec.querySelector('.late-confirm-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => setImage(ev.target.result);
      reader.readAsDataURL(file);
    }
  });
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setImage(ev.target.result);
    reader.readAsDataURL(file);
  });
  document.addEventListener('paste', e => {
    if (sec.classList.contains('tab-section-hidden')) return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = ev => setImage(ev.target.result);
        reader.readAsDataURL(item.getAsFile());
        break;
      }
    }
  });

  // Clear image
  sec.querySelector('.late-confirm-clear-btn').addEventListener('click', () => {
    sec.querySelector('.late-confirm-img-wrap').hidden = true;
    imgEl.src = '';
    fileInput.value = '';
  });

  // Confirm & Flag (retroactive — no verification checks to gate on)
  const confirmBtn = sec.querySelector('.late-confirm-btn');
  const confirmStatus = sec.querySelector('.late-confirm-status');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ Sending…';
    confirmStatus.textContent = '';

    const agentEmail = await getAgentEmail();

    let imageBase64 = null, mimeType = null;
    if (imgEl.src?.startsWith('data:')) {
      const [header, b64] = imgEl.src.split(',');
      mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
      imageBase64 = b64;
    }

    const result = await sendMessage({
      action: 'SEND_VERIFY_FLAG',
      bookingId,
      agentEmail,
      confirmed: [],
      skipped: [],
      retroactive: true,
      imageBase64,
      mimeType,
      verifiedAt: new Date().toISOString(),
      workerUrl: DEFAULT_WORKER_URL,
    });

    confirmBtn.disabled = false;
    confirmBtn.textContent = '✓ Confirm & Flag';

    if (result?.steps) console.log('[BA] /confirm-flag (late) steps:', result.steps);

    if (result?.ok) {
      confirmStatus.textContent = result.screenshotError ? `✓ Flagged (screenshot: ${result.screenshotError})` : '✓ Flagged';
      confirmStatus.className = result.screenshotError ? 'verify-confirm-status late-confirm-status status-warn' : 'verify-confirm-status late-confirm-status status-ok';
    } else {
      confirmStatus.textContent = result?.error || 'Failed';
      confirmStatus.className = 'verify-confirm-status late-confirm-status status-err';
    }
  });

  return sec;
}

// Instructions tab ─────────────────────────────────────────────────────────────
function _instrContent(v) {
  if (!v) return null;
  return v.vendorTourImportantInstructions || v.importantInstructions || v.bookingInstructions
    || v.instructions || v.manualFulfillmentInstructions || v.fulfillmentInstructions
    || v.vendorInstructions || v.additionalInstructions || v.remarks
    || v.notes || v.bookingNotes || null;
}

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETE', 'CANCELLED', 'CANCELED', 'REFUNDED'];

function isTerminalBooking(flat) {
  const status = String(flat.status || '').toUpperCase();
  const fulfilmentStatus = String(flat.fulfilmentStatus || '').toUpperCase();
  return TERMINAL_STATUSES.includes(status) || TERMINAL_STATUSES.includes(fulfilmentStatus);
}

function isAutomationPending(flat) {
  const fulfilmentType = String(flat.fulfilmentType || '').toUpperCase();
  const isAutomation = fulfilmentType && fulfilmentType !== 'MANUAL';
  const fulfilmentStatus = String(flat.fulfilmentStatus || flat.status || '').toUpperCase();
  return isAutomation && fulfilmentStatus === 'PENDING';
}

function buildInstructionsSection(flat, vendors, vendorTourData = []) {
  if (isTerminalBooking(flat)) {
    return buildSection('instructions', 'Instructions', '📌',
      '<p class="instruction-empty">Booking is completed or cancelled — instructions no longer apply.</p>');
  }
  if (isAutomationPending(flat)) {
    return buildSection('instructions', 'Instructions', '📌',
      '<p class="instruction-empty">Automated fulfilment is still pending — manual instructions withheld until needed.</p>');
  }

  const blocks = [];

  // Booking-level instructions (rare, but some flows put them here)
  const flatInstr = flat.bookingInstructions || flat.instructions || flat.bookingNotes || null;
  if (flatInstr) blocks.push({ title: 'Important Instructions', instr: flatInstr });

  // vendorsInfo lists every candidate/alternate supplier for this tour — only the
  // vendor actually assigned to THIS booking is relevant for booking-specific
  // instructions, same as the Scorpio link and Product (Vendor) field elsewhere.
  // Showing all of them there surfaces irrelevant candidate-vendor notes
  // (e.g. plain "freesale" placeholders) for suppliers not in use.
  const primary = getPrimaryVendor(flat);
  const primaryIndex = primary ? vendors.indexOf(primary) : -1;

  if (primary) {
    const bookingInstr = primary.bookingInstructions || null;
    if (bookingInstr) {
      const title = primary.vendorName || `Vendor ${primaryIndex + 1}`;
      blocks.push({ title: `${title} — Booking Instructions`, instr: bookingInstr });
    }
  }

  // Vendor-tour SOP: check the assigned vendor first, but a real Calipso SOP is
  // uncommon enough (unlike the noisy bookingInstructions field) that it's safe
  // to fall back to whichever candidate vendor actually has one configured.
  let sopVendor = primary && _instrContent(vendorTourData?.[primaryIndex]) ? primary : null;
  let sopIndex = sopVendor ? primaryIndex : -1;
  if (!sopVendor) {
    const found = vendors.findIndex((v, i) => _instrContent(vendorTourData?.[i]));
    if (found !== -1) { sopVendor = vendors[found]; sopIndex = found; }
  }
  if (sopVendor) {
    const sop = _instrContent(vendorTourData?.[sopIndex]);
    const title = sopVendor.vendorName || `Vendor ${sopIndex + 1}`;
    blocks.push({ title: `${title} — Vendor SOP`, instr: sop });
  }

  if (!blocks.length) {
    return buildSection('instructions', 'Instructions', '📌',
      '<p class="instruction-empty">No booking instructions available.</p>');
  }

  let blocksHtml = '';
  blocks.forEach(({ title, instr }, i) => {
    let bodyHtml;
    if (isHtmlContent(instr)) {
      bodyHtml = `<div class="rich-instruction-wrapper">${instr}</div>`;
    } else {
      const lines = instr.split(/\n/).filter(Boolean);
      bodyHtml = `<div class="instruction-text">${
        lines.map(l => `<p class="instruction-para">${escHtml(l)}</p>`).join('')
      }</div>`;
    }
    blocksHtml += `<details class="instr-block instr-block--booking" ${i === 0 ? 'open' : ''}>
      <summary class="instr-block__header">
        <span class="instr-block__icon">📌</span>
        <span class="instr-block__title">${escHtml(title)}</span>
      </summary>
      <div class="instr-block__body">${bodyHtml}</div>
    </details>`;
  });

  const html = `
    <div class="instr-view-toggle">
      <button class="instr-view-btn active" data-view="scroll">Full</button>
      <button class="instr-view-btn" data-view="compact">Compact</button>
    </div>
    <div class="instr-container instr-view--scroll">${blocksHtml}</div>
  `;

  const sec = buildSection('instructions', 'Instructions', '📌', html);

  // Wire toggle after insertion
  sec.querySelectorAll('.instr-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sec.querySelectorAll('.instr-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const container = sec.querySelector('.instr-container');
      container.className = `instr-container instr-view--${btn.dataset.view}`;
      if (btn.dataset.view === 'compact') {
        container.querySelectorAll('details').forEach(d => d.open = true);
      }
    });
  });

  return sec;
}

// Customer tab ─────────────────────────────────────────────────────────────────
function buildCustomerSection(flat, guestData) {
  let html = '';

  if (guestData) {
    // Primary guest identity
    const pg = guestData.primaryGuest;
    if (pg) {
      const fullName = [pg.firstName, pg.lastName].filter(Boolean).join(' ');
      html += fieldRow('Name', fullName, true);
      html += fieldRow('Email', pg.email, true);
    }

    // Pax breakdown — right after Email, before the per-guest detail boxes
    if (guestData.paxDetails?.length) {
      const paxLabel = guestData.paxDetails
        .filter(p => p.count > 0)
        .map(p => `${p.count} ${p.count === 1 ? p.displayName : p.pluralDisplayName}`)
        .join(', ');
      if (paxLabel) html += fieldRow('Pax Breakdown', paxLabel, true);
    }

    // All user-provided fields, for EVERY guest — not just the first
    const guests = guestData.guests || [];
    guests.forEach((g, i) => {
      let guestHtml = '';
      if (g.bookingUserFields?.length) {
        g.bookingUserFields.forEach(f => {
          const type = f.tourUserFieldType?.name;
          if (f.value) {
            guestHtml += fieldRow(f.name || humanise(type || ''), f.value, true);
          }
        });
      }
      if (guestHtml) {
        const label = i === 0 ? 'Primary Guest' : `Additional Guest ${i}`;
        html += `<div class="guest-group">
          <div class="guest-group-label">${escHtml(label)}</div>
          ${guestHtml}
        </div>`;
      }
    });

  } else {
    // Fallback: basic fields from the booking response
    html += fieldRow('Guest Name',  flat.guestName, true);
    html += fieldRow('Guest Email', flat.guestEmail, true);
  }

  if (!html) html = '<p class="instruction-empty">No customer details available.</p>';
  const sec = buildSection('customer-details', 'Customer Details', '👤', html);
  wireCopyButtons(sec);
  return sec;
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
  if (status === 'AUTHENTICATED') {
    const restored = await restoreLastBooking();
    if (!restored) await autoDetect();
  }
})();
