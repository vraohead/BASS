/**
 * apps-script.gs — BASS v6.5
 * Test:  added editor-run helpers — testFetchBooking() to call a real Booking ID
 *        end-to-end (Zendesk lookup + comments), and checkConfig() to confirm
 *        the required Script Properties are set WITHOUT printing their values.
 *        Run them from the Apps Script editor (where the @headout Google session
 *        and Script Properties are available); the deployed Web App cannot be
 *        called anonymously, so these are the way to test a BID server-side.
 * New:   VERIFY_TICKET action — vision-model ticket checker that compares an
 *        SP-portal screenshot against the fetched booking (date/time/pax/
 *        net price). Requires the OPENAI_API_KEY script property (optional
 *        VISION_MODEL, default gpt-4o). The key never leaves the server.
 * Speed: validate the booking-ID custom field directly from Zendesk search
 *        results instead of re-fetching every matching ticket. The search
 *        response already includes custom_fields/tags/status/updated_at, so
 *        the per-ticket re-fetch loop (N sequential round trips) is removed.
 *        A single fallback fetch is kept only when a result lacks custom_fields.
 * Auth:  Headout domain protection retained (only @headout.com users).
 * Notes: Comment retrieval already uses lazy cursor pagination — it stops after
 *        the first page when Zendesk reports no more pages, so no extra calls.
 */

const BOOKING_FIELD_ID = '360021524471';
const MAX_COMMENT_PAGES = 50;

// ── Ticket-checker (OpenAI) config ─────────────────────────────────────────
// TEMPORARY: paste your OpenAI key between the quotes below to hardcode it.
// Leave it empty ('') to keep using the OPENAI_API_KEY script property instead.
// ⚠ A hardcoded key is readable by anyone with edit access to this script and
// will be committed to source — rotate it and move back to Script Properties
// before sharing this project. Paste the FULL key (sk-... ~100+ chars); a
// truncated/partial key is the usual cause of "HTTP 401 Incorrect API key".
const OPENAI_API_KEY_HARDCODED = '';
const VISION_MODEL_HARDCODED   = 'gpt-4o';

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // ── Pre-auth endpoints (no session yet) ─────────────────────────────────
    // Sign-up / log-in / password-reset are the only actions allowed without a
    // session token — they are how an associate *gets* one (or recovers access).
    // All are rate-limited by email.
    if (payload.action === 'SIGNUP')         return respond(handleSignup(payload));
    if (payload.action === 'LOGIN')          return respond(handleLogin(payload));
    if (payload.action === 'REQUEST_RESET')  return respond(handleRequestReset(payload));
    if (payload.action === 'RESET_PASSWORD') return respond(handleResetPassword(payload));

    // ── Auth gate (fail CLOSED) ─────────────────────────────────────────────
    // The /exec URL is shipped inside the extension, so it can NOT be a secret.
    // Access is therefore gated by *identity*: every other action requires a
    // valid, unexpired BASS session token (issued at login). See
    // authorizeRequest / AUTH_MODE below.
    const auth = authorizeRequest(payload);
    if (!auth.ok) return respond({ success: false, error: auth.error, needLogin: !!auth.needLogin });

    // Per-user rate limiting (runaway-loop / abuse protection).
    if (!withinRateLimit(auth.email, payload.action)) {
      return respond({ success: false, error: 'Too many requests — please wait a moment and try again.' });
    }

    // Audit log (never throws).
    logCall(auth.email, payload.action, payload.bookingId);

    if (payload.action === 'FETCH_BOOKING') {
      return respond(fetchBooking(payload.bookingId));
    }
    if (payload.action === 'VERIFY_TICKET') {
      return respond(verifyTicket(payload));
    }
    return respond({ success: false, error: 'Unknown action' });
  } catch (err) {
    return respond({ success: false, error: String(err) });
  }
}

// ── Authentication & abuse protection ───────────────────────────────────────
// The AUTH_MODE script property selects how callers are authenticated:
//   'token'  (DEFAULT) — require a valid, unexpired BASS session token in the
//                        request body (payload.sessionToken). The token is an
//                        HMAC-signed "email|expiry" string minted at login and
//                        verified statelessly here. A copy of the extension
//                        files is useless without a live login.
//   'open'   — INSECURE legacy: anyone with the URL can call. Migration/local
//                        testing ONLY — never leave this enabled.
function authorizeRequest(payload) {
  var mode = String(PropertiesService.getScriptProperties().getProperty('AUTH_MODE') || 'token').toLowerCase();

  if (mode === 'open') {
    return { ok: true, email: 'anonymous' };
  }

  // Default: BASS session-token mode.
  var v = verifySessionToken_(payload && payload.sessionToken);
  if (!v.ok) return { ok: false, error: 'Your session has expired — please log in to BASS again.', needLogin: true };
  return { ok: true, email: v.email };
}

// ── Custom email + password auth (Google sign-in replaced) ──────────────────
// Associates log in with their @headout.com email and a password they choose at
// first sign-up. Credentials live on the same audit spreadsheet (a "Users" tab);
// passwords are NEVER stored in the clear — only a salted, peppered SHA-256 hash.
// A successful login mints a 24h HMAC-signed session token the extension stores
// and replays on every backend call.

