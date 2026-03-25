// sidepanel.js — BASS v5.0 (clean architecture)

const STORAGE_KEY_THEME = 'theme';

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
}
function loadTheme() {
  chrome.storage.local.get(STORAGE_KEY_THEME, r => applyTheme(r[STORAGE_KEY_THEME] || 'dark'));
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  chrome.storage.local.set({ [STORAGE_KEY_THEME]: next });
  applyTheme(next);
}

// ── Error helpers ─────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-message');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function hideError() { showError(''); }

// ── Tab navigation ────────────────────────────────────────────────────────
const TABS = [
  { id: 'important-links',  label: '🔗 Links' },
  { id: 'instructions',     label: '📋 Instructions' },
  { id: 'full-booking',     label: '🗓️ Booking' },
  { id: 'customer-details', label: '👤 Customer' },
  { id: 'pseudo-email',     label: '📧 Email Gen' },
];

function buildTabNav() {
  document.getElementById('tab-nav')?.remove();
  const nav = document.createElement('div');
  nav.id = 'tab-nav'; nav.className = 'tab-nav';
  TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tab-pill'; btn.dataset.target = t.id; btn.textContent = t.label;
    btn.addEventListener('click', () => showSection(t.id, btn));
    nav.appendChild(btn);
  });
  const details = document.getElementById('ticket-details');
  details.parentNode.insertBefore(nav, details);
  const firstPill = nav.querySelector('.tab-pill');
  if (firstPill) firstPill.classList.add('active');
}

function showSection(id, btn) {
  document.querySelectorAll('#ticket-details [data-section-id]').forEach(s => {
    s.classList.add('tab-section-hidden');
  });
  const target = document.querySelector(`#ticket-details [data-section-id="${id}"]`);
  if (target) {
    target.classList.remove('tab-section-hidden');
    target.classList.add('section-flash');
    setTimeout(() => target.classList.remove('section-flash'), 900);
    document.getElementById('ticket-details').scrollTop = 0;
  }
  document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
}

function hideTabNav() { document.getElementById('tab-nav')?.remove(); }

