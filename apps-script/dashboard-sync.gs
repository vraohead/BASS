/**
 * dashboard-sync.gs — mirrors the BASS Verify Pulse dashboard into a Google Sheet.
 *
 * The Cloudflare Worker's /admin/usage-report-range and /admin/channel-report
 * endpoints already return everything the dashboard renders (summarizeEvents()'s
 * output, plus a `bookings` list) — this script just accepts THAT SAME JSON body
 * verbatim and lays it out across tabs, so no field mapping/renaming has to be
 * kept in sync by hand on either side. Whoever wires up the push just needs to
 * POST the worker's own response body here, with a `secret` field added.
 *
 * Deploy: Extensions > Apps Script (from the target Sheet) > paste this file >
 * set SHARED_SECRET below > Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone) > copy the /exec URL.
 * IMPORTANT: to keep the same URL after editing this script later, use
 * Deploy > Manage deployments > Edit > New version — a brand-new deployment
 * gets a brand-new URL.
 */

// Anyone with the deployed URL can POST to it — this is the only thing standing
// between "our Worker" and "literally anyone on the internet" writing to the
// sheet, so it MUST be changed from the placeholder below before deploying.
const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SHARED_SECRET || body.secret !== SHARED_SECRET) {
      return respond({ ok: false, error: 'Bad or missing secret' });
    }
    syncSnapshot(body);
    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// One call, one snapshot, one full refresh of every tab — these are all
// point-in-time aggregates recomputed from scratch by summarizeEvents() on
// the worker side, not incremental deltas, so overwriting (not appending) is
// what keeps the sheet honest: a booking that's no longer flagged should stop
// showing up here too, the same way it would disappear from the dashboard.
function syncSnapshot(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  writeSummary(ss, d);
  writeBookings(ss, d.bookings || []);
  writePairCounts(ss, 'Per Person', ['Agent Email', 'Unique Bookings'], d.perPersonUniqueBookings || []);
  writePairCounts(ss, 'Top Vendors', ['Vendor', 'Unique Bookings'], d.perVendorUniqueBookings || []);
  writePairCounts(ss, 'Mismatched Fields', ['Field', 'Times Mismatched'], d.fieldMismatchCounts || []);
  writeProducts(ss, d.perProductUniqueBookings || []);
  appendSyncLog(ss, d);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function writeSummary(ss, d) {
  const sheet = getOrCreateSheet_(ss, 'Summary');
  sheet.clear();
  const rows = [
    ['Last synced', new Date()],
    ['Source', d.source || ''],
    ['Range start', d.start || ''],
    ['Range end', d.end || ''],
    ['Filter', d.filter || ''],
    [],
    ['Unique bookings verified', d.uniqueBookingCount || 0],
    ['Bookings fetched (not necessarily verified)', d.fetchedBookingCount || 0],
    ['Checkout page (good)', d.checkoutBookingCount || 0],
    ['Ticket shown instead (incorrect flag)', d.ticketBookingCount || 0],
    ['Other / unclear page', d.otherPageBookingCount || 0],
    [],
    ['Pre-Override Flags (mismatch caught at detection)', d.preOverrideFlagCount || 0],
    ['Override Confirmed (resolved and confirmed)', d.overrideConfirmedCount || 0],
    [],
    ['Full match checks', d.fullMatchChecks || 0],
    ['Partial match checks', d.partialMatchChecks || 0],
    ['Checks with field data', d.checksWithData || 0],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  sheet.autoResizeColumns(1, 2);
}

// Same columns the dashboard's "Flagged Booking IDs" table shows, in the same
// order — anyone who's used the dashboard should recognise this immediately.
// Slack Link is only ever populated for channel-sourced rows (an actual Slack
// message exists to link to); dashboard/KV-sourced rows get a plain "—",
// same as Tour ID / Vendor ID, which the KV log doesn't carry today.
function writeBookings(ss, bookings) {
  const sheet = getOrCreateSheet_(ss, 'Bookings');
  sheet.clear();
  const header = ['Booking ID', 'Stage', 'Agent Email', 'At', 'Vendor', 'Product', 'Tour ID', 'Vendor ID', 'Page Type', 'Mismatched Fields', 'Retroactive', 'Slack Link'];
  const rows = bookings.map(b => [
    b.bookingId || '',
    b.stage || '',
    b.agentEmail || '',
    b.at || '',
    b.vendor || '',
    b.product || '',
    b.tourId || '—',
    b.vendorId || '—',
    b.pageType || '',
    (b.mismatchedFields || []).join(', '),
    b.retroactive ? 'Yes' : '',
    b.slackLink ? '=HYPERLINK("' + b.slackLink + '","Open in Slack")' : '—',
  ]);
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.autoResizeColumns(1, header.length);
}

// Every other tab is a full-refresh snapshot (see syncSnapshot's comment) —
// this one is deliberately the opposite: an append-only history of every
// sync, so you can see the headline numbers trend over time instead of only
// ever seeing "right now". Kept lean (just the top-line counts) since it
// grows forever; the full detail for "right now" is always the other tabs.
function appendSyncLog(ss, d) {
  const sheet = getOrCreateSheet_(ss, 'Sync Log');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Synced At', 'Source', 'Range Start', 'Range End', 'Filter',
      'Unique Bookings', 'Fetched', 'Checkout', 'Ticket (bad)', 'Other (bad)',
      'Pre-Override Flags', 'Override Confirmed', 'Full Match', 'Partial Match',
    ]);
    sheet.getRange(1, 1, 1, 14).setFontWeight('bold');
  }
  sheet.appendRow([
    new Date(), d.source || '', d.start || '', d.end || '', d.filter || '',
    d.uniqueBookingCount || 0, d.fetchedBookingCount || 0, d.checkoutBookingCount || 0,
    d.ticketBookingCount || 0, d.otherPageBookingCount || 0,
    d.preOverrideFlagCount || 0, d.overrideConfirmedCount || 0,
    d.fullMatchChecks || 0, d.partialMatchChecks || 0,
  ]);
}

// Shared by Per Person / Top Vendors / Mismatched Fields — all three are just
// [label, count] pairs already sorted descending by the worker.
function writePairCounts(ss, sheetName, header, pairs) {
  const sheet = getOrCreateSheet_(ss, sheetName);
  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([header]).setFontWeight('bold');
  if (pairs.length) sheet.getRange(2, 1, pairs.length, 2).setValues(pairs);
  sheet.autoResizeColumns(1, 2);
}

// perProductUniqueBookings is an array of {vendor, product, uniqueBookingCount}
// objects rather than [label, count] pairs, so it gets its own writer.
function writeProducts(ss, products) {
  const sheet = getOrCreateSheet_(ss, 'Top Experiences');
  sheet.clear();
  const header = ['Vendor', 'Product', 'Unique Bookings'];
  const rows = products.map(p => [p.vendor || '', p.product || '', p.uniqueBookingCount || 0]);
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.autoResizeColumns(1, header.length);
}