var USERS_SHEET_NAME  = 'Users';
var LOGINS_SHEET_NAME = 'Logins';
var SESSION_TTL_MS    = 24 * 60 * 60 * 1000; // 24h — "log in once per day"
var MIN_PASSWORD_LEN  = 8;
var RESET_TTL_MS      = 15 * 60 * 1000;      // password-reset code is valid 15 min

// Sign-up: create an account + password for a new @headout.com associate, then
// log them straight in (returns a session token).
function handleSignup(payload) {
  var email = normEmail_(payload && payload.email);
  var password = String((payload && payload.password) || '');

  if (!email)                       return { success: false, error: 'Enter your Headout email.' };
  if (!email.endsWith('@headout.com')) return { success: false, error: 'Use your @headout.com email address.' };
  if (password.length < MIN_PASSWORD_LEN) return { success: false, error: 'Password must be at least ' + MIN_PASSWORD_LEN + ' characters.' };
  if (!withinAuthRateLimit_(email)) return { success: false, error: 'Too many attempts — please wait a minute and try again.' };

  var sheet = getUsersSheet_();
  if (findUserRow_(sheet, email).row > 0) {
    return { success: false, error: 'An account already exists for this email — log in instead.' };
  }

  var salt = Utilities.getUuid().replace(/-/g, '');
  var hash = hashPassword_(password, salt);
  sheet.appendRow([email, hash, salt, new Date(), new Date()]);
  logLoginEvent_(email, 'signup');

  var sess = createSessionToken_(email);
  return { success: true, email: email, sessionToken: sess.token, expiresAt: sess.expiresAt };
}

// Log in an existing associate. Verifies the salted+peppered hash; on success
// records the login and mints a fresh 24h session token.
function handleLogin(payload) {
  var email = normEmail_(payload && payload.email);
  var password = String((payload && payload.password) || '');

  if (!email || !password)          return { success: false, error: 'Enter your email and password.' };
  if (!withinAuthRateLimit_(email)) return { success: false, error: 'Too many attempts — please wait a minute and try again.' };

  var sheet = getUsersSheet_();
  var found = findUserRow_(sheet, email);
  if (found.row <= 0) return { success: false, error: 'No account found — sign up to create a password.' };

  var storedHash = String(found.values[1] || '');
  var salt       = String(found.values[2] || '');
  if (hashPassword_(password, salt) !== storedHash) {
    return { success: false, error: 'Incorrect password — try again.' };
  }

  sheet.getRange(found.row, 5).setValue(new Date()); // LastLoginAt
  logLoginEvent_(email, 'login');

  var sess = createSessionToken_(email);
  return { success: true, email: email, sessionToken: sess.token, expiresAt: sess.expiresAt };
}

function normEmail_(raw) { return String(raw || '').trim().toLowerCase(); }

// Step 1 of "forgot password": an associate enters their @headout.com email and
// we email them a short-lived numeric code. We store only a salted, peppered
// HASH of the code (+ an expiry) on the user's row — never the code itself.
// To avoid revealing which emails have accounts, we ALWAYS return success; the
// email is only actually sent when a matching account exists.
function handleRequestReset(payload) {
  var email = normEmail_(payload && payload.email);
  if (!email)                          return { success: false, error: 'Enter your Headout email.' };
  if (!email.endsWith('@headout.com')) return { success: false, error: 'Use your @headout.com email address.' };
  if (!withinAuthRateLimit_(email))    return { success: false, error: 'Too many attempts — please wait a minute and try again.' };

  var sheet = getUsersSheet_();
  var found = findUserRow_(sheet, email);
  if (found.row > 0) {
    var code = generateResetCode_();
    sheet.getRange(found.row, 6).setValue(hashResetCode_(email, code));   // ResetCodeHash
    sheet.getRange(found.row, 7).setValue(Date.now() + RESET_TTL_MS);     // ResetExpiresAt
    // Never surface a send failure to the client: an error here would only ever
    // occur for an existing account, which would leak account existence. Log it
    // server-side and still return success.
    try { sendResetEmail_(email, code); } catch (err) { console.error('sendResetEmail_ failed: ' + err); }
    logLoginEvent_(email, 'reset_request');
  }
  return { success: true };
}

// Step 2 of "forgot password": verify the emailed code, set a brand-new salted
// password hash, clear the reset code, and log the associate straight in
// (returns a fresh session token, exactly like login/sign-up).
function handleResetPassword(payload) {
  var email    = normEmail_(payload && payload.email);
  var code     = String((payload && payload.code) || '').trim();
  var password = String((payload && payload.password) || '');

  if (!email || !code)                    return { success: false, error: 'Enter the code from your email.' };
  if (password.length < MIN_PASSWORD_LEN) return { success: false, error: 'Password must be at least ' + MIN_PASSWORD_LEN + ' characters.' };
  if (!withinAuthRateLimit_(email))       return { success: false, error: 'Too many attempts — please wait a minute and try again.' };

  var sheet = getUsersSheet_();
  var found = findUserRow_(sheet, email);
  // Use one generic message for every "bad code" case so we never reveal whether
  // the email exists, the code expired, or the code was simply wrong.
  var bad = { success: false, error: 'Invalid or expired code — request a new one.' };
  if (found.row <= 0) return bad;

  var storedCodeHash = String(found.values[5] || '');
  var expiresAt      = Number(found.values[6] || 0);
  if (!storedCodeHash || !expiresAt || Date.now() > expiresAt) return bad;
  if (hashResetCode_(email, code) !== storedCodeHash)          return bad;

  var salt = Utilities.getUuid().replace(/-/g, '');
  sheet.getRange(found.row, 2).setValue(hashPassword_(password, salt)); // PasswordHash
  sheet.getRange(found.row, 3).setValue(salt);                          // Salt
  sheet.getRange(found.row, 5).setValue(new Date());                    // LastLoginAt
  sheet.getRange(found.row, 6).setValue('');                            // clear ResetCodeHash
  sheet.getRange(found.row, 7).setValue('');                            // clear ResetExpiresAt
  logLoginEvent_(email, 'reset');

  var sess = createSessionToken_(email);
  return { success: true, email: email, sessionToken: sess.token, expiresAt: sess.expiresAt };
}

