// Booking Assistant Verify Worker — proxies screenshot AI verification and the
// Confirm & Flag Slack notification, so the OpenAI key and Slack bot
// token stay on Cloudflare, never in the extension.
//
// Deploy (Cloudflare dashboard "Edit code" flow):
//   1. Paste this entire file, replacing everything.
//   2. Save and deploy.
//   3. Confirm the deploy actually took by visiting /debug-env — it
//      reports WORKER_VERSION below, so a mismatch means the paste
//      didn't take or you're looking at a different environment.
//
// Deploy (wrangler CLI, if available):
//   wrangler deploy
//   wrangler secret put OPENAI_API_KEY   <- paste key when prompted
//   wrangler secret put SLACK_BOT_TOKEN  <- paste Slack bot token when prompted
//
// Endpoints:
//   GET  /               -> the admin control page (see "Admin page" below)
//   GET  /debug-env      -> { hasSlackToken, hasOpenAiKey, slackChannelId, version }
//   POST /verify          { imageBase64, mimeType, facts: {date,time,pax,price,product}, bookingId?, agentEmail?, vendor? }
//                          -> { checks: [...], pageType, pageTypeNote }
//                             each check is { label, expected, status, seenValue } where
//                             status is "match", "mismatch" (read, but contradicts the
//                             record — seenValue required), or "not_found" (missing/
//                             illegible, nothing to compare). pageType is "checkout"
//                             (expected), "ticket" (already-issued ticket instead — the
//                             flagged case), or "other" (neither — blank/error/unrelated
//                             page). bookingId, agentEmail, and vendor (all optional) only
//                             feed the usage report below — omitting any just skips that
//                             slice of tracking, the AI check itself is unaffected.
//                             If any check comes back "mismatch", this also posts a
//                             ":triangular_flag_on_post: Mismatch Flagged" alert to the
//                             confirm-flag channel immediately (stage: 'flagged') — this
//                             is the only trace left behind for a booking that never makes
//                             it to Confirm & Flag at all. See stage/strictMismatchFields
//                             in recordVerifyEvent() and the Pre-Override Flags /
//                             Override Confirmed dashboard tiles.
//   POST /confirm-flag     { bookingId, agentEmail, confirmed, skipped, overridden,
//                            imageBase64?, mimeType?, verifiedAt, vendor?, product?,
//                            vendorId?, tourId?, pageType? }
//                          skipped = {label,value}[] for a NOT-FOUND field (checkbox-skip in the
//                          extension); overridden = {label,value,expected,reason}[] for a field
//                          AI Verify actually read and found to CONTRADICT the booking record — a
//                          stricter path in the extension (typed reason required, not a checkbox),
//                          called out in its own alert line since it's the higher-severity case.
//                          vendor/product/pageType go into both the Slack alert text AND
//                          the verifylog: KV entry — vendorId/tourId (Scorpio/Aries lookup)
//                          go into the alert text only, not the usage log.
//                          pageType is only ever set when AI Verify ran first (never for
//                          Late Confirm) — this is what lets the channel-based report (see
//                          /admin/channel-report below) carry the same checkout/ticket/other
//                          classification the KV log gets from /verify.
//                          -> { ok: true, steps: [...], screenshotError? }
//                          Also records a verifylog: event (same as /verify) so every
//                          Confirm & Flag click counts toward usage — this fires far more
//                          often than AI Verify itself, so it's the real usage signal.
//   GET  /admin/send-daily-code?password=...    -> manually trigger the Slack post (for testing)
//   GET  /admin/send-usage-report?password=...&alsoMainChannel=  -> send the totals report to
//                                                   the passcode channel right now (also wired to
//                                                   a button on the admin page); alsoMainChannel=true
//                                                   also posts to the main confirm-flag channel
//   GET  /admin/send-agent-report?password=...&alsoMainChannel=  -> same, for the per-person report
//   GET  /admin/usage-report-range?password=...&start=<ISO>&end=<ISO>&filter=
//                          -> the KV-log source for the admin page's Channel/Dashboard
//                             toggle: the full summarizeEvents() shape (see below) for
//                             exactly that window, plus a `bookings` list — same response
//                             shape as /admin/channel-report below (source: 'dashboard'
//                             vs 'channel' is the only difference the frontend checks).
//                             filter is 'all' (default), 'mismatch', or 'fullmatch'.
//   POST /admin/backfill-from-slack { password, since?, until? } -> reads the
//                          main confirm-flag channel and writes any missing
//                          verifylog: entries for that range (default: last
//                          30 days). Re-running it for an overlapping range
//                          is safe — each entry is keyed off the Slack
//                          message's own timestamp, so it overwrites rather
//                          than duplicates. One-time historical import only;
//                          /confirm-flag itself has logged live since -01.
//   GET  /admin/channel-audit?password=...&start=&end=  -> channel vs KV-log
//                          counts side by side for the same window, so a
//                          future under-counting bug shows up as a gap here
//                          instead of silently skewing the usage numbers.
//   GET  /admin/channel-report?password=...&start=&end=&filter=  -> the primary,
//                          channel-based usage report — reads the Confirm & Flag
//                          channel directly (not the KV log) for any date range
//                          (default: last rolling 24h). filter is 'all' (default),
//                          'mismatch' (only bookings with an acknowledged skip), or
//                          'fullmatch'. Returns the full summarizeEvents() shape
//                          (same as /admin/usage-report-range above — source:
//                          'channel' vs 'dashboard' is the only difference), plus
//                          `bookings` (capped at 500, newest first).
//   GET  /admin/config?password=...           -> secret/binding status (admin-only)
//   POST /admin/request-code { password } -> generate + Slack-post an admin
//                                             code, reusable all day (admin-only)
//   POST /verify-code      { code } -> { valid: true|false, adminMode: true|false }
//                             adminMode is true only for a matched admin
//                             code — false for a matched instructions code
//
// Usage tracking — one permanent, append-only KV event log (verifylog: keys,
// each a random-UUID key with the actual data in its KV metadata: bookingId,
// email, vendor, product, pageType, totalChecks, mismatchedFields, at).
// Every /verify call that carries a bookingId and/or agentEmail writes one
// entry; nothing is ever overwritten, so any report — all-time, last-24h, or
// an arbitrary custom range — is just a filter + aggregation over this same
// log, computed at read time (listVerifyEvents + summarizeEvents). There's
// no separate step or button an agent needs to remember to generate this
// data, since the extension runs AI Verify itself the instant a screenshot
// is captured, pasted, or uploaded (not gated behind a manual "AI Verify"
// click).
//
// Three ways to read it, all admin-page buttons/cards plus a matching daily
// cron post (except the custom range, which is on-demand only). Both Slack
// reports post to DAILY_CODE_CHANNEL_ID (the passcode channel) by default —
// deliberately not the main confirm-flag channel, since this is admin-level
// data rather than something the whole team needs in their feed. Each
// on-demand button has an "Also send to the main team channel" checkbox
// (?alsoMainChannel=true) for when you want it there too; the automatic
// daily cron post always stays passcode-channel-only:
//   1. Totals (sendUsageReportToSlack) — unique bookings that have run AI
//      Verify, all-time; the pageType breakdown (checkout / ticket-instead /
//      other); full-match vs. partial-match check counts and which field is
//      most often mismatched; and the busiest vendors and experiences by
//      unique bookings verified. All cumulative since this shipped, not a
//      daily/weekly delta — there's no historical data from before this
//      existed to backfill from.
//   2. Per-person (sendAgentUsageReportToSlack) — who's using it: checks run
//      per person over a true rolling last 24 hours (recomputed from the
//      log at read time, not a calendar-day bucket), listing every person
//      who has ever logged an event so someone at 0 today still shows up
//      rather than silently disappearing — plus total unique bookings each
//      person has actioned, all-time.
//   3. Custom range (handleAdminUsageReportRange) — the same totals and
//      per-person breakdown as above, but for whatever start/end window is
//      asked for instead of last-24h or all-time. On-demand only, doesn't
//      post to Slack at all — rendered inline on the admin page instead.
//
// Every meaningful operation (Slack calls, OpenAI calls) appends a
// {step, ok, detail, at} entry to a `steps` array that's returned in the
// JSON response — so a failure anywhere always comes back with the exact
// step name, HTTP status, and raw response body instead of a generic
// "something went wrong".
//
// Codes — one shared format everywhere: "<bookingId>-<code>" typed into the
// Booking ID box (booking ID first, always). Both kinds are random 6-digit
// codes stored in the CONFIG KV namespace and posted to the same Slack
// channel — they differ only in lifetime, and the /verify-code response's
// adminMode field tells the extension which one (if either) just matched:
//
// 1. Instructions code — unlocks ONE gated booking's Instructions, then is
//    immediately consumed. Valid 5 minutes, single-use (deleted on the
//    first successful match, even if time remains — re-fetching the same
//    booking with the same code again will not work). One posts
//    automatically per day via this Worker's `scheduled` handler to
//    DAILY_CODE_CHANNEL_ID — wire the cron up once in the Dashboard:
//    Settings -> Triggers -> Cron Triggers -> "35 18 * * *" (00:05 IST).
//    Need another one that same day (the daily one already used, or
//    expired)? Click "Send to Slack now" on the admin page any time —
//    it generates and posts a brand new one on demand.
//
// 2. Admin code — replaces the old static admin master code. Generated on
//    demand via the admin page's "Request admin code" button (POST
//    /admin/request-code), stored with a TTL that runs out at the next IST
//    midnight, and NOT deleted on use — reusable as many times as needed
//    for the rest of that day. Redeeming it flips a persistent "admin
//    mode" in the extension (chrome.storage.local, not this Worker) that
//    bypasses every display gate — Past booking, Booking due soon,
//    Instructions withheld — from then on, for testing.
//    Request a fresh one any day you need admin access again.
//
// Both require:
//   wrangler secret put SLACK_BOT_TOKEN     <- posts the codes to Slack
//   wrangler secret put ADMIN_PASSWORD      <- gates /admin/* endpoints
// and the CONFIG KV binding (see "Admin page" below) — without it neither
// kind of code can be generated, stored, or verified.
//
// Admin page: visiting this Worker's own URL in a browser (e.g.
// https://bass-verify.vivek-rao.workers.dev/) serves a small password-gated
// control page — no separate site or Artifact needed, since this is
// same-origin to the Worker's own API. It shows secret/binding status,
// today's codes, and lets you trigger the instructions-code Slack post or
// request a fresh admin code on demand, all through the /admin/* endpoints
// above (same ADMIN_PASSWORD secret as everything else admin-only).
//
// The CONFIG Workers KV namespace is what both code kinds are stored in —
// one-time setup: Dashboard -> this worker -> Settings -> Bindings -> Add
// -> KV Namespace -> create a namespace (any name) -> bind it as variable
// name CONFIG. Until that binding exists, the admin page's status panel
// says so and neither code kind can be generated.

// Bump this string whenever you paste a new version into the dashboard —
// visiting GET /debug-env instantly confirms whether a deploy took effect.
const WORKER_VERSION = '2026-09-21-11';

// Formats an ISO timestamp as a clean IST string, e.g. "6 Sep 2026, 10:44 PM IST".
function formatIST(isoString) {
  if (!isoString) return '';
  try {
    const formatted = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(isoString));
    return `${formatted} IST`;
  } catch (_) {
    return isoString;
  }
}

// Not sensitive, so hardcoded here rather than as an env var/secret —
// change these if the target Slack channels ever change.
const SLACK_CHANNEL_ID = 'C0BV91K7F70';
const DAILY_CODE_CHANNEL_ID = 'C0BKUTZ4ADN';

// Cloudflare Workers Builds (Git auto-deploy) has repeatedly wiped the
// Dashboard-set ADMIN_PASSWORD secret on CI-triggered deploys, locking the
// admin page out. This fallback keeps admin access working even if that
// happens again — set ADMIN_PASSWORD in the Dashboard to override it, and
// rotate this value periodically since it's stored in source.
const FALLBACK_ADMIN_PASSWORD = 'Vivek124';
function getAdminPassword(env) { return env.ADMIN_PASSWORD || FALLBACK_ADMIN_PASSWORD; }

export default {
  async fetch(request, env, ctx) {
    // CORS pre-flight — every route needs this handled first.
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
      return htmlResponse(ADMIN_PAGE_HTML);
    }

    // The Verify Pulse analytics view used to be its own page at these
    // paths — it now lives inline on the admin page itself, so redirect
    // anyone with the old link.
    if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/pulse')) {
      return Response.redirect(url.origin + '/', 302);
    }

    if (request.method === 'GET' && url.pathname === '/debug-env') {
      return cors(JSON.stringify({
        version: WORKER_VERSION,
        hasSlackToken: !!env.SLACK_BOT_TOKEN,
        hasOpenAiKey: !!env.OPENAI_API_KEY,
        hasAdminPassword: true, // always true — falls back to a hardcoded value if the secret is unset
        hasConfigKv: !!env.CONFIG,
        slackChannelId: SLACK_CHANNEL_ID,
        dailyCodeChannelId: DAILY_CODE_CHANNEL_ID,
      }), 200);
    }

    if (request.method === 'POST' && url.pathname === '/confirm-flag') {
      return handleConfirmFlag(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/verify') {
      return handleVerify(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/admin/send-daily-code') {
      return handleAdminSendDailyCode(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/send-usage-report') {
      return handleAdminSendUsageReport(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/send-agent-report') {
      return handleAdminSendAgentReport(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/usage-report-range') {
      return handleAdminUsageReportRange(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/admin/backfill-from-slack') {
      return handleAdminBackfillFromSlack(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/admin/channel-audit') {
      return handleAdminChannelAudit(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/channel-report') {
      return handleAdminChannelReport(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/config') {
      return handleAdminGetConfig(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/admin/request-code') {
      return handleAdminRequestCode(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify-code') {
      return handleVerifyCode(request, env);
    }

    return cors(JSON.stringify({ error: 'Not found', version: WORKER_VERSION }), 404);
  },

  // Cloudflare cron trigger — wire up in the Dashboard (Triggers -> Cron
  // Triggers), see the header comment. Posts today's code to the Slack
  // channel automatically; failures are swallowed here since there's no
  // HTTP caller to report them to (use /admin/send-daily-code to test
  // manually and see the actual error).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyCodeToSlack(env));
    ctx.waitUntil(sendUsageReportToSlack(env));
    ctx.waitUntil(sendAgentUsageReportToSlack(env));
  },
};

// ── Codes ────────────────────────────────────────────────────────────────────
// Both code kinds are random, stored in the CONFIG KV namespace, and posted
// to Slack — they differ only in TTL and whether they're deleted on use:
//   - Instructions code: 5-minute TTL, single-use (deleted the instant it's
//     redeemed). One posts automatically every day (cron); "Send to Slack
//     now" on the admin page generates and sends another whenever more are
//     needed that day.
//   - Admin code: TTL until the end of the current IST day, NOT deleted on
//     use — reusable all day once requested. Grants persistent admin mode.

const INSTR_CODE_TTL_SECONDS = 300; // 5 minutes
function instrCodeKey(code) { return `instrcode:${code}`; }
function adminCodeKey(code) { return `admincode:${code}`; }

async function generateRandomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let num = 0;
  for (let i = 0; i < 4; i++) num = (num << 8) | bytes[i];
  num = (num >>> 0) % 1000000;
  return String(num).padStart(6, '0');
}

// Seconds remaining until the next IST midnight — the admin code's TTL, so
// it naturally stops working at day's end without any extra bookkeeping.
function secondsUntilMidnightIST() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  const secondsSinceMidnight = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  return Math.max(60, 86400 - secondsSinceMidnight);
}

// Generates + stores a fresh instructions code and posts it to Slack.
// Shared by the daily cron trigger and the "Send to Slack now" button (for
// testing, or to send an extra one mid-day without waiting for the cron).
async function sendDailyCodeToSlack(env) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  if (!env.SLACK_BOT_TOKEN || !env.CONFIG) {
    logStep('check_config', false, 'SLACK_BOT_TOKEN secret or CONFIG KV binding missing');
    return { ok: false, error: 'Worker misconfigured', steps };
  }

  const code = await generateRandomCode();
  await env.CONFIG.put(instrCodeKey(code), '1', { expirationTtl: INSTR_CODE_TTL_SECONDS });
  const text = `:key: *Booking Assistant instructions code:* \`${code}\`\n_Valid for the next 5 minutes, single-use — type it as \`<booking ID>-${code}\` in the Booking ID box to unlock that one booking's gated instructions._`;

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: DAILY_CODE_CHANNEL_ID, text }),
    });
    const data = await res.json();
    logStep('slack_chat_postMessage', data.ok === true, `HTTP ${res.status} — ${JSON.stringify(data).slice(0, 500)}`);
    return { ok: data.ok === true, error: data.ok ? null : data.error, code, steps };
  } catch (err) {
    logStep('slack_chat_postMessage', false, `Exception: ${err.message}`);
    return { ok: false, error: err.message, steps };
  }
}

