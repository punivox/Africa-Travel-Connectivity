/**
 * Africa Travel Connectivity — the MCP server's metadata and tools, built over
 * the live Safari eSIM catalog. index.ts builds one instance per request
 * (stateless) and handles transport, auth and rate limits.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { McpServer } from "npm:@modelcontextprotocol/server@2.3.0";
import { z } from "npm:zod@4.6.5";
import type { Plan } from "../_shared/catalog/formats.ts";
import { type CatalogData, parseDays, SITE } from "../_shared/catalog/buildCatalog.ts";
import type { PartnerKey } from "../_shared/catalog/partnerKeys.ts";
import { AFRICA, countryName, countryRef, fold, resolveCountry } from "./geo.ts";
import {
  byPrice,
  catalogData,
  destinationNames,
  networksFor,
  plansCoveringAll,
  planView,
  priceCatalog,
  supportedCurrencies,
} from "./catalog.ts";
import { type Activity, ASSUMPTIONS, estimateData, type Profile } from "./dataUsage.ts";
import * as S from "./schemas.ts";

export const SERVER_VERSION = "1.0.0";
export const ICON_URL = "https://raw.githubusercontent.com/punivox/africa-travel-connectivity/main/assets/icon-512.png";

/** Per-request caller context, set by index.ts. */
export interface CallerContext {
  /** The partner key, when the caller sent one: adds ref= attribution and the key's own limits. */
  key: PartnerKey | null;
  withRef: (url: string) => string;
}