// A 6-digit numeric code — easy to read from an email and type into the panel.
// Brute force is blunted by the 15-min expiry and the per-email rate limit.
function generateResetCode_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Hash the reset code bound to the email + the server-only pepper, so a stolen
// spreadsheet (hashes only) can't be turned back into a usable code.
function hashResetCode_(email, code) {
  var pepper = getSessionSecret_();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email + '|' + code + '|' + pepper, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

// Email the reset code. Uses MailApp (sends as the Web App's "Execute as"
// account), which requires the script.send_email OAuth scope — re-authorise +
// redeploy after adding this so the deployed backend can send mail.
function sendResetEmail_(email, code) {
  var subject = 'Your BASS password reset code';
  var body = 'Hi,\n\n'
    + 'Your BASS password reset code is:\n\n'
    + '    ' + code + '\n\n'
    + 'Enter this code in the BASS extension together with your new password. '
    + 'The code expires in 15 minutes.\n\n'
    + 'If you did not request a password reset, you can safely ignore this email.\n\n'
    + '— BASS';
  MailApp.sendEmail(email, subject, body);
}

// Salted + peppered SHA-256. The pepper is a server-only secret (script
// property), so even someone who steals the sheet can't brute-force the hashes
// without also having the Apps Script project's secret.
function hashPassword_(password, salt) {
  var pepper = getSessionSecret_();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password + '|' + pepper, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

// HMAC-signed, stateless 24h session token: base64web("email|expiryMs") + "." +
// hex(HMAC_SHA256(secret, payload)). No server-side session store needed.
function createSessionToken_(email) {
  var expiresAt = Date.now() + SESSION_TTL_MS;
  var body = email + '|' + expiresAt;
  var b64  = Utilities.base64EncodeWebSafe(Utilities.newBlob(body).getBytes());
  var sig  = signToken_(b64);
  return { token: b64 + '.' + sig, expiresAt: expiresAt };
}

function verifySessionToken_(token) {
  try {
    if (!token) return { ok: false };
    var parts = String(token).split('.');
    if (parts.length !== 2) return { ok: false };
    if (signToken_(parts[0]) !== parts[1]) return { ok: false }; // tampered / wrong secret
    var body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    var i = body.lastIndexOf('|');
    if (i < 0) return { ok: false };
    var email = body.substring(0, i);
    var expiresAt = Number(body.substring(i + 1));
    if (!email || !expiresAt || Date.now() > expiresAt) return { ok: false };
    return { ok: true, email: email };
  } catch (err) {
    return { ok: false };
  }
}

function signToken_(b64) {
  var raw = Utilities.computeHmacSha256Signature(b64, getSessionSecret_());
  return bytesToHex_(raw);
}

// One server-side secret used as both the password pepper and the session-token
// signing key. Auto-generated and stored on first use, so no manual setup.
function getSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', s);
  }
  return s;
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// The Users tab (Email | PasswordHash | Salt | CreatedAt | LastLoginAt) on the
// same audit spreadsheet, created with a header row on first use.
function getUsersSheet_() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID') || DEFAULT_LOG_SHEET_ID;
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
    sheet.appendRow(['Email', 'PasswordHash', 'Salt', 'CreatedAt', 'LastLoginAt', 'ResetCodeHash', 'ResetExpiresAt']);
    return sheet;
  }
  // Migrate older 5-column sheets in place: make sure the password-reset columns
  // exist in the header so getRange(...,6/7) lines up with the right fields.
  var header = sheet.getRange(1, 1, 1, 7).getValues()[0];
  if (!header[5]) sheet.getRange(1, 6).setValue('ResetCodeHash');
  if (!header[6]) sheet.getRange(1, 7).setValue('ResetExpiresAt');
  return sheet;
}

// Locate an existing user row (1-based) by email. Returns {row, values} or row 0.
function findUserRow_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return { row: 0, values: null };
  var rows = sheet.getRange(2, 1, last - 1, 7).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i][0]) === email) return { row: i + 2, values: rows[i] };
  }
  return { row: 0, values: null };
}

// Track every sign-up / log-in on a "Logins" tab (Timestamp | Email | Event).
function logLoginEvent_(email, event) {
  try {
    var sheetId = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID') || DEFAULT_LOG_SHEET_ID;
    if (!sheetId) return;
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName(LOGINS_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(LOGINS_SHEET_NAME);
      sheet.appendRow(['Timestamp', 'Email', 'Event']);
    }
    sheet.appendRow([new Date(), email, event || '']);
  } catch (err) { /* best-effort */ }
}

