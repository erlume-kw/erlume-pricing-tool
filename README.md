# erlume — AI Bag Pricing Tool

Internal tool for the erlume team: upload bag photos → Gemini identifies the bag → find the 3 closest resale comps → run the **Pricing 3.0** formula → save to the internal price log → optionally raise a seller quote.

> **This repo is now only the UI.** All pricing logic (identify, comps, price, listing, price-log, quotes) lives in the **erlume backend** (`backend-1.0`) under the admin-only `/api/pricing-tool` namespace. `server.js` serves static files and nothing else.

## Quick start

```sh
npm install
npm start                # http://localhost:3200
```

The page needs a backend to talk to. Both settings are read at runtime — no rebuild, no `.env` here:

| Setting | How to set it | Default |
|---|---|---|
| Backend URL | `?api=<url>` in the address bar, or `localStorage.PRICING_API_BASE` | `http://127.0.0.1:3000` |
| Admin token | `localStorage.PRICING_TOKEN` — sent as `Authorization: Bearer …` | none — log in first |

`/api/pricing-tool` is admin-only, so a non-admin token gets 403 on every route.

**API keys live in the backend's `.env`, not here:** `GEMINI_API_KEY` (photo identification + comp ranking), `SERPAPI_KEY` / `SERPAPI_SOLD` (eBay comps), `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`.

## The flow

1. **Identify** — staff uploads 1–3 photos (+ optional brand/model to confirm). Gemini returns schema-constrained JSON `{brand, model, size, material, color, confidence, notes}`. Low confidence → the UI asks staff to confirm. A photo of the inside label/serial stamp improves accuracy.
2. **Find comps** — checks the internal price log first, then eBay (Browse API + SerpApi), converts USD→KWD, and has Gemini pick the 3 closest matches (same model+size required; then condition, material, color). If nothing comes back, pre-filled manual search links are shown (eBay sold, The Luxury Closet, Vestiaire). **Do not scrape Vestiaire/Fashionphile/TheRealReal** — ToS + Cloudflare.
   - Note: the Browse API returns *active* listings; sold/completed data requires the restricted Marketplace Insights API. The "eBay sold" manual link covers that gap, and `SERPAPI_SOLD=1` pulls sold prices through SerpApi.
3. **Price it** — the median comp price (editable) feeds the formula; staff can override any value before saving.
4. **Save / quote** — write the result to the price log, and optionally raise a seller quote (a Zoho **estimate**, linked to the seller record).

## Pricing 3.0 formula

Implemented in the backend at `src/utils/pricingFormula.ts`. All constants live in **`src/config/pricingEstimatorConfig.ts`** — that file is the source of truth. Edit it after team meetings; never hardcode.

```
age = currentYear − yearPurchased          (unknown year → ≤5yr bracket)
IF compPrice: marketValue = compPrice      (no retention, no condition deduction)
ELSE:         marketValue = originalPrice × retention[tier][ageBracket] × conditionFactor
base         = marketValue + pickupFee + cleaningCost
listingPrice = round0.5(base × 1.025)      (gateway buffer — shown externally as "logistics & handling")
erlumeCut    = max(0.25 × base, 10)
sellerPayout = base − erlumeCut
accept       = listingPrice ≥ 100
```

| Constant | Value |
|---|---|
| Commission | 25% of base, floor 10 KWD |
| Gateway buffer | ×1.025 |
| Accept floor | 100 KWD |
| USD → KWD | 0.307 |
| Age brackets | ≤1 / ≤3 / ≤5 / ≤10 / 11+ yrs · unknown year → ≤5yr |
| Condition factors | like-new 1.0 · gently-used 0.9 · fair-worn 0.75 |
| Pickup fees | dropoff 0 · own-driver 3 · third-party 5 KWD |
| Markdowns | −15% @ 2mo · −30% @ 3mo · −50% @ 4mo · −75% @ 5mo |

Retention by brand tier (share of original retail kept):

| Tier | ≤1yr | ≤3yr | ≤5yr | ≤10yr | 11+yr |
|---|---|---|---|---|---|
| ultra — Hermès, Chanel, LV | 0.90 | 0.85 | 0.80 | 0.85 | 0.90 |
| premium — Gucci, Prada, Dior, YSL, Loewe… | 0.70 | 0.60 | 0.50 | 0.40 | 0.35 |
| accessible — Coach, MK, Kate Spade… | 0.50 | 0.40 | 0.30 | 0.20 | 0.15 |
| everything else | 0.25 | 0.20 | 0.15 | 0.10 | 0.10 |

Ultra-luxury without comps triggers a warning — Hermès/Chanel often resell above retail, so always prefer comps there.

**erlume Listing mode** (bags erlume buys to resell) multiplies a starting price by per-attribute factors, with the AI's band at ±10%. Brand is deliberately weighted low so attributes matter more than the name.

Worked example — premium, 400 KWD, 3 yrs, gently used, own driver, no cleaning:

```
market 216.00 → base 219.00 → listing 224.50 → cut 54.75 → payout 164.25 → ✅ Accept
```

## Backend API

All routes are under `/api/pricing-tool` and are admin-only.

| Route | What |
|---|---|
| `GET /config` | formula constants for the UI |
| `POST /identify` | multipart `photos[]` (max 3) + optional `brand`,`model` → identification JSON |
| `POST /comps` | `{brand, model, size?, condition?}` → 3 comps + median KWD + fallback links |
| `POST /price` | formula inputs → full breakdown incl. markdown schedule |
| `POST /listing` | erlume Listing mode pricing |
| `GET/POST/DELETE /log` | internal price log (`PriceLog` collection in MongoDB) |
| `GET /sellers` | seller search, for linking a quote |
| `POST /quote` | create a Zoho estimate, link it to the seller, write a price-log entry |
| `GET /quote/:id/pdf` | download the quote PDF |

## Verify

The formula regression suite lives in the backend, alongside the formula it tests:

```sh
# in backend-1.0
npx ts-node src/scripts/test-pricing-formula.ts
```

The spec's worked examples are pinned to 20% commission on purpose (`specConfig` in that file) so they stay a fixed regression even when the live rate changes — that pin is deliberate, don't "fix" it to 25%.

## What was removed

`lib/`, `config.json`, and `test/` were the tool's original standalone implementation — a second copy of the formula and its constants. They were deleted on 2026-08-29 so the backend is the only source of truth; the tests were ported across. Recover them from git history if you ever need them.

`data/price-log.json` is **still here on purpose.** It holds 5 real price-log entries from Jul–Aug 2026, written before the tool moved to the backend. Check they exist in the MongoDB `PriceLog` collection before deleting it — they were computed at the old 20% commission, so the stored `erlumeCut` / `sellerPayout` figures are historical, not reproducible from today's config.
