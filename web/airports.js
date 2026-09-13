/**
 * IATA / metro / country lookup for Flight + hotel autocomplete.
 * Airport rows come from OurAirports (scheduled service); see scripts/generate-airports.py.
 */

import {
  AIRPORT_ROWS,
  COUNTRY_ALIASES,
  COUNTRY_EXTRAS,
  COUNTRY_NAMES,
} from "./airports-data.js";

/** @typedef {{ code: string, name: string, city: string, country: string, metro?: boolean, size?: string }} Airport */

/** Metro / multi-airport codes (Seats.aero-style). */
const METROS = [
  { code: "NYC", name: "New York Area", city: "New York", country: "US", metro: true },
  { code: "LON", name: "London Area", city: "London", country: "GB", metro: true },
  { code: "PAR", name: "Paris Area", city: "Paris", country: "FR", metro: true },
  { code: "TYO", name: "Tokyo Area", city: "Tokyo", country: "JP", metro: true },
  { code: "SEL", name: "Seoul Area", city: "Seoul", country: "KR", metro: true },
  { code: "MIL", name: "Milan Area", city: "Milan", country: "IT", metro: true },
  { code: "ROM", name: "Rome Area", city: "Rome", country: "IT", metro: true },
  { code: "STO", name: "Stockholm Area", city: "Stockholm", country: "SE", metro: true },
  { code: "WAS", name: "Washington DC Area", city: "Washington", country: "US", metro: true },
  { code: "CHI", name: "Chicago Area", city: "Chicago", country: "US", metro: true },
  { code: "YTO", name: "Toronto Area", city: "Toronto", country: "CA", metro: true },
  { code: "YMQ", name: "Montreal Area", city: "Montreal", country: "CA", metro: true },
  { code: "BUE", name: "Buenos Aires Area", city: "Buenos Aires", country: "AR", metro: true },
  { code: "SAO", name: "Sao Paulo Area", city: "Sao Paulo", country: "BR", metro: true },
  { code: "RIO", name: "Rio de Janeiro Area", city: "Rio de Janeiro", country: "BR", metro: true },
  { code: "BJS", name: "Beijing Area", city: "Beijing", country: "CN", metro: true },
  { code: "SHA", name: "Shanghai Area", city: "Shanghai", country: "CN", metro: true },
  { code: "OSA", name: "Osaka Area", city: "Osaka", country: "JP", metro: true },
  { code: "BER", name: "Berlin Area", city: "Berlin", country: "DE", metro: true },
  { code: "MOW", name: "Moscow Area", city: "Moscow", country: "RU", metro: true },
  { code: "QSF", name: "San Francisco Bay Area", city: "San Francisco", country: "US", metro: true },
];

/** @type {Airport[]} */
export const AIRPORTS = [
  ...METROS,
  ...AIRPORT_ROWS.map(([code, name, city, country, size]) => ({
    code,
    name,
    city,
    country,
    size,
  })),
];

const BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

const SIZE_RANK = { L: 0, M: 1, S: 2 };

function countryLabel(code) {
  return COUNTRY_NAMES[code] || code;
}