// Throttle login/sign-up attempts (per email) to blunt password guessing.
function withinAuthRateLimit_(email) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'auth_rl:' + email;
    var current = Number(cache.get(key) || '0');
    if (current >= 10) return false; // 10 attempts / minute / email
    cache.put(key, String(current + 1), 60);
    return true;
  } catch (err) {
    return true;
  }
}

// Lightweight per-user, per-action rate limit using the script cache (rolling
// ~60s window). Not perfectly atomic under heavy concurrency, but enough to
// stop runaway loops and casual abuse.
function withinRateLimit(email, action) {
  try {
    var cache = CacheService.getScriptCache();
    var windowSec = 60;
    var max = action === 'VERIFY_TICKET' ? 20 : 60;
    var key = 'rl:' + action + ':' + email;
    var current = Number(cache.get(key) || '0');
    if (current >= max) return false;
    cache.put(key, String(current + 1), windowSec);
    return true;
  } catch (err) {
    // If the cache is unavailable, don't block legitimate work.
    return true;
  }
}

// Default audit-log spreadsheet. The LOG_SHEET_ID script property overrides this
// if set; otherwise logs go to this sheet. Set to '' to disable the default.
var DEFAULT_LOG_SHEET_ID = '1Z-OEmDbhaGE6bTt1Qd3VN6MVmb6dKrxp9-YIS1LQR6k';

// Audit log: always to Cloud Logging (console), plus the audit spreadsheet
// (LOG_SHEET_ID property, else DEFAULT_LOG_SHEET_ID). Never throws — logging
// must not break a request.
function logCall(email, action, bookingId) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), email: email, action: action || '', bookingId: bookingId || ''
    }));
    var sheetId = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID') || DEFAULT_LOG_SHEET_ID;
    if (sheetId) {
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(['Timestamp', 'Email', 'Action', 'Booking ID']);
      }
      sheet.appendRow([new Date(), email, action || '', bookingId || '']);
    }
  } catch (err) { /* swallow — logging is best-effort */ }
}

function fetchBooking(bookingId) {
  if (!bookingId) return { success: false, error: 'Booking ID required' };

  const props     = PropertiesService.getScriptProperties();
  const subdomain = props.getProperty('ZENDESK_SUBDOMAIN');
  const email     = props.getProperty('ZENDESK_EMAIL');
  const token     = props.getProperty('ZENDESK_API_TOKEN');

  if (!subdomain || !email || !token) {
    return { success: false, error: 'Zendesk credentials not configured' };
  }

  const auth = 'Basic ' + Utilities.base64Encode(email + '/token:' + token);
  const base = 'https://' + subdomain + '.zendesk.com/api/v2';

  const ticket = findTicket(base, auth, bookingId);
  if (!ticket) return { success: false, error: 'No matching booking ticket found' };

  const comments = fetchAllComments(base, auth, ticket.id);

  const normalisedComments = comments.map(function(c) {
    return {
      id:         c.id          || null,
      created_at: c.created_at  || null,
      public:     typeof c.public === 'boolean' ? c.public : null,
      author_id:  c.author_id   || null,
      body:       c.body        || '',
      plain_body: c.plain_body  || '',
      html_body:  c.html_body   || '',
    };
  });

  // Build joined htmlBody for the parser (extension expects this)
  var htmlBodies = normalisedComments
    .map(function(c) { return c.html_body || ''; })
    .filter(function(h) { return h.length > 0; });

  return {
    success:    true,
    booking_id: String(bookingId),
    ticket_id:  ticket.id,
    subject:    ticket.subject || '',
    htmlBody:   htmlBodies.join('<hr/>'),
    ticket: {
      id:            ticket.id,
      status:        ticket.status       || '',
      created_at:    ticket.created_at   || null,
      updated_at:    ticket.updated_at   || null,
      tags:          ticket.tags         || [],
      custom_fields: ticket.custom_fields|| [],
    },
    comments: normalisedComments,
  };
}

// ── Ticket lookup ────────────────────────────────────────────────────────
// Zendesk search returns full ticket objects (incl. custom_fields, tags,
// status, updated_at, subject). We validate the booking-ID custom field
// straight from those results — no per-ticket re-fetch. The earlier code
// fetched /tickets/{id}.json for every match, adding N sequential round
// trips to confirm a field the search response already contained.

