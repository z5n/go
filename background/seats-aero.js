/**
 * Seats.aero partner API (cached search).
 * Auth: Partner-Authorization header with Pro/commercial API key.
 * Docs: https://developers.seats.aero/reference/getting-started-p
 */

import {
  getCachedFlightSearch,
  setCachedFlightSearch,
} from "./rate-cache.js";
import { recordOutbound, recordActivity } from "./request-metrics.js";
import { convertToUsd } from "./exchange-rates.js";

const SEATS_API_BASE = "https://seats.aero/partnerapi";
const SEATS_KEY_STORAGE = "seatsAeroApiKey";

/** seats.aero `sources` that map to common transferable-points banks. */
export const TRANSFER_PARTNER_PRESETS = {
  all: {
    label: "All programs",
    sources: null,
  },
  chase: {
    label: "Chase UR",
    sources: ["aeroplan", "flyingblue", "jetblue", "singapore", "united", "virginatlantic"],
  },
  amex: {
    label: "Amex MR",
    sources: [
      "aeromexico",
      "aeroplan",
      "delta",
      "emirates",
      "etihad",
      "flyingblue",
      "qatar",
      "qantas",
      "singapore",
      "virginatlantic",
    ],
  },
  capitalone: {
    label: "Capital One",
    sources: [
      "aeroplan",
      "emirates",
      "etihad",
      "finnair",
      "flyingblue",
      "qatar",
      "singapore",
      "turkish",
      "virginatlantic",
    ],
  },
  citi: {
    label: "Citi ThankYou",
    sources: [
      "aeromexico",
      "emirates",
      "etihad",
      "flyingblue",
      "qatar",
      "singapore",
      "turkish",
      "virginatlantic",
    ],
  },
};

export const PROGRAM_LABELS = {
  aeroplan: "Aeroplan",
  flyingblue: "Flying Blue",
  jetblue: "JetBlue",
  singapore: "KrisFlyer",
  united: "United",
  virginatlantic: "Virgin Atlantic",
  american: "American",
  alaska: "Alaska",
  delta: "Delta",
  emirates: "Emirates",
  etihad: "Etihad",
  qatar: "Qatar",
  qantas: "Qantas",
  aeromexico: "Aeromexico",
  turkish: "Turkish",
  finnair: "Finnair",
  lufthansa: "Miles&More",
  ethopian: "Ethiopian",
  ethiopian: "Ethiopian",
  saudia: "Saudia",
  eurobonus: "EuroBonus",
  velocity: "Velocity",
  smiles: "Smiles",
  azul: "Azul",
  connectmiles: "ConnectMiles",
  frontier: "Frontier",
  spirit: "Spirit",
};

/** Alliance membership for seats.aero sources (best-effort). */
export const ALLIANCE_BY_SOURCE = {
  united: "star",
  aeroplan: "star",
  singapore: "star",
  lufthansa: "star",
  turkish: "star",
  ethiopian: "star",
  ethopian: "star",
  american: "oneworld",
  alaska: "oneworld",
  qatar: "oneworld",
  qantas: "oneworld",
  finnair: "oneworld",
  delta: "skyteam",
  flyingblue: "skyteam",
  aeromexico: "skyteam",
  virginatlantic: "skyteam",
  saudia: "skyteam",
  emirates: "none",
  etihad: "none",
  jetblue: "none",
  eurobonus: "none",
  velocity: "none",
  smiles: "none",
  azul: "none",
  connectmiles: "star",
  frontier: "none",
  spirit: "none",
};

export const ALLIANCE_LABELS = {
  star: "Star Alliance",
  oneworld: "Oneworld",
  skyteam: "SkyTeam",
  none: "No Alliance",
};

export function sourcesForTransferPartners(preset) {
  const key = String(preset || "chase").toLowerCase();
  const entry = TRANSFER_PARTNER_PRESETS[key] || TRANSFER_PARTNER_PRESETS.chase;
  return entry.sources;
}

