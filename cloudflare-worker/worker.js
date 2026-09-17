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
//   POST /verify          { imageBase64, mimeType, facts: {date,time,pax,price,product} }
//                          -> { checks: [...], isCheckoutPage, checkoutPageNote }
//                             isCheckoutPage:false is the flagged case — the
//                             screenshot is expected to be a checkout/cart/
//                             payment page (pre-confirmation), not an
//                             already-issued ticket
//   POST /confirm-flag     { bookingId, agentEmail, confirmed, skipped,
//                            imageBase64?, mimeType?, verifiedAt }
//                          -> { ok: true, steps: [...], screenshotError? }
//   GET  /admin/send-daily-code?password=...  -> manually trigger the Slack post (for testing)
//   GET  /admin/config?password=...           -> current config + today's code + secret status (admin-only)
//   POST /admin/set-config { password, latestVersion?, updateRequired? } -> write config (admin-only)
//   POST /verify-code      { code } -> { valid: true|false }
//   POST /verify-admin-code { code } -> { valid: true|false }
//   GET  /latest-version   -> { latestVersion, downloadUrl, updateRequired, message } — not secret, no auth
//                             message is the admin's custom update text, only
//                             sent when enabled — null falls back to the
//                             extension's own default wording
//
// Every meaningful operation (Slack calls, OpenAI calls) appends a
// {step, ok, detail, at} entry to a `steps` array that's returned in the
// JSON response — so a failure anywhere always comes back with the exact
// step name, HTTP status, and raw response body instead of a generic
// "something went wrong".
//
// Daily instructions-unlock code: requires two new Cloudflare secrets —
//   wrangler secret put DAILY_CODE_SECRET   <- any random string, never shared
//   wrangler secret put ADMIN_PASSWORD      <- password for the manual
//                                               /admin/send-daily-code test-trigger
// The code itself is never stored anywhere — it's recomputed on demand from
// HMAC(DAILY_CODE_SECRET, today's IST date), so it's deterministic for the
// whole day and automatically different tomorrow with zero extra state.
//
// Daily Slack post: this Worker also exports a `scheduled` handler that
// posts today's code to DAILY_CODE_CHANNEL_ID automatically. Wire it up
// once in the Cloudflare Dashboard: Workers & Pages -> this worker ->
// Settings -> Triggers -> Cron Triggers -> Add Cron Trigger -> schedule
// "35 18 * * *" (that's 00:05 IST, i.e. just after the code rolls over).
//
// Admin/testing master code: requires one more secret —
//   wrangler secret put ADMIN_MASTER_CODE   <- pick something with at least
//                                               one letter in it (e.g.
//                                               "BASSADMIN2026"), so it can
//                                               never collide with the
//                                               all-numeric daily code.
// Unlike the daily code this never rotates on its own — change the secret
// value in the Dashboard any time you want to invalidate it. Typed as
// "<bookingId>-<masterCode>" into the Booking ID box, it flips a
// persistent "admin mode" in the extension (chrome.storage.local, not this
// Worker) that bypasses every display gate — Past booking, Booking due
// soon, Instructions withheld — from then on, for testing.
//
// Team update push: add a plain (non-secret) Variable named LATEST_VERSION
// in the Dashboard (Settings -> Variables) whenever you want everyone's
// extension to show an "update available" banner — set it to the new
// version number (must match the manifest.json you're asking people to
// install, e.g. "10.1.0"). Every extension checks it on open and shows the
// banner only while its own installed version is older; there's nothing to
// turn back off — just leave the variable set (or delete it to stop
// announcing). Not a push in the literal sense (nothing reaches an
// already-open extension instantly) — it's checked next time each agent
// opens the panel, same as everything else this Worker serves.
//
// Soft banner vs. hard block: by default a stale LATEST_VERSION only shows
// the dismissable-by-updating banner (extension still fully usable). To
// force everyone to update before they can use it at all, also add a plain
// Variable named UPDATE_REQUIRED set to the string "true" — anyone whose
// installed version is behind LATEST_VERSION then gets a full-screen
// "Update Required" block (no booking lookup, no tabs) until they install
// the new version. Set UPDATE_REQUIRED back to "false" (or delete it) to
// drop back to the soft banner for the same LATEST_VERSION. Admin mode
// (the ID-masterCode bypass, extension-side) is exempt from the hard
// block, so testing a new version never locks the admin out of their own
// device — they still see the soft banner as a reminder.
//
// Admin page: visiting this Worker's own URL in a browser (e.g.
// https://bass-verify.vivek-rao.workers.dev/) now serves a small
// password-gated control page — no separate site or Artifact needed, since
// this is same-origin to the Worker's own API. It can view + set
// LATEST_VERSION and UPDATE_REQUIRED, view today's daily code, and
// trigger the Slack post on demand, all through the /admin/* endpoints
// above (same ADMIN_PASSWORD secret as everything else admin-only). It
// also renders a live mini-preview of the extension's own UI (header,
// search bar, update banner / hard-block screen) that updates as you type
// — before you even hit Save — so you can see exactly what the team will
// see for a given Latest version / Update required combination, against a
// simulated installed version you enter.
//
// LATEST_VERSION/UPDATE_REQUIRED written from the page persist in a
// Workers KV namespace (the plain Variables are still read as a fallback
// if KV isn't set up, so nothing breaks before you add it) — one-time
// setup: Dashboard -> this worker -> Settings -> Bindings -> Add ->
// KV Namespace -> create a namespace (any name) -> bind it as variable
// name CONFIG. Until that binding exists, the page's status panel says so
// and the Save button on Release Control is disabled.

