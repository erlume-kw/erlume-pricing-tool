# erlume — AI Bag Pricing Tool

Internal tool for the erlume team: upload bag photos → Claude identifies the bag → find the 3 closest resale comps → run the **Pricing 3.0** formula → save to the internal price log.

## Quick start

```sh
npm install
copy .env.example .env   # then fill in the keys
npm start                # http://localhost:3200
```

Runs fine without keys (formula + manual search links only):

| Key | Enables |
|---|---|
| `GEMINI_API_KEY` | Step A photo identification + Step B comp ranking (Google Gemini `gemini-2.0-flash`, **free tier** — key at https://aistudio.google.com/apikey) |
| `SERPAPI_KEY` | Step B eBay comps via [SerpApi](https://serpapi.com/ebay-search-api) (free tier: 100 searches/mo). Set `SERPAPI_SOLD=1` to pull *sold* prices instead of active listings. |

## The flow

1. **Identify** — staff uploads 1–3 photos (+ optional brand/model to confirm). Gemini returns schema-constrained JSON `{brand, model, size, material, color, confidence, notes}`. Low confidence → UI asks staff to confirm. A photo of the inside label/serial stamp improves accuracy.
2. **Find comps** — checks the **internal price log first**, then eBay via SerpApi (`{brand} {model} {size}` in the Handbags category; optionally sold listings), converts USD→KWD (configurable rate, rounded to 0.5), and has Gemini pick the 3 closest matches (same model+size required; then condition, material, color). If nothing comes back, pre-filled manual search links are shown (eBay sold, The Luxury Closet, Vestiaire). **Do not scrape Vestiaire/Fashionphile/TheRealReal** — ToS + Cloudflare.
   - Note: the Browse API returns *active* listings; sold/completed data requires the restricted Marketplace Insights API. The "eBay sold" manual link covers that gap.
3. **Price it** — the median comp price (editable) feeds the formula; staff can override any value before saving.

## Pricing 3.0 formula (`lib/pricing.js` — keep in sync with the Notion calculator)

```
age = currentYear − yearPurchased          (unknown year → 4–5 yr bracket)
IF compPrice: marketValue = compPrice      (no retention, no condition deduction)
ELSE:         marketValue = originalPrice × retention[tier][ageBracket] × conditionFactor
base         = marketValue + pickupFee + cleaningCost
listingPrice = round0.5(base × 1.025)      (gateway buffer — shown externally as "logistics & handling")
erlumeCut    = max(0.20 × base, 10)
sellerPayout = base − erlumeCut
accept       = listingPrice ≥ 30
```

Ultra-luxury without comps triggers a warning — Hermès/Chanel often resell above retail, so always prefer comps there.

All constants (commission, buffer, retention table, condition factors, markdown schedule, USD→KWD rate, brand-tier lists) live in **`config.json`** — no hardcoding; edit after team meetings.

## Verify

```sh
npm test
```

Includes the spec's mandatory test case: premium bag, 400 KWD, 3 yrs, Gently Used, own driver →
market **216.00** → base **219.00** → listing **224.50** → cut **43.80** → payout **175.20** → ✅ Accept.

## API

| Route | What |
|---|---|
| `POST /api/identify` | multipart `photos[]` + optional `brand`,`model` → identification JSON |
| `POST /api/comps` | `{brand, model, size?, condition?}` → 3 comps + median KWD + fallback links |
| `POST /api/price` | formula inputs → full breakdown incl. markdown schedule |
| `GET/POST /api/log` | internal price log (`data/price-log.json`) |
| `GET /api/config` | current pricing config |

## Backoffice integration

This is a standalone Express app on purpose (easy to demo). To fold it into `erlume-backoffice`: mount the four routes above as a router, move `lib/` across as-is, and reuse the UI as a page — there is no session/auth logic to untangle. The price log is a JSON file; swap `lib/pricelog.js` for a DB table when integrating.