// ── BMS Tab Mismatch Warning ────────────────────────────────────────────
function handleBmsTabChange(bmsBookingId) {
  const warn     = document.getElementById('bms-warning');
  const loadedId = document.getElementById('ticket-input')?.value?.trim();
  if (!warn) return;
  if (bmsBookingId && loadedId && String(bmsBookingId) !== String(loadedId)) {
    warn.innerHTML =
      `⚠️ <strong>BMS Tab Mismatch!</strong> ` +
      `You are viewing Booking <strong>${esc(bmsBookingId)}</strong> in BMS ` +
      `but <strong>${esc(loadedId)}</strong> is loaded in BASS.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}
// ── Portal Date/Time Mismatch Warning ─────────────────────────────────────
// Receives normalised date/time found on the active portal page and compares
// against what's currently loaded in BASS.

// ── Footer scroll ─────────────────────────────────────────────────────────
let _footerHandler = null;
function enableFooterScroll() {
  const pane   = document.getElementById('ticket-details');
  const footer = document.querySelector('.app-footer');
  footer.classList.add('footer-hidden');
  _footerHandler = () => {
    const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 50;
    footer.classList.toggle('footer-hidden', !near);
  };
  pane.addEventListener('scroll', _footerHandler);
}
function disableFooterScroll() {
  const pane = document.getElementById('ticket-details');
  if (_footerHandler) { pane.removeEventListener('scroll', _footerHandler); _footerHandler = null; }
  document.querySelector('.app-footer')?.classList.remove('footer-hidden');
}

// ── DOM ready ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTheme();

  // ── BMS Tab Mismatch: listen for tab changes broadcast by background ──
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'BMS_TAB_CHANGE') handleBmsTabChange(msg.bmsBookingId);
  });
  // Also check whichever tab is already active when the panel opens
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.url) {
      const m = tabs[0].url.match(/\/bms\/booking\/(\d+)/);
      handleBmsTabChange(m ? m[1] : null);
    }
  });

  const input   = document.getElementById('ticket-input');
  const fetchBtn = document.getElementById('fetch-ticket');
  const clearBtn = document.getElementById('clear-ticket');
  const pane     = document.getElementById('ticket-details');
  const spinner  = document.getElementById('loading-spinner');

  // Restore the last searched Booking ID so it persists across sidepanel sessions
  chrome.storage.local.get('lastBookingId', r => {
    if (r.lastBookingId) input.value = r.lastBookingId;
  });

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') fetchBtn.click(); });

  fetchBtn.addEventListener('click', () => {
    const bookingId = input.value.trim();
    if (!bookingId) { showError('Please enter a Booking ID.'); return; }

    hideError();
    spinner.style.display = 'flex';
    pane.innerHTML = '';
    hideTabNav();
    document.querySelector('.app-footer')?.classList.add('footer-fetch-hidden');
    fetchBtn.disabled = true;
    fetchBtn.textContent = '⟳ Fetching...';

    chrome.storage.local.set({ lastBookingId: bookingId });

    chrome.runtime.sendMessage({ action: 'FETCH_BOOKING', bookingId }, response => {
      spinner.style.display = 'none';
      fetchBtn.disabled = false;
      fetchBtn.textContent = '⟳ Fetch';

      if (!response || response.error) {
        showError(response?.error || 'No data found for this Booking ID.');
        document.querySelector('.app-footer')?.classList.remove('footer-fetch-hidden');
        return;
      }
      try {
        renderTicketDetails(response, pane, bookingId);
        buildTabNav();
        enableFooterScroll();
        // footer stays hidden — already hidden above
      } catch (err) {
        showError('Render error: ' + err.message);
        document.querySelector('.app-footer')?.classList.remove('footer-fetch-hidden');
      }
    });
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    chrome.storage.local.remove(['lastBookingId', 'lastBookingDate', 'lastBookingTime']);
    document.getElementById('dt-warning')?.classList.add('hidden');
    document.getElementById('dt-warning')?.classList.remove('danger');
    if (_timeLeftInterval) { clearInterval(_timeLeftInterval); _timeLeftInterval = null; }
    _lastBookingParams = null;
    const bmsEl = document.getElementById('header-bms-link');
    if (bmsEl) { bmsEl.classList.remove('visible'); bmsEl.removeAttribute('href'); }
    pane.innerHTML = '<div class="welcome-placeholder"><p>Enter a Booking ID and click Fetch to get started.</p></div>';
    hideError();
    hideTabNav();
    disableFooterScroll();
    document.getElementById('datetime-bar')?.classList.add('hidden');
    document.querySelector('.app-footer')?.classList.remove('footer-fetch-hidden');
  });

  pane.innerHTML = '<div class="welcome-placeholder"><p>Enter a Booking ID and click Fetch to get started.</p></div>';
});

// ── Render ────────────────────────────────────────────────────────────────
function renderTicketDetails(data, container, fetchedBookingId) {
  // Normalize response envelope
  const norm = d => {
    if (!d) return null;
    if (d.payload && typeof d.payload === 'object') d = d.payload;
    if (d.data   && typeof d.data   === 'object') d = d.data;
    if (d.ticketDetails?.ticketDetails) d = d.ticketDetails;
    if (!d.ticketDetails && d.htmlBody) {
      try { const p = parseTicketHtml(d.htmlBody); p.subject = d.subject || 'N/A'; return p; }
      catch (_) { return d; }
    }
    return d;
  };

  data = norm(data);
  if (!data?.ticketDetails) {
    container.innerHTML = '<p style="color:var(--red);padding:16px;">No ticket data found.</p>';
    return;
  }

  const { ticketDetails: td, instructions: ins } = data;
  const {
    productDetails:  pd = {},
    bookingDetails:  bd = {},
    customerDetails: cd = { guests: [] },
    postBookingInfo: pb = {},
    links:           lk = {}
  } = td;

  const imp = { summary: ins?.importantInstructions?.summary || '', steps: ins?.importantInstructions?.steps || [], richHtml: ins?.importantInstructions?.richHtml || null };
  const bkg = { summary: ins?.bookingInstructions?.summary   || '', steps: ins?.bookingInstructions?.steps   || [], richHtml: ins?.bookingInstructions?.richHtml   || null };

  // Cache guest name for email generator (look for first Name-like field)
  if (cd.guests?.length) {
    const first = cd.guests[0];
    const nameLine = first.lines?.find(l => /\bname\b/i.test(l.label));
    const name = nameLine?.value || '';
    try { chrome.storage.local.set({ lastGuestName: name }); }
    catch (_) { try { localStorage.setItem('lastGuestName', name); } catch (_) {} }
  }

  const frag = document.createDocumentFragment();

  // ── Important Links ───────────────────────────────────────────────────
  // BMS link: use ticket link if present, otherwise construct from fetched booking ID
  let bmsLinkUrl = lk.bmsLink;
  if (!isUrl(bmsLinkUrl) && fetchedBookingId) {
    bmsLinkUrl = `https://aries.headout.com/bms/booking/${fetchedBookingId}`;
  }

  const linkSec = sec('🔗', 'Important Links', 'important-links');
  const lb = linkSec.querySelector('.section-body');
  lb.appendChild(linkBtn('BMS Link', '🎫', bmsLinkUrl));
  lb.appendChild(linkBtn('Aries Inventory Link', '📋', lk.ariesInventoryLink));
  lb.appendChild(linkBtn('Product Link', '📦', lk.productLink));
  lb.appendChild(linkBtn('Vendor Link', '🏪', lk.vendorLink));
  frag.appendChild(linkSec);

  // ── Instructions ──────────────────────────────────────────────────────
  const instrSec = sec('📋', 'Instructions', 'instructions');
  const ib = instrSec.querySelector('.section-body');
  const hasImp = imp.summary || imp.steps.length || imp.richHtml;
  const hasBkg = bkg.summary || bkg.steps.length || bkg.richHtml;

  if (hasImp) ib.appendChild(instrBlock('important', '⚠️', 'Important Instructions', imp));
  if (hasBkg) ib.appendChild(instrBlock('booking',   '📋', 'Booking Instructions',   bkg));
  if (!hasImp && !hasBkg) ib.innerHTML = '<p class="instruction-empty">No instructions provided for this ticket.</p>';
  frag.appendChild(instrSec);

  // ── Full Booking Details ──────────────────────────────────────────────
  const bkSec = sec('🗓️', 'Booking Details', 'full-booking');
  appendRows(bkSec.querySelector('.section-body'), [
    fr('Tour Name',       pd.tourName),
    fr('City',            pd.city || pd.location || pd.destination || pd.venue),
    fr('Date',            bd.date),
    fr('Start Time',      bd.startTime),
    fr('Guest Numbers',   bd.guestNumbers),
    fr('Final Price Paid',bd.finalPricePaid),
    fr('Net Price',       bd.netPrice),
    fr('Promo Discount',  bd.promoDiscount),
  ]);
  frag.appendChild(bkSec);

  // ── Customer Details ──────────────────────────────────────────────────
  const custSec = sec('👤', 'Customer Details', 'customer-details');
  const cb = custSec.querySelector('.section-body');
  const guests = cd.guests || [];
  if (!guests.length) {
    cb.innerHTML = '<p class="instruction-empty">No guest details found.</p>';
  } else {
    guests.forEach(g => {
      const card = mkEl('div', 'guest-card');
      if (g.guestType) {
        const badge = mkEl('div', 'guest-type-badge');
        badge.textContent = fmtGuestType(g.guestType);
        card.appendChild(badge);
      }
      const lines = g.lines || [];
      if (!lines.length) {
        const p = mkEl('p', 'instruction-empty'); p.textContent = 'No details found.';
        card.appendChild(p);
      } else {
        appendRows(card, lines.map(({ label, value }) => fr(label, value, true)));
      }
      cb.appendChild(card);
    });
  }
  frag.appendChild(custSec);

  // ── Pseudo Email Generator ────────────────────────────────────────────
  frag.appendChild(buildEmailSection(bd));

  container.appendChild(frag);

  // Hide all sections except the first (key-details) — tabs control visibility
  const allSections = container.querySelectorAll('[data-section-id]');
  allSections.forEach((s, i) => { if (i > 0) s.classList.add('tab-section-hidden'); });

  // Populate the pinned date/time bar
  const city = pd.city || pd.location || pd.destination || pd.venue || '';
  updateDatetimeBar(bd.date, bd.startTime, city);

  // Populate BMS link in header
  const bmsEl = document.getElementById('header-bms-link');
  if (bmsEl && isUrl(bmsLinkUrl)) {
    bmsEl.href = bmsLinkUrl;
    bmsEl.classList.add('visible');
  }

  // Wire copy buttons
  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy || '').then(() => {
        btn.textContent = '✓'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('copied'); }, 1200);
      });
    });
  });
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function mkEl(tag, className, inlineStyle) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (inlineStyle) el.style.cssText = inlineStyle;
  return el;
}