async function handleAdminSendDailyCode(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const result = await sendDailyCodeToSlack(env);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

// ── Admin config status ──────────────────────────────────────────────────────
async function handleAdminGetConfig(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }

  return cors(JSON.stringify({
    workerVersion: WORKER_VERSION,
    hasConfigKv: !!env.CONFIG,
    hasSlackToken: !!env.SLACK_BOT_TOKEN,
    hasOpenAiKey: !!env.OPENAI_API_KEY,
    dailyCodeChannelId: DAILY_CODE_CHANNEL_ID,
  }), 200);
}

// Checks a submitted code against both pools and reports which one (if
// either) matched. adminMode:true only for a matched admin code — the
// instructions code never grants more than that one booking's unlock, and
// is deleted immediately so it can never be redeemed twice.
async function handleVerifyCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  const submitted = String(body.code || '').trim();
  if (!submitted || !env.CONFIG) {
    return cors(JSON.stringify({ valid: false, adminMode: false }), 200);
  }

  // Admin code — reusable all day, so presence alone is enough; not deleted.
  const adminFound = await env.CONFIG.get(adminCodeKey(submitted));
  if (adminFound !== null) {
    return cors(JSON.stringify({ valid: true, adminMode: true }), 200);
  }

  // Instructions code — single-use, deleted the instant it matches, even
  // though its 5-minute TTL would also expire it eventually on its own.
  const instrKey = instrCodeKey(submitted);
  const instrFound = await env.CONFIG.get(instrKey);
  if (instrFound !== null) {
    await env.CONFIG.delete(instrKey);
    return cors(JSON.stringify({ valid: true, adminMode: false }), 200);
  }

  return cors(JSON.stringify({ valid: false, adminMode: false }), 200);
}

// Generates a fresh admin code, stores it until end-of-day IST (reusable,
// not deleted on use), and posts it to the same Slack channel as the
// instructions code. Replaces the old static ADMIN_MASTER_CODE secret
// entirely — request a new one from the admin page any time admin access
// is needed (or just keep using today's until it rolls over at midnight).
async function handleAdminRequestCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  if (body.password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  if (!env.CONFIG) {
    return cors(JSON.stringify({
      error: 'No CONFIG KV namespace bound — codes need it to track single-use/expiry',
    }), 500);
  }
  if (!env.SLACK_BOT_TOKEN) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the SLACK_BOT_TOKEN secret' }), 500);
  }

  const code = await generateRandomCode();
  const ttl = secondsUntilMidnightIST();
  await env.CONFIG.put(adminCodeKey(code), '1', { expirationTtl: ttl });

  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });
  const text = `:zap: *Admin code:* \`${code}\`\n_Reusable for the rest of today (IST) — type it as \`<booking ID>-${code}\` in the Booking ID box to unlock admin mode on this device._`;

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: DAILY_CODE_CHANNEL_ID, text }),
    });
    const data = await res.json();
    logStep('slack_chat_postMessage', data.ok === true, `HTTP ${res.status} — ${JSON.stringify(data).slice(0, 500)}`);
    if (!data.ok) {
      return cors(JSON.stringify({ ok: false, error: data.error, steps }), 502);
    }
  } catch (err) {
    logStep('slack_chat_postMessage', false, `Exception: ${err.message}`);
    return cors(JSON.stringify({ ok: false, error: err.message, steps }), 502);
  }

  return cors(JSON.stringify({ ok: true, code, expiresInSeconds: ttl, steps }), 200);
}

// gpt-4o-mini is instructed to treat "13:20" and "1:20 PM" as the same time
// (tolerance rule 2 in the prompt below), but it can still get the 24-hour /
// 12-hour conversion wrong and report a "mismatch" for a time that is
// actually identical — as opposed to date/product-name tolerance, which
// genuinely needs judgment, converting HH:MM(:SS) <-> H:MM AM/PM is a pure,
// deterministic parse, so this catches and downgrades exactly that class of
// AI arithmetic slip instead of trusting the model to always get it right.
function parseClockTimeToMinutes(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[4] ? m[4].toLowerCase().replace(/\./g, '') : null;
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  return hour * 60 + minute;
}

function downgradeFalseTimeMismatches(checks) {
  for (const c of checks || []) {
    if (c.status !== 'mismatch' || !/time/i.test(c.label || '')) continue;
    const expectedMin = parseClockTimeToMinutes(c.expected);
    const seenMin = parseClockTimeToMinutes(c.seenValue);
    if (expectedMin !== null && seenMin !== null && expectedMin === seenMin) {
      c.status = 'match';
      c.seenValue = '';
    }
  }
}

const MONTH_NUMBERS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad2 = n => String(n).padStart(2, '0');

// Same failure mode as time above, for dates — the prompt already says
// "14 Sep 2026", "2026-09-14", "Sep 14, 2026", "14/09/2026" can all be the
// same calendar date, but the model can still misjudge two differently-
// formatted-but-identical dates as a mismatch. Parsing to a plain
// YYYY-MM-DD and comparing is deterministic, so it catches that slip the
// same way the time guard does, without needing any judgment of its own.
function parseDateToISODay(str) {
  if (!str) return null;
  const s = String(str).trim();

  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); // 2026-07-29
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // 29/07/2026 (day-month-year)
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10);
    if (day > 12 && month <= 12) return `${m[3]}-${pad2(month)}-${pad2(day)}`;
    if (month > 12 && day <= 12) return `${m[3]}-${pad2(day)}-${pad2(month)}`;
    return `${m[3]}-${pad2(month)}-${pad2(day)}`; // ambiguous — assume day-month-year
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/); // 29 Jul 2026
  if (m) {
    const mon = MONTH_NUMBERS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${pad2(mon)}-${pad2(m[1])}`;
  }

  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/); // Jul 29, 2026 / Jul 29 2026
  if (m) {
    const mon = MONTH_NUMBERS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${pad2(mon)}-${pad2(m[2])}`;
  }

  return null;
}

function downgradeFalseDateMismatches(checks) {
  for (const c of checks || []) {
    if (c.status !== 'mismatch' || !/date/i.test(c.label || '')) continue;
    const expectedDay = parseDateToISODay(c.expected);
    const seenDay = parseDateToISODay(c.seenValue);
    if (expectedDay !== null && seenDay !== null && expectedDay === seenDay) {
      c.status = 'match';
      c.seenValue = '';
    }
  }
}

// The prompt instructs the model to include one check per non-empty field
// (see the "Rules" section above), but that's still just an instruction —
// nothing in the schema enforces it, and a busy/uncertain completion can
// still drop one. Rather than let a dropped field silently vanish from the
// agent's results (looking like it was never checked at all), this fills
// in a "not_found" placeholder for any expected field the model's response
// didn't cover — same treatment as a field it saw but couldn't read.
function fillMissingChecks(checks, expectedFields) {
  const list = checks || [];
  for (const f of expectedFields) {
    const already = list.some(c => (c.label || '').trim().toLowerCase() === f.label.toLowerCase());
    if (!already) list.push({ label: f.label, expected: f.value, status: 'not_found', seenValue: '' });
  }
  return list;
}

// ── /verify — AI screenshot verification ──────────────────────────────────────

