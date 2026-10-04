# Contributing

Thanks for helping make travel connectivity answers better. Bug reports, tool ideas and pull requests are all welcome.

## How this repository works

This repository mirrors the production source of the MCP server. Production is deployed from SafarieSIM's main codebase, so when a pull request here is accepted, a maintainer applies it there, deploys it, and re-exports this repository. Your change still lands, with credit, but it may arrive in a maintainer's commit.

## Ground rules for tools

- **Live data only.** Tools read the catalog through `buildCatalog`. Never hard-code prices, coverage, networks or destination lists.
- **Customer-facing fields only.** Never return supplier names, wholesale costs, internal ids or partner data. Add new fields to the views in `supabase/functions/mcp/catalog.ts` explicitly, and keep the leak test in `tests/mcp_test.ts` passing.
- **Read-only.** No purchases, reservations or writes beyond rate limiting.
- **Built for agents.** Keep outputs deterministic, state the currency, validity and data allowance, and write descriptions that tell a model when to use the tool.
- **Honest about limits.** If the catalog doesn't know something, such as signal at a specific park, the tool should say so rather than guess.

## Development

You need [Deno](https://deno.com) 2.x.

```bash
deno task check            # type-check
deno task test             # end-to-end tests against the synthetic catalog
deno task serve:fixtures   # local server at http://127.0.0.1:8787/mcp for MCP Inspector
```

The tests replace Supabase with an in-memory fake (`tests/fake_supabase.ts`) and seed made-up data (`tests/fixtures.ts`), so no database or credentials are needed.

## Pull request checklist

- [ ] `deno task check` and `deno task test` pass.
- [ ] New behaviour has a test, including its error cases.
- [ ] Tool descriptions, input and output schemas, and [docs/tools.md](docs/tools.md) match the change.
- [ ] No new output field exposes supplier, partner or internal data.

## Reporting problems

Open a [GitHub issue](https://github.com/punivox/africa-travel-connectivity/issues) with the tool name, the arguments you sent and what you got back. For security issues, follow [SECURITY.md](SECURITY.md) instead.
