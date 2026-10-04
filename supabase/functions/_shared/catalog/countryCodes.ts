/**
 * Country-code normalization for partner feeds. Stored values sometimes hold
 * several codes ("CA;MX;US"), non-ISO aliases (UK, EL) or region placeholders
 * (CB, EU, XX, AN). Comparators need one ISO 3166-1 alpha-2 per entry.
 */
const ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };

/** Placeholder codes that are regions, mapped to eSIMDB region slugs. */
export const REGION_SLUGS: Record<string, string> = {
  CB: "caribbean",
  EU: "europe",
  XX: "global",
  AN: "netherlands-antilles",
  AFRICA: "africa",
};

const NOT_COUNTRIES = new Set(["XX", "EU", "CB", "AN", "AFRICA"]);

export function splitCodes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw).split(/[;,|\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export function normalizeCountry(code: string): string | null {
  const c = ALIASES[code.toUpperCase()] ?? code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || NOT_COUNTRIES.has(c)) return null;
  return c;
}

export function normalizeCountries(values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) for (const c of splitCodes(v)) {
    const n = normalizeCountry(c);
    if (n) out.add(n);
  }
  return Array.from(out);
}

/**
 * Countries a plan covers. Members win; a multi-country destination with no
 * members returns [] (excluded) instead of its placeholder code (AM, ME).
 */
export function resolveCoverage(
  countryCode: string | null | undefined,
  coverageType: string | null | undefined,
  members: (string | null | undefined)[],
): string[] {
  const fromMembers = normalizeCountries(members);
  if (fromMembers.length) return fromMembers;
  const own = normalizeCountries([countryCode]);
  const multi = String(countryCode ?? "").length !== 2 || /multi|regional/i.test(String(coverageType ?? "")) || own.length > 1;
  return multi ? (own.length > 1 ? own : []) : own;
}

/** eSIMDB Destination Link targets: region slug, else members, else own code. */
export function linkTargets(countryCode: string | null | undefined, members: (string | null | undefined)[]): string[] {
  const region = REGION_SLUGS[String(countryCode ?? "").toUpperCase()];
  if (region) return [region];
  const m = normalizeCountries(members);
  return m.length ? m : normalizeCountries([countryCode]);
}
