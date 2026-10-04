# Africa Travel Connectivity

An MCP server that lets AI assistants find and compare travel eSIM plans for Africa: live prices, mobile networks, validity and trip data estimates, from the [Safari eSIM](https://safariesim.com) catalog.

```
https://api.safariesim.com/functions/v1/mcp
```

Public and read-only. No API key. Streamable HTTP, serving MCP `2026-07-28` with a fallback for `2025-11-25` clients.

## Why it exists

Questions like "which eSIM works in Kenya and Tanzania?" or "how much will 12 days of data cost?" have answers that change week to week. Prices, durations and networks live in a catalog, not in a model's training data. This server lets an assistant look them up instead of guessing. It returns the same prices Safari eSIM charges at checkout, the operators each plan uses, and a link to buy.

## Connect

**Claude Code**

```bash
claude mcp add --transport http africa-travel-connectivity https://api.safariesim.com/functions/v1/mcp
```

**Claude (web and desktop):** add a custom connector in Claude's connector settings and paste the URL above. No authentication is needed.

**Cursor:** add it to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "africa-travel-connectivity": { "url": "https://api.safariesim.com/functions/v1/mcp" }
  }
}
```

**VS Code:** add it to `.vscode/mcp.json`:

```json
{
  "servers": {
    "africa-travel-connectivity": { "type": "http", "url": "https://api.safariesim.com/functions/v1/mcp" }
  }
}
```

Any other client that supports remote MCP servers over Streamable HTTP works the same way.

## Example prompts

- "What's the best eSIM for a 10-day Kenya safari?"
- "Compare Kenya and Tanzania eSIM plans for 12 days, in euros."
- "Find one eSIM that covers Kenya, Tanzania and Uganda for under $60."
- "Which mobile networks does the Uganda eSIM use? Is there 5G?"
- "How much data do I need for a 10-day safari if I post photos every day?"
- "What are my options for two weeks in South Africa or Botswana?"
- "Which African countries can I get an eSIM for?"

## Tools

| Tool | Use it for |
|---|---|
| `search_esim_plans` | Plans that work in every country of a trip, filtered by trip length, data, budget and currency. Cheapest first. |
| `compare_country_plans` | Cheapest and cheapest-unlimited plan per country, the operators used there, and single plans that cover every country. |
| `get_country_networks` | Mobile operators and network types (5G, 4G, 3G) in a country, and which plans use each one. |
| `calculate_safari_data` | How much data a trip needs, from its length and activities, optionally matched to plans that fit. |
| `list_destinations` | Covered countries and multi-country plans, Africa first. |

Countries can be ISO codes (`KE`) or English names (`Kenya`, `Zanzibar`). Prices come in any currency Safari eSIM supports (USD by default). Every tool is read-only and returns structured content that matches a published output schema.

The full reference, with input and output schemas, examples and edge cases, is in [docs/tools.md](docs/tools.md).

## Example response

`search_esim_plans` with `{"countries": ["Kenya", "Tanzania"], "days": 10}` returns plans shaped like this (illustrative values):

```json
{
  "countries": [{ "iso2": "KE", "name": "Kenya" }, { "iso2": "TZ", "name": "Tanzania" }],
  "days": 10,
  "currency": "USD",
  "total_matches": 1,
  "plans": [
    {
      "name": "Africa Safari eSIM — 10 days",
      "destination": { "name": "Africa Safari", "slug": "africa-safari", "url": "https://safariesim.com/esim-africa-safari" },
      "coverage": { "type": "multi_country", "countries": ["KE", "TZ", "UG"] },
      "validity_days": 10,
      "data": {
        "unlimited": true,
        "total_gb": null,
        "high_speed_gb_per_day": 1,
        "speed_after_cap_kbps": 512,
        "summary": "Unlimited data: 1 GB/day at full speed, then 512 kbps"
      },
      "price": { "amount": 60, "currency": "USD", "per_day": 6 },
      "networks": [
        { "country": "KE", "operator": "Safaricom", "network_types": ["4G"] },
        { "country": "TZ", "operator": "Vodacom", "network_types": ["4G"] }
      ],
      "hotspot_allowed": true,
      "top_up_available": false,
      "checkout_url": "https://safariesim.com/esim-africa-safari?days=10&checkout=1"
    }
  ]
}
```

## Destinations

The server covers every destination Safari eSIM sells, with Africa first. `list_destinations` returns the live list. Some common safari trips:

| Trip | Safari eSIM page |
|---|---|
| Kenya | [Kenya eSIM](https://safariesim.com/kenya-esim) |
| Tanzania, including Zanzibar | [Tanzania eSIM](https://safariesim.com/tanzania-esim) |
| Uganda | [Uganda eSIM](https://safariesim.com/uganda-esim) |
| Kenya, Tanzania and Uganda on one eSIM | [Africa Safari eSIM](https://safariesim.com/africa-safari-esim) |
| South Africa | [South Africa eSIM](https://safariesim.com/south-africa-esim) |
| Botswana | [Botswana eSIM](https://safariesim.com/botswana-esim) |
| Rwanda | [Rwanda eSIM](https://safariesim.com/esim-rwanda) |
| Namibia | [Namibia eSIM](https://safariesim.com/esim-namibia) |

## How it works

```
 MCP client ── POST (JSON-RPC) ──▶ api.safariesim.com/functions/v1/mcp
 (Claude, Cursor, VS Code,         │  Supabase Edge Function (Deno)
  your agent)                      ├─ optional partner key ─────────▶ partner_api_keys
                                   ├─ rate limit ────────────────────▶ rate_limits
                                   ├─ new MCP server for this request
                                   │    └─ tool ─▶ catalog cache (60 s) ─▶ Postgres catalog
                                   │                └─ buildCatalog + checkout price maths
                                   └─ JSON result: plans, prices, networks, checkout links
