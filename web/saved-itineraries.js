/**
 * Saved flight + hotel itineraries (chrome.storage.local / localStorage fallback).
 */

export const SAVED_ITINERARIES_KEY = "savedItineraries";
export const MAX_SAVED_ITINERARIES = 50;

function storageGet(keys) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      chrome.storage.local.get(keys, (data) => resolve(data || {}));
      return;
    }
    const out = {};
    for (const key of keys) {
      try {
        out[key] = JSON.parse(localStorage.getItem(key) || "null");
      } catch {
        out[key] = null;
      }
    }
    resolve(out);
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      chrome.storage.local.set(obj, () => resolve());
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    resolve();
  });
}

export function itineraryFingerprint(entry) {
  const out = entry?.outbound || {};
  const ret = entry?.return || {};
  const hotel = entry?.hotel || {};
  return [
    out.id || "",
    ret.id || "",
    hotel.ctyhocn || "",
    hotel.arrivalDate || "",
    hotel.departureDate || "",
    hotel.amount ?? "",
    hotel.ratePlanCode || "",
    hotel.roomTypeCode || "",
  ].join("|");
}

/** Destination airport code used in saved trip titles. */
export function itineraryDestinationCode(entry) {
  const fromOutbound = String(entry?.outbound?.destination || "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{3}$/.test(fromOutbound)) return fromOutbound;
  const fromSearch = entry?.search?.destinations;
  if (Array.isArray(fromSearch)) {
    const code = String(fromSearch[0] || "")
      .trim()
      .toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) return code;
  } else if (typeof fromSearch === "string") {
    const code = fromSearch
      .split(/[\s,]+/)
      .map((p) => p.trim().toUpperCase())
      .find((p) => /^[A-Z]{3}$/.test(p));
    if (code) return code;
  }
  return "";
}

export function buildItineraryTitle({
  outbound = null,
  return: ret = null,
  hotel = null,
  search = null,
} = {}) {
  if (!outbound && hotel) {
    const name = String(hotel.hotelName || hotel.ctyhocn || "Hotel stay").trim() || "Hotel stay";
    const arrival = hotel.arrivalDate ? String(hotel.arrivalDate).slice(0, 10) : "";
    const departure = hotel.departureDate ? String(hotel.departureDate).slice(0, 10) : "";
    if (arrival && departure) return `${name} · ${arrival} → ${departure}`;
    if (arrival) return `${name} · ${arrival}`;
    return name;
  }
  const code =
    itineraryDestinationCode({ outbound, return: ret, search }) ||
    String(outbound?.destination || "")
      .trim()
      .toUpperCase() ||
    "—";
  return ret ? `Round-trip to ${code}` : `One-way to ${code}`;
}

/** Prefer stored name; derive for older saves. */
export function itineraryTitle(entry) {
  if (entry?.name && String(entry.name).trim()) return String(entry.name).trim();
  return buildItineraryTitle(entry || {});
}

export function snapshotFlight(flight) {
  if (!flight) return null;
  return {
    id: flight.id || null,
    availabilityId: flight.availabilityId || null,
    direction: flight.direction || null,
    origin: flight.origin || null,
    destination: flight.destination || null,
    date: flight.date || null,
    departsAt: flight.departsAt || null,
    arrivesAt: flight.arrivesAt || null,
    departHour: flight.departHour ?? null,
    arriveHour: flight.arriveHour ?? null,
    source: flight.source || flight.program || null,
    program: flight.program || flight.source || null,
    alliance: flight.alliance || null,
    mileageCost: flight.mileageCost ?? null,
    taxes: flight.taxes ?? null,
    taxesCurrency: flight.taxesCurrency || flight.taxesCurrencySymbol || null,
    cabin: flight.cabin || flight.bestCabin || null,
    bestCabin: flight.bestCabin || flight.cabin || null,
    stops: flight.stops ?? null,
    direct: flight.direct ?? null,
    durationMinutes: flight.durationMinutes ?? null,
    remainingSeats: flight.remainingSeats ?? null,
    flightNumbers: Array.isArray(flight.flightNumbers) ? [...flight.flightNumbers] : [],
    connections: Array.isArray(flight.connections) ? [...flight.connections] : [],
    carriers: Array.isArray(flight.carriers) ? [...flight.carriers] : [],
    fareClasses: Array.isArray(flight.fareClasses) ? [...flight.fareClasses] : [],
    aircraft: Array.isArray(flight.aircraft) ? [...flight.aircraft] : [],
    segments: Array.isArray(flight.segments) ? flight.segments.map((s) => ({ ...s })) : [],
    bookingLinks: Array.isArray(flight.bookingLinks) ? flight.bookingLinks.map((b) => ({ ...b })) : [],
    fromCache: Boolean(flight.fromCache),
    fetchedAt: flight.fetchedAt ?? null,
  };
}