export function programLabel(source) {
  const key = String(source || "").toLowerCase().trim();
  if (!key) return "—";
  if (PROGRAM_LABELS[key]) return PROGRAM_LABELS[key];
  return key.replace(/[A-Za-z0-9]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

export function allianceForSource(source) {
  const key = String(source || "").toLowerCase();
  return ALLIANCE_BY_SOURCE[key] || "none";
}

export function transferBanksForSource(source) {
  const key = String(source || "").toLowerCase();
  const banks = [];
  for (const [id, meta] of Object.entries(TRANSFER_PARTNER_PRESETS)) {
    if (id === "all") continue;
    if (!meta.sources || meta.sources.includes(key)) banks.push(id);
  }
  return banks;
}

export async function readSeatsApiKey() {
  try {
    const data = await chrome.storage.local.get(SEATS_KEY_STORAGE);
    return String(data[SEATS_KEY_STORAGE] || "").trim();
  } catch {
    return "";
  }
}

export async function writeSeatsApiKey(key) {
  const value = String(key || "").trim();
  await chrome.storage.local.set({ [SEATS_KEY_STORAGE]: value });
  return value;
}

function parseAirportList(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const codes = raw
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]{3}$/.test(s));
  return [...new Set(codes)];
}

function cabinAvailable(row) {
  return Boolean(row?.YAvailable || row?.WAvailable || row?.JAvailable || row?.FAvailable);
}

function summarizeCabin(row) {
  const bits = [];
  if (row.YAvailable) bits.push({ cabin: "Y", miles: Number(row.YMileageCost) || null, direct: row.YDirect });
  if (row.WAvailable) bits.push({ cabin: "W", miles: Number(row.WMileageCost) || null, direct: row.WDirect });
  if (row.JAvailable) bits.push({ cabin: "J", miles: Number(row.JMileageCost) || null, direct: row.JDirect });
  if (row.FAvailable) bits.push({ cabin: "F", miles: Number(row.FMileageCost) || null, direct: row.FDirect });
  bits.sort((a, b) => (a.miles ?? 1e12) - (b.miles ?? 1e12));
  return bits[0] || null;
}

function cabinCode(cabin) {
  const c = String(cabin || "").toLowerCase();
  if (c.startsWith("econ") || c === "y") return "Y";
  if (c.startsWith("prem") || c === "w") return "W";
  if (c.startsWith("bus") || c === "j") return "J";
  if (c.startsWith("first") || c === "f") return "F";
  return (cabin && String(cabin).slice(0, 1).toUpperCase()) || null;
}

function parseIsoLocal(value) {
  if (!value) return null;
  const s = String(value);
  if (s.startsWith("0001-01-01")) return null;
  // Prefer date/time as given (already airport-local in seats.aero).
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: m[1], hour: Number(m[2]), minute: Number(m[3]), raw: s };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s, hour: null, minute: null, raw: s };
  return null;
}

function cleanDateTime(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s || s.startsWith("0001-01-01")) return null;
  if (!/\d{2}:\d{2}/.test(s)) return null;
  return s;
}

function tripDateTime(trip, ordered, field) {
  const upper = field; // DepartsAt / ArrivesAt
  const lower = field[0].toLowerCase() + field.slice(1);
  const fromTrip = cleanDateTime(trip?.[upper] || trip?.[lower] || null);
  if (fromTrip) return fromTrip;
  if (!ordered?.length) return null;
  const seg = field.startsWith("Depart") ? ordered[0] : ordered[ordered.length - 1];
  return cleanDateTime(seg?.[upper] || seg?.[lower] || seg?.[field.toLowerCase()] || null);
}

function segmentsOf(trip) {
  return (
    trip?.AvailabilitySegments ||
    trip?.availabilitySegments ||
    trip?.Segments ||
    trip?.segments ||
    []
  );
}

function segmentAircraftLabel(seg) {
  return String(seg?.AircraftName || seg?.AircraftCode || seg?.aircraftName || seg?.aircraftCode || "")
    .trim();
}

function tripAircraftList(trip, orderedSegments = []) {
  const fromSegs = orderedSegments.map(segmentAircraftLabel).filter(Boolean);
  const raw = trip?.Aircraft ?? trip?.aircraft ?? null;
  const fromTrip = Array.isArray(raw)
    ? raw.map((v) => String(v || "").trim()).filter(Boolean)
    : typeof raw === "string"
      ? String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return [...new Set([...fromSegs, ...fromTrip])];
}

function scaleSeatsTaxAmount(raw) {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  // Seats often reports taxes in cents for USD-like currencies.
  return amount >= 100 && Number.isInteger(amount) ? amount / 100 : amount;
}