function findTicket(base, auth, bookingId) {
  const query = 'type:ticket tags:bkngs custom_field_' + BOOKING_FIELD_ID + ':"' + bookingId + '"';
  const url   = base + '/search.json?query=' + encodeURIComponent(query);

  const resp = zFetch(url, auth);
  if (!resp.ok) throw new Error('Zendesk search failed: HTTP ' + resp.status);

  const results = (resp.json.results || []).filter(function(t) {
    return Array.isArray(t.tags) && t.tags.indexOf('bkngs') !== -1;
  });

  if (!results.length) return null;

  function hasBookingField(t) {
    return (t.custom_fields || []).some(function(f) {
      return String(f.id) === String(BOOKING_FIELD_ID);
    });
  }

  function matchesBooking(t) {
    return (t.custom_fields || []).some(function(f) {
      return String(f.id) === String(BOOKING_FIELD_ID) && String(f.value) === String(bookingId);
    });
  }

  var validated = [];
  results.forEach(function(r) {
    // Fast path: the booking-ID field is present on the search result — validate inline.
    if (hasBookingField(r)) {
      if (matchesBooking(r)) validated.push(r);
      return;
    }
    // Fallback (rare): search result omitted the booking-ID field (trimmed
    // result) — fetch the full ticket once to confirm before excluding it.
    var ticketResp = zFetch(base + '/tickets/' + r.id + '.json', auth);
    if (!ticketResp.ok || !ticketResp.json.ticket) return;
    if (matchesBooking(ticketResp.json.ticket)) validated.push(ticketResp.json.ticket);
  });

  if (!validated.length) return null;

  // Most recently updated valid ticket wins.
  validated.sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
  return validated[0];
}

// ── Comments fetch — cursor pagination ───────────────────────────────────
// Uses ?page[size]=100 cursor-based pagination (Zendesk v2 supported path).
// Lazy: stops after the first page unless Zendesk signals more pages, so a
// ticket with <=100 comments costs exactly one request.

function fetchAllComments(base, auth, ticketId) {
  var all   = [];
  var pages = 0;

  // First page — request maximum page size to minimise round-trips
  var url = base + '/tickets/' + ticketId + '/comments.json?page[size]=100&sort=created_at';

  while (url && pages < MAX_COMMENT_PAGES) {
    var resp = zFetch(url, auth);
    if (!resp.ok || !resp.json) break;

    var batch = resp.json.comments || [];
    if (batch.length) all = all.concat(batch);

    // Follow cursor only if Zendesk signals there are more pages
    var meta  = resp.json.meta   || {};
    var links = resp.json.links  || {};

    if (meta.has_more && links.next) {
      url = links.next;   // absolute URL — use directly
    } else {
      break;
    }
    pages++;
  }

  // Chronological order — oldest first (sort=created_at should handle it,
  // but sort client-side as a safety net in case of out-of-order pages)
  all.sort(function(a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  return all;
}

function zFetch(url, auth) {
  var raw = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: auth },
    muteHttpExceptions: true,
  });
  var status = raw.getResponseCode();
  var json   = null;
  try { json = JSON.parse(raw.getContentText()); } catch (_) {}
  return { ok: status >= 200 && status < 300, status: status, json: json };
}

// ══════════════════════════════════════════════════════════════════════════
// TICKET VERIFICATION (AI accuracy gate)
//
// The extension sends a screenshot of the supplier (SP) portal checkout/
// selection page plus the already-fetched booking fields. A vision model
// extracts the visible date / time / pax / net price; this server then compares
// them against the expected values with format-normalisation and returns a
// per-field PASS / FAIL / SKIPPED / PARTIAL result. The model key lives only
// in script properties — never in the extension client.
// ══════════════════════════════════════════════════════════════════════════

function verifyTicket(payload) {
  const image    = payload && payload.image;
  const expected = (payload && payload.expected) || {};

  if (!image || String(image).indexOf('data:image') !== 0) {
    return { success: false, error: 'No screenshot received. Please attach an image of the SP portal page.' };
  }

  const props = PropertiesService.getScriptProperties();
  // Prefer the hardcoded key when present; otherwise fall back to Script Properties.
  const apiKey = (OPENAI_API_KEY_HARDCODED && OPENAI_API_KEY_HARDCODED.trim())
    || props.getProperty('OPENAI_API_KEY');
  const model  = (VISION_MODEL_HARDCODED && VISION_MODEL_HARDCODED.trim())
    || props.getProperty('VISION_MODEL') || 'gpt-4o';
  if (!apiKey) {
    return {
      success: false,
      error: 'Ticket checker not configured: paste your key into OPENAI_API_KEY_HARDCODED at the top of the Apps Script, or set the OPENAI_API_KEY script property.'
    };
  }

  let vision;
  try {
    vision = callVisionModel(apiKey, model, image, expected);
  } catch (err) {
    return { success: false, error: 'Vision model error: ' + String(err) };
  }
  if (!vision) {
    return { success: false, error: 'Vision model returned no result. Please retry.' };
  }

  return { success: true, verification: buildVerification(expected, vision) };
}