// Bump this string whenever you paste a new version into the dashboard —
// visiting GET /debug-env instantly confirms whether a deploy took effect.
const WORKER_VERSION = '2026-09-17-01';

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

// Where everyone downloads the extension from — the shared Drive folder,
// kept up to date in place rather than a new link per release.
const DOWNLOAD_URL = 'https://drive.google.com/drive/folders/19IvY2URiuri53L_eajvxjuGx2zl-ojZV';

export default {
  async fetch(request, env) {
    // CORS pre-flight — every route needs this handled first.
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
      return htmlResponse(ADMIN_PAGE_HTML);
    }

    if (request.method === 'GET' && url.pathname === '/debug-env') {
      const config = await getConfig(env);
      return cors(JSON.stringify({
        version: WORKER_VERSION,
        hasSlackToken: !!env.SLACK_BOT_TOKEN,
        hasOpenAiKey: !!env.OPENAI_API_KEY,
        hasAdminPassword: !!env.ADMIN_PASSWORD,
        hasDailyCodeSecret: !!env.DAILY_CODE_SECRET,
        hasAdminMasterCode: !!env.ADMIN_MASTER_CODE,
        hasConfigKv: !!env.CONFIG,
        slackChannelId: SLACK_CHANNEL_ID,
        dailyCodeChannelId: DAILY_CODE_CHANNEL_ID,
        latestVersion: config.latestVersion,
        updateRequired: config.updateRequired,
      }), 200);
    }

    if (request.method === 'POST' && url.pathname === '/confirm-flag') {
      return handleConfirmFlag(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify') {
      return handleVerify(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/admin/send-daily-code') {
      return handleAdminSendDailyCode(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/admin/config') {
      return handleAdminGetConfig(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/admin/set-config') {
      return handleAdminSetConfig(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify-code') {
      return handleVerifyCode(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify-admin-code') {
      return handleVerifyAdminCode(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/latest-version') {
      // Not secret — the version number and download link are fine to
      // expose with no auth. Absence of a configured version means "no
      // update being announced right now".
      const config = await getConfig(env);
      return cors(JSON.stringify({
        latestVersion: config.latestVersion,
        downloadUrl: DOWNLOAD_URL,
        updateRequired: config.updateRequired,
        // Only sent when the admin has both written AND enabled a custom
        // message — otherwise null, so the extension falls back to its
        // own built-in default wording.
        message: (config.updateMessageEnabled && config.updateMessage) ? config.updateMessage : null,
      }), 200);
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
  },
};

// ── Daily instructions-unlock code ──────────────────────────────────────────

// Deterministic 6-digit code from HMAC(secret, today's IST date) — same
// input always produces the same code within a day, and a different one
// the next, with nothing to store or expire.
async function computeDailyCode(env, dateStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.DAILY_CODE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dateStr));
  const bytes = new Uint8Array(sig);
  let num = 0;
  for (let i = 0; i < 4; i++) num = (num << 8) | bytes[i];
  num = (num >>> 0) % 1000000;
  return String(num).padStart(6, '0');
}

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); // YYYY-MM-DD
}

// Posts today's code to the Slack channel. Shared by the daily cron trigger
// and the manual /admin/send-daily-code endpoint (for testing without
// waiting for the schedule to fire).
async function sendDailyCodeToSlack(env) {
  const steps = [];
  const logStep = (step, ok, detail) => steps.push({ step, ok, detail, at: new Date().toISOString() });

  if (!env.SLACK_BOT_TOKEN || !env.DAILY_CODE_SECRET) {
    logStep('check_config', false, 'SLACK_BOT_TOKEN or DAILY_CODE_SECRET secret not set');
    return { ok: false, error: 'Worker misconfigured', steps };
  }

  const date = todayIST();
  const code = await computeDailyCode(env, date);
  const text = `:key: *Today's Booking Assistant instructions code:* \`${code}\`\n_Valid for ${date} (IST) only — type it as \`${code}-<booking ID>\` in the Booking ID box to unlock a gated booking's instructions._`;

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
    return { ok: data.ok === true, error: data.ok ? null : data.error, date, steps };
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

// ── Admin config (Release Control) ──────────────────────────────────────────
// Read/write LATEST_VERSION + UPDATE_REQUIRED at runtime via a Workers KV
// binding (env.CONFIG) so the admin page can change them without touching
// the Dashboard. Falls back to the plain env Variables when KV isn't bound
// yet or has no value for a key, so nothing breaks before that's set up.
async function getConfig(env) {
  let latestVersion = null;
  let updateRequired = false;
  let updateMessage = '';
  let updateMessageEnabled = false;
  let kvHasVersion = false;
  let kvHasRequired = false;

  if (env.CONFIG) {
    try {
      const [lv, ur, um, ume] = await Promise.all([
        env.CONFIG.get('latestVersion'),
        env.CONFIG.get('updateRequired'),
        env.CONFIG.get('updateMessage'),
        env.CONFIG.get('updateMessageEnabled'),
      ]);
      if (lv !== null) { latestVersion = lv; kvHasVersion = true; }
      if (ur !== null) { updateRequired = ur === 'true'; kvHasRequired = true; }
      if (um !== null) updateMessage = um;
      if (ume !== null) updateMessageEnabled = ume === 'true';
    } catch (_) {
      // KV read failed — fall through to the plain-Variable fallback below.
    }
  }

  if (!kvHasVersion && env.LATEST_VERSION) latestVersion = env.LATEST_VERSION;
  if (!kvHasRequired && env.UPDATE_REQUIRED === 'true') updateRequired = true;

  return { latestVersion, updateRequired, updateMessage, updateMessageEnabled };
}

async function handleAdminGetConfig(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_PASSWORD secret' }), 500);
  }
  const password = url.searchParams.get('password') || '';
  if (password !== env.ADMIN_PASSWORD) {
    return cors(JSON.stringify({ error: 'Wrong password' }), 401);
  }

  const config = await getConfig(env);
  let dailyCode = null, dailyCodeDate = null;
  if (env.DAILY_CODE_SECRET) {
    dailyCodeDate = todayIST();
    dailyCode = await computeDailyCode(env, dailyCodeDate);
  }

  return cors(JSON.stringify({
    ...config,
    dailyCode,
    dailyCodeDate,
    workerVersion: WORKER_VERSION,
    hasConfigKv: !!env.CONFIG,
    hasSlackToken: !!env.SLACK_BOT_TOKEN,
    hasOpenAiKey: !!env.OPENAI_API_KEY,
    hasDailyCodeSecret: !!env.DAILY_CODE_SECRET,
    hasAdminMasterCode: !!env.ADMIN_MASTER_CODE,
    dailyCodeChannelId: DAILY_CODE_CHANNEL_ID,
  }), 200);
}

async function handleAdminSetConfig(request, env) {
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
      error: 'No CONFIG KV namespace bound — add one in Settings -> Bindings -> KV Namespace, bind it as CONFIG',
    }), 500);
  }

  if (typeof body.latestVersion === 'string') {
    await env.CONFIG.put('latestVersion', body.latestVersion.trim());
  }
  if (typeof body.updateRequired === 'boolean') {
    await env.CONFIG.put('updateRequired', body.updateRequired ? 'true' : 'false');
  }
  if (typeof body.updateMessage === 'string') {
    await env.CONFIG.put('updateMessage', body.updateMessage);
  }
  if (typeof body.updateMessageEnabled === 'boolean') {
    await env.CONFIG.put('updateMessageEnabled', body.updateMessageEnabled ? 'true' : 'false');
  }

  const config = await getConfig(env);
  return cors(JSON.stringify({ ok: true, ...config }), 200);
}

