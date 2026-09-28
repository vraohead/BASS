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

// ── Daily pull, on Apps Script's own clock (no Cloudflare cron needed) ──────
// The Worker can push here on ITS schedule (see doPost above, and worker.js's
// scheduled() cron), but Apps Script can also PULL on ITS OWN schedule,
// independent of whatever time Cloudflare's cron happens to run at. This is
// the "run once, it repeats every morning forever" path: createDailyTrigger()
// installs a persistent time-driven trigger — you run it ONCE from the editor,
// Google's own infrastructure then invokes pullFromWorkerAndSync() every day
// around the chosen hour, with nothing further to do.
//
// Setup (one-time):
//   1. Project Settings (gear icon, left sidebar) > Script Properties >
//      Add property: ADMIN_PASSWORD = <the same admin password the Worker's
//      dashboard login uses>. Never hardcode it in this file.
//   2. Select createDailyTrigger in the function dropdown (editor toolbar) > Run.
//      (One-time authorization prompt on first run — approve it.)
//   3. Check Triggers (clock icon, left sidebar) — you should see one entry
//      for pullFromWorkerAndSync, "Time-driven", firing daily.
// To change the hour later, edit SYNC_HOUR below, then re-run
// createDailyTrigger() (it removes the old one first, so this is safe to
// re-run any time you want to change or just confirm the schedule).
const WORKER_BASE_URL = 'https://bass-verify.vivek-rao.workers.dev';
const SYNC_HOUR = 9; // 24h, in this Apps Script project's timezone (File > Project Settings)

function pullFromWorkerAndSync() {
  const password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!password) {
    throw new Error('ADMIN_PASSWORD script property not set — see setup instructions at the top of this file.');
  }
  const url = WORKER_BASE_URL + '/admin/usage-report-range?password=' + encodeURIComponent(password);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Worker returned HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  if (!data.ok) {
    throw new Error('Worker error: ' + (data.error || 'unknown'));
  }
  syncSnapshot(data);
}

function createDailyTrigger() {
  removeDailyTrigger_(); // avoid stacking up duplicate triggers on repeat runs
  ScriptApp.newTrigger('pullFromWorkerAndSync')
    .timeBased()
    .everyDays(1)
    .atHour(SYNC_HOUR)
    .create();
  Logger.log('Daily trigger installed — pullFromWorkerAndSync will fire once a day, in the hour starting at ' + SYNC_HOUR + ':00.');
}

// Apps Script time-driven triggers give you an HOUR WINDOW, not an exact
// minute — atHour(9) means "sometime between 9:00 and 9:59", not "at 9:00:00
// sharp". That's a Google platform limitation, not something this code can
// tighten further.
function removeDailyTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pullFromWorkerAndSync') ScriptApp.deleteTrigger(t);
  });
}

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
    ['', ''],
    ['Unique bookings verified', d.uniqueBookingCount || 0],
    ['Bookings fetched (not necessarily verified)', d.fetchedBookingCount || 0],
    ['Checkout page (good)', d.checkoutBookingCount || 0],
    ['Ticket shown instead (incorrect flag)', d.ticketBookingCount || 0],
    ['Other / unclear page', d.otherPageBookingCount || 0],
    ['', ''],
    ['Pre-Override Flags (mismatch caught at detection)', d.preOverrideFlagCount || 0],
    ['Override Confirmed (resolved and confirmed)', d.overrideConfirmedCount || 0],
    ['', ''],
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


// ── Daily Usage dashboard ────────────────────────────────────────────────────
// An editable, day-specific view inside the Sheet. It queries the same report
// endpoints as the web dashboard, so source, filter, bookings, and all metrics
// retain their existing definitions. Run setupDailyUsageDashboard() once.
const DAILY_USAGE_SHEET = 'Daily Usage';
const DAILY_USAGE_LISTS_SHEET = 'Daily Usage Lists';
const DAILY_USAGE_LOOKBACK_DAYS = 180;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BASS')
    .addItem('Refresh selected day', 'refreshDailyUsage')
    .addItem('Set up daily usage dashboard', 'setupDailyUsageDashboard')
    .addToUi();
}

function setupDailyUsageDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupDailyUsageLayout_(ss);
  rebuildDailyUsageDateList_(ss);
  installDailyUsageEditTrigger_(ss);
  refreshDailyUsage();
}

function onDailyUsageEdit(e) {
  const range = e && e.range;
  if (!range || range.getSheet().getName() !== DAILY_USAGE_SHEET) return;
  const a1 = range.getA1Notation();
  if (a1 === 'B3' || a1 === 'B4' || a1 === 'B5') refreshDailyUsage();
}