/** Create a section card */
function sec(icon, title, sectionId) {
  const el = document.createElement('div');
  el.className = 'section';
  if (sectionId) el.dataset.sectionId = sectionId;
  el.innerHTML = `<div class="section-header"><div class="section-title"><span class="section-icon">${icon}</span>${esc(title)}</div></div><div class="section-body"></div>`;
  return el;
}

/** Append an array of pre-built HTML strings as DOM nodes */
function appendRows(parent, rows) {
  rows.forEach(html => {
    if (!html) return;
    const t = document.createElement('div'); t.innerHTML = html;
    while (t.firstChild) parent.appendChild(t.firstChild);
  });
}

/** Standard field row */
function fr(label, value, copyable) {
  const isNA = !value || value === 'N/A' || value === 'null';
  const cls  = isNA ? 'field-value na' : 'field-value';
  const v    = esc(isNA ? 'N/A' : String(value));
  const copy = (copyable && !isNA) ? `<button class="copy-btn" data-copy="${esc(String(value))}" title="Copy">⧉</button>` : '';
  return `<div class="field-row"><span class="field-label">${esc(label)}</span><span class="${cls}">${v}${copy}</span></div>`;
}

/** Booking ID with badge */
function bookingIdRow(value) {
  const isNA = !value || value === 'N/A';
  if (isNA) return fr('Booking ID', 'N/A');
  return `<div class="field-row"><span class="field-label">BOOKING ID</span><span class="field-value"><span class="booking-id-badge">${esc(String(value))}</span><button class="copy-btn" data-copy="${esc(String(value))}" title="Copy">⧉</button></span></div>`;
}

/** Cancellable / Reschedulable row */
function statusRow(label, yesNo, upto) {
  const isY = yesNo?.toUpperCase() === 'Y';
  const isN = yesNo?.toUpperCase() === 'N';
  const badge = isY ? '<span class="status-badge yes">Yes</span>'
              : isN ? '<span class="status-badge no">No</span>'
              : `<span class="status-badge na">${esc(yesNo || 'N/A')}</span>`;
  const uptoStr = (upto && upto !== 'N/A' && upto !== '0' && upto !== 'null') ? ` <span class="status-upto">up to ${esc(upto)}</span>` : '';
  return `<div class="field-row"><span class="field-label">${esc(label)}</span><span class="field-value">${badge}${uptoStr}</span></div>`;
}

