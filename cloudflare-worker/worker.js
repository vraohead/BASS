// BASS Verify Worker — proxies screenshot AI verification and the
// Confirm & Flag Slack notification, so the OpenAI key and Slack bot
// token stay on Cloudflare, never in the extension.
//
// Deploy:
//   wrangler deploy
//   wrangler secret put OPENAI_API_KEY   ← paste key when prompted
//   wrangler secret put SLACK_BOT_TOKEN  ← paste Slack bot token when prompted
//
// POST /verify        { imageBase64, mimeType, facts } -> { checks: [...] }
// POST /confirm-flag   { bookingId, agentEmail, confirmed, skipped, imageBase64?, mimeType?, verifiedAt } -> { ok: true }

// Not sensitive, so hardcoded here rather than as an env var/secret —
// change this if the target Slack channel ever changes.
const SLACK_CHANNEL_ID = 'C0BV91K7F70';

export default {
  async fetch(request, env) {
    // CORS pre-flight
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/debug-env') {
      return cors(JSON.stringify({
        hasSlackToken: !!env.SLACK_BOT_TOKEN,
        hasOpenAiKey: !!env.OPENAI_API_KEY,
        slackChannelId: SLACK_CHANNEL_ID,
      }), 200);
    }

    if (request.method === 'POST' && url.pathname === '/confirm-flag') {
      return handleConfirmFlag(request, env);
    }

    if (request.method !== 'POST' || url.pathname !== '/verify') {
      return cors(JSON.stringify({ error: 'Not found' }), 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
    }

    const { imageBase64, mimeType = 'image/png', facts = {} } = body;

    if (!imageBase64) {
      return cors(JSON.stringify({ error: 'imageBase64 is required' }), 400);
    }

    if (!env.OPENAI_API_KEY) {
      return cors(
        JSON.stringify({ error: 'Worker misconfigured — run: wrangler secret put OPENAI_API_KEY' }),
        500
      );
    }

    const { date = '', time = '', pax = '', price = '' } = facts;

    const factLines = [
      date  ? `Date: ${date}`       : null,
      time  ? `Time: ${time}`       : null,
      pax   ? `Pax (guests): ${pax}` : null,
      price ? `Net price: ${price}` : null,
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

    const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                  detail: 'low',
                },
              },
            ],
          },
        ],
      }),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      return cors(JSON.stringify({ error: `OpenAI error ${oaiRes.status}: ${errText}` }), 502);
    }

    const oaiData = await oaiRes.json();
    const content = oaiData.choices?.[0]?.message?.content?.trim() || '';

    let result;
    try {
      result = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { result = JSON.parse(m[0]); }
        catch { return cors(JSON.stringify({ error: 'Could not parse AI response', raw: content }), 502); }
      } else {
        return cors(JSON.stringify({ error: 'Unexpected AI response format', raw: content }), 502);
      }
    }

    return cors(JSON.stringify(result), 200);
  },
};

async function handleConfirmFlag(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400);
  }

  const {
    bookingId, agentEmail, confirmed = [], skipped = [],
    imageBase64, mimeType = 'image/png', verifiedAt,
  } = body;

  if (!env.SLACK_BOT_TOKEN) {
    return cors(JSON.stringify({ error: 'Worker misconfigured — run: wrangler secret put SLACK_BOT_TOKEN' }), 500);
  }

  const lines = [
    ':white_check_mark: *Booking Verification Confirmed*',
    `*Booking ID:* ${bookingId || 'n/a'}`,
    `*Confirmed by:* ${agentEmail || 'unknown'}`,
    confirmed.length
      ? `*Matched:* ${confirmed.map(c => `${c.label}: ${c.value}`).join('  |  ')}`
      : null,
    skipped.length
      ? `*Skipped (mismatch acknowledged):* ${skipped.map(c => `${c.label}: ${c.value}`).join('  |  ')}`
      : null,
    verifiedAt ? `*At:* ${verifiedAt}` : null,
  ].filter(Boolean).join('\n');

  // If there's a screenshot, try posting it as ONE unified message (image +
  // text together via initial_comment) rather than a separate text message
  // followed by a threaded file reply. Falls back to a plain text message
  // if there's no image, or if the image upload/attach fails at any step.
  let screenshotError = null;
  let posted = false;

  if (imageBase64) {
    try {
      const binary = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const filename = `verify-${bookingId || 'screenshot'}.${ext}`;

      const uploadUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ filename, length: String(binary.length) }),
      });
      const uploadUrlData = await uploadUrlRes.json();

      if (!uploadUrlData.ok) {
        screenshotError = `files.getUploadURLExternal failed: ${uploadUrlData.error}`;
      } else {
        const putRes = await fetch(uploadUrlData.upload_url, { method: 'POST', body: binary });
        if (!putRes.ok) {
          screenshotError = `Upload PUT failed: HTTP ${putRes.status}`;
        } else {
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
          if (!completeData.ok) {
            screenshotError = `files.completeUploadExternal failed: ${completeData.error}`;
          } else {
            posted = true;
          }
        }
      }
    } catch (err) {
      screenshotError = `Exception: ${err.message}`;
    }
  }

  if (!posted) {
    const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text: lines }),
    });
    const msgData = await msgRes.json();
    if (!msgData.ok) {
      return cors(JSON.stringify({ error: `Slack chat.postMessage failed: ${msgData.error}` }), 502);
    }
  }

  return cors(JSON.stringify({ ok: true, screenshotError }), 200);
}

function cors(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
