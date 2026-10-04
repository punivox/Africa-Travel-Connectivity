/**
 * End-to-end tests for the MCP endpoint: real HTTP requests into the edge
 * function's handler, with Supabase replaced by an in-memory fake (see
 * import_map.json). Run with `deno task test`.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { KEYS, loadHandler, seed } from "./fixtures.ts";
import { createClient, db } from "./fake_supabase.ts";
import { loadCatalog } from "../supabase/functions/_shared/catalog/buildCatalog.ts";
import { resetCatalogCache } from "../supabase/functions/mcp/catalog.ts";

const mcp = await loadHandler(new URL("../supabase/functions/mcp/index.ts", import.meta.url).href);
const URL_ = "https://api.safariesim.com/functions/v1/mcp";

const reset = async () => {
  await seed();
  resetCatalogCache();
};

let ip = 0;
let id = 1;
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "tests", version: "0" },
};

type Era = "legacy" | "modern";
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  o: { era?: Era; key?: string; ip?: string; notify?: boolean; raw?: string; headers?: Record<string, string> } = {},
) {
  const era = o.era ?? "modern";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "cf-connecting-ip": o.ip ?? `192.0.2.${(ip++ % 250) + 1}`,
    "mcp-protocol-version": era === "modern" ? "2026-07-28" : "2025-11-25",
  };
  if (era === "modern") {
    headers["mcp-method"] = method;
    if (method === "tools/call") headers["mcp-name"] = String(params.name);
  }
  if (o.key) headers["x-api-key"] = o.key;
  Object.assign(headers, o.headers ?? {});
  const p = era === "modern" ? { ...params, _meta: META } : params;
  const body = o.raw ??
    JSON.stringify(o.notify ? { jsonrpc: "2.0", method, params: p } : { jsonrpc: "2.0", id: id++, method, params: p });
  const res = await mcp(new Request(URL_, { method: "POST", headers, body }));
  const text = await res.text();
  // 2025-era responses may arrive as a one-event SSE stream.
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? ""
    : text;
  let json: Json = null;
  try {
    json = payload ? JSON.parse(payload) : null;
  } catch { /* asserted by callers */ }
  return { status: res.status, headers: res.headers, text, json };
}

const outputs: string[] = [];
async function call(name: string, args: Record<string, unknown> = {}, o: { era?: Era; key?: string } = {}) {
  const r = await rpc("tools/call", { name, arguments: args }, o);
  assertEquals(r.status, 200, r.text);
  const res = r.json.result;
  outputs.push(res.content[0].text);
  return { isError: !!res.isError, text: res.content[0].text as string, data: res.structuredContent as Json };
}

const fingerprint = (p: Json) => `${p.checkout_url}|${p.validity_days}|${p.price.amount ?? p.price}`;

Deno.test("2025-era clients: initialize, initialized, tools/list", async () => {
  await reset();
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "tests", version: "0" },
  }, { era: "legacy" });
  assertEquals(init.status, 200, init.text);
  const result = init.json.result;
  assertEquals(result.serverInfo.name, "africa-travel-connectivity");
  assertEquals(result.serverInfo.title, "Africa Travel Connectivity");
  assert(result.serverInfo.description.includes("Africa"), "directories read the description");
  assert(result.instructions.includes("search_esim_plans"));
  assertEquals(init.headers.get("mcp-session-id"), null, "stateless: no session id");
  assertEquals((await rpc("notifications/initialized", {}, { era: "legacy", notify: true })).status, 202);

  const tools = (await rpc("tools/list", {}, { era: "legacy" })).json.result.tools;
  assertEquals(tools.map((t: Json) => t.name), [
    "search_esim_plans",
    "compare_country_plans",
    "get_country_networks",
    "calculate_safari_data",
    "list_destinations",
  ]);
  for (const t of tools) {
    assert(t.title && t.annotations.title, `${t.name}: title`);
    assertEquals(t.annotations.readOnlyHint, true);
    assertEquals(t.annotations.destructiveHint, false);
    assertEquals(t.outputSchema.type, "object");
  }
});

Deno.test("2026-07-28 clients: server/discover and cacheable tools/list", async () => {
  await reset();
  const discover = await rpc("server/discover");
  assert(discover.json.result.supportedVersions.includes("2026-07-28"));
  const list = await rpc("tools/list");
  assertEquals(list.json.result.cacheScope, "public");
  assertEquals(list.json.result.tools.length, 5);
});

Deno.test("search_esim_plans returns the catalog builder's prices", async () => {
  await reset();
  for (const currency of ["USD", "EUR", "KES"]) {
    for (const days of [1, 7, 10, 30]) {
      const result = await call("search_esim_plans", { countries: ["KE"], days, currency, limit: 25 });
      const built = await loadCatalog(createClient("", "") as never, { slug: null, currency, requestedDays: [days], withRef: (u) => u });
      assert(built.ok);
      const expected = built.catalog.plans
        .filter((p) => p.countries.includes("KE") && p.validity_days >= days)
        .sort((a, b) => a.price - b.price || a.validity_days - b.validity_days || a.destination_slug.localeCompare(b.destination_slug))
        .map(fingerprint);
      assertEquals(result.data.plans.map(fingerprint), expected, `${currency} ${days}d`);
      assert(result.data.plans.every((p: Json) => p.price.currency === currency));
    }
  }
});

