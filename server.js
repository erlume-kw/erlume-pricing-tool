import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.js';
import { priceBag, resolveBrandTier, mean, listingRange, clampToRange } from './lib/pricing.js';
import { identifyBag } from './lib/identify.js';
import { searchEbay, rankComps, fallbackLinks, pickListingPrice } from './lib/comps.js';
import * as pricelog from './lib/pricelog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
});

// Interleave two comp sources (primary first, then secondary) so both are
// represented in the final set, up to `n` items. If one source is empty the
// other fills all slots.
function blendComps(primary = [], secondary = [], n = 3) {
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < n && (i < primary.length || j < secondary.length)) {
    if (i < primary.length) out.push(primary[i++]);
    if (out.length < n && j < secondary.length) out.push(secondary[j++]);
  }
  return out;
}

// --- Config (editable in config.json; exposed so the UI shows live values) ---
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

// --- Step A: identify from photos -------------------------------------------
app.post('/api/identify', upload.array('photos', 3), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Upload 1–3 photos.' });
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured — fill in brand/model manually.' });
    }
    const result = await identifyBag(req.files, { brand: req.body.brand, model: req.body.model });
    const config = loadConfig();
    result.brandTier = resolveBrandTier(result.brand || req.body.brand, config);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Step B: find 3 comps ----------------------------------------------------
app.post('/api/comps', async (req, res) => {
  try {
    const { brand, model, size, material, color, condition } = req.body;
    if (!brand || !model) return res.status(400).json({ error: 'brand and model are required.' });

    const config = loadConfig();
    const query = [brand, model, size].filter(Boolean).join(' ');

    // 1. Internal price log first — our own comp database.
    const internal = pricelog.findComps(brand, model).map((e) => ({
      title: `${e.brand} ${e.model}${e.size ? ' ' + e.size : ''} (priced ${e.createdAt.slice(0, 10)})`,
      priceKwd: e.listingPrice,
      condition: e.condition || 'Unknown',
      url: null,
      source: 'erlume price log',
      similarityNote: 'Previously priced by erlume.',
    }));

    // 2. eBay Browse API.
    let ebay = { available: false, items: [] };
    let ebayError = null;
    try {
      ebay = await searchEbay(query, config);
    } catch (err) {
      console.error('eBay search failed:', err.message);
      ebayError = err.message;
    }

    // 3. Rank external candidates down to the 3 closest.
    const target = { brand, model, size, material, color, condition };
    const ranked = await rankComps(target, ebay.items, 3);

    // 4. Blend both sources so eBay market data and our own log are BOTH
    //    represented — interleave eBay-first, then fill from whichever remains.
    const comps = blendComps(ranked, internal, 3);
    const compAvg = mean(comps.map((c) => c.priceKwd));

    res.json({
      query,
      comps,
      avgKwd: compAvg,
      enoughComps: comps.length >= 2,
      ebayAvailable: ebay.available,
      ebayError,
      fallbackLinks: fallbackLinks(query),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Step C: run the pricing formula ------------------------------------------
app.post('/api/price', (req, res) => {
  try {
    const config = loadConfig();
    const input = { ...req.body };
    if (!input.brandTier && input.brand) input.brandTier = resolveBrandTier(input.brand, config);
    const result = priceBag(input, config);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- erlume listing pricing (items we BUY) — hybrid: formula band + AI point --
app.post('/api/listing', async (req, res) => {
  try {
    const config = loadConfig();
    const { startingPrice, deliveryFee = 0, cleaningCost = 0, brand, model, compAvg } = req.body;
    if (startingPrice == null || Number.isNaN(Number(startingPrice))) {
      return res.status(400).json({ error: 'startingPrice is required.' });
    }

    // Categorization attributes → suggested-price band.
    const attrs = {
      rare: req.body.rare,
      vintage: req.body.vintage,
      trendy: req.body.trendy,
      seasonal: req.body.seasonal,
      material: req.body.material,
      condition: req.body.condition,
      brand: req.body.brandTier || (brand ? resolveBrandTier(brand, config) : 'highstreet'),
    };
    const range = listingRange(startingPrice, attrs, config);

    // Decide the market value one of three ways:
    //  1. chosenValue supplied → staff typed/nudged it manually (clamped to band)
    //  2. mode === 'manual'    → formula only, use the band midpoint (no AI, instant)
    //  3. otherwise            → AI picks a point in the band and explains why
    let suggestedMarketValue;
    let aiReason;
    let method;
    if (req.body.chosenValue != null && !Number.isNaN(Number(req.body.chosenValue))) {
      suggestedMarketValue = clampToRange(Number(req.body.chosenValue), range);
      aiReason = 'Manually set to ' + suggestedMarketValue + ' KWD (kept within the band).';
      method = 'manual-value';
    } else if (req.body.mode === 'manual') {
      suggestedMarketValue = range.mid;
      aiReason = 'Formula only — midpoint of the band. No AI used.';
      method = 'manual';
    } else {
      const pick = await pickListingPrice({ brand, model, attrs, compAvg }, range);
      suggestedMarketValue = clampToRange(pick.price, range);
      aiReason = pick.reason;
      method = 'ai';
    }

    // Reuse the core money math via the comp path (no retention/condition here).
    const priced = priceBag(
      { compPrice: suggestedMarketValue, pickupFee: Number(deliveryFee), cleaningCost: Number(cleaningCost) },
      config
    );

    res.json({ range, attrs, suggestedMarketValue, aiReason, method, ...priced });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// --- Price log -----------------------------------------------------------------
app.get('/api/log', (req, res) => {
  res.json(pricelog.listEntries());
});

app.post('/api/log', (req, res) => {
  const { brand, model, listingPrice } = req.body;
  if (!brand || !model || listingPrice == null) {
    return res.status(400).json({ error: 'brand, model and listingPrice are required.' });
  }
  res.status(201).json(pricelog.addEntry(req.body));
});

app.delete('/api/log/:id', (req, res) => {
  const ok = pricelog.deleteEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ deleted: true });
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`erlume pricing tool running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn('⚠ GEMINI_API_KEY not set — photo identification & AI ranking disabled.');
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) console.log('✓ eBay comps: official Browse API');
  else if (process.env.SERPAPI_KEY) console.log('✓ eBay comps: SerpApi (fallback)');
  else console.warn('⚠ No eBay source set (EBAY_CLIENT_ID/SECRET or SERPAPI_KEY) — comps use price log + manual links only.');
});
