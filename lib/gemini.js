// Google Gemini (free tier) — vision identification and comp ranking.
// Uses the REST API via native fetch so no extra SDK dependency is needed.
// Retries transient 429/500/503 errors and falls back across models, since
// preview models occasionally return 503 "high demand".

// Lead with the most accurate model, then fall back to lighter/lite models
// (which serve reliably when the full-flash models are overloaded with 503s).
// On 503 we skip to the next model immediately rather than waiting — so this
// auto-upgrades to the better model the moment Google's capacity recovers.
const PRIMARY = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const MODEL_CHAIN = [PRIMARY, 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite']
  .filter((m, i, arr) => arr.indexOf(m) === i);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hasGemini() {
  return !!process.env.GEMINI_API_KEY;
}

async function callModel(model, parts, schema, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
    }),
  });

  if (!res.ok) {
    const err = new Error(`Gemini ${model} error: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini ${model} returned no content.`);
  return JSON.parse(text);
}

/**
 * Call Gemini and get schema-constrained JSON back.
 * Retries transient errors on the same model, then falls back to the next model.
 * @param {Array} parts  Gemini content parts (text and/or inline_data images)
 * @param {object} schema  Gemini responseSchema (OpenAPI subset, uppercase types)
 */
export async function geminiJSON(parts, schema) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  let lastErr;
  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callModel(model, parts, schema, apiKey);
      } catch (err) {
        lastErr = err;
        // 400 = our request is wrong; retrying or switching models won't help.
        if (err.status === 400) throw err;
        // 404 (model gone) or 503 (overloaded) = don't wait, try the next model now.
        if (err.status === 404 || err.status === 503) break;
        // 429/500 = transient rate/server blip; back off and retry the same model.
        if (attempt < 2) await sleep(600 * (attempt + 1)); // 0.6s, then 1.2s
      }
    }
  }
  throw lastErr;
}
