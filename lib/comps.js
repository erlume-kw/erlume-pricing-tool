import { usdToKwd } from './pricing.js';
import { geminiJSON, hasGemini } from './gemini.js';

const EBAY_HANDBAGS_CATEGORY = '169291'; // Women's Bags & Handbags
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Source dispatcher: prefer eBay's OFFICIAL Browse API (sanctioned, free) when
// EBAY_CLIENT_ID/SECRET are set; otherwise fall back to SerpApi.
// ---------------------------------------------------------------------------
export async function searchEbay(query, config, limit = 25) {
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
    return searchEbayBrowse(query, config, limit);
  }
  if (process.env.SERPAPI_KEY) {
    return searchSerpApi(query, config, limit);
  }
  return { available: false, items: [] };
}

// ---------------------------------------------------------------------------
// eBay Browse API — official, sanctioned source (developer.ebay.com).
// OAuth client-credentials token, then item_summary/search in the Handbags
// category. Returns ACTIVE listings (asking prices). Sold/completed data needs
// the restricted Marketplace Insights API — the manual "eBay sold" link covers that.
// ---------------------------------------------------------------------------
let ebayToken = { token: null, expires: 0 };

async function getEbayToken() {
  if (ebayToken.token && Date.now() < ebayToken.expires - 60_000) return ebayToken.token;
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return null;

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) throw new Error(`eBay OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  ebayToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return ebayToken.token;
}

async function searchEbayBrowse(query, config, limit = 25) {
  const token = await getEbayToken();
  if (!token) return { available: false, items: [] };

  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('category_ids', EBAY_HANDBAGS_CATEGORY);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE|AUCTION}');

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });
  if (!res.ok) throw new Error(`eBay search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const items = (data.itemSummaries || [])
    .filter((it) => it.price?.value && it.price.currency === 'USD')
    .slice(0, limit)
    .map((it) => {
      const usd = Number(it.price.value);
      return {
        title: it.title,
        priceUsd: usd,
        priceKwd: usdToKwd(usd, config),
        condition: it.condition || 'Unknown',
        url: it.itemWebUrl,
        image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
        source: 'eBay',
      };
    });

  return { available: true, items };
}

// ---------------------------------------------------------------------------
// eBay comps via SerpApi (fallback). One API key, no OAuth. Set SERPAPI_SOLD=1
// to pull SOLD prices (better comps than active listings).
// ---------------------------------------------------------------------------

// Pull a USD number out of a SerpApi price field, which may be a single value
// { extracted } or a range { from, to }.
function extractUsd(price) {
  if (!price) return null;
  if (typeof price.extracted === 'number') return price.extracted;
  if (price.from?.extracted != null && price.to?.extracted != null) {
    return (price.from.extracted + price.to.extracted) / 2;
  }
  if (price.from?.extracted != null) return price.from.extracted;
  if (price.raw) {
    const n = parseFloat(String(price.raw).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

async function searchSerpApi(query, config, limit = 25) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return { available: false, items: [] };

  const sold = process.env.SERPAPI_SOLD === '1';

  function buildUrl(freshScrape) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'ebay');
    url.searchParams.set('ebay_domain', 'ebay.com'); // USD prices
    url.searchParams.set('_nkw', query);
    url.searchParams.set('_sacat', EBAY_HANDBAGS_CATEGORY);
    url.searchParams.set('api_key', key);
    if (sold) {
      url.searchParams.set('LH_Sold', '1');
      url.searchParams.set('LH_Complete', '1');
    }
    // eBay intermittently returns an empty page to scrapers; forcing a fresh
    // scrape on retries reliably recovers the results.
    if (freshScrape) url.searchParams.set('no_cache', 'true');
    return url;
  }

  // Up to 3 attempts: eBay's "no results" is often a transient empty page.
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(buildUrl(attempt > 0));
    if (!res.ok) throw new Error(`SerpApi eBay search failed: ${res.status} ${await res.text()}`);
    data = await res.json();
    if (data.organic_results?.length) break; // got results
    const transientEmpty = /hasn't returned any results/i.test(data.error || '');
    if (data.error && !transientEmpty) throw new Error(`SerpApi: ${data.error}`);
    if (attempt < 2) await sleep(700); // brief pause, then force a fresh scrape
  }

  const items = (data?.organic_results || [])
    .slice(0, limit)
    .map((it) => {
      const usd = extractUsd(it.price);
      if (usd == null) return null;
      return {
        title: it.title,
        priceUsd: usd,
        priceKwd: usdToKwd(usd, config),
        condition: it.condition || (sold ? 'Sold' : 'Unknown'),
        url: it.link,
        image: it.thumbnail || null,
        source: sold ? 'eBay sold (SerpApi)' : 'eBay (SerpApi)',
      };
    })
    .filter(Boolean);

  return { available: true, items };
}

// ---------------------------------------------------------------------------
// Manual fallback links (never scrape these sites programmatically)
// ---------------------------------------------------------------------------