/**
 * Normalize flight taxes to USD via the same FX helper hotels use.
 * Keeps original amount/currency on taxesOriginal / taxesCurrencyOriginal.
 */
async function applyFlightTaxUsd(flight) {
  if (!flight || flight.taxes == null || !Number.isFinite(Number(flight.taxes))) {
    return {
      ...flight,
      taxesOriginal: flight?.taxesOriginal ?? null,
      taxesCurrencyOriginal: flight?.taxesCurrencyOriginal ?? flight?.taxesCurrency ?? null,
      fxRateToUsd: flight?.fxRateToUsd ?? null,
    };
  }

  // Already converted in a prior pass / cache write.
  if (
    flight.fxRateToUsd != null &&
    String(flight.taxesCurrency || "").toUpperCase() === "USD"
  ) {
    return flight;
  }

  const currencyOriginal = String(
    flight.taxesCurrencyOriginal || flight.taxesCurrency || flight.taxesCurrencySymbol || "USD"
  )
    .trim()
    .toUpperCase() || "USD";
  const scaled =
    flight.taxesOriginal != null && Number.isFinite(Number(flight.taxesOriginal))
      ? Number(flight.taxesOriginal)
      : scaleSeatsTaxAmount(flight.taxes);

  if (scaled == null) {
    return {
      ...flight,
      taxes: null,
      taxesCurrency: "USD",
      taxesOriginal: null,
      taxesCurrencyOriginal: currencyOriginal,
      fxRateToUsd: null,
    };
  }

  try {
    const conv = await convertToUsd(scaled, currencyOriginal);
    const usd =
      conv.amount == null ? scaled : Math.round(Number(conv.amount) * 100) / 100;
    return {
      ...flight,
      taxes: usd,
      taxesCurrency: "USD",
      taxesOriginal: scaled,
      taxesCurrencyOriginal: conv.fromCurrency || currencyOriginal,
      fxRateToUsd: conv.rate ?? (currencyOriginal === "USD" ? 1 : null),
    };
  } catch {
    return {
      ...flight,
      taxes: scaled,
      taxesCurrency: currencyOriginal,
      taxesOriginal: scaled,
      taxesCurrencyOriginal: currencyOriginal,
      fxRateToUsd: null,
    };
  }
}

