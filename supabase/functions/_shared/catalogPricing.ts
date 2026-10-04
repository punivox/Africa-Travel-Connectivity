/**
 * Shared retail-price math for edge functions.
 *
 * This is the single implementation of the daily-rate tier maths and the
 * currency conversion / charm-rounding used across the site. `calculate-price`
 * (checkout) and `partner-catalog` (external partners) both import it, so a
 * partner can never be quoted a price that differs from checkout.
 *
 * Mirrors src/lib/dailyRatePricing.ts and the convertPrice() logic in
 * src/contexts/CurrencyContext.tsx.
 */

export interface Tier {
  from_days: number;
  to_days: number;
  price_per_day_usd: number;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Durations the site sells. Requested days snap up to the next one. */
export const ALLOWED_DURATIONS = [1, 3, 7, 15, 30];

export const snapDuration = (days: number): number => {
  for (const d of ALLOWED_DURATIONS) if (days <= d) return d;
  return ALLOWED_DURATIONS[ALLOWED_DURATIONS.length - 1];
};

/** Tier value that applies to a single day (absolute $/day or multiplier). */
export const tierValueForDay = (day: number, tiers: Tier[]): number => {
  if (!tiers.length) return 0;
  const tier = tiers.find((t) => day >= t.from_days && day <= t.to_days);
  return tier ? Number(tier.price_per_day_usd) : Number(tiers[tiers.length - 1].price_per_day_usd);
};

/** Tiers hold absolute USD/day: sum day by day. */
export const absoluteTierTotal = (days: number, tiers: Tier[]): number => {
  let total = 0;
  for (let d = 1; d <= days; d += 1) total += tierValueForDay(d, tiers);
  return round2(total);
};

/** Tiers hold multipliers applied to the 1-day USD base price. */
export const formulaTierTotal = (days: number, tiers: Tier[], baseUsd: number): number => {
  if (baseUsd <= 0) return 0;
  if (!tiers.length) return round2(baseUsd * days);
  let total = 0;
  for (let d = 1; d <= days; d += 1) total += baseUsd * tierValueForDay(d, tiers);
  return round2(total);
};

/**
 * Subtotal in USD for one destination configuration.
 * `baseUsd` is only used in formula mode (the destination's 1-day USD SRP).
 */
export const dailyRateSubtotalUsd = (opts: {
  days: number;
  people: number;
  useFormula: boolean;
  dailyRateUsd: number;
  tiers: Tier[];
  baseUsd: number;
}): number => {
  const { days, people, useFormula, dailyRateUsd, tiers, baseUsd } = opts;
  const hasTiers = tiers.length > 0;

  if (useFormula) return round2(formulaTierTotal(days, tiers, baseUsd) * people);
  if (hasTiers) return round2(absoluteTierTotal(days, tiers) * people);
  return round2(Number(dailyRateUsd) * days * people);
};

// ── Display currency ──────────────────────────────────────────────────────

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", AED: "د.إ", SAR: "﷼", PLN: "zł", BRL: "R$",
  IDR: "Rp", KES: "KSh", MUR: "Rs", TWD: "NT$", SGD: "S$", NZD: "NZ$",
  AUD: "A$", NGN: "₦",
};

export const SPACED_CURRENCIES = new Set(["IDR", "AED", "SAR", "KES", "MUR", "TWD", "NGN"]);

/**
 * Convert a USD amount to a display currency using the same charm rounding the
 * website applies, so catalog prices match what a shopper sees and pays.
 */
export const convertDisplayPrice = (
  usdPrice: number,
  rate: number,
  currency: string,
  decimalPlaces: number,
): number => {
  const converted = usdPrice * rate;

  if (currency === "USD" || decimalPlaces !== 2) {
    const factor = Math.pow(10, decimalPlaces);
    return Math.round(converted * factor) / factor;
  }

  const raw = Math.round(converted * 100) / 100;
  const floor = Math.floor(raw);
  const frac = raw - floor;
  const v99 = frac >= 0.5 ? floor + 0.99 : Math.max(0.99, floor - 0.01);

  if (v99 === usdPrice) return Math.max(0.49, Math.floor(raw * 10) / 10 - 0.01);
  return v99;
};

export const formatDisplayPrice = (
  amount: number,
  currency: string,
  decimalPlaces: number,
): string => {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  });
  return SPACED_CURRENCIES.has(currency) ? `${symbol} ${formatted}` : `${symbol}${formatted}`;
};