function setupDailyUsageLayout_(ss) {
  const sheet = getOrCreateSheet_(ss, DAILY_USAGE_SHEET);
  const lists = getOrCreateSheet_(ss, DAILY_USAGE_LISTS_SHEET);
  const existingDate = sheet.getRange('B3').getValue();
  const existingSource = sheet.getRange('B4').getValue();
  const existingFilter = sheet.getRange('B5').getValue();

  sheet.clear();
  sheet.getRange('A1:J1').merge()
    .setValue('BASS Daily Usage')
    .setFontSize(16).setFontWeight('bold')
    .setBackground('#1f4e78').setFontColor('#ffffff');
  sheet.getRange('A2:J2').merge()
    .setValue('Choose a day and filter below. The report refreshes automatically after a control changes.')
    .setFontColor('#666666');
  sheet.getRange('A3:A5').setValues([['Date'], ['Source'], ['Filter']]).setFontWeight('bold');
  sheet.getRange('B3').setValue(existingDate instanceof Date ? existingDate : new Date())
    .setNumberFormat('dd mmm yyyy');
  sheet.getRange('B4').setValue(existingSource || 'Channel');
  sheet.getRange('B5').setValue(existingFilter || 'All');

  const dateCount = DAILY_USAGE_LOOKBACK_DAYS + 1;
  sheet.getRange('B3').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(lists.getRange(2, 1, dateCount, 1), true)
      .setAllowInvalid(false).build()
  );
  sheet.getRange('B4').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['Channel', 'Dashboard'], true)
      .setAllowInvalid(false).build()
  );
  sheet.getRange('B5').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['All', 'Mismatched only', 'Full match only'], true)
      .setAllowInvalid(false).build()
  );
  sheet.getRange('A3:B5').setBackground('#eaf2f8');
  sheet.setFrozenRows(5);
  sheet.setColumnWidths(1, 1, 240);
  sheet.setColumnWidths(2, 9, 150);
}

function rebuildDailyUsageDateList_(ss) {
  const listSheet = getOrCreateSheet_(ss, DAILY_USAGE_LISTS_SHEET);
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i <= DAILY_USAGE_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push([d]);
  }
  listSheet.clearContents();
  listSheet.getRange('A1').setValue('Available dates');
  listSheet.getRange(2, 1, dates.length, 1).setValues(dates).setNumberFormat('dd mmm yyyy');
  if (!listSheet.isSheetHidden()) listSheet.hideSheet();
}

function installDailyUsageEditTrigger_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onDailyUsageEdit') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('onDailyUsageEdit').forSpreadsheet(ss).onEdit().create();
}

function refreshDailyUsage() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, DAILY_USAGE_SHEET);
  try {
    const report = fetchDailyUsageReport_(sheet);
    writeDailyUsageReport_(sheet, report);
  } catch (err) {
    sheet.getRange('A7:J8').clearContent().setBackground(null);
    sheet.getRange('A7').setValue('Could not load this day').setFontWeight('bold').setFontColor('#b91c1c');
    sheet.getRange('A8:J8').merge().setValue(String(err.message || err)).setFontColor('#b91c1c');
  }
}

function fetchDailyUsageReport_(sheet) {
  const selectedDate = sheet.getRange('B3').getValue();
  if (!(selectedDate instanceof Date) || isNaN(selectedDate.getTime())) {
    throw new Error('Select a valid date from the Date dropdown.');
  }
  const password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!password) throw new Error('ADMIN_PASSWORD script property is not set.');

  const tz = Session.getScriptTimeZone();
  const nextDate = new Date(selectedDate);
  nextDate.setDate(nextDate.getDate() + 1);
  const start = Utilities.formatDate(selectedDate, tz, "yyyy-MM-dd'T'00:00:00Z");
  const end = Utilities.formatDate(nextDate, tz, "yyyy-MM-dd'T'00:00:00Z");
  const source = sheet.getRange('B4').getValue() === 'Dashboard' ? 'Dashboard' : 'Channel';
  const filterLabel = sheet.getRange('B5').getValue() || 'All';
  const filter = filterLabel === 'Mismatched only' ? 'mismatch' :
    filterLabel === 'Full match only' ? 'fullmatch' : 'all';
  const endpoint = source === 'Dashboard' ? '/admin/usage-report-range' : '/admin/channel-report';
  const url = WORKER_BASE_URL + endpoint +
    '?password=' + encodeURIComponent(password) +
    '&start=' + encodeURIComponent(start) +
    '&end=' + encodeURIComponent(end) +
    '&filter=' + encodeURIComponent(filter);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error('Worker returned HTTP ' + status + ': ' + body.slice(0, 300));
  const report = JSON.parse(body);
  if (!report.ok) throw new Error(report.error || 'Worker returned an unknown error.');
  return report;
}

