/**
 * Award flights results table — stays-table look + Seats.aero-style filters.
 */

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Extension runtime unavailable" });
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

const PROGRAM_LABELS = {
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

const ALLIANCE_LABELS = {
  star: "Star Alliance",
  oneworld: "Oneworld",
  skyteam: "SkyTeam",
  none: "No Alliance",
};

const TRANSFER_PARTNER_PRESETS = {
  chase: { label: "Chase UR" },
  amex: { label: "Amex MR" },
  capitalone: { label: "Capital One" },
  citi: { label: "Citi ThankYou" },
};
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_BUCKETS = [
  { id: "overnight", label: "Overnight (12am – 5:59am)", test: (h) => h >= 0 && h < 6 },
  { id: "morning", label: "Morning (6am – 11:59am)", test: (h) => h >= 6 && h < 12 },
  { id: "afternoon", label: "Afternoon (12pm – 5:59pm)", test: (h) => h >= 12 && h < 18 },
  { id: "evening", label: "Evening (6pm – 11:59pm)", test: (h) => h >= 18 && h <= 23 },
];
const STOP_OPTIONS = [
  { id: "0", label: "Nonstop" },
  { id: "1", label: "1 stop" },
  { id: "2plus", label: "2+ stops" },
];

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatCount(n) {
  return Number(n || 0).toLocaleString();
}

function formatMiles(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

function taxAmountDollars(flight) {
  if (flight?.taxes == null || !Number.isFinite(Number(flight.taxes))) return null;
  const amount = Number(flight.taxes);
  // Service worker stores major-unit USD after FX (same path as hotel rates).
  if (flight.fxRateToUsd != null || flight.taxesCurrencyOriginal) {
    return amount;
  }
  // Legacy Seats rows: taxes often reported in cents for USD-like currencies.
  return amount >= 100 && Number.isInteger(amount) ? amount / 100 : amount;
}

function formatTaxMoney(flight) {
  const scaled = taxAmountDollars(flight);
  if (scaled == null) return null;
  const currency = String(flight.taxesCurrency || flight.taxesCurrencySymbol || "")
    .trim()
    .toUpperCase();
  const formatted = scaled.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Prefer USD after FX normalization; fall back to original currency label.
  if (!currency || currency === "USD" || currency === "$") {
    const original = String(flight.taxesCurrencyOriginal || "").trim().toUpperCase();
    if (
      original &&
      original !== "USD" &&
      original !== "$" &&
      flight.taxesOriginal != null &&
      Number.isFinite(Number(flight.taxesOriginal))
    ) {
      const origFmt = Number(flight.taxesOriginal).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return `$${formatted} (${original} ${origFmt})`;
    }
    return `$${formatted}`;
  }
  if (currency === "AUD") return `A$${formatted}`;
  if (currency === "CAD") return `C$${formatted}`;
  if (currency === "EUR" || currency === "€") return `€${formatted}`;
  if (currency === "GBP" || currency === "£") return `£${formatted}`;
  return `${currency} ${formatted}`;
}

function formatTaxes(flight) {
  return formatTaxMoney(flight) || "—";
}

function formatPointsWithTaxes(flight) {
  const miles = formatMiles(flight?.mileageCost);
  const tax = formatTaxMoney(flight);
  if (miles === "—") return tax ? `— + ${tax}` : "—";
  if (!tax) return miles;
  return `${miles} + ${tax}`;
}

function formatProgramName(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const key = raw.toLowerCase();
  if (PROGRAM_LABELS[key]) return PROGRAM_LABELS[key];
  const compact = key.replace(/[\s&_-]+/g, "");
  if (PROGRAM_LABELS[compact]) return PROGRAM_LABELS[compact];
  for (const [id, label] of Object.entries(PROGRAM_LABELS)) {
    if (label.toLowerCase() === key) return label;
  }
  return raw.replace(/[A-Za-z0-9]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatAllianceName(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (ALLIANCE_LABELS[key]) return ALLIANCE_LABELS[key];
  if (key === "staralliance") return ALLIANCE_LABELS.star;
  if (key === "noalliance" || key === "none") return ALLIANCE_LABELS.none;
  return raw.replace(/[A-Za-z0-9]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

const CABIN_LABELS = {
  Y: "Economy",
  W: "Premium Economy",
  J: "Business",
  F: "First",
  economy: "Economy",
  premium: "Premium Economy",
  premiumeconomy: "Premium Economy",
  business: "Business",
  first: "First",
};

function formatCabinName(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const upper = raw.toUpperCase();
  if (CABIN_LABELS[upper]) return CABIN_LABELS[upper];
  const compact = raw.toLowerCase().replace(/[\s&_-]+/g, "");
  if (CABIN_LABELS[compact]) return CABIN_LABELS[compact];
  return raw.replace(/[A-Za-z0-9]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatDuration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return "—";
  const h = Math.floor(m / 60);
  const mins = Math.round(m % 60);
  if (h <= 0) return `${mins}m`;
  if (mins === 0) return `${h}h`;
  return `${h}h ${mins}m`;
}

function formatClock(iso) {
  if (!iso && iso !== 0) return "—";
  const s = String(iso).trim();
  if (!s || s.startsWith("0001-01-01")) return "—";
  const m = s.match(/(?:^|[T ])(\d{2}):(\d{2})/);
  if (!m) return "—";
  const hour24 = Number(m[1]);
  const minute = m[2];
  if (!Number.isFinite(hour24) || hour24 < 0 || hour24 > 23) return "—";
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minute}${suffix}`;
}

function flightClockTimes(flight) {
  let departsAt = flight?.departsAt || null;
  let arrivesAt = flight?.arrivesAt || null;
  const segs = Array.isArray(flight?.segments) ? flight.segments : [];
  if (!departsAt && segs.length) departsAt = segs[0]?.departsAt || null;
  if (!arrivesAt && segs.length) arrivesAt = segs[segs.length - 1]?.arrivesAt || null;
  return { departsAt, arrivesAt };
}

function flightClockParts(iso) {
  if (!iso) return null;
  const m = String(iso).trim().match(/(?:^|[T ])(\d{2}):(\d{2})/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function flightTimeParts(flight, which = "depart") {
  if (which === "arrive") {
    if (flight?.arriveHour != null) {
      const fromIso = flightClockParts(flightClockTimes(flight).arrivesAt);
      return { hour: Number(flight.arriveHour), minute: fromIso?.minute || 0 };
    }
    return flightClockParts(flightClockTimes(flight).arrivesAt);
  }
  if (flight?.departHour != null) {
    const fromIso = flightClockParts(flightClockTimes(flight).departsAt);
    return { hour: Number(flight.departHour), minute: fromIso?.minute || 0 };
  }
  return flightClockParts(flightClockTimes(flight).departsAt);
}

function parseTimeInputToMinutes(value) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function minutesInTimeRange(minutes, range) {
  if (!range?.start || !range?.end) return false;
  const start = parseTimeInputToMinutes(range.start);
  const end = parseTimeInputToMinutes(range.end);
  if (start == null || end == null || minutes == null) return false;
  if (start <= end) return minutes >= start && minutes <= end;
  return minutes >= start || minutes <= end;
}

function flightMatchesTimeSide(flight, which, buckets, range) {
  const hasBuckets = buckets?.size > 0;
  const hasRange = Boolean(range?.start && range?.end);
  if (!hasBuckets && !hasRange) return true;
  const parts = flightTimeParts(flight, which);
  if (!parts || parts.hour == null) return false;
  const minutes = parts.hour * 60 + (parts.minute || 0);
  if (hasBuckets) {
    const bucketHit = [...buckets].some((id) => TIME_BUCKETS.find((b) => b.id === id)?.test(parts.hour));
    if (bucketHit) return true;
  }
  if (hasRange && minutesInTimeRange(minutes, range)) return true;
  return false;
}

function timeFilterActiveCount(times = state.filters.times) {
  return (
    (times?.depart?.size || 0) +
    (times?.arrive?.size || 0) +
    (times?.departRange ? 1 : 0) +
    (times?.arriveRange ? 1 : 0)
  );
}

function weekdayOf(isoDate) {
  if (!isoDate) return null;
  return new Date(`${isoDate}T12:00:00`).getDay();
}

function stopsBucket(stops) {
  if (stops == null || !Number.isFinite(Number(stops))) return null;
  const n = Number(stops);
  if (n <= 0) return "0";
  if (n === 1) return "1";
  return "2plus";
}

function emptyTimeFilters() {
  return {
    depart: new Set(),
    arrive: new Set(),
    departRange: null,
    arriveRange: null,
  };
}

function cloneTimeFilters(times) {
  return {
    depart: new Set(times?.depart || []),
    arrive: new Set(times?.arrive || []),
    departRange: times?.departRange ? { ...times.departRange } : null,
    arriveRange: times?.arriveRange ? { ...times.arriveRange } : null,
  };
}

function emptyFilters() {
  return {
    outboundDates: new Set(),
    returnDates: new Set(),
    programs: new Set(),
    cabins: new Set(),
    routes: new Set(),
    alliances: new Set(),
    transferPartners: new Set(),
    pointsMax: null,
    dow: new Set(),
    stops: new Set(),
    durationMaxHours: null,
    times: emptyTimeFilters(),
    aircraft: new Set(),
    fareClasses: new Set(),
    connections: new Set(),
  };
}

const state = {
  all: [],
  rows: [],
  rowsOutbound: [],
  rowsReturn: [],
  filters: emptyFilters(),
  sortKey: "mileageCost",
  sortDir: "asc",
  pageOutbound: 0,
  pageReturn: 0,
  pageSize: 10,
  meta: {},
  openFilter: null,
  openColFilter: null,
  openColFilterTrigger: null,
  openColFilterPanel: null,
  expanded: new Set(),
  tripDetails: new Map(),
  tripDetailsLoading: new Set(),
  refreshingLegs: new Set(),
  selectedOutboundId: null,
  selectedReturnId: null,
  /** Highlighted cheapest-combo flight ids (search suggestion). */
  bestComboOutboundId: null,
  bestComboReturnId: null,
  /** @type {{ arrivalDate: string, departureDate: string | null } | null} */
  selectedStay: null,
};

let tripSelectionListener = null;

function flightRouteValue(flight) {
  const o = String(flight?.origin || "").toUpperCase().trim();
  const d = String(flight?.destination || "").toUpperCase().trim();
  if (!o && !d) return "—";
  return `${o || "?"} → ${d || "?"}`;
}

function flightCabinValue(flight) {
  const raw = String(flight?.cabin || flight?.bestCabin || "").trim();
  if (!raw) return "—";
  return raw.toLowerCase().replace(/[\s&_-]+/g, "") || "—";
}

function cabinBadgeClass(flightOrCabin) {
  const key =
    flightOrCabin && typeof flightOrCabin === "object"
      ? flightCabinValue(flightOrCabin)
      : String(flightOrCabin || "")
          .toLowerCase()
          .replace(/[\s&_-]+/g, "");
  if (key === "business" || key === "j" || key === "first" || key === "f") {
    return "badge cabin-biz";
  }
  if (key === "premium" || key === "premiumeconomy" || key === "w") {
    return "badge cabin-premium";
  }
  return "badge go";
}

const FLIGHT_COL_FILTERS = [
  {
    id: "outbound-date",
    filterKey: "outboundDates",
    leg: "outbound",
    plural: "dates",
    panelWidth: 200,
    value: (flight) => String(flight?.date || "").slice(0, 10).trim() || "—",
    labelFor: (value) => value,
  },
  {
    id: "return-date",
    filterKey: "returnDates",
    leg: "return",
    plural: "dates",
    panelWidth: 200,
    value: (flight) => String(flight?.date || "").slice(0, 10).trim() || "—",
    labelFor: (value) => value,
  },
  {
    id: "route",
    filterKey: "routes",
    leg: null,
    plural: "routes",
    panelWidth: 200,
    value: (flight) => flightRouteValue(flight),
    labelFor: (value) => value,
  },
  {
    id: "program",
    filterKey: "programs",
    leg: null,
    plural: "programs",
    panelWidth: 220,
    value: (flight) => String(flight?.source || "").toLowerCase().trim() || "—",
    labelFor: (value) => formatProgramName(value),
  },
  {
    id: "cabin",
    filterKey: "cabins",
    leg: null,
    plural: "cabins",
    panelWidth: 180,
    value: (flight) => flightCabinValue(flight),
    labelFor: (value) => formatCabinName(value),
  },
  {
    id: "stops",
    filterKey: "stops",
    leg: null,
    plural: "stops",
    panelWidth: 160,
    value: (flight) => stopsBucket(flight?.stops) || "—",
    labelFor: (value) => STOP_OPTIONS.find((o) => o.id === value)?.label || value,
  },
];

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
  );
}

function compareFlights(a, b, key, dir) {
  const mul = dir === "desc" ? -1 : 1;
  const numKeys = new Set(["mileageCost", "stops", "durationMinutes", "departHour"]);
  let av = a?.[key];
  let bv = b?.[key];
  if (key === "route") {
    av = `${a.origin || ""}-${a.destination || ""}`;
    bv = `${b.origin || ""}-${b.destination || ""}`;
  }
  if (numKeys.has(key)) {
    av = av == null || av === "" ? Number.POSITIVE_INFINITY : Number(av);
    bv = bv == null || bv === "" ? Number.POSITIVE_INFINITY : Number(bv);
    if (av === bv) return String(a.date || "").localeCompare(String(b.date || "")) * mul;
    return (av - bv) * mul;
  }
  av = String(av ?? "").toLowerCase();
  bv = String(bv ?? "").toLowerCase();
  if (av === bv) return String(a.date || "").localeCompare(String(b.date || "")) * mul;
  return av.localeCompare(bv) * mul;
}

function flightPassesFilters(flight, filters = state.filters) {
  const date = String(flight.date || "").slice(0, 10).trim() || "—";
  const dateSet =
    flight.direction === "return" ? filters.returnDates : filters.outboundDates;
  if (dateSet?.size && !dateSet.has(date)) return false;
  if (filters.programs.size && !filters.programs.has(String(flight.source || "").toLowerCase())) {
    return false;
  }
  if (filters.cabins?.size) {
    const cabin = flightCabinValue(flight);
    if (!filters.cabins.has(cabin)) return false;
  }
  if (filters.routes?.size) {
    const route = flightRouteValue(flight);
    if (!filters.routes.has(route)) return false;
  }
  if (filters.alliances.size && !filters.alliances.has(String(flight.alliance || "none"))) {
    return false;
  }
  if (filters.transferPartners.size) {
    const banks = flight.transferBanks || [];
    if (![...filters.transferPartners].some((b) => banks.includes(b))) return false;
  }
  if (filters.pointsMax != null && Number.isFinite(filters.pointsMax)) {
    if (flight.mileageCost == null || Number(flight.mileageCost) > filters.pointsMax) return false;
  }
  if (filters.dow.size) {
    const dow = weekdayOf(flight.date);
    if (dow == null || !filters.dow.has(String(dow))) return false;
  }
  if (filters.stops.size) {
    const bucket = stopsBucket(flight.stops);
    if (!bucket || !filters.stops.has(bucket)) return false;
  }
  if (filters.durationMaxHours != null && Number.isFinite(filters.durationMaxHours)) {
    if (
      flight.durationMinutes == null ||
      Number(flight.durationMinutes) > filters.durationMaxHours * 60
    ) {
      return false;
    }
  }
  if (filters.times) {
    if (!flightMatchesTimeSide(flight, "depart", filters.times.depart, filters.times.departRange)) {
      return false;
    }
    if (!flightMatchesTimeSide(flight, "arrive", filters.times.arrive, filters.times.arriveRange)) {
      return false;
    }
  }
  if (filters.aircraft.size) {
    const list = flight.aircraft || [];
    if (![...filters.aircraft].some((a) => list.includes(a))) return false;
  }
  if (filters.fareClasses.size) {
    const list = flight.fareClasses || [];
    if (![...filters.fareClasses].some((a) => list.includes(a))) return false;
  }
  if (filters.connections.size) {
    const list = flight.connections || [];
    if (![...filters.connections].some((a) => list.includes(a))) return false;
  }
  return true;
}

function activeFilterCount(id) {
  const f = state.filters;
  if (id === "outbound-date" || id === "outboundDates") return f.outboundDates.size;
  if (id === "return-date" || id === "returnDates") return f.returnDates.size;
  if (id === "dates" || id === "date") return f.outboundDates.size + f.returnDates.size;
  if (id === "programs" || id === "program") return f.programs.size;
  if (id === "cabin" || id === "cabins") return f.cabins.size;
  if (id === "route" || id === "routes") return f.routes.size;
  if (id === "alliances") return f.alliances.size;
  if (id === "transferPartners") return f.transferPartners.size;
  if (id === "points") return f.pointsMax != null ? 1 : 0;
  if (id === "dow") return f.dow.size;
  if (id === "stops") return f.stops.size;
  if (id === "duration") return f.durationMaxHours != null ? 1 : 0;
  if (id === "times") return timeFilterActiveCount(f.times);
  if (id === "aircraft") return f.aircraft.size;
  if (id === "fareClasses") return f.fareClasses.size;
  if (id === "connections") return f.connections.size;
  return 0;
}

function anyFlightFilterActive() {
  return (
    [
      "outbound-date",
      "return-date",
      "programs",
      "cabin",
      "route",
      "alliances",
      "transferPartners",
      "points",
      "dow",
      "stops",
      "duration",
      "times",
      "aircraft",
      "fareClasses",
      "connections",
    ].some((id) => activeFilterCount(id) > 0)
  );
}

function recomputeRows() {
  const filtered = state.all.filter((f) => flightPassesFilters(f));
  filtered.sort((a, b) => compareFlights(a, b, state.sortKey, state.sortDir));
  state.rows = filtered;
  state.rowsOutbound = filtered.filter((f) => f.direction !== "return");
  state.rowsReturn = filtered.filter((f) => f.direction === "return");
  const valid = new Set([
    ...state.rowsOutbound.map((f) => String(f.id)),
    ...state.rowsReturn.map((f) => String(f.id)),
  ]);
  state.expanded = new Set([...state.expanded].filter((id) => valid.has(id)));
  const clampPage = (page, total) => {
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize) || 1);
    return Math.min(Math.max(0, page), totalPages - 1);
  };
  state.pageOutbound = clampPage(state.pageOutbound, state.rowsOutbound.length);
  state.pageReturn = clampPage(state.pageReturn, state.rowsReturn.length);
}

function getSearchTripRanges() {
  const ranges = state.meta?.search?.tripRanges;
  if (Array.isArray(ranges) && ranges.length) {
    return ranges
      .map((r) => ({
        from: String(r.from || r.departureDate || "").slice(0, 10),
        to: String(r.to || r.returnDate || "").slice(0, 10),
      }))
      .filter((r) => r.from && r.to);
  }
  const dep = String(state.meta?.search?.departureDate || "").slice(0, 10);
  const ret = String(state.meta?.search?.returnDate || "").slice(0, 10);
  if (dep && ret) return [{ from: dep, to: ret }];
  return [];
}

function intersectDateSets(existing, next) {
  if (!next?.size) return existing;
  if (!existing) return new Set(next);
  return new Set([...existing].filter((d) => next.has(d)));
}

/** Opposite-leg date locks from selected flights, hotel stay, and trip windows. */
function pairDateConstraint() {
  const trips = getSearchTripRanges();
  const outbound =
    state.all.find((f) => String(f.id) === String(state.selectedOutboundId)) || null;
  const ret =
    state.all.find((f) => String(f.id) === String(state.selectedReturnId)) || null;
  const outDate = String(outbound?.date || "").slice(0, 10);
  const retDate = String(ret?.date || "").slice(0, 10);

  let outboundDates = null;
  let returnDates = null;

  // Selected flights write into that leg's date filter and the paired opposite dates.
  if (outDate) {
    outboundDates = new Set([outDate]);
    if (trips.length) {
      returnDates = new Set(
        trips.filter((t) => t.from === outDate).map((t) => t.to).filter(Boolean)
      );
    }
  }
  if (retDate) {
    returnDates = returnDates
      ? intersectDateSets(returnDates, new Set([retDate]))
      : new Set([retDate]);
    if (trips.length) {
      const froms = new Set(
        trips.filter((t) => t.to === retDate).map((t) => t.from).filter(Boolean)
      );
      outboundDates = outboundDates ? intersectDateSets(outboundDates, froms) : froms;
    }
  }

  // Selected hotel stay locks both legs to check-in / check-out.
  // If check-out is missing, infer return date(s) from trip windows with that check-in.
  const stay = state.selectedStay;
  if (stay?.arrivalDate || stay?.departureDate) {
    let stayOutbound = stay.arrivalDate ? new Set([stay.arrivalDate]) : null;
    let stayReturn = stay.departureDate ? new Set([stay.departureDate]) : null;
    if (stayOutbound && !stayReturn?.size && trips.length) {
      stayReturn = new Set(
        trips.filter((t) => t.from === stay.arrivalDate).map((t) => t.to).filter(Boolean)
      );
    }
    if (stayReturn?.size && !stayOutbound?.size && trips.length) {
      stayOutbound = new Set(
        trips.filter((t) => t.to === stay.departureDate).map((t) => t.from).filter(Boolean)
      );
    }
    if (stayOutbound?.size) {
      outboundDates = intersectDateSets(outboundDates, stayOutbound);
    }
    if (stayReturn?.size) {
      returnDates = intersectDateSets(returnDates, stayReturn);
    }
  }

  return { outboundDates, returnDates };
}

/** Push selection locks into the visible per-leg Date column filters. */
function syncDateFiltersFromSelection() {
  const { outboundDates, returnDates } = pairDateConstraint();
  state.filters.outboundDates = outboundDates?.size
    ? new Set([...outboundDates].map((d) => String(d).slice(0, 10)))
    : new Set();
  state.filters.returnDates = returnDates?.size
    ? new Set([...returnDates].map((d) => String(d).slice(0, 10)))
    : new Set();
}

/**
 * Hotel stay window(s) implied by the current flight selection, hotel stay, and trip ranges.
 * @returns {{ arrivalDates: Set<string>, departureDates: Set<string> } | null}
 */
export function getTripPairStayConstraint() {
  const trips = getSearchTripRanges();
  const outbound =
    state.all.find((f) => String(f.id) === String(state.selectedOutboundId)) || null;
  const ret =
    state.all.find((f) => String(f.id) === String(state.selectedReturnId)) || null;
  const outDate = String(outbound?.date || "").slice(0, 10);
  const retDate = String(ret?.date || "").slice(0, 10);

  let arrivalDates = null;
  let departureDates = null;

  if (outDate && retDate) {
    if (!trips.length || trips.some((t) => t.from === outDate && t.to === retDate)) {
      arrivalDates = new Set([outDate]);
      departureDates = new Set([retDate]);
    }
  } else if (outDate) {
    arrivalDates = new Set([outDate]);
    if (trips.length) {
      departureDates = new Set(trips.filter((t) => t.from === outDate).map((t) => t.to).filter(Boolean));
      if (!departureDates.size) departureDates = null;
    } else {
      departureDates = new Set();
    }
  } else if (retDate) {
    departureDates = new Set([retDate]);
    if (trips.length) {
      arrivalDates = new Set(trips.filter((t) => t.to === retDate).map((t) => t.from).filter(Boolean));
      if (!arrivalDates.size) arrivalDates = null;
    } else {
      arrivalDates = new Set();
    }
  }

  const stay = state.selectedStay;
  if (stay?.arrivalDate || stay?.departureDate) {
    if (stay.arrivalDate) {
      const stayArr = new Set([stay.arrivalDate]);
      arrivalDates = arrivalDates?.size ? intersectDateSets(arrivalDates, stayArr) : stayArr;
    }
    if (stay.departureDate) {
      const stayDep = new Set([stay.departureDate]);
      departureDates = departureDates?.size
        ? intersectDateSets(departureDates, stayDep)
        : stayDep;
    }
  }

  if (!arrivalDates?.size && !departureDates?.size) return null;
  return {
    arrivalDates: arrivalDates || new Set(),
    departureDates: departureDates || new Set(),
  };
}

function addDaysISO(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + Number(days) || 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Keep flight rows locked to a selected hotel stay (check-in / check-out). */
export function setSelectedStayConstraint(stay, { silent = false } = {}) {
  let arrival = stay?.arrivalDate ? String(stay.arrivalDate).slice(0, 10) : "";
  let departure = stay?.departureDate ? String(stay.departureDate).slice(0, 10) : "";
  if (arrival && !departure) {
    const nights = Number(stay?.nights);
    if (Number.isFinite(nights) && nights > 0) {
      departure = addDaysISO(arrival, nights);
    }
  }
  if (!arrival && !departure) {
    if (!state.selectedStay) return;
    state.selectedStay = null;
  } else {
    state.selectedStay = {
      arrivalDate: arrival || null,
      departureDate: departure || null,
    };
    // Drop flight selections that no longer fit this stay.
    const out =
      state.all.find((f) => String(f.id) === String(state.selectedOutboundId)) || null;
    const ret =
      state.all.find((f) => String(f.id) === String(state.selectedReturnId)) || null;
    const outDate = String(out?.date || "").slice(0, 10);
    const retDate = String(ret?.date || "").slice(0, 10);
    if (outDate && arrival && outDate !== arrival) state.selectedOutboundId = null;
    if (retDate && departure && retDate !== departure) state.selectedReturnId = null;
    // If check-out was inferred only via trip windows, still drop incompatible returns.
    if (retDate && arrival && !departure) {
      const trips = getSearchTripRanges();
      const ok = trips.some((t) => t.from === arrival && t.to === retDate);
      if (trips.length && !ok) state.selectedReturnId = null;
    }
  }
  syncDateFiltersFromSelection();
  if (!silent) refreshFlightTable();
}

function pageRowsFor(list, page) {
  const start = page * state.pageSize;
  return list.slice(start, start + state.pageSize);
}

function updateFilterTriggerBadges() {
  document.querySelectorAll("[data-flight-filter]").forEach((btn) => {
    const id = btn.dataset.flightFilter;
    const count = activeFilterCount(id);
    btn.classList.toggle("has-filter", count > 0);
    let badge = btn.querySelector(".flight-filter-badge");
    if (count > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "flight-filter-badge";
        btn.insertBefore(badge, btn.querySelector(".flight-filter-chevron"));
      }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
  });
}

function optionListHtml(values, selectedSet, valueFmt = (v) => v) {
  if (!values.length) {
    return `<div class="col-filter-empty">No values in results</div>`;
  }
  return values
    .map((value) => {
      const checked = selectedSet.has(value) ? "checked" : "";
      return `<label>
        <input type="checkbox" value="${escapeHtml(value)}" ${checked} />
        <span>${escapeHtml(valueFmt(value))}</span>
      </label>`;
    })
    .join("");
}

function filtersExcluding(excludeId) {
  const f = {
    outboundDates: new Set(state.filters.outboundDates),
    returnDates: new Set(state.filters.returnDates),
    programs: new Set(state.filters.programs),
    cabins: new Set(state.filters.cabins),
    routes: new Set(state.filters.routes),
    alliances: new Set(state.filters.alliances),
    transferPartners: new Set(state.filters.transferPartners),
    pointsMax: state.filters.pointsMax,
    dow: new Set(state.filters.dow),
    stops: new Set(state.filters.stops),
    durationMaxHours: state.filters.durationMaxHours,
    times: cloneTimeFilters(state.filters.times),
    aircraft: new Set(state.filters.aircraft),
    fareClasses: new Set(state.filters.fareClasses),
    connections: new Set(state.filters.connections),
  };
  if (
    excludeId === "outbound-date" ||
    excludeId === "outboundDates" ||
    excludeId === "dates" ||
    excludeId === "date"
  ) {
    f.outboundDates = new Set();
  }
  if (excludeId === "return-date" || excludeId === "returnDates") {
    f.returnDates = new Set();
  }
  if (excludeId === "programs" || excludeId === "program") f.programs = new Set();
  if (excludeId === "cabin" || excludeId === "cabins") f.cabins = new Set();
  if (excludeId === "route" || excludeId === "routes") f.routes = new Set();
  if (excludeId === "alliances") f.alliances = new Set();
  if (excludeId === "transferPartners") f.transferPartners = new Set();
  if (excludeId === "points") f.pointsMax = null;
  if (excludeId === "dow") f.dow = new Set();
  if (excludeId === "stops") f.stops = new Set();
  if (excludeId === "duration") f.durationMaxHours = null;
  if (excludeId === "times") f.times = emptyTimeFilters();
  if (excludeId === "aircraft") f.aircraft = new Set();
  if (excludeId === "fareClasses") f.fareClasses = new Set();
  if (excludeId === "connections") f.connections = new Set();
  return f;
}

/** Flights that would appear given every filter except one (for facet option lists). */
function facetFlights(excludeId) {
  const filters = filtersExcluding(excludeId);
  return state.all.filter((flight) => flightPassesFilters(flight, filters));
}

function pruneSelectedToAvailable(selectedSet, available) {
  const allowed = new Set(available);
  for (const value of [...selectedSet]) {
    if (!allowed.has(value)) selectedSet.delete(value);
  }
}

function fillFilterPanels() {
  const programFacet = facetFlights("programs");
  const allianceFacet = facetFlights("alliances");
  const transferFacet = facetFlights("transferPartners");
  const baseFacet = facetFlights(null);

  const programs = uniqueSorted(
    programFacet.map((f) => String(f.source || "").toLowerCase()).filter(Boolean)
  );
  const alliances = uniqueSorted(
    allianceFacet.map((f) => f.alliance || "none").filter(Boolean)
  );
  const transferBanks = uniqueSorted(
    transferFacet.flatMap((f) => f.transferBanks || [])
  ).filter((id) => TRANSFER_PARTNER_PRESETS[id]);

  pruneSelectedToAvailable(state.filters.programs, programs);
  pruneSelectedToAvailable(state.filters.alliances, alliances);
  pruneSelectedToAvailable(state.filters.transferPartners, transferBanks);

  const aircraft = uniqueSorted(baseFacet.flatMap((f) => f.aircraft || []));
  const fareClasses = uniqueSorted(baseFacet.flatMap((f) => f.fareClasses || []));
  const connections = uniqueSorted(baseFacet.flatMap((f) => f.connections || []));
  pruneSelectedToAvailable(state.filters.aircraft, aircraft);
  pruneSelectedToAvailable(state.filters.fareClasses, fareClasses);
  pruneSelectedToAvailable(state.filters.connections, connections);

  const programList = $("flightFilterProgramsList");
  if (programList) {
    programList.innerHTML = optionListHtml(
      programs,
      state.filters.programs,
      (v) => formatProgramName(v)
    );
  }
  const allianceList = $("flightFilterAlliancesList");
  if (allianceList) {
    allianceList.innerHTML = optionListHtml(
      alliances,
      state.filters.alliances,
      (v) => formatAllianceName(v)
    );
  }
  const transferList = $("flightFilterTransferList");
  if (transferList) {
    if (!transferBanks.length) {
      transferList.innerHTML = `<div class="col-filter-empty">No transfer partners in results</div>`;
    } else {
      transferList.innerHTML = transferBanks
        .map((id) => {
          const label = TRANSFER_PARTNER_PRESETS[id]?.label || id;
          const checked = state.filters.transferPartners.has(id) ? "checked" : "";
          return `<label>
            <input type="checkbox" value="${escapeHtml(id)}" ${checked} />
            <span>${escapeHtml(label)}</span>
          </label>`;
        })
        .join("");
    }
  }
  const stopsList = $("flightFilterStopsList");
  if (stopsList) {
    const availableStops = new Set(
      baseFacet.map((f) => stopsBucket(f.stops)).filter(Boolean)
    );
    const stopOpts = STOP_OPTIONS.filter((o) => availableStops.has(o.id));
    pruneSelectedToAvailable(
      state.filters.stops,
      stopOpts.map((o) => o.id)
    );
    stopsList.innerHTML = stopOpts.length
      ? stopOpts
          .map(({ id, label }) => {
            const checked = state.filters.stops.has(id) ? "checked" : "";
            return `<label>
              <input type="checkbox" value="${escapeHtml(id)}" ${checked} />
              <span>${escapeHtml(label)}</span>
            </label>`;
          })
          .join("")
      : `<div class="col-filter-empty">No stop values in results</div>`;
  }
  const timesDepartList = $("flightFilterDepartTimesList");
  const timesArriveList = $("flightFilterArriveTimesList");
  if (timesDepartList || timesArriveList) {
    const renderTimeSide = (listEl, buckets, range, rangeWrapId, fromId, toId) => {
      if (!listEl) return;
      const rangeChecked = Boolean(range);
      listEl.innerHTML = [
        `<label>
          <input type="checkbox" value="range" data-time-range="1" ${rangeChecked ? "checked" : ""} />
          <span>Specific time range</span>
        </label>`,
        ...TIME_BUCKETS.map(({ id, label }) => {
          const checked = buckets.has(id) ? "checked" : "";
          return `<label>
            <input type="checkbox" value="${escapeHtml(id)}" ${checked} />
            <span>${escapeHtml(label)}</span>
          </label>`;
        }),
      ].join("");
      const rangeWrap = $(rangeWrapId);
      if (rangeWrap) rangeWrap.hidden = !rangeChecked;
      const fromInput = $(fromId);
      const toInput = $(toId);
      if (fromInput) fromInput.value = range?.start || "00:00";
      if (toInput) toInput.value = range?.end || "23:59";
    };
    renderTimeSide(
      timesDepartList,
      state.filters.times.depart,
      state.filters.times.departRange,
      "flightFilterDepartRange",
      "flightFilterDepartFrom",
      "flightFilterDepartTo"
    );
    renderTimeSide(
      timesArriveList,
      state.filters.times.arrive,
      state.filters.times.arriveRange,
      "flightFilterArriveRange",
      "flightFilterArriveFrom",
      "flightFilterArriveTo"
    );
  }
  const dowList = $("flightFilterDowList");
  if (dowList) {
    const availableDow = new Set(
      baseFacet.map((f) => weekdayOf(f.date)).filter((d) => d != null).map(String)
    );
    pruneSelectedToAvailable(state.filters.dow, [...availableDow]);
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => availableDow.has(String(d)));
    dowList.innerHTML = days.length
      ? days
          .map((d) => {
            const checked = state.filters.dow.has(String(d)) ? "checked" : "";
            return `<label>
              <input type="checkbox" value="${d}" ${checked} />
              <span>${DAY_LABELS[d]}</span>
            </label>`;
          })
          .join("")
      : `<div class="col-filter-empty">No days in results</div>`;
  }
  const aircraftList = $("flightFilterAircraftList");
  if (aircraftList) {
    aircraftList.innerHTML = optionListHtml(aircraft, state.filters.aircraft);
  }
  const fareList = $("flightFilterFareList");
  if (fareList) {
    fareList.innerHTML = optionListHtml(fareClasses, state.filters.fareClasses);
  }
  const connList = $("flightFilterConnectionsList");
  if (connList) {
    connList.innerHTML = optionListHtml(connections, state.filters.connections);
  }

  const pointsInput = $("flightFilterPointsMax");
  if (pointsInput) {
    pointsInput.value =
      state.filters.pointsMax == null ? "" : String(state.filters.pointsMax);
  }
  const durationInput = $("flightFilterDurationMax");
  if (durationInput) {
    durationInput.value =
      state.filters.durationMaxHours == null ? "" : String(state.filters.durationMaxHours);
  }
}

function closeFlightFilterPanels() {
  state.openFilter = null;
  document.querySelectorAll("[data-flight-filter-panel]").forEach((panel) => {
    panel.hidden = true;
    unmountOverlayPanel(panel);
  });
  document.querySelectorAll("[data-flight-filter]").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
}

function closeFlightColFilterPanels() {
  state.openColFilter = null;
  state.openColFilterTrigger = null;
  state.openColFilterPanel = null;
  for (const def of FLIGHT_COL_FILTERS) {
    document.querySelectorAll(`[data-flight-col-filter-panel="${def.id}"]`).forEach((panel) => {
      panel.hidden = true;
      unmountOverlayPanel(panel);
    });
    document.querySelectorAll(`[data-flight-col-filter="${def.id}"]`).forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
  }
}

function closeAllFlightOverlays() {
  closeFlightFilterPanels();
  closeFlightColFilterPanels();
}

function flightColFilterSelected(id) {
  const def = FLIGHT_COL_FILTERS.find((c) => c.id === id);
  if (!def) return new Set();
  return state.filters[def.filterKey];
}

function availableFlightColValues(id) {
  const def = FLIGHT_COL_FILTERS.find((c) => c.id === id);
  if (!def) return [];
  let facet = facetFlights(id);
  if (def.leg === "outbound") facet = facet.filter((f) => f.direction !== "return");
  if (def.leg === "return") facet = facet.filter((f) => f.direction === "return");
  const fromResults = facet.map((flight) => def.value(flight)).filter((v) => v && v !== "—");
  // Keep active selections even when they match zero rows (e.g. hotel date with no awards).
  const selected = [...flightColFilterSelected(id)].filter((v) => v && v !== "—");
  const values = uniqueSorted([...fromResults, ...selected]);
  if (id === "stops") {
    const order = STOP_OPTIONS.map((o) => o.id);
    return values.sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  return values;
}

function flightColFilterListHtml(id, values) {
  const def = FLIGHT_COL_FILTERS.find((c) => c.id === id);
  if (!values.length) {
    return `<div class="col-filter-empty">No ${def?.plural || "values"} in results</div>`;
  }
  const selected = flightColFilterSelected(id);
  return values
    .map((value) => {
      const checked = selected.has(value) ? " checked" : "";
      return `<label>
        <input type="checkbox" value="${escapeHtml(value)}"${checked} />
        <span>${escapeHtml(def.labelFor(value))}</span>
      </label>`;
    })
    .join("");
}

function renderFlightColFilterList(id, values = availableFlightColValues(id)) {
  const html = flightColFilterListHtml(id, values);
  document.querySelectorAll(`[data-flight-col-filter-list="${id}"]`).forEach((list) => {
    list.innerHTML = html;
  });
}

function mountOverlayPanel(panel) {
  if (!panel || panel.dataset.overlayMounted === "1") return;
  panel._overlayParent = panel.parentNode;
  panel._overlayNext = panel.nextSibling;
  document.body.appendChild(panel);
  panel.dataset.overlayMounted = "1";
}

function unmountOverlayPanel(panel) {
  if (!panel || panel.dataset.overlayMounted !== "1") return;
  const parent = panel._overlayParent;
  const next = panel._overlayNext;
  if (parent) {
    if (next && next.parentNode === parent) parent.insertBefore(panel, next);
    else parent.appendChild(panel);
  }
  panel._overlayParent = null;
  panel._overlayNext = null;
  delete panel.dataset.overlayMounted;
  panel.style.left = "";
  panel.style.top = "";
  panel.style.width = "";
}

function pinOverlayPanel(panel, trigger, { width = 220, gap = 6 } = {}) {
  if (!panel || !trigger || panel.hidden) return;
  mountOverlayPanel(panel);
  const rect = trigger.getBoundingClientRect();
  const w = Math.min(width, window.innerWidth - 16);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
  let top = rect.bottom + gap;
  const maxH = Math.min(320, window.innerHeight * 0.6);
  if (top + Math.min(panel.scrollHeight || maxH, maxH) > window.innerHeight - 8) {
    top = Math.max(8, rect.top - gap - Math.min(panel.scrollHeight || 200, maxH));
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${w}px`;
}

function positionFlightColFilterPanel(id, triggerEl = null) {
  const trigger =
    triggerEl ||
    state.openColFilterTrigger ||
    document.querySelector(`[data-flight-col-filter="${id}"][aria-expanded="true"]`) ||
    document.querySelector(`[data-flight-col-filter="${id}"]`);
  const def = FLIGHT_COL_FILTERS.find((c) => c.id === id);
  const panel =
    state.openColFilterPanel ||
    trigger?.closest(".col-filter")?.querySelector(`[data-flight-col-filter-panel="${id}"]`) ||
    document.querySelector(`[data-flight-col-filter-panel="${id}"][data-overlay-mounted="1"]`) ||
    document.querySelector(`[data-flight-col-filter-panel="${id}"]:not([hidden])`);
  if (!trigger || !panel || panel.hidden || !def) return;
  pinOverlayPanel(panel, trigger, { width: def.panelWidth || 220 });
}

function positionFlightFilterPanel(id) {
  const btn = document.querySelector(`[data-flight-filter="${id}"]`);
  const panel =
    document.querySelector(`[data-flight-filter-panel="${id}"][data-overlay-mounted="1"]`) ||
    document.querySelector(`[data-flight-filter-panel="${id}"]`);
  if (!btn || !panel || panel.hidden) return;
  const wide = panel.classList.contains("flight-filter-panel-times");
  pinOverlayPanel(panel, btn, { width: wide ? 300 : 240 });
}

function repositionOpenFlightOverlays() {
  if (state.openColFilter) {
    positionFlightColFilterPanel(state.openColFilter, state.openColFilterTrigger);
  }
  if (state.openFilter) positionFlightFilterPanel(state.openFilter);
}

function pruneFlightColFilters() {
  let pruned = false;
  for (let pass = 0; pass < FLIGHT_COL_FILTERS.length; pass += 1) {
    let changed = false;
    for (const def of FLIGHT_COL_FILTERS) {
      const values = availableFlightColValues(def.id);
      const selected = flightColFilterSelected(def.id);
      const before = selected.size;
      pruneSelectedToAvailable(selected, values);
      if (selected.size !== before) {
        changed = true;
        pruned = true;
      }
    }
    if (!changed) break;
  }
  return pruned;
}

function updateFlightColFilterUi() {
  for (const def of FLIGHT_COL_FILTERS) {
    const values = availableFlightColValues(def.id);
    const selected = flightColFilterSelected(def.id);
    const count = selected.size;
    const metaText = !count
      ? ""
      : count <= 2
        ? [...selected]
            .sort((a, b) => a.localeCompare(b))
            .map((v) => def.labelFor(v))
            .join(", ")
        : `${count} ${def.plural}`;
    document.querySelectorAll(`[data-flight-col-filter="${def.id}"]`).forEach((trigger) => {
      trigger.classList.toggle("has-filter", count > 0);
      // Keep the control usable when a selection pinned a date with zero matches.
      trigger.disabled = !values.length && !count;
    });
    document.querySelectorAll(`[data-flight-col-filter-meta="${def.id}"]`).forEach((meta) => {
      meta.textContent = metaText;
    });
    renderFlightColFilterList(def.id, values);
  }
}

function setFlightColFilterOpen(id, open, triggerEl = null) {
  closeFlightFilterPanels();
  for (const def of FLIGHT_COL_FILTERS) {
    document.querySelectorAll(`[data-flight-col-filter-panel="${def.id}"]`).forEach((panel) => {
      panel.hidden = true;
    });
    document.querySelectorAll(`[data-flight-col-filter="${def.id}"]`).forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
  }
  if (!open) {
    state.openColFilter = null;
    state.openColFilterTrigger = null;
    return;
  }
  const trigger =
    triggerEl || document.querySelector(`[data-flight-col-filter="${id}"]`);
  const panel = trigger?.closest(".col-filter")?.querySelector(`[data-flight-col-filter-panel="${id}"]`);
  if (!trigger || !panel) {
    state.openColFilter = null;
    state.openColFilterTrigger = null;
    return;
  }
  renderFlightColFilterList(id);
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  state.openColFilter = id;
  state.openColFilterTrigger = trigger;
  state.openColFilterPanel = panel;
  positionFlightColFilterPanel(id, trigger);
}

function syncFlightColFilterFromDom(id, listEl = null) {
  const list =
    listEl ||
    state.openColFilterPanel?.querySelector(`[data-flight-col-filter-list="${id}"]`) ||
    document.querySelector(`[data-flight-col-filter-list="${id}"]`);
  const def = FLIGHT_COL_FILTERS.find((c) => c.id === id);
  if (!list || !def) return;
  state.filters[def.filterKey] = new Set(
    [...list.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value)
  );
  state.pageOutbound = 0;
  state.pageReturn = 0;
  requestAnimationFrame(() => {
    fillFilterPanels();
    refreshFlightTable();
  });
}

function openFlightFilter(id) {
  const opening = state.openFilter !== id;
  closeAllFlightOverlays();
  if (!opening) return;
  fillFilterPanels();
  state.openFilter = id;
  const btn = document.querySelector(`[data-flight-filter="${id}"]`);
  const panel = document.querySelector(`[data-flight-filter-panel="${id}"]`);
  if (btn) btn.setAttribute("aria-expanded", "true");
  if (panel) {
    panel.hidden = false;
    positionFlightFilterPanel(id);
  }
}

function readCheckboxSet(listEl) {
  const set = new Set();
  if (!listEl) return set;
  listEl.querySelectorAll('input[type="checkbox"]:checked').forEach((el) => {
    set.add(el.value);
  });
  return set;
}

function applyFilterPanel(id) {
  if (id === "programs") state.filters.programs = readCheckboxSet($("flightFilterProgramsList"));
  if (id === "alliances") state.filters.alliances = readCheckboxSet($("flightFilterAlliancesList"));
  if (id === "transferPartners") {
    state.filters.transferPartners = readCheckboxSet($("flightFilterTransferList"));
  }
  if (id === "stops") state.filters.stops = readCheckboxSet($("flightFilterStopsList"));
  if (id === "times") {
    const readSide = (listId, fromId, toId) => {
      const listEl = $(listId);
      const selected = readCheckboxSet(listEl);
      const rangeOn = selected.has("range");
      selected.delete("range");
      const buckets = new Set([...selected].filter((v) => TIME_BUCKETS.some((b) => b.id === v)));
      let range = null;
      if (rangeOn) {
        const start = $(fromId)?.value || "00:00";
        const end = $(toId)?.value || "23:59";
        range = { start, end };
      }
      return { buckets, range };
    };
    const depart = readSide("flightFilterDepartTimesList", "flightFilterDepartFrom", "flightFilterDepartTo");
    const arrive = readSide("flightFilterArriveTimesList", "flightFilterArriveFrom", "flightFilterArriveTo");
    state.filters.times = {
      depart: depart.buckets,
      arrive: arrive.buckets,
      departRange: depart.range,
      arriveRange: arrive.range,
    };
  }
  if (id === "dow") state.filters.dow = readCheckboxSet($("flightFilterDowList"));
  if (id === "aircraft") state.filters.aircraft = readCheckboxSet($("flightFilterAircraftList"));
  if (id === "fareClasses") {
    state.filters.fareClasses = readCheckboxSet($("flightFilterFareList"));
  }
  if (id === "connections") {
    state.filters.connections = readCheckboxSet($("flightFilterConnectionsList"));
  }
  if (id === "points") {
    const raw = $("flightFilterPointsMax")?.value;
    const n = raw === "" || raw == null ? null : Number(raw);
    state.filters.pointsMax = Number.isFinite(n) ? n : null;
  }
  if (id === "duration") {
    const raw = $("flightFilterDurationMax")?.value;
    const n = raw === "" || raw == null ? null : Number(raw);
    state.filters.durationMaxHours = Number.isFinite(n) ? n : null;
  }
  state.pageOutbound = 0;
  state.pageReturn = 0;
  fillFilterPanels();
  refreshFlightTable();
}

function resetFilter(id) {
  if (id === "outbound-date" || id === "outboundDates") state.filters.outboundDates = new Set();
  if (id === "return-date" || id === "returnDates") state.filters.returnDates = new Set();
  if (id === "dates" || id === "date") {
    state.filters.outboundDates = new Set();
    state.filters.returnDates = new Set();
  }
  if (id === "programs" || id === "program") state.filters.programs = new Set();
  if (id === "cabin" || id === "cabins") state.filters.cabins = new Set();
  if (id === "route" || id === "routes") state.filters.routes = new Set();
  if (id === "alliances") state.filters.alliances = new Set();
  if (id === "transferPartners") state.filters.transferPartners = new Set();
  if (id === "points") state.filters.pointsMax = null;
  if (id === "dow") state.filters.dow = new Set();
  if (id === "stops") state.filters.stops = new Set();
  if (id === "duration") state.filters.durationMaxHours = null;
  if (id === "times") state.filters.times = emptyTimeFilters();
  if (id === "aircraft") state.filters.aircraft = new Set();
  if (id === "fareClasses") state.filters.fareClasses = new Set();
  if (id === "connections") state.filters.connections = new Set();
  fillFilterPanels();
  state.pageOutbound = 0;
  state.pageReturn = 0;
  refreshFlightTable();
}

function resetAllFlightFilters() {
  state.filters = emptyFilters();
  fillFilterPanels();
  state.pageOutbound = 0;
  state.pageReturn = 0;
  refreshFlightTable();
}

function updateSortHeaders() {
  document.querySelectorAll("#flightResults [data-flight-sort]").forEach((btn) => {
    const key = btn.dataset.flightSort;
    const active = key === state.sortKey;
    btn.classList.toggle("active", active);
    btn.dataset.dir = active ? state.sortDir : "";
    btn.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function updateLegPager(leg) {
  const isOutbound = leg === "outbound";
  const rows = isOutbound ? state.rowsOutbound : state.rowsReturn;
  const page = isOutbound ? state.pageOutbound : state.pageReturn;
  const pager = $(isOutbound ? "flightOutboundPager" : "flightReturnPager");
  const range = $(isOutbound ? "flightOutboundRangeLabel" : "flightReturnRangeLabel");
  const jump = $(isOutbound ? "flightOutboundPageJump" : "flightReturnPageJump");
  const totalLabel = $(isOutbound ? "flightOutboundPageTotalLabel" : "flightReturnPageTotalLabel");
  const prev = document.querySelector(`[data-flight-page="${leg}-prev"]`);
  const next = document.querySelector(`[data-flight-page="${leg}-next"]`);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize) || 1);
  if (pager) pager.hidden = total === 0;
  const start = total ? page * state.pageSize + 1 : 0;
  const end = Math.min(total, (page + 1) * state.pageSize);
  if (range) range.textContent = total ? `${formatCount(start)}–${formatCount(end)} of ${formatCount(total)}` : "";
  if (jump) jump.value = String(page + 1);
  if (totalLabel) totalLabel.textContent = `of ${formatCount(totalPages)}`;
  if (prev) prev.disabled = page <= 0;
  if (next) next.disabled = page >= totalPages - 1;
}

function updatePager() {
  updateLegPager("outbound");
  updateLegPager("return");
  if ($("flightPageSize")) $("flightPageSize").value = String(state.pageSize);
}

function updateLabel() {
  const el = $("flightResultsLabel");
  if (el) {
    const total = state.all.length;
    const shown = state.rowsOutbound.length + state.rowsReturn.length;
    const cached = [...state.rowsOutbound, ...state.rowsReturn].filter((f) => f.fromCache).length;
    const cacheBit = cached > 0 ? ` (${formatCount(cached)} from cache)` : "";
    const filterBit = anyFlightFilterActive() ? " matching filters" : "";
    const oneWay = state.meta?.search?.tripType === "oneway";
    const pair = getTripPairStayConstraint();
    const stay = state.selectedStay;
    const pairBit = pair
      ? pair.arrivalDates?.size === 1 && pair.departureDates?.size === 1
        ? ` · trip ${[...pair.arrivalDates][0]} → ${[...pair.departureDates][0]}`
        : " · paired trip dates"
      : stay?.arrivalDate && stay?.departureDate
        ? ` · trip ${stay.arrivalDate} → ${stay.departureDate}`
        : stay?.arrivalDate
          ? ` · trip ${stay.arrivalDate}`
          : "";
    if (!total) {
      el.textContent = "No award flights";
    } else {
      const spent = state.meta?.seatsApiCallsSpent;
      const spentBit =
        spent != null && Number.isFinite(Number(spent))
          ? ` · ${formatCount(Number(spent))} Seats.aero API call${Number(spent) === 1 ? "" : "s"} spent`
          : "";
      if (oneWay) {
        el.textContent = `${formatCount(shown)} award flight${shown === 1 ? "" : "s"}${cacheBit}${filterBit}${pairBit} · ${formatCount(
          state.rowsOutbound.length
        )} outbound${spentBit}${state.meta.transferLabel ? ` · ${state.meta.transferLabel}` : ""}`;
      } else {
        el.textContent = `${formatCount(shown)} award flight${shown === 1 ? "" : "s"}${cacheBit}${filterBit}${pairBit} · ${formatCount(
          state.rowsOutbound.length
        )} outbound · ${formatCount(state.rowsReturn.length)} returning${spentBit}${
          state.meta.transferLabel ? ` · ${state.meta.transferLabel}` : ""
        }`;
      }
    }
  }
  const outLabel = $("flightOutboundLabel");
  if (outLabel) {
    outLabel.textContent = `Outbound${
      state.rowsOutbound.length ? ` · ${formatCount(state.rowsOutbound.length)}` : ""
    }`;
  }
  const retLabel = $("flightReturnLabel");
  if (retLabel) {
    retLabel.textContent = `Return${
      state.rowsReturn.length ? ` · ${formatCount(state.rowsReturn.length)}` : ""
    }`;
  }
}

function renderLegBody(bodyId, rows, page, emptyMessage, filteredEmptyMessage = null) {
  const body = $(bodyId);
  if (!body) return;
  if (!state.all.length) {
    body.innerHTML = `<tr class="empty"><td colspan="9">${escapeHtml(emptyMessage)}</td></tr>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<tr class="empty"><td colspan="9">${escapeHtml(
      filteredEmptyMessage || "No flights match the current filters."
    )}</td></tr>`;
    return;
  }
  body.innerHTML = pageRowsFor(rows, page).map(flightRowHtml).join("");
}

function formatCacheCapturedAt(fetchedAt) {
  const ts = Number(fetchedAt);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function flightCacheIconHtml(flight, { readOnly = false } = {}) {
  const leg = flight.direction === "return" ? "return" : "outbound";
  if (!flight.fromCache && !state.refreshingLegs.has(leg)) return "";
  const refreshing = !readOnly && state.refreshingLegs.has(leg);
  const captured = formatCacheCapturedAt(flight.fetchedAt);
  const title = refreshing
    ? "Refreshing…"
    : readOnly
      ? captured
        ? `Cached · captured ${captured}`
        : "Cached saved result"
      : captured
        ? `Cached · captured ${captured} — click to refresh`
        : "Cached (less than 4 hours old) — click to refresh";
  return `<button
    type="button"
    class="cache-icon${refreshing ? " refreshing" : ""}"
    ${readOnly ? "" : `data-flight-cache-refresh="${escapeHtml(leg)}"`}
    title="${escapeHtml(title)}"
    aria-label="${escapeHtml(title)}"
    ${refreshing ? "disabled" : ""}
    ${readOnly ? 'tabindex="-1" aria-disabled="true"' : ""}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <ellipse cx="8" cy="4.2" rx="5.2" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.8 4.2v3.4c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.8 7.6v3.4c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V7.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
    </svg>
  </button>`;
}

export function setFlightLegRefreshing(leg, refreshing) {
  const direction = leg === "return" ? "return" : "outbound";
  if (refreshing) state.refreshingLegs.add(direction);
  else state.refreshingLegs.delete(direction);
}

async function refreshCachedFlightLeg(leg) {
  const direction = leg === "return" ? "return" : "outbound";
  const search = state.meta?.search;
  if (!search?.origins || !search?.destinations || state.refreshingLegs.has(direction)) return;
  if (!search.departureDate || !search.returnDate) return;

  state.refreshingLegs.add(direction);
  refreshFlightTable();

  const isReturn = direction === "return";
  const res = await sendMessage({
    type: "SEATS_CACHED_SEARCH",
    originAirports: isReturn ? search.destinations : search.origins,
    destinationAirports: isReturn ? search.origins : search.destinations,
    startDate: isReturn ? search.returnDate : search.departureDate,
    endDate: isReturn ? search.returnDate : search.departureDate,
    arrivalDate: isReturn ? null : search.departureDate,
    departureDate: isReturn ? null : search.returnDate,
    transferPartners: search.transferPartners || "all",
    skipCache: true,
  });

  if (res?.ok) {
    const next = (res.flights || []).map((f, i) => ({
      ...f,
      direction,
      fromCache: false,
      fetchedAt: Date.now(),
      id: `${direction}:${f.id || `${f.source}-${f.date}-${f.origin}-${f.destination}-${i}`}`,
    }));
    state.all = [
      ...state.all.filter((f) => (f.direction === "return") !== isReturn),
      ...next,
    ];
    if (isReturn) state.meta.returnCount = next.length;
    else state.meta.outboundCount = next.length;
  }

  state.refreshingLegs.delete(direction);
  fillFilterPanels();
  refreshFlightTable();
}

function flightBookUrl(flight) {
  const links = [
    ...(flight.bookingLinks || []),
    ...(state.tripDetails.get(flight.availabilityId)?.bookingLinks || []),
  ];
  const primary = links.find((l) => l.primary && l.link) || links.find((l) => l.link);
  if (primary?.link) return primary.link;
  const params = new URLSearchParams();
  if (flight.origin) params.set("origin", flight.origin);
  if (flight.destination) params.set("destination", flight.destination);
  if (flight.date) params.set("date", flight.date);
  if (flight.source) params.set("source", flight.source);
  if (flight.cabin) params.set("cabin", String(flight.cabin).toLowerCase());
  return `https://seats.aero/?${params.toString()}`;
}

function flightDetailItems(flight) {
  const stops =
    flight.stops == null
      ? flight.direct
        ? "Nonstop"
        : "—"
      : flight.stops === 0
        ? "Nonstop"
        : `${flight.stops} stop${flight.stops === 1 ? "" : "s"}`;
  return [
    ["Date", flight.date || "—"],
    ["Leg", flight.direction === "return" ? "Return" : flight.direction === "outbound" ? "Outbound" : "—"],
    ["Route", `${flight.origin || "?"} → ${flight.destination || "?"}`],
    ["Program", formatProgramName(flight.source || flight.program)],
    ["Alliance", formatAllianceName(flight.alliance)],
    ["Points", formatPointsWithTaxes(flight)],
    ["Taxes", formatTaxes(flight)],
    ["Cabin", formatCabinName(flight.cabin || flight.bestCabin)],
    ["Stops", stops],
    ["Duration", formatDuration(flight.durationMinutes)],
    ["Departs", formatClock(flightClockTimes(flight).departsAt)],
    ["Arrives", formatClock(flightClockTimes(flight).arrivesAt)],
    ["Flights", flight.flightNumbers?.length ? flight.flightNumbers.join(", ") : "—"],
    ["Carriers", flight.carriers?.length ? flight.carriers.join(", ") : "—"],
    ["Aircraft", flight.aircraft?.length ? flight.aircraft.join(", ") : "—"],
    ["Fare classes", flight.fareClasses?.length ? flight.fareClasses.join(", ") : "—"],
    ["Connections", flight.connections?.length ? flight.connections.join(", ") : "—"],
    ["Seats left", flight.remainingSeats != null ? String(flight.remainingSeats) : "—"],
  ];
}

function flightSegmentsHtml(flight) {
  const segments = Array.isArray(flight.segments) ? flight.segments : [];
  if (!segments.length) return "";
  const rows = segments
    .map((seg) => {
      const route = `${seg.origin || "?"} → ${seg.destination || "?"}`;
      return `<tr>
        <td>${escapeHtml(seg.flightNumber || "—")}</td>
        <td>${escapeHtml(route)}</td>
        <td>${escapeHtml(formatClock(seg.departsAt))}<div class="hotel-code">${escapeHtml(
          formatClock(seg.arrivesAt)
        )}</div></td>
        <td>${escapeHtml(seg.aircraft || "—")}</td>
        <td>${escapeHtml(seg.fareClass || "—")}</td>
      </tr>`;
    })
    .join("");
  return `<div class="flight-segments">
    <div class="flight-segments-title">Segments</div>
    <table class="flight-segments-table">
      <thead><tr><th>Flight</th><th>Route</th><th>Times</th><th>Aircraft</th><th>Fare</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function flightBookingLinksHtml(flight) {
  const links = [
    ...(flight.bookingLinks || []),
    ...(state.tripDetails.get(flight.availabilityId)?.bookingLinks || []),
  ];
  const seen = new Set();
  const unique = [];
  for (const link of links) {
    if (!link?.link || seen.has(link.link)) continue;
    seen.add(link.link);
    unique.push(link);
  }
  if (!unique.length) {
    return `<a class="book-link" href="${escapeHtml(flightBookUrl(flight))}" target="_blank" rel="noopener">Open on Seats.aero</a>`;
  }
  return unique
    .map(
      (link) =>
        `<a class="book-link" href="${escapeHtml(link.link)}" target="_blank" rel="noopener">${escapeHtml(
          link.label || "Book"
        )}</a>`
    )
    .join("");
}

function flightSelectButtonHtml(flight, { forceSelected = null, disabled = false } = {}) {
  const id = String(flight.id || "");
  const leg = flight.direction === "return" ? "return" : "outbound";
  const selected =
    forceSelected != null
      ? Boolean(forceSelected)
      : leg === "return"
        ? state.selectedReturnId === id
        : state.selectedOutboundId === id;
  return `<button
    type="button"
    class="trip-select-btn${selected ? " is-selected" : ""}"
    data-flight-select="${escapeHtml(id)}"
    data-flight-select-leg="${leg}"
    aria-pressed="${selected ? "true" : "false"}"
    ${disabled ? "disabled" : ""}
  >${selected ? "Selected" : "Select"}</button>`;
}

function notifyTripSelectionChange() {
  if (typeof tripSelectionListener === "function") tripSelectionListener();
}

function selectFlightForTrip(id, leg) {
  const direction = leg === "return" ? "return" : "outbound";
  const key = direction === "return" ? "selectedReturnId" : "selectedOutboundId";
  const selecting = state[key] !== id;
  if (state[key] === id) state[key] = null;
  else state[key] = id;

  if (selecting) {
    const trips = getSearchTripRanges();
    const flight = state.all.find((f) => String(f.id) === String(id));
    const flightDate = String(flight?.date || "").slice(0, 10);
    if (trips.length && flightDate) {
      if (direction === "outbound" && state.selectedReturnId) {
        const ret =
          state.all.find((f) => String(f.id) === String(state.selectedReturnId)) || null;
        const retDate = String(ret?.date || "").slice(0, 10);
        const ok = trips.some((t) => t.from === flightDate && t.to === retDate);
        if (!ok) state.selectedReturnId = null;
      }
      if (direction === "return" && state.selectedOutboundId) {
        const out =
          state.all.find((f) => String(f.id) === String(state.selectedOutboundId)) || null;
        const outDate = String(out?.date || "").slice(0, 10);
        const ok = trips.some((t) => t.from === outDate && t.to === flightDate);
        if (!ok) state.selectedOutboundId = null;
      }
    }
  }

  syncDateFiltersFromSelection();
  refreshFlightTable();
  notifyTripSelectionChange();
}

export function setTripSelectionListener(listener) {
  tripSelectionListener = typeof listener === "function" ? listener : null;
}

export function clearTripFlightSelection({ silent = false } = {}) {
  state.selectedOutboundId = null;
  state.selectedReturnId = null;
  syncDateFiltersFromSelection();
  if (!silent) {
    refreshFlightTable();
    notifyTripSelectionChange();
  }
}

export function clearSelectedStayConstraint({ silent = false } = {}) {
  setSelectedStayConstraint(null, { silent });
}

export function clearSelectedReturnFlight({ silent = false } = {}) {
  if (!state.selectedReturnId) return;
  state.selectedReturnId = null;
  syncDateFiltersFromSelection();
  if (!silent) {
    refreshFlightTable();
    notifyTripSelectionChange();
  }
}

export function getSelectedTripFlights() {
  const outbound =
    state.all.find((f) => String(f.id) === String(state.selectedOutboundId)) || null;
  const ret =
    state.all.find((f) => String(f.id) === String(state.selectedReturnId)) || null;
  return { outbound, return: ret };
}

export { taxAmountDollars, formatPointsWithTaxes, formatTaxMoney, formatMiles, formatProgramName, formatCabinName, formatDuration, formatClock, formatAllianceName };

function flightRowHtml(
  flight,
  { forceSelected = null, selectDisabled = false, cacheReadOnly = false, hideSelect = false } = {}
) {
  const id = String(flight.id || "");
  const open = state.expanded.has(id);
  const selected =
    !hideSelect &&
    (forceSelected != null
      ? Boolean(forceSelected)
      : (flight.direction === "return" ? state.selectedReturnId : state.selectedOutboundId) === id);
  const route = `${flight.origin || "?"} → ${flight.destination || "?"}`;
  const stops =
    flight.stops == null
      ? flight.direct
        ? "Nonstop"
        : "—"
      : flight.stops === 0
        ? "Nonstop"
        : `${flight.stops} stop${flight.stops === 1 ? "" : "s"}`;
  const cabin = formatCabinName(flight.cabin || flight.bestCabin);
  const cabinClass = cabinBadgeClass(flight);
  const conn =
    flight.connections?.length
      ? `<div class="hotel-code">${escapeHtml(flight.connections.join(" · "))}</div>`
      : "";
  const flights =
    flight.flightNumbers?.length
      ? `<div class="hotel-code">${escapeHtml(flight.flightNumbers.join(", "))}</div>`
      : "";
  const details = flightDetailItems(flight)
    .map(
      ([label, value]) =>
        `<div class="detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join("");
  const loading = state.tripDetailsLoading.has(flight.availabilityId)
    ? `<div class="hotel-code">Loading booking links…</div>`
    : "";
  const cacheIcon = flightCacheIconHtml(flight, { readOnly: cacheReadOnly });
  const times = flightClockTimes(flight);
  const colSpan = hideSelect ? 8 : 9;
  const selectCell = hideSelect
    ? ""
    : `<td class="select-col">${flightSelectButtonHtml(flight, {
        forceSelected: selected,
        disabled: selectDisabled,
      })}</td>`;
  const bestCombo =
    !hideSelect &&
    (state.bestComboOutboundId === id || state.bestComboReturnId === id);
  const optimalTag = bestCombo
    ? `<span class="most-optimal-tag" title="Price optimal for this trip">PRICE OPTIMAL</span>`
    : "";
  return `<tr class="result-row flight-row${open ? " open" : ""}${
    selected ? " is-trip-selected" : ""
  }${bestCombo ? " is-best-combo" : ""}" data-flight-id="${escapeHtml(id)}" tabindex="0" aria-expanded="${open ? "true" : "false"}">
    ${selectCell}
    <td class="date-cell">${cacheIcon}${escapeHtml(flight.date || "—")}<div class="hotel-code">${escapeHtml(
      DAY_LABELS[weekdayOf(flight.date)] || ""
    )}</div></td>
    <td>
      <div class="hotel-name">${escapeHtml(route)}</div>
      ${optimalTag}
      ${flights}${conn}
    </td>
    <td>
      <div class="hotel-name">${escapeHtml(formatProgramName(flight.source || flight.program))}</div>
      <div class="hotel-code">${escapeHtml(formatAllianceName(flight.alliance))}</div>
    </td>
    <td class="rate">${escapeHtml(formatPointsWithTaxes(flight))}</td>
    <td><span class="${cabinClass}">${escapeHtml(cabin)}</span></td>
    <td>${escapeHtml(stops)}</td>
    <td>${escapeHtml(formatDuration(flight.durationMinutes))}</td>
    <td>${escapeHtml(formatClock(times.departsAt))}<div class="hotel-code">${escapeHtml(
      formatClock(times.arrivesAt)
    )}</div></td>
  </tr>
  <tr class="detail-row${open ? " open" : ""}"${open ? "" : " hidden"}>
    <td colspan="${colSpan}">
      <div class="detail-panel">
        <dl class="detail-grid">${details}</dl>
        ${open ? flightSegmentsHtml(flight) : ""}
        <div class="detail-actions">
          ${open ? flightBookingLinksHtml(flight) : ""}
          ${open ? loading : ""}
        </div>
      </div>
    </td>
  </tr>`;
}

/** Search-page outbound table header (filters present, even if inactive off Search). */
function flightOutboundTheadHtml({ hideSelect = false } = {}) {
  return `<thead>
    <tr>
      ${hideSelect ? "" : `<th class="select-col-th">Select</th>`}
      <th class="col-filter-th">
        <div class="col-filter">
          <button type="button" class="col-filter-trigger" aria-expanded="false" aria-haspopup="true" disabled>
            <span class="col-filter-label">Date</span>
          </button>
          <button type="button" class="sort-btn col-sort-btn" disabled aria-label="Sort by date"></button>
        </div>
      </th>
      <th><button type="button" class="sort-btn" disabled>Route</button></th>
      <th class="col-filter-th">
        <div class="col-filter">
          <button type="button" class="col-filter-trigger" aria-expanded="false" aria-haspopup="true" disabled>
            <span class="col-filter-label">Program</span>
          </button>
          <button type="button" class="sort-btn col-sort-btn" disabled aria-label="Sort by program"></button>
        </div>
      </th>
      <th><button type="button" class="sort-btn" disabled>Points</button></th>
      <th><button type="button" class="sort-btn" disabled>Cabin</button></th>
      <th><button type="button" class="sort-btn" disabled>Stops</button></th>
      <th><button type="button" class="sort-btn" disabled>Duration</button></th>
      <th><button type="button" class="sort-btn" disabled>Times</button></th>
    </tr>
  </thead>`;
}

/** Search-page return table header (same Date/Program filters as outbound). */
function flightReturnTheadHtml({ hideSelect = false } = {}) {
  return flightOutboundTheadHtml({ hideSelect });
}

/**
 * Render one outbound/return leg using the same table chrome + row markup as Search.
 */
export function renderFlightLegSectionHtml(
  leg,
  flight,
  {
    selected = true,
    asCached = false,
    cachedAt = null,
    hideSelect = false,
    cacheReadOnly = null,
  } = {}
) {
  const direction = leg === "return" ? "return" : "outbound";
  const title = direction === "return" ? "Return" : "Outbound";
  const thead =
    direction === "return"
      ? flightReturnTheadHtml({ hideSelect })
      : flightOutboundTheadHtml({ hideSelect });
  const colSpan = hideSelect ? 8 : 9;
  let body;
  if (!flight) {
    body = `<tr class="empty"><td colspan="${colSpan}">${title} not saved.</td></tr>`;
  } else {
    const normalized = {
      ...flight,
      direction: flight.direction || direction,
      id: flight.id || `${direction}_${flight.date || "x"}_${flight.origin || ""}_${flight.destination || ""}`,
      fromCache: asCached ? true : Boolean(flight.fromCache),
      fetchedAt: flight.fetchedAt || cachedAt || (asCached ? Date.now() : null),
    };
    body = flightRowHtml(normalized, {
      forceSelected: hideSelect ? false : selected,
      selectDisabled: true,
      cacheReadOnly: cacheReadOnly == null ? asCached : Boolean(cacheReadOnly),
      hideSelect,
    });
  }
  return `<div class="flight-leg-section" data-flight-leg="${direction}">
    <div class="flight-leg-header">
      <div class="flight-results-title">${title}</div>
    </div>
    <div class="table-scroll">
      <table class="results">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>
  </div>`;
}

const tripDetailPromises = new Map();

function flightNeedsTripHydration(flight) {
  if (!flight) return false;
  const times = flightClockTimes(flight);
  const hasLinks =
    (flight.bookingLinks && flight.bookingLinks.length) ||
    (flight.availabilityId && state.tripDetails.get(flight.availabilityId)?.bookingLinks?.length);
  return !(
    hasLinks &&
    flight.aircraft?.length &&
    flight.segments?.length &&
    times.departsAt &&
    times.arrivesAt
  );
}

/**
 * Load segment / aircraft / booking-link details for a flight (same path as row expand on Search).
 * @returns {Promise<object|null>} hydrated flight from state.all when possible
 */
export async function ensureTripDetails(flight) {
  const availabilityId = flight?.availabilityId;
  if (!flight) return null;
  if (!availabilityId) return resolveFlightFromState(flight) || flight;

  const live = resolveFlightFromState(flight) || flight;
  if (!flightNeedsTripHydration(live)) {
    if (!state.tripDetails.has(availabilityId) && live.bookingLinks?.length) {
      state.tripDetails.set(availabilityId, { bookingLinks: live.bookingLinks });
    }
    return resolveFlightFromState(live) || live;
  }

  if (tripDetailPromises.has(availabilityId)) {
    await tripDetailPromises.get(availabilityId);
    return resolveFlightFromState(flight) || flight;
  }

  const run = (async () => {
    state.tripDetailsLoading.add(availabilityId);
    refreshFlightTable();
    try {
      const res = await sendMessage({ type: "SEATS_GET_TRIPS", availabilityId });
      if (res?.ok) {
        state.tripDetails.set(availabilityId, {
          bookingLinks: res.bookingLinks || [],
        });
        mergeTripDetailsIntoFlights(availabilityId, res.trips || []);
      } else if (!state.tripDetails.has(availabilityId)) {
        state.tripDetails.set(availabilityId, { bookingLinks: [] });
      }
    } catch {
      if (!state.tripDetails.has(availabilityId)) {
        state.tripDetails.set(availabilityId, { bookingLinks: [] });
      }
    } finally {
      state.tripDetailsLoading.delete(availabilityId);
      fillFilterPanels();
      refreshFlightTable();
    }
  })();

  tripDetailPromises.set(availabilityId, run);
  try {
    await run;
  } finally {
    tripDetailPromises.delete(availabilityId);
  }
  return resolveFlightFromState(flight) || flight;
}

/** Full flight payload for saving (includes booking links held only in tripDetails). */
export function prepareFlightForSave(flight) {
  const live = resolveFlightFromState(flight) || flight;
  if (!live) return null;
  const fromDetails = state.tripDetails.get(live.availabilityId)?.bookingLinks || [];
  const seen = new Set();
  const bookingLinks = [];
  for (const link of [...(live.bookingLinks || []), ...fromDetails]) {
    if (!link?.link || seen.has(link.link)) continue;
    seen.add(link.link);
    bookingLinks.push({ ...link });
  }
  return {
    ...live,
    fromCache: true,
    fetchedAt: live.fetchedAt || Date.now(),
    bookingLinks,
    segments: Array.isArray(live.segments) ? live.segments.map((s) => ({ ...s })) : [],
    aircraft: Array.isArray(live.aircraft) ? [...live.aircraft] : [],
    carriers: Array.isArray(live.carriers) ? [...live.carriers] : [],
    fareClasses: Array.isArray(live.fareClasses) ? [...live.fareClasses] : [],
    flightNumbers: Array.isArray(live.flightNumbers) ? [...live.flightNumbers] : [],
    connections: Array.isArray(live.connections) ? [...live.connections] : [],
  };
}

function mergeTripDetailsIntoFlights(availabilityId, trips) {
  if (!availabilityId || !Array.isArray(trips) || !trips.length) return;
  const byId = new Map(trips.map((t) => [String(t.id), t]));
  state.all = state.all.map((flight) => {
    if (String(flight.availabilityId) !== String(availabilityId)) return flight;
    const rawId = String(flight.id || "").replace(/^(outbound|return):/, "");
    const trip =
      byId.get(rawId) ||
      byId.get(String(flight.id)) ||
      trips.find(
        (t) =>
          String(t.cabin || "").toUpperCase() === String(flight.cabin || "").toUpperCase() &&
          (!flight.departsAt || String(t.departsAt || "") === String(flight.departsAt || ""))
      ) ||
      (trips.length === 1 ? trips[0] : null);
    if (!trip) return flight;
    const needsAircraft = !(flight.aircraft && flight.aircraft.length);
    const needsSegments = !(flight.segments && flight.segments.length);
    const needsTimes = !flight.departsAt || !flight.arrivesAt;
    const needsFlights = !(flight.flightNumbers && flight.flightNumbers.length);
    if (!needsAircraft && !needsSegments && !needsTimes && !needsFlights) return flight;
    return {
      ...flight,
      aircraft: needsAircraft && trip.aircraft?.length ? trip.aircraft : flight.aircraft,
      segments: needsSegments && trip.segments?.length ? trip.segments : flight.segments,
      departsAt: needsTimes && trip.departsAt ? trip.departsAt : flight.departsAt,
      arrivesAt: needsTimes && trip.arrivesAt ? trip.arrivesAt : flight.arrivesAt,
      departHour:
        needsTimes && trip.departHour != null ? trip.departHour : flight.departHour ?? trip.departHour ?? null,
      arriveHour:
        needsTimes && trip.arriveHour != null ? trip.arriveHour : flight.arriveHour ?? trip.arriveHour ?? null,
      flightNumbers:
        needsFlights && trip.flightNumbers?.length ? trip.flightNumbers : flight.flightNumbers,
      carriers: flight.carriers?.length ? flight.carriers : trip.carriers || flight.carriers,
      fareClasses: flight.fareClasses?.length ? flight.fareClasses : trip.fareClasses || [],
      connections: flight.connections?.length ? flight.connections : trip.connections || [],
      durationMinutes: flight.durationMinutes ?? trip.durationMinutes ?? null,
      stops: flight.stops ?? trip.stops ?? null,
      taxes: flight.taxes ?? trip.taxes ?? null,
      taxesCurrency: flight.taxesCurrency || trip.taxesCurrency || null,
      remainingSeats: flight.remainingSeats ?? trip.remainingSeats ?? null,
      bookingLinks: flight.bookingLinks?.length ? flight.bookingLinks : trip.bookingLinks || [],
    };
  });
}

/** Merge saved itinerary flights into the in-memory table so expand/details work off Search. */
export function seedFlightsForSavedView(flights) {
  const incoming = (Array.isArray(flights) ? flights : []).filter((f) => f && f.id);
  if (!incoming.length) return;
  const byId = new Map(state.all.map((f) => [String(f.id), f]));
  for (const flight of incoming) {
    const id = String(flight.id);
    const existing = byId.get(id);
    if (!existing) {
      state.all.push(flight);
      byId.set(id, flight);
      continue;
    }
    // Prefer already-hydrated live row; fill any missing snapshot fields.
    byId.set(id, {
      ...flight,
      ...existing,
      segments: existing.segments?.length ? existing.segments : flight.segments,
      aircraft: existing.aircraft?.length ? existing.aircraft : flight.aircraft,
      bookingLinks: existing.bookingLinks?.length ? existing.bookingLinks : flight.bookingLinks,
    });
  }
  state.all = [...byId.values()];
  for (const flight of state.all) {
    if (
      flight?.availabilityId &&
      flight.bookingLinks?.length &&
      !state.tripDetails.has(flight.availabilityId)
    ) {
      state.tripDetails.set(flight.availabilityId, { bookingLinks: flight.bookingLinks });
    }
  }
}

export function resolveFlightFromState(flight) {
  if (!flight?.id) return flight || null;
  return state.all.find((f) => String(f.id) === String(flight.id)) || flight;
}

export function toggleFlightExpanded(id) {
  if (!id) return;
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    refreshFlightTable();
    return;
  }
  state.expanded.add(id);
  refreshFlightTable();
  const flight = state.all.find((f) => String(f.id) === String(id));
  if (flight) ensureTripDetails(flight);
}

let flightTableRefreshHook = null;
export function setFlightTableRefreshHook(fn) {
  flightTableRefreshHook = typeof fn === "function" ? fn : null;
}

export function refreshFlightTable() {
  recomputeRows();
  if (pruneFlightColFilters()) recomputeRows();
  updateFilterTriggerBadges();
  updateFlightColFilterUi();
  updateSortHeaders();
  updatePager();
  updateLabel();

  const exportBtn = $("flightExportBtn");
  if (exportBtn) exportBtn.disabled = !state.rows.length;

  const pair = pairDateConstraint();
  renderLegBody(
    "flightOutboundBody",
    state.rowsOutbound,
    state.pageOutbound,
    "Outbound award flights will appear here.",
    state.filters.outboundDates.size || pair.outboundDates?.size
      ? "No outbound flights match the current date filter."
      : null
  );
  renderLegBody(
    "flightReturnBody",
    state.rowsReturn,
    state.pageReturn,
    "Return award flights will appear here.",
    state.filters.returnDates.size || pair.returnDates?.size
      ? "No return flights match the current date filter."
      : null
  );
  try {
    flightTableRefreshHook?.();
  } catch {
    /* saved-page refresh hooks should not break search */
  }
}

export function clearFlightResults() {
  state.all = [];
  state.rows = [];
  state.rowsOutbound = [];
  state.rowsReturn = [];
  state.filters = emptyFilters();
  state.pageOutbound = 0;
  state.pageReturn = 0;
  state.sortKey = "mileageCost";
  state.sortDir = "asc";
  state.meta = {};
  state.expanded = new Set();
  state.tripDetails = new Map();
  state.tripDetailsLoading = new Set();
  state.refreshingLegs = new Set();
  state.selectedOutboundId = null;
  state.selectedReturnId = null;
  state.bestComboOutboundId = null;
  state.bestComboReturnId = null;
  state.selectedStay = null;
  closeAllFlightOverlays();
  fillFilterPanels();
  refreshFlightTable();
  notifyTripSelectionChange();
}

export function setBestComboFlightIds({ outboundId = null, returnId = null } = {}) {
  state.bestComboOutboundId = outboundId != null ? String(outboundId) : null;
  state.bestComboReturnId = returnId != null ? String(returnId) : null;
}

export function getBestComboFlightIds() {
  return {
    outboundId: state.bestComboOutboundId,
    returnId: state.bestComboReturnId,
  };
}

export function clearBestComboFlightIds() {
  state.bestComboOutboundId = null;
  state.bestComboReturnId = null;
}

/** Force-set trip flight selection (does not toggle). */
export function setTripFlightSelection({
  outboundId = null,
  returnId = null,
  silent = false,
} = {}) {
  state.selectedOutboundId = outboundId != null ? String(outboundId) : null;
  state.selectedReturnId = returnId != null ? String(returnId) : null;
  syncDateFiltersFromSelection();
  if (!silent) {
    refreshFlightTable();
    notifyTripSelectionChange();
  }
}

export function setFlightResults(flights, meta = {}) {
  state.all = Array.isArray(flights) ? flights : [];
  state.meta = meta || {};
  state.filters = emptyFilters();
  state.pageOutbound = 0;
  state.pageReturn = 0;
  state.sortKey = "mileageCost";
  state.sortDir = "asc";
  state.expanded = new Set();
  state.tripDetails = new Map();
  state.tripDetailsLoading = new Set();
  state.refreshingLegs = new Set();
  state.selectedOutboundId = null;
  state.selectedReturnId = null;
  state.bestComboOutboundId = null;
  state.bestComboReturnId = null;
  state.selectedStay = null;
  // Visibility is owned by the search page (syncFlightHotelResultsLayout) so hotel mode
  // never flashes the award-travel table.
  fillFilterPanels();
  refreshFlightTable();
  notifyTripSelectionChange();
}

export function getFlightResults() {
  return { all: state.all, filtered: state.rows, meta: state.meta };
}

export function setupFlightResultsUi() {
  const wrap = $("flightResults");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";

  wrap.addEventListener("click", (e) => {
    const flightSelect = e.target.closest("[data-flight-select]");
    if (flightSelect?.dataset.flightSelect) {
      e.preventDefault();
      e.stopPropagation();
      selectFlightForTrip(flightSelect.dataset.flightSelect, flightSelect.dataset.flightSelectLeg);
      return;
    }
    const cacheRefresh = e.target.closest("[data-flight-cache-refresh]");
    if (cacheRefresh?.dataset.flightCacheRefresh) {
      e.preventDefault();
      e.stopPropagation();
      refreshCachedFlightLeg(cacheRefresh.dataset.flightCacheRefresh);
      return;
    }
    const resetAll = e.target.closest("[data-flight-filter-reset-all]");
    if (resetAll) {
      e.preventDefault();
      resetAllFlightFilters();
      return;
    }
    const colReset = e.target.closest("[data-flight-col-filter-reset]");
    if (colReset?.dataset.flightColFilterReset) {
      e.preventDefault();
      e.stopPropagation();
      resetFilter(colReset.dataset.flightColFilterReset);
      return;
    }
    const colTrigger = e.target.closest("[data-flight-col-filter]");
    if (colTrigger?.dataset.flightColFilter) {
      e.preventDefault();
      e.stopPropagation();
      if (colTrigger.disabled) return;
      const id = colTrigger.dataset.flightColFilter;
      const panel = colTrigger
        .closest(".col-filter")
        ?.querySelector(`[data-flight-col-filter-panel="${id}"]`);
      setFlightColFilterOpen(id, Boolean(panel?.hidden), colTrigger);
      return;
    }
    const reset = e.target.closest("[data-flight-filter-reset]");
    if (reset?.dataset.flightFilterReset) {
      e.preventDefault();
      resetFilter(reset.dataset.flightFilterReset);
      return;
    }
    const trigger = e.target.closest("[data-flight-filter]");
    if (trigger?.dataset.flightFilter) {
      e.preventDefault();
      openFlightFilter(trigger.dataset.flightFilter);
      return;
    }
    const sortBtn = e.target.closest("[data-flight-sort]");
    if (sortBtn?.dataset.flightSort) {
      e.preventDefault();
      const key = sortBtn.dataset.flightSort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = key === "mileageCost" || key === "durationMinutes" ? "asc" : "asc";
      }
      refreshFlightTable();
      return;
    }
    const pageBtn = e.target.closest("[data-flight-page]");
    if (pageBtn?.dataset.flightPage) {
      e.preventDefault();
      const action = pageBtn.dataset.flightPage;
      if (action === "outbound-prev") {
        if (state.pageOutbound <= 0) return;
        state.pageOutbound -= 1;
      } else if (action === "outbound-next") {
        const totalPages = Math.max(1, Math.ceil(state.rowsOutbound.length / state.pageSize) || 1);
        if (state.pageOutbound >= totalPages - 1) return;
        state.pageOutbound += 1;
      } else if (action === "return-prev") {
        if (state.pageReturn <= 0) return;
        state.pageReturn -= 1;
      } else if (action === "return-next") {
        const totalPages = Math.max(1, Math.ceil(state.rowsReturn.length / state.pageSize) || 1);
        if (state.pageReturn >= totalPages - 1) return;
        state.pageReturn += 1;
      }
      refreshFlightTable();
      return;
    }
    if (e.target.closest("a, button, input, label, .col-filter")) return;
    const row = e.target.closest("tr.flight-row[data-flight-id]");
    if (row?.dataset.flightId) {
      toggleFlightExpanded(row.dataset.flightId);
    }
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("a, button, input")) return;
    const row = e.target.closest("tr.flight-row[data-flight-id]");
    if (!row?.dataset.flightId) return;
    e.preventDefault();
    toggleFlightExpanded(row.dataset.flightId);
  });

  for (const def of FLIGHT_COL_FILTERS) {
    document.querySelectorAll(`[data-flight-col-filter-panel="${def.id}"]`).forEach((panel) => {
      const list = panel.querySelector(`[data-flight-col-filter-list="${def.id}"]`);
      if (!list) return;
      panel.addEventListener("click", (e) => e.stopPropagation());
      list.addEventListener("mousedown", (e) => {
        if (e.target.closest("label")) e.preventDefault();
      });
      list.addEventListener("click", (e) => {
        const label = e.target.closest("label");
        if (!label || !list.contains(label)) return;
        e.preventDefault();
        e.stopPropagation();
        const input = label.querySelector('input[type="checkbox"]');
        if (!input) return;
        input.checked = !input.checked;
        syncFlightColFilterFromDom(def.id, list);
      });
    });
  }

  // Filter panels are portaled to document.body — listen on document, not #flightResults.
  document.addEventListener("change", (e) => {
    const panel = e.target.closest("[data-flight-filter-panel]");
    if (!panel) return;
    const id = panel.dataset.flightFilterPanel;
    if (!id) return;
    applyFilterPanel(id);
  });

  document.addEventListener("input", (e) => {
    if (
      !e.target.matches(
        "#flightFilterPointsMax, #flightFilterDurationMax, #flightFilterDepartFrom, #flightFilterDepartTo, #flightFilterArriveFrom, #flightFilterArriveTo"
      )
    ) {
      return;
    }
    const panel = e.target.closest("[data-flight-filter-panel]");
    const id = panel?.dataset.flightFilterPanel;
    if (!id) return;
    applyFilterPanel(id);
  });

  $("flightPageSize")?.addEventListener("change", () => {
    const next = Number($("flightPageSize").value) || 25;
    state.pageSize = [25, 50, 75, 100].includes(next) ? next : 25;
    state.pageOutbound = 0;
    state.pageReturn = 0;
    refreshFlightTable();
  });

  $("flightOutboundPageJump")?.addEventListener("change", () => {
    const totalPages = Math.max(1, Math.ceil(state.rowsOutbound.length / state.pageSize) || 1);
    const next = Math.max(1, Math.min(totalPages, Number($("flightOutboundPageJump").value) || 1));
    state.pageOutbound = next - 1;
    refreshFlightTable();
  });
  $("flightReturnPageJump")?.addEventListener("change", () => {
    const totalPages = Math.max(1, Math.ceil(state.rowsReturn.length / state.pageSize) || 1);
    const next = Math.max(1, Math.min(totalPages, Number($("flightReturnPageJump").value) || 1));
    state.pageReturn = next - 1;
    refreshFlightTable();
  });
  $("flightExportBtn")?.addEventListener("click", exportFlightCsv);

  document.addEventListener("click", (e) => {
    const filterReset = e.target.closest("[data-flight-filter-reset]");
    if (
      filterReset?.dataset.flightFilterReset &&
      filterReset.closest("[data-flight-filter-panel]")
    ) {
      e.preventDefault();
      resetFilter(filterReset.dataset.flightFilterReset);
      return;
    }
    if (
      state.openFilter &&
      !e.target.closest("#flightResults .flight-filter") &&
      !e.target.closest("[data-flight-filter-panel]")
    ) {
      closeFlightFilterPanels();
    }
    if (
      state.openColFilter &&
      !e.target.closest("#flightResults .col-filter") &&
      !e.target.closest("[data-flight-col-filter-panel]")
    ) {
      closeFlightColFilterPanels();
    }
  });
  window.addEventListener("resize", () => {
    repositionOpenFlightOverlays();
  });
  window.addEventListener("scroll", repositionOpenFlightOverlays, true);
  document.addEventListener("goplus:close-overlays", closeAllFlightOverlays);
}

function exportFlightCsv() {
  if (!state.rows.length) return;
  const headers = [
    "date",
    "origin",
    "destination",
    "program",
    "source",
    "alliance",
    "direction",
    "mileageCost",
    "cabin",
    "stops",
    "durationMinutes",
    "departsAt",
    "arrivesAt",
    "flightNumbers",
    "aircraft",
    "fareClasses",
    "connections",
  ];
  const lines = [headers.join(",")];
  for (const row of state.rows) {
    lines.push(
      headers
        .map((key) => {
          let val = row[key];
          if (key === "program") val = formatProgramName(row.source || row.program);
          if (Array.isArray(val)) val = val.join("|");
          const s = String(val ?? "");
          return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        })
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `goplus-flights-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