async function handleVerifyCode(request, env) {
  if (!env.DAILY_CODE_SECRET) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the DAILY_CODE_SECRET secret' }), 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  const submitted = String(body.code || '').trim();
  const expected = await computeDailyCode(env, todayIST());
  return cors(JSON.stringify({ valid: submitted.length > 0 && submitted === expected }), 200);
}

// Static admin/testing master code — unlike the daily code, this never
// rotates on its own; rotate it by changing the ADMIN_MASTER_CODE secret.
async function handleVerifyAdminCode(request, env) {
  if (!env.ADMIN_MASTER_CODE) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — set the ADMIN_MASTER_CODE secret' }), 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }
  const submitted = String(body.code || '').trim();
  return cors(JSON.stringify({ valid: submitted.length > 0 && submitted === env.ADMIN_MASTER_CODE }), 200);
}

// ── /verify — AI screenshot verification ──────────────────────────────────────

async function handleVerify(request, env) {
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

  const { imageBase64, mimeType = 'image/png', facts = {} } = body;

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
6. Page type: this screenshot is EXPECTED to be a CHECKOUT / CART / PAYMENT page — showing the booking being entered and about to be confirmed on the vendor's site (an editable cart, guest/date/time selection, a "Pay now" or "Proceed to payment" button, a price breakdown), NOT an already-issued ticket or booking confirmation (a booking/ticket/confirmation number, a QR/barcode, "Booking Confirmed", a voucher). Checking the details only AFTER the booking is already placed defeats the entire purpose of catching mistakes before they happen, so this must be flagged whenever it happens.

Reply ONLY with valid JSON in this exact shape — no markdown, no extra text:
{"checks":[{"label":"Date","expected":"${date}","found":true},{"label":"Time","expected":"${time}","found":false}],"isCheckoutPage":true,"checkoutPageNote":""}

Rules:
- Only include a check for a field if its expected value above is non-empty.
- Set found to true only when the value is unambiguously present after applying the format-tolerance rules above.
- isCheckoutPage must be true when the screenshot is the expected checkout/cart/payment page, and false when it instead shows an already-confirmed/issued ticket (the case that needs to be flagged).
- checkoutPageNote: if isCheckoutPage is false, a short (under 15 words) reason why (e.g. "Shows a confirmed booking number and QR code — this is an issued ticket, not a checkout page"); otherwise an empty string.`;

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
        isCheckoutPage:   { type: 'boolean' },
        checkoutPageNote: { type: 'string' },
      },
      required: ['checks', 'isCheckoutPage', 'checkoutPageNote'],
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
          model: 'gpt-4o',
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

  return cors(JSON.stringify({ ...result, steps }), 200);
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
  .layout { max-width: 1080px; margin: 0 auto; display: flex; gap: 20px; align-items: flex-start; }
  .col-left { flex: 1 1 480px; min-width: 0; }
  .col-right { flex: 0 0 380px; position: sticky; top: 24px; }
  @media (max-width: 900px) {
    .layout { flex-direction: column; }
    .col-right { position: static; width: 100%; }
  }
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
  input[type=password], input[type=text], textarea {
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
  .live-line {
    display: flex; justify-content: space-between; align-items: center;
    background: #14151a; border: 1px solid #2a2c35; border-radius: 7px;
    padding: 8px 10px; font-size: 12px; color: #b0b0ba; margin-bottom: 14px;
  }
  .live-line b { color: #e6e6ea; }
  #dashboard { display: none; }
  a { color: #5865f2; }

  /* ── Extension preview — a scaled-down faithful copy of popup.css ──── */
  .preview-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .preview-head h2 { margin: 0; }
  .preview-theme-toggle { display: flex; gap: 4px; }
  .preview-verdict {
    font-size: 12.5px; color: #b0b0ba; margin-top: 12px; line-height: 1.55;
    background: #14151a; border: 1px solid #2a2c35; border-radius: 7px; padding: 10px 12px;
  }
  .preview-verdict b { color: #e6e6ea; }
  .ext-frame {
    width: 100%; max-width: 360px; margin: 0 auto;
    border-radius: 14px; overflow: hidden; border: 1px solid #000;
    box-shadow: 0 8px 30px rgba(0,0,0,0.35);
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  .ext-frame[data-theme="light"] {
    --x-bg: #f4f2fb; --x-surface: #ffffff; --x-surface2: #f6f3fd; --x-border: #e8e3f3;
    --x-accent: #7c2ff0; --x-accent3: #6311cb; --x-green: #1a9d6e; --x-red: #e5484d;
    --x-text: #1c1535; --x-muted: #8a84a0; --x-header-bg: rgba(255,255,255,0.96);
  }
  .ext-frame[data-theme="dark"] {
    --x-bg: #130d22; --x-surface: rgba(32,24,52,0.88); --x-surface2: rgba(43,33,66,0.92); --x-border: rgba(255,255,255,0.07);
    --x-accent: #a979ff; --x-accent3: #8b5cf6; --x-green: #35d39b; --x-red: #f87171;
    --x-text: #ece8f6; --x-muted: #a8a2c4; --x-header-bg: rgba(19,13,34,0.95);
  }
  .ext-frame { background: var(--x-bg); color: var(--x-text); }
  .ext-header {
    background: var(--x-header-bg); border-bottom: 1px solid var(--x-border);
    padding: 8px 12px; display: flex; align-items: center; justify-content: space-between;
  }
  .ext-title { font-size: 12px; font-weight: 800; }
  .ext-sub { font-size: 9px; color: var(--x-muted); text-transform: uppercase; letter-spacing: .1em; font-weight: 600; }
  .ext-auth-pill {
    font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 20px;
    border: 1px solid var(--x-border); background: rgba(26,157,110,0.10); color: var(--x-green);
  }
  .ext-searchbar {
    padding: 7px 10px; background: var(--x-surface2); border-bottom: 1px solid var(--x-border);
    display: flex; gap: 6px; align-items: center;
  }
  .ext-input {
    flex: 1; min-width: 0; padding: 7px 10px; background: var(--x-bg); border: 1px solid var(--x-border);
    border-radius: 8px; color: var(--x-muted); font-size: 12px; font-family: 'JetBrains Mono', monospace;
  }
  .ext-btn {
    padding: 7px 10px; border: none; border-radius: 8px; font-size: 11px; font-weight: 700;
    white-space: nowrap;
  }
  .ext-btn-primary { background: linear-gradient(135deg, var(--x-accent), var(--x-accent3)); color: #fff; }
  .ext-btn-danger { background: transparent; color: var(--x-red); border: 1px solid var(--x-border); }
  .ext-update-banner {
    padding: 8px 12px; font-size: 11px; line-height: 1.5;
    background: rgba(229,72,77,0.08); border-bottom: 2px solid var(--x-red); color: var(--x-red); font-weight: 600;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .ext-banner-link {
    color: #fff; background: var(--x-red); flex-shrink: 0; padding: 3px 9px; border-radius: 6px;
    font-size: 10px; font-weight: 700; white-space: nowrap;
  }
  .ext-update-banner[hidden] { display: none !important; }
  .ext-body { min-height: 260px; display: flex; flex-direction: column; }
  .ext-placeholder {
    flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 40px 20px; color: var(--x-muted); font-size: 12px; line-height: 1.6;
  }
  .ext-gate {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 40px 20px; gap: 8px;
  }
  .ext-gate-icon { font-size: 36px; line-height: 1; margin-bottom: 4px; }
  .ext-gate-title { font-size: 14px; font-weight: 800; }
  .ext-gate-sub { font-size: 11.5px; color: var(--x-muted); line-height: 1.6; max-width: 250px; }
  .ext-gate-sub a { color: var(--x-accent); font-weight: 600; text-decoration: none; }
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
    <div class="col-left">
      <div id="kv-warning" class="warn-banner" style="display:none">
        No CONFIG KV namespace bound yet — Release Control is read-only (showing values from the plain env Variables). Bind one in Settings → Bindings → KV Namespace → name it <b>CONFIG</b> to make this page able to write changes.
      </div>

      <div class="card">
        <div class="card-head">
          <h2>🚀 Release control</h2>
          <button type="button" class="info-btn" data-info="release-control">i</button>
        </div>
        <div class="live-line">
          <span>Currently live for the team:</span>
          <span><b id="live-version">—</b> · <b id="live-required">—</b></span>
        </div>
        <label for="version-input">Latest version</label>
        <input type="text" id="version-input" placeholder="e.g. 10.5.0" />
        <div class="checkbox-row">
          <input type="checkbox" id="required-input" />
          <label for="required-input" style="margin:0">Update required (hard block instead of banner)</label>
          <button type="button" class="info-btn" data-info="update-required">i</button>
        </div>

        <div class="message-block">
          <div class="checkbox-row" style="margin-top:0">
            <input type="checkbox" id="message-enabled-input" />
            <label for="message-enabled-input" style="margin:0">Use a custom message</label>
            <button type="button" class="info-btn" data-info="update-message">i</button>
          </div>
          <p class="sub-label" id="message-default-hint">Off — the team sees the default wording shown below.</p>
          <textarea id="message-input" placeholder="🚨 A new version is available — please download the latest update." disabled></textarea>
        </div>

        <button id="save-config-btn">Save</button>
        <p class="msg" id="config-msg"></p>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>🔑 Daily instructions-unlock code</h2>
          <button type="button" class="info-btn" data-info="daily-code">i</button>
        </div>
        <div class="code-display" id="daily-code">——————</div>
        <p class="muted" id="daily-code-date"></p>
        <button class="secondary" id="send-slack-btn">Send to Slack now</button>
        <p class="msg" id="slack-msg"></p>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>🩺 Status</h2>
          <button type="button" class="info-btn" data-info="status">i</button>
        </div>
        <div class="status-grid" id="status-grid"></div>
      </div>
    </div>

    <div class="col-right">
      <div class="card">
        <div class="preview-head">
          <div class="card-head" style="margin-bottom:0">
            <h2>👁 Live preview</h2>
            <button type="button" class="info-btn" data-info="live-preview">i</button>
          </div>
          <div class="preview-theme-toggle">
            <button type="button" class="tiny secondary" id="preview-theme-light">☀️</button>
            <button type="button" class="tiny secondary" id="preview-theme-dark">🌙</button>
          </div>
        </div>
        <label for="sim-version-input">Simulate an installed version</label>
        <input type="text" id="sim-version-input" placeholder="e.g. 10.2.0 (blank = behind)" />

        <div class="ext-frame" id="ext-frame" data-theme="dark">
          <div class="ext-header">
            <div>
              <div class="ext-title">Booking Assistant</div>
              <div class="ext-sub">Box Office Tool</div>
            </div>
            <span class="ext-auth-pill">✓ authenticated</span>
          </div>
          <div class="ext-searchbar">
            <input class="ext-input" value="Booking ID…" disabled />
            <button class="ext-btn ext-btn-primary">⟳ Fetch</button>
            <button class="ext-btn ext-btn-danger">✕ Clear</button>
          </div>
          <div class="ext-update-banner" id="ext-update-banner" hidden>
            <span id="ext-banner-text">🚨 A new version is available — please download the latest update.</span>
            <span class="ext-banner-link">Download</span>
          </div>
          <div class="ext-body" id="ext-body">
            <div class="ext-placeholder">Booking details would show here as normal.</div>
          </div>
        </div>

        <p class="preview-verdict" id="preview-verdict"></p>
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
  var liveConfig = { latestVersion: null, updateRequired: false };
  var previewTheme = 'dark';

  function statusRow(label, ok) {
    return '<div><span>' + label + '</span><span><span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>' + (ok ? 'yes' : 'no') + '</span></div>';
  }

  // ── Info popovers — one shared element, positioned near whichever (i)
  // button was clicked; closes on outside click, Escape, or a second click
  // on the same button.
  var INFO_TEXT = {
    'release-control': 'Controls what your team\\'s extension shows for updates. Set Latest version to the version you want everyone on, then Save — every extension checks this the next time its panel opens.',
    'update-required': 'Off (default): a dismissable red banner nudges people to update, but the extension keeps working. On: anyone behind Latest version is fully blocked \\u2014 no booking lookup at all \\u2014 until they install the new version. Your own device stays exempt via the admin master code.',
    'update-message': 'By default the banner/block screen uses a fixed built-in sentence. Turn this on to replace it with your own wording (e.g. pointing at a specific fix, or a deadline) \\u2014 leave it off to just use the default, even while typing a draft here.',
    'daily-code': 'A 6-digit code that changes automatically every day, computed from a secret key \\u2014 nothing is stored, so it\\'s unpredictable without that key. It posts to Slack daily via a scheduled job. Typing it as code-bookingID in the Booking ID box unlocks that day\\'s gated Instructions for whoever has it.',
    'status': 'Shows which Cloudflare secrets and bindings this Worker can see \\u2014 never the values themselves, just whether each is configured. A red dot here usually explains a broken feature (e.g. no Slack token means Confirm & Flag can\\'t post).',
    'live-preview': 'A faithful mini-copy of the real extension UI. It updates as you type in Release control \\u2014 before you hit Save \\u2014 so you can check exactly what the team will see for a given Latest version / Update required / message combination.',
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

  // Same numeric per-segment comparison as the extension's isVersionOlder,
  // so the preview matches real behaviour exactly (e.g. 10.9.0 < 10.10.0).
  function isVersionOlder(a, b) {
    var pa = String(a || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = pa[i] || 0, nb = pb[i] || 0;
      if (na !== nb) return na < nb;
    }
    return false;
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var DEFAULT_BANNER_TEXT = '🚨 A new version is available — please download the latest update.';

  function renderPreview() {
    var latestVersion = document.getElementById('version-input').value.trim();
    var updateRequired = document.getElementById('required-input').checked;
    var messageEnabled = document.getElementById('message-enabled-input').checked;
    var messageText = document.getElementById('message-input').value.trim();
    var effectiveMessage = (messageEnabled && messageText) ? messageText : '';
    var simRaw = document.getElementById('sim-version-input').value.trim();
    var sim = simRaw || '0.0.0'; // blank = "assume it's behind", the common case being demoed
    var frame = document.getElementById('ext-frame');
    var banner = document.getElementById('ext-update-banner');
    var bannerText = document.getElementById('ext-banner-text');
    var body = document.getElementById('ext-body');
    var verdict = document.getElementById('preview-verdict');

    frame.setAttribute('data-theme', previewTheme);

    if (!latestVersion || !isVersionOlder(sim, latestVersion)) {
      banner.hidden = true;
      body.innerHTML = '<div class="ext-placeholder">Booking details would show here as normal — no update prompt.</div>';
      verdict.innerHTML = !latestVersion
        ? 'No <b>Latest version</b> set — nothing is announced right now.'
        : 'Simulated install <b>' + escHtml(simRaw || '(blank)') + '</b> is not behind <b>' + escHtml(latestVersion) + '</b> — extension looks completely normal.';
      return;
    }

    var messageNote = effectiveMessage ? ' using your custom message' : ' using the default message';

    if (updateRequired) {
      banner.hidden = true;
      var gateBody = effectiveMessage ? escHtml(effectiveMessage) : ('Version ' + escHtml(latestVersion) + ' is required to keep using Booking Assistant.');
      body.innerHTML =
        '<div class="ext-gate">' +
          '<div class="ext-gate-icon">🚨</div>' +
          '<div class="ext-gate-title">Update required</div>' +
          '<div class="ext-gate-sub">' + gateBody + '<br><a>Download the latest version</a>, then reload the extension.</div>' +
        '</div>';
      verdict.innerHTML = 'Simulated install <b>' + escHtml(simRaw || '(behind)') + '</b> is behind <b>' + escHtml(latestVersion) + '</b> and <b>Update required</b> is ON → full-screen block' + messageNote + ', extension unusable until updated. (The Booking ID box itself stays enabled the whole time — only the admin master code still works through it.)';
    } else {
      banner.hidden = false;
      bannerText.textContent = effectiveMessage || DEFAULT_BANNER_TEXT;
      body.innerHTML = '<div class="ext-placeholder">Booking details would still show here as normal — the banner is dismissable by updating, not blocking.</div>';
      verdict.innerHTML = 'Simulated install <b>' + escHtml(simRaw || '(behind)') + '</b> is behind <b>' + escHtml(latestVersion) + '</b> and <b>Update required</b> is OFF → dismissable red banner only' + messageNote + ', extension stays fully usable.';
    }
  }

  document.getElementById('preview-theme-light').addEventListener('click', function () { previewTheme = 'light'; renderPreview(); });
  document.getElementById('preview-theme-dark').addEventListener('click', function () { previewTheme = 'dark'; renderPreview(); });
  ['version-input', 'sim-version-input', 'message-input'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', renderPreview);
  });
  document.getElementById('required-input').addEventListener('change', renderPreview);
  document.getElementById('message-enabled-input').addEventListener('change', function () {
    var on = this.checked;
    document.getElementById('message-input').disabled = !on;
    document.getElementById('message-default-hint').textContent = on
      ? 'On — the team will see your text below instead of the default.'
      : 'Off — the team sees the default wording shown below.';
    renderPreview();
  });

  function render(cfg) {
    document.getElementById('worker-version').textContent = cfg.workerVersion || '—';
    document.getElementById('version-input').value = cfg.latestVersion || '';
    document.getElementById('required-input').checked = !!cfg.updateRequired;
    document.getElementById('message-input').value = cfg.updateMessage || '';
    document.getElementById('message-enabled-input').checked = !!cfg.updateMessageEnabled;
    document.getElementById('message-input').disabled = !cfg.updateMessageEnabled;
    document.getElementById('message-default-hint').textContent = cfg.updateMessageEnabled
      ? 'On — the team will see your text below instead of the default.'
      : 'Off — the team sees the default wording shown below.';
    document.getElementById('daily-code').textContent = cfg.dailyCode || 'not configured';
    document.getElementById('daily-code-date').textContent = cfg.dailyCodeDate ? ('for ' + cfg.dailyCodeDate + ' (IST) — posts automatically to the Slack channel via the cron trigger') : '';
    document.getElementById('kv-warning').style.display = cfg.hasConfigKv ? 'none' : 'block';
    document.getElementById('save-config-btn').disabled = !cfg.hasConfigKv;
    document.getElementById('status-grid').innerHTML =
      statusRow('Slack token', cfg.hasSlackToken) +
      statusRow('OpenAI key', cfg.hasOpenAiKey) +
      statusRow('Daily code secret', cfg.hasDailyCodeSecret) +
      statusRow('Admin master code', cfg.hasAdminMasterCode) +
      statusRow('CONFIG KV bound', cfg.hasConfigKv);

    liveConfig = { latestVersion: cfg.latestVersion || null, updateRequired: !!cfg.updateRequired };
    document.getElementById('live-version').textContent = liveConfig.latestVersion || 'none set';
    document.getElementById('live-required').textContent = liveConfig.updateRequired ? 'hard block ON' : 'banner only';
    renderPreview();
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
        dashboard.style.display = 'flex';
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

  document.getElementById('save-config-btn').addEventListener('click', function () {
    var msg = document.getElementById('config-msg');
    msg.textContent = 'Saving…'; msg.className = 'msg';
    fetch('/admin/set-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: password,
        latestVersion: document.getElementById('version-input').value.trim(),
        updateRequired: document.getElementById('required-input').checked,
        updateMessage: document.getElementById('message-input').value.trim(),
        updateMessageEnabled: document.getElementById('message-enabled-input').checked,
      }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) { msg.textContent = r.data.error || 'Save failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Saved — now live for the whole team.'; msg.className = 'msg ok';
        render(Object.assign({ workerVersion: document.getElementById('worker-version').textContent }, r.data));
      })
      .catch(function (err) { msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err'; });
  });

  document.getElementById('send-slack-btn').addEventListener('click', function () {
    var msg = document.getElementById('slack-msg');
    msg.textContent = 'Sending…'; msg.className = 'msg';
    fetch('/admin/send-daily-code?password=' + encodeURIComponent(password))
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok || !r.data.ok) { msg.textContent = (r.data && r.data.error) || 'Failed'; msg.className = 'msg err'; return; }
        msg.textContent = 'Posted to Slack.'; msg.className = 'msg ok';
      })
      .catch(function (err) { msg.textContent = 'Request failed: ' + err.message; msg.className = 'msg err'; });
  });

  var savedPw = null;
  try { savedPw = sessionStorage.getItem('bassAdminPw'); } catch (_) {}
  if (savedPw) unlock(savedPw, { silent: true });
})();
</script>
</body>
</html>`;