async function handleVerify(request, env, ctx) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  let body;
  try {
    body = await request.json();
    logStep('parse_request_body', true, null);
  } catch (err) {
    logStep('parse_request_body', false, err.message);
    return cors(JSON.stringify({ error: 'Invalid JSON body', steps }), 400);
  }

  const { imageBase64, mimeType = 'image/png', facts = {}, bookingId = '', agentEmail = '', vendor = '' } = body;

  if (!imageBase64) {
    logStep('validate_input', false, 'imageBase64 missing');
    return cors(JSON.stringify({ error: 'imageBase64 is required', steps }), 400);
  }
  logStep('validate_input', true, null);

  if (!env.OPENAI_API_KEY) {
    logStep('check_openai_key', false, 'OPENAI_API_KEY secret not set');
    return cors(JSON.stringify({
      error: 'Worker misconfigured — run: wrangler secret put OPENAI_API_KEY (or add it as a Secret in the dashboard Settings)',
      steps,
    }), 500);
  }
  logStep('check_openai_key', true, null);

  const { date = '', time = '', pax = '', price = '', product = '' } = facts;

  // label is the exact string the model must use for that field's check —
  // spelling it out per-field (rather than leaving it to infer one from the
  // description) is what the "one check per field" rule below can actually
  // be verified against, both by the model and by the fallback further down
  // that fills in any field the model still drops.
  const expectedFields = [
    { key: 'date',    label: 'Date',       value: date,    desc: `Date: ${date}` },
    { key: 'time',    label: 'Time',       value: time,    desc: `Time: ${time}` },
    { key: 'pax',     label: 'Pax',        value: pax,     desc: `Total pax (guests): ${pax}` },
    { key: 'price',   label: 'Net Price',  value: price,   desc: `Net price: ${price}` },
    { key: 'product', label: 'Product',    value: product, desc: `Product / experience name: ${product}` },
  ].filter(f => f.value);

  const factLines = expectedFields.map(f => f.desc).join('\n');
  const labelList = expectedFields.map(f => `"${f.label}"`).join(', ');

  // Deliberately verbose and explicit — the aim is to eliminate manual
  // re-checking entirely, not just catch the easy cases. Every rule below
  // exists because a naive exact-string-match prompt used to miss it.
  const prompt = `You are a meticulous booking-verification assistant. Agents capture this screenshot BEFORE finalizing a booking on a vendor site, to catch mistakes (wrong date, wrong pax, wrong tour) while they can still be fixed — so it should show the CHECKOUT / CART / PAYMENT page with the booking details entered but not yet confirmed, not an already-issued ticket. Getting a field's status wrong causes real problems in either direction — calling a genuine mismatch a "match" lets a mistake through, and calling a merely-unclear field a "mismatch" causes needless alarm — so read carefully and think about what's actually shown before answering.

Booking record to match against the screenshot:
${factLines}

How to judge each field — for every field, decide between three states:
- "match": the value shown is unambiguously the same as expected (after the format-tolerance rules below).
- "mismatch": the field IS visible and readable in the screenshot, but shows a DIFFERENT value than expected — a genuine contradiction, not just a formatting difference. When you report this, you must also give seenValue: the actual value you read from the screenshot.
- "not_found": the field is missing, blank, cropped off, or too illegible to read at all — there is nothing to compare, so this is not a contradiction, just an absence. seenValue should be an empty string.

Per-field tolerance rules (apply before deciding match vs. mismatch):
1. Date: dates are often written in completely different formats between the booking record and the screenshot (e.g. "14 Sep 2026", "2026-09-14", "Sep 14, 2026", "14/09/2026" can all be the SAME date). Parse both and compare the actual calendar date, not the text formatting. Only mark mismatch if the calendar date shown is genuinely a different date.
2. Time: same principle — "3:00 PM", "15:00", and "3 PM" are the same time of day. Allow for a different timezone label as long as the underlying time is consistent with the booking; only mark mismatch if the actual time of day is genuinely different.
3. Total pax (guests): look for the TOTAL guest/pax/ticket count shown in the screenshot. If the screenshot breaks pax down by type (e.g. "2 Adults, 1 Child"), add them up yourself and compare the sum to the expected total — do not mark mismatch just because no single number matches if the breakdown sums to the expected total.
4. Net price: ignore currency symbol, comma, and decimal-formatting differences; compare the numeric amount itself.
5. Product / experience name: compare the tour/experience/product name shown in the screenshot against the expected name. Minor wording differences (abbreviations, punctuation, added suffixes like "- with hotel pickup", capitalization) still count as a match if it is clearly the same experience. A genuinely different tour or activity is a mismatch, not a not_found.

Separately — always answer this regardless of the fields above:
6. Page type: classify what the screenshot actually shows, as exactly one of:
   - "checkout": the expected case — a CHECKOUT / CART / PAYMENT page on the vendor's site, showing the booking being entered and about to be confirmed (an editable cart, guest/date/time selection, a "Pay now" or "Proceed to payment" button, a price breakdown).
   - "ticket": an already-confirmed/issued ticket or booking confirmation instead (a booking/ticket/confirmation number, a QR/barcode, "Booking Confirmed", a voucher) — checking details only AFTER the booking is already placed defeats the entire purpose of catching mistakes before they happen, so this must be flagged whenever it happens.
   - "other": neither of the above — a blank/loading page, an error page, a login/session-expired screen, an unrelated page, or anything else that isn't a checkout page or a ticket. Use this rather than forcing a screenshot into "checkout" or "ticket" when it's genuinely neither.

Reply ONLY with valid JSON in this exact shape — no markdown, no extra text:
{"checks":[{"label":"Date","expected":"${date}","status":"match","seenValue":""},{"label":"Time","expected":"${time}","status":"mismatch","seenValue":"11:00 AM"}],"pageType":"checkout","pageTypeNote":""}

Rules:
- Include exactly one check per field listed above — one for each of: ${labelList}. Do not omit any of them, even if you're unsure — use "not_found" rather than dropping a field entirely.
- Use the label exactly as given above (e.g. "Net Price", not "Net price" or "Price") — this is how the results get matched back up on the agent's side.
- status must be exactly one of "match", "mismatch", or "not_found" per the definitions above.
- seenValue is required (non-empty) when status is "mismatch", and must be an empty string otherwise.
- pageType must be exactly one of "checkout", "ticket", or "other" per the definitions above.
- pageTypeNote: if pageType is not "checkout", a short (under 15 words) reason why (e.g. "Shows a confirmed booking number and QR code — this is an issued ticket, not a checkout page", or "Blank/loading page — no booking content visible yet"); otherwise an empty string.`;

  // Structured Outputs: a strict JSON Schema makes OpenAI's API layer itself
  // guarantee the response is valid JSON matching this exact shape — the
  // model literally cannot return markdown, prose, or a differently-shaped
  // object. This is what makes the failure rate approach zero, rather than
  // just parsing defensively after the fact.
  const VERIFY_SCHEMA = {
    name: 'verify_checks',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label:     { type: 'string' },
              expected:  { type: 'string' },
              status:    { type: 'string', enum: ['match', 'mismatch', 'not_found'] },
              seenValue: { type: 'string' },
            },
            required: ['label', 'expected', 'status', 'seenValue'],
            additionalProperties: false,
          },
        },
        pageType:     { type: 'string', enum: ['checkout', 'ticket', 'other'] },
        pageTypeNote: { type: 'string' },
      },
      required: ['checks', 'pageType', 'pageTypeNote'],
      additionalProperties: false,
    },
  };

  // One retry on top of Structured Outputs: covers the rare transient case
  // (network blip, empty completion) without ever surfacing it to the agent.
  const MAX_ATTEMPTS = 2;
  let result = null, lastError = null, lastRaw = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !result; attempt++) {
    let oaiRes;
    try {
      oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 300,
          response_format: { type: 'json_schema', json_schema: VERIFY_SCHEMA },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${imageBase64}`,
                    detail: 'high',
                  },
                },
              ],
            },
          ],
        }),
      });
      logStep(`openai_chat_completions_attempt${attempt}`, oaiRes.ok, `HTTP ${oaiRes.status}`);
    } catch (err) {
      logStep(`openai_chat_completions_attempt${attempt}`, false, `Exception: ${err.message}`);
      lastError = `OpenAI request failed: ${err.message}`;
      continue;
    }

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      logStep(`openai_chat_completions_body_attempt${attempt}`, false, errText.slice(0, 2000));
      lastError = `OpenAI error ${oaiRes.status}: ${errText}`;
      continue;
    }

    const oaiData = await oaiRes.json();
    const content = oaiData.choices?.[0]?.message?.content?.trim() || '';
    logStep(`extract_ai_content_attempt${attempt}`, content.length > 0, `length=${content.length}`);
    lastRaw = content;

    if (!content) {
      lastError = 'OpenAI returned an empty response';
      continue;
    }

    // Structured Outputs should already guarantee valid, schema-matching
    // JSON — this fence-stripping/array-normalizing is just a defensive
    // fallback in case a future model swap ever loses that guarantee.
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      let parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) parsed = { checks: parsed };
      result = parsed;
      logStep(`parse_ai_json_attempt${attempt}`, true, null);
    } catch (err) {
      logStep(`parse_ai_json_attempt${attempt}`, false, err.message);
      lastError = 'Could not parse AI response';
    }
  }

  if (!result) {
    return cors(JSON.stringify({ error: lastError || 'AI Verify failed', raw: lastRaw, steps }), 502);
  }

  downgradeFalseTimeMismatches(result.checks);
  downgradeFalseDateMismatches(result.checks);
  result.checks = fillMissingChecks(result.checks, expectedFields);

  // Fire-and-forget: logs one permanent usage event for the reports below
  // (booking-uniqueness, page-type tag distribution, match-rate/field-skip
  // stats, vendor/experience breakdowns, per-person breakdowns, and custom
  // date-range queries all derive from this same log). Never blocks the
  // response on this.
  // mismatchedFields covers both not_found and mismatch (kept for existing
  // full/partial-match aggregation); strictMismatchFields is only the
  // 'mismatch' subset — fields AI Verify actually read and found to
  // contradict the record, i.e. ones that will need an override, not just
  // a skip. stage:'flagged' marks this as the moment of detection, distinct
  // from stage:'confirmed' on the later /confirm-flag event for the same
  // booking — see the "Pre-Override Flags" vs "Override Confirmed" tiles.
  const mismatchedFields = (result.checks || []).filter(c => c.status !== 'match').map(c => c.label);
  const strictMismatchFields = (result.checks || []).filter(c => c.status === 'mismatch').map(c => c.label);
  ctx.waitUntil(recordVerifyEvent(env, {
    bookingId: bookingId || null,
    agentEmail: agentEmail || null,
    vendor: vendor || null,
    product: facts.product || null,
    pageType: result.pageType || null,
    totalChecks: (result.checks || []).length,
    mismatchedFields,
    stage: 'flagged',
    strictMismatchFields,
  }));

  // A genuine mismatch (not just "couldn't tell") is worth flagging the
  // moment it's caught, not only once someone gets around to confirming —
  // this is the one channel-visible trace of a mismatch for a booking that
  // never makes it to Confirm & Flag at all.
  if (strictMismatchFields.length && bookingId) {
    ctx.waitUntil(postPreOverrideFlag(env, {
      bookingId, agentEmail, vendor, product: facts.product || '',
      checks: result.checks || [],
    }));
  }

  return cors(JSON.stringify({ ...result, steps }), 200);
}

// Posted the moment AI Verify itself catches a genuine mismatch — before
// the agent has done anything about it (skip, override, or just move on).
// This is what makes "someone saw a mismatch and never confirmed anything"
// visible at all — without this, that case leaves zero trace anywhere.
// Best-effort: never throws past its own ctx.waitUntil, since a Slack
// hiccup here must never affect the AI Verify result itself. No screenshot
// attached (keeps this fast and simple) — the full picture, with the
// image, comes later if/when Confirm & Flag is actually clicked.
async function postPreOverrideFlag(env, { bookingId, agentEmail, vendor, product, checks }) {
  if (!env.SLACK_BOT_TOKEN) return;
  const allChecks = checks || [];
  const mismatches = allChecks.filter(c => c.status === 'mismatch');
  if (!mismatches.length) return;
  const matched = allChecks.filter(c => c.status === 'match');
  const notFound = allChecks.filter(c => c.status === 'not_found');

  // One bullet per field, on its own line — same shape the Confirm & Flag
  // alert below uses, so the two messages read consistently.
  const bulletBlock = (header, items, formatFn) =>
    items.length ? `${header}\n${items.map(c => `• ${formatFn(c)}`).join('\n')}` : null;

  const text = [
    ':triangular_flag_on_post: *Mismatch Flagged — Awaiting Review*',
    `*Booking ID:* ${bookingId || 'n/a'} · *Flagged by:* ${agentEmail || 'unknown'}`,
    (vendor || product) ? `*Vendor:* ${vendor || 'n/a'} · *Experience:* ${product || 'n/a'}` : null,
    // Shows the mismatches in context — out of how many fields were actually
    // checked, not just the bad news in isolation.
    `*Fields checked:* ${allChecks.length} · *Matched:* ${matched.length} · *Mismatched:* ${mismatches.length}${notFound.length ? ` · *Not found:* ${notFound.length}` : ''}`,
    '',
    bulletBlock('*Mismatched fields:*', mismatches, c => `${c.label} — expected ${c.expected || 'n/a'}, shows ${c.seenValue || 'n/a'}`),
    bulletBlock('*Matched:*', matched, c => `${c.label}: ${c.expected || 'n/a'}`),
    bulletBlock('*Not found:*', notFound, c => `${c.label}: expected ${c.expected || 'n/a'}`),
  ].filter(v => v !== null).join('\n');

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text }),
    });
    await res.json();
  } catch (_) {
    // Best-effort only — see comment above.
  }
}

// ── Usage tracking + report ──────────────────────────────────────────────────
// One permanent, append-only event log — every successful /verify call that
// carries a bookingId and/or agentEmail writes one entry (never overwritten,
// no TTL), so any report (all-time, last-24h, or an arbitrary custom range)
// is just a filter + aggregation over the same data, computed at read time.
// Cheap at this team's scale (a few dozen entries a day at most).
const VERIFY_LOG_PREFIX = 'verifylog:';

async function recordVerifyEvent(env, {
  bookingId, agentEmail, vendor, product, pageType, totalChecks, mismatchedFields,
  stage, strictMismatchFields, key, at,
}) {
  if (!env.CONFIG) return;
  if (!bookingId && !agentEmail) return; // nothing worth logging
  // KV metadata is capped at 1024 bytes — keep this to short scalars/labels,
  // never raw screenshot data or full AI output.
  // `key`/`at` are only ever passed by the Slack backfill (see below), so a
  // re-run overwrites the same entry instead of double-counting it — normal
  // /verify and /confirm-flag calls always get a fresh random key and "now".
  // `stage` distinguishes the moment of detection ('flagged', from /verify)
  // from the moment of resolution ('confirmed', from /confirm-flag) for the
  // same booking; `strictMismatchFields` is the subset of mismatchedFields
  // that are genuine contradictions (status 'mismatch') rather than merely
  // not_found — see the Pre-Override Flags / Override Confirmed tiles.
  await env.CONFIG.put(key || `${VERIFY_LOG_PREFIX}${crypto.randomUUID()}`, '1', {
    metadata: {
      bookingId: bookingId || null,
      email: agentEmail || null,
      vendor: vendor || null,
      product: product || null,
      pageType: pageType || null, // 'checkout' | 'ticket' | 'other' | null (unknown/older event)
      totalChecks: totalChecks || 0,
      mismatchedFields: mismatchedFields && mismatchedFields.length ? mismatchedFields : undefined,
      stage: stage || null, // 'flagged' | 'confirmed' | null (unknown/older event)
      strictMismatchFields: strictMismatchFields && strictMismatchFields.length ? strictMismatchFields : undefined,
      at: at || new Date().toISOString(),
    },
  });
}

// Cloudflare KV lists at most 1000 keys per call — page through with the
// cursor. `start`/`end` accept anything Date can parse (or null/undefined
// for an open end) and are inclusive.
async function listVerifyEvents(env, { start, end } = {}) {
  const startMs = start ? new Date(start).getTime() : -Infinity;
  const endMs = end ? new Date(end).getTime() : Infinity;
  const events = [];
  let cursor;
  do {
    const page = await env.CONFIG.list({ prefix: VERIFY_LOG_PREFIX, cursor });
    for (const k of page.keys) {
      const m = k.metadata;
      const atMs = m?.at ? Date.parse(m.at) : NaN;
      if (Number.isNaN(atMs) || atMs < startMs || atMs > endMs) continue;
      events.push(m);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return events;
}

// Aggregates a list of log entries into every shape the reports need —
// shared by the totals report, the per-person report, and the custom-range
// endpoint, so "unique booking" / "per person" always mean the same thing.
function summarizeEvents(events) {
  const bookingIds = new Set();
  const pageTypeBookingIds = { checkout: new Set(), ticket: new Set(), other: new Set() };
  const perPersonChecks = new Map();
  const perPersonBookings = new Map();     // email -> Set(bookingId)
  const perVendorBookings = new Map();     // vendor -> Set(bookingId)
  const perProductBookings = new Map();    // "vendor|product" -> Set(bookingId), plus a display label
  const productLabels = new Map();
  const fieldMismatchCounts = new Map();   // field label -> count of times it was mismatched
  // Pre-Override Flags: bookings where a genuine mismatch was caught at
  // detection time (stage:'flagged', from /verify) — regardless of whether
  // anyone ever did anything about it. Override Confirmed: bookings where
  // an agent actually resolved a mismatch via Override and confirmed
  // (stage:'confirmed', from /confirm-flag). Same booking ID can appear in
  // both, or only in the first (flagged, never confirmed) — that gap is
  // exactly what these two separate counts are for.
  const preOverrideFlagIds = new Set();
  const overrideConfirmedIds = new Set();
  let fullMatchChecks = 0, partialMatchChecks = 0, checksWithData = 0;

  for (const e of events) {
    if (e.bookingId) {
      bookingIds.add(e.bookingId);
      const bucket = pageTypeBookingIds[e.pageType];
      if (bucket) bucket.add(e.bookingId);

      if ((e.strictMismatchFields || []).length) {
        if (e.stage === 'flagged') preOverrideFlagIds.add(e.bookingId);
        else if (e.stage === 'confirmed') overrideConfirmedIds.add(e.bookingId);
      }

      if (e.vendor) {
        if (!perVendorBookings.has(e.vendor)) perVendorBookings.set(e.vendor, new Set());
        perVendorBookings.get(e.vendor).add(e.bookingId);
      }
      if (e.product) {
        const key = `${e.vendor || '—'}|${e.product}`;
        if (!perProductBookings.has(key)) perProductBookings.set(key, new Set());
        perProductBookings.get(key).add(e.bookingId);
        productLabels.set(key, { vendor: e.vendor || null, product: e.product });
      }
    }

    if (e.email) {
      perPersonChecks.set(e.email, (perPersonChecks.get(e.email) || 0) + 1);
      if (e.bookingId) {
        if (!perPersonBookings.has(e.email)) perPersonBookings.set(e.email, new Set());
        perPersonBookings.get(e.email).add(e.bookingId);
      }
    }

    if (e.totalChecks) {
      checksWithData++;
      const mismatches = e.mismatchedFields || [];
      if (mismatches.length === 0) fullMatchChecks++;
      else partialMatchChecks++;
      for (const label of mismatches) {
        fieldMismatchCounts.set(label, (fieldMismatchCounts.get(label) || 0) + 1);
      }
    }
  }

  const toSortedCounts = map => [...map.entries()]
    .map(([key, set]) => [key, set.size])
    .sort((a, b) => b[1] - a[1]);

  return {
    uniqueBookingCount: bookingIds.size,
    ticketBookingIds: [...pageTypeBookingIds.ticket],
    ticketBookingCount: pageTypeBookingIds.ticket.size,
    otherPageBookingIds: [...pageTypeBookingIds.other],
    otherPageBookingCount: pageTypeBookingIds.other.size,
    checkoutBookingCount: pageTypeBookingIds.checkout.size,

    preOverrideFlagCount: preOverrideFlagIds.size,
    preOverrideFlagBookingIds: [...preOverrideFlagIds],
    overrideConfirmedCount: overrideConfirmedIds.size,
    overrideConfirmedBookingIds: [...overrideConfirmedIds],

    checksWithData,
    fullMatchChecks,
    partialMatchChecks,
    fieldMismatchCounts: [...fieldMismatchCounts.entries()].sort((a, b) => b[1] - a[1]),

    perPersonCheckCounts: [...perPersonChecks.entries()].sort((a, b) => b[1] - a[1]),
    perPersonUniqueBookings: toSortedCounts(perPersonBookings),
    perVendorUniqueBookings: toSortedCounts(perVendorBookings),
    perProductUniqueBookings: [...perProductBookings.entries()]
      .map(([key, set]) => ({ ...productLabels.get(key), uniqueBookingCount: set.size }))
      .sort((a, b) => b.uniqueBookingCount - a.uniqueBookingCount),
  };
}

// ── Reading the Confirm & Flag channel back — for a one-time historical
// backfill (events from before this Worker version started logging
// /confirm-flag) and for an ongoing audit that catches future silent
// under-counting by comparing "what Slack shows" against "what the KV log
// has". Needs the bot token to carry the channels:history (or groups:history
// for a private channel) scope in addition to chat:write/files:write — if
// it doesn't, Slack returns { ok:false, error:"missing_scope" } and that
// error is surfaced as-is in the response so it's obvious what to fix.
//
// Parses only the exact text handleConfirmFlag() itself generates — a
// change to that message format must be mirrored here.
// Slack auto-linkifies anything email-shaped in posted mrkdwn text into
// `<mailto:x@y.com|x@y.com>` — that's what actually comes back in the
// message's `text` field from conversations.history, not the plain address
// we originally sent. Every value pulled out of a message has to go through
// this before use, or "Confirmed by" ends up with the raw Slack link markup.
function stripSlackLink(s) {
  if (!s) return s;
  const m = s.match(/^<(?:mailto:)?([^|>]+)(?:\|[^>]*)?>$/);
  return m ? m[1] : s;
}

function parseConfirmFlagMessage(text, ts) {
  if (!text) return null;
  const isPreOverrideFlag = text.includes('Mismatch Flagged — Awaiting Review');
  const retroactive = text.includes('Booking Confirmed — Late');
  const isConfirm = retroactive || text.includes('Booking Verification Confirmed');
  if (!isPreOverrideFlag && !isConfirm) return null; // not one of ours

  const bookingId = stripSlackLink(text.match(/\*Booking ID:\*\s*(\S+)/)?.[1]);
  // Pre-override flag messages say "Flagged by"; confirm messages say
  // "Confirmed by" — same person, different verb for the different moment.
  const agentEmail = stripSlackLink(text.match(/\*(?:Confirmed|Flagged) by:\*\s*(\S+)/)?.[1]);
  if (!bookingId && !agentEmail) return null;

  const tourId = stripSlackLink(text.match(/\*Tour ID:\*\s*(\S+)/)?.[1]);
  const vendorId = stripSlackLink(text.match(/\*Vendor ID:\*\s*(\S+)/)?.[1]);
  // Non-greedy + lookahead stop: this line may continue with "  |  *Tour
  // ID:* ..." right after the experience name, which a plain (.+) would
  // swallow into the captured product name.
  // Accepts either separator: "·" is current, "|" is what messages posted
  // earlier the same day this feature shipped used.
  const vendorProductLine = text.match(/\*Vendor:\*\s*(.+?)\s*(?:·|\|)\s*\*Experience:\*\s*(.+?)(?=\s*\|\s*\*Tour ID:\*|\n|$)/);
  const vendor = vendorProductLine?.[1]?.trim();
  const product = vendorProductLine?.[2]?.trim();

  // Current format puts each entry on its own "• " bullet line under a bold
  // header; messages posted before that change have the same entries
  // pipe-joined directly after the header on one line. This normalizes
  // either shape back to a single pipe-joined string so the parsing below
  // doesn't care which one it got. Anchored to the START of a line (not a
  // bare substring search) — the pre-override flag alert also mentions
  // "*Matched:*"/"*Not found:*" inline in its summary counts line, which a
  // plain indexOf would match instead of the real section header below it.
  const lines = text.split('\n');
  const extractFieldBlock = headerText => {
    const idx = lines.findIndex(l => l.trim().startsWith(headerText));
    if (idx === -1) return null;
    const sameLineRest = lines[idx].trim().slice(headerText.length).trim();
    if (sameLineRest) return sameLineRest; // old single-line format
    const bullets = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('•')) break;
      bullets.push(t.replace(/^•\s*/, ''));
    }
    return bullets.length ? bullets.join('  |  ') : null;
  };

  const parseFieldList = raw => (raw || '').split('  |  ').filter(Boolean).map(part => {
    const m = part.match(/^(.+?):\s*(.*)$/);
    return m ? { label: m[1].trim(), value: m[2].trim() } : { label: part.trim(), value: '' };
  });

  if (isPreOverrideFlag) {
    // No pageType, no Overridden section here — just what AI Verify saw at
    // detection time, before anyone has acted on it: the mismatches ("label
    // — expected X, shows Y", same shape the confirm message's override line
    // uses, just no reason yet), plus what already matched and what wasn't
    // found, so this alert reads as the full picture, not just the bad news.
    const mismatchRaw = extractFieldBlock('*Mismatched fields:*');
    const strictMismatchFields = (mismatchRaw || '').split('  |  ').filter(Boolean)
      .map(part => part.split(' — ')[0].trim());
    const matched = parseFieldList(extractFieldBlock('*Matched:*'));
    const notFound = parseFieldList(extractFieldBlock('*Not found:*'));
    return {
      bookingId: bookingId === 'n/a' ? null : bookingId || null,
      agentEmail: agentEmail === 'unknown' ? null : agentEmail || null,
      tourId: null,
      vendorId: null,
      vendor: vendor === 'n/a' ? null : vendor || null,
      product: product === 'n/a' ? null : product || null,
      pageType: null,
      totalChecks: strictMismatchFields.length + matched.length + notFound.length,
      mismatchedFields: strictMismatchFields.concat(notFound.map(n => n.label)),
      strictMismatchFields,
      stage: 'flagged',
      retroactive: false,
      at: new Date(parseFloat(ts) * 1000).toISOString(),
      ts,
    };
  }

  // Mirrors handleConfirmFlag()'s label choices exactly. "Final ticket" is
  // the expected Late Confirm outcome, not an AI classification — it's
  // deliberately left out of pageType here too, same as recordVerifyEvent()
  // never sets pageType for a Late Confirm. Only an actual AI Verify
  // classification (Checkout page / an Incorrect flag line) sets pageType,
  // so ticketBookingCount / checkoutBookingCount keep meaning "what AI Verify
  // saw", not "was this ever a ticket".
  const pageTypeLineRaw = text.match(/\*Page type:\*\s*(.+)/)?.[1];
  let pageType = null;
  if (pageTypeLineRaw) {
    // Order matters, and matches on distinctive substrings only — both
    // "Incorrect flag" messages mention "checkout page" (the other one's
    // says "not a checkout page or a ticket" for clarity), so a bare
    // "checkout page" test can't tell them apart.
    if (/Incorrect flag.*ticket captured/i.test(pageTypeLineRaw)) pageType = 'ticket';
    else if (/Incorrect flag.*other/i.test(pageTypeLineRaw)) pageType = 'other';
    else if (/Checkout page/i.test(pageTypeLineRaw)) pageType = 'checkout';
  }

  const matchedRaw = extractFieldBlock('*Matched:*');
  // "Skipped (not found)" is the current label; older messages posted before
  // this wording change say "Skipped (mismatch acknowledged)" — try both so
  // historical channel history (backfill, audit) still parses correctly.
  const skippedRaw = extractFieldBlock('*Skipped (not found):*') || extractFieldBlock('*Skipped (mismatch acknowledged):*');
  const confirmed = parseFieldList(matchedRaw);
  const skipped = parseFieldList(skippedRaw);

  // "label — expected X, shows Y (reason)" per entry — only the label
  // matters for mismatchedFields aggregation, so that's all this pulls out;
  // the fuller detail stays in the Slack message itself.
  const overriddenRaw = extractFieldBlock('*:rotating_light: Confirmed despite mismatch:*');
  const overriddenLabels = (overriddenRaw || '').split('  |  ').filter(Boolean)
    .map(part => part.split(' — ')[0].trim());

  return {
    bookingId: bookingId === 'n/a' ? null : bookingId || null,
    agentEmail: agentEmail === 'unknown' ? null : agentEmail || null,
    tourId: tourId === 'n/a' ? null : tourId || null,
    vendorId: vendorId === 'n/a' ? null : vendorId || null,
    vendor: vendor === 'n/a' ? null : vendor || null,
    product: product === 'n/a' ? null : product || null,
    pageType: pageType || null,
    totalChecks: confirmed.length + skipped.length + overriddenLabels.length,
    mismatchedFields: skipped.map(s => s.label).concat(overriddenLabels),
    strictMismatchFields: overriddenLabels,
    stage: 'confirmed',
    retroactive,
    at: new Date(parseFloat(ts) * 1000).toISOString(),
    ts,
  };
}

// Pages through conversations.history for the main confirm-flag channel
// between sinceMs/untilMs (both epoch ms), parsing every message that looks
// like one of our own Confirm & Flag posts. Slack's `oldest`/`latest` are
// seconds-based and exclusive/inclusive respectively — see Slack's docs;
// treated as approximate here since we re-filter by parsed `at` anyway.
async function fetchConfirmFlagSlackMessages(env, sinceMs, untilMs) {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN secret not set');
  const parsed = [];
  let cursor;
  do {
    const params = new URLSearchParams({
      channel: SLACK_CHANNEL_ID,
      oldest: String(sinceMs / 1000),
      latest: String(untilMs / 1000),
      inclusive: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack conversations.history failed: ${data.error}`);
    for (const msg of data.messages || []) {
      const p = parseConfirmFlagMessage(msg.text, msg.ts);
      if (p) parsed.push(p);
    }
    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
  } while (cursor);
  return parsed;
}