function normalizeQuery(q) {
  return String(q || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a typed token to ISO country codes (exact / alias / name prefix).
 * @returns {string[]}
 */
export function matchCountries(query) {
  const q = normalizeQuery(query);
  if (!q || q.length < 2) return [];

  if (/^[a-z]{2}$/.test(q)) {
    const code = q.toUpperCase();
    if (COUNTRY_NAMES[code]) return [code];
  }

  if (COUNTRY_ALIASES[q]) return [COUNTRY_ALIASES[q]];

  const exact = [];
  const prefix = [];
  for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
    const n = normalizeQuery(name);
    if (n === q) exact.push(code);
    else if (n.startsWith(q) || n.includes(` ${q}`)) prefix.push(code);
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    if (alias === q) {
      if (!exact.includes(code)) exact.push(code);
    } else if (alias.startsWith(q) && !prefix.includes(code) && !exact.includes(code)) {
      prefix.push(code);
    }
  }
  return [...exact, ...prefix];
}

/**
 * Airports associated with a country (including border extras like BSL for CH).
 * @returns {Airport[]}
 */
export function airportsForCountry(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  if (!cc) return [];
  const extras = new Set((COUNTRY_EXTRAS[cc] || []).map((c) => String(c).toUpperCase()));
  const out = [];
  for (const entry of AIRPORTS) {
    if (entry.metro) continue;
    if (entry.country === cc || extras.has(entry.code)) out.push(entry);
  }
  out.sort(
    (a, b) =>
      (SIZE_RANK[a.size] ?? 9) - (SIZE_RANK[b.size] ?? 9) ||
      (extras.has(a.code) ? 1 : 0) - (extras.has(b.code) ? 1 : 0) ||
      a.city.localeCompare(b.city) ||
      a.code.localeCompare(b.code)
  );
  return out;
}

function haystack(entry) {
  const countryName = countryLabel(entry.country);
  return `${entry.code} ${entry.city} ${entry.name} ${entry.country} ${countryName}`.toLowerCase();
}

/**
 * Rank airports for a typed token (city, airport name, IATA, or country).
 * Country matches return every airport in that country (plus an "all" group).
 * @returns {Array<Airport & { kind?: string, codes?: string[], countryName?: string }>}
 */
export function searchAirports(query, { limit = 10 } = {}) {
  const raw = String(query || "").trim();
  const q = normalizeQuery(raw);
  if (!q) return [];

  const countries = matchCountries(raw);
  if (countries.length) {
    /** Prefer the best country hit when multiple prefix-match. */
    const primary = countries[0];
    const inCountry = airportsForCountry(primary);
    if (inCountry.length) {
      const countryName = countryLabel(primary);
      const majorOnly = inCountry.length > 25;
      const allCodes = (majorOnly ? inCountry.filter((a) => a.size === "L") : inCountry).map(
        (a) => a.code
      );
      const codes = allCodes.length ? allCodes : inCountry.slice(0, 25).map((a) => a.code);
      const group = {
        code: primary,
        name: majorOnly
          ? `All major airports in ${countryName}`
          : `All airports in ${countryName}`,
        city: countryName,
        country: primary,
        kind: "country",
        codes,
        countryName,
      };
      const maxAirports = Math.max(0, (limit > 40 ? limit : 40) - 1);
      return [group, ...inCountry.slice(0, maxAirports)];
    }
  }

  const scored = [];
  for (const entry of AIRPORTS) {
    const code = entry.code.toLowerCase();
    const city = normalizeQuery(entry.city);
    const name = normalizeQuery(entry.name);
    const countryName = normalizeQuery(countryLabel(entry.country));
    let score = 0;
    if (code === q) score = 1000;
    else if (code.startsWith(q)) score = 800;
    else if (city === q) score = 700;
    else if (city.startsWith(q)) score = 600;
    else if (name.startsWith(q)) score = 500;
    else if (countryName.startsWith(q) || entry.country.toLowerCase() === q) score = 450;
    else if (haystack(entry).includes(q)) score = 300;
    else continue;
    if (entry.metro) score += 15;
    if (entry.size === "L") score += 8;
    else if (entry.size === "M") score += 3;
    scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (SIZE_RANK[a.entry.size] ?? 9) - (SIZE_RANK[b.entry.size] ?? 9) ||
      a.entry.code.localeCompare(b.entry.code)
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Pull a 3-letter IATA/metro code out of free text / Hilton suggestion. */
export function extractIataCode(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const paren = upper.match(/\(([A-Z]{3})\)/);
  if (paren) return paren[1];
  const lead = upper.match(/^([A-Z]{3})(?:\s|[-–,])/);
  if (lead) return lead[1];
  const iataWord = upper.match(/\bIATA[:\s-]*([A-Z]{3})\b/);
  if (iataWord) return iataWord[1];
  return null;
}

/**
 * Split a multi-airport field into completed codes + the token currently being typed.
 */
export function splitIataField(value) {
  const raw = String(value || "");
  const endsWithSep = /[\s,;]$/.test(raw);
  const parts = raw
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return { completed: [], token: "", endsWithSep: false };
  if (endsWithSep) return { completed: parts, token: "", endsWithSep: true };
  const token = parts[parts.length - 1] || "";
  const completed = parts.slice(0, -1);
  return { completed, token, endsWithSep: false };
}

export function joinIataField(completed, nextCode) {
  const codes = [...completed];
  const code = String(nextCode || "").toUpperCase();
  if (code && !codes.includes(code)) codes.push(code);
  return codes.join(", ");
}

export function getAirportByCode(code) {
  return BY_CODE.get(String(code || "").toUpperCase()) || null;
}

export { COUNTRY_NAMES, countryLabel };