/** Link button */
function linkBtn(label, icon, url) {
  const ok = isUrl(url);
  if (ok) {
    const a = mkEl('a', 'link-btn'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = `${icon} ${label}`;
    return a;
  }
  const d = mkEl('div', 'link-btn na'); d.textContent = `${icon} ${label} — Not found in ticket`;
  return d;
}

/**
 * Self-contained instruction block card.
 * type: 'important' (amber left-border) | 'booking' (accent left-border)
 */
function instrBlock(type, icon, title, instr) {
  const card = mkEl('div', 'instr-block instr-block--' + type);
  const hdr  = mkEl('div', 'instr-block__header');
  const iconEl = mkEl('span', 'instr-block__icon'); iconEl.textContent = icon;
  const titleEl = mkEl('span', 'instr-block__title'); titleEl.textContent = title;
  hdr.appendChild(iconEl); hdr.appendChild(titleEl);
  card.appendChild(hdr);
  const body = mkEl('div', 'instr-block__body');
  renderInstruction(body, instr);
  card.appendChild(body);
  return card;
}

// ── Instruction rendering ─────────────────────────────────────────────────

function renderInstruction(container, instr) {
  if (!instr) { container.innerHTML = '<p class="instruction-empty">No instructions.</p>'; return; }
  const raw = (instr.richHtml || '').trim();

  // Always prefer the raw HTML/text captured from Zendesk — don't summarise.
  if (raw.length > 3) {
    if (renderRichHtml(container, raw)) return;
    // renderRichHtml returned false (empty after tag-stripping) — show as plain text
    const p = mkEl('p', 'summary-text'); p.textContent = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    container.appendChild(p);
    return;
  }
  container.innerHTML = '<p class="instruction-empty">No instructions available.</p>';
}

function renderRichHtml(container, html) {
  const w = mkEl('div', 'rich-instruction-wrapper');
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/\s+on\w+="[^"]*"/gi,'')
    .replace(/href="javascript:[^"]*"/gi,'href="#"')
    .replace(/<form[\s\S]*?<\/form>/gi,'')
    .replace(/<(?:input|link|meta)[^>]*>/gi,'');

  if (!s.replace(/<[^>]*>/g,'').trim()) return false;

  s = s
    .replace(/<h([1-6])([^>]*)>/gi,(_,n,a)=>`<div class="rich-heading rich-h${n}"${a}>`)
    .replace(/<\/h[1-6]>/gi,'</div>')
    .replace(/<ol[^>]*>/gi,'<ol class="rich-ordered-list">')
    .replace(/<ul[^>]*>/gi,'<ul class="rich-unordered-list">')
    .replace(/<li([^>]*)>/gi,(_,a)=>`<li class="rich-list-item"${a}>`)
    .replace(/<p([^>]*)>/gi,'<p class="rich-paragraph"$1>')
    .replace(/<div([^>]*style="[^"]*(?:background|border|color)[^"]*"[^>]*)>/gi,'<div class="rich-styled-box"$1>')
    .replace(/<div[^>]*>/gi,'<div class="rich-div">')
    .replace(/<b([^>]*)>/gi,'<strong$1>')
    .replace(/<\/b>/gi,'</strong>')
    .replace(/<i([^>]*)>/gi,'<em$1>')
    .replace(/<\/i>/gi,'</em>')
    .replace(/<table[^>]*>/gi,'<table class="rich-table">')
    .replace(/<tr[^>]*>/gi,'<tr class="rich-table-row">')
    .replace(/<td([^>]*)>/gi,'<td class="rich-table-cell"$1>')
    .replace(/<th([^>]*)>/gi,'<th class="rich-table-header"$1>')
    .replace(/<a\s+([^>]*?)href=/gi,'<a target="_blank" rel="noopener noreferrer" $1href=');

  try {
    w.innerHTML = s;
    w.querySelectorAll('a').forEach(a => { a.target='_blank'; a.rel='noopener noreferrer'; a.classList.add('rich-link'); });
    w.querySelectorAll('img').forEach(i => i.style.display='none');
    container.appendChild(w); return true;
  } catch(_) { return false; }
}

function renderSummarySteps(container, summary, steps) {
  const pre = mkEl('div', 'instruction-preamble'); pre.textContent = summary;
  container.appendChild(pre);
  renderSteps(container, steps);
}

function renderSummaryOnly(container, summary) {
  const b = mkEl('div', 'instruction-summary-box');
  b.innerHTML = `<div class="summary-label">Summary</div><p class="summary-text">${esc(summary)}</p>`;
  container.appendChild(b);
}

