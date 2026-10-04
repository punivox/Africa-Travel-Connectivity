/**
 * Builds the normalized plan list shared by partner-catalog and mcp.
 *
 * Prices come from the shared resolver in ../catalogPricing.ts — the same
 * maths `calculate-price` uses at checkout — so a partner never publishes a
 * price we will not honour. provider_config is read server-side only to derive
 * public facts (fair use, speed, top-up); costs and supplier codes never leave.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  ALLOWED_DURATIONS,
  convertDisplayPrice,
  dailyRateSubtotalUsd,
  round2,
  type Tier,
} from "../catalogPricing.ts";
import { FORMATS, type Plan } from "./formats.ts";
import { linkTargets, normalizeCountry, resolveCoverage } from "./countryCodes.ts";
import { supplierFacts, type SupplierFacts } from "./providers.ts";

export const SITE = "https://safariesim.com";

export interface CatalogDestination {
  id: string;
  slug: string;
  name: string;
  country_code: string | null;
  region: string | null;
  coverage_type: string | null;
  network_types: string[] | null;
  updated_at: string | null;
  flag_emoji: string | null;
  /** "country" | "region" */
  type: string | null;
}

export interface Catalog {
  /** Admin-selected price source (see loadCatalog). */
  pricingSource: string;
  /** Every active destination matching the slug filter, priced or not. */
  destinations: CatalogDestination[];
  membersByDest: Map<string, string[]>;
  /** Sorted by destination slug, then validity. */
  plans: Plan[];
  /** Plans left out while building, by reason. */
  excluded: Record<string, number>;
}

export type CatalogResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; code: "unsupported_currency"; message: string };

/**
 * `days` — the site sells any number of days from a calendar, so callers can
 * ask for the exact durations they want instead of the default showcase set.
 * Accepts `10`, `1,5,10`, `1-30`, or `all`. An empty value means "default set"
 * (days: null). Only applies to day-based (daily-rate) destinations.
 */
export function parseDays(daysParam: string): { days: number[] | null } | { error: string } {
  if (!daysParam) return { days: null };
  const MAX_DAYS = 365;
  const set = new Set<number>();
  if (daysParam.toLowerCase() === "all") {
    for (let d = 1; d <= 30; d += 1) set.add(d);
  } else {
    for (const part of daysParam.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (!from || !to || from > to || to > MAX_DAYS) {
          return { error: `Invalid days range "${piece}".` };
        }
        for (let d = from; d <= to; d += 1) set.add(d);
      } else {
        const n = Number(piece);
        if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
          return { error: `Invalid days value "${piece}".` };
        }
        set.add(n);
      }
    }
  }
  if (set.size === 0) return { error: "No valid days supplied." };
  if (set.size > MAX_DAYS) return { error: "Too many days requested." };
  return { days: Array.from(set).sort((a, b) => a - b) };
}

/**
 * Raw catalog rows as read from Postgres. Fetching is separate from building so
 * a caller can reuse one read for many requests (mcp caches it briefly).
 * Read-only: buildCatalog never mutates it.
 */
export interface CatalogData {
  pricingSource: string;
  destinations: CatalogDestination[];
  rates: { id: string; destination_id: string; daily_rate_usd: number | string; min_days: number | null; max_days: number | null; use_formula: boolean | null }[];
  tiers: { rate_id: string; from_days: number; to_days: number; price_per_day_usd: number | string }[];
  members: { destination_id: string; country_iso2: string }[];
  operators: { destination_id: string; operator_name: string; network_types: string[] | null; country_iso2: string | null; sort_order: number | null }[];
  fxRates: { currency: string; rate: number | string }[];
  roundingRules: { currency: string; decimal_places: number | string }[];
  products: {
    id: string;
    slug: string;
    destination_id: string;
    status: string;
    updated_at: string | null;
    product_variant: {
      id: string;
      variant_name: string | null;
      validity_days: number | null;
      sort_order: number | null;
      type: string | null;
      data_amount_mb: number | null;
      is_unlimited: boolean | null;
      updated_at: string | null;
      provider: string | null;
      provider_config: unknown;
      pricing: { currency: string; srp: number | string }[] | null;
    }[] | null;
  }[];
  fairUse: { destination_id: string; highspeed_mb_per_day: number | null; reduced_speed_kbps: number | null; tethering: boolean | null }[];
  fuDefault: { highspeed_mb_per_day?: number | null; reduced_speed_kbps?: number | null; tethering?: boolean | null };
}