Deno.test("search_esim_plans: multi-country, filters and empty results", async () => {
  await reset();
  const trip = await call("search_esim_plans", { countries: ["Kenya", "Tanzania", "Uganda"], days: 10 });
  assertEquals(trip.data.plans.map((p: Json) => p.destination.slug), ["africa-safari"]);
  assertEquals(trip.data.plans[0].networks.map((n: Json) => `${n.country}:${n.operator}`), ["KE:Safaricom", "TZ:Vodacom", "UG:MTN"]);

  const data = await call("search_esim_plans", { countries: ["BW"], days: 7, min_data_gb: 5 });
  assertEquals(data.data.plans.map((p: Json) => p.data.total_gb), [10]);
  const cheap = await call("search_esim_plans", { countries: ["KE"], days: 7, max_price: 1 });
  assertEquals(cheap.data.total_matches, 0);
  assert(/Relax max_price/.test(cheap.data.note));
  const split = await call("search_esim_plans", { countries: ["KE", "FR"], days: 7 });
  assert(/No single plan covers/.test(split.data.note));
  const uncovered = await call("search_esim_plans", { countries: ["ER"], days: 7 });
  assert(/No SafarieSIM plan currently covers Eritrea/.test(uncovered.data.note));
});

Deno.test("compare_country_plans", async () => {
  await reset();
  const r = await call("compare_country_plans", { countries: ["KE", "TZ", "UG"], days: 10, currency: "EUR" });
  assertEquals(r.data.currency, "EUR");
  assertEquals(r.data.countries.map((c: Json) => c.country.iso2), ["KE", "TZ", "UG"]);
  for (const c of r.data.countries) assert(c.cheapest.price.amount <= (c.cheapest_unlimited?.price.amount ?? Infinity));
  assertEquals(r.data.single_esim_for_all.map((p: Json) => p.destination.slug), ["africa-safari"]);
  const defaulted = await call("compare_country_plans", { countries: ["BW"] });
  assertEquals([defaulted.data.days, defaulted.data.days_defaulted, defaulted.data.single_esim_for_all], [7, true, null]);
});

Deno.test("get_country_networks", async () => {
  await reset();
  const ke = await call("get_country_networks", { country: "kenya" });
  assertEquals(ke.data.networks.map((n: Json) => [n.operator, n.network_types, n.offered_on.map((o: Json) => o.slug)]), [
    ["Airtel", ["4G"], ["kenya"]],
    ["Safaricom", ["5G", "4G"], ["africa-safari", "kenya"]],
  ]);
  const bw = await call("get_country_networks", { country: "BW" });
  assertEquals(bw.data.networks.map((n: Json) => n.operator), ["Mascom"], "operators without a country belong to single-country plans");
  assert(/does not track/.test(ke.data.note));
});

Deno.test("calculate_safari_data", async () => {
  await reset();
  const light = await call("calculate_safari_data", { days: 10, profile: "light" });
  const moderate = await call("calculate_safari_data", { days: 10 });
  assertEquals([light.data.daily_mb, moderate.data.daily_mb], [89, 312]);
  assertEquals(light.data.recommendation.plan_type, "fixed_data");
  const heavy = await call("calculate_safari_data", { days: 10, profile: "heavy", devices: 2 });
  assertEquals(heavy.data.recommendation.plan_type, "unlimited");
  const custom = await call("calculate_safari_data", { days: 5, daily_usage: { streaming_minutes: 0, video_call_minutes: 0 }, profile: "heavy" });
  assert(custom.data.breakdown.every((b: Json) => !/Video/.test(b.activity)));
  const fit = await call("calculate_safari_data", { days: 7, countries: ["BW"] });
  assertEquals(fit.data.matching_plans.map((p: Json) => p.data.total_gb), [3, 10]);
});

Deno.test("list_destinations", async () => {
  await reset();
  const africa = await call("list_destinations", {});
  assertEquals(africa.data.destinations.map((d: Json) => d.slug), ["botswana", "kenya", "tanzania", "uganda", "africa-safari"]);
  const all = await call("list_destinations", { region: "all" });
  assert(all.data.destinations.some((d: Json) => d.slug === "france"));
  assert(!all.data.destinations.some((d: Json) => d.slug === "atlantis"), "inactive destinations are hidden");
  const tz = await call("list_destinations", { query: "TZ" });
  assertEquals(tz.data.destinations.map((d: Json) => d.slug), ["tanzania", "africa-safari"]);
});

