/**
 * Country reference data for the MCP tools: English names from the runtime's
 * ICU data (Intl.DisplayNames), a few traveller aliases, and the set of
 * African ISO codes used to put Africa first. This is static geography —
 * which countries a plan covers always comes from the catalog.
 */
import { normalizeCountry } from "../_shared/catalog/countryCodes.ts";

/** African countries (AU/UN members) and territories, ISO 3166-1 alpha-2. */
export const AFRICA = new Set([
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD", "CI", "DJ", "EG", "GQ", "ER",
  "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ",
  "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ", "TG", "TN", "UG", "ZM", "ZW",
  "RE", "YT", "SH", "EH",
]);

/** Names travellers use that ICU's English region names don't cover. */
const ALIASES: Record<string, string> = {
  zanzibar: "TZ",
  "ivory coast": "CI",
  swaziland: "SZ",
  drc: "CD",
  "dr congo": "CD",
  "democratic republic of the congo": "CD",
  "democratic republic of congo": "CD",
  "republic of the congo": "CG",
  "cabo verde": "CV",
  "the gambia": "GM",
  "sao tome and principe": "ST",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  britain: "GB",
  "great britain": "GB",
  usa: "US",
  "united states of america": "US",
  uae: "AE",
};

/** Region codes ICU names that are not countries (EU, UN, …). */
const NOT_REGIONS = new Set(["EU", "EZ", "UN", "QO", "ZZ", "XA", "XB"]);

const display = new Intl.DisplayNames(["en"], { type: "region" });

/** Case-, accent- and punctuation-insensitive form used for name matching. */
export const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const icuName = (iso2: string): string | null => {
  try {
    const name = display.of(iso2);
    return name && name !== iso2 ? name : null;
  } catch {
    return null;
  }
};

/** Folded English name → ISO code, for every region ICU knows. */
const BY_NAME = new Map<string, string>();
for (let a = 65; a <= 90; a += 1) {
  for (let b = 65; b <= 90; b += 1) {
    const code = String.fromCharCode(a, b);
    const name = !NOT_REGIONS.has(code) && normalizeCountry(code) ? icuName(code) : null;
    if (name) BY_NAME.set(fold(name), code);
  }
}

export interface CountryRef {
  iso2: string;
  name: string;
}

export const countryName = (iso2: string) => icuName(iso2) ?? iso2;
export const countryRef = (iso2: string): CountryRef => ({ iso2, name: countryName(iso2) });

/**
 * Resolves a country given as an ISO alpha-2 code or an English name.
 * `extraNames` maps folded catalog destination names to their ISO code.
 */
export function resolveCountry(
  input: string,
  extraNames: Map<string, string> = new Map(),
): { iso2: string } | { error: string } {
  const raw = input.trim();
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const iso = normalizeCountry(raw);
    if (iso && (icuName(iso) || [...extraNames.values()].includes(iso))) return { iso2: iso };
  }
  const key = fold(raw);
  const exact = ALIASES[key] ?? extraNames.get(key) ?? BY_NAME.get(key);
  if (exact) return { iso2: exact };

  // A unique partial match ("tanzania, united republic" or "south sudan" vs "sudan" stays exact).
  const candidates = new Set<string>();
  for (const [name, iso] of [...BY_NAME, ...extraNames]) {
    if (key.length >= 4 && (name.startsWith(key) || key.startsWith(name))) candidates.add(iso);
  }
  if (candidates.size === 1) return { iso2: [...candidates][0] };
  const suggestions = [...candidates].slice(0, 5).map((c) => `${countryName(c)} (${c})`);
  return {
    error: suggestions.length
      ? `"${raw}" is ambiguous: ${suggestions.join(", ")}. Use an ISO 3166-1 alpha-2 code.`
      : `"${raw}" is not a recognised country. Use an ISO 3166-1 alpha-2 code (e.g. KE) or an English country name.`,
  };
}