function callVisionModel(apiKey, model, image, expected) {
  const openDated = !!expected.openDated;
  const schema =
    '{"readable":bool,"relevant":bool,"screenshot_type":"checkout|selection|confirmation|other",' +
    '"fields":{"date":{"detected":string,"matches":bool,"reason":string},' +
    '"time":{"detected":string,"matches":bool,"reason":string},' +
    '"pax":{"detected":string,"matches":bool,"reason":string},' +
    '"netPrice":{"detected":string,"matches":bool,"reason":string}},"overall_notes":string}';

  const sys =
    'You are a meticulous booking-verification assistant for a tours & activities ' +
    'operations team. You are shown a screenshot from a supplier (SP) portal ' +
    'checkout or ticket-selection page, plus the EXPECTED booking details from our ' +
    'system. Read the booking details visible in the screenshot and compare them to ' +
    'the expected values. Normalise formatting differences before deciding a match: ' +
    'dates (e.g. "18 Jun 2026" == "2026-06-18" == "18/06/2026"), times ("10:00" == ' +
    '"10:00 AM"), pax wording ("2 Adults" == "2 adult"), and prices (ignore currency ' +
    'symbols and thousands separators, so "$1,234.50" == "1234.5"). Only report what is ' +
    'actually visible; if a field is not visible, set its detected to "" and matches ' +
    'to false. Set readable=false if the image is blank/too blurry to read, and ' +
    'relevant=false if it is clearly not an SP checkout/selection/confirmation page. ' +
    (openDated ? 'This booking is OPEN-DATED: ignore the date and set date.matches=true with reason "open-dated". ' : '') +
    'Respond with STRICT minified JSON only (no markdown, no code fences) matching: ' + schema;

  const userText =
    'EXPECTED booking details:\n' +
    '- netPrice (the net/supplier price we expect to pay, shown on the SP checkout): ' + (expected.netPrice || '(unknown)') + '\n' +
    '- date: '    + (expected.openDated ? '(open-dated — skip)' : (expected.date || '(unknown)')) + '\n' +
    '- time: '    + (expected.time || '(unknown)') + '\n' +
    '- pax: '     + (expected.pax  || '(unknown)') + '\n' +
    '- city: '    + (expected.city || '(unknown)') + '\n\n' +
    'Extract the matching fields from the screenshot and return the JSON described.';

  const body = {
    model: model,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: image, detail: 'high' } }
      ] }
    ]
  };

  const resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ' ' + text.slice(0, 200));
  }

  let outer;
  try { outer = JSON.parse(text); } catch (_) { throw new Error('Unparseable model response'); }
  const content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
  if (!content) throw new Error('Empty model response');

  let cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch (_) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_2) {} }
    throw new Error('Model did not return valid JSON');
  }
}

function buildVerification(expected, vision) {
  const readable = vision.readable !== false;
  const relevant = vision.relevant !== false;
  const vf = vision.fields || {};

  if (!readable || !relevant) {
    const reason = !readable
      ? 'The screenshot could not be read. Re-capture a clear, full screenshot of the SP page and re-upload.'
      : 'This does not look like an SP checkout/selection page. Capture the SP portal screen showing date, time, pax and net price, then re-upload.';
    return {
      overall: 'FAIL', readable: readable, relevant: relevant, caveats: [],
      message: !readable ? 'Screenshot unreadable.' : 'Screenshot not recognised as an SP portal page.',
      fields: ['date', 'time', 'pax', 'netPrice'].map(function (k) {
        return { key: k, label: fieldLabel(k), status: 'unknown',
                 expected: expectedVal(expected, k), detected: (vf[k] && vf[k].detected) || '', reason: reason };
      })
    };
  }

  const caveats = [];
  const fields  = [];

  // ── Date ──
  (function () {
    const det = (vf.date && vf.date.detected) || '';
    const exp = expected.date || '';
    if (expected.openDated) {
      fields.push(mkField('date', exp || 'Open-dated', det, 'skipped', 'Open-dated booking — date check skipped.'));
      caveats.push('Date check skipped (open-dated booking) — confirm the date manually if the SP page shows one.');
      return;
    }
    let status, reason;
    const cmp = compareDates(exp, det);
    if (!det) { status = 'fail'; reason = 'No date found in the screenshot.'; }
    else if (cmp === true)  { status = 'pass'; reason = 'Date matches.'; }
    else if (cmp === false) { status = 'fail'; reason = 'Date on the SP page does not match the booking date.'; }
    else { status = (vf.date && vf.date.matches) ? 'pass' : 'fail'; reason = (vf.date && vf.date.reason) || 'Compared by AI.'; }
    fields.push(mkField('date', exp, det, status, reason));
  })();

  // ── Time ──
  (function () {
    const det = (vf.time && vf.time.detected) || '';
    const exp = expected.time || '';
    let status, reason;
    const cmp = compareTimes(exp, det);
    if (!det) { status = 'fail'; reason = 'No start time found in the screenshot.'; }
    else if (cmp === true)  { status = 'pass'; reason = 'Start time matches.'; }
    else if (cmp === false) { status = 'fail'; reason = 'Start time on the SP page does not match the booking.'; }
    else { status = (vf.time && vf.time.matches) ? 'pass' : 'fail'; reason = (vf.time && vf.time.reason) || 'Compared by AI.'; }
    fields.push(mkField('time', exp, det, status, reason));
  })();

  // ── Pax ──
  (function () {
    const det = (vf.pax && vf.pax.detected) || '';
    const exp = expected.pax || '';
    let status, reason;
    const e = paxCounts(exp), d = paxCounts(det);
    if (!det) { status = 'fail'; reason = 'No guest/pax count found in the screenshot.'; }
    else if (e && d) {
      if (e.total === d.total) { status = 'pass'; reason = 'Guest count matches.'; }
      else if (e.child > 0 && d.total === (e.total - e.child) && d.child === 0) {
        status = 'partial';
        reason = 'Adult count matches but child pax (' + e.child + ') is not visible on the SP page — verify manually.';
        caveats.push('Child pax may be missing on the SP selection — confirm ' + e.child + ' child ticket(s) were added.');
      } else { status = 'fail'; reason = 'Guest count (' + d.total + ') does not match the booking (' + e.total + ').'; }
    } else { status = (vf.pax && vf.pax.matches) ? 'pass' : 'fail'; reason = (vf.pax && vf.pax.reason) || 'Compared by AI.'; }
    fields.push(mkField('pax', exp, det, status, reason));
  })();

  // ── Net Price (numeric compare, with model judgment as backstop) ──
  (function () {
    const det = (vf.netPrice && vf.netPrice.detected) || '';
    const exp = expected.netPrice || '';
    let status, reason;
    if (!exp) {
      status = 'skipped';
      reason = 'No net price on the booking — price check skipped.';
      caveats.push('Net price missing on the booking — verify the SP price manually.');
    } else if (!det) {
      status = 'fail'; reason = 'No price found in the screenshot.';
    } else {
      const cmp = comparePrices(exp, det);
      if (cmp === true)  { status = 'pass'; reason = 'Net price matches.'; }
      else if (cmp === false) { status = 'fail'; reason = 'Price on the SP page does not match the booking net price.'; }
      else { status = (vf.netPrice && vf.netPrice.matches) ? 'pass' : 'fail'; reason = (vf.netPrice && vf.netPrice.reason) || 'Compared by AI.'; }
    }
    fields.push(mkField('netPrice', exp, det, status, reason));
  })();

  const failed = fields.filter(function (f) { return f.status === 'fail'; });
  const overall = failed.length ? 'FAIL' : 'PASS';
  const message = overall === 'PASS'
    ? (caveats.length ? 'All checks passed (with caveats).' : 'All checks passed.')
    : 'Mismatch found in: ' + failed.map(function (f) { return f.label; }).join(', ') + '.';

  return { overall: overall, readable: true, relevant: true, caveats: caveats, message: message, fields: fields };
}

