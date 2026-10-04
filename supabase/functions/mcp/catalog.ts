/**
 * Catalog access for the MCP tools: a short per-isolate cache of the raw
 * catalog rows, priced per request by the same buildCatalog that
 * partner-catalog uses (and the same price maths as checkout), plus the
 * customer-facing views every tool returns. Views are whitelists: supplier
 * names, costs and internal ids never appear in them.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import type { Plan } from "../_shared/catalog/formats.ts";
import { groupNetworksByCountry } from "../_shared/catalog/networks.ts";
import { normalizeCountry } from "../_shared/catalog/countryCodes.ts";
import { buildCatalog, type CatalogData, type CatalogResult, fetchCatalogData } from "../_shared/catalog/buildCatalog.ts";
import { fold } from "./geo.ts";

/** One catalog read serves requests for this long. Checkout re-prices at purchase anyway. */
export const CACHE_TTL_MS = 60_000;
/** If Postgres is unreachable, keep answering from the last good read for at most this long. */
const MAX_STALE_MS = 15 * 60_000;

let cached: { at: number; data: CatalogData } | null = null;
let inflight: Promise<CatalogData> | null = null;

export function catalogData(supabase: SupabaseClient): Promise<CatalogData> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.data);
  inflight ??= fetchCatalogData(supabase, { slug: null })
    .then((data) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .catch((err) => {
      if (cached && Date.now() - cached.at < MAX_STALE_MS) {
        console.error("mcp catalog refresh failed; serving last good read", err);
        return cached.data;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drops the cache (tests). */
export function resetCatalogCache() {
  cached = null;
  inflight = null;
}

export function priceCatalog(
  data: CatalogData,
  opts: { currency: string; days: number[] | null; withRef: (url: string) => string },
): CatalogResult {
  return buildCatalog(data, { currency: opts.currency, requestedDays: opts.days, withRef: opts.withRef });
}

/** Folded single-country destination names → ISO code, e.g. "kenya" → "KE". */
export function destinationNames(data: CatalogData): Map<string, string> {
  const names = new Map<string, string>();
  for (const d of data.destinations) {
    const iso = d.type === "country" && d.country_code?.length === 2 ? normalizeCountry(d.country_code) : null;
    if (iso) names.set(fold(d.name), iso);
  }
  return names;
}

/** Currencies with an active conversion rate, for error messages. */
export const supportedCurrencies = (data: CatalogData) =>
  Array.from(new Set(["USD", ...data.fxRates.map((r: { currency: string }) => r.currency)])).sort();

/** Plans covering every one of the given countries. */
export const plansCoveringAll = (plans: Plan[], isos: string[]) =>
  plans.filter((p) => isos.every((c) => p.countries.includes(c)));

/** Cheapest first; ties broken so results are deterministic. */
export const byPrice = (a: Plan, b: Plan) =>
  a.price - b.price || a.validity_days - b.validity_days || a.destination_slug.localeCompare(b.destination_slug) ||
  a.name.localeCompare(b.name);

const round2 = (n: number) => Math.round(n * 100) / 100;
const formatMb = (mb: number) => (mb >= 1024 ? `${round2(mb / 1024)} GB` : `${mb} MB`);

/** Operators per country for one plan (operators without a country belong to single-country plans). */
export function networksFor(p: Plan, countries: string[]) {
  const ops = p.operators.map((o) => ({
    name: o.name,
    network_types: o.network_types,
    country_iso2: o.country_iso2 ?? (p.countries.length === 1 ? p.countries[0] : null),
  }));
  const grouped = groupNetworksByCountry(ops, countries);
  return countries.flatMap((c) =>
    (grouped[c] ?? []).map((n) => ({ country: c, operator: n.name, network_types: n.types }))
  );
}

function dataView(p: Plan) {
  const cap = p.is_unlimited ? p.highspeed_mb_per_day : null;
  const throttle = p.is_unlimited ? p.reduced_speed_kbps : null;
  let summary = "Data allowance not published";
  if (p.is_unlimited) {
    summary = cap
      ? `Unlimited data: ${formatMb(cap)}/day at full speed, then ${throttle ? `${throttle} kbps` : "reduced speed"}`
      : "Unlimited data";
  } else if (p.data_amount_mb) {
    summary = `${formatMb(p.data_amount_mb)} total`;
  }
  return {
    unlimited: p.is_unlimited,
    total_gb: !p.is_unlimited && p.data_amount_mb ? round2(p.data_amount_mb / 1024) : null,
    high_speed_gb_per_day: cap ? round2(cap / 1024) : null,
    speed_after_cap_kbps: throttle,
    summary,
  };
}

/**
 * The plan as every tool returns it. `focus` limits the network list to the
 * countries the traveller asked about (a regional plan can cover dozens).
 */
export function planView(p: Plan, focus: string[]) {
  const countries = p.countries.filter((c) => focus.includes(c));
  return {
    name: p.name,
    destination: { name: p.destination_name, slug: p.destination_slug, url: p.product_url },
    coverage: {
      type: p.countries.length === 1 ? "single_country" as const : "multi_country" as const,
      countries: [...p.countries],
    },
    validity_days: p.validity_days,
    data: dataView(p),
    price: { amount: p.price, currency: p.currency, per_day: round2(p.price / p.validity_days) },
    networks: networksFor(p, countries),
    hotspot_allowed: p.tethering,
    top_up_available: p.topup_available,
    checkout_url: p.checkout_url,
  };
}

export type PlanView = ReturnType<typeof planView>;
