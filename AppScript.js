/**
 * apps-script.gs — BASS v6.1
 * Fix: use next_page cursor pagination instead of ?page=N integer paging.
 * Zendesk deprecated integer paging; cursor pagination is the supported path.
 */

const BOOKING_FIELD_ID = '360021524471';
const MAX_COMMENT_PAGES = 50;

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (payload.action === 'FETCH_BOOKING') {
      return respond(fetchBooking(payload.bookingId));
    }
    return respond({ success: false, error: 'Unknown action' });
  } catch (err) {
    return respond({ success: false, error: String(err) });
  }
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

function findTicket(base, auth, bookingId) {
  const query = 'type:ticket tags:bkngs custom_field_' + BOOKING_FIELD_ID + ':"' + bookingId + '"';
  const url   = base + '/search.json?query=' + encodeURIComponent(query);

  const resp = zFetch(url, auth);
  if (!resp.ok) throw new Error('Zendesk search failed: HTTP ' + resp.status);

  const results = (resp.json.results || []).filter(function(t) {
    return Array.isArray(t.tags) && t.tags.indexOf('bkngs') !== -1;
  });

  if (!results.length) return null;

  var validated = [];
  results.forEach(function(r) {
    var ticketResp = zFetch(base + '/tickets/' + r.id + '.json', auth);
    if (!ticketResp.ok || !ticketResp.json.ticket) return;
    var t = ticketResp.json.ticket;
    var match = (t.custom_fields || []).some(function(f) {
      return String(f.id) === String(BOOKING_FIELD_ID) && String(f.value) === String(bookingId);
    });
    if (match) validated.push(t);
  });

  if (!validated.length) return null;

  validated.sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
  return validated[0];
}

// ── Comments fetch — cursor pagination ───────────────────────────────────
// Uses ?page[size]=100 cursor-based pagination (Zendesk v2 supported path).
// Falls back gracefully: if after_cursor is absent, treats the page as final.

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

    // Follow cursor if Zendesk signals there are more pages
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

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}