function mkField(key, expected, detected, status, reason) {
  return { key: key, label: fieldLabel(key), expected: expected || '', detected: detected || '', status: status, reason: reason || '' };
}
function fieldLabel(k) {
  return k === 'date' ? 'Date' : k === 'time' ? 'Start Time' : k === 'pax' ? 'Guests / Pax' : k === 'netPrice' ? 'Net Price' : k;
}
function expectedVal(expected, k) {
  return k === 'date' ? (expected.date || '') : k === 'time' ? (expected.time || '') : k === 'pax' ? (expected.pax || '') : (expected.netPrice || '');
}

// Compare two price strings numerically. Returns true (equal within a cent),
// false (clear mismatch), or null (either side unparsable — caller falls back to
// the model's judgment). Currency symbols and thousands separators are ignored.
function comparePrices(exp, det) {
  const pe = priceNum(exp), pd = priceNum(det);
  if (pe === null || pd === null) return null;
  return Math.abs(pe - pd) <= 0.01;
}
function priceNum(s) {
  if (s === null || s === undefined) return null;
  const cleaned = String(s).replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const commas = (cleaned.match(/,/g) || []).length;
  const dots   = (cleaned.match(/\./g) || []).length;
  let n;
  if (commas && dots) {
    // Both present: the last-occurring separator is the decimal point,
    // the other is a thousands separator.
    const dec = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'));
    const intPart  = cleaned.slice(0, dec).replace(/[.,]/g, '');
    const fracPart = cleaned.slice(dec + 1).replace(/[.,]/g, '');
    n = parseFloat((intPart || '0') + '.' + fracPart);
  } else if (commas || dots) {
    const sep = commas ? ',' : '.';
    const count = commas || dots;
    const last = cleaned.lastIndexOf(sep);
    const frac = cleaned.slice(last + 1);
    // A single separator followed by exactly 3 digits (e.g. "1,234" / "1.234")
    // is treated as a thousands separator; multiple occurrences are always
    // thousands separators. Otherwise it's a decimal point.
    if (count > 1 || frac.length === 3) {
      n = parseFloat(cleaned.replace(/[.,]/g, ''));
    } else {
      n = parseFloat(cleaned.replace(sep, '.'));
    }
  } else {
    n = parseFloat(cleaned);
  }
  return isNaN(n) ? null : n;
}

// ── Normalisation helpers ────────────────────────────────────────────────
function norm4(y) { return y < 100 ? 2000 + y : y; }