function renderSteps(container, steps) {
  const wrap = mkEl('div', 'instruction-steps-container');
  steps.forEach(step => {
    const s = mkEl('div', 'instruction-step');
    const [main, ...rest] = step.split('\n');
    const subs = rest.map(l => l.replace(/^\s*[•\-✓→*]\s*/, '').trim()).filter(Boolean);
    const m = mkEl('div', 'step-main');
    m.innerHTML = `<span class="step-content">${esc(main)}</span>`;
    s.appendChild(m);
    if (subs.length) {
      const sc = mkEl('div', 'step-subs');
      subs.forEach(t => { const d = mkEl('div', 'step-sub-item'); d.innerHTML = `<span class="sub-bullet">•</span><span class="sub-text">${esc(t)}</span>`; sc.appendChild(d); });
      s.appendChild(sc);
    }
    wrap.appendChild(s);
  });
  container.appendChild(wrap);
}

function renderPlainText(container, text) {
  const b = mkEl('div', 'instruction-summary-box');
  b.innerHTML = `<p class="summary-text">${esc(text)}</p>`;
  container.appendChild(b);
}

// ── Pseudo Email Generator ────────────────────────────────────────────────

function buildEmailSection(bd) {
  const s = sec('📧', 'Pseudo Email Generator', 'pseudo-email');
  const body = s.querySelector('.section-body');

  // Type selector
  body.appendChild(labelEl('Email Type'));
  const typeSelect = mkEl('select', 'email-select'); typeSelect.id = 'email-type';
  [['', 'Select option'], ['volitand', 'Volitand'], ['veritt', 'Veritt'], ['gmail', 'Gmail']].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; typeSelect.appendChild(o);
  });
  body.appendChild(typeSelect);

  // Gmail account selector (hidden by default)
  const gmailWrap = mkEl('div', ''); gmailWrap.style.display = 'none'; gmailWrap.id = 'gmail-wrap';
  gmailWrap.appendChild(labelEl('Gmail Account'));
  const accSelect = mkEl('select', 'email-select'); accSelect.id = 'email-gmail-acc';
  [['', 'Select account'], ['michielanmichele50', 'michielanmichele50'], ['amreentanaz4', 'amreentanaz4']].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; accSelect.appendChild(o);
  });
  gmailWrap.appendChild(accSelect);
  body.appendChild(gmailWrap);

  // Password info
  const pw = mkEl('div', 'password-info');
  pw.innerHTML = '<span class="password-info-title">🔐 Passwords:</span>' +
    '<div class="password-info-row">Partnered: <code class="password-code">Headout@123</code></div>' +
    '<div class="password-info-row">Non-Partnered: <code class="password-code">Forget@123</code> or <code class="password-code">Forget_[BookingID]</code></div>';
  body.appendChild(pw);

  // Result
  const result = mkEl('div', 'email-result'); result.id = 'email-result';
  result.innerHTML = '<div class="email-result-row"><div class="email-result-info"><div class="email-result-caption">Generated Email:</div><div class="email-result-value" id="email-display"></div></div><button class="email-copy-btn" id="email-copy-btn">Copy</button></div>';
  body.appendChild(result);

  // Buttons
  const btnRow = mkEl('div', 'email-btn-row');
  const genBtn = mkEl('button', 'email-gen-btn'); genBtn.id = 'email-gen-btn'; genBtn.textContent = '✨ Generate Email';
  const clrBtn = mkEl('button', 'email-clr-btn'); clrBtn.textContent = 'Clear';
  btnRow.appendChild(genBtn); btnRow.appendChild(clrBtn);
  body.appendChild(btnRow);

  // Events
  typeSelect.addEventListener('change', () => { gmailWrap.style.display = typeSelect.value === 'gmail' ? 'block' : 'none'; });

  genBtn.addEventListener('click', async () => {
    if (!typeSelect.value) { showError('Please select an email type'); return; }
    if (typeSelect.value === 'gmail' && !accSelect.value) { showError('Please select a Gmail account'); return; }
    genBtn.disabled = true; genBtn.textContent = '⏳ Generating...';
    try {
      const email = await generateEmail(typeSelect.value, bd.bookingId || 'UNKNOWN', accSelect.value);
      result.style.display = 'block';
      body.querySelector('#email-display').textContent = email;
      hideError();
    } catch (e) { showError('Error: ' + e.message); }
    finally { genBtn.disabled = false; genBtn.textContent = '✨ Generate Email'; }
  });

  clrBtn.addEventListener('click', () => {
    typeSelect.value = ''; gmailWrap.style.display = 'none'; result.style.display = 'none'; hideError();
  });

  // Copy button (after DOM insertion)
  setTimeout(() => {
    body.querySelector('#email-copy-btn')?.addEventListener('click', () => {
      const email = body.querySelector('#email-display').textContent;
      navigator.clipboard.writeText(email).then(() => {
        const btn = body.querySelector('#email-copy-btn');
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    });
  }, 0);

  return s;
}

function labelEl(text) {
  const l = mkEl('label', 'email-label'); l.textContent = text; return l;
}

async function generateEmail(type, bookingId, gmailAcc) {
  const guestName = await new Promise(res => {
    try { chrome.storage.local.get(['lastGuestName'], r => res(r?.lastGuestName || 'guest')); }
    catch (_) { try { res(localStorage.getItem('lastGuestName') || 'guest'); } catch (_) { res('guest'); } }
  });
  const name = guestName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  if (type === 'gmail')    return `${gmailAcc}+${bookingId}@gmail.com`;
  if (type === 'volitand') return `${name}_${bookingId}@volitand.com`;
  if (type === 'veritt')   return `${name}_${bookingId}@veritt.com`;
  throw new Error('Unknown email type');
}

// ── Date/Time bar ─────────────────────────────────────────────────────────

// ── City → IANA Timezone mapping ────────────────────────────────────────────────────
const CITY_TZ_MAP = [
  // Europe
  ['london','Europe/London'],     ['edinburgh','Europe/London'],   ['dublin','Europe/Dublin'],
  ['paris','Europe/Paris'],       ['rome','Europe/Rome'],           ['milan','Europe/Rome'],
  ['venice','Europe/Rome'],       ['florence','Europe/Rome'],       ['naples','Europe/Rome'],
  ['madrid','Europe/Madrid'],     ['barcelona','Europe/Madrid'],    ['seville','Europe/Madrid'],
  ['amsterdam','Europe/Amsterdam'],['berlin','Europe/Berlin'],      ['munich','Europe/Berlin'],
  ['frankfurt','Europe/Berlin'],  ['hamburg','Europe/Berlin'],      ['cologne','Europe/Berlin'],
  ['vienna','Europe/Vienna'],     ['prague','Europe/Prague'],       ['budapest','Europe/Budapest'],
  ['warsaw','Europe/Warsaw'],     ['krakow','Europe/Warsaw'],       ['athens','Europe/Athens'],
  ['istanbul','Europe/Istanbul'], ['lisbon','Europe/Lisbon'],       ['porto','Europe/Lisbon'],
  ['copenhagen','Europe/Copenhagen'],['stockholm','Europe/Stockholm'],['oslo','Europe/Oslo'],
  ['helsinki','Europe/Helsinki'], ['zurich','Europe/Zurich'],       ['geneva','Europe/Zurich'],
  ['brussels','Europe/Brussels'], ['luxembourg','Europe/Luxembourg'],
  ['moscow','Europe/Moscow'],     ['st. petersburg','Europe/Moscow'],['saint petersburg','Europe/Moscow'],
  ['kyiv','Europe/Kiev'],         ['bucharest','Europe/Bucharest'], ['sofia','Europe/Sofia'],
  ['zagreb','Europe/Zagreb'],     ['belgrade','Europe/Belgrade'],   ['valletta','Europe/Malta'],
  ['reykjavik','Atlantic/Reykjavik'],
  // North America
  ['new york','America/New_York'],['nyc','America/New_York'],       ['boston','America/New_York'],
  ['washington','America/New_York'],['philadelphia','America/New_York'],['miami','America/New_York'],
  ['orlando','America/New_York'], ['atlanta','America/New_York'],   ['toronto','America/Toronto'],
  ['montreal','America/Toronto'], ['ottawa','America/Toronto'],     ['detroit','America/Detroit'],
  ['chicago','America/Chicago'],  ['dallas','America/Chicago'],     ['houston','America/Chicago'],
  ['minneapolis','America/Chicago'],['new orleans','America/Chicago'],
  ['denver','America/Denver'],    ['phoenix','America/Phoenix'],
  ['las vegas','America/Los_Angeles'],['los angeles','America/Los_Angeles'],
  ['san francisco','America/Los_Angeles'],['seattle','America/Los_Angeles'],
  ['portland','America/Los_Angeles'],['san diego','America/Los_Angeles'],
  ['vancouver','America/Vancouver'],['calgary','America/Edmonton'],
  ['mexico city','America/Mexico_City'],['cancun','America/Cancun'],
  // South America
  ['buenos aires','America/Argentina/Buenos_Aires'],
  ['rio de janeiro','America/Sao_Paulo'],['sao paulo','America/Sao_Paulo'],['são paulo','America/Sao_Paulo'],
  ['santiago','America/Santiago'],['bogota','America/Bogota'],['lima','America/Lima'],
  // Middle East
  ['dubai','Asia/Dubai'],         ['abu dhabi','Asia/Dubai'],       ['sharjah','Asia/Dubai'],
  ['doha','Asia/Qatar'],          ['riyadh','Asia/Riyadh'],         ['jeddah','Asia/Riyadh'],
  ['muscat','Asia/Muscat'],       ['kuwait','Asia/Kuwait'],         ['bahrain','Asia/Bahrain'],
  ['tel aviv','Asia/Jerusalem'],  ['jerusalem','Asia/Jerusalem'],   ['beirut','Asia/Beirut'],
  ['amman','Asia/Amman'],         ['tehran','Asia/Tehran'],
  // Africa
  ['cairo','Africa/Cairo'],       ['casablanca','Africa/Casablanca'],['marrakech','Africa/Casablanca'],
  ['rabat','Africa/Casablanca'],  ['tunis','Africa/Tunis'],         ['algiers','Africa/Algiers'],
  ['tripoli','Africa/Tripoli'],   ['nairobi','Africa/Nairobi'],     ['lagos','Africa/Lagos'],
  ['accra','Africa/Accra'],
  ['johannesburg','Africa/Johannesburg'],['cape town','Africa/Johannesburg'],['durban','Africa/Johannesburg'],
  ['addis ababa','Africa/Addis_Ababa'],['kampala','Africa/Kampala'],
  // South / Southeast Asia
  ['mumbai','Asia/Kolkata'],      ['delhi','Asia/Kolkata'],         ['new delhi','Asia/Kolkata'],
  ['bangalore','Asia/Kolkata'],   ['bengaluru','Asia/Kolkata'],     ['chennai','Asia/Kolkata'],
  ['kolkata','Asia/Kolkata'],     ['hyderabad','Asia/Kolkata'],     ['goa','Asia/Kolkata'],
  ['agra','Asia/Kolkata'],        ['jaipur','Asia/Kolkata'],        ['pune','Asia/Kolkata'],
  ['karachi','Asia/Karachi'],     ['islamabad','Asia/Karachi'],     ['lahore','Asia/Karachi'],
  ['dhaka','Asia/Dhaka'],         ['colombo','Asia/Colombo'],
  ['bangkok','Asia/Bangkok'],     ['phuket','Asia/Bangkok'],        ['chiang mai','Asia/Bangkok'],
  ['hanoi','Asia/Bangkok'],       ['singapore','Asia/Singapore'],
  ['kuala lumpur','Asia/Kuala_Lumpur'],['jakarta','Asia/Jakarta'],
  ['bali','Asia/Makassar'],       ['denpasar','Asia/Makassar'],     ['manila','Asia/Manila'],
  ['ho chi minh','Asia/Ho_Chi_Minh'],['saigon','Asia/Ho_Chi_Minh'],
  // East Asia
  ['beijing','Asia/Shanghai'],    ['shanghai','Asia/Shanghai'],     ['guangzhou','Asia/Shanghai'],
  ['shenzhen','Asia/Shanghai'],   ['hong kong','Asia/Hong_Kong'],   ['taipei','Asia/Taipei'],
  ['tokyo','Asia/Tokyo'],         ['osaka','Asia/Tokyo'],           ['kyoto','Asia/Tokyo'],
  ['seoul','Asia/Seoul'],         ['busan','Asia/Seoul'],
  // Oceania
  ['sydney','Australia/Sydney'],  ['melbourne','Australia/Melbourne'],['brisbane','Australia/Brisbane'],
  ['perth','Australia/Perth'],    ['adelaide','Australia/Adelaide'],
  ['auckland','Pacific/Auckland'],['wellington','Pacific/Auckland'],['christchurch','Pacific/Auckland'],
];

function cityToTimezone(cityRaw) {
  if (!cityRaw) return null;
  const c = cityRaw.toLowerCase().trim();
  for (const [key, tz] of CITY_TZ_MAP) {
    if (c.includes(key)) return tz;
  }
  return null;
}

// Returns true if booking's local start time has passed, false if future, null if undetermined.
// Also returns ms remaining when not passed.
function isBookingInPast(isoDate, isoTime, tz) {
  try {
    const probe = new Date(`${isoDate}T${isoTime}:00Z`);
    if (isNaN(probe.getTime())) return { past: null, remaining: null };
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = {};
    fmt.formatToParts(probe).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    const h = parts.hour === '24' ? '00' : parts.hour;
    const tzDate = new Date(`${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}:${parts.second}Z`);
    const offsetMs = probe.getTime() - tzDate.getTime();
    const bookingEpoch = probe.getTime() + offsetMs;
    const remaining = bookingEpoch - Date.now();
    return { past: remaining < 0, remaining };
  } catch (_) { return { past: null, remaining: null }; }
}

// ── Time-left countdown interval ──────────────────────────────────────────
let _timeLeftInterval = null;
let _lastBookingParams = null;

function _formatRemaining(ms) {
  if (ms <= 0) return null;
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h ${m}m left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function _updateTimeLeftBadge(isoDate, isoTime, tz, city) {
  const badge = document.getElementById('dt-time-left');
  const warn = document.getElementById('dt-warning');
  if (!badge || !tz) return;

  const { past, remaining } = isBookingInPast(isoDate, isoTime, tz);
  if (past === true) {
    badge.textContent = 'PASSED';
    badge.className = 'dt-time-left danger';
    if (warn) {
      warn.innerHTML =
        `🚫 <strong>Start time already passed!</strong> ` +
        `It is past <strong>${esc(isoTime)}</strong> local time in <strong>${esc(city)}</strong>. Do not fulfill this booking.`;
      warn.classList.add('danger');
      warn.classList.remove('hidden');
    }
  } else if (past === false && remaining != null) {
    const txt = _formatRemaining(remaining);
    badge.textContent = txt || '<1m left';
    // <2h = danger, <6h = warn, else ok
    badge.className = 'dt-time-left ' + (remaining < 7200000 ? 'danger' : remaining < 21600000 ? 'warn' : 'ok');
    if (warn) { warn.classList.add('hidden'); warn.classList.remove('danger'); }
  } else {
    badge.textContent = '';
    badge.className = 'dt-time-left';
  }
}

function updateDatetimeBar(date, time, city) {
  const bar = document.getElementById('datetime-bar');
  if (!bar) return;
  const dateStr = formatDate(date);
  const timeStr = (time && time !== 'N/A') ? time : 'N/A';
  bar.innerHTML =
    `<div class="dt-item"><span class="dt-label">Date</span><span class="dt-value">${esc(dateStr)}</span></div>` +
    `<div class="dt-sep"></div>` +
    `<div class="dt-item"><span class="dt-label">Time</span><span class="dt-value">${esc(timeStr)}</span></div>` +
    `<span id="dt-time-left" class="dt-time-left"></span>`;
  bar.classList.remove('hidden');

  // ── Start-time validator ────────────────────────────────────────────────────
  const warn = document.getElementById('dt-warning');
  if (!date || date === 'N/A' || !time || time === 'N/A') {
    if (warn) { warn.classList.add('hidden'); warn.classList.remove('danger'); }
    if (_timeLeftInterval) { clearInterval(_timeLeftInterval); _timeLeftInterval = null; }
    return;
  }

  // Normalize date → YYYY-MM-DD
  let isoDate = null;
  try {
    let dt = new Date(date + 'T00:00:00Z');
    if (isNaN(dt.getTime())) dt = new Date(date);
    if (!isNaN(dt.getTime())) {
      isoDate = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
    }
  } catch(_) {}
  if (!isoDate) {
    if (warn) { warn.classList.add('hidden'); warn.classList.remove('danger'); }
    if (_timeLeftInterval) { clearInterval(_timeLeftInterval); _timeLeftInterval = null; }
    return;
  }

  // Normalize time → HH:MM 24h
  let isoTime = null;
  const ts = time.trim();
  let tm = ts.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (tm) {
    let h = parseInt(tm[1], 10);
    const mp = (tm[3] || '').toLowerCase();
    if (mp === 'am' && h === 12) h = 0;
    if (mp === 'pm' && h !== 12) h += 12;
    isoTime = String(h).padStart(2, '0') + ':' + tm[2];
  } else {
    tm = ts.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (tm) {
      let h = parseInt(tm[1], 10); const mp = tm[2].toLowerCase();
      if (mp === 'am' && h === 12) h = 0;
      if (mp === 'pm' && h !== 12) h += 12;
      isoTime = String(h).padStart(2, '0') + ':00';
    }
  }
  if (!isoTime) {
    if (warn) { warn.classList.add('hidden'); warn.classList.remove('danger'); }
    if (_timeLeftInterval) { clearInterval(_timeLeftInterval); _timeLeftInterval = null; }
    return;
  }

  const tz = cityToTimezone(city || '');
  if (!tz) {
    // City not in our map — surface an amber prompt to check manually
    const label = city ? `"${esc(city)}"` : 'this booking\'s city';
    if (warn) {
      warn.innerHTML = `⚠️ <strong>Timezone unknown</strong> for city ${label} — verify start time manually.`;
      warn.classList.remove('danger');
      warn.classList.remove('hidden');
    }
    if (_timeLeftInterval) { clearInterval(_timeLeftInterval); _timeLeftInterval = null; }
    return;
  }

  // Initial render + start live interval
  _lastBookingParams = { isoDate, isoTime, tz, city };
  _updateTimeLeftBadge(isoDate, isoTime, tz, city);
  if (_timeLeftInterval) clearInterval(_timeLeftInterval);
  _timeLeftInterval = setInterval(() => {
    if (_lastBookingParams) {
      _updateTimeLeftBadge(_lastBookingParams.isoDate, _lastBookingParams.isoTime, _lastBookingParams.tz, _lastBookingParams.city);
    }
  }, 30000); // refresh every 30s
}

// ── Utilities ─────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d || d === 'N/A') return 'N/A';
  try {
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt)) return d;
    const day = dt.getUTCDate();
    const sfx = [,'st','nd','rd'][day%10] && ![11,12,13].includes(day%100) ? [,'st','nd','rd'][day%10] : 'th';
    return `${day}${sfx} ${dt.toLocaleString('en-US',{month:'long',timeZone:'UTC'})} ${dt.getUTCFullYear()}`;
  } catch (_) { return d; }
}

function fmtGuestType(raw) {
  if (!raw) return 'Guest';
  const m = raw.match(/^(.+?)_Number_(\d+)$/i);
  if (!m) return raw;
  return m[1].replace(/_/g,' ').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()) + ' #' + m[2];
}

function esc(s) {
  return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isUrl(s) {
  if (!s || s === 'N/A' || s === 'null') return false;
  try { return ['http:','https:'].includes(new URL(s).protocol); } catch (_) { return false; }
}