// One-time (or re-run-safe) historical backfill — writes a verifylog: entry
// for every parsed Confirm & Flag message in range that doesn't already have
// one, keyed deterministically off the Slack message's own timestamp so
// running this twice for an overlapping range never double-counts.
async function backfillFromSlack(env, { since, until }) {
  const sinceMs = since ? new Date(since).getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const untilMs = until ? new Date(until).getTime() : Date.now();
  const messages = await fetchConfirmFlagSlackMessages(env, sinceMs, untilMs);

  let backfilled = 0, skippedUnparseable = 0;
  for (const m of messages) {
    if (!m.bookingId && !m.agentEmail) { skippedUnparseable++; continue; }
    await recordVerifyEvent(env, {
      bookingId: m.bookingId,
      agentEmail: m.agentEmail,
      vendor: null,
      product: null,
      pageType: null,
      totalChecks: m.totalChecks,
      mismatchedFields: m.mismatchedFields,
      stage: m.stage,
      strictMismatchFields: m.strictMismatchFields,
      key: `${VERIFY_LOG_PREFIX}slackbackfill:${m.ts}`,
      at: m.at,
    });
    backfilled++;
  }
  return { scanned: messages.length, backfilled, skippedUnparseable };
}

// Posts `text` to the passcode/admin channel (DAILY_CODE_CHANNEL_ID) always,
// and additionally to the main confirm-flag channel (SLACK_CHANNEL_ID) when
// `alsoMainChannel` is true — shared by both usage reports so "which
// channel(s)" is answered in exactly one place.
async function postReportToSlack(env, text, alsoMainChannel, logStep) {
  const channels = [DAILY_CODE_CHANNEL_ID];
  if (alsoMainChannel) channels.push(SLACK_CHANNEL_ID);

  let allOk = true, lastError = null;
  for (const channel of channels) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text }),
      });
      const data = await res.json();
      logStep(`slack_chat_postMessage_${channel}`, data.ok === true, `HTTP ${res.status} — ${JSON.stringify(data).slice(0, 500)}`);
      if (!data.ok) { allOk = false; lastError = data.error; }
    } catch (err) {
      logStep(`slack_chat_postMessage_${channel}`, false, `Exception: ${err.message}`);
      allOk = false; lastError = err.message;
    }
  }
  return { ok: allOk, error: lastError };
}

// Posted automatically once a day via the cron `scheduled` handler below,
// alongside the instructions code — also wired to the admin page's "Send
// usage report now" button for an on-demand check any time. Covers overall
// totals, match-rate, and vendor/experience breakdowns; per-person activity
// is a separate report (see below). Posts to the passcode channel by
// default (see postReportToSlack); pass alsoMainChannel:true to also post
// to the main confirm-flag channel.
async function sendUsageReportToSlack(env, alsoMainChannel = false) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  if (!env.SLACK_BOT_TOKEN || !env.CONFIG) {
    logStep('check_config', false, 'SLACK_BOT_TOKEN secret or CONFIG KV binding missing');
    return { ok: false, error: 'Worker misconfigured', steps };
  }

  const s = summarizeEvents(await listVerifyEvents(env));
  const MAX_LISTED = 30;
  const MAX_ROWS = 15;

  const ticketList = s.ticketBookingIds.length
    ? '\n' + s.ticketBookingIds.slice(0, MAX_LISTED).join(', ') + (s.ticketBookingIds.length > MAX_LISTED ? ` … +${s.ticketBookingIds.length - MAX_LISTED} more` : '')
    : '';
  const otherList = s.otherPageBookingIds.length
    ? '\n' + s.otherPageBookingIds.slice(0, MAX_LISTED).join(', ') + (s.otherPageBookingIds.length > MAX_LISTED ? ` … +${s.otherPageBookingIds.length - MAX_LISTED} more` : '')
    : '';

  const fieldLines = s.fieldMismatchCounts.length
    ? s.fieldMismatchCounts.slice(0, MAX_ROWS).map(([label, count]) => `• ${label}: *${count}*`).join('\n')
    : '_No mismatches recorded._';
  const vendorLines = s.perVendorUniqueBookings.length
    ? s.perVendorUniqueBookings.slice(0, MAX_ROWS).map(([vendor, count]) => `• ${vendor}: *${count}*`).join('\n')
    : '_No vendor data recorded yet._';
  const productLines = s.perProductUniqueBookings.length
    ? s.perProductUniqueBookings.slice(0, MAX_ROWS).map(p => `• ${p.product} (${p.vendor || 'unknown vendor'}): *${p.uniqueBookingCount}*`).join('\n')
    : '_No experience data recorded yet._';

  const text = `:bar_chart: *Booking Assistant — usage report*\n\n` +
    `*Overall*\n` +
    `Unique bookings AI-verified (all-time): *${s.uniqueBookingCount}*\n` +
    `Checkout page (expected, good): *${s.checkoutBookingCount}*\n` +
    `:rotating_light: Ticket shown instead of checkout: *${s.ticketBookingCount}*${ticketList}\n` +
    `:grey_question: Neither checkout nor ticket ("other" — blank/error/unrelated page): *${s.otherPageBookingCount}*${otherList}\n\n` +
    `*Match rate* (of ${s.checksWithData} check(s) with field data)\n` +
    `Full match (all fields found): *${s.fullMatchChecks}*\n` +
    `Partial match (at least one field missing): *${s.partialMatchChecks}*\n\n` +
    `*Most-mismatched fields:*\n${fieldLines}\n\n` +
    `*Top vendors — unique bookings verified:*\n${vendorLines}\n\n` +
    `*Top experiences — unique bookings verified:*\n${productLines}`;

  const posted = await postReportToSlack(env, text, alsoMainChannel, logStep);
  return {
    ok: posted.ok, error: posted.error,
    usedCount: s.uniqueBookingCount, ticketCount: s.ticketBookingCount, otherCount: s.otherPageBookingCount,
    fullMatchChecks: s.fullMatchChecks, partialMatchChecks: s.partialMatchChecks, steps,
  };
}

