/**
 * Synthetic catalog for the tests: a few destinations that exercise every
 * pricing path (absolute day tiers, flat daily rate, formula mode, fixed
 * packages, a multi-country safari plan) plus partner keys. Prices and ids are
 * made up; they are not SafarieSIM's live catalog.
 */
import { db, writes } from "./fake_supabase.ts";

export const KEYS = {
  plain: "pk_test_plain_00000000000000000000",
  affiliate: "pk_test_affiliate_0000000000000000",
  inactiveAffiliate: "pk_test_inactive_00000000000000000",
  revoked: "pk_test_revoked_000000000000000000",
  limited: "pk_test_limited_000000000000000000",
};

const sha256 = async (v: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

const dest = (id: string, slug: string, name: string, country_code: string, extra: Record<string, unknown> = {}) => ({
  id, slug, name, country_code, region: "Other", coverage_type: "Nationwide", network_types: ["4G"],
  updated_at: "2026-09-01T00:00:00.000Z", flag_emoji: null, type: "country", is_active: true, ...extra,
});

const variant = (id: string, validity_days: number, usd: number, extra: Record<string, unknown> = {}) => ({
  id, variant_name: null, validity_days, sort_order: 0, type: "standard", data_amount_mb: null, is_unlimited: true,
  updated_at: "2026-09-01T00:00:00.000Z", provider: "esimaccess", provider_config: null,
  pricing: [{ currency: "USD", srp: usd }], ...extra,
});

// Supplier config the server must read for public facts but never expose.
const SUPPLIER_CONFIG = {
  fup: "2GB/day", fupPolicy: "384kbps", speed: "4G/5G", topUpType: "Data Top-up", breakoutIp: "",
  costPrice: 1.23, packageCode: "SECRET-PACKAGE-CODE",
};

export async function seed() {
  for (const k of Object.keys(db)) delete db[k];
  writes.length = 0;

  db.destinations = [
    dest("d-ke", "kenya", "Kenya", "KE", { flag_emoji: "🇰🇪" }),
    dest("d-tz", "tanzania", "Tanzania", "TZ", { flag_emoji: "🇹🇿" }),
    dest("d-ug", "uganda", "Uganda", "UG", { flag_emoji: "🇺🇬" }),
    dest("d-bw", "botswana", "Botswana", "BW", { flag_emoji: "🇧🇼" }),
    dest("d-fr", "france", "France", "FR", { region: "Europe", flag_emoji: "🇫🇷" }),
    dest("d-safari", "africa-safari", "Africa Safari", "", { type: "region", coverage_type: "regional", region: "Africa", flag_emoji: "🦁" }),
    dest("d-old", "atlantis", "Atlantis", "AT", { is_active: false }),
  ];
  db.destination_daily_rate = [
    { id: "r-ke", destination_id: "d-ke", daily_rate_usd: 4, min_days: 1, max_days: 30, use_formula: false, is_active: true },
    { id: "r-tz", destination_id: "d-tz", daily_rate_usd: 4.5, min_days: 1, max_days: 30, use_formula: false, is_active: true },
    { id: "r-ug", destination_id: "d-ug", daily_rate_usd: 0, min_days: 1, max_days: 30, use_formula: true, is_active: true },
    { id: "r-safari", destination_id: "d-safari", daily_rate_usd: 6, min_days: 3, max_days: 30, use_formula: false, is_active: true },
  ];
  db.destination_daily_rate_tier = [
    { rate_id: "r-ke", from_days: 1, to_days: 7, price_per_day_usd: 4 },
    { rate_id: "r-ke", from_days: 8, to_days: 30, price_per_day_usd: 3 },
    { rate_id: "r-ug", from_days: 1, to_days: 30, price_per_day_usd: 0.9 },
  ];
  db.destination_member = ["KE", "TZ", "UG"].map((c) => ({ destination_id: "d-safari", country_iso2: c }));
  db.destination_operators = [
    { destination_id: "d-ke", operator_name: "Safaricom", network_types: ["5G", "4G"], country_iso2: "KE", sort_order: 1, is_active: true },
    { destination_id: "d-ke", operator_name: "Airtel", network_types: ["4G"], country_iso2: "KE", sort_order: 2, is_active: true },
    { destination_id: "d-tz", operator_name: "Vodacom", network_types: ["4G", "3G"], country_iso2: "TZ", sort_order: 1, is_active: true },
    { destination_id: "d-ug", operator_name: "MTN", network_types: ["4G"], country_iso2: "UG", sort_order: 1, is_active: true },
    { destination_id: "d-bw", operator_name: "Mascom", network_types: ["4G"], country_iso2: null, sort_order: 1, is_active: true },
    { destination_id: "d-safari", operator_name: "Safaricom", network_types: ["4G"], country_iso2: "KE", sort_order: 1, is_active: true },
    { destination_id: "d-safari", operator_name: "Vodacom", network_types: ["4G"], country_iso2: "TZ", sort_order: 2, is_active: true },
    { destination_id: "d-safari", operator_name: "MTN", network_types: ["4G"], country_iso2: "UG", sort_order: 3, is_active: true },
  ];
  db.product = [
    { id: "p-ke", slug: "kenya", destination_id: "d-ke", status: "active", updated_at: null, product_variant: [variant("v-ke-1", 1, 4.99, { provider_config: SUPPLIER_CONFIG })] },
    { id: "p-tz", slug: "tanzania", destination_id: "d-tz", status: "active", updated_at: null, product_variant: [variant("v-tz-1", 1, 5.49)] },
    { id: "p-ug", slug: "uganda", destination_id: "d-ug", status: "active", updated_at: null, product_variant: [variant("v-ug-1", 1, 5.99, { provider: "esimgo" })] },
    {
      id: "p-bw", slug: "botswana", destination_id: "d-bw", status: "active", updated_at: null, product_variant: [
        variant("v-bw-3gb", 7, 19.99, { is_unlimited: false, data_amount_mb: 3072, variant_name: "Botswana 3 GB / 7 days", provider: "airalo" }),
        variant("v-bw-10gb", 30, 44.99, { is_unlimited: false, data_amount_mb: 10240, variant_name: "Botswana 10 GB / 30 days", provider: "airalo" }),
      ],
    },
    { id: "p-fr", slug: "france", destination_id: "d-fr", status: "active", updated_at: null, product_variant: [variant("v-fr-5gb", 15, 9.99, { is_unlimited: false, data_amount_mb: 5120 })] },
    { id: "p-safari", slug: "africa-safari", destination_id: "d-safari", status: "active", updated_at: null, product_variant: [variant("v-safari-1", 1, 7.99)] },
  ];
  db.destination_fair_use = [{ destination_id: "d-tz", highspeed_mb_per_day: 1536, reduced_speed_kbps: 256, tethering: false }];
  db.currency_conversion_rates = [
    { currency: "EUR", rate: 0.92, is_active: true },
    { currency: "KES", rate: 129.5, is_active: true },
  ];
  db.currency_rounding_rules = [{ currency: "KES", decimal_places: 0 }];
  db.system_settings = [
    { setting_key: "partner_catalog_pricing_source", setting_value: { source: "auto" } },
    { setting_key: "partner_catalog_fair_use_default", setting_value: { highspeed_mb_per_day: 1024, reduced_speed_kbps: 512 } },
  ];
  db.affiliates = [
    { id: "aff-1", referral_code: "TRAVELBOT", status: "approved" },
    { id: "aff-2", referral_code: "PAUSED", status: "pending" },
  ];
  const key = async (id: string, raw: string, extra: Record<string, unknown> = {}) => ({
    id, partner_slug: id, key_hash: await sha256(raw), rate_limit_per_hour: 600, revoked_at: null,
    request_count: 0, affiliate_id: null, default_format: "catalog", default_days: null, ...extra,
  });
  db.partner_api_keys = [
    await key("plain", KEYS.plain),
    await key("affiliate", KEYS.affiliate, { affiliate_id: "aff-1" }),
    await key("inactive", KEYS.inactiveAffiliate, { affiliate_id: "aff-2" }),
    await key("revoked", KEYS.revoked, { revoked_at: "2026-09-01T00:00:00Z" }),
    await key("limited", KEYS.limited, { rate_limit_per_hour: 3 }),
  ];
  db.rate_limits = [];
}

/** Imports an edge function and returns the handler it passes to Deno.serve. */
export async function loadHandler(url: string): Promise<(req: Request) => Promise<Response>> {
  let captured: ((req: Request) => Promise<Response>) | undefined;
  const serve = Deno.serve;
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    captured = h;
    return { finished: Promise.resolve(), shutdown() {} };
  };
  await import(url);
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Deno as any).serve = serve;
  if (!captured) throw new Error(`no handler captured from ${url}`);
  return captured;
}