function dateParse(s) {
  if (!s) return { cands: [], ambiguous: false, raw: null };
  s = String(s).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const M = { january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,
              july:7,jul:7,august:8,aug:8,september:9,sept:9,sep:9,october:10,oct:10,november:11,nov:11,december:12,dec:12 };
  const names = Object.keys(M).sort(function (a, b) { return b.length - a.length; }).join('|');
  let m;
  if ((m = s.match(/(\d{4})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})/))) {
    return { cands: [{ y:+m[1], m:+m[2], d:+m[3] }], ambiguous: false, raw: null };
  }
  if ((m = s.match(new RegExp('\\b(\\d{1,2})\\s+(' + names + ')\\b(?:\\s*,?\\s*(\\d{2,4}))?')))) {
    return { cands: [{ y: m[3] ? norm4(+m[3]) : null, m: M[m[2]], d: +m[1] }], ambiguous: false, raw: null };
  }
  if ((m = s.match(new RegExp('\\b(' + names + ')\\s+(\\d{1,2})\\b(?:\\s*,?\\s*(\\d{2,4}))?')))) {
    return { cands: [{ y: m[3] ? norm4(+m[3]) : null, m: M[m[1]], d: +m[2] }], ambiguous: false, raw: null };
  }
  if ((m = s.match(/\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})\b/))) {
    const a = +m[1], b = +m[2], y = norm4(+m[3]);
    const cands = [];
    const dm = (a <= 31 && b <= 12) ? { y: y, m: b, d: a } : null; // d/m/y
    const md = (b <= 31 && a <= 12) ? { y: y, m: a, d: b } : null; // m/d/y
    if (dm) cands.push(dm);
    if (md && !(dm && md.m === dm.m && md.d === dm.d)) cands.push(md);
    return { cands: cands, ambiguous: cands.length > 1, raw: { a: a, b: b, y: y } };
  }
  return { cands: [], ambiguous: false, raw: null };
}
// Returns true (match), false (clear mismatch) or null (cannot decide — caller
// falls back to the model's judgment). Two ambiguous slash dates (both parts
// <=12) are only matched when their raw digits are identical, so a swapped
// dd/mm vs mm/dd pair never produces a false PASS.
function compareDates(exp, det) {
  const A = dateParse(exp), B = dateParse(det);
  if (!A.cands.length || !B.cands.length) return null;
  if (A.ambiguous && B.ambiguous) {
    if (A.raw && B.raw && A.raw.a === B.raw.a && A.raw.b === B.raw.b && A.raw.y === B.raw.y) return true;
    return null;
  }
  for (let i = 0; i < A.cands.length; i++) for (let j = 0; j < B.cands.length; j++) {
    const x = A.cands[i], y = B.cands[j];
    if (x.m === y.m && x.d === y.d && (x.y == null || y.y == null || x.y === y.y)) return true;
  }
  return false;
}

function timeMinutes(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  let m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (m) { let h = +m[1]; const mn = +m[2], ap = m[3]; if (ap === 'am' && h === 12) h = 0; if (ap === 'pm' && h !== 12) h += 12; return h * 60 + mn; }
  m = s.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m) { let h = +m[1]; const ap = m[2]; if (ap === 'am' && h === 12) h = 0; if (ap === 'pm' && h !== 12) h += 12; return h * 60; }
  return null;
}
function compareTimes(exp, det) { const a = timeMinutes(exp), b = timeMinutes(det); if (a == null || b == null) return null; return a === b; }

function paxCounts(s) {
  if (!s) return null;
  s = String(s).toLowerCase();
  const re = /(\d+)\s*(adults?|children|child|kids?|infants?|toddlers?|seniors?|youths?|students?|guests?|persons?|people|pax|travell?ers?|tickets?)/g;
  let total = 0, child = 0, matched = false, m;
  while ((m = re.exec(s))) { matched = true; const n = parseInt(m[1], 10); total += n; if (/child|children|kid|infant|toddler/.test(m[2])) child += n; }
  if (matched) return { total: total, child: child };
  const b = s.match(/\b(\d+)\b/);
  if (b) return { total: parseInt(b[1], 10), child: 0 };
  return null;
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════════════════
// MANUAL TEST HELPERS — run these from the Apps Script editor
//
// The deployed Web App requires a signed-in @headout Google session, so it
// cannot be called anonymously (e.g. from an external server). To test a real
// Booking ID, run these functions IN the editor: pick the function in the
// toolbar, click Run, then open Executions / View ▸ Logs to read the output.
// ══════════════════════════════════════════════════════════════════════════

// 1) Put a REAL Booking ID below, select testFetchBooking in the toolbar, Run.
//    Logs the same JSON the extension receives from FETCH_BOOKING.
function testFetchBooking() {
  var BOOKING_ID = 'PUT_A_REAL_BOOKING_ID_HERE';

  if (BOOKING_ID === 'PUT_A_REAL_BOOKING_ID_HERE') {
    Logger.log('Edit testFetchBooking() and set BOOKING_ID to a real Booking ID first.');
    return;
  }

  var result = fetchBooking(BOOKING_ID);
  Logger.log('success      : ' + result.success);
  if (!result.success) { Logger.log('error        : ' + result.error); return; }
  Logger.log('ticket_id    : ' + result.ticket_id);
  Logger.log('subject      : ' + result.subject);
  Logger.log('status       : ' + (result.ticket && result.ticket.status));
  Logger.log('comments     : ' + (result.comments ? result.comments.length : 0));
  Logger.log('htmlBody len : ' + (result.htmlBody ? result.htmlBody.length : 0));
  Logger.log('--- full JSON below ---');
  Logger.log(JSON.stringify(result, null, 2));
}

// 2) Confirms the required Script Properties exist WITHOUT printing their
//    values (only present/absent and length), so you can verify setup safely.
function checkConfig() {
  var props = PropertiesService.getScriptProperties();
  ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN', 'OPENAI_API_KEY', 'VISION_MODEL']
    .forEach(function (key) {
      var v = props.getProperty(key);
      Logger.log(key + ' : ' + (v ? 'set (length ' + v.length + ')' : 'NOT set'));
    });
  try {
    var email = Session.getActiveUser().getEmail();
    Logger.log('signed-in user : ' + (email || '(none / anonymous)'));
  } catch (e) {
    Logger.log('signed-in user : (unavailable) ' + e);
  }
}
