// BASS Verify Worker — proxies screenshot AI verification so the OpenAI key
// stays on Cloudflare, never in the extension.
//
// Deploy:
//   wrangler deploy
//   wrangler secret put OPENAI_API_KEY   ← paste key when prompted
//
// The extension sends POST /verify with { imageBase64, mimeType, facts }
// and gets back { checks: [{ label, expected, found }] }

export default {
  async fetch(request, env) {
    // CORS pre-flight
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    const url = new URL(request.url);

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