/** Reads every row the catalog is built from. */
export async function fetchCatalogData(
  supabase: SupabaseClient,
  opts: {
    /** Destination slug filter; null = every active destination. */
    slug: string | null;
  },
): Promise<CatalogData> {
  const slugFilter = opts.slug;

  // ── Reference data ────────────────────────────────────────────────────
  let destQuery = supabase
    .from("destinations")
    .select("id, slug, name, country_code, region, coverage_type, network_types, updated_at, flag_emoji, type")
    .eq("is_active", true);
  if (slugFilter) destQuery = destQuery.eq("slug", slugFilter);
  // country filter is applied on resolved plan coverage (plansCoveringCountry), not here.

  const [destRes, rateRes, tierRes, memberRes, opRes, fxRes, roundRes, settingRes] = await Promise.all([
    destQuery,
    supabase
      .from("destination_daily_rate")
      .select("id, destination_id, daily_rate_usd, min_days, max_days, use_formula")
      .eq("is_active", true),
    supabase
      .from("destination_daily_rate_tier")
      .select("rate_id, from_days, to_days, price_per_day_usd")
      .order("from_days"),
    supabase.from("destination_member").select("destination_id, country_iso2"),
    supabase
      .from("destination_operators")
      .select("destination_id, operator_name, network_types, country_iso2, sort_order")
      .eq("is_active", true)
      .order("sort_order"),
    supabase.from("currency_conversion_rates").select("currency, rate").eq("is_active", true),
    supabase.from("currency_rounding_rules").select("currency, decimal_places"),
    supabase
      .from("system_settings")
      .select("setting_value")
      .eq("setting_key", "partner_catalog_pricing_source")
      .maybeSingle(),
  ]);

  /**
   * Which prices the catalog publishes, set by admins in
   * /sys/admin/daily-rates:
   *   daily_rate  — only the Daily Rates page pricing (destinations without a
   *                 daily rate are omitted)
   *   variant_srp — only the fixed plan prices from the products catalog
   *   auto        — daily rate when configured, otherwise fixed plan prices
   */
  const pricingSource =
    ((settingRes as any)?.data?.setting_value?.source as string | undefined) ?? "auto";

  if (destRes.error) throw destRes.error;
  const destinations = (destRes.data ?? []) as CatalogDestination[];
  const reference = {
    pricingSource,
    destinations,
    rates: rateRes.data ?? [],
    tiers: tierRes.data ?? [],
    members: memberRes.data ?? [],
    operators: opRes.data ?? [],
    fxRates: fxRes.data ?? [],
    roundingRules: roundRes.data ?? [],
  };
  if (destinations.length === 0) return { ...reference, products: [], fairUse: [], fuDefault: {} };

  const destIds = destinations.map((d) => d.id);

  // Variants + USD retail prices. provider_config is read server-side only to
  // derive public facts (fair use, speed, top-up); costs/codes never leave.
  const [{ data: products, error: productError }, { data: fairUse }] = await Promise.all([
    supabase
      .from("product")
      .select(`
        id, slug, destination_id, status, updated_at,
        product_variant (
          id, variant_name, validity_days, sort_order, type,
          data_amount_mb, is_unlimited, updated_at, provider, provider_config,
          pricing ( currency, srp )
        )
      `)
      .eq("status", "active")
      .in("destination_id", destIds),
    supabase
      .from("destination_fair_use")
      .select("destination_id, highspeed_mb_per_day, reduced_speed_kbps, tethering")
      .in("destination_id", destIds),
  ]);
  if (productError) throw productError;
  // Global fair-use default, used when no per-destination override or supplier data exists.
  const { data: fuDefaultRow } = await supabase
    .from("system_settings")
    .select("setting_value")
    .eq("setting_key", "partner_catalog_fair_use_default")
    .maybeSingle();

  return {
    ...reference,
    products: products ?? [],
    fairUse: fairUse ?? [],
    fuDefault: (fuDefaultRow as any)?.setting_value ?? {},
  };
}