Deno.test("country names, aliases and invalid input", async () => {
  await reset();
  const names = await call("search_esim_plans", { countries: ["zanzibar", "Côte d'Ivoire", "uk", "DRC"], days: 7 });
  assertEquals(names.data.countries.map((c: Json) => c.iso2), ["TZ", "CI", "GB", "CD"]);
  for (
    const [args, pattern] of [
      [{ countries: ["Atlantis"], days: 7 }, /not a recognised country/],
      [{ countries: ["South"], days: 7 }, /ambiguous/],
      [{ countries: ["KE"], days: 7, currency: "XYZ" }, /Supported currencies: EUR, KES, USD/],
      [{ countries: [], days: 7 }, /validation/i],
      [{ countries: ["KE"], days: 0 }, /validation/i],
      [{ countries: ["KE"], days: 7, limit: 100 }, /validation/i],
    ] as const
  ) {
    const r = await call("search_esim_plans", args as Record<string, unknown>);
    assert(r.isError, `${JSON.stringify(args)} should be rejected`);
    assert(pattern.test(r.text), r.text);
  }
  const malformed = await rpc("tools/list", {}, { raw: "{not json" });
  assertEquals(malformed.status, 400);
  assertEquals(malformed.json.error.code, -32700);
});

Deno.test("HTTP: CORS, methods, partner keys, rate limits, body size", async () => {
  await reset();
  const preflight = await mcp(new Request(URL_, { method: "OPTIONS" }));
  for (const h of ["mcp-method", "mcp-protocol-version", "x-api-key"]) {
    assert(preflight.headers.get("access-control-allow-headers")!.includes(h), h);
  }
  assertEquals((await mcp(new Request(URL_, { method: "GET", headers: { accept: "text/event-stream" } }))).status, 405);
  assertEquals((await mcp(new Request(URL_, { method: "DELETE" }))).status, 405);

  assertEquals((await rpc("tools/list", {}, { key: "pk_test_unknown_000000000000000000" })).status, 401);
  assertEquals((await rpc("tools/list", {}, { key: KEYS.revoked })).status, 401);
  assertEquals((await rpc("tools/list", {}, { key: KEYS.inactiveAffiliate })).status, 403);

  // Partner keys are never JWTs: a JWT bearer or an empty x-api-key stays anonymous.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.e30.signature";
  assertEquals((await rpc("tools/list", {}, { headers: { authorization: `Bearer ${jwt}` } })).status, 200);
  assertEquals((await rpc("tools/list", {}, { headers: { "x-api-key": " " } })).status, 200);
  assertEquals((await rpc("tools/list", {}, { headers: { authorization: `Bearer ${KEYS.plain}` } })).status, 200);
  assertEquals((await rpc("tools/list", {}, { headers: { authorization: "Bearer pk_test_unknown_000000000000000000" } })).status, 401);

  const partner = await call("search_esim_plans", { countries: ["KE"], days: 7 }, { key: KEYS.affiliate });
  assert(partner.data.plans.every((p: Json) => p.checkout_url.endsWith("ref=TRAVELBOT")));
  const anonymous = await call("search_esim_plans", { countries: ["KE"], days: 7 });
  assert(anonymous.data.plans.every((p: Json) => !p.checkout_url.includes("ref=")));

  const flooding = "203.0.113.50";
  for (let i = 0; i < 120; i++) assertEquals((await rpc("tools/list", {}, { ip: flooding })).status, 200);
  const limited = await rpc("tools/list", {}, { ip: flooding });
  assertEquals(limited.status, 429);
  assert(Number(limited.headers.get("retry-after")) > 0);
  assert(!JSON.stringify(db.rate_limits).includes(flooding), "IPs are stored hashed");

  for (let i = 0; i < 3; i++) assertEquals((await rpc("tools/list", {}, { key: KEYS.limited })).status, 200);
  assertEquals((await rpc("tools/list", {}, { key: KEYS.limited })).status, 429);

  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
  assertEquals((await rpc("tools/list", {}, { raw: big })).status, 413);
  assert((await rpc("subscriptions/listen", { notifications: { toolsListChanged: true } })).json.error);
});

Deno.test("catalog is read once per cache window", async () => {
  await reset();
  let reads = 0;
  const proto = Object.getPrototypeOf(createClient("", ""));
  const from = proto.from;
  proto.from = function (table: string) {
    if (table !== "rate_limits") reads++;
    return from.call(this, table);
  };
  try {
    await call("search_esim_plans", { countries: ["KE"], days: 7 });
    const first = reads;
    await call("compare_country_plans", { countries: ["KE", "TZ"] });
    await call("list_destinations", {});
    assertEquals(first, 11);
    assertEquals(reads, first);
  } finally {
    proto.from = from;
  }
});

Deno.test("no supplier or internal data in any tool output", () => {
  const all = outputs.join("\n");
  assert(outputs.length > 20);
  for (const secret of ["SECRET-PACKAGE-CODE", "costPrice", "packageCode", "provider_config", '"providers"', "esimaccess", "esimgo", "airalo", "price_usd", "v-ke-1", "key_hash"]) {
    assert(!all.includes(secret), `leaked ${secret}`);
  }
});