function writeDailyUsageReport_(sheet, report) {
  sheet.getRange('A7:V1000').clearContent().clearFormat();
  const tagged = (report.checkoutBookingCount || 0) + (report.ticketBookingCount || 0) + (report.otherPageBookingCount || 0);
  const checkoutRate = tagged ? (report.checkoutBookingCount || 0) / tagged : 0;
  const fullMatchRate = report.checksWithData ? (report.fullMatchChecks || 0) / report.checksWithData : 0;
  const pendingFlags = Math.max(0, (report.preOverrideFlagCount || 0) - (report.overrideConfirmedCount || 0));

  sheet.getRange('A7:J7').merge()
    .setValue('Usage for ' + Utilities.formatDate(sheet.getRange('B3').getValue(), Session.getScriptTimeZone(), 'dd MMM yyyy') +
      ' · ' + (report.source || '').toUpperCase() + ' · ' + (report.filter || 'all'))
    .setFontWeight('bold').setBackground('#d9eaf7');
  sheet.getRange('A8').setValue('Last refreshed');
  sheet.getRange('B8').setValue(new Date()).setNumberFormat('dd mmm yyyy HH:mm');
  sheet.getRange('A10:B10').setValues([['Metric', 'Value']]).setFontWeight('bold').setBackground('#1f4e78').setFontColor('#ffffff');
  const metrics = [
    ['Unique bookings verified', report.uniqueBookingCount || 0],
    ['Bookings fetched', report.fetchedBookingCount || 0],
    ['Checkout capture rate', checkoutRate],
    ['Full-match rate', fullMatchRate],
    ['Incorrect flags', report.ticketBookingCount || 0],
    ['Pre-Override Flags', report.preOverrideFlagCount || 0],
    ['Override Confirmed', report.overrideConfirmedCount || 0],
    ['Not yet confirmed', pendingFlags],
  ];
  sheet.getRange(11, 1, metrics.length, 2).setValues(metrics);
  sheet.getRange(13, 2, 2, 1).setNumberFormat('0%');

  writeDailyUsageTable_(sheet, 10, 4, 'Page type', ['Page type', 'Unique bookings'], [
    ['Checkout page', report.checkoutBookingCount || 0],
    ['Ticket shown instead', report.ticketBookingCount || 0],
    ['Other / unclear', report.otherPageBookingCount || 0],
  ]);
  writeDailyUsageTable_(sheet, 10, 7, 'Match quality', ['Match quality', 'Checks'], [
    ['Full match', report.fullMatchChecks || 0],
    ['Partial match', report.partialMatchChecks || 0],
    ['Checks with field data', report.checksWithData || 0],
  ]);

  writeDailyUsageTable_(sheet, 21, 1, 'Top vendors', ['Vendor', 'Unique bookings'], report.perVendorUniqueBookings || []);
  writeDailyUsageTable_(sheet, 21, 4, 'Top experiences', ['Vendor', 'Experience', 'Unique bookings'],
    (report.perProductUniqueBookings || []).map(function (p) {
      return [p.vendor || '—', p.product || '—', p.uniqueBookingCount || 0];
    })
  );
  writeDailyUsageTable_(sheet, 21, 8, 'Most-mismatched fields', ['Field', 'Times mismatched'], report.fieldMismatchCounts || []);
  writeDailyUsageTable_(sheet, 21, 11, 'Per person', ['Agent', 'Checks run', 'Unique bookings'],
    mergePersonRows_(report.perPersonCheckCounts || [], report.perPersonUniqueBookings || [])
  );

  const bookingStart = 50;
  const bookingHeaders = ['Booking ID', 'Stage', 'Agent', 'At', 'Vendor', 'Product', 'Page type', 'Mismatched fields', 'Slack link'];
  sheet.getRange(bookingStart, 1, 1, bookingHeaders.length).setValues([bookingHeaders])
    .setFontWeight('bold').setBackground('#1f4e78').setFontColor('#ffffff');
  const bookings = (report.bookings || []).map(function (b) {
    return [
      b.bookingId || '', b.stage || '', b.agentEmail || '', b.at || '',
      b.vendor || '', b.product || '', b.pageType || '',
      (b.mismatchedFields || []).join(', '),
      b.slackLink ? '=HYPERLINK("' + b.slackLink + '","Open in Slack")' : '—',
    ];
  });
  if (bookings.length) sheet.getRange(bookingStart + 1, 1, bookings.length, bookingHeaders.length).setValues(bookings);
  else sheet.getRange(bookingStart + 1, 1).setValue('No bookings match this date and filter.');
  sheet.getRange(bookingStart, 1, Math.max(bookings.length + 1, 2), bookingHeaders.length).createFilter();
  sheet.autoResizeColumns(1, bookingHeaders.length);
  sheet.setColumnWidth(6, 280);
  sheet.setColumnWidth(8, 260);
}

function writeDailyUsageTable_(sheet, row, col, title, headers, rows) {
  sheet.getRange(row, col, 1, headers.length).merge()
    .setValue(title).setFontWeight('bold').setBackground('#d9eaf7');
  sheet.getRange(row + 1, col, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1f4e78').setFontColor('#ffffff');
  if (rows.length) sheet.getRange(row + 2, col, rows.length, headers.length).setValues(rows);
  else sheet.getRange(row + 2, col).setValue('No data');
  sheet.autoResizeColumns(col, headers.length);
}

function mergePersonRows_(checks, bookings) {
  const uniqueByEmail = {};
  bookings.forEach(function (row) { uniqueByEmail[row[0]] = row[1]; });
  return checks.map(function (row) { return [row[0], row[1], uniqueByEmail[row[0]] || 0]; });
}