async function normalizeTripRow(avail, trip) {
  const route = avail.Route || {};
  const source = String(trip.Source || avail.Source || route.Source || "").toLowerCase() || null;
  const segs = segmentsOf(trip);
  const ordered = [...segs].sort((a, b) => (Number(a.Order) || 0) - (Number(b.Order) || 0));
  const first = ordered[0] || null;
  const last = ordered[ordered.length - 1] || null;
  const departsAt = tripDateTime(trip, ordered, "DepartsAt");
  const arrivesAt = tripDateTime(trip, ordered, "ArrivesAt");
  const dep = parseIsoLocal(departsAt);
  const arr = parseIsoLocal(arrivesAt);
  const origin =
    String(first?.OriginAirport || route.OriginAirport || trip.OriginAirport || "").toUpperCase() ||
    null;
  const destination =
    String(
      last?.DestinationAirport || route.DestinationAirport || trip.DestinationAirport || ""
    ).toUpperCase() || null;
  const connections = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const code = String(ordered[i]?.DestinationAirport || "").toUpperCase();
    if (code) connections.push(code);
  }
  const aircraft = tripAircraftList(trip, ordered);
  const fareClasses = [
    ...new Set(ordered.map((s) => String(s.FareClass || "").trim()).filter(Boolean)),
  ];
  const stops =
    trip.Stops != null
      ? Number(trip.Stops)
      : Math.max(0, ordered.length - 1);
  const durationMinutes =
    trip.TotalDuration != null
      ? Number(trip.TotalDuration)
      : null;
  const cabin = cabinCode(trip.Cabin) || summarizeCabin(avail)?.cabin || null;
  const mileageCost =
    trip.MileageCost != null
      ? Number(trip.MileageCost)
      : summarizeCabin(avail)?.miles ?? null;

  const row = {
    id: String(trip.ID || `${avail.ID}:${cabin}:${departsAt || avail.Date}`),
    availabilityId: avail.ID || null,
    date: dep?.date || avail.Date || String(avail.ParsedDate || "").slice(0, 10),
    origin,
    destination,
    source,
    program: programLabel(source),
    alliance: allianceForSource(source),
    transferBanks: transferBanksForSource(source),
    bestCabin: cabin,
    cabin,
    mileageCost: Number.isFinite(mileageCost) ? mileageCost : null,
    taxes: trip.TotalTaxes != null ? Number(trip.TotalTaxes) : null,
    direct: stops === 0,
    stops: Number.isFinite(stops) ? stops : null,
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
    departsAt,
    arrivesAt,
    departHour: dep?.hour ?? null,
    arriveHour: arr?.hour ?? null,
    carriers: String(trip.Carriers || "").split(",").map((s) => s.trim()).filter(Boolean),
    flightNumbers: String(trip.FlightNumbers || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    aircraft,
    fareClasses,
    connections,
    remainingSeats: trip.RemainingSeats != null ? Number(trip.RemainingSeats) : null,
    taxesCurrency: trip.TaxesCurrency || trip.TaxesCurrencySymbol || null,
    segments: ordered.map((s, idx) => ({
      order: Number(s.Order) || idx + 1,
      flightNumber: String(s.FlightNumber || "").trim() || null,
      origin: String(s.OriginAirport || "").toUpperCase() || null,
      destination: String(s.DestinationAirport || "").toUpperCase() || null,
      departsAt: cleanDateTime(s.DepartsAt || s.departsAt || null),
      arrivesAt: cleanDateTime(s.ArrivesAt || s.arrivesAt || null),
      aircraft: segmentAircraftLabel(s) || null,
      fareClass: String(s.FareClass || "").trim() || null,
      distance: s.Distance != null ? Number(s.Distance) : null,
    })),
    bookingLinks: normalizeBookingLinks(trip),
    yAvailable: Boolean(avail.YAvailable),
    wAvailable: Boolean(avail.WAvailable),
    jAvailable: Boolean(avail.JAvailable),
    fAvailable: Boolean(avail.FAvailable),
    hasTrip: true,
  };
  return applyFlightTaxUsd(row);
}

function normalizeBookingLinks(tripOrPayload) {
  const raw =
    tripOrPayload?.BookingLinks ||
    tripOrPayload?.booking_links ||
    tripOrPayload?.bookingLinks ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((link) => ({
      label: String(link?.label || link?.Label || "Book").trim() || "Book",
      link: String(link?.link || link?.Link || link?.url || "").trim(),
      primary: Boolean(link?.primary ?? link?.Primary ?? true),
    }))
    .filter((link) => link.link);
}

function normalizeSummaryRow(avail) {
  const route = avail.Route || {};
  const source = String(avail.Source || route.Source || "").toLowerCase() || null;
  const best = summarizeCabin(avail);
  return {
    id: String(avail.ID || `${route.OriginAirport}-${route.DestinationAirport}-${avail.Date}`),
    availabilityId: avail.ID || null,
    date: avail.Date || String(avail.ParsedDate || "").slice(0, 10),
    origin: String(route.OriginAirport || "").toUpperCase() || null,
    destination: String(route.DestinationAirport || "").toUpperCase() || null,
    source,
    program: programLabel(source),
    alliance: allianceForSource(source),
    transferBanks: transferBanksForSource(source),
    bestCabin: best?.cabin || null,
    cabin: best?.cabin || null,
    mileageCost: best?.miles ?? null,
    taxes: null,
    direct: Boolean(best?.direct),
    stops: best?.direct ? 0 : null,
    durationMinutes: null,
    departsAt: null,
    arrivesAt: null,
    departHour: null,
    arriveHour: null,
    carriers: [],
    flightNumbers: [],
    aircraft: [],
    fareClasses: [],
    connections: [],
    remainingSeats: null,
    taxesCurrency: null,
    segments: [],
    bookingLinks: [],
    yAvailable: Boolean(avail.YAvailable),
    wAvailable: Boolean(avail.WAvailable),
    jAvailable: Boolean(avail.JAvailable),
    fAvailable: Boolean(avail.FAvailable),
    hasTrip: false,
  };
}

