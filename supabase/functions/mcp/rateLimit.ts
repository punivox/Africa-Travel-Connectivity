/**
 * Abuse protection for anonymous (no partner key) MCP traffic: a per-IP
 * request budget per minute on the shared rate_limits table. IPs are stored
 * only as truncated SHA-256 hashes, and requests occasionally delete their own
 * expired rows so the table stays small. Fails open on DB errors, like the
 * other rate-limited functions.
 *
 * AI platforms (Claude, Smithery's gateway, …) send many users' traffic from
 * a few IPs, so this is a flood guard, not a quota.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export const ANONYMOUS_LIMIT = 120;
export const WINDOW_SECONDS = 60;

export const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Seconds until this IP may retry, or null when the request is allowed. */
export async function anonymousRetryAfter(supabase: SupabaseClient, ip: string): Promise<number | null> {
  const bucket = `mcp_ip:${(await sha256Hex(`mcp:${ip}`)).slice(0, 16)}`;
  const now = Date.now();
  const since = new Date(now - WINDOW_SECONDS * 1000).toISOString();

  if (Math.random() < 0.1) {
    supabase.from("rate_limits").delete().eq("key", bucket).lt("created_at", since).then(() => {});
  }

  const { count, error } = await supabase
    .from("rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("key", bucket)
    .gte("created_at", since);
  if (error) {
    console.error("mcp anonymous rate limit check failed", error.message);
    return null;
  }

  if ((count ?? 0) >= ANONYMOUS_LIMIT) {
    const { data: oldest } = await supabase
      .from("rate_limits")
      .select("created_at")
      .eq("key", bucket)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const freesAt = oldest ? new Date(oldest.created_at).getTime() + WINDOW_SECONDS * 1000 : now + WINDOW_SECONDS * 1000;
    return Math.max(1, Math.ceil((freesAt - now) / 1000));
  }

  await supabase.from("rate_limits").insert({ key: bucket });
  return null;
}