export function fallbackLinks(query) {
  const q = encodeURIComponent(query);
  return [
    { name: 'eBay sold listings', url: `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1` },
    { name: 'The Luxury Closet', url: `https://theluxurycloset.com/search?q=${q}` },
    { name: 'Vestiaire Collective', url: `https://www.vestiairecollective.com/search/?q=${q}` },
  ];
}

// ---------------------------------------------------------------------------
// Similarity ranking — Haiku picks the 3 closest matches; falls back to a
// heuristic score if the API is unavailable.
// ---------------------------------------------------------------------------

// Gemini responseSchema — UPPERCASE OpenAPI type names.
const RANK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    matches: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER', description: '0-based index into the candidate list' },
          similarityNote: { type: 'STRING', description: 'One short sentence: why this comp matches (model/size/condition/material/color).' },
        },
        required: ['index', 'similarityNote'],
        propertyOrdering: ['index', 'similarityNote'],
      },
    },
  },
  required: ['matches'],
  propertyOrdering: ['matches'],
};

export async function rankComps(target, candidates, topN = 3) {
  if (!candidates.length) return [];
  if (candidates.length <= topN) {
    return candidates.map((c) => ({ ...c, similarityNote: 'One of the few available matches.' }));
  }

  if (hasGemini()) {
    try {
      const listing = candidates
        .map((c, i) => `${i}: ${c.title} | ${c.condition} | ${c.priceKwd} KWD`)
        .join('\n');
      const prompt =
        `Target bag: brand="${target.brand}", model="${target.model}", size="${target.size || 'unknown'}", ` +
        `material="${target.material || 'unknown'}", color="${target.color || 'unknown'}", condition="${target.condition || 'unknown'}".\n\n` +
        `Candidate resale listings:\n${listing}\n\n` +
        `Pick the ${topN} listings most similar to the target. HARD REQUIREMENT: same model (and same size when stated in the title). ` +
        `Then prefer matching condition, then material, then color. Exclude listings for a different model, dust-bag-only, straps, or replicas. ` +
        `Return fewer than ${topN} if fewer truly match.`;
      const { matches } = await geminiJSON([{ text: prompt }], RANK_SCHEMA);
      const picked = (matches || [])
        .filter((m) => candidates[m.index])
        .slice(0, topN)
        .map((m) => ({ ...candidates[m.index], similarityNote: m.similarityNote }));
      if (picked.length) return picked;
    } catch (err) {
      console.warn('Gemini ranking failed, using heuristic:', err.message);
    }
  }

  return heuristicRank(target, candidates, topN);
}

export function heuristicRank(target, candidates, topN = 3) {
  const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const modelTokens = tokens(`${target.brand} ${target.model}`);
  const scored = candidates.map((c) => {
    const title = String(c.title || '').toLowerCase();
    let score = 0;
    for (const t of modelTokens) if (title.includes(t)) score += 2;
    if (target.size && title.includes(String(target.size).toLowerCase())) score += 2;
    if (target.color && title.includes(String(target.color).toLowerCase())) score += 1;
    if (target.material && title.includes(String(target.material).toLowerCase())) score += 1;
    return { ...c, _score: score, similarityNote: 'Heuristic title match (Claude ranking unavailable).' };
  });
  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, topN)
    .map(({ _score, ...c }) => c);
}

// ---------------------------------------------------------------------------
// Listing mode — AI picks a price point WITHIN the formula's band and explains
// why, informed by the categorization and any comps. Falls back to the band
// midpoint if the AI is unavailable.
// ---------------------------------------------------------------------------

const POINT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    price: { type: 'NUMBER', description: 'Suggested price in KWD, within [low, high].' },
    reason: { type: 'STRING', description: 'One short sentence justifying where in the band you landed.' },
  },
  required: ['price', 'reason'],
  propertyOrdering: ['price', 'reason'],
};

/**
 * @param {object} item   { brand, model, attrs, compAvg }
 * @param {object} range  { low, mid, high } from listingRange()
 * @returns {Promise<{price:number, reason:string}>}
 */
export async function pickListingPrice(item, range) {
  if (hasGemini()) {
    try {
      const attrs = Object.entries(item.attrs || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const prompt =
        `We are pricing a pre-loved luxury bag that erlume is buying to resell.\n` +
        `Item: brand="${item.brand || 'unknown'}", model="${item.model || 'unknown'}".\n` +
        `Categorization: ${attrs || 'none'}.\n` +
        (item.compAvg != null ? `Average of resale comps: ${item.compAvg} KWD.\n` : 'No resale comps found.\n') +
        `The pricing formula gives an allowed band of ${range.low} to ${range.high} KWD (midpoint ${range.mid}).\n\n` +
        `Choose the single best suggested price. You MUST stay within [${range.low}, ${range.high}]. ` +
        `Lean higher for rare/vintage/trendy/premium-material/like-new items and when comps support it; lean lower otherwise. ` +
        `Give one short sentence of reasoning.`;
      const out = await geminiJSON([{ text: prompt }], POINT_SCHEMA);
      return { price: out.price, reason: out.reason };
    } catch (err) {
      console.warn('Gemini price-point pick failed, using band midpoint:', err.message);
    }
  }
  return { price: range.mid, reason: 'Band midpoint (AI unavailable).' };
}
