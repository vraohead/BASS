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
//                             pageType is "checkout" (expected), "ticket"
//                             (already-issued ticket instead — the flagged
//                             case), or "other" (neither — blank/error/
//                             unrelated page). bookingId, agentEmail, and
//                             vendor (all optional) only feed the usage
//                             report below — omitting any just skips that
//                             slice of tracking, the AI check itself is
//                             unaffected.
//   POST /confirm-flag     { bookingId, agentEmail, confirmed, skipped,
//                            imageBase64?, mimeType?, verifiedAt }
//                          -> { ok: true, steps: [...], screenshotError? }
//   GET  /admin/send-daily-code?password=...    -> manually trigger the Slack post (for testing)
//   GET  /admin/send-usage-report?password=...  -> send the totals report to Slack right now
//                                                   (also wired to a button on the admin page)
//   GET  /admin/send-agent-report?password=...  -> send the per-person report to Slack right now
//                                                   (also wired to a button on the admin page)
//   GET  /admin/usage-report-range?password=...&start=<ISO>&end=<ISO>
//                          -> the full summarizeEvents() shape (see below) for exactly
//                             that window — doesn't post to Slack, rendered inline on
//                             the admin page (its "Custom range report" card), and is
//                             the same shape a future dashboard would read from
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
// cron post (except the custom range, which is on-demand only):
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
//      asked for instead of last-24h or all-time.
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
const WORKER_VERSION = '2026-09-20-04';

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

    if (request.method === 'GET' && url.pathname === '/debug-env') {
      return cors(JSON.stringify({
        version: WORKER_VERSION,
        hasSlackToken: !!env.SLACK_BOT_TOKEN,
        hasOpenAiKey: !!env.OPENAI_API_KEY,
        hasAdminPassword: !!env.ADMIN_PASSWORD,
        hasConfigKv: !!env.CONFIG,
        slackChannelId: SLACK_CHANNEL_ID,
        dailyCodeChannelId: DAILY_CODE_CHANNEL_ID,
      }), 200);
    }

    if (request.method === 'POST' && url.pathname === '/confirm-flag') {
      return handleConfirmFlag(request, env);
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
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const result = await sendDailyCodeToSlack(env);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

// ── Admin config status ──────────────────────────────────────────────────────
async function handleAdminGetConfig(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
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
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  if (body.password !== env.ADMIN_PASSWORD) {
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

  const factLines = [
    date    ? `Date: ${date}`             : null,
    time    ? `Time: ${time}`             : null,
    pax     ? `Total pax (guests): ${pax}` : null,
    price   ? `Net price: ${price}`       : null,
    product ? `Product / experience name: ${product}` : null,
  ].filter(Boolean).join('\n');

  // Deliberately verbose and explicit — the aim is to eliminate manual
  // re-checking entirely, not just catch the easy cases. Every rule below
  // exists because a naive exact-string-match prompt used to miss it.
  const prompt = `You are a meticulous booking-verification assistant. Agents capture this screenshot BEFORE finalizing a booking on a vendor site, to catch mistakes (wrong date, wrong pax, wrong tour) while they can still be fixed — so it should show the CHECKOUT / CART / PAYMENT page with the booking details entered but not yet confirmed, not an already-issued ticket. Getting the field checks wrong in either direction causes real problems — a false "found: true" lets a mistake through, and a false "found: false" creates needless manual review — so read carefully and think about what's actually shown before answering.

Booking record to match against the screenshot:
${factLines}

How to judge each field:
1. Date: dates are often written in completely different formats between the booking record and the screenshot (e.g. "14 Sep 2026", "2026-09-14", "Sep 14, 2026", "14/09/2026" can all be the SAME date). Parse both and compare the actual calendar date, not the text formatting. Only mark found:false if the calendar date shown is genuinely different, missing, or illegible.
2. Time: same principle — "3:00 PM", "15:00", and "3 PM" are the same time of day. Allow for a different timezone label as long as the underlying time is consistent with the booking; only mark found:false if the actual time of day is genuinely different or not shown.
3. Total pax (guests): look for the TOTAL guest/pax/ticket count shown in the screenshot. If the screenshot breaks pax down by type (e.g. "2 Adults, 1 Child"), add them up yourself and compare the sum to the expected total — do not mark found:false just because no single number matches if the breakdown sums to the expected total.
4. Net price: ignore currency symbol, comma, and decimal-formatting differences; compare the numeric amount itself.
5. Product / experience name: compare the tour/experience/product name shown in the screenshot against the expected name. Minor wording differences (abbreviations, punctuation, added suffixes like "- with hotel pickup", capitalization) still count as a match if it is clearly the same experience. A genuinely different tour or activity is not a match.

Separately — always answer this regardless of the fields above:
6. Page type: classify what the screenshot actually shows, as exactly one of:
   - "checkout": the expected case — a CHECKOUT / CART / PAYMENT page on the vendor's site, showing the booking being entered and about to be confirmed (an editable cart, guest/date/time selection, a "Pay now" or "Proceed to payment" button, a price breakdown).
   - "ticket": an already-confirmed/issued ticket or booking confirmation instead (a booking/ticket/confirmation number, a QR/barcode, "Booking Confirmed", a voucher) — checking details only AFTER the booking is already placed defeats the entire purpose of catching mistakes before they happen, so this must be flagged whenever it happens.
   - "other": neither of the above — a blank/loading page, an error page, a login/session-expired screen, an unrelated page, or anything else that isn't a checkout page or a ticket. Use this rather than forcing a screenshot into "checkout" or "ticket" when it's genuinely neither.

Reply ONLY with valid JSON in this exact shape — no markdown, no extra text:
{"checks":[{"label":"Date","expected":"${date}","found":true},{"label":"Time","expected":"${time}","found":false}],"pageType":"checkout","pageTypeNote":""}

Rules:
- Only include a check for a field if its expected value above is non-empty.
- Set found to true only when the value is unambiguously present after applying the format-tolerance rules above.
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
              label:    { type: 'string' },
              expected: { type: 'string' },
              found:    { type: 'boolean' },
            },
            required: ['label', 'expected', 'found'],
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

  // Fire-and-forget: logs one permanent usage event for the reports below
  // (booking-uniqueness, page-type tag distribution, match-rate/field-skip
  // stats, vendor/experience breakdowns, per-person breakdowns, and custom
  // date-range queries all derive from this same log). Never blocks the
  // response on this.
  const mismatchedFields = (result.checks || []).filter(c => c.found === false).map(c => c.label);
  ctx.waitUntil(recordVerifyEvent(env, {
    bookingId: bookingId || null,
    agentEmail: agentEmail || null,
    vendor: vendor || null,
    product: product || null,
    pageType: result.pageType || null,
    totalChecks: (result.checks || []).length,
    mismatchedFields,
  }));

  return cors(JSON.stringify({ ...result, steps }), 200);
}

// ── Usage tracking + report ──────────────────────────────────────────────────
// One permanent, append-only event log — every successful /verify call that
// carries a bookingId and/or agentEmail writes one entry (never overwritten,
// no TTL), so any report (all-time, last-24h, or an arbitrary custom range)
// is just a filter + aggregation over the same data, computed at read time.
// Cheap at this team's scale (a few dozen entries a day at most).
const VERIFY_LOG_PREFIX = 'verifylog:';

async function recordVerifyEvent(env, { bookingId, agentEmail, vendor, product, pageType, totalChecks, mismatchedFields }) {
  if (!env.CONFIG) return;
  if (!bookingId && !agentEmail) return; // nothing worth logging
  // KV metadata is capped at 1024 bytes — keep this to short scalars/labels,
  // never raw screenshot data or full AI output.
  await env.CONFIG.put(`${VERIFY_LOG_PREFIX}${crypto.randomUUID()}`, '1', {
    metadata: {
      bookingId: bookingId || null,
      email: agentEmail || null,
      vendor: vendor || null,
      product: product || null,
      pageType: pageType || null, // 'checkout' | 'ticket' | 'other' | null (unknown/older event)
      totalChecks: totalChecks || 0,
      mismatchedFields: mismatchedFields && mismatchedFields.length ? mismatchedFields : undefined,
      at: new Date().toISOString(),
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
  let fullMatchChecks = 0, partialMatchChecks = 0, checksWithData = 0;

  for (const e of events) {
    if (e.bookingId) {
      bookingIds.add(e.bookingId);
      const bucket = pageTypeBookingIds[e.pageType];
      if (bucket) bucket.add(e.bookingId);

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

// Posted automatically once a day via the cron `scheduled` handler below,
// alongside the instructions code — also wired to the admin page's "Send
// usage report now" button for an on-demand check any time. Covers overall
// totals, match-rate, and vendor/experience breakdowns; per-person activity
// is a separate report (see below).
async function sendUsageReportToSlack(env) {
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

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text }),
    });
    const data = await res.json();
    logStep('slack_chat_postMessage', data.ok === true, `HTTP ${res.status} — ${JSON.stringify(data).slice(0, 500)}`);
    return {
      ok: data.ok === true, error: data.ok ? null : data.error,
      usedCount: s.uniqueBookingCount, ticketCount: s.ticketBookingCount, otherCount: s.otherPageBookingCount,
      fullMatchChecks: s.fullMatchChecks, partialMatchChecks: s.partialMatchChecks, steps,
    };
  } catch (err) {
    logStep('slack_chat_postMessage', false, `Exception: ${err.message}`);
    return { ok: false, error: err.message, steps };
  }
}

// Posted automatically once a day alongside the report above — also wired
// to its own admin page button ("Send per-person report now") since it's a
// distinct question (who's using it) from the totals report (how much has
// been used overall). Lists every person who has EVER logged an event (the
// "roster"), not just those active in the last 24h, so someone at 0 today
// still shows up rather than silently disappearing from the list.
async function sendAgentUsageReportToSlack(env) {
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

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text }),
    });
    const data = await res.json();
    logStep('slack_chat_postMessage', data.ok === true, `HTTP ${res.status} — ${JSON.stringify(data).slice(0, 500)}`);
    return {
      ok: data.ok === true, error: data.ok ? null : data.error,
      last24hUsage: last24hFull, allTimeUsage: allTime.perPersonUniqueBookings, steps,
    };
  } catch (err) {
    logStep('slack_chat_postMessage', false, `Exception: ${err.message}`);
    return { ok: false, error: err.message, steps };
  }
}

async function handleAdminSendUsageReport(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const result = await sendUsageReportToSlack(env);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

async function handleAdminSendAgentReport(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  const result = await sendAgentUsageReportToSlack(env);
  return cors(JSON.stringify(result), result.ok ? 200 : 502);
}

// On-demand only — doesn't post to Slack, just returns the numbers so the
// admin page can render them inline for whatever window was asked for.
async function handleAdminUsageReportRange(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }
  if (!env.CONFIG) {
    return cors(JSON.stringify({ error: 'No CONFIG KV namespace bound' }), 500);
  }
  const start = url.searchParams.get('start') || null;
  const end = url.searchParams.get('end') || null;
  const events = await listVerifyEvents(env, { start, end });
  const summary = summarizeEvents(events);
  return cors(JSON.stringify({ ok: true, start, end, totalEvents: events.length, ...summary }), 200);
}

// ── /confirm-flag — post to Slack (message + screenshot, unified) ─────────────

async function handleConfirmFlag(request, env) {
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
    bookingId, agentEmail, confirmed = [], skipped = [], retroactive = false,
    imageBase64, mimeType = 'image/png', verifiedAt,
  } = body;

  if (!env.SLACK_BOT_TOKEN) {
    logStep('check_slack_token', false, 'SLACK_BOT_TOKEN secret not set');
    return cors(JSON.stringify({
      error: 'Worker misconfigured — run: wrangler secret put SLACK_BOT_TOKEN (or add it as a Secret in the dashboard Settings)',
      steps,
    }), 500);
  }
  logStep('check_slack_token', true, null);

  const lines = [
    retroactive
      ? ':rotating_light: *Booking Confirmed — Late (no prior verification run)*'
      : ':white_check_mark: *Booking Verification Confirmed*',
    `*Booking ID:* ${bookingId || 'n/a'}`,
    `*Confirmed by:* ${agentEmail || 'unknown'}`,
    confirmed.length
      ? `*Matched:* ${confirmed.map(c => `${c.label}: ${c.value}`).join('  |  ')}`
      : null,
    skipped.length
      ? `*Skipped (mismatch acknowledged):* ${skipped.map(c => `${c.label}: ${c.value}`).join('  |  ')}`
      : null,
    retroactive ? '*Note:* Confirmed via Late Confirm — ticket was already booked, verification step was skipped at the time.' : null,
    verifiedAt ? `*At:* ${formatIST(verifiedAt)}` : null,
  ].filter(Boolean).join('\n');

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
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px; background: #0f1115; color: #e6e6ea;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b8b95; margin: 0 0 24px; font-size: 13px; }
  .login-wrap { max-width: 420px; margin: 40px auto 0; }
  .layout { max-width: 480px; margin: 0 auto; }
  .card {
    background: #1a1c23; border: 1px solid #2a2c35; border-radius: 10px;
    padding: 18px; margin-bottom: 16px;
  }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #9a9aa5; margin: 0; }
  .card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; }
  .info-btn {
    background: transparent; border: 1px solid #33353f; color: #75757f;
    width: 18px; height: 18px; padding: 0; border-radius: 50%;
    font-size: 11px; font-weight: 700; line-height: 1; display: inline-flex;
    align-items: center; justify-content: center; flex-shrink: 0;
  }
  .info-btn:hover { background: #24262e; color: #b0b0ba; border-color: #45475a; }
  .info-popover {
    position: fixed; max-width: 280px; background: #24262e; border: 1px solid #3a3d4a;
    border-radius: 8px; padding: 10px 12px; font-size: 12.5px; line-height: 1.55;
    color: #d6d6de; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 50;
  }
  label { display: block; font-size: 12px; color: #b0b0ba; margin-bottom: 6px; }
  .sub-label { font-size: 11px; color: #75757f; margin: -6px 0 10px; }
  input[type=password], input[type=text], input[type=datetime-local], textarea {
    width: 100%; padding: 9px 10px; border-radius: 7px; border: 1px solid #33353f;
    background: #0f1115; color: #e6e6ea; font-size: 14px; margin-bottom: 10px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 56px; }
  textarea:disabled { opacity: 0.4; cursor: not-allowed; }
  .message-block {
    border-top: 1px dashed #2a2c35; margin-top: 4px; padding-top: 14px;
  }
  .row { display: flex; gap: 10px; align-items: center; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin: 4px 0 14px; }
  .checkbox-row input { width: 16px; height: 16px; }
  button {
    background: #5865f2; color: #fff; border: none; border-radius: 7px;
    padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #4752c4; }
  button:disabled { background: #33353f; color: #75757f; cursor: not-allowed; }
  button.secondary { background: #2a2c35; }
  button.secondary:hover { background: #33353f; }
  button.tiny { padding: 4px 10px; font-size: 12px; }
  .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; font-size: 13px; }
  .status-grid div { display: flex; justify-content: space-between; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: #3ba55c; } .dot.bad { background: #ed4245; }
  .code-display { font: 700 22px/1 "JetBrains Mono", monospace; letter-spacing: .06em; color: #5865f2; margin: 6px 0; }
  .muted { color: #8b8b95; font-size: 12px; }
  .msg { font-size: 13px; margin-top: 10px; min-height: 18px; }
  .msg.err { color: #ed4245; } .msg.ok { color: #3ba55c; }
  .warn-banner {
    background: #3a2c0f; border: 1px solid #6b4f14; color: #f0c674;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; margin-bottom: 16px;
  }
  #dashboard { display: none; }
  a { color: #5865f2; }
</style>
</head>
<body>
  <h1>Booking Assistant — Admin</h1>
  <p class="sub">Manage what the team's extension shows, test changes live before they go out, and check configuration health. · Worker: <span id="worker-version">—</span></p>

  <div id="login-card" class="card login-wrap">
    <h2>Unlock</h2>
    <input type="password" id="password-input" placeholder="Admin password" autocomplete="off" />
    <button id="unlock-btn">Unlock</button>
    <p class="msg" id="login-msg"></p>
  </div>

  <div id="dashboard" class="layout">
    <div id="kv-warning" class="warn-banner" style="display:none">
      No CONFIG KV namespace bound yet — codes can't be generated or verified. Bind one in Settings → Bindings → KV Namespace → name it <b>CONFIG</b> to fix this.
    </div>

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
      <p class="sub-label" style="margin:0 0 12px">Posts automatically once a day. Click below to send it right now — unique bookings AI-verified (all-time), and tickets flagged instead of checkout (all-time).</p>
      <button class="secondary" id="send-usage-report-btn">Send usage report now</button>
      <p class="msg" id="usage-report-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🧑‍💼 Per-person report</h2>
        <button type="button" class="info-btn" data-info="agent-report">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Posts automatically once a day. Click below to send it right now — who's using it: checks run in the last 24 hours, and total unique bookings actioned per person, all-time.</p>
      <button class="secondary" id="send-agent-report-btn">Send per-person report now</button>
      <p class="msg" id="agent-report-msg"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🗓 Custom range report</h2>
        <button type="button" class="info-btn" data-info="range-report">i</button>
      </div>
      <p class="sub-label" style="margin:0 0 12px">Fetch usage for any date/time window — shown right here, doesn't post to Slack.</p>
      <label for="range-start-input">From</label>
      <input type="datetime-local" id="range-start-input" />
      <label for="range-end-input">To</label>
      <input type="datetime-local" id="range-end-input" />
      <button class="secondary" id="range-fetch-btn" style="margin-top:2px">Fetch</button>
      <p class="msg" id="range-msg"></p>
      <div id="range-results" style="display:none; margin-top:12px; font-size:13px; line-height:1.7;"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🩺 Status</h2>
        <button type="button" class="info-btn" data-info="status">i</button>
      </div>
      <div class="status-grid" id="status-grid"></div>
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
    'usage-report': 'Posts to the same Slack channel as Confirm & Flag: unique bookings AI-verified all-time, and how many of those were flagged for an already-issued ticket instead of a checkout screenshot (also all-time). Posts automatically once a day; this button sends it on demand too.',
    'agent-report': 'Posts to the same Slack channel: checks run per person over a true rolling last-24-hours window (not tied to calendar days), plus total unique bookings each person has actioned, all-time. Posts automatically once a day; this button sends it on demand too.',
    'range-report': 'Pick any From/To window and fetch usage for exactly that period \\u2014 unique bookings, ticket-instead-of-checkout flags, and a per-person breakdown. Shown right here on the page, not posted to Slack, so you can explore freely without spamming the channel.',
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
    btn.disabled = true;
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-usage-report?password=' + encodeURIComponent(password))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Sent — ' + r.data.usedCount + ' unique booking(s), ' + r.data.ticketCount + ' ticket flag(s).';
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
    btn.disabled = true;
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-agent-report?password=' + encodeURIComponent(password))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        var rosterCount = (r.data.last24hUsage || []).length;
        var allTimeCount = (r.data.allTimeUsage || []).length;
        msg.textContent = 'Sent — ' + rosterCount + ' known agent(s) listed, ' + allTimeCount + ' with unique-booking history.';
        msg.className = 'msg ok';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  document.getElementById('range-fetch-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('range-msg');
    var resultsEl = document.getElementById('range-results');
    var startVal = document.getElementById('range-start-input').value;
    var endVal = document.getElementById('range-end-input').value;
    if (!startVal || !endVal) {
      msg.textContent = 'Pick both a start and end.'; msg.className = 'msg err';
      return;
    }
    var startIso = new Date(startVal).toISOString();
    var endIso = new Date(endVal).toISOString();
    btn.disabled = true;
    resultsEl.style.display = 'none';
    msg.textContent = 'Fetching…'; msg.className = 'msg';
    fetch('/admin/usage-report-range?password=' + encodeURIComponent(password) +
      '&start=' + encodeURIComponent(startIso) + '&end=' + encodeURIComponent(endIso))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = '';
        var d = r.data;
        var perPersonLines = d.perPersonUniqueBookings.length
          ? d.perPersonUniqueBookings.map(function (row) {
              return '<div>' + escHtml(row[0]) + ': <b>' + row[1] + '</b> unique booking(s)</div>';
            }).join('')
          : '<div class="muted">No activity in this range.</div>';
        resultsEl.innerHTML =
          '<div><b>' + d.uniqueBookingCount + '</b> unique booking(s) verified</div>' +
          '<div><b>' + d.checkoutBookingCount + '</b> checkout page (expected)</div>' +
          '<div><b>' + d.ticketBookingCount + '</b> ticket shown instead of checkout</div>' +
          '<div><b>' + d.otherPageBookingCount + '</b> neither (other)</div>' +
          '<div style="margin-top:8px"><b>' + d.fullMatchChecks + '</b> full match, <b>' + d.partialMatchChecks + '</b> partial match (of ' + d.checksWithData + ')</div>' +
          '<div style="margin-top:8px"><b>Per person (unique bookings):</b></div>' + perPersonLines +
          '<div class="muted" style="margin-top:10px">Full breakdown (vendors, experiences, mismatched fields) is on the dashboard.</div>';
        resultsEl.style.display = 'block';
      })
      .catch(function (err) {
        btn.disabled = false;
        msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err';
      });
  });

  var savedPw = null;
  try { savedPw = sessionStorage.getItem('bassAdminPw'); } catch (_) {}
  if (savedPw) unlock(savedPw, { silent: true });
})();
</script>
</body>
</html>`;
