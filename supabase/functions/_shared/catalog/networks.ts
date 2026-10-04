/**
 * Group a product's networks by the country they are recorded for, so each
 * coverage entry only lists that country's own operators. Source data
 * (destination_operators.country_iso2) carries the country relationship.
 */
export interface CountryOperator {
  name: string;
  network_types: string[];
  country_iso2: string | null;
}

export interface CoverageNetwork { name: string; types: string[] }

const TYPE_ORDER = ["5G", "LTE", "4G", "3G", "2G"];
const typeRank = (t: string) => {
  const i = TYPE_ORDER.indexOf(t);
  return i === -1 ? 99 : i;
};

export function groupNetworksByCountry(
  ops: CountryOperator[],
  countries: string[],
  maxTypeLen = 4,
): Record<string, CoverageNetwork[]> {
  const out: Record<string, CoverageNetwork[]> = {};
  for (const code of countries) {
    const byName = new Map<string, Set<string>>();
    for (const o of ops) {
      if (!o.country_iso2 || o.country_iso2.toUpperCase() !== code) continue;
      const name = String(o.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = [...byName.keys()].find((k) => k.toLowerCase() === key) ?? name;
      const set = byName.get(existing) ?? new Set<string>();
      for (const t of o.network_types ?? []) {
        const up = String(t).trim().toUpperCase();
        if (up && up.length <= maxTypeLen) set.add(up);
      }
      byName.set(existing, set);
    }
    out[code] = [...byName.entries()]
      .map(([name, types]) => ({ name, types: [...types].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