// Posted automatically once a day alongside the report above — also wired
// to its own admin page button ("Send per-person report now") since it's a
// distinct question (who's using it) from the totals report (how much has
// been used overall). Lists every person who has EVER logged an event (the
// "roster"), not just those active in the last 24h, so someone at 0 today
// still shows up rather than silently disappearing from the list. Posts to
// the passcode channel by default; pass alsoMainChannel:true to also post
// to the main confirm-flag channel.
async function sendAgentUsageReportToSlack(env, alsoMainChannel = false) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  if (!env.SLACK_BOT_TOKEN || !env.CONFIG) {
    logStep('check_config', false, 'SLACK_BOT_TOKEN secret or CONFIG KV binding missing');
    return { ok: false, error: 'Worker misconfigured', steps };
  }

  const allEvents = await listVerifyEvents(env);
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const last24hEvents = allEvents.filter(e => e.at >= cutoffIso);

  const allTime = summarizeEvents(allEvents);
  const last24h = summarizeEvents(last24hEvents);

  const roster = new Set(allEvents.map(e => e.email).filter(Boolean));
  const last24hCountByEmail = new Map(last24h.perPersonCheckCounts);
  const last24hFull = [...roster]
    .map(email => [email, last24hCountByEmail.get(email) || 0])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const last24hLines = last24hFull.length
    ? last24hFull.map(([email, count]) => `• ${email}: *${count}*`).join('\n')
    : '_No one has used AI Verify yet._';
  const allTimeLines = allTime.perPersonUniqueBookings.length
    ? allTime.perPersonUniqueBookings.map(([email, count]) => `• ${email}: *${count}*`).join('\n')
    : '_No AI Verify activity yet._';

  const text = `:bar_chart: *Booking Assistant — per-person usage report*\n\n` +
    `*Checks run — last 24 hours (everyone, including 0):*\n${last24hLines}\n\n` +
    `*Unique bookings actioned — all-time:*\n${allTimeLines}`;

  const posted = await postReportToSlack(env, text, alsoMainChannel, logStep);
  return {
    ok: posted.ok, error: posted.error,
    last24hUsage: last24hFull, allTimeUsage: allTime.perPersonUniqueBookings, steps,
  };
}

async function handleAdminSendUsageReport(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const alsoMainChannel = url.searchParams.get('alsoMainChannel') === 'true';
  const result = await sendUsageReportToSlack(env, alsoMainChannel);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

async function handleAdminSendAgentReport(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const alsoMainChannel = url.searchParams.get('alsoMainChannel') === 'true';
  const result = await sendAgentUsageReportToSlack(env, alsoMainChannel);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

// On-demand only — doesn't post to Slack, just returns the numbers so the
// admin page can render them inline for whatever window was asked for.
async function handleAdminUsageReportRange(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  if (!env.CONFIG) {
    return cors(JSON.stringify({ error: 'No CONFIG KV namespace bound' }), 500);
  }
  const start = url.searchParams.get('start') || null;
  const end = url.searchParams.get('end') || null;
  const filter = url.searchParams.get('filter') || 'all'; // 'all' | 'mismatch' | 'fullmatch'
  let events = await listVerifyEvents(env, { start, end });
  if (filter === 'mismatch') {
    events = events.filter(e => (e.mismatchedFields || []).length > 0);
  } else if (filter === 'fullmatch') {
    events = events.filter(e => e.totalChecks > 0 && (e.mismatchedFields || []).length === 0);
  }
  const summary = summarizeEvents(events);

  // Same shape as /admin/channel-report's `bookings`, so the admin page can
  // render either source with one set of functions.
  const sorted = [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const bookings = sorted.slice(0, USAGE_BOOKINGS_MAX_ROWS).map(e => ({
    bookingId: e.bookingId,
    stage: e.stage || null,
    agentEmail: e.email,
    at: e.at,
    tourId: null,
    vendorId: null,
    vendor: e.vendor,
    product: e.product,
    pageType: e.pageType,
    mismatchedFields: e.mismatchedFields || [],
    retroactive: null,
  }));

  return cors(JSON.stringify({
    ok: true,
    source: 'dashboard',
    start, end, filter,
    totalEvents: events.length,
    ...summary,
    bookings,
    bookingsTruncated: sorted.length > USAGE_BOOKINGS_MAX_ROWS,
  }), 200);
}

// One-time (safely re-runnable) historical import — reads the Confirm & Flag
// channel directly and writes any missing verifylog: entries for the given
// range. Meant for backfilling activity that happened before this Worker
// version started logging /confirm-flag calls; not needed going forward.
async function handleAdminBackfillFromSlack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  if (body.password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  if (!env.CONFIG) {
    return cors(JSON.stringify({ error: 'No CONFIG KV namespace bound' }), 500);
  }
  try {
    const result = await backfillFromSlack(env, { since: body.since, until: body.until });
    return cors(JSON.stringify({ ok: true, ...result }), 200);
  } catch (err) {
    return cors(JSON.stringify({ error: err.message }), 502);
  }
}

// Ongoing cross-check, not a one-time thing — compares what the Confirm &
// Flag channel actually shows against what the KV log has for the same
// window, so a future silent under-counting bug (a bad deploy, a dropped
// waitUntil, a schema change) shows up as a gap here instead of going
// unnoticed. On-demand only (costs a Slack API call), never automatic.
async function handleAdminChannelAudit(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  if (!env.CONFIG) {
    return cors(JSON.stringify({ error: 'No CONFIG KV namespace bound' }), 500);
  }
  const start = url.searchParams.get('start') || null;
  const end = url.searchParams.get('end') || null;
  const startMs = start ? new Date(start).getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const endMs = end ? new Date(end).getTime() : Date.now();

  try {
    const [channelMessages, dashboardEvents] = await Promise.all([
      fetchConfirmFlagSlackMessages(env, startMs, endMs),
      listVerifyEvents(env, { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }),
    ]);
    const channelBookingIds = new Set(channelMessages.filter(m => m.bookingId).map(m => m.bookingId));
    const dashboardSummary = summarizeEvents(dashboardEvents);
    return cors(JSON.stringify({
      ok: true,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      channelMessageCount: channelMessages.length,
      channelUniqueBookingCount: channelBookingIds.size,
      dashboardEventCount: dashboardEvents.length,
      dashboardUniqueBookingCount: dashboardSummary.uniqueBookingCount,
    }), 200);
  } catch (err) {
    return cors(JSON.stringify({ error: err.message }), 502);
  }
}

// Shared row cap for the `bookings` list both /admin/channel-report and
// /admin/usage-report-range return — same shape either way, so the admin
// page renders whichever source is selected with one set of functions.
const USAGE_BOOKINGS_MAX_ROWS = 500;

// The channel is the primary, ground-truth source for usage reporting — this
// is the main channel-based report: any date range, an optional filter, the
// actual list of flagged booking IDs (not just a count), and a per-person
// breakdown, all read straight from the Confirm & Flag channel. Returns the
// exact same summarizeEvents() shape as /admin/usage-report-range (the KV
// log), plus `bookings`/`source`/`filter`, so the admin page's Channel/
// Dashboard toggle can point at either endpoint and render identically.

async function handleAdminChannelReport(request, env, url) {
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword(env)) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const nowMs = Date.now();
  const startParam = url.searchParams.get('start');
  const endParam = url.searchParams.get('end');
  const startMs = startParam ? new Date(startParam).getTime() : nowMs - 24 * 60 * 60 * 1000;
  const endMs = endParam ? new Date(endParam).getTime() : nowMs;
  const filter = url.searchParams.get('filter') || 'all'; // 'all' | 'mismatch' | 'fullmatch'

  try {
    let messages = await fetchConfirmFlagSlackMessages(env, startMs, endMs);
    if (filter === 'mismatch') {
      messages = messages.filter(m => m.mismatchedFields.length > 0);
    } else if (filter === 'fullmatch') {
      messages = messages.filter(m => m.totalChecks > 0 && m.mismatchedFields.length === 0);
    }

    // Same aggregation the KV-log dashboard uses — map each parsed message
    // into the shape summarizeEvents() already expects, so "unique booking",
    // "per person", vendor/experience breakdowns, and match-rate all mean
    // exactly the same thing whether the source is the channel or the log.
    // This includes both stages (Pre-Override Flag and Override Confirmed)
    // — a booking that generated both still counts once in uniqueBookingCount
    // (Set-deduped by bookingId), and the two stages get their own counts.
    const summary = summarizeEvents(messages.map(m => ({
      bookingId: m.bookingId, email: m.agentEmail, vendor: m.vendor, product: m.product,
      pageType: m.pageType, totalChecks: m.totalChecks, mismatchedFields: m.mismatchedFields,
      stage: m.stage, strictMismatchFields: m.strictMismatchFields,
    })));

    const sorted = [...messages].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    const bookings = sorted.slice(0, USAGE_BOOKINGS_MAX_ROWS).map(m => ({
      bookingId: m.bookingId,
      stage: m.stage || null,
      agentEmail: m.agentEmail,
      at: m.at,
      tourId: m.tourId,
      vendorId: m.vendorId,
      vendor: m.vendor,
      product: m.product,
      pageType: m.pageType,
      mismatchedFields: m.mismatchedFields,
      retroactive: m.retroactive,
    }));

    return cors(JSON.stringify({
      ok: true,
      source: 'channel',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      filter,
      totalEvents: messages.length,
      ...summary,
      bookings,
      bookingsTruncated: sorted.length > USAGE_BOOKINGS_MAX_ROWS,
    }), 200);
  } catch (err) {
    return cors(JSON.stringify({ error: err.message }), 502);
  }
}

// ── /confirm-flag — post to Slack (message + screenshot, unified) ─────────────

async function handleConfirmFlag(request, env, ctx) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  let body;
  try {
    body = await request.json();
    logStep('parse_request_body', true, null);
  } catch (err) {
    logStep('parse_request_body', false, err.message);
    return cors(JSON.stringify({ error: 'Invalid JSON body', steps }), 400);
  }

  const {
    bookingId, agentEmail, confirmed = [], skipped = [], overridden = [], retroactive = false,
    imageBase64, mimeType = 'image/png', verifiedAt, vendor, product, vendorId, tourId, pageType,
  } = body;

  // This is the real, common usage signal — every Confirm & Flag click,
  // whether or not AI Verify ran on this booking — so it counts toward
  // "unique bookings actioned" the same way an AI Verify check does.
  // mismatchedFields covers both skipped (not found) and overridden (a
  // genuine contradiction, confirmed anyway) — summarizeEvents() treats
  // both the same way for match-rate/most-mismatched purposes; only the
  // Slack alert text below distinguishes the two by severity.
  // pageType is only ever set when AI Verify actually ran first (never for
  // Late Confirm) — passed through as-is, null otherwise.
  if (ctx) {
    ctx.waitUntil(recordVerifyEvent(env, {
      bookingId: bookingId || null,
      agentEmail: agentEmail || null,
      vendor: vendor || null,
      product: product || null,
      pageType: pageType || null,
      totalChecks: confirmed.length + skipped.length + overridden.length,
      mismatchedFields: skipped.map(s => s.label).concat(overridden.map(o => o.label)),
      stage: 'confirmed',
      strictMismatchFields: overridden.map(o => o.label),
    }));
  }

  if (!env.SLACK_BOT_TOKEN) {
    logStep('check_slack_token', false, 'SLACK_BOT_TOKEN secret not set');
    return cors(JSON.stringify({
      error: 'Worker misconfigured — run: wrangler secret put SLACK_BOT_TOKEN (or add it as a Secret in the dashboard Settings)',
      steps,
    }), 500);
  }
  logStep('check_slack_token', true, null);

  // The two expected, healthy outcomes are "Final ticket" (Late Confirm —
  // booking was already ticketed, no checkout page to capture) and
  // "Checkout page" (normal flow, AI Verify saw the expected page). Anything
  // else AI Verify actually classified — a ticket or an unrelated/blank page
  // captured during the NORMAL flow, when a checkout page was expected — is
  // the rare, wrong case and gets called out inline so it isn't missed.
  let pageTypeLine = null;
  if (retroactive) {
    pageTypeLine = '*Page type:* Final ticket';
  } else if (pageType === 'checkout') {
    pageTypeLine = '*Page type:* Checkout page';
  } else if (pageType === 'ticket') {
    pageTypeLine = '*Page type:* :warning: Incorrect flag — ticket captured instead of a checkout page';
  } else if (pageType === 'other') {
    pageTypeLine = '*Page type:* :warning: Incorrect flag — other (not a checkout page or a ticket)';
  }

  // One bullet per field, on its own line — a pipe-joined single line reads
  // as a wall of text once there's more than one or two mismatches (this is
  // what agents actually see in the channel, so it has to stay scannable).
  const bulletBlock = (header, items, formatFn) =>
    items.length ? `${header}\n${items.map(c => `• ${formatFn(c)}`).join('\n')}` : null;

  const lines = [
    retroactive
      ? ':rotating_light: *Booking Confirmed — Late (no prior verification run)*'
      : ':white_check_mark: *Booking Verification Confirmed*',
    `*Booking ID:* ${bookingId || 'n/a'} · *Confirmed by:* ${agentEmail || 'unknown'}`,
    (vendor || product || tourId || vendorId)
      ? [
          (vendor || product) ? `*Vendor:* ${vendor || 'n/a'} · *Experience:* ${product || 'n/a'}` : null,
          (tourId || vendorId) ? `*Tour ID:* ${tourId || 'n/a'} · *Vendor ID:* ${vendorId || 'n/a'}` : null,
        ].filter(Boolean).join('  |  ')
      : null,
    pageTypeLine,
    '',
    bulletBlock('*Matched:*', confirmed, c => `${c.label}: ${c.value}`),
    bulletBlock('*Skipped (not found):*', skipped, c => `${c.label}: ${c.value}`),
    bulletBlock(
      '*:rotating_light: Confirmed despite mismatch:*',
      overridden,
      c => `${c.label} — expected ${c.expected || 'n/a'}, shows ${c.value || 'n/a'} (${c.reason || 'no reason given'})`
    ),
    retroactive ? '*Note:* Confirmed via Late Confirm — ticket was already booked, verification step was skipped at the time.' : null,
    '',
    verifiedAt ? `*At:* ${formatIST(verifiedAt)}` : null,
  ].filter(v => v !== null).join('\n');

  // If there's a screenshot, post it as ONE unified message — the text goes
  // in as the file's initial_comment, so Slack renders text + image together
  // rather than a plain message followed by a separate threaded file reply.
  // Falls back to a plain chat.postMessage if there's no image, or if the
  // upload/attach flow fails at any step (every step logs into `steps`
  // regardless, so a failure is always fully visible, never silent).
  let screenshotError = null;
  let posted = false;

  if (imageBase64) {
    try {
      const binary = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const filename = `verify-${bookingId || 'screenshot'}.${ext}`;
      logStep('prepare_binary', true, `bytes=${binary.length} filename=${filename}`);

      let uploadUrlRes, uploadUrlData;
      try {
        uploadUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ filename, length: String(binary.length) }),
        });
        uploadUrlData = await uploadUrlRes.json();
        logStep('slack_files_getUploadURLExternal', uploadUrlData.ok === true,
          `HTTP ${uploadUrlRes.status} — ${JSON.stringify(uploadUrlData).slice(0, 500)}`);
      } catch (err) {
        logStep('slack_files_getUploadURLExternal', false, `Exception: ${err.message}`);
        screenshotError = `files.getUploadURLExternal exception: ${err.message}`;
        uploadUrlData = null;
      }

      if (uploadUrlData && !uploadUrlData.ok) {
        screenshotError = `files.getUploadURLExternal failed: ${uploadUrlData.error}`;
      } else if (uploadUrlData) {
        let putRes;
        try {
          putRes = await fetch(uploadUrlData.upload_url, { method: 'POST', body: binary });
          logStep('slack_upload_put', putRes.ok, `HTTP ${putRes.status}`);
        } catch (err) {
          logStep('slack_upload_put', false, `Exception: ${err.message}`);
          screenshotError = `Upload PUT exception: ${err.message}`;
          putRes = null;
        }

        if (putRes && !putRes.ok) {
          screenshotError = `Upload PUT failed: HTTP ${putRes.status}`;
        } else if (putRes) {
          try {
            const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json; charset=utf-8',
              },
              body: JSON.stringify({
                files: [{ id: uploadUrlData.file_id, title: filename }],
                channel_id: SLACK_CHANNEL_ID,
                initial_comment: lines,
              }),
            });
            const completeData = await completeRes.json();
            logStep('slack_files_completeUploadExternal', completeData.ok === true,
              `HTTP ${completeRes.status} — ${JSON.stringify(completeData).slice(0, 800)}`);

            if (!completeData.ok) {
              screenshotError = `files.completeUploadExternal failed: ${completeData.error}`;
            } else {
              posted = true;
            }
          } catch (err) {
            logStep('slack_files_completeUploadExternal', false, `Exception: ${err.message}`);
            screenshotError = `files.completeUploadExternal exception: ${err.message}`;
          }
        }
      }
    } catch (err) {
      logStep('screenshot_flow_outer', false, `Exception: ${err.message}`);
      screenshotError = `Exception: ${err.message}`;
    }
  } else {
    logStep('screenshot_flow', true, 'no imageBase64 provided — skipping upload, plain text message only');
  }

  if (!posted) {
    try {
      const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text: lines }),
      });
      const msgData = await msgRes.json();
      logStep('slack_chat_postMessage_fallback', msgData.ok === true,
        `HTTP ${msgRes.status} — ${JSON.stringify(msgData).slice(0, 500)}`);

      if (!msgData.ok) {
        return cors(JSON.stringify({ error: `Slack chat.postMessage failed: ${msgData.error}`, steps }), 502);
      }
    } catch (err) {
      logStep('slack_chat_postMessage_fallback', false, `Exception: ${err.message}`);
      return cors(JSON.stringify({ error: `Slack chat.postMessage exception: ${err.message}`, steps }), 502);
    }
  }

  return cors(JSON.stringify({ ok: true, screenshotError, steps, version: WORKER_VERSION }), 200);
}