async function seatsFetch(url, { method = "GET", headers = {}, operation = "search" } = {}) {
  try {
    const response = await fetch(url, { method, headers });
    recordOutbound({
      url: String(url),
      method,
      kind: "seats",
      operation,
      via: "service_worker",
      status: response.status,
      ok: response.ok,
    });
    return response;
  } catch (err) {
    recordOutbound({
      url: String(url),
      method,
      kind: "seats",
      operation,
      via: "service_worker",
      ok: false,
      error: err?.message || err,
    });
    throw err;
  }
}

/**
 * Trip / booking details for an availability ID.
 * https://developers.seats.aero/reference/get-trips
 */
export async function fetchTripDetails(availabilityId, { apiKey = null } = {}) {
  const id = String(availabilityId || "").trim();
  if (!id) throw new Error("Availability ID required.");
  const key = String(apiKey || (await readSeatsApiKey()) || "").trim();
  if (!key) {
    const err = new Error("Seats.aero API key required. Add it in the search page footer.");
    err.code = "missing_api_key";
    throw err;
  }
  const response = await seatsFetch(`${SEATS_API_BASE}/trips/${encodeURIComponent(id)}`, {
    method: "GET",
    operation: "trips",
    headers: {
      Accept: "application/json",
      "Partner-Authorization": key,
    },
  });
  if (response.status === 401 || response.status === 403) {
    const err = new Error("Seats.aero rejected the API key (unauthorized).");
    err.code = "unauthorized";
    throw err;
  }
  if (response.status === 404) {
    return { availabilityId: id, bookingLinks: [], trips: [] };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Seats.aero trips failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  const json = await response.json();
  const trips = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const bookingLinks = [
    ...normalizeBookingLinks(json),
    ...trips.flatMap((trip) => normalizeBookingLinks(trip)),
  ];
  const seen = new Set();
  const uniqueLinks = [];
  for (const link of bookingLinks) {
    if (seen.has(link.link)) continue;
    seen.add(link.link);
    uniqueLinks.push(link);
  }
  const availStub = { ID: id, Route: {}, Source: trips[0]?.Source || null };
  const normalizedTrips = await Promise.all(
    trips.map((trip) => normalizeTripRow(availStub, trip))
  );
  return {
    availabilityId: id,
    bookingLinks: uniqueLinks,
    trips: normalizedTrips,
    raw: json,
  };
}

/**
 * Cached search across mileage programs.
 * https://developers.seats.aero/reference/cached-search
 */
export async function cachedFlightSearch({
  originAirports,
  destinationAirports,
  startDate,
  endDate,
  transferPartners = "chase",
  apiKey = null,
  take = 500,
  onlyDirect = false,
  cabins = null,
  includeTrips = true,
  skipCache = false,
} = {}) {
  const origins = parseAirportList(originAirports);
  const destinations = parseAirportList(destinationAirports);
  if (!origins.length) throw new Error("At least one origin airport (IATA) is required.");
  if (!destinations.length) throw new Error("At least one destination airport (IATA) is required.");
  if (!startDate || !endDate) throw new Error("Departure start and end dates are required.");

  const cacheParams = {
    originAirports: origins,
    destinationAirports: destinations,
    startDate,
    endDate,
    transferPartners: String(transferPartners || "chase"),
    onlyDirect: Boolean(onlyDirect),
    cabins: cabins || null,
    includeTrips: includeTrips !== false,
  };

  if (!skipCache) {
    try {
      const hit = await getCachedFlightSearch(cacheParams);
      if (hit && Array.isArray(hit.flights)) {
        const flights = await Promise.all(hit.flights.map((f) => applyFlightTaxUsd(f)));
        recordActivity({
          type: "search",
          name: "seats_cache_hit",
          ok: true,
          detail: {
            flightCount: flights.length,
            origins,
            destinations,
            startDate,
            endDate,
            apiCalls: 0,
          },
        });
        return { ...hit, flights, fromCache: true, apiCalls: 0 };
      }
    } catch {
      /* ignore cache read errors */
    }
  }

  const key = String(apiKey || (await readSeatsApiKey()) || "").trim();
  if (!key) {
    const err = new Error("Seats.aero API key required. Add it in the search page footer.");
    err.code = "missing_api_key";
    throw err;
  }

  const sources = sourcesForTransferPartners(transferPartners);
  const all = [];
  let cursor = null;
  let skip = 0;
  let guard = 0;
  let apiCalls = 0;

  while (guard < 40) {
    guard += 1;
    const url = new URL(`${SEATS_API_BASE}/search`);
    url.searchParams.set("origin_airport", origins.join(","));
    url.searchParams.set("destination_airport", destinations.join(","));
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    url.searchParams.set("take", String(Math.max(10, Math.min(1000, Number(take) || 500))));
    url.searchParams.set("order_by", "lowest_mileage");
    if (includeTrips) {
      // Full trips (not minify) — minify strips segments/aircraft/times.
      url.searchParams.set("include_trips", "true");
    }
    if (skip > 0) url.searchParams.set("skip", String(skip));
    if (cursor != null) url.searchParams.set("cursor", String(cursor));
    if (sources?.length) url.searchParams.set("sources", sources.join(","));
    if (onlyDirect) url.searchParams.set("only_direct_flights", "true");
    if (cabins) url.searchParams.set("cabins", String(cabins));

    const response = await seatsFetch(url.toString(), {
      method: "GET",
      operation: "search",
      headers: {
        Accept: "application/json",
        "Partner-Authorization": key,
      },
    });
    apiCalls += 1;

    if (response.status === 401 || response.status === 403) {
      const err = new Error("Seats.aero rejected the API key (unauthorized).");
      err.code = "unauthorized";
      throw err;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Seats.aero search failed (${response.status})${text ? `: ${text.slice(0, 180)}` : ""}`);
    }

    const json = await response.json();
    const page = Array.isArray(json?.data) ? json.data : [];
    all.push(...page);
    if (!json?.hasMore || !page.length) break;
    cursor = json.cursor ?? cursor;
    skip = all.length;
  }

  const flights = [];
  const seen = new Set();
  for (const row of all) {
    const trips = row.AvailabilityTrips || row.availabilityTrips || [];
    if (Array.isArray(trips) && trips.length) {
      for (const trip of trips) {
        const normalized = await normalizeTripRow(row, trip);
        if (!normalized.date || !normalized.origin || !normalized.destination) continue;
        if (seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        flights.push(normalized);
      }
      continue;
    }
    if (!cabinAvailable(row)) continue;
    const summary = normalizeSummaryRow(row);
    if (!summary.date || !summary.origin || !summary.destination) continue;
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    flights.push(summary);
  }

  flights.sort((a, b) => {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate) return byDate;
    const byMiles = (a.mileageCost ?? 1e12) - (b.mileageCost ?? 1e12);
    if (byMiles) return byMiles;
    return String(a.departsAt || "").localeCompare(String(b.departsAt || ""));
  });

  const result = {
    flights,
    count: flights.length,
    rawCount: all.length,
    origins,
    destinations,
    startDate,
    endDate,
    transferPartners: String(transferPartners || "chase"),
    sources: sources || "all",
    fromCache: false,
    apiCalls,
  };

  try {
    await setCachedFlightSearch(cacheParams, result);
  } catch {
    /* ignore cache write errors */
  }

  return result;
}

/**
 * Collapse award hits into hotel stays: one window per destination using
 * the trip departure/return dates (check-in → check-out).
 */
export function hotelStaysFromFlights(flights, { arrivalDate, departureDate } = {}) {
  const from = String(arrivalDate || "").slice(0, 10);
  const to = String(departureDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) {
    return { stays: [], byDestination: new Map(), nights: 0 };
  }
  const nights = nightsBetweenISO(from, to);
  const byDestination = new Map();

  for (const flight of flights || []) {
    const dest = String(flight.destination || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(dest)) continue;
    if (!byDestination.has(dest)) {
      byDestination.set(dest, {
        from,
        to,
        nights,
        mode: "exact",
        destination: dest,
        flights: [],
      });
    }
    byDestination.get(dest).flights.push(flight);
  }

  const stays = [...byDestination.values()].sort((a, b) =>
    a.destination.localeCompare(b.destination)
  );
  return { stays, byDestination, nights };
}

function nightsBetweenISO(fromDate, toDate) {
  const a = String(fromDate || "").slice(0, 10);
  const b = String(toDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b) || b <= a) return 1;
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  const ms = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
  return Math.max(1, Math.round(ms / 86400000));
}
