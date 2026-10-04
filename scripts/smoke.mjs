#!/usr/bin/env node
/**
 * Post-deploy check for the `mcp` edge function (Africa Travel Connectivity).
 *
 *   node scripts/verify-mcp.mjs                       public checks, no key needed
 *   PARTNER_KEY=<key> node scripts/verify-mcp.mjs     + price parity with partner-catalog
 *
 * Checks both protocol eras (2025-11-25 initialize, 2026-07-28 server/discover),
 * all five tools, error handling and that no supplier fields leak. With a
 * partner key it also compares search_esim_plans prices with partner-catalog
 * (which requires a key) and checks ref= attribution. API_BASE overrides
 * https://api.safariesim.com/functions/v1. Exits non-zero on any failure.
 */
const key = process.env.PARTNER_KEY ?? "";
const base = (process.env.API_BASE ?? "https://api.safariesim.com/functions/v1").replace(/\/$/, "");
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "verify-mcp", version: "2.0.0" },
};
const TOOLS = ["calculate_safari_data", "compare_country_plans", "get_country_networks", "list_destinations", "search_esim_plans"];
const LEAKS = ['"providers"', "provider_config", "costPrice", "packageCode", "esimaccess", "esimgo", "airalo", "price_usd", "key_hash"];

let id = 0;
let failures = 0;
const outputs = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

/** One JSON-RPC exchange; legacy responses may arrive as a one-event SSE stream. */
async function rpc(method, params = {}, { era = "modern", notify = false, apiKey = key } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": era === "modern" ? "2026-07-28" : "2025-11-25",
  };
  if (era === "modern") {
    headers["mcp-method"] = method;
    if (method === "tools/call") headers["mcp-name"] = params.name;
  }
  if (apiKey) headers["x-api-key"] = apiKey;
  const p = era === "modern" ? { ...params, _meta: MODERN_META } : params;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params: p } : { jsonrpc: "2.0", id: ++id, method, params: p }),
  });
  const text = await res.text();
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? ""
    : text;
  let json = null;
  try {
    json = payload ? JSON.parse(payload) : null;
  } catch {
    /* reported by the caller */
  }
  return { status: res.status, json, text };
}

async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const result = r.json?.result;
  const ok = r.status === 200 && result && !result.isError && result.structuredContent;
  if (result?.content?.[0]?.text) outputs.push(result.content[0].text);
  const detail = !result ? `${r.status} ${r.text.slice(0, 200)}` : result.isError ? result.content?.[0]?.text : "";
  check(!!ok, `${name} ${JSON.stringify(args)}`, detail);
  return ok ? result.structuredContent : null;
}

console.log(`MCP endpoint: ${base}/mcp ${key ? "(with partner key)" : "(anonymous)"}\n`);

// ── Protocol ────────────────────────────────────────────────────────────────
const init = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "verify-mcp", version: "2.0.0" },
}, { era: "legacy" });
const info = init.json?.result?.serverInfo;
check(init.status === 200 && info?.name === "africa-travel-connectivity", "legacy initialize (2025-11-25)",
  info ? `${info.title} ${info.version}` : `${init.status} ${init.text.slice(0, 200)}`);
const initialized = await rpc("notifications/initialized", {}, { era: "legacy", notify: true });
check(initialized.status === 202, "legacy notifications/initialized", `HTTP ${initialized.status}`);

const discover = await rpc("server/discover");
const versions = discover.json?.result?.supportedVersions ?? [];
check(versions.includes("2026-07-28"), "modern server/discover (2026-07-28)", versions.join(", ") || discover.text.slice(0, 200));

const list = await rpc("tools/list");
const tools = list.json?.result?.tools ?? [];
check(JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(TOOLS), "tools/list", tools.map((t) => t.name).join(", "));
check(tools.length > 0 && tools.every((t) => t.title && t.annotations?.readOnlyHint === true && t.outputSchema), "every tool has a title, readOnlyHint and outputSchema");

// ── Tools ───────────────────────────────────────────────────────────────────
const search = await tool("search_esim_plans", { countries: ["Kenya", "Tanzania"], days: 10 });
if (search) check(search.plans.every((p) => p.price.currency === "USD" && p.coverage.countries.includes("KE") && p.coverage.countries.includes("TZ")), "search results cover KE and TZ, priced in USD", `${search.total_matches} plans`);
const compare = await tool("compare_country_plans", { countries: ["KE", "TZ", "UG"], days: 7, currency: "EUR" });
if (compare) check(compare.countries.length === 3 && compare.currency === "EUR", "compare returns one entry per country in EUR");
const networks = await tool("get_country_networks", { country: "ZA" });
if (networks) check(networks.country.iso2 === "ZA", "networks for South Africa", networks.networks.map((n) => n.operator).join(", ") || "none recorded");
const estimate = await tool("calculate_safari_data", { days: 10, countries: ["KE"] });
if (estimate) check(estimate.total_gb > 0 && Array.isArray(estimate.matching_plans), "data estimate with matching plans", `${estimate.total_gb} GB, ${estimate.recommendation.plan_type}`);
const destinations = await tool("list_destinations", {});
if (destinations) check(destinations.destinations.some((d) => d.slug === "kenya"), "list_destinations includes Kenya", `${destinations.total} African destinations`);

const bad = await rpc("tools/call", { name: "search_esim_plans", arguments: { countries: ["KE"], days: 7, currency: "XYZ" } });
check(bad.json?.result?.isError === true, "unsupported currency → isError with supported list", bad.json?.result?.content?.[0]?.text?.slice(0, 80));
const unknownKey = await rpc("tools/list", {}, { apiKey: "pk_not_a_real_key_000000000000000000" });
check(unknownKey.status === 401 && unknownKey.json?.error?.data?.code === "unauthorized", "unknown partner key → 401 JSON-RPC error", `HTTP ${unknownKey.status}`);
const get = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
check(get.status === 405, "GET → 405 (no standalone stream)", `HTTP ${get.status}`);

const leaked = LEAKS.filter((l) => outputs.join("\n").includes(l));
check(leaked.length === 0, `no supplier fields in ${outputs.length} tool outputs`, leaked.join(", "));

// ── Partner key: parity with partner-catalog + attribution ─────────────────
if (key) {
  const res = await fetch(`${base}/partner-catalog?country=KE&days=7&per_page=250`, { headers: { "x-api-key": key } });
  const body = await res.json();
  const mine = await tool("search_esim_plans", { countries: ["KE"], days: 7, limit: 25 });
  if (res.ok && mine) {
    const fp = (p) => `${p.checkout_url}|${p.validity_days}|${typeof p.price === "number" ? p.price : p.price.amount}`;
    const theirs = body.data.filter((p) => p.validity_days >= 7)
      .sort((a, b) => a.price - b.price || a.validity_days - b.validity_days || a.destination_slug.localeCompare(b.destination_slug) || a.name.localeCompare(b.name))
      .slice(0, 25).map(fp);
    const ours = mine.plans.map(fp);
    check(JSON.stringify(ours) === JSON.stringify(theirs), "search_esim_plans prices = partner-catalog (KE, 7 days)", `${ours.length} plans`);
  } else {
    check(false, "partner-catalog reachable with this key", `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