/** Fetches and prices the catalog in one step (what partner-catalog uses). */
export async function loadCatalog(
  supabase: SupabaseClient,
  opts: {
    /** Destination slug filter; null = every active destination. */
    slug: string | null;
    /** Display currency for `price`. */
    currency: string;
    /** Durations to price for day-based destinations; null = ALLOWED_DURATIONS. */
    requestedDays: number[] | null;
    /** Adds the partner's referral code to product/checkout links. */
    withRef: (url: string) => string;
  },
): Promise<CatalogResult> {
  return buildCatalog(await fetchCatalogData(supabase, { slug: opts.slug }), opts);
}

/** Prices the catalog from fetched rows. Pure: no I/O, and `data` is never mutated. */
export function buildCatalog(
  data: CatalogData,
  opts: {
    /** Display currency for `price`. */
    currency: string;
    /** Durations to price for day-based destinations; null = ALLOWED_DURATIONS. */
    requestedDays: number[] | null;
    /** Adds the partner's referral code to product/checkout links. */
    withRef: (url: string) => string;
  },
): CatalogResult {
  const { currency, requestedDays, withRef } = opts;
  const { pricingSource, destinations, fuDefault } = data;

  const membersByDest = new Map<string, string[]>();
  const excluded: Record<string, number> = {};

  if (destinations.length === 0) {
    return { ok: true, catalog: { pricingSource, destinations, membersByDest, plans: [], excluded } };
  }

  const fairUseByDest = new Map<string, any>();
  for (const f of data.fairUse) fairUseByDest.set(f.destination_id, f);

  // ── Index helpers ─────────────────────────────────────────────────────
  const rateByDest = new Map<string, any>();
  for (const r of data.rates) rateByDest.set(r.destination_id, r);

  const tiersByRate = new Map<string, Tier[]>();
  for (const t of data.tiers) {
    const list = tiersByRate.get(t.rate_id) ?? [];
    list.push({ from_days: t.from_days, to_days: t.to_days, price_per_day_usd: Number(t.price_per_day_usd) });
    tiersByRate.set(t.rate_id, list);
  }

  for (const m of data.members) {
    const list = membersByDest.get(m.destination_id) ?? [];
    list.push(m.country_iso2);
    membersByDest.set(m.destination_id, list);
  }

  const opsByDest = new Map<string, { name: string; network_types: string[]; country_iso2: string | null }[]>();
  for (const o of data.operators) {
    const list = opsByDest.get(o.destination_id) ?? [];
    list.push({
      name: o.operator_name,
      network_types: o.network_types ?? [],
      country_iso2: (o as any).country_iso2 ? normalizeCountry(String((o as any).country_iso2)) : null,
    });
    opsByDest.set(o.destination_id, list);
  }

  const variantsByDest = new Map<string, any[]>();
  for (const p of data.products) {
    const list = variantsByDest.get(p.destination_id) ?? [];
    for (const v of p.product_variant ?? []) list.push({ ...v, product_slug: p.slug, product_updated_at: p.updated_at });
    variantsByDest.set(p.destination_id, list);
  }

  // Display currency setup
  const fxRate = currency === "USD"
    ? 1
    : Number(data.fxRates.find((r: any) => r.currency === currency)?.rate ?? 0);
  if (!fxRate) return { ok: false, code: "unsupported_currency", message: `No active conversion rate for ${currency}.` };
  const decimals = currency === "USD"
    ? 2
    : Number(data.roundingRules.find((r: any) => r.currency === currency)?.decimal_places ?? 2);

  const toDisplay = (usd: number) => convertDisplayPrice(usd, fxRate, currency, decimals);

  // ── Build the normalized plan list ────────────────────────────────────
  const plans: Plan[] = [];

  for (const dest of destinations) {
    const variants = (variantsByDest.get(dest.id) ?? []).filter((v) => (v.sort_order ?? 0) >= 0);
    if (variants.length === 0) continue;

    const usdSrp = (v: any) =>
      Number((v.pricing ?? []).find((p: any) => p.currency === "USD" && Number(p.srp) > 0)?.srp ?? 0);

    const oneDay = variants.filter((v) => v.validity_days === 1).map(usdSrp).filter((n) => n > 0);
    const baseUsd = oneDay.length ? Math.min(...oneDay) : 0;

    const members = membersByDest.get(dest.id) ?? [];
    const operators = opsByDest.get(dest.id) ?? [];
    const coverageType = dest.coverage_type ?? (members.length > 1 ? "regional" : "local");
    const lastUpdated = dest.updated_at ?? new Date().toISOString();
    const countries = resolveCoverage(dest.country_code, dest.coverage_type, members);
    if (countries.length === 0) { excluded.missing_coverage = (excluded.missing_coverage ?? 0) + variants.length; continue; }
    const countryIso2 = countries.length === 1 ? countries[0] : null;
    const fu = fairUseByDest.get(dest.id);

    /** Merge admin fair-use settings (win) with supplier facts (fallback). */
    const factsFor = (vs: any[]) => {
      const facts = vs.map((v) => supplierFacts(v.provider, v.provider_config));
      const first = <T,>(pick: (f: SupplierFacts) => T | null) =>
        facts.map(pick).find((x) => x !== null && x !== undefined) ?? null;
      const supplierNet = Array.from(new Set(facts.flatMap((f) => f.networkTypes)));
      return {
        highspeed_mb_per_day:
          fu?.highspeed_mb_per_day ?? first((f) => f.highspeedMbPerDay) ?? fuDefault.highspeed_mb_per_day ?? null,
        reduced_speed_kbps:
          fu?.reduced_speed_kbps ?? first((f) => f.reducedSpeedKbps) ?? fuDefault.reduced_speed_kbps ?? null,
        tethering: fu?.tethering ?? fuDefault.tethering ?? true,
        breakout_countries: Array.from(new Set(facts.map((f) => f.breakoutCountry && normalizeCountry(f.breakoutCountry)).filter(Boolean) as string[])),
        topup_available: facts.some((f) => f.topUp),
        providers: Array.from(new Set(vs.map((v) => v.provider).filter(Boolean))),
        network_types: operators.length
          ? Array.from(new Set(operators.flatMap((o) => o.network_types)))
          : supplierNet.length ? supplierNet : (dest.network_types ?? []),
      };
    };

    const rate = pricingSource === "variant_srp" ? null : rateByDest.get(dest.id);
    // In daily_rate mode a destination without a daily rate is simply not published.
    // Destinations with no daily rate are sold as fixed packages on the site
    // (e.g. Namibia, Mozambique, Africa Safari), so they fall through below.

    if (rate) {
      // Day-based destination: one plan per sellable duration.
      const tiers = tiersByRate.get(rate.id) ?? [];
      const durations = (requestedDays ?? ALLOWED_DURATIONS).filter(
        (d) => d >= (rate.min_days ?? 1) && d <= (rate.max_days ?? 30),
      );
      const sample = variants[0];
      const facts = factsFor(variants);
      const before = plans.length;

      for (const days of durations) {
        const usd = dailyRateSubtotalUsd({
          days,
          people: 1,
          useFormula: !!rate.use_formula,
          dailyRateUsd: Number(rate.daily_rate_usd),
          tiers,
          baseUsd,
        });
        if (usd <= 0) continue;

        plans.push({
          id: `${dest.slug}-${days}d`,
          name: `${dest.name} eSIM — ${days} ${days === 1 ? "day" : "days"}`,
          destination_slug: dest.slug,
          destination_name: dest.name,
          country_iso2: countryIso2,
          countries,
          region: dest.region ?? null,
          coverage_type: coverageType,
          data_amount_mb: sample?.data_amount_mb ?? null,
          is_unlimited: !!sample?.is_unlimited,
          ...facts,
          validity_days: days,
          price: toDisplay(usd),
          price_usd: round2(usd),
          currency,
          operators,
          plan_type: sample?.is_unlimited ? "unlimited" : "data",
          status: "available",
          product_url: withRef(`${SITE}/esim-${dest.slug}`),
          checkout_url: withRef(`${SITE}/esim-${dest.slug}?days=${days}&checkout=1`),
          last_updated: lastUpdated,
        });
      }
      // A daily rate that prices nothing (e.g. formula mode without a 1-day
      // base) means the site sells fixed packages instead — fall through.
      if (plans.length > before) continue;
    }

    // Fixed-variant destination: one plan per visible variant with a USD price.
    for (const v of variants) {
      const usd = usdSrp(v);
      if (usd <= 0 || !v.validity_days) continue;

      plans.push({
        id: v.id,
        name: v.variant_name ?? `${dest.name} eSIM — ${v.validity_days} days`,
        destination_slug: dest.slug,
        destination_name: dest.name,
        country_iso2: countryIso2,
        countries,
        region: dest.region ?? null,
        coverage_type: coverageType,
        data_amount_mb: v.data_amount_mb ?? null,
        is_unlimited: !!v.is_unlimited,
        ...factsFor([v]),
        validity_days: v.validity_days,
        price: toDisplay(usd),
        price_usd: round2(usd),
        currency,
        operators,
        plan_type: v.is_unlimited ? "unlimited" : "data",
        status: "available",
        product_url: withRef(`${SITE}/esim-${dest.slug}`),
        checkout_url: withRef(`${SITE}/esim-${dest.slug}?variant=${v.id}&checkout=1`),
        last_updated: v.updated_at ?? v.product_updated_at ?? lastUpdated,
      });
    }
  }

  plans.sort((a, b) =>
    a.destination_slug.localeCompare(b.destination_slug) || a.validity_days - b.validity_days
  );

  return { ok: true, catalog: { pricingSource, destinations, membersByDest, plans, excluded } };
}

/** Country filter = plan coverage (includes regional plans covering it). */
export const plansCoveringCountry = (plans: Plan[], iso2: string) =>
  plans.filter((p) => p.countries.includes(iso2));

/**
 * eSIMDB Destination Links (section 4). A destination is only linked when it
 * has at least one plan publishable under eSIMDB's rules, so pass a catalog
 * priced the way the esimdb format prices it (USD, every duration 1–30).
 */
export function buildDestinationLinks(catalog: Catalog, withRef: (url: string) => string) {
  const exclude = FORMATS.esimdb.exclude!;
  const withPlans = new Set(catalog.plans.filter((p) => !exclude(p)).map((p) => p.destination_slug));
  return catalog.destinations.flatMap((d) => {
    if (!withPlans.has(d.slug)) return [];
    const targets = linkTargets(d.country_code, catalog.membersByDest.get(d.id) ?? []);
    if (targets.length === 0) return [];
    return [{
      name: `${d.name} eSIM`.slice(0, 30),
      link: withRef(`${SITE}/esim-${d.slug}`),
      type: "web",
      targetLanguages: null,
      targets,
    }];
  });
}
