import test from 'node:test';
import assert from 'node:assert/strict';
import { priceBag, ageBracketIndex, roundToHalf, median, mean, resolveBrandTier, listingMultiplier, listingRange, clampToRange } from '../lib/pricing.js';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();
const YEAR = 2026;

// The spec document's worked examples were written at 20% commission. Pin them
// here so they stay a fixed formula regression regardless of the live rate in
// config.json (which the team may change — e.g. to 25%).
const specConfig = { ...config, commissionRate: 0.2 };

test('spec test case: premium, 400 KWD, 3 yrs, gently used, own driver, no cleaning', () => {
  const r = priceBag(
    {
      originalPrice: 400,
      yearPurchased: YEAR - 3,
      brandTier: 'premium',
      condition: 'gently-used',
      pickupFee: 3,
      cleaningCost: 0,
      currentYear: YEAR,
    },
    specConfig
  );
  assert.equal(r.marketValue, 216.0);
  assert.equal(r.base, 219.0);
  assert.equal(r.listingPrice, 224.5);
  assert.equal(r.erlumeCut, 43.8);
  assert.equal(r.sellerPayout, 175.2);
  assert.equal(r.accept, true);
});

test('comp price path skips retention and condition', () => {
  const r = priceBag(
    { compPrice: 500, brandTier: 'ultra', condition: 'fair-worn', pickupFee: 0, cleaningCost: 0 },
    specConfig
  );
  assert.equal(r.usingComps, true);
  assert.equal(r.marketValue, 500);
  assert.equal(r.listingPrice, roundToHalf(500 * 1.025)); // 512.5
  assert.equal(r.erlumeCut, 100);
  assert.equal(r.sellerPayout, 400);
});

test('unknown year falls back to the 4–5 yr bracket', () => {
  const r = priceBag(
    { originalPrice: 100, brandTier: 'premium', condition: 'like-new', currentYear: YEAR },
    config
  );
  // premium ≤5 bracket = 50%
  assert.equal(r.retention, 0.5);
  assert.equal(r.marketValue, 50);
});

test('commission floor of 10 KWD applies to cheap bags', () => {
  const r = priceBag(
    { originalPrice: 40, yearPurchased: YEAR - 1, brandTier: 'accessible', condition: 'like-new', currentYear: YEAR },
    config
  );
  // 40 × 0.50 × 1.00 = 20 base → 20% = 4 → floor 10
  assert.equal(r.erlumeCut, 10);
  assert.equal(r.sellerPayout, 10);
  assert.equal(r.accept, false); // listing 20.5 < 30 floor
});

test('ultra-luxury without comps produces a warning', () => {
  const r = priceBag(
    { originalPrice: 3000, yearPurchased: YEAR - 2, brandTier: 'ultra', condition: 'like-new', currentYear: YEAR },
    config
  );
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /comps/i);
});

test('age brackets map correctly', () => {
  const b = config.ageBrackets; // [1, 3, 5, 10]
  assert.equal(ageBracketIndex(0, b), 0);
  assert.equal(ageBracketIndex(1, b), 0);
  assert.equal(ageBracketIndex(2, b), 1);
  assert.equal(ageBracketIndex(3, b), 1);
  assert.equal(ageBracketIndex(5, b), 2);
  assert.equal(ageBracketIndex(10, b), 3);
  assert.equal(ageBracketIndex(11, b), 4);
});

test('markdown schedule reapplies commission on discounted base', () => {
  const r = priceBag(
    { compPrice: 200, brandTier: 'premium', condition: 'gently-used' },
    specConfig
  );
  const m2 = r.markdowns.find((m) => m.months === 2);
  // base 200 → −15% = 170 → ×1.025 = 174.25 → round 174.5
  assert.equal(m2.listingPrice, roundToHalf(170 * 1.025));
  assert.equal(m2.erlumeCut, 34);
  assert.equal(m2.sellerPayout, 136);
});

test('median of comp prices', () => {
  assert.equal(median([100, 300, 200]), 200);
  assert.equal(median([100, 200]), 150);
  assert.equal(median([]), null);
});

test('brand tier resolution', () => {
  assert.equal(resolveBrandTier('Chanel', config), 'ultra');
  assert.equal(resolveBrandTier('GUCCI', config), 'premium');
  assert.equal(resolveBrandTier('Coach', config), 'accessible');
  assert.equal(resolveBrandTier('Zara', config), 'highstreet');
});

test('mean of comp prices (average, not median)', () => {
  assert.equal(mean([100, 300, 200]), 200);
  assert.equal(mean([100, 200]), 150);
  assert.equal(mean([100, 100, 400]), 200); // mean 200 vs median 100 — proves it averages
  assert.equal(mean([]), null);
});

test('accept floor is now 100 KWD', () => {
  assert.equal(config.acceptFloorKWD, 100);
  // comp 90 → listing ~92 < 100 → decline
  const r = priceBag({ compPrice: 90, brandTier: 'premium', condition: 'used' }, config);
  assert.equal(r.accept, false);
});

test('listing multiplier compounds category factors (brand weighted low)', () => {
  const { multiplier } = listingMultiplier(
    { rare: 'yes', vintage: 'no', trendy: 'no', seasonal: 'n/a', material: 'standard', condition: 'like-new', brand: 'ultra' },
    config
  );
  // rare 1.30 × ultra brand 1.06 = 1.378 → round2 1.38
  assert.equal(multiplier, 1.38);
});

test('listing range brackets the midpoint by the config spread', () => {
  const range = listingRange(200, { rare: 'no', vintage: 'no', condition: 'gently-used', brand: 'highstreet' }, config);
  // gently-used 0.90 × highstreet 1.00 = 0.90 → mid 180; spread 10% → 162 / 198
  assert.equal(range.mid, 180);
  assert.equal(range.low, 162);
  assert.equal(range.high, 198);
});

test('clampToRange keeps AI picks inside the band', () => {
  const range = { low: 100, mid: 150, high: 200 };
  assert.equal(clampToRange(250, range), 200); // above → high
  assert.equal(clampToRange(50, range), 100);  // below → low
  assert.equal(clampToRange(160, range), 160); // inside → unchanged
  assert.equal(clampToRange(null, range), 150); // missing → mid
});