function cors(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function htmlResponse(body) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Admin page — served at GET / on this Worker's own domain, so its
// fetch() calls to /admin/* are same-origin (no CORS, no external API
// needed — the earlier idea of a separate hosted page couldn't do this).
// Password is kept in sessionStorage only (cleared when the tab closes),
// never localStorage — it's re-sent on every admin fetch, never persisted
// server-side.
const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Booking Assistant — Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ── Same sage/paper editorial identity as the Verify Pulse dashboard
     (/dashboard) — same tokens and fonts, restyled logic-for-logic so the
     two pages read as one product. Nothing below changes any element id,
     class, or the <script> at the bottom — styling only. ── */
  :root {
    color-scheme: light;
    --paper:       #f6f7f5;
    --surface:     #ffffff;
    --surface-2:   #eef0ea;
    --ink:         #17201c;
    --ink-2:       #43524a;
    --ink-muted:   #7c8a80;
    --line:        #dde2da;
    --border:      rgba(23,32,28,0.10);
    --accent:      #176247;
    --accent-ink:  #ffffff;
    --accent-wash: rgba(23,98,71,0.07);
    --good:        #176247;
    --good-wash:   rgba(23,98,71,0.07);
    --warn:        #93650f;
    --warn-wash:   rgba(147,101,15,0.10);
    --crit:        #a23c2e;
    --crit-wash:   rgba(162,60,46,0.08);
    --shadow:      0 1px 2px rgba(23,32,28,0.04), 0 14px 32px -12px rgba(23,32,28,0.14);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --paper:       #0f130f;
      --surface:     #171c18;
      --surface-2:   #202620;
      --ink:         #edf1ee;
      --ink-2:       #aab6ae;
      --ink-muted:   #7c8a80;
      --line:        #2b332c;
      --border:      rgba(237,241,238,0.10);
      --accent:      #5fc9a1;
      --accent-ink:  #0c1f16;
      --accent-wash: rgba(95,201,161,0.12);
      --good:        #5fc9a1;
      --good-wash:   rgba(95,201,161,0.12);
      --warn:        #e0ab4a;
      --warn-wash:   rgba(224,171,74,0.14);
      --crit:        #e2795f;
      --crit-wash:   rgba(226,121,95,0.14);
      --shadow:      0 1px 2px rgba(0,0,0,0.35), 0 16px 36px -14px rgba(0,0,0,0.55);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 64px; background: var(--paper); color: var(--ink);
    font: 14px/1.5 'Instrument Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 {
    font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400;
    font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em;
  }
  h1 em { font-style: italic; color: var(--accent); }
  .sub { color: var(--ink-muted); margin: 0 0 24px; font-size: 13px; }
  .login-wrap { max-width: 420px; margin: 40px auto 0; }
  .layout { max-width: 480px; margin: 0 auto; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
    padding: 20px 22px; margin-bottom: 16px; box-shadow: var(--shadow);
  }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-muted); margin: 0; font-weight: 600; }
  .card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; }
  .info-btn {
    background: transparent; border: 1px solid var(--border); color: var(--ink-muted);
    width: 18px; height: 18px; padding: 0; border-radius: 50%;
    font-size: 11px; font-weight: 700; line-height: 1; display: inline-flex;
    align-items: center; justify-content: center; flex-shrink: 0;
  }
  .info-btn:hover { background: var(--surface-2); color: var(--ink-2); border-color: var(--ink-muted); }
  .info-popover {
    position: fixed; max-width: 280px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 10px 12px; font-size: 12.5px; line-height: 1.55;
    color: var(--ink-2); box-shadow: var(--shadow); z-index: 50;
  }
  label { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; font-weight: 600; }
  .sub-label { font-size: 12px; color: var(--ink-muted); margin: -6px 0 10px; }
  input[type=password], input[type=text], input[type=datetime-local], textarea {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--ink); font-size: 14px; margin-bottom: 10px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 56px; }
  textarea:disabled { opacity: 0.4; cursor: not-allowed; }
  .message-block {
    border-top: 1px dashed var(--line); margin-top: 4px; padding-top: 14px;
  }
  .row { display: flex; gap: 10px; align-items: center; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin: 4px 0 14px; }
  .checkbox-row input { width: 16px; height: 16px; }
  button {
    background: var(--accent); color: var(--accent-ink); border: none; border-radius: 999px;
    padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  button:hover { opacity: .9; }
  button:disabled { background: var(--surface-2); color: var(--ink-muted); cursor: not-allowed; opacity: 1; }
  button.secondary { background: var(--surface-2); color: var(--ink); }
  button.secondary:hover { background: var(--line); opacity: 1; }
  button.tiny { padding: 4px 10px; font-size: 12px; }
  .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; font-size: 13px; }
  .status-grid div { display: flex; justify-content: space-between; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: var(--good); } .dot.bad { background: var(--crit); }
  .code-display { font: 700 22px/1 "JetBrains Mono", monospace; letter-spacing: .06em; color: var(--accent); margin: 6px 0; }
  .muted { color: var(--ink-muted); font-size: 12px; }
  .msg { font-size: 13px; margin-top: 10px; min-height: 18px; }
  .msg.err { color: var(--crit); } .msg.ok { color: var(--good); }
  .warn-banner {
    background: var(--warn-wash); border: 1px solid var(--warn); color: var(--warn);
    border-radius: 12px; padding: 10px 12px; font-size: 12px; margin-bottom: 16px;
  }
  #dashboard { display: none; max-width: 1180px; margin: 0 auto; }
  a { color: var(--accent); }

  /* ── Analytics (merged in from the former separate /dashboard page) ──── */
  .topbar {
    display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between;
    gap: 14px; padding-bottom: 16px; margin: 4px 0 20px; border-bottom: 1px solid var(--line);
  }
  .topbar h2 {
    font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400;
    font-size: 24px; letter-spacing: -0.01em; color: var(--ink); text-transform: none; margin: 0;
  }
  .topbar h2 em { font-style: italic; color: var(--accent); }
  .topbar p { margin: 3px 0 0; font-size: 12px; color: var(--ink-muted); }
  .topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .range-group { display: flex; gap: 3px; background: var(--surface-2); border-radius: 999px; padding: 3px; }
  .range-btn {
    border: none; background: transparent; color: var(--ink-2); font: inherit; font-size: 12.5px;
    font-weight: 500; padding: 6px 13px; border-radius: 999px; cursor: pointer;
  }
  .range-btn:hover { color: var(--ink); }
  .range-btn.active { background: var(--surface); color: var(--accent); font-weight: 600; box-shadow: var(--shadow); }
  .custom-range { display: none; align-items: center; gap: 6px; }
  .custom-range.open { display: flex; }
  .custom-range input {
    font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 8px; margin-bottom: 0;
    border: 1px solid var(--border); background: var(--surface); color: var(--ink); width: auto;
  }
  .status-line { font-size: 11.5px; color: var(--ink-muted); margin: -12px 0 20px; }
  .tabular { font-variant-numeric: tabular-nums; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .kpi-tile { display: flex; flex-direction: column; gap: 7px; }
  .kpi-label { font-size: 11px; color: var(--ink-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
  .kpi-value { font-family: 'Instrument Serif', Georgia, serif; font-size: 34px; font-weight: 400; letter-spacing: -0.01em; line-height: 1; color: var(--ink); }
  .kpi-sub { font-size: 12px; color: var(--ink-2); }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .three-col { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .four-col { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .status-tile { border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--border); }
  .status-tile .stlabel { font-size: 12px; font-weight: 600; display: flex; align-items: center; color: var(--ink-2); }
  .status-tile .stdot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 7px; }
  .status-tile .stvalue { font-family: 'Instrument Serif', Georgia, serif; font-size: 28px; font-weight: 400; letter-spacing: -0.01em; color: var(--ink); }
  .status-tile .stpct { font-size: 11.5px; color: var(--ink-muted); }
  .status-tile.good { background: var(--good-wash); } .status-tile.good .stdot { background: var(--good); }
  .status-tile.warn { background: var(--warn-wash); } .status-tile.warn .stdot { background: var(--warn); }
  .status-tile.crit { background: var(--crit-wash); } .status-tile.crit .stdot { background: var(--crit); }
  .rank-list { display: flex; flex-direction: column; gap: 11px; }
  .rank-row { display: grid; grid-template-columns: 128px 1fr 32px; align-items: center; gap: 10px; }
  .rank-name { font-size: 12.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank-track { position: relative; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
  .rank-fill { position: absolute; inset: 0 auto 0 0; height: 100%; border-radius: 4px; background: var(--accent); }
  .rank-fill.mismatch { background: var(--crit); }
  .rank-value { font-size: 12.5px; font-weight: 600; text-align: right; }
  .empty-note { font-size: 12.5px; color: var(--ink-muted); font-style: italic; font-family: 'Instrument Serif', Georgia, serif; padding: 10px 2px; }
  .table-wrap { overflow-x: auto; }
  .an-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .an-table th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-muted); font-weight: 600; padding: 0 10px 9px; border-bottom: 1px solid var(--line); }
  .an-table td { padding: 10px 10px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
  .an-table tr:last-child td { border-bottom: none; }
  .an-table td.num, .an-table th.num { text-align: right; }
  .rank-badge {
    display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
    border-radius: 50%; background: var(--accent-wash); color: var(--accent); font-size: 11px; font-weight: 700; margin-right: 9px;
  }
  @media (max-width: 760px) {
    .kpi-grid, .four-col { grid-template-columns: repeat(2, 1fr); }
    .two-col, .three-col { grid-template-columns: 1fr; }
    .rank-row { grid-template-columns: 96px 1fr 30px; }
  }
</style>
</head>
<body>
  <h1>Booking Assistant — <em>Admin</em></h1>
  <p class="sub">Manage what the team's extension shows, test changes live before they go out, and check configuration health. · Worker: <span id="worker-version">—</span></p>

  <div id="login-card" class="card login-wrap">
    <h2>Unlock</h2>
    <input type="password" id="password-input" placeholder="Admin password" autocomplete="off" />
    <button id="unlock-btn">Unlock</button>
    <p class="msg" id="login-msg"></p>
  </div>

  <div id="dashboard">
    <div id="kv-warning" class="warn-banner" style="display:none">
      No CONFIG KV namespace bound yet — codes can't be generated or verified. Bind one in Settings → Bindings → KV Namespace → name it <b>CONFIG</b> to fix this.
    </div>

    <!-- ── Verify Pulse — reads from the Confirm & Flag channel by default
         (the primary, ground-truth source); the Source toggle below can
         switch it to the KV usage log instead. Same rendering either way. ── -->
    <div class="topbar">
      <div>
        <h2>Verify <em>Pulse</em></h2>
        <p>AI Verify usage &amp; quality</p>
      </div>
      <div class="topbar-right">
        <div class="range-group" id="range-group">
          <button type="button" class="range-btn" data-range="1">Today</button>
          <button type="button" class="range-btn active" data-range="7">7D</button>
          <button type="button" class="range-btn" data-range="30">30D</button>
          <button type="button" class="range-btn" data-range="90">90D</button>
          <button type="button" class="range-btn" data-range="all">All-time</button>
          <button type="button" class="range-btn" data-range="custom">Custom…</button>
        </div>
        <div class="custom-range" id="custom-range">
          <input type="datetime-local" id="custom-start">
          <span style="color:var(--ink-muted);font-size:12px;">to</span>
          <input type="datetime-local" id="custom-end">
          <button type="button" class="secondary tiny" id="custom-apply-btn">Apply</button>
        </div>
        <button type="button" class="secondary tiny" id="refresh-btn">↻ Refresh</button>
      </div>
    </div>

    <div class="topbar-right" style="justify-content:flex-start; padding-bottom:14px; margin-top:-10px; gap:18px; flex-wrap:wrap;">
      <span style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:12px; color:var(--ink-muted);">Source:</span>
        <div class="range-group" id="source-group">
          <button type="button" class="range-btn active" data-source="channel">Channel</button>
          <button type="button" class="range-btn" data-source="dashboard">Dashboard</button>
        </div>
      </span>
      <span style="display:flex; align-items:center; gap:6px;">
        <span style="font-size:12px; color:var(--ink-muted);">Filter:</span>
        <div class="range-group" id="filter-group">
          <button type="button" class="range-btn active" data-filter="all">All</button>
          <button type="button" class="range-btn" data-filter="mismatch">Mismatched only</button>
          <button type="button" class="range-btn" data-filter="fullmatch">Full match only</button>
        </div>
      </span>
    </div>

    <p class="status-line" id="status-line">Loading…</p>

    <div class="kpi-grid">
      <div class="card kpi-tile">
        <span class="kpi-label">Unique Bookings Verified</span>
        <span class="kpi-value tabular" id="kpi-bookings">—</span>
        <span class="kpi-sub" id="kpi-bookings-sub">&nbsp;</span>
      </div>
      <div class="card kpi-tile">
        <span class="kpi-label">Checkout Capture Rate</span>
        <span class="kpi-value tabular" id="kpi-checkout-rate">—</span>
        <span class="kpi-sub">Screenshots that were the expected page</span>
      </div>
      <div class="card kpi-tile">
        <span class="kpi-label">Full-Match Rate</span>
        <span class="kpi-value tabular" id="kpi-match-rate">—</span>
        <span class="kpi-sub">Of checks with field data</span>
      </div>
      <div class="card kpi-tile">
        <span class="kpi-label">Busiest Vendor</span>
        <span class="kpi-value" id="kpi-top-vendor" style="font-size:22px;">—</span>
        <span class="kpi-sub" id="kpi-top-vendor-sub">&nbsp;</span>
      </div>
    </div>

    <div class="four-col">
      <div class="status-tile good">
        <span class="stlabel"><span class="stdot"></span>Checkout page</span>
        <span class="stvalue tabular" id="tile-checkout">—</span>
        <span class="stpct" id="tile-checkout-pct">expected — good</span>
      </div>
      <div class="status-tile crit">
        <span class="stlabel"><span class="stdot"></span>Ticket shown instead</span>
        <span class="stvalue tabular" id="tile-ticket">—</span>
        <span class="stpct" id="tile-ticket-pct">checked after booking — flag</span>
      </div>
      <div class="status-tile warn">
        <span class="stlabel"><span class="stdot"></span>Other / unclear</span>
        <span class="stvalue tabular" id="tile-other">—</span>
        <span class="stpct" id="tile-other-pct">not a checkout or a ticket</span>
      </div>
      <div class="status-tile crit">
        <span class="stlabel"><span class="stdot"></span>⚠️ Incorrect flags</span>
        <span class="stvalue tabular" id="tile-incorrect">—</span>
        <span class="stpct" id="tile-incorrect-pct">AI Verify caught something wrong</span>
      </div>
    </div>

    <!-- Pre-Override Flag = the moment AI Verify caught a field that genuinely
         contradicts the record, before anyone has done anything about it.
         Override Confirmed = an agent actually resolved one via Override and
         confirmed. Same booking can appear in one or both — the gap between
         the two counts is bookings flagged but never confirmed either way. -->
    <div class="two-col">
      <div class="status-tile warn">
        <span class="stlabel"><span class="stdot"></span>🚩 Pre-Override Flags</span>
        <span class="stvalue tabular" id="tile-pre-override">—</span>
        <span class="stpct" id="tile-pre-override-pct">mismatch caught at detection</span>
      </div>
      <div class="status-tile good">
        <span class="stlabel"><span class="stdot"></span>✅ Override Confirmed</span>
        <span class="stvalue tabular" id="tile-override-confirmed">—</span>
        <span class="stpct" id="tile-override-confirmed-pct">resolved and confirmed</span>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Top vendors</h2>
        <div class="rank-list" id="vendor-list"></div>
      </div>
      <div class="card">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Top experiences</h2>
        <div class="rank-list" id="product-list"></div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Match quality</h2>
        <div class="rank-list">
          <div class="rank-row">
            <span class="rank-name">Full match</span>
            <div class="rank-track"><div class="rank-fill" id="bar-full" style="background:var(--good)"></div></div>
            <span class="rank-value tabular" id="val-full">—</span>
          </div>
          <div class="rank-row">
            <span class="rank-name">Partial match</span>
            <div class="rank-track"><div class="rank-fill" id="bar-partial" style="background:var(--warn)"></div></div>
            <span class="rank-value tabular" id="val-partial">—</span>
          </div>
        </div>
      </div>
      <div class="card">
        <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Most-mismatched fields</h2>
        <div class="rank-list" id="field-list"></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Flagged booking IDs</h2>
      <div class="table-wrap" style="max-height:340px; overflow-y:auto;">
        <table class="an-table">
          <thead><tr><th>Booking ID</th><th>Stage</th><th>Agent</th><th>Mismatched fields</th><th>At</th></tr></thead>
          <tbody id="booking-table-body"></tbody>
        </table>
      </div>
      <p class="muted" id="booking-truncated-note" style="display:none; margin-top:8px;">Showing the first 500 — narrow the range or filter to see the rest.</p>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);font-weight:600;margin:0 0 14px;">Per person</h2>
      <table class="an-table">
        <thead><tr><th>Agent</th><th class="num">Checks run</th><th class="num">Unique bookings</th></tr></thead>
        <tbody id="person-table-body"></tbody>
      </table>
    </div>

    <!-- ── Admin actions (unchanged from before) ── -->
    <div class="layout">
    <div class="card">
      <div class="card-head">
        <h2>🔑 Instructions-unlock code</h2>
        <button type="button" class="info-btn" data-info="daily-code">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">One posts automatically every day. Click below any time to send another — valid 5 minutes, single-use.</p>
      <button class="secondary" id="send-slack-btn">Send to Slack now</button>
      <p class="msg" id="slack-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>⚡ One-time admin code</h2>
        <button type="button" class="info-btn" data-info="admin-code">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Replaces the old static master code — request one whenever you need admin access. Posted to the same Slack channel, valid 5 minutes, single-use.</p>
      <button id="request-code-btn">Request admin code</button>
      <p class="msg" id="request-code-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>📊 Usage report</h2>
        <button type="button" class="info-btn" data-info="usage-report">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Posts to the <b>passcode channel</b> automatically once a day — unique bookings AI-verified (all-time), and tickets flagged instead of checkout (all-time). Click below to send it right now.</p>
      <div class="checkbox-row" style="margin:0 0 12px">
        <input type="checkbox" id="usage-report-also-main">
        <label for="usage-report-also-main" style="margin:0">Also send to the main team channel</label>
      </div>
      <button class="secondary" id="send-usage-report-btn">Send usage report now</button>
      <p class="msg" id="usage-report-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🧑‍💼 Per-person report</h2>
        <button type="button" class="info-btn" data-info="agent-report">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Posts to the <b>passcode channel</b> automatically once a day — who's using it: checks run in the last 24 hours, and total unique bookings actioned per person, all-time. Click below to send it right now.</p>
      <div class="checkbox-row" style="margin:0 0 12px">
        <input type="checkbox" id="agent-report-also-main">
        <label for="agent-report-also-main" style="margin:0">Also send to the main team channel</label>
      </div>
      <button class="secondary" id="send-agent-report-btn">Send per-person report now</button>
      <p class="msg" id="agent-report-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>📥 Backfill from Slack</h2>
        <button type="button" class="info-btn" data-info="backfill">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">One-time import — reads the Confirm &amp; Flag channel and fills in usage for activity from before this Worker version started logging it live. Safe to re-run.</p>
      <label for="backfill-days-input">Days back</label>
      <input type="text" id="backfill-days-input" value="30" inputmode="numeric" />
      <button class="secondary" id="backfill-btn" style="margin-top:2px">Backfill now</button>
      <p class="msg" id="backfill-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🔍 Channel vs Dashboard audit</h2>
        <button type="button" class="info-btn" data-info="channel-audit">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Compares what the Confirm &amp; Flag channel actually shows against what's logged here, for the range currently selected above — a gap means something's under-counting.</p>
      <button class="secondary" id="channel-audit-btn">Run audit for current range</button>
      <p class="msg" id="channel-audit-msg"></p>
      <div id="channel-audit-results" style="display:none; margin-top:10px; font-size:13px; line-height:1.7;"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🩺 Status</h2>
        <button type="button" class="info-btn" data-info="status">i</button>
      </div>
      <div class="status-grid" id="status-grid"></div>
    </div>
    </div>
  </div>

<script>
(function () {
  var pwInput = document.getElementById('password-input');
  var loginMsg = document.getElementById('login-msg');
  var dashboard = document.getElementById('dashboard');
  var loginCard = document.getElementById('login-card');
  var password = null;

  function statusRow(label, ok) {
    return '<div><span>' + label + '</span><span><span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>' + (ok ? 'yes' : 'no') + '</span></div>';
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Info popovers — one shared element, positioned near whichever (i)
  // button was clicked; closes on outside click, Escape, or a second click
  // on the same button.
  var INFO_TEXT = {
    'daily-code': 'A random 6-digit code, posted to Slack automatically once a day \\u2014 click Send to Slack now any time to send another. Typed as bookingID-code, it unlocks that ONE booking\\'s gated Instructions, then is consumed immediately \\u2014 valid 5 minutes, single-use, so the same code can\\'t unlock a second booking or be reused if that booking is fetched again.',
    'admin-code': 'Generates a random code, posts it to the same Slack channel as the instructions code, and stores it until the end of today (IST). Typed as bookingID-code, it flips a permanent admin-mode bypass on your device for every display gate (Past booking, Booking due soon, Instructions) \\u2014 reusable as many times as you like for the rest of the day, not consumed on use. Request a fresh one any day you need admin access.',
    'status': 'Shows which Cloudflare secrets and bindings this Worker can see \\u2014 never the values themselves, just whether each is configured. A red dot here usually explains a broken feature (e.g. no Slack token means Confirm & Flag can\\'t post).',
    'usage-report': 'Posts to the passcode channel (the same one the instructions/admin codes go to), not the main team channel — this is admin-level data, not something the whole team needs in their feed. Check "Also send to the main team channel" before clicking to post there too. Unique bookings AI-verified all-time, and how many of those were flagged for an already-issued ticket instead of a checkout screenshot (also all-time). Posts automatically once a day; this button sends it on demand too.',
    'agent-report': 'Posts to the passcode channel by default, same as the usage report \\u2014 check the box first if you also want this in the main team channel. Checks run per person over a true rolling last-24-hours window (not tied to calendar days), plus total unique bookings each person has actioned, all-time. Posts automatically once a day; this button sends it on demand too.',
    'backfill': 'Confirm & Flag started logging usage here only from a certain point on \\u2014 anything confirmed before that only exists as a Slack message. This reads the Confirm & Flag channel\\'s history for the chosen window and fills in the missing entries. Each one is keyed by its Slack message, so re-running this for the same days never double-counts \\u2014 safe to click again. Needs the Slack bot token to have channel-history read access; a \\u201cmissing_scope\\u201d error means that needs adding in the Slack app\\'s OAuth settings first.',
    'channel-audit': 'A sanity check, not a report \\u2014 counts Confirm & Flag messages in the channel for the range selected above and compares that to what\\'s logged here. They won\\'t match perfectly forever (a message posted seconds before/after a range boundary can land on one side only), but a large or growing gap usually means something stopped recording \\u2014 catch it here before the usage numbers quietly go stale.',
  };
  var infoPopover = null;
  function closeInfoPopover() {
    if (infoPopover) { infoPopover.remove(); infoPopover = null; }
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.info-btn') : null;
    if (!btn) { closeInfoPopover(); return; }
    var wasOpenForThisBtn = infoPopover && infoPopover._forBtn === btn;
    closeInfoPopover();
    if (wasOpenForThisBtn) return;
    var text = INFO_TEXT[btn.getAttribute('data-info')];
    if (!text) return;
    var pop = document.createElement('div');
    pop.className = 'info-popover';
    pop.textContent = text;
    pop._forBtn = btn;
    document.body.appendChild(pop);
    var r = btn.getBoundingClientRect();
    var top = r.bottom + 6;
    var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 16);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, left) + 'px';
    infoPopover = pop;
    e.stopPropagation();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeInfoPopover(); });

  function render(cfg) {
    document.getElementById('worker-version').textContent = cfg.workerVersion || '—';
    document.getElementById('kv-warning').style.display = cfg.hasConfigKv ? 'none' : 'block';
    document.getElementById('status-grid').innerHTML =
      statusRow('Slack token', cfg.hasSlackToken) +
      statusRow('OpenAI key', cfg.hasOpenAiKey) +
      statusRow('CONFIG KV bound', cfg.hasConfigKv);
  }

  function unlock(pw, opts) {
    opts = opts || {};
    return fetch('/admin/config?password=' + encodeURIComponent(pw))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) {
          if (!opts.silent) loginMsg.textContent = r.data.error || 'Wrong password';
          loginMsg.className = 'msg err';
          return false;
        }
        password = pw;
        try { sessionStorage.setItem('bassAdminPw', pw); } catch (_) {}
        loginCard.style.display = 'none';
        dashboard.style.display = 'block';
        render(r.data);
        loadAnalyticsData();
        return true;
      })
      .catch(function (err) {
        if (!opts.silent) { loginMsg.textContent = 'Request failed: ' + err.message; loginMsg.className = 'msg err'; }
        return false;
      });
  }

  document.getElementById('unlock-btn').addEventListener('click', function () {
    var pw = pwInput.value.trim();
    if (!pw) return;
    unlock(pw);
  });
  pwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('unlock-btn').click(); });

  document.getElementById('send-slack-btn').addEventListener('click', function () {
    var msg = document.getElementById('slack-msg');
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-daily-code?password=' + encodeURIComponent(password))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Sent — code ' + r.data.code + ', valid 5 minutes, single-use.';
        msg.className = 'msg ok';
      })
      .catch(function (err) { msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err'; });
  });

  document.getElementById('request-code-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('request-code-msg');
    btn.disabled = true;
    msg.textContent = 'Requesting…'; msg.className = 'msg';
    fetch('/admin/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Sent — code ' + r.data.code + ', valid for the next 5 minutes, single-use.';
        msg.className = 'msg ok';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  document.getElementById('send-usage-report-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('usage-report-msg');
    var alsoMain = document.getElementById('usage-report-also-main').checked;
    btn.disabled = true;
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-usage-report?password=' + encodeURIComponent(password) + '&alsoMainChannel=' + alsoMain)
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Sent to the passcode channel' + (alsoMain ? ' and the main channel' : '') + ' — ' + r.data.usedCount + ' unique booking(s), ' + r.data.ticketCount + ' ticket flag(s).';
        msg.className = 'msg ok';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  document.getElementById('send-agent-report-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('agent-report-msg');
    var alsoMain = document.getElementById('agent-report-also-main').checked;
    btn.disabled = true;
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-agent-report?password=' + encodeURIComponent(password) + '&alsoMainChannel=' + alsoMain)
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        var rosterCount = (r.data.last24hUsage || []).length;
        var allTimeCount = (r.data.allTimeUsage || []).length;
        msg.textContent = 'Sent to the passcode channel' + (alsoMain ? ' and the main channel' : '') + ' — ' + rosterCount + ' known agent(s) listed, ' + allTimeCount + ' with unique-booking history.';
        msg.className = 'msg ok';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  document.getElementById('backfill-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('backfill-msg');
    var days = parseInt(document.getElementById('backfill-days-input').value, 10);
    if (!days || days < 1) { msg.textContent = 'Enter a positive number of days.'; msg.className = 'msg err'; return; }
    var since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    btn.disabled = true;
    msg.textContent = 'Reading the channel — this can take a moment…'; msg.className = 'msg';
    fetch('/admin/backfill-from-slack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password, since: since }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Scanned ' + r.data.scanned + ' channel message(s) — backfilled ' + r.data.backfilled + ', skipped ' + r.data.skippedUnparseable + ' unparseable. Refresh above to see updated numbers.';
        msg.className = 'msg ok';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  document.getElementById('channel-audit-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('channel-audit-msg');
    var resultsEl = document.getElementById('channel-audit-results');
    var range = computeRange();
    btn.disabled = true;
    resultsEl.style.display = 'none';
    msg.textContent = 'Reading the channel — this can take a moment…'; msg.className = 'msg';
    fetch('/admin/channel-audit?password=' + encodeURIComponent(password) +
      '&start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = '';
        var d = r.data;
        var gap = d.channelUniqueBookingCount - d.dashboardUniqueBookingCount;
        resultsEl.innerHTML =
          '<div><b>Channel:</b> ' + d.channelMessageCount + ' message(s), ' + d.channelUniqueBookingCount + ' unique booking(s)</div>' +
          '<div><b>Dashboard:</b> ' + d.dashboardEventCount + ' event(s), ' + d.dashboardUniqueBookingCount + ' unique booking(s)</div>' +
          '<div style="margin-top:6px" class="' + (gap > 0 ? 'msg err' : 'msg ok') + '">' +
          (gap > 0 ? gap + ' booking(s) in the channel are missing here — try Backfill from Slack, or widen its day range.' : 'No gap for this range.') +
          '</div>';
        resultsEl.style.display = 'block';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  // ── Analytics — reads from the Confirm & Flag channel by default (the
  // primary source), with a toggle to switch to the KV usage log instead.
  // Reuses the same admin 'password' already unlocked above.
  var pct = function (n, d) { return d > 0 ? Math.round((n / d) * 100) + '%' : '—'; };
  function fmtRange(startIso, endIso) {
    try {
      var opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
      return new Date(startIso).toLocaleString(undefined, opts) + ' → ' + new Date(endIso).toLocaleString(undefined, opts);
    } catch (_) { return startIso + ' to ' + endIso; }
  }

  var anState = { rangeDays: 7, customStart: null, customEnd: null, source: 'channel', filter: 'all' };

  function computeRange() {
    if (anState.rangeDays === 'custom' && anState.customStart && anState.customEnd) {
      return { start: anState.customStart, end: anState.customEnd };
    }
    var end = new Date();
    var start = anState.rangeDays === 'all' ? new Date(0) : new Date(end.getTime() - anState.rangeDays * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function renderRankList(el, rows, opts) {
    opts = opts || {};
    if (!rows.length) {
      el.innerHTML = '<p class="empty-note">No activity in this range yet.</p>';
      return;
    }
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    el.innerHTML = rows.slice(0, 8).map(function (r) {
      var widthPct = max > 0 ? Math.max(4, Math.round((r.value / max) * 100)) : 0;
      return '<div class="rank-row" title="' + escHtml(r.name) + ': ' + r.value + '">' +
        '<span class="rank-name">' + escHtml(r.name) + '</span>' +
        '<div class="rank-track"><div class="rank-fill' + (opts.mismatch ? ' mismatch' : '') + '" style="width:' + widthPct + '%"></div></div>' +
        '<span class="rank-value tabular">' + r.value + '</span>' +
        '</div>';
    }).join('');
  }

  function renderAnalytics(d, range) {
    var sourceLabel = d.source === 'dashboard' ? 'usage log' : 'channel';
    document.getElementById('status-line').textContent = 'Showing ' + fmtRange(range.start, range.end) + ' from the ' + sourceLabel + ' · ' + (d.totalEvents || 0) + ' logged event(s) · updated ' + new Date().toLocaleTimeString();

    document.getElementById('kpi-bookings').textContent = d.uniqueBookingCount;
    document.getElementById('kpi-bookings-sub').textContent = d.checksWithData + ' with field-level checks';

    var totalTagged = d.checkoutBookingCount + d.ticketBookingCount + d.otherPageBookingCount;
    document.getElementById('kpi-checkout-rate').textContent = pct(d.checkoutBookingCount, totalTagged);
    document.getElementById('kpi-match-rate').textContent = pct(d.fullMatchChecks, d.checksWithData);

    var topVendor = d.perVendorUniqueBookings[0];
    document.getElementById('kpi-top-vendor').textContent = topVendor ? topVendor[0] : '—';
    document.getElementById('kpi-top-vendor-sub').textContent = topVendor ? topVendor[1] + ' unique booking(s)' : 'No vendor data yet';

    document.getElementById('tile-checkout').textContent = d.checkoutBookingCount;
    document.getElementById('tile-ticket').textContent = d.ticketBookingCount;
    document.getElementById('tile-other').textContent = d.otherPageBookingCount;
    document.getElementById('tile-checkout-pct').textContent = pct(d.checkoutBookingCount, totalTagged) + ' of tagged screenshots — good';
    document.getElementById('tile-ticket-pct').textContent = pct(d.ticketBookingCount, totalTagged) + ' of tagged screenshots — flag';
    document.getElementById('tile-other-pct').textContent = pct(d.otherPageBookingCount, totalTagged) + ' of tagged screenshots';

    // Union, not a sum — the same booking can show up in both buckets across
    // more than one confirmation, and this should still count it once.
    var incorrectFlagIds = new Set((d.ticketBookingIds || []).concat(d.otherPageBookingIds || []));
    document.getElementById('tile-incorrect').textContent = incorrectFlagIds.size;
    document.getElementById('tile-incorrect-pct').textContent = pct(incorrectFlagIds.size, d.uniqueBookingCount) + ' of all unique bookings';

    var preOverrideIds = d.preOverrideFlagBookingIds || [];
    var overrideConfirmedIds = d.overrideConfirmedBookingIds || [];
    var stillOutstanding = preOverrideIds.filter(function (id) { return overrideConfirmedIds.indexOf(id) === -1; });
    document.getElementById('tile-pre-override').textContent = d.preOverrideFlagCount || 0;
    document.getElementById('tile-pre-override-pct').textContent = stillOutstanding.length
      ? stillOutstanding.length + ' not yet confirmed'
      : 'all resolved';
    document.getElementById('tile-override-confirmed').textContent = d.overrideConfirmedCount || 0;
    document.getElementById('tile-override-confirmed-pct').textContent = 'resolved and confirmed';

    renderRankList(document.getElementById('vendor-list'), d.perVendorUniqueBookings.map(function (r) { return { name: r[0], value: r[1] }; }));
    renderRankList(document.getElementById('product-list'), d.perProductUniqueBookings.map(function (r) { return { name: r.product + (r.vendor ? ' · ' + r.vendor : ''), value: r.uniqueBookingCount }; }));
    renderRankList(document.getElementById('field-list'), d.fieldMismatchCounts.map(function (r) { return { name: r[0], value: r[1] }; }), { mismatch: true });

    var matchTotal = d.fullMatchChecks + d.partialMatchChecks;
    document.getElementById('val-full').textContent = d.fullMatchChecks;
    document.getElementById('val-partial').textContent = d.partialMatchChecks;
    document.getElementById('bar-full').style.width = matchTotal ? Math.max(4, Math.round((d.fullMatchChecks / matchTotal) * 100)) + '%' : '0%';
    document.getElementById('bar-partial').style.width = matchTotal ? Math.max(4, Math.round((d.partialMatchChecks / matchTotal) * 100)) + '%' : '0%';

    document.getElementById('booking-table-body').innerHTML = (d.bookings || []).length
      ? d.bookings.map(function (b) {
          var mismatch = (b.mismatchedFields || []).length ? escHtml(b.mismatchedFields.join(', ')) : '<span class="muted">none</span>';
          var when = b.at ? new Date(b.at).toLocaleString() : '—';
          var stageLabel = b.stage === 'flagged'
            ? '<span style="color:var(--warn);font-weight:600;">🚩 Flagged</span>'
            : b.stage === 'confirmed'
            ? '<span style="color:var(--good);font-weight:600;">✅ Confirmed</span>'
            : '<span class="muted">—</span>';
          return '<tr><td>' + escHtml(b.bookingId || '—') + (b.retroactive ? ' <span class="muted">(late)</span>' : '') + '</td>' +
            '<td>' + stageLabel + '</td>' +
            '<td>' + escHtml(b.agentEmail || '—') + '</td>' +
            '<td>' + mismatch + '</td>' +
            '<td>' + escHtml(when) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty-note">No activity for this range, source, and filter.</td></tr>';
    document.getElementById('booking-truncated-note').style.display = d.bookingsTruncated ? 'block' : 'none';

    var personRows = d.perPersonUniqueBookings.map(function (row) {
      var email = row[0], uniqueCount = row[1];
      var checksRow = d.perPersonCheckCounts.find(function (c) { return c[0] === email; });
      return { email: email, checks: checksRow ? checksRow[1] : 0, unique: uniqueCount };
    });
    d.perPersonCheckCounts.forEach(function (c) {
      if (!personRows.some(function (r) { return r.email === c[0]; })) personRows.push({ email: c[0], checks: c[1], unique: 0 });
    });
    personRows.sort(function (a, b) { return b.checks - a.checks; });
    document.getElementById('person-table-body').innerHTML = personRows.length
      ? personRows.map(function (r, i) {
          return '<tr><td><span class="rank-badge">' + (i + 1) + '</span>' + escHtml(r.email) + '</td>' +
            '<td class="num tabular">' + r.checks + '</td><td class="num tabular">' + r.unique + '</td></tr>';
        }).join('')
      : '<tr><td colspan="3" class="empty-note">No one has used AI Verify in this range yet.</td></tr>';
  }

  function loadAnalyticsData() {
    if (!password) return;
    var range = computeRange();
    var endpoint = anState.source === 'dashboard' ? '/admin/usage-report-range' : '/admin/channel-report';
    document.getElementById('status-line').textContent = anState.source === 'dashboard' ? 'Loading…' : 'Reading the channel — this can take a moment…';
    fetch(endpoint + '?password=' + encodeURIComponent(password) +
      '&start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end) +
      '&filter=' + encodeURIComponent(anState.filter))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok || !r.data.ok) {
          document.getElementById('status-line').textContent = 'Could not load data: ' + ((r.data && r.data.error) || ('HTTP ' + (r.status || '?')));
          return;
        }
        renderAnalytics(r.data, range);
      })
      .catch(function (err) {
        document.getElementById('status-line').textContent = 'Request failed: ' + err.message;
      });
  }

  document.querySelectorAll('#range-group .range-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var range = btn.getAttribute('data-range');
      document.querySelectorAll('#range-group .range-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (range === 'custom') { document.getElementById('custom-range').classList.add('open'); return; }
      document.getElementById('custom-range').classList.remove('open');
      anState.rangeDays = range === 'all' ? 'all' : parseInt(range, 10);
      loadAnalyticsData();
    });
  });
  document.getElementById('custom-apply-btn').addEventListener('click', function () {
    var s = document.getElementById('custom-start').value, e = document.getElementById('custom-end').value;
    if (!s || !e) return;
    anState.rangeDays = 'custom';
    anState.customStart = new Date(s).toISOString();
    anState.customEnd = new Date(e).toISOString();
    loadAnalyticsData();
  });
  document.getElementById('refresh-btn').addEventListener('click', loadAnalyticsData);

  document.querySelectorAll('#source-group .range-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#source-group .range-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      anState.source = btn.getAttribute('data-source');
      loadAnalyticsData();
    });
  });
  document.querySelectorAll('#filter-group .range-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#filter-group .range-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      anState.filter = btn.getAttribute('data-filter');
      loadAnalyticsData();
    });
  });

  var savedPw = null;
  try { savedPw = sessionStorage.getItem('bassAdminPw'); } catch (_) {}
  if (savedPw) unlock(savedPw, { silent: true });
})();
</script>
</body>
</html>`;