export function snapshotHotel(hotel, { nights = null } = {}) {
  if (!hotel) return null;
  const n = Number(nights);
  const compare = hotel.compareRate || null;
  const roomDetails = hotel.roomDetails || null;
  return {
    ctyhocn: hotel.ctyhocn || null,
    hotelName: hotel.hotelName || null,
    city: hotel.city || null,
    country: hotel.country || null,
    arrivalDate: hotel.arrivalDate || null,
    departureDate: hotel.departureDate || null,
    amount: hotel.amount ?? null,
    amountFmt: hotel.amountFmt || null,
    amountOriginal: hotel.amountOriginal ?? null,
    currency: hotel.currency || null,
    currencyOriginal: hotel.currencyOriginal || null,
    nights: Number.isFinite(n) && n > 0 ? n : hotel.nights ?? null,
    ratePlanName: hotel.ratePlanName || null,
    ratePlanCode: hotel.ratePlanCode || null,
    roomTypeCode: hotel.roomTypeCode || null,
    inventoryOnly: Boolean(hotel.inventoryOnly),
    stayPriced: hotel.stayPriced !== false,
    bookUrl: hotel.bookUrl || null,
    brandCode: hotel.brandCode || null,
    roomsAvail: hotel.roomsAvail ?? null,
    specialRateType: hotel.specialRateType || null,
    isGoRate: hotel.isGoRate ?? null,
    fromCache: hotel.fromCache !== false,
    fetchedAt: hotel.fetchedAt ?? null,
    compareRate: compare
      ? {
          amount: compare.amount ?? null,
          amountFmt: compare.amountFmt || null,
          currency: compare.currency || null,
          ratePlanName: compare.ratePlanName || null,
          ratePlanCode: compare.ratePlanCode || null,
        }
      : null,
    roomDetails: roomDetails
      ? {
          currency: roomDetails.currency || null,
          fromCache: Boolean(roomDetails.fromCache),
          rooms: Array.isArray(roomDetails.rooms)
            ? roomDetails.rooms.map((room) => ({
                amount: room.amount ?? null,
                amountFmt: room.amountFmt || null,
                currency: room.currency || null,
                roomsAvail: room.roomsAvail ?? null,
                ratePlanCode: room.ratePlanCode || null,
                ratePlanName: room.ratePlanName || null,
                roomTypeCode: room.roomTypeCode || null,
                roomTypeName: room.roomTypeName || null,
                specialRateType: room.specialRateType || null,
                isGoRate: Boolean(room.isGoRate),
              }))
            : [],
        }
      : null,
  };
}

export function buildItinerary({
  outbound,
  return: ret,
  hotel,
  nights = null,
  points = null,
  cash = null,
  search = null,
  name = null,
} = {}) {
  const searchMeta = search
    ? {
        origins: search.origins || search.flightOrigins || null,
        destinations: search.destinations || search.flightDestinations || null,
        departureDate: search.departureDate || search.flightStartDate || null,
        returnDate: search.returnDate || search.flightEndDate || null,
        tripType:
          search.tripType ||
          search.flightTripType ||
          (ret ? "roundtrip" : "oneway"),
      }
    : null;
  const entry = {
    id: `itin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    name:
      (name && String(name).trim()) ||
      buildItineraryTitle({ outbound, return: ret, hotel, search: searchMeta }),
    outbound: snapshotFlight(outbound),
    return: snapshotFlight(ret),
    hotel: snapshotHotel(hotel, { nights }),
    totals: {
      points: Number.isFinite(Number(points)) ? Number(points) : null,
      cash: Number.isFinite(Number(cash)) ? Number(cash) : null,
    },
    search: searchMeta,
  };
  entry.fingerprint = itineraryFingerprint(entry);
  return entry;
}

export async function loadSavedItineraries() {
  const data = await storageGet([SAVED_ITINERARIES_KEY]);
  const list = Array.isArray(data[SAVED_ITINERARIES_KEY]) ? data[SAVED_ITINERARIES_KEY] : [];
  return list.slice(0, MAX_SAVED_ITINERARIES);
}

export async function persistSavedItineraries(list) {
  const next = (Array.isArray(list) ? list : []).slice(0, MAX_SAVED_ITINERARIES);
  await storageSet({ [SAVED_ITINERARIES_KEY]: next });
  return next;
}

export async function upsertSavedItinerary(entry) {
  const list = await loadSavedItineraries();
  const fp = entry.fingerprint || itineraryFingerprint(entry);
  const next = [
    { ...entry, fingerprint: fp },
    ...list.filter(
      (e) => e.id !== entry.id && (e.fingerprint || itineraryFingerprint(e)) !== fp
    ),
  ];
  return persistSavedItineraries(next);
}

export async function removeSavedItinerary(id) {
  const list = await loadSavedItineraries();
  return persistSavedItineraries(list.filter((e) => e.id !== id));
}

export async function findSavedByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const list = await loadSavedItineraries();
  return list.find((e) => (e.fingerprint || itineraryFingerprint(e)) === fingerprint) || null;
}

export async function toggleSavedItinerary(entry) {
  const fp = entry.fingerprint || itineraryFingerprint(entry);
  const existing = await findSavedByFingerprint(fp);
  if (existing) {
    const list = await removeSavedItinerary(existing.id);
    return { saved: false, list, entry: null };
  }
  const list = await upsertSavedItinerary(entry);
  const saved = list.find((e) => (e.fingerprint || itineraryFingerprint(e)) === fp) || entry;
  return { saved: true, list, entry: saved };
}
