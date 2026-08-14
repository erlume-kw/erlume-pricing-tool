// erlume Pricing 3.0 — must stay in sync with the Notion "👜 Bag Pricing Calculator" formulas.

export function roundToHalf(x) {
  return Math.round(x * 2) / 2;
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}

// Brackets are the config's ageBrackets upper bounds (≤1 / ≤3 / ≤5 / ≤10),
// with an implicit final bracket for 11+ years.
export function ageBracketIndex(age, brackets) {
  for (let i = 0; i < brackets.length; i++) {
    if (age <= brackets[i]) return i;
  }
  return brackets.length;
}

export function resolveBrandTier(brand, config) {
  if (!brand) return 'highstreet';
  const b = String(brand).trim().toLowerCase();
  for (const [tier, brands] of Object.entries(config.brandTiers)) {
    if (brands.some((name) => b === name || b.includes(name))) return tier;
  }
  return 'highstreet';
}

/**
 * Core pricing formula.
 * @param {object} input
 *   originalPrice  KWD (required unless compPrice given)
 *   yearPurchased  optional — unknown year falls back to the 4–5yr bracket
 *   brandTier      "ultra" | "premium" | "accessible" | "highstreet"
 *   condition      "like-new" | "gently-used" | "fair-worn"
 *   compPrice      KWD — median of comps; when present, retention/condition are skipped
 *   pickupFee      KWD (0 / 3 / 5)
 *   cleaningCost   KWD
 *   currentYear    override for tests
 */
export function priceBag(input, config) {
  const {
    originalPrice,
    yearPurchased,
    brandTier = 'highstreet',
    condition = 'gently-used',
    compPrice,
    pickupFee = 0,
    cleaningCost = 0,
    currentYear = new Date().getFullYear(),
  } = input;

  const warnings = [];
  const usingComps = compPrice !== undefined && compPrice !== null && compPrice !== '' && !Number.isNaN(Number(compPrice));

  let marketValue;
  let retention = null;
  let conditionFactor = null;
  let age = null;

  if (usingComps) {
    // Comp path: NO retention, NO condition deduction.
    marketValue = Number(compPrice);
  } else {
    const table = config.retentionTable[brandTier];
    if (!table) throw new Error(`Unknown brand tier: ${brandTier}`);
    conditionFactor = config.conditionFactors[condition];
    if (conditionFactor === undefined) throw new Error(`Unknown condition: ${condition}`);

    let idx;
    if (yearPurchased) {
      age = currentYear - Number(yearPurchased);
      idx = ageBracketIndex(age, config.ageBrackets);
    } else {
      idx = config.defaultAgeBracketIndex; // unknown year → 4–5 yr bracket
    }
    retention = table[idx];
    marketValue = Number(originalPrice) * retention * conditionFactor;

    if (brandTier === 'ultra') {
      warnings.push(
        'Ultra-luxury bag priced without comps — Hermès/Chanel often resell ABOVE retail; find comps before accepting this price.'
      );
    }
  }

  const base = marketValue + Number(pickupFee) + Number(cleaningCost);
  const listingPrice = roundToHalf(base * config.gatewayBuffer);
  const erlumeCut = Math.max(config.commissionRate * base, config.commissionFloorKWD);
  const sellerPayout = base - erlumeCut;
  const accept = listingPrice >= config.acceptFloorKWD;

  const markdowns = (config.markdownSchedule || []).map((m) => {
    const mBase = base * (1 - m.discount);
    const mCut = Math.max(config.commissionRate * mBase, config.commissionFloorKWD);
    return {
      months: m.months,
      discount: m.discount,
      listingPrice: roundToHalf(mBase * config.gatewayBuffer),
      erlumeCut: round2(mCut),
      sellerPayout: round2(mBase - mCut),
    };
  });

  return {
    usingComps,
    age,
    retention,
    conditionFactor,
    marketValue: round2(marketValue),
    pickupFee: round2(Number(pickupFee)),
    cleaningCost: round2(Number(cleaningCost)),
    base: round2(base),
    listingPrice,
    erlumeCut: round2(erlumeCut),
    sellerPayout: round2(sellerPayout),
    accept,
    markdowns,
    warnings,
  };
}

export function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return null;
  return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export function usdToKwd(usd, config) {
  return roundToHalf(usd * config.usdToKwd);
}

// ---------------------------------------------------------------------------
// Listing mode — pricing for items erlume BUYS to resell.
// Categorization attributes multiply the starting price into a suggested-price
// band; the AI then picks a point inside [low, high]. Brand is weighted LOW.
// ---------------------------------------------------------------------------

/**
 * Combined multiplier + per-attribute breakdown from the categorization.
 * @param {object} attrs  { rare, vintage, trendy, seasonal, material, condition, brand }
 *   each value must be a key in config.listingMode.multipliers[attr]
 */
export function listingMultiplier(attrs, config) {
  const table = config.listingMode.multipliers;
  const factors = [];
  let multiplier = 1;
  for (const [attr, choice] of Object.entries(attrs)) {
    const set = table[attr];
    if (!set) continue;
    const m = set[choice];
    if (m === undefined) continue;
    multiplier *= m;
    factors.push({ attr, choice, multiplier: m });
  }
  return { multiplier: round2(multiplier), factors };
}

/**
 * Suggested-price band from starting price + categorization.
 * Returns { low, mid, high, multiplier, factors } — all in KWD, rounded to 0.5.
 */
export function listingRange(startingPrice, attrs, config) {
  const { multiplier, factors } = listingMultiplier(attrs, config);
  const mid = Number(startingPrice) * multiplier;
  const spread = config.listingMode.rangeSpreadPct ?? 0.1;
  return {
    multiplier,
    factors,
    low: roundToHalf(mid * (1 - spread)),
    mid: roundToHalf(mid),
    high: roundToHalf(mid * (1 + spread)),
  };
}

/**
 * Clamp an AI-chosen price into the band, so the model can never go outside
 * the formula's guardrails.
 */
export function clampToRange(value, range) {
  if (value == null || Number.isNaN(Number(value))) return range.mid;
  return Math.min(range.high, Math.max(range.low, Number(value)));
}
