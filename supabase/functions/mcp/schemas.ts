/**
 * Output schemas for every tool, advertised in tools/list so agents know the
 * exact shape of a result before calling. The SDK validates each result
 * against its schema, so these must match the views in catalog.ts.
 */
import { z } from "npm:zod@4.6.5";

export const Country = z.object({
  iso2: z.string().describe("ISO 3166-1 alpha-2 code"),
  name: z.string().describe("English country name"),
});

export const Network = z.object({
  country: z.string().describe("ISO code of the country this operator serves"),
  operator: z.string(),
  network_types: z.array(z.string()).describe("e.g. 5G, 4G, 3G"),
});

export const Plan = z.object({
  name: z.string(),
  destination: z.object({
    name: z.string(),
    slug: z.string(),
    url: z.string().describe("SafarieSIM product page"),
  }),
  coverage: z.object({
    type: z.enum(["single_country", "multi_country"]),
    countries: z.array(z.string()).describe("ISO codes of every country the plan works in"),
  }),
  validity_days: z.number().describe("Days the plan lasts"),
  data: z.object({
    unlimited: z.boolean(),
    total_gb: z.number().nullable().describe("Total data for fixed-data plans; null for unlimited or unpublished"),
    high_speed_gb_per_day: z.number().nullable().describe("Daily full-speed allowance of an unlimited plan, if known"),
    speed_after_cap_kbps: z.number().nullable().describe("Speed after the daily allowance, if known"),
    summary: z.string(),
  }),
  price: z.object({
    amount: z.number().describe("Final price for one traveller for the whole plan, as charged at checkout"),
    currency: z.string(),
    per_day: z.number(),
  }),
  networks: z.array(Network).describe("Operators used in the countries asked about"),
  hotspot_allowed: z.boolean(),
  top_up_available: z.boolean(),
  checkout_url: z.string().describe("Opens SafarieSIM checkout with this plan selected"),
});

export const SearchOutput = z.object({
  countries: z.array(Country),
  days: z.number().nullable().describe("Trip length priced; null when standard durations were listed"),
  currency: z.string(),
  filters: z.object({
    min_data_gb: z.number().nullable(),
    unlimited_only: z.boolean(),
    max_price: z.number().nullable(),
  }),
  total_matches: z.number(),
  plans: z.array(Plan),
  note: z.string().optional(),
});

export const CompareOutput = z.object({
  days: z.number(),
  days_defaulted: z.boolean().describe("True when no trip length was given and 7 days was assumed"),
  currency: z.string(),
  countries: z.array(z.object({
    country: Country,
    plans_available: z.number(),
    cheapest: Plan.nullable(),
    cheapest_unlimited: Plan.nullable(),
    networks: z.array(z.object({ operator: z.string(), network_types: z.array(z.string()) })),
  })),
  single_esim_for_all: z.array(Plan).nullable().describe("Cheapest plans covering every country; null for one country"),
  note: z.string(),
});

export const NetworksOutput = z.object({
  country: Country,
  network_types: z.array(z.string()),
  networks: z.array(z.object({
    operator: z.string(),
    network_types: z.array(z.string()),
    offered_on: z.array(z.object({
      destination: z.string(),
      slug: z.string(),
      coverage: z.enum(["single_country", "multi_country"]),
      url: z.string(),
    })),
  })),
  note: z.string(),
});

export const DataOutput = z.object({
  days: z.number(),
  devices: z.number(),
  profile: z.enum(["light", "moderate", "heavy"]),
  daily_mb: z.number(),
  total_gb: z.number(),
  breakdown: z.array(z.object({
    activity: z.string(),
    amount_per_day: z.number(),
    unit: z.string(),
    mb_per_day: z.number(),
  })),
  recommendation: z.object({
    plan_type: z.enum(["unlimited", "fixed_data"]),
    reason: z.string(),
  }),
  matching_plans: z.array(Plan).optional(),
  currency: z.string().optional(),
  assumptions: z.string(),
});

export const DestinationsOutput = z.object({
  region: z.enum(["africa", "all"]),
  total: z.number(),
  destinations: z.array(z.object({
    name: z.string(),
    slug: z.string(),
    type: z.enum(["single_country", "multi_country"]),
    country: Country.nullable().describe("Set for single-country destinations"),
    countries_covered: z.number(),
    plan_types: z.array(z.enum(["unlimited", "fixed_data"])),
    flag: z.string().nullable(),
    url: z.string(),
  })),
});
