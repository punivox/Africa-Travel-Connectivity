/**
 * Serves the MCP endpoint locally with the synthetic test catalog, for MCP
 * Inspector or a client you are developing:
 *
 *   deno task serve:fixtures
 *   npx @modelcontextprotocol/inspector    → http://127.0.0.1:8787/mcp (Streamable HTTP)
 */
import { loadHandler, seed } from "./fixtures.ts";

await seed();
const handler = await loadHandler(new URL("../supabase/functions/mcp/index.ts", import.meta.url).href);
Deno.serve({ hostname: "127.0.0.1", port: 8787 }, handler);
