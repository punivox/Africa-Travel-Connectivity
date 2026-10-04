/**
 * Output format registry. Each comparator is one adapter over the same
 * normalized plan. Add a partner = add one entry here.
 */
import { groupNetworksByCountry } from "./networks.ts";

export interface Plan {
  id: string;
  name: string;
  destination_slug: string;
  destination_name: string;
  country_iso2: string | null;
  countries: string[];
  region: string | null;
  coverage_type: string;
  data_amount_mb: number | null;
  is_unlimited: boolean;
  highspeed_mb_per_day: number | null;
  reduced_speed_kbps: number | null;
  tethering: boolean;
  breakout_countries: string[];
  providers: string[];
  validity_days: number;
  price: number;
  price_usd: number;
  currency: string;
  operators: { name: string; network_types: string[]; country_iso2?: string | null }[];
  network_types: string[];
  plan_type: string;
  topup_available: boolean;
  status: string;
  product_url: string;
  checkout_url: string;
  last_updated: string;
}

export interface FormatAdapter {
  /** true = response body is a raw JSON array (no envelope) */
  rawArray: boolean;
  /** Plans the partner's rules forbid publishing (return reason) */
  exclude?: (p: Plan) => string | null;
  map: (p: Plan) => unknown;
}

const internal = (p: Plan) => {
  // Internal fields never published in the generic catalog.
  const { providers: _p, ...rest } = p;
  return rest;
};

export const FORMATS: Record<string, FormatAdapter> = {
  catalog: { rawArray: false, map: internal },

  "esims-io": {
    rawArray: false,
    map: (p) => ({
      provider: "SafarieSIM",
      plan_id: p.id,
      title: p.name,
      country_code: p.country_iso2,
      countries: p.countries,
      data_mb: p.data_amount_mb,
      unlimited: p.is_unlimited,
      daily_highspeed_mb: p.highspeed_mb_per_day,
      days: p.validity_days,
      price: p.price,
      currency: p.currency,
      networks: p.operators.map((o) => o.name),
      technology: p.network_types,
      url: p.checkout_url,
      in_stock: p.status === "available",
      updated_at: p.last_updated,
    }),
  },

  /** eSIMDB Provider API v1.0.2 — DataPlan */
  esimdb: {
    rawArray: true,
    exclude: (p) => {
      // eSIMDB forbids dataCap 0 for fair-use plans unless maxSpeed/breakouts are known.
      if (!p.is_unlimited && !p.data_amount_mb) return "missing_data_allowance";
      if (p.is_unlimited && !p.highspeed_mb_per_day && p.breakout_countries.length === 0) {
        return "missing_fair_use";
      }
      return null;
    },
    map: (p) => {
      const daily = p.is_unlimited && p.highspeed_mb_per_day;
      const capMb = daily ? p.highspeed_mb_per_day! : p.is_unlimited ? 0 : p.data_amount_mb ?? 0;
      const useGb = capMb >= 1024 && capMb % 1024 === 0;
      const byCountry = groupNetworksByCountry(
        p.operators.map((o) => ({ name: o.name, network_types: o.network_types, country_iso2: o.country_iso2 ?? null })),
        p.countries,
      );
      const coverages = p.countries.map((code) => ({ code, networks: byCountry[code] ?? [] }));
      const info: string[] = ["Sold and supported by SafarieSIM (safariesim.com)."];
      if (daily) info.push("High-speed allowance resets every 24 hours; speed is reduced after the daily cap.");
      info.push("Validity starts when the eSIM first connects to a supported network.");
      info.push("Pick exact travel dates at checkout; other durations are available on the website.");
      return {
        provider: "SafarieSIM",
        planName: p.name.slice(0, 100),
        validity: p.validity_days,
        dataCap: useGb ? capMb / 1024 : capMb,
        dataUnit: useGb ? "GB" : "MB",
        dataCapPer: daily ? "day" : null,
        maxSpeed: null,
        reducedSpeed: daily ? p.reduced_speed_kbps ?? null : null,
        prices: { [p.currency]: p.price },
        coverages,
        internetBreakouts: p.breakout_countries.length ? p.breakout_countries.map((country) => ({ country })) : null,
        telephony: null,
        subscription: false,
        canTopUp: p.topup_available,
        eKYC: false,
        tethering: p.tethering,
        promoEnabled: true,
        newUserOnly: false,
        hasAds: false,
        payAsYouGo: false,
        additionalInfo: info.join("\n"),
        link: p.checkout_url,
      };
    },
  },
};
