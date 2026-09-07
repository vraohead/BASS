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
//   GET  /debug-env      -> { hasSlackToken, hasOpenAiKey, slackChannelId, version }
//   POST /verify          { imageBase64, mimeType, facts } -> { checks: [...] }
//   POST /confirm-flag     { bookingId, agentEmail, confirmed, skipped,
//                            imageBase64?, mimeType?, verifiedAt }
//                          -> { ok: true, steps: [...], screenshotError? }
//
// Every meaningful operation (Slack calls, OpenAI calls) appends a
// {step, ok, detail, at} entry to a `steps` array that's returned in the
// JSON response — so a failure anywhere always comes back with the exact
// step name, HTTP status, and raw response body instead of a generic
// "something went wrong".

// Bump this string whenever you paste a new version into the dashboard —
// visiting GET /debug-env instantly confirms whether a deploy took effect.
const WORKER_VERSION = '2026-09-07-03';

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
// change this if the target Slack channel ever changes.
const SLACK_CHANNEL_ID = 'C0BV91K7F70';

export default {
  async fetch(request, env) {
    // CORS pre-flight — every route needs this handled first.
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/debug-env') {
      return cors(JSON.stringify({
        version: WORKER_VERSION,
        hasSlackToken: !!env.SLACK_BOT_TOKEN,
        hasOpenAiKey: !!env.OPENAI_API_KEY,
        slackChannelId: SLACK_CHANNEL_ID,
      }), 200);
    }

    if (request.method === 'POST' && url.pathname === '/confirm-flag') {
      return handleConfirmFlag(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify') {
      return handleVerify(request, env);
    }

    return cors(JSON.stringify({ error: 'Not found', version: WORKER_VERSION }), 404);
  },
};

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

  const { date = '', time = '', pax = '', price = '' } = facts;

  const factLines = [
    date  ? `Date: ${date}`        : null,
    time  ? `Time: ${time}`        : null,
    pax   ? `Pax (guests): ${pax}` : null,
    price ? `Net price: ${price}`  : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are checking a ticket or booking confirmation screenshot against a booking record.

Booking record:
${factLines}

For each field above, determine whether the exact value (or a clearly matching representation) is visible in the screenshot. Reply ONLY with valid JSON in this exact shape — no markdown, no extra text:
{"checks":[{"label":"Date","expected":"${date}","found":true},{"label":"Time","expected":"${time}","found":false}]}

Rules:
- Only include a check for a field if expected is non-empty.
- Set found to true only when the value is unambiguously readable in the image.
- For numeric pax/price, a match is true if the number appears clearly (ignore currency symbols for price match).`;

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
      },
      required: ['checks'],
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
