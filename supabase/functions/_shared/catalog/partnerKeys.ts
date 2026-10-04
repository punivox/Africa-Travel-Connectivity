/**
 * Partner API key auth shared by partner-catalog and mcp.
 *
 * Keys live in public.partner_api_keys as SHA-256 hashes and are sent as
 * `x-api-key: <key>` (or `Authorization: Bearer <key>`). An affiliate-owned key
 * bakes that affiliate's referral code into every link it returns.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export interface PartnerKey {
  id: string;
  partner_slug: string;
  rate_limit_per_hour: number | null;
  revoked_at: string | null;
  request_count: number | null;
  affiliate_id: string | null;
  default_format: string | null;
  default_days: number[] | null;
}

export type PartnerAuth =
  | { ok: true; key: PartnerKey; refCode: string | null; withRef: (url: string) => string }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string };

export async function authenticatePartner(supabase: SupabaseClient, req: Request): Promise<PartnerAuth> {
  const headerKey =
    req.headers.get("x-api-key") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  if (!headerKey || headerKey.length < 20) {
    return { ok: false, status: 401, code: "unauthorized", message: "Missing or malformed partner API key." };
  }

  const { data: keyRow } = await supabase
    .from("partner_api_keys")
    .select("id, partner_slug, rate_limit_per_hour, revoked_at, request_count, affiliate_id, default_format, default_days")
    .eq("key_hash", await sha256(headerKey))
    .maybeSingle();

  if (!keyRow || keyRow.revoked_at) {
    return { ok: false, status: 401, code: "unauthorized", message: "Invalid or revoked partner API key." };
  }

  // Affiliate-owned keys get their referral code baked into every link, so the
  // catalog doubles as the affiliate product feed.
  let refCode: string | null = null;
  if (keyRow.affiliate_id) {
    const { data: aff } = await supabase
      .from("affiliates")
      .select("referral_code, status")
      .eq("id", keyRow.affiliate_id)
      .maybeSingle();
    if (!aff || aff.status !== "approved") {
      return { ok: false, status: 403, code: "forbidden", message: "Affiliate account is not active." };
    }
    refCode = aff.referral_code ?? null;
  }
  const withRef = (u: string) => (refCode ? `${u}${u.includes("?") ? "&" : "?"}ref=${refCode}` : u);

  return { ok: true, key: keyRow as PartnerKey, refCode, withRef };
}

/**
 * Per-key hourly limit (partner_api_keys.rate_limit_per_hour) on the shared
 * rate_limits table. Fails open on a DB error, like the other rate-limited
 * functions. Returns the seconds until a slot frees up, or null when allowed.
 */
export async function hourlyLimitRetryAfter(supabase: SupabaseClient, key: PartnerKey): Promise<number | null> {
  const bucket = `partner_key:${key.id}`;
  const limit = key.rate_limit_per_hour ?? 600;
  const since = new Date(Date.now() - 3600_000).toISOString();

  const { count, error } = await supabase
    .from("rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("key", bucket)
    .gte("created_at", since);
  if (error) {
    console.error("partner key rate limit check failed", error.message);
    return null;
  }

  if ((count ?? 0) >= limit) {
    const { data: oldest } = await supabase
      .from("rate_limits")
      .select("created_at")
      .eq("key", bucket)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const freesAt = oldest ? new Date(oldest.created_at).getTime() + 3600_000 : Date.now() + 3600_000;
    return Math.max(1, Math.ceil((freesAt - Date.now()) / 1000));
  }

  await supabase.from("rate_limits").insert({ key: bucket });
  return null;
}

/** Usage bookkeeping (best effort; never blocks the response). */
export function recordKeyUse(supabase: SupabaseClient, key: PartnerKey) {
  supabase
    .from("partner_api_keys")
    .update({ last_used_at: new Date().toISOString(), request_count: (key.request_count ?? 0) + 1 })
    .eq("id", key.id)
    .then(() => {});
}
