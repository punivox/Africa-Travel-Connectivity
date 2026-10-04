/**
 * mcp — Africa Travel Connectivity: a public, read-only MCP server over the
 * live SafarieSIM catalog, so AI clients can find and compare travel eSIM
 * plans, networks and trip data needs.
 *
 *   https://api.safariesim.com/functions/v1/mcp      Streamable HTTP
 *
 * Protocol: the official TypeScript SDK's createMcpHandler serves the
 * 2026-07-28 revision and falls back to stateless serving for 2025-era clients
 * (initialize handshake), so old and new clients both work. Every request gets
 * a fresh server (Edge Function isolates share no state); responses are plain
 * JSON, GET is answered 405, and subscriptions/listen is refused (the tool list
 * never changes), so no request holds the function open.
 *
 * Access: no key needed. Anonymous traffic gets a per-IP flood guard. A partner
 * API key (x-api-key or Authorization: Bearer, same check as partner-catalog)
 * adds ref= attribution to links and uses that key's hourly limit; an invalid
 * or revoked key is rejected rather than treated as anonymous.
 *
 * Read-only: the only writes are rate-limit rows and the key's usage counter.
 * Plans come from _shared/catalog/buildCatalog.ts — the builder partner-catalog
 * uses, priced with checkout's maths — through a 60-second cache (catalog.ts).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { createMcpHandler } from "npm:@modelcontextprotocol/server@2.3.0";
import { authenticatePartner, hourlyLimitRetryAfter, recordKeyUse } from "../_shared/catalog/partnerKeys.ts";
import { buildServer, type CallerContext } from "./server.ts";
import { anonymousRetryAfter, clientIp } from "./rateLimit.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-protocol-version, retry-after",
};

/** HTTP-level failure as a JSON-RPC error (id null: the body may be unread). */
const rpcError = (status: number, code: number, message: string, data?: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message, ...(data ? { data } : {}) }, id: null }), {
    status,
    headers: { ...CORS, ...extra, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const AUTH_RPC_CODES = { unauthorized: -32001, forbidden: -32003 } as const;
const ANONYMOUS: CallerContext = { key: null, withRef: (url) => url };

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const handler = createMcpHandler(
  (ctx) => buildServer(supabase, (ctx.authInfo?.extra?.caller as CallerContext | undefined) ?? ANONYMOUS),
  {
    legacy: "stateless",
    responseMode: "json",
    maxSubscriptions: 0,
    keepAliveMs: 0,
    maxRequestBodySize: 64 * 1024,
    onerror: (err) => {
      if (!/subscription limit|Method not allowed/i.test(err.message)) console.error("mcp transport error", err);
    },
  },
);

/**
 * Whether the caller sent a partner key. Partner keys are never JWTs, so a
 * JWT bearer (a Supabase anon key, or a gateway's own token) stays anonymous.
 */
const presentsKey = (req: Request) => {
  if ((req.headers.get("x-api-key") ?? "").trim()) return true;
  const bearer = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)/i)?.[1];
  return !!bearer && !bearer.startsWith("eyJ");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let caller = ANONYMOUS;
  if (presentsKey(req)) {
    // TODO(oauth): partner-only tools would need MCP authorization (OAuth 2.1):
    // serve protected-resource metadata, answer 401 with WWW-Authenticate, and
    // map the access token to a partner here. Public tools stay keyless.
    const auth = await authenticatePartner(supabase, req);
    if (!auth.ok) return rpcError(auth.status, AUTH_RPC_CODES[auth.code], auth.message, { code: auth.code });
    caller = { key: auth.key, withRef: auth.withRef };
  }

  // Only POST does work; GET and DELETE are answered 405 by the handler.
  if (req.method === "POST") {
    const retryAfter = caller.key
      ? await hourlyLimitRetryAfter(supabase, caller.key)
      : await anonymousRetryAfter(supabase, clientIp(req));
    if (retryAfter !== null) {
      return rpcError(429, -32029, `Rate limit exceeded. Retry in ${retryAfter}s.`, {
        code: "rate_limited",
        retry_after_seconds: retryAfter,
      }, { "Retry-After": String(retryAfter) });
    }
  }

  try {
    const res = await handler.fetch(req, {
      authInfo: { token: "", clientId: caller.key?.partner_slug ?? "anonymous", scopes: [], extra: { caller } },
    });
    if (req.method === "POST" && caller.key) recordKeyUse(supabase, caller.key);

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    console.error("mcp error", err);
    return rpcError(500, -32603, "Internal error. Retry shortly.");
  }
});