```

- **One server per request.** Edge Function instances share no memory, so the server is stateless: no sessions, single JSON responses, `GET` answered with `405`, and no long-lived streams.
- **Both protocol eras.** The official TypeScript SDK (`createMcpHandler`) serves `2026-07-28` requests and falls back to stateless `2025-11-25` serving for clients that open with `initialize`.
- **One plan builder.** Tools price plans with `buildCatalog`, the same code behind Safari eSIM's [partner catalog API](https://safariesim.com/api). It uses the same price maths as checkout.

## Data and freshness

- **Source:** Safari eSIM's production catalog in Postgres. Nothing is hard-coded.
- **Prices:** final prices for one traveller, including the rounding customers see, identical to checkout. Catalog reads are cached for up to 60 seconds, and checkout always re-prices.
- **Networks:** the operators recorded for each plan and country. This is not a coverage map: the server can't tell you the signal at a particular park or lodge, and its tools say so.
- **Data estimates:** typical per-app data rates, returned with every estimate so you can see the assumptions.

## Access and limits

- **No key needed.** Each IP address gets a flood-protection budget of 120 requests per minute. AI platforms share IP addresses, so this is generous by design.
- **Partner keys (optional).** Safari eSIM partners and affiliates can send `x-api-key: <key>`. This adds their referral code to every link and uses their key's hourly quota. An unknown or revoked key gets `401` instead of anonymous access, so a misconfigured key is easy to spot. Keys are issued by Safari eSIM. Ask at [support@safariesim.com](mailto:support@safariesim.com).

| Status | JSON-RPC code | Meaning |
|---|---|---|
| 401 | `-32001` | Unknown or revoked partner key |
| 403 | `-32003` | Partner key's affiliate account is not active |
| 413 | | Request body over 64 KB |
| 429 | `-32029` | Rate limited; wait `Retry-After` seconds |

Bad tool arguments, such as an unknown country or an unsupported currency, come back as a normal tool result with `isError: true` and a message explaining how to fix the call.

## Security and privacy

- **Read-only:** the server can't buy, reserve or activate anything, and it never asks for personal data. Purchases happen on safariesim.com through the `checkout_url`.
- **Minimal writes:** it writes only rate-limit rows and partner usage counters. IP addresses are stored as truncated SHA-256 hashes and cleaned up automatically.
- **Customer-facing fields only:** responses never include supplier names, wholesale costs, internal ids or credentials. The test suite plants supplier secrets in the fixtures and fails if any of them appear in an output.
- **No secrets in this repo:** the database credential lives only in Supabase's function secrets.
- **Small prompt-injection surface:** tool output is catalog data (names, numbers, links), not user-generated text.

See Safari eSIM's [privacy policy](https://safariesim.com/privacy). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

This repository mirrors the production source of the `mcp` function, which is deployed from Safari eSIM's main codebase. You can run and test the full server locally against a synthetic catalog. You need [Deno](https://deno.com) 2.x.

```bash
deno task check            # type-check the function
deno task test             # end-to-end tests against a fake database
deno task serve:fixtures   # serve it at http://127.0.0.1:8787/mcp
npx @modelcontextprotocol/inspector   # then connect Inspector to that URL (Streamable HTTP)
deno task smoke            # check the production endpoint
```

Running it against a real database needs Safari eSIM's catalog schema, which isn't public.

```
supabase/functions/
  mcp/                   the MCP server
    index.ts             HTTP entry: CORS, partner keys, rate limits, SDK handler
    server.ts            server metadata and the five tools
    catalog.ts           catalog cache and the customer-facing plan view
    schemas.ts           output schemas
    geo.ts               country names, aliases, African country codes
    dataUsage.ts         data estimate rates and profiles
    rateLimit.ts         anonymous per-IP limit
  _shared/               catalog builder and pricing shared with the partner API
tests/                   fake Supabase client, synthetic catalog, end-to-end tests
scripts/smoke.mjs        production smoke test
server.json              MCP Registry metadata
```

## MCP Registry

The registry metadata is in [`server.json`](server.json), under the name `com.safariesim/africa-travel-connectivity`.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes flow into production.

## License

[MIT](LICENSE) © Punivox OÜ

## Support

- Questions, partner keys: [support@safariesim.com](mailto:support@safariesim.com)
- Bugs and ideas: [GitHub issues](https://github.com/punivox/africa-travel-connectivity/issues)
- Safari eSIM: [safariesim.com](https://safariesim.com)