const INSTRUCTIONS = `Africa Travel Connectivity answers travel eSIM questions with live plans and prices from Safari eSIM (safariesim.com). It covers African destinations first and also works for the other countries Safari eSIM sells. All tools are read-only.

Which tool to use:
- search_esim_plans: plans that work in every country of a trip, filtered by trip length, data, budget and currency.
- compare_country_plans: side-by-side options for each country, plus single plans that cover all of them.
- get_country_networks: mobile operators and network types (5G, 4G) per country.
- calculate_safari_data: how much data a trip needs, optionally matched to plans that fit.
- list_destinations: which countries and regions are covered.

Guidance:
- Countries can be ISO codes or English names. Ask for the trip length when it matters.
- Prices are final per-traveller prices that match Safari eSIM checkout. Always state the currency.
- To buy, give the user the plan's checkout_url. This server cannot purchase anything.
- This server knows operators per country, not signal at specific parks or lodges. Say so rather than guessing coverage.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const ok = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const countriesField = z
  .array(z.string().trim().min(2).max(60))
  .min(1)
  .max(10)
  .describe("Countries on the trip, as ISO 3166-1 alpha-2 codes (KE, TZ) or English names (Kenya, Tanzania, Zanzibar).");
const currencyField = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .optional()
  .describe("ISO 4217 code for prices, e.g. USD, EUR, GBP, KES. Defaults to USD. An unsupported code returns the supported list.");

const SearchInput = z.object({
  countries: countriesField,
  days: z.number().int().min(1).max(365).optional()
    .describe("Trip length in days. Calendar plans are priced for exactly this many days; fixed packages must last at least this long. Omit to list the standard durations."),
  min_data_gb: z.number().min(0).max(1000).optional()
    .describe("Minimum total data for the trip in GB (calculate_safari_data can estimate it). Unlimited plans always qualify."),
  unlimited_only: z.boolean().optional().describe("Only return unlimited-data plans."),
  max_price: z.number().positive().optional().describe("Maximum total price, in the requested currency."),
  currency: currencyField,
  limit: z.number().int().min(1).max(25).optional().describe("Maximum number of plans to return. Defaults to 10."),
});

const CompareInput = z.object({
  countries: countriesField,
  days: z.number().int().min(1).max(365).optional().describe("Trip length in days. Defaults to 7."),
  currency: currencyField,
});

const NetworksInput = z.object({
  country: z.string().trim().min(2).max(60).describe("ISO 3166-1 alpha-2 code or English name, e.g. TZ or Tanzania."),
});

const usageField = (what: string) => z.number().min(0).max(1440).optional().describe(`${what} per day, in minutes.`);
const DataInput = z.object({
  days: z.number().int().min(1).max(365).describe("Trip length in days."),
  profile: z.enum(["light", "moderate", "heavy"]).optional()
    .describe("light: messaging and maps. moderate (default): plus social media, photo uploads and short video calls. heavy: plus long video calls and streaming."),
  daily_usage: z.object({
    messaging_minutes: usageField("Messaging"),
    maps_minutes: usageField("Maps and navigation"),
    web_minutes: usageField("Web browsing"),
    social_media_minutes: usageField("Social media"),
    video_call_minutes: usageField("Video calls"),
    streaming_minutes: usageField("Video streaming"),
    photos_uploaded: z.number().int().min(0).max(2000).optional().describe("Photos uploaded per day."),
  }).optional().describe("Per-day amounts that override the profile's defaults."),
  devices: z.number().int().min(1).max(10).optional().describe("Devices sharing the data through a hotspot. Defaults to 1."),
  countries: countriesField.optional().describe("If given, also returns the cheapest plans covering these countries that fit the estimate."),
  currency: currencyField,
});

const DestinationsInput = z.object({
  region: z.enum(["africa", "all"]).optional()
    .describe("africa (default): African countries and multi-country plans that are mostly African. all: every destination."),
  query: z.string().trim().min(1).max(60).optional()
    .describe("Filter by name, ISO code or covered country, e.g. \"tanzania\", \"TZ\", \"safari\"."),
});

type TypeOrdered = { operator: string; network_types: string[] };
const TYPE_ORDER = ["5G", "LTE", "4G", "3G", "2G"];
const typeRank = (t: string) => (TYPE_ORDER.indexOf(t) === -1 ? 99 : TYPE_ORDER.indexOf(t));
const sortTypes = (types: Iterable<string>) => [...new Set(types)].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));

/** Merges operator lists from several plans: one entry per operator, network types unioned. */
function mergeNetworks(lists: { operator: string; network_types: string[] }[]): TypeOrdered[] {
  const byName = new Map<string, TypeOrdered>();
  for (const n of lists) {
    const key = n.operator.toLowerCase();
    const entry = byName.get(key) ?? { operator: n.operator, network_types: [] };
    entry.network_types = sortTypes([...entry.network_types, ...n.network_types]);
    byName.set(key, entry);
  }
  return [...byName.values()].sort((a, b) => a.operator.localeCompare(b.operator));
}

export function buildServer(supabase: SupabaseClient, caller: CallerContext) {
  const server = new McpServer(
    {
      name: "africa-travel-connectivity",
      title: "Africa Travel Connectivity",
      version: SERVER_VERSION,
      websiteUrl: SITE,
      icons: [{ src: ICON_URL, mimeType: "image/png", sizes: ["512x512"] }],
    },
    {
      instructions: INSTRUCTIONS,
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  // A partner key's default durations apply exactly as they do in partner-catalog.
  const keyDays = caller.key?.default_days?.length ? parseDays(caller.key.default_days.join(",")) : null;
  const defaultDays = keyDays && "days" in keyDays ? keyDays.days : null;

  function resolveAll(data: CatalogData, inputs: string[]): { isos: string[] } | { error: string } {
    const names = destinationNames(data);
    const isos: string[] = [];
    const errors: string[] = [];
    for (const input of inputs) {
      const r = resolveCountry(input, names);
      if ("error" in r) errors.push(r.error);
      else if (!isos.includes(r.iso2)) isos.push(r.iso2);
    }
    return errors.length ? { error: errors.join(" ") } : { isos };
  }

  function priced(
    data: CatalogData,
    currency: string | undefined,
    days: number[] | null,
  ): { error: string } | { plans: Plan[]; currency: string } {
    const code = (currency ?? "USD").toUpperCase();
    const result = priceCatalog(data, { currency: code, days, withRef: caller.withRef });
    if (!result.ok) return { error: `${result.message} Supported currencies: ${supportedCurrencies(data).join(", ")}.` };
    return { plans: result.catalog.plans, currency: code };
  }

  const uncoveredNote = (plans: Plan[], isos: string[]) => {
    const missing = isos.filter((c) => !plans.some((p) => p.countries.includes(c)));
    return missing.length
      ? `No Safari eSIM plan currently covers ${missing.map((c) => `${countryName(c)} (${c})`).join(", ")}.`
      : null;
  };

  const guard = <A,>(name: string, fn: (args: A) => Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      console.error(`mcp tool ${name} failed`, err);
      return fail("The catalog is temporarily unavailable. Retry shortly.");
    }
  };

  server.registerTool(
    "search_esim_plans",
    {
      title: "Search eSIM plans",
      description:
        "Find travel eSIM plans that work in every country of a trip, cheapest first. Use it for questions like " +
        "\"best eSIM for a 10-day Kenya safari\" or \"one eSIM for Kenya, Tanzania and Uganda under $40\". " +
        "Each plan includes its data allowance (or unlimited with its daily full-speed cap), validity, price in the " +
        "requested currency, the operators it uses in those countries, and a checkout_url. Prices are live and match " +
        "Safari eSIM checkout. If no single plan covers every country, use compare_country_plans.",
      inputSchema: SearchInput,
      outputSchema: S.SearchOutput,
      annotations: { title: "Search eSIM plans", ...READ_ONLY },
    },
    guard("search_esim_plans", async (args: z.infer<typeof SearchInput>) => {
      const data = await catalogData(supabase);
      const resolved = resolveAll(data, args.countries);
      if ("error" in resolved) return fail(resolved.error);
      const { isos } = resolved;
      const pricedPlans = priced(data, args.currency, args.days ? [args.days] : defaultDays);
      if ("error" in pricedPlans) return fail(pricedPlans.error);

      const minMb = (args.min_data_gb ?? 0) * 1024;
      const matches = plansCoveringAll(pricedPlans.plans, isos)
        .filter((p) => !args.days || p.validity_days >= args.days)
        .filter((p) => !args.unlimited_only || p.is_unlimited)
        .filter((p) => !minMb || p.is_unlimited || (p.data_amount_mb ?? 0) >= minMb)
        .filter((p) => args.max_price === undefined || p.price <= args.max_price)
        // With a trip length, cheapest first; without one, a ladder of durations.
        .sort((a, b) => (args.days ? byPrice(a, b) : a.validity_days - b.validity_days || byPrice(a, b)));

      let note: string | null = null;
      if (matches.length === 0) {
        note = uncoveredNote(pricedPlans.plans, isos) ??
          (isos.length > 1 && plansCoveringAll(pricedPlans.plans, isos).length === 0
            ? "No single plan covers all of these countries. Use compare_country_plans to see the options for each country."
            : "No plan matches these filters for this trip length. Relax max_price, min_data_gb or unlimited_only, or try another trip length.");
      }
      return ok({
        countries: isos.map(countryRef),
        days: args.days ?? null,
        currency: pricedPlans.currency,
        filters: {
          min_data_gb: args.min_data_gb ?? null,
          unlimited_only: !!args.unlimited_only,
          max_price: args.max_price ?? null,
        },
        total_matches: matches.length,
        plans: matches.slice(0, args.limit ?? 10).map((p) => planView(p, isos)),
        ...(note ? { note } : {}),
      });
    }),
  );

  server.registerTool(
    "compare_country_plans",
    {
      title: "Compare plans by country",
      description:
        "Compare eSIM options country by country for a trip: the cheapest plan and the cheapest unlimited plan in " +
        "each country, the operators used there, and the cheapest single plans that cover every country (useful " +
        "for multi-country safaris such as Kenya, Tanzania and Uganda). Use it for \"compare Kenya and Tanzania\" or " +
        "when search_esim_plans finds no plan covering all countries. Prices are for the whole trip length.",
      inputSchema: CompareInput,
      outputSchema: S.CompareOutput,
      annotations: { title: "Compare plans by country", ...READ_ONLY },
    },
    guard("compare_country_plans", async (args: z.infer<typeof CompareInput>) => {
      const data = await catalogData(supabase);
      const resolved = resolveAll(data, args.countries);
      if ("error" in resolved) return fail(resolved.error);
      const { isos } = resolved;
      const days = args.days ?? 7;
      const pricedPlans = priced(data, args.currency, [days]);
      if ("error" in pricedPlans) return fail(pricedPlans.error);

      const eligible = pricedPlans.plans.filter((p) => p.validity_days >= days);
      const countries = isos.map((iso) => {
        const covering = eligible.filter((p) => p.countries.includes(iso)).sort(byPrice);
        const unlimited = covering.find((p) => p.is_unlimited);
        return {
          country: countryRef(iso),
          plans_available: covering.length,
          cheapest: covering[0] ? planView(covering[0], [iso]) : null,
          cheapest_unlimited: unlimited ? planView(unlimited, [iso]) : null,
          networks: mergeNetworks(covering.flatMap((p) => networksFor(p, [iso]))),
        };
      });
      const all = isos.length > 1 ? plansCoveringAll(eligible, isos).sort(byPrice).slice(0, 3) : null;

      const notes = [uncoveredNote(eligible, isos)];
      if (all) {
        notes.push(all.length
          ? "single_esim_for_all lists the cheapest plans that cover every country for the whole trip."
          : "No single plan covers all of these countries; buy one plan per country.");
      }
      notes.push(isos.length > 1
        ? `Prices are for all ${days} days. If the trip is split between countries, compare price.per_day.`
        : `Prices are for all ${days} days.`);
      return ok({
        days,
        days_defaulted: args.days === undefined,
        currency: pricedPlans.currency,
        countries,
        single_esim_for_all: all ? all.map((p) => planView(p, isos)) : null,
        note: notes.filter(Boolean).join(" "),
      });
    }),
  );

  server.registerTool(
    "get_country_networks",
    {
      title: "Get mobile networks for a country",
      description:
        "List the mobile operators and network types (5G, 4G, 3G) that Safari eSIM plans use in a country, and which " +
        "plans use each operator. Use it for \"which network does the Tanzania eSIM use?\" or \"is there 5G in " +
        "Kenya?\". It does not know signal strength at specific parks, lodges or roads.",
      inputSchema: NetworksInput,
      outputSchema: S.NetworksOutput,
      annotations: { title: "Get mobile networks for a country", ...READ_ONLY },
    },
    guard("get_country_networks", async (args: z.infer<typeof NetworksInput>) => {
      const data = await catalogData(supabase);
      const resolved = resolveAll(data, [args.country]);
      if ("error" in resolved) return fail(resolved.error);
      const iso = resolved.isos[0];
      const pricedPlans = priced(data, "USD", null);
      if ("error" in pricedPlans) return fail(pricedPlans.error);

      // One representative plan per destination: operators are recorded per destination.
      const perDestination = new Map<string, Plan>();
      for (const p of pricedPlans.plans) if (p.countries.includes(iso) && !perDestination.has(p.destination_slug)) perDestination.set(p.destination_slug, p);

      const byOperator = new Map<string, { operator: string; network_types: string[]; offered_on: Map<string, unknown> }>();
      for (const p of perDestination.values()) {
        for (const n of networksFor(p, [iso])) {
          const key = n.operator.toLowerCase();
          const entry = byOperator.get(key) ?? { operator: n.operator, network_types: [], offered_on: new Map() };
          entry.network_types = sortTypes([...entry.network_types, ...n.network_types]);
          entry.offered_on.set(p.destination_slug, {
            destination: p.destination_name,
            slug: p.destination_slug,
            coverage: p.countries.length === 1 ? "single_country" : "multi_country",
            url: p.product_url,
          });
          byOperator.set(key, entry);
        }
      }
      const networks = [...byOperator.values()]
        .sort((a, b) => a.operator.localeCompare(b.operator))
        .map((e) => ({ operator: e.operator, network_types: e.network_types, offered_on: [...e.offered_on.values()] }));

      const lead = perDestination.size === 0
        ? `No Safari eSIM plan currently covers ${countryName(iso)}.`
        : networks.length === 0
        ? `Operator details are not recorded for ${countryName(iso)} yet.`
        : `Operators come from the Safari eSIM catalog.`;
      return ok({
        country: countryRef(iso),
        network_types: sortTypes(networks.flatMap((n) => n.network_types)),
        networks,
        note: `${lead} Signal in remote areas such as national parks depends on each operator's local coverage, which this server does not track.`,
      });
    }),
  );

  server.registerTool(
    "calculate_safari_data",
    {
      title: "Estimate trip data needs",
      description:
        "Estimate how much mobile data a trip needs from its length and typical activities (messaging, maps, social " +
        "media, photo uploads, video calls, streaming), including devices sharing a hotspot. Returns daily and total " +
        "figures with the rates used, a recommendation between unlimited and fixed-data plans, and — when countries " +
        "are given — the cheapest live plans that fit. Use it for \"how much data do I need for a 10-day safari?\".",
      inputSchema: DataInput,
      outputSchema: S.DataOutput,
      annotations: { title: "Estimate trip data needs", ...READ_ONLY },
    },
    guard("calculate_safari_data", async (args: z.infer<typeof DataInput>) => {
      const profile: Profile = args.profile ?? "moderate";
      const devices = args.devices ?? 1;
      const overrides = Object.fromEntries(
        Object.entries(args.daily_usage ?? {}).filter(([, v]) => typeof v === "number"),
      ) as Partial<Record<Activity, number>>;
      const est = estimateData(args.days, profile, overrides, devices);
      const neededGb = Math.ceil(est.total_gb * 1.2 * 10) / 10;
      const generic = est.daily_mb >= 800 || est.total_gb >= 10
        ? { plan_type: "unlimited" as const, reason: `About ${est.daily_mb} MB a day is heavy use; an unlimited plan avoids running out.` }
        : { plan_type: "fixed_data" as const, reason: `A fixed-data plan with at least ${neededGb} GB covers the estimate plus 20% headroom.` };
      const base = {
        days: args.days,
        devices,
        profile,
        daily_mb: est.daily_mb,
        total_gb: est.total_gb,
        breakdown: est.breakdown,
        assumptions: ASSUMPTIONS,
      };
      if (!args.countries?.length) return ok({ ...base, recommendation: generic });

      const data = await catalogData(supabase);
      const resolved = resolveAll(data, args.countries);
      if ("error" in resolved) return fail(resolved.error);
      const { isos } = resolved;
      const pricedPlans = priced(data, args.currency, [args.days]);
      if ("error" in pricedPlans) return fail(pricedPlans.error);

      const fits = plansCoveringAll(pricedPlans.plans, isos)
        .filter((p) => p.validity_days >= args.days)
        .filter((p) =>
          p.is_unlimited
            ? !p.highspeed_mb_per_day || p.highspeed_mb_per_day >= est.daily_mb
            : (p.data_amount_mb ?? 0) >= neededGb * 1024
        )
        .sort(byPrice);
      const best = fits[0];
      const recommendation = best
        ? {
          plan_type: best.is_unlimited ? "unlimited" as const : "fixed_data" as const,
          reason: `Cheapest plan covering ${isos.join(", ")} for ${args.days} days that fits about ${est.daily_mb} MB a day: ` +
            `${best.name} at ${best.price} ${pricedPlans.currency}.`,
        }
        : {
          ...generic,
          reason: `${generic.reason} ${uncoveredNote(pricedPlans.plans, isos) ?? "No plan covering all of these countries fits the estimate; compare_country_plans shows the options per country."}`,
        };
      return ok({
        ...base,
        recommendation,
        matching_plans: fits.slice(0, 3).map((p) => planView(p, isos)),
        currency: pricedPlans.currency,
      });
    }),
  );

  server.registerTool(
    "list_destinations",
    {
      title: "List destinations",
      description:
        "List the destinations Safari eSIM covers — African countries and multi-country plans by default — with " +
        "their type (single or multi-country), the plan types offered and the product page. Use it for \"which " +
        "African countries do you cover?\" or to find which plans include a country (query: \"TZ\").",
      inputSchema: DestinationsInput,
      outputSchema: S.DestinationsOutput,
      annotations: { title: "List destinations", ...READ_ONLY },
    },
    guard("list_destinations", async (args: z.infer<typeof DestinationsInput>) => {
      const data = await catalogData(supabase);
      const pricedPlans = priced(data, "USD", null);
      if ("error" in pricedPlans) return fail(pricedPlans.error);
      const region = args.region ?? "africa";

      const bySlug = new Map<string, Plan[]>();
      for (const p of pricedPlans.plans) bySlug.set(p.destination_slug, [...(bySlug.get(p.destination_slug) ?? []), p]);

      const query = args.query?.trim();
      const queryIso = query ? resolveCountry(query, destinationNames(data)) : null;
      const isoFilter = queryIso && "iso2" in queryIso ? queryIso.iso2 : null;

      const destinations = data.destinations
        .filter((d) => bySlug.has(d.slug))
        .map((d) => {
          const plans = bySlug.get(d.slug)!;
          const countries = plans[0].countries;
          const single = countries.length === 1;
          return {
            name: d.name,
            slug: d.slug,
            type: single ? "single_country" as const : "multi_country" as const,
            country: single ? countryRef(countries[0]) : null,
            countries_covered: countries.length,
            plan_types: [...new Set(plans.map((p) => (p.is_unlimited ? "unlimited" as const : "fixed_data" as const)))].sort(),
            flag: d.flag_emoji ?? null,
            url: plans[0].product_url,
            _countries: countries,
          };
        })
        .filter((d) => region === "all" || (d.type === "single_country"
          ? AFRICA.has(d._countries[0])
          : d._countries.filter((c) => AFRICA.has(c)).length * 2 >= d._countries.length))
        .filter((d) => !query || (isoFilter ? d._countries.includes(isoFilter) : fold(d.name).includes(fold(query)) || d.slug.includes(fold(query).replace(/ /g, "-"))))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "single_country" ? -1 : 1))
        .map(({ _countries, ...rest }) => rest);

      return ok({ region, total: destinations.length, destinations });
    }),
  );

  return server;
}
