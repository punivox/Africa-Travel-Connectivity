/**
 * Supplier mappers: turn each supplier's private provider_config into public,
 * customer-facing plan facts. Costs, package codes and bundle names never
 * leave this module.
 */
export interface SupplierFacts {
  highspeedMbPerDay: number | null; // fair-use daily allowance, if known
  reducedSpeedKbps: number | null;
  networkTypes: string[];
  topUp: boolean;
  breakoutCountry: string | null;
}

const EMPTY: SupplierFacts = {
  highspeedMbPerDay: null,
  reducedSpeedKbps: null,
  networkTypes: [],
  topUp: false,
  breakoutCountry: null,
};

/** "1GB/day", "500MB", "2 GB" -> MB */
export function parseMb(text: unknown): number | null {
  if (typeof text !== "string" && typeof text !== "number") return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return Math.round(unit === "TB" ? n * 1024 * 1024 : unit === "GB" ? n * 1024 : n);
}

/** "512kbps", "1Mbps" -> kbps */
export function parseKbps(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(M|K)bps/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === "M" ? 1024 : 1));
}

const mappers: Record<string, (cfg: Record<string, any>) => SupplierFacts> = {
  esimaccess: (cfg) => ({
    highspeedMbPerDay: parseMb(cfg.fup),
    reducedSpeedKbps: parseKbps(cfg.fupPolicy),
    networkTypes: typeof cfg.speed === "string" ? cfg.speed.split("/").map((s: string) => s.trim()).filter(Boolean) : [],
    topUp: typeof cfg.topUpType === "string" && !/non/i.test(cfg.topUpType),
    breakoutCountry: typeof cfg.breakoutIp === "string" && cfg.breakoutIp.length === 2 ? cfg.breakoutIp.toUpperCase() : null,
  }),
  esimgo: () => ({ ...EMPTY }),
  esim_go: () => ({ ...EMPTY }),
  airalo: () => ({ ...EMPTY }),
};

export function supplierFacts(provider: string | null | undefined, cfg: unknown): SupplierFacts {
  const fn = mappers[(provider ?? "").toLowerCase()];
  return fn ? fn((cfg as Record<string, any>) ?? {}) : { ...EMPTY };
}
