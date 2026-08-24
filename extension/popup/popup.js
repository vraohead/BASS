// popup.js — BASS v10.0  (ES module, type="module")
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

  renderBooking(id, result.data, result.guestData, result.showAutomationModal);
}

// ── Render booking ────────────────────────────────────────────────────────────

function renderBooking(id, data, guestData, showAutomationModal) {
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

  const primary = getPrimaryVendor(flat);
  const instrVendors = primary ? [primary] : vendors;

  const details = $('ticket-details');
  details.innerHTML = '';
  details.appendChild(buildBookingSection(flat));
  details.appendChild(buildInstructionsSection(instrVendors));
  details.appendChild(buildCustomerSection(flat, guestData));
  details.appendChild(buildVerifySection(flat, guestData));

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

  const date  = flat.inventoryDate || flat.bookingDate || '';
  const time  = flat.inventoryTime || '';
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

  // Time to Experience: pre-computed server-side field (timezone-correct)
  let tte = '';
  if (flat.actualLeadTimeInHours != null) {
    const totalH = Math.abs(flat.actualLeadTimeInHours);
    const d = Math.floor(totalH / 24);
    const h = totalH % 24;
    tte = `${flat.actualLeadTimeInHours < 0 ? '-' : '+'}${d}d ${h}h`;
  }

  const fact = (label, valueHtml, cls = '') =>
    valueHtml ? `<div class="bs-fact${cls ? ' ' + cls : ''}">
      <span class="bs-fact-label">${label}</span>
      <span class="bs-fact-value">${valueHtml}</span>
    </div>` : '';

  bar.innerHTML = `
    ${flat.productName ? `<div class="bs-tour">${escHtml(flat.productName)}</div>` : ''}
    <div class="bs-facts">
      ${date  ? fact('Date',   escHtml(date))  : ''}
      ${time  ? fact('Time',   escHtml(time))  : ''}
      ${pax   ? fact('Pax',   escHtml(pax))   : ''}
      ${price ? fact('Net',   escHtml(price)) : ''}
      ${tte   ? fact('TTE',   escHtml(tte), tte.startsWith('-') ? 'bs-fact--past' : 'bs-fact--future') : ''}
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
  ['createdAt',        'Created'],
  ['updatedAt',        'Updated'],
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
      <span class="field-value"><a href="https://scorpio.headout.com/admin/vendor/vendortour/?tour=${primary.tourId}&vendor_id=${primary.vendorId}" target="_blank" rel="noopener" class="quick-link">${escHtml(primary.vendorName || 'Vendor')} ↗</a></span>
    </div>`;
  }

  let html = linksHtml
    ? `<div class="quick-links-group">${linksHtml}</div><div class="quick-links-divider"></div>`
    : '';

  // ── Standard fields ──────────────────────────────────────────────────────
  const HIDDEN = new Set([
    ...BOOKING_FIELDS.map(f => f[0]),
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
  ]);

  html += BOOKING_FIELDS.map(([key, label]) => fieldRow(label, flat[key])).join('');

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

  for (const [key, v] of Object.entries(flat)) {
    if (HIDDEN.has(key) || v == null || typeof v === 'object') continue;
    html += fieldRow(humanise(key), v);
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
      errEl.innerHTML = `<p class="verify-result-error">Permission denied. Go to chrome://extensions → BASS → Details → Site access → On all sites.</p>`;
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
      resultsEl.innerHTML = `<p class="verify-result-error">Error: ${escHtml(result?.error || 'unknown')}</p>`;
      resultsEl.hidden = false;
      return;
    }

    const checks = result.checks || [];
    if (!checks.length) {
      resultsEl.innerHTML = '<p class="verify-result-error">No results returned from AI.</p>';
    } else {
      resultsEl.innerHTML = checks.map(c => `
        <div class="verify-result-row ${c.found ? 'match' : 'nomatch'}">
          <span class="vr-icon">${c.found ? '✓' : '✗'}</span>
          <span class="vr-label">${escHtml(c.label)}</span>
          <span class="vr-value">${escHtml(String(c.expected))}</span>
          <span class="vr-status">${c.found ? 'Found' : 'Not found'}</span>
        </div>
      `).join('');
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
      resultsEl.innerHTML = checks.map(c => `
        <div class="verify-result-row ${c.found ? 'match' : 'nomatch'}">
          <span class="vr-icon">${c.found ? '✓' : '✗'}</span>
          <span class="vr-label">${escHtml(c.label)}</span>
          <span class="vr-value">${escHtml(c.expected)}</span>
          <span class="vr-status">${c.found ? 'Found' : 'Not found'}</span>
        </div>
      `).join('');
    }
    resultsEl.hidden = false;
  });

  return sec;
}

// Instructions tab ─────────────────────────────────────────────────────────────
function buildInstructionsSection(vendors) {
  const withInstr = vendors.filter(v => v.bookingInstructions);
  if (!withInstr.length) {
    return buildSection('instructions', 'Instructions', '📌',
      '<p class="instruction-empty">No booking instructions available.</p>');
  }

  let blocksHtml = '';
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


  } else {
    // Fallback: basic fields from the booking response
    html += fieldRow('Guest Name',  flat.guestName);
    html += fieldRow('Guest Email', flat.guestEmail);
  }

  if (!html) html = '<p class="instruction-empty">No customer details available.</p>';
  return buildSection('customer-details', 'Customer Details', '👤', html);
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
