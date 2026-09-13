import {
  setupDateRangesField,
  getDateRanges,
  setDateRanges,
  setDateRangesHints,
  setDateRangesPlaceholder,
  formatRangeLabel,
  nightsBetween,
} from "./calendar.js";
import {
  setupFlightResultsUi,
  setFlightResults,
  clearFlightResults,
  setTripSelectionListener,
  getSelectedTripFlights,
  clearTripFlightSelection,
  taxAmountDollars,
  formatPointsWithTaxes,
  formatMiles as formatAwardMiles,
  formatProgramName,
  getFlightResults,
  ensureTripDetails,
  prepareFlightForSave,
  clearSelectedReturnFlight,
  getTripPairStayConstraint,
  setSelectedStayConstraint,
  refreshFlightTable,
  setBestComboFlightIds,
  clearBestComboFlightIds,
  getBestComboFlightIds,
  setTripFlightSelection,
} from "./flights.js";
import {
  searchAirports,
  extractIataCode,
  countryLabel,
} from "./airports.js";
import {
  buildItinerary,
  itineraryFingerprint,
  loadSavedItineraries,
  toggleSavedItinerary,
} from "./saved-itineraries.js";

const $ = (id) => document.getElementById(id);

const DAY_NAMES = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

const state = {
  allRows: [],
  rows: [],
  scanning: false,
  stopRequested: false,
  selectedSuggestion: null,
  suggestItems: [],
  suggestIndex: -1,
  suggestTimer: null,
  suggestReq: 0,
  sortKey: "amount",
  sortDir: "asc",
  roomSortKey: "amount",
  roomSortDir: "asc",
  dowSelected: new Set(),
  columnFilters: {
    arrivalDate: new Set(),
    hotelName: new Set(),
    brandCode: new Set(),
    city: new Set(),
    specialRateType: new Set(),
  },
  openColumnFilter: null,
  expanded: new Set(),
  roomDetails: new Map(),
  recentSearches: [],
  savedItineraries: [],
  roomGroupsOpen: new Set(),
  roomsSectionOpen: new Set(),
  roomDescOpen: new Set(),
  scanErrors: [],
  awaitingReauth: false,
  userName: null,
  pageSize: 25,
  focusCtyhocn: null,
  focusHotelName: null,
  page: 0,
  roomFetchPending: [],
  roomFetchInFlight: 0,
  refreshingKeys: new Set(),
  selectedHotelKey: null,
  /** Cheapest outbound/return/hotel combo hotel row key (search suggestion). */
  bestComboHotelKey: null,
  /** Hotels in the active destination scan — used for status “Found N hotels”. */
  scanHotels: [],
  /** Monotonic SCAN_PROGRESS cursor — ignore out-of-order snapshots. */
  scanProgressDone: 0,
};

const RECENT_SEARCHES_KEY = "recentSearches";
const ROOM_DETAILS_KEY = "roomDetailsCache";
const MAX_RECENT_SEARCHES = 8;
const MAX_ROOM_DETAILS = 80;
const ROOM_FETCH_CONCURRENCY = 1;
const ROOM_FETCH_DELAY_MS = 750;
const SCAN_DELAY_MS = 1500;
const METRICS_SESSION_ID =
  globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local calendar date as YYYY-MM-DD (avoid UTC shifts from toISOString). */
function formatLocalISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayISO() {
  return formatLocalISO(new Date());
}

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return formatLocalISO(d);
}

function parseRangesParam(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((part) => {
      const bits = part.split("_");
      if (bits.length < 2) return null;
      const from = bits[0];
      const to = bits[1];
      if (!from || !to) return null;
      // Wide range: from_to_wN  (arrival window + nights)
      if (bits.length >= 3 && /^w\d+$/i.test(bits[2])) {
        const nights = Math.max(1, Math.min(7, Number(bits[2].slice(1)) || 1));
        return { from, to, nights, mode: "window" };
      }
      return { from, to, mode: "exact" };
    })
    .filter(Boolean);
}

function encodeRangesParam(ranges) {
  return (ranges || [])
    .map((r) => {
      if (!r?.from || !r?.to) return "";
      if (r.mode === "window") {
        const n = Math.max(1, Math.min(7, Number(r.nights) || 1));
        return `${r.from}_${r.to}_w${n}`;
      }
      return `${r.from}_${r.to}`;
    })
    .filter(Boolean)
    .join(",");
}

function formatRangesSummary(ranges) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (!list.length) return "any stays";
  if (list.length === 1) return formatRangeLabel(list[0]);
  const windows = list.filter((r) => r.mode === "window");
  if (windows.length === list.length) {
    const nights = [...new Set(list.map((r) => Number(r.nights) || 1))];
    if (nights.length === 1) {
      const n = nights[0];
      return `${list.length} × any ${n === 1 ? "1-night" : `${n}-night`} windows`;
    }
    return `${list.length} wide-range stays`;
  }
  const nights = [...new Set(list.map((r) => Number(r.nights) || nightsBetween(r.from, r.to)))];
  if (nights.length === 1) {
    const n = nights[0];
    return `${list.length} × ${n === 1 ? "1-night" : `${n}-night`} stays`;
  }
  return `${list.length} stays`;
}

function enrichRanges(ranges) {
  return (ranges || [])
    .map((r) => {
      const from = r.from || r.fromDate;
      const to = r.to || r.toDate;
      if (!from || !to) return null;
      if (r.mode === "window") {
        return {
          from,
          to,
          nights: Math.max(1, Math.min(7, Number(r.nights) || 1)),
          mode: "window",
        };
      }
      return { from, to, nights: nightsBetween(from, to), mode: "exact" };
    })
    .filter(Boolean);
}

function parseMinRooms(value, fallback = 1) {
  if (value === "" || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(9, Math.floor(n)));
}

function readParams() {
  const params = new URLSearchParams(location.search);
  const legacyFrom = params.get("from") || params.get("date") || "";
  const legacyTo = params.get("to") || "";
  const legacyNights = Number(params.get("nights") || 0);
  let ranges = parseRangesParam(params.get("ranges") || "");
  if (!ranges.length && legacyFrom) {
    const to =
      legacyTo ||
      (legacyNights > 0 ? addDaysISO(legacyFrom, legacyNights) : addDaysISO(legacyFrom, 1));
    ranges = [{ from: legacyFrom, to }];
  }
  return {
    searchMode: params.get("mode") === "flight" ? "flight" : "hotel",
    destination: params.get("destination") || params.get("destinations") || "",
    ranges,
    fromDate: ranges[0]?.from || legacyFrom || "",
    toDate: ranges[0]?.to || legacyTo || "",
    maxRate: params.get("max_rate") || params.get("max_fees") || "",
    minRooms: parseMinRooms(params.get("min_rooms") ?? params.get("min_seats"), 1),
    rateType: params.get("rate_type") || "fnf",
    ctyhocn: String(params.get("ctyhocn") || "").toUpperCase(),
    hotel: params.get("hotel") || "",
    flightOrigins: params.get("origins") || "",
    flightDestinations: params.get("dest_airports") || params.get("airports") || "",
    flightTripType: params.get("trip") === "oneway" ? "oneway" : "roundtrip",
    flightRanges: (() => {
      const fromTrip = parseRangesParam(params.get("trip_dates") || "");
      if (fromTrip.length) return fromTrip;
      const start = params.get("depart_from") || params.get("departure") || "";
      const end = params.get("depart_to") || params.get("return") || "";
      return start && end ? [{ from: start, to: end, mode: "exact" }] : [];
    })(),
  };
}

function writeParams(values) {
  const params = new URLSearchParams();
  const mode = values.searchMode === "flight" ? "flight" : "hotel";
  if (mode === "flight") params.set("mode", "flight");
  if (values.destination) params.set("destination", values.destination);
  const ranges = values.ranges?.length
    ? values.ranges
    : values.fromDate && values.toDate
      ? [{ from: values.fromDate, to: values.toDate }]
      : [];
  const encoded = encodeRangesParam(ranges);
  if (encoded) params.set("ranges", encoded);
  if (values.maxRate !== "" && values.maxRate != null) params.set("max_rate", String(values.maxRate));
  if (values.minRooms != null && values.minRooms !== "") params.set("min_rooms", String(values.minRooms));
  params.set("rate_type", values.rateType);
  if (values.ctyhocn) params.set("ctyhocn", String(values.ctyhocn).toUpperCase());
  if (values.hotel) params.set("hotel", String(values.hotel));
  if (mode === "flight") {
    if (values.flightOrigins) params.set("origins", values.flightOrigins);
    if (values.flightDestinations) params.set("dest_airports", values.flightDestinations);
    const tripEncoded = encodeRangesParam(values.flightRanges || []);
    if (tripEncoded) params.set("trip_dates", tripEncoded);
    // Keep legacy single-date params for the first trip (shareable links / older tools).
    if (values.flightStartDate) params.set("departure", values.flightStartDate);
    if (values.flightEndDate) params.set("return", values.flightEndDate);
    if (values.flightTripType === "oneway") params.set("trip", "oneway");
  }
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

function setStatus(text, tone = "") {
  const el = $("statusBar");
  el.textContent = text;
  el.classList.remove("warn", "bad", "ok");
  if (tone) el.classList.add(tone);
}

function setProgress(pct) {
  $("progressBar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

const REAUTH_URL = "https://www.hilton.com/en/go-hilton/";

function setSession(guestId, { unauthorized = false, userName = null } = {}) {
  const el = $("sessionStatus");
  if (!unauthorized && guestId) {
    el.className = "session ok";
    const label = userName || state.userName;
    if (userName) state.userName = userName;
    el.textContent = `Signed in · ${label || guestId}`;
    return;
  }
  state.userName = null;
  el.className = "session bad reauth";
  el.innerHTML = `<a class="session-reauth" href="${REAUTH_URL}" target="_blank" rel="noopener">Signed out • Reauthorize</a>`;
}

function scanErrorsAreUnauthorized(errors = state.scanErrors) {
  return (errors || []).some((err) => /unauthorized/i.test(String(err.message || err.error || "")));
}

function markUnauthorized(message) {
  setSession(null, { unauthorized: true });
  setStatus(
    message || "Hilton session expired. Sign in again, then return here and search.",
    "warn"
  );
  sendMessage({ type: "CLEAR_SESSION" });
}

async function refreshSession() {
  let res = await sendMessage({ type: "GET_STATUS" });
  // Only force-unlock after the user clicked Reauthorize (fresh Hilton login).
  if ((!res.signedIn || res.unauthorized) && state.awaitingReauth) {
    res = await sendMessage({ type: "RESTORE_SESSION" });
  }
  if (!res.signedIn || !res.guestId) {
    const showReauth =
      Boolean(res.unauthorized) ||
      res.reason === "token_expired" ||
      res.reason === "no_token" ||
      res.reason === "not_logged_in";
    setSession(null, { unauthorized: showReauth || !res.guestId });
    return;
  }
  setSession(res.guestId, { userName: res.userName || null });
  state.awaitingReauth = false;
}

function setupReauthHandling() {
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".session-reauth")) return;
    state.awaitingReauth = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSession();
  });
  window.addEventListener("focus", () => refreshSession());
}

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Open this page from the Chrome extension icon." });
      return;
    }
    chrome.runtime.sendMessage({ ...message, sessionId: METRICS_SESSION_ID }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

function setupMetricsSession() {
  // Open Search tab = active metrics session (Metrics page shows "current").
  // Ends only when the tab unloads — not when a scan finishes.
  sendMessage({ type: "METRICS_SESSION_START", sessionId: METRICS_SESSION_ID });
  const end = () => {
    try {
      chrome?.runtime?.sendMessage?.({
        type: "METRICS_SESSION_END",
        sessionId: METRICS_SESSION_ID,
      });
    } catch {
      /* ignore */
    }
  };
  window.addEventListener("pagehide", end);
  window.addEventListener("beforeunload", end);
}

function formValues() {
  const rateType = $("rateType")?.value === "tm" ? "tm" : "fnf";
  const ranges = enrichRanges(getDateRanges());
  const flightRanges = enrichRanges(getDateRanges("flightDateRanges"));
  const searchMode = $("searchMode")?.value === "flight" ? "flight" : "hotel";
  return {
    searchMode,
    destination: $("destination").value.trim(),
    ranges,
    fromDate: ranges[0]?.from || "",
    toDate: ranges[0]?.to || "",
    nights: ranges[0]?.nights || null,
    maxRate: $("maxRate").value === "" ? null : Number($("maxRate").value),
    minRooms: parseMinRooms($("minRooms").value, 1),
    goOnly: false,
    rateType,
    ctyhocn: state.focusCtyhocn || "",
    hotel: state.focusHotelName || "",
    flightOrigins: getIataCodes("flightOrigins").join(", "),
    flightDestinations: getIataCodes("flightDestinations").join(", "),
    flightRanges,
    flightStartDate: flightRanges[0]?.from || "",
    flightEndDate: flightRanges[0]?.to || "",
    flightTripType: $("flightTripType")?.value === "oneway" ? "oneway" : "roundtrip",
  };
}

function compareRows(a, b, key, dir) {
  const mul = dir === "desc" ? -1 : 1;
  let av = a?.[key];
  let bv = b?.[key];

  if (key === "amount" || key === "roomsAvail") {
    av = av == null || av === "" ? Number.NEGATIVE_INFINITY : Number(av);
    bv = bv == null || bv === "" ? Number.NEGATIVE_INFINITY : Number(bv);
    if (av === bv) {
      return String(a.arrivalDate || "").localeCompare(String(b.arrivalDate || "")) * mul ||
        String(a.hotelName || "").localeCompare(String(b.hotelName || ""));
    }
    return (av - bv) * mul;
  }

  av = String(av ?? "").toLowerCase();
  bv = String(bv ?? "").toLowerCase();
  if (av === bv) {
    if (key !== "arrivalDate") {
      return String(a.arrivalDate || "").localeCompare(String(b.arrivalDate || ""));
    }
    return String(a.hotelName || "").localeCompare(String(b.hotelName || ""));
  }
  return av.localeCompare(bv) * mul;
}

function sortedRows(rows) {
  return [...rows].sort((a, b) => compareRows(a, b, state.sortKey, state.sortDir));
}

function updateSortHeaders() {
  document.querySelectorAll("#resultsTable > thead .sort-btn").forEach((btn) => {
    const active = btn.dataset.sort === state.sortKey;
    btn.classList.toggle("active", active);
    btn.dataset.dir = active ? state.sortDir : "";
    btn.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
  updateRoomSortHeaders();
}

function updateRoomSortHeaders() {
  document.querySelectorAll(".room-sort-btn").forEach((btn) => {
    const active = btn.dataset.sort === state.roomSortKey;
    btn.classList.toggle("active", active);
    btn.dataset.dir = active ? state.roomSortDir : "";
    btn.setAttribute("aria-sort", active ? (state.roomSortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function setSort(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDir = "asc";
  }
  updateSortHeaders();
  refreshTable();
}

function setRoomSort(key) {
  if (state.roomSortKey === key) {
    state.roomSortDir = state.roomSortDir === "asc" ? "desc" : "asc";
  } else {
    state.roomSortKey = key;
    state.roomSortDir = "asc";
  }
  refreshTable();
}

function formatMoneyAmount(amount, currency, amountFmt = null) {
  // All shop/calendar requests ask Hilton for USD; always render as $.
  if (amount != null && amount !== "") {
    const n = Number(amount);
    if (Number.isFinite(n)) return `$${n.toFixed(0)}`;
  }
  if (amountFmt != null && String(amountFmt).trim()) {
    const raw = String(amountFmt).trim();
    const m = raw.match(/([\d,]+(?:\.\d+)?)/);
    if (m) return `$${m[1].replace(/,/g, "")}`;
  }
  void currency;
  return "—";
}

function stayNightsFor(row) {
  if (row?.arrivalDate && row?.departureDate) {
    return nightsBetween(row.arrivalDate, row.departureDate);
  }
  const fromRow = Number(row?.nights);
  if (Number.isFinite(fromRow) && fromRow > 0) return fromRow;
  const values = formValues();
  if (values.nights) return values.nights;
  return 1;
}

function formatStayEstimate(amount, currency, nights) {
  const rate = Number(amount);
  const n = Math.max(1, Number(nights) || 1);
  if (!Number.isFinite(rate)) return null;
  return formatMoneyAmount(rate * n, currency);
}

function hotelStayCashTotal(row) {
  if (!row || row.amount == null || !Number.isFinite(Number(row.amount))) return null;
  if (row.inventoryOnly && !row.stayPriced) return null;
  const nights = stayNightsFor(row);
  return Number(row.amount) * Math.max(1, Number(nights) || 1);
}

function hotelSelectButtonHtml(row, key) {
  const selected = state.selectedHotelKey === key;
  return `<button
    type="button"
    class="trip-select-btn${selected ? " is-selected" : ""}"
    data-hotel-select="${escapeHtml(key)}"
    aria-pressed="${selected ? "true" : "false"}"
  >${selected ? "Selected" : "Select"}</button>`;
}

function selectHotelForTrip(key) {
  if (!key) return;
  const nextKey = state.selectedHotelKey === key ? null : key;
  state.selectedHotelKey = nextKey;
  const hotel = nextKey
    ? state.allRows.find((r) => rowKey(r) === nextKey) ||
      state.rows.find((r) => rowKey(r) === nextKey) ||
      null
    : null;
  setSelectedStayConstraint(
    hotel
      ? {
          arrivalDate: hotel.arrivalDate,
          departureDate:
            hotel.departureDate ||
            (hotel.arrivalDate
              ? addDaysISO(hotel.arrivalDate, stayNightsFor(hotel))
              : null),
          nights: stayNightsFor(hotel),
        }
      : null
  );
  syncHotelDateFiltersFromSelection();
  if (!isHotelSearchMode() && !$("flightResults")?.hidden) {
    resolveAndHighlightBestTripCombo();
  } else {
    refreshTable();
    updateTripSummary();
  }
}

function clearTripHotelSelection({ silent = false } = {}) {
  state.selectedHotelKey = null;
  setSelectedStayConstraint(null, { silent });
  syncHotelDateFiltersFromSelection();
  if (!silent) {
    if (!isHotelSearchMode() && !$("flightResults")?.hidden) {
      resolveAndHighlightBestTripCombo();
    } else {
      refreshTable();
      updateTripSummary();
    }
  }
}

function clearTripSelection() {
  clearTripHotelSelection({ silent: true });
  clearTripFlightSelection({ silent: true });
  syncHotelDateFiltersFromSelection();
  if (!isHotelSearchMode() && !$("flightResults")?.hidden) {
    resolveAndHighlightBestTripCombo();
  } else {
    refreshFlightTable();
    refreshTable();
    updateTripSummary();
  }
}

function formatTripCash(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return formatMoneyAmount(Number(amount), "USD");
}

function currentTripSelection() {
  const { outbound, return: ret } = getSelectedTripFlights();
  const hotel =
    state.selectedHotelKey
      ? state.allRows.find((r) => rowKey(r) === state.selectedHotelKey) ||
        state.rows.find((r) => rowKey(r) === state.selectedHotelKey) ||
        null
      : null;
  return { outbound, return: ret, hotel };
}

function isHotelSearchMode(values = null) {
  return (values || formValues()).searchMode !== "flight";
}

function isFlightRoundTrip(values = null) {
  const tripType = (values || formValues()).flightTripType;
  return tripType !== "oneway";
}

function currentItineraryDraft() {
  const { outbound, return: ret, hotel } = currentTripSelection();
  const values = formValues();
  const hotelMode = isHotelSearchMode(values);
  if (!hotel) return null;
  if (!hotelMode) {
    const roundTrip = isFlightRoundTrip(values);
    if (!outbound) return null;
    if (roundTrip && !ret) return null;
  }

  let points = 0;
  let cash = 0;
  const flights = hotelMode
    ? []
    : isFlightRoundTrip(values)
      ? [outbound, ret]
      : [outbound];
  for (const flight of flights) {
    if (!flight) continue;
    const miles = Number(flight.mileageCost);
    if (Number.isFinite(miles)) points += miles;
    const tax = taxAmountDollars(flight);
    if (tax != null) cash += tax;
  }
  const nights = stayNightsFor(hotel);
  const stayCash = hotelStayCashTotal(hotel);
  if (stayCash != null) cash += stayCash;
  const searchMeta = getFlightResults()?.meta?.search || null;
  return buildItinerary({
    outbound: hotelMode ? null : prepareFlightForSave(outbound) || outbound,
    return: hotelMode || !isFlightRoundTrip(values) ? null : prepareFlightForSave(ret) || ret,
    hotel: prepareHotelForSave(hotel) || hotel,
    nights,
    points,
    cash,
    search: hotelMode
      ? {
          destinations: values.destination || null,
          tripType: "hotel",
        }
      : searchMeta || {
          flightOrigins: values.flightOrigins,
          flightDestinations: values.flightDestinations,
          flightStartDate: values.flightStartDate,
          flightEndDate: values.flightEndDate,
          flightTripType: values.flightTripType,
        },
  });
}

function findSavedForDraft(draft) {
  if (!draft) return null;
  const fp = draft.fingerprint || itineraryFingerprint(draft);
  return (
    state.savedItineraries.find((e) => (e.fingerprint || itineraryFingerprint(e)) === fp) || null
  );
}

function updateTripSaveButton(draft) {
  const btn = $("tripSummarySave");
  if (!btn) return;
  const complete = Boolean(draft);
  btn.hidden = !complete;
  btn.disabled = !complete;
  const existing = findSavedForDraft(draft);
  const saved = Boolean(existing);
  btn.classList.toggle("is-saved", saved);
  btn.setAttribute("aria-pressed", saved ? "true" : "false");
  btn.setAttribute("aria-label", saved ? "Remove saved itinerary" : "Save itinerary");
  btn.title = saved ? "Saved — click to remove" : "Save itinerary";
}

function updateTripSummary() {
  const bar = $("tripSummary");
  const totalEl = $("tripSummaryTotal");
  const linesEl = $("tripSummaryLines");
  const clearBtn = $("tripSummaryClear");
  if (!bar || !totalEl || !linesEl) return;

  const hotelMode = isHotelSearchMode();
  const flightMode = !$("flightResults")?.hidden;
  const { outbound, return: ret, hotel } = currentTripSelection();

  const hasAny = Boolean(outbound || ret || hotel);
  bar.hidden = !(flightMode || hasAny);
  if (clearBtn) clearBtn.hidden = !hasAny;
  if (!(flightMode || hasAny)) {
    updateTripSaveButton(null);
    return;
  }

  const lines = [];
  let points = 0;
  let cash = 0;
  let hasPoints = false;
  let hasCash = false;

  const pushFlight = (label, flight) => {
    if (!flight) {
      lines.push(
        `<div class="trip-summary-line is-missing"><span>${label}</span><span>Not selected</span><span class="trip-summary-price">—</span></div>`
      );
      return;
    }
    const miles = Number(flight.mileageCost);
    const tax = taxAmountDollars(flight);
    if (Number.isFinite(miles)) {
      points += miles;
      hasPoints = true;
    }
    if (tax != null) {
      cash += tax;
      hasCash = true;
    }
    const route = `${flight.origin || "?"} → ${flight.destination || "?"}`;
    const program = formatProgramName(flight.source || flight.program) || "Flight";
    lines.push(
      `<div class="trip-summary-line"><span>${label}</span><span><strong>${escapeHtml(
        String(program)
      )}</strong> · ${escapeHtml(route)}</span><span class="trip-summary-price">${escapeHtml(
        formatPointsWithTaxes(flight)
      )}</span></div>`
    );
  };

  if (!hotelMode) {
    pushFlight("Outbound", outbound);
    if (isFlightRoundTrip()) pushFlight("Return", ret);
  }

  if (!hotel) {
    lines.push(
      `<div class="trip-summary-line is-missing"><span>Hotel</span><span>Not selected</span><span class="trip-summary-price">—</span></div>`
    );
  } else {
    const nights = stayNightsFor(hotel);
    const stayCash = hotelStayCashTotal(hotel);
    const estLabel = formatStayEstimate(hotel.amount, hotel.currency, nights);
    if (stayCash != null) {
      cash += stayCash;
      hasCash = true;
    }
    lines.push(
      `<div class="trip-summary-line"><span>Hotel</span><span><strong>${escapeHtml(
        hotel.hotelName || hotel.ctyhocn || "Hotel"
      )}</strong> · ${escapeHtml(String(nights))} night${nights === 1 ? "" : "s"}</span><span class="trip-summary-price">${escapeHtml(
        estLabel ? `est. ${estLabel}` : "—"
      )}</span></div>`
    );
  }

  linesEl.innerHTML = lines.join("");

  const roundTrip = isFlightRoundTrip();
  const complete = hotelMode
    ? Boolean(hotel)
    : Boolean(outbound && hotel && (!roundTrip || ret));
  const parts = [];
  if (hasPoints) parts.push(`${formatAwardMiles(points)} pts`);
  if (hasCash) parts.push(formatTripCash(cash));
  if (complete && parts.length) {
    totalEl.textContent = parts.join(" + ");
  } else if (parts.length) {
    totalEl.textContent = hotelMode
      ? `${parts.join(" + ")} · pick a hotel`
      : roundTrip
        ? `${parts.join(" + ")} · pick outbound, return, and a hotel`
        : `${parts.join(" + ")} · pick outbound and a hotel`;
  } else {
    totalEl.textContent = hotelMode
      ? "Select a hotel"
      : roundTrip
        ? "Select outbound, return, and a hotel"
        : "Select outbound and a hotel";
  }

  updateTripSaveButton(currentItineraryDraft());
}

async function toggleSaveCurrentItinerary() {
  const selection = currentTripSelection();
  const hotelMode = isHotelSearchMode();
  const roundTrip = isFlightRoundTrip();
  if (!selection.hotel) return;
  if (!hotelMode) {
    if (!selection.outbound) return;
    if (roundTrip && !selection.return) return;
  }

  // Removing an already-saved trip does not need hydration.
  const preview = currentItineraryDraft();
  if (preview && findSavedForDraft(preview)) {
    const result = await toggleSavedItinerary(preview);
    state.savedItineraries = result.list;
    updateTripSaveButton(currentItineraryDraft());
    return;
  }

  // Pull full Search-page detail before saving (flights + hotel rooms/compare).
  const detailJobs = [ensureHotelRoomsForSave(selection.hotel)];
  if (!hotelMode) {
    detailJobs.push(ensureTripDetails(selection.outbound));
    if (roundTrip && selection.return) detailJobs.push(ensureTripDetails(selection.return));
  }
  await Promise.all(detailJobs);
  const draft = currentItineraryDraft();
  if (!draft) return;
  const result = await toggleSavedItinerary(draft);
  state.savedItineraries = result.list;
  updateTripSaveButton(currentItineraryDraft());
}

function hotelBookUrlForSave(hotel) {
  if (hotel?.bookUrl) return hotel.bookUrl;
  if (!hotel?.ctyhocn) return null;
  const url = new URL("https://www.hilton.com/en/book/reservation/rooms/");
  url.searchParams.set("ctyhocn", hotel.ctyhocn);
  if (hotel.arrivalDate) url.searchParams.set("arrivalDate", hotel.arrivalDate);
  if (hotel.departureDate) url.searchParams.set("departureDate", hotel.departureDate);
  url.searchParams.set("room1NumAdults", "1");
  return url.toString();
}

function prepareHotelForSave(hotel) {
  if (!hotel) return null;
  const nights = stayNightsFor(hotel);
  const detailKey = roomDetailKey(hotel);
  const detail = state.roomDetails.get(detailKey);
  let compareRate = null;
  if (!hotel.inventoryOnly && isFamilyAndFriendsRate(hotel) && detail?.rooms?.length) {
    const sameType = hotel.roomTypeCode
      ? detail.rooms.filter(
          (r) =>
            String(r.roomTypeCode || "").toUpperCase() ===
            String(hotel.roomTypeCode || "").toUpperCase()
        )
      : [];
    const compare = findNextHigherDifferentPlan(
      hotel,
      sameType.length ? sameType : detail.rooms
    );
    if (compare) {
      compareRate = {
        amount: compare.amount ?? null,
        amountFmt: compare.amountFmt || null,
        currency: compare.currency || hotel.currency || null,
        ratePlanName: compare.ratePlanName || null,
        ratePlanCode: compare.ratePlanCode || null,
      };
    }
  }
  return {
    ...hotel,
    nights,
    fromCache: true,
    fetchedAt: hotel.fetchedAt || Date.now(),
    bookUrl: hotelBookUrlForSave(hotel),
    compareRate,
    roomDetails:
      detail?.rooms?.length
        ? {
            currency: detail.currency || hotel.currency || null,
            fromCache: Boolean(detail.fromCache),
            rooms: detail.rooms,
          }
        : hotel.roomDetails || null,
  };
}

async function ensureHotelRoomsForSave(hotel) {
  if (!hotel?.ctyhocn || hotel.inventoryOnly) return null;
  const detailKey = roomDetailKey(hotel);
  let detail = state.roomDetails.get(detailKey);
  if (detail?.status === "ok" && detail.rooms?.length) return detail;
  enqueueRoomRateFetch(hotel, { priority: true });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    detail = state.roomDetails.get(detailKey);
    if (detail?.status === "ok" || detail?.status === "error") return detail;
  }
  return state.roomDetails.get(detailKey) || null;
}

function isFamilyAndFriendsRate(rate) {
  if (!rate) return false;
  if (rate.specialRateType === "familyAndFriends") return true;
  return /family\s*and\s*friends|fft|go hilton fftp/i.test(
    `${rate.specialRateType || ""} ${rate.ratePlanName || ""}`
  );
}

/** Cheapest higher-priced rate on a different plan (for F&F savings). */
function findNextHigherDifferentPlan(base, candidates = []) {
  if (!base || base.amount == null) return null;
  const baseAmount = Number(base.amount);
  if (!Number.isFinite(baseAmount)) return null;
  const basePlan = String(base.ratePlanCode || "").toUpperCase();

  let best = null;
  for (const cand of candidates) {
    if (!cand || cand.amount == null) continue;
    const amount = Number(cand.amount);
    if (!Number.isFinite(amount) || amount <= baseAmount) continue;
    const plan = String(cand.ratePlanCode || "").toUpperCase();
    if (basePlan && plan && plan === basePlan) continue;
    // Prefer non-F&F comparison rates when available.
    const candIsFnf = isFamilyAndFriendsRate(cand);
    const bestIsFnf = best ? isFamilyAndFriendsRate(best) : null;
    if (!best) {
      best = cand;
      continue;
    }
    const bestAmount = Number(best.amount);
    if (candIsFnf !== bestIsFnf) {
      if (!candIsFnf && bestIsFnf) best = cand;
      continue;
    }
    if (amount < bestAmount) best = cand;
  }
  return best;
}

function rateDisplayHtml(amount, currency, amountFmt, nights, compareWith = null) {
  const nightly = formatMoneyAmount(amount, currency, amountFmt);
  const showStay = nights != null && Number(nights) > 0;
  const estimate = showStay ? formatStayEstimate(amount, currency, nights) : null;

  let compareStrike = "";
  if (compareWith?.amount != null && amount != null) {
    const saved = Number(compareWith.amount) - Number(amount);
    if (Number.isFinite(saved) && saved > 0) {
      const nextNightly = formatMoneyAmount(compareWith.amount, currency);
      const planHint = compareWith.ratePlanName || compareWith.ratePlanCode || "other rate";
      compareStrike = `<s class="rate-was" title="${escapeHtml(planHint)}">${escapeHtml(nextNightly)}</s>`;
    }
  }

  return estimate
    ? `<div class="rate-nightly">${escapeHtml(nightly)}${compareStrike}<span class="rate-per">/night</span></div>
    <div class="rate-stay">est. ${escapeHtml(estimate)} stay</div>`
    : `${escapeHtml(nightly)}${compareStrike}`;
}

function compareRooms(a, b, key, dir) {
  const mul = dir === "desc" ? -1 : 1;
  if (key === "amount" || key === "roomsAvail") {
    const av = a?.[key] == null || a[key] === "" ? Number.NEGATIVE_INFINITY : Number(a[key]);
    const bv = b?.[key] == null || b[key] === "" ? Number.NEGATIVE_INFINITY : Number(b[key]);
    if (av !== bv) return (av - bv) * mul;
    return String(a.ratePlanName || a.ratePlanCode || "").localeCompare(
      String(b.ratePlanName || b.ratePlanCode || "")
    );
  }
  if (key === "room") {
    const av = String(a.roomTypeName || a.roomTypeCode || "").toLowerCase();
    const bv = String(b.roomTypeName || b.roomTypeCode || "").toLowerCase();
    if (av !== bv) return av.localeCompare(bv) * mul;
    return (Number(a.amount) || 0) - (Number(b.amount) || 0);
  }
  const av = String(a.ratePlanName || a.ratePlanCode || a.specialRateType || "").toLowerCase();
  const bv = String(b.ratePlanName || b.ratePlanCode || b.specialRateType || "").toLowerCase();
  if (av !== bv) return av.localeCompare(bv) * mul;
  return (Number(a.amount) || 0) - (Number(b.amount) || 0);
}

function groupRoomsByType(rooms) {
  const map = new Map();
  for (const room of rooms) {
    const code = String(room.roomTypeCode || room.roomTypeName || "OTHER").toUpperCase();
    if (!map.has(code)) {
      map.set(code, {
        code,
        name: room.roomTypeName || code,
        desc: room.roomTypeDesc || "",
        paragraphs: Array.isArray(room.roomTypeParagraphs) ? room.roomTypeParagraphs : [],
        tags: Array.isArray(room.roomTypeTags) ? room.roomTypeTags : [],
        rooms: [],
      });
    }
    const group = map.get(code);
    group.rooms.push(room);
    if (room.roomTypeName) group.name = room.roomTypeName;
    if (room.roomTypeDesc && (!group.desc || room.roomTypeDesc.length > group.desc.length)) {
      group.desc = room.roomTypeDesc;
    }
    if (Array.isArray(room.roomTypeParagraphs) && room.roomTypeParagraphs.length > group.paragraphs.length) {
      group.paragraphs = room.roomTypeParagraphs;
    }
    if (Array.isArray(room.roomTypeTags) && room.roomTypeTags.length && !group.tags.length) {
      group.tags = room.roomTypeTags;
    }
  }
  return [...map.values()].map((group) => {
    // Recover paragraphs from legacy flat desc strings (cached HTML/joined text).
    if (!group.paragraphs.length && group.desc) {
      group.paragraphs = cleanRoomDescParagraphs(group.desc);
    }
    if (!group.tags.length) {
      const tags = [];
      const sample = group.rooms[0];
      if (sample?.numBeds) tags.push(`${sample.numBeds} bed${Number(sample.numBeds) === 1 ? "" : "s"}`);
      if (sample?.smokingRoom) tags.push("Smoking");
      if (sample?.adaAccessibleRoom) tags.push("Accessible");
      // Pull trailing tag-like chunks from flat desc if needed.
      for (const piece of String(group.desc || "").split(" · ")) {
        if (/^\d+\s+beds?$/i.test(piece.trim()) || /^(smoking|accessible)$/i.test(piece.trim())) {
          if (!tags.includes(piece.trim())) tags.push(piece.trim());
        }
      }
      group.tags = tags;
    }
    return group;
  });
}

function cleanRoomDescParagraphs(raw) {
  const text = String(raw || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  return text
    .split(/\n+| · /)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((p) => !/corresponding photo may not reflect/i.test(p))
    .filter((p) => !/^\d+\s+beds?$/i.test(p))
    .filter((p) => !/^(smoking|accessible)$/i.test(p));
}

function roomDescKey(stayKey, code) {
  return `${stayKey}::${code}`;
}

function isRoomDescOpen(stayKey, code) {
  return state.roomDescOpen.has(roomDescKey(stayKey, code));
}

function toggleRoomDesc(stayKey, code) {
  const id = roomDescKey(stayKey, code);
  if (state.roomDescOpen.has(id)) state.roomDescOpen.delete(id);
  else state.roomDescOpen.add(id);
  refreshTable();
}

function roomGroupDescriptionParts(stayKey, group) {
  const paragraphs = (group.paragraphs || []).length
    ? group.paragraphs
    : cleanRoomDescParagraphs(group.desc);
  const tags = group.tags || [];
  const tagsHtml = tags.length
    ? `<div class="room-group-tags">${tags
        .map((t) => `<span class="room-tag">${escapeHtml(t)}</span>`)
        .join("")}</div>`
    : "";

  if (!paragraphs.length) {
    return {
      meta: `${tagsHtml}<div class="room-group-meta"><span class="room-group-meta-empty">No description from Hilton</span></div>`,
      row: "",
    };
  }

  const open = isRoomDescOpen(stayKey, group.code);
  const meta = `${tagsHtml}
    <button
      type="button"
      class="room-desc-toggle"
      data-room-desc-stay="${escapeHtml(stayKey)}"
      data-room-desc-code="${escapeHtml(group.code)}"
      aria-expanded="${open ? "true" : "false"}"
    >
      <span class="room-desc-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>
      ${open ? "Hide description" : "Show description"}
    </button>`;

  const row = open
    ? `<tr class="room-desc-row">
        <td colspan="5">
          <div class="room-desc-body">
            ${paragraphs.map((p) => `<p class="room-desc-p">${escapeHtml(p)}</p>`).join("")}
          </div>
        </td>
      </tr>`
    : "";

  return { meta, row };
}

function sortedRoomGroups(rooms) {
  const groups = groupRoomsByType(rooms).map((group) => ({
    ...group,
    rooms: [...group.rooms].sort((a, b) =>
      compareRooms(a, b, state.roomSortKey === "room" ? "amount" : state.roomSortKey, state.roomSortDir)
    ),
  }));

  const mul = state.roomSortDir === "desc" ? -1 : 1;
  groups.sort((a, b) => {
    if (state.roomSortKey === "room") {
      const byName = String(a.name || a.code).localeCompare(String(b.name || b.code)) * mul;
      if (byName) return byName;
      return String(a.code).localeCompare(String(b.code)) * mul;
    }
    if (state.roomSortKey === "amount") {
      const av = Math.min(...a.rooms.map((r) => Number(r.amount)).filter((n) => !Number.isNaN(n)), 1e12);
      const bv = Math.min(...b.rooms.map((r) => Number(r.amount)).filter((n) => !Number.isNaN(n)), 1e12);
      if (av !== bv) return (av - bv) * mul;
    } else if (state.roomSortKey === "roomsAvail") {
      const av = Math.max(...a.rooms.map((r) => Number(r.roomsAvail) || 0), 0);
      const bv = Math.max(...b.rooms.map((r) => Number(r.roomsAvail) || 0), 0);
      if (av !== bv) return (av - bv) * mul;
    } else if (state.roomSortKey === "ratePlanName") {
      const av = String(a.rooms[0]?.ratePlanName || "").toLowerCase();
      const bv = String(b.rooms[0]?.ratePlanName || "").toLowerCase();
      if (av !== bv) return av.localeCompare(bv) * mul;
    }
    return String(a.name || a.code).localeCompare(String(b.name || b.code));
  });
  return groups;
}

function arrivalWeekday(isoDate) {
  return new Date(`${isoDate}T00:00:00`).getDay();
}

function filterByDow(rows) {
  if (!state.dowSelected.size) return rows;
  return rows.filter((row) => {
    if (row.inventoryOnly || !row.arrivalDate) return true;
    return state.dowSelected.has(arrivalWeekday(row.arrivalDate));
  });
}

const COLUMN_FILTERS = [
  {
    id: "arrivalDate",
    sortKey: "arrivalDate",
    label: "Check-in",
    plural: "dates",
    panelWidth: 200,
    value: (row) => String(row?.arrivalDate || "").trim() || "—",
  },
  {
    id: "hotelName",
    sortKey: "hotelName",
    label: "Hotel",
    plural: "hotels",
    panelWidth: 280,
    value: (row) =>
      String(row?.hotelName || "").trim() ||
      String(row?.ctyhocn || "").trim() ||
      "—",
  },
  {
    id: "brandCode",
    sortKey: "brandCode",
    label: "Brand",
    plural: "brands",
    panelWidth: 160,
    value: (row) => String(row?.brandCode || "").trim() || "—",
  },
  {
    id: "city",
    sortKey: "city",
    label: "City",
    plural: "cities",
    panelWidth: 220,
    value: (row) => String(row?.city || "").trim() || "—",
  },
  {
    id: "specialRateType",
    sortKey: "specialRateType",
    label: "Rate",
    plural: "rates",
    panelWidth: 200,
    value: (row) => {
      if (row?.inventoryOnly && !row.stayPriced) return "lead";
      if (row?.isGoRate) return String(row.specialRateType || "go").trim() || "go";
      return String(row?.specialRateType || "other").trim() || "other";
    },
  },
];

function columnFilterDef(id) {
  return COLUMN_FILTERS.find((c) => c.id === id) || null;
}

function columnFilterSelected(id) {
  if (!state.columnFilters[id]) state.columnFilters[id] = new Set();
  return state.columnFilters[id];
}

function availableColumnValues(id) {
  const def = columnFilterDef(id);
  if (!def) return [];
  const fromResults = rowsMatchingFiltersExcept(id).map((row) => def.value(row));
  // Keep active selections even when they match zero rows.
  const selected = [...columnFilterSelected(id)];
  return [...new Set([...fromResults, ...selected].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/** Rows after DOW + all column filters except `excludeId` (cascading option lists). */
function rowsMatchingFiltersExcept(excludeId = null) {
  let rows = filterByDow(state.allRows || []);
  for (const def of COLUMN_FILTERS) {
    if (excludeId && def.id === excludeId) continue;
    const selected = columnFilterSelected(def.id);
    if (!selected.size) continue;
    rows = rows.filter((row) => selected.has(def.value(row)));
  }
  return rows;
}

function anyColumnFilterActive() {
  return COLUMN_FILTERS.some((c) => columnFilterSelected(c.id).size > 0);
}

function filterByColumnFilters(rows) {
  let out = rows;
  for (const def of COLUMN_FILTERS) {
    const selected = columnFilterSelected(def.id);
    if (!selected.size) continue;
    out = out.filter((row) => selected.has(def.value(row)));
  }
  return out;
}

function filterByTripPair(rows) {
  // Check-in is applied via the Check-in column filter (synced from selection).
  // Still enforce check-out when flight/hotel selection implies departure dates.
  const constraint = getTripPairStayConstraint();
  if (!constraint?.departureDates?.size) return rows;
  return rows.filter((row) => {
    if (row.inventoryOnly) return true;
    if (row.departureDate && !constraint.departureDates.has(row.departureDate)) return false;
    return true;
  });
}

/** Push selection locks into the hotel Check-in column filter. */
function syncHotelDateFiltersFromSelection() {
  const constraint = getTripPairStayConstraint();
  state.columnFilters.arrivalDate = constraint?.arrivalDates?.size
    ? new Set([...constraint.arrivalDates].map((d) => String(d).slice(0, 10)))
    : new Set();
}

function filterResultRows(rows) {
  return filterByColumnFilters(filterByDow(filterByTripPair(rows)));
}

function onTripFlightSelectionChange() {
  syncHotelDateFiltersFromSelection();
  const constraint = getTripPairStayConstraint();
  if (state.selectedHotelKey && constraint) {
    const hotel =
      state.allRows.find((r) => rowKey(r) === state.selectedHotelKey) || null;
    const ok =
      hotel &&
      (!hotel.arrivalDate ||
        !constraint.arrivalDates?.size ||
        constraint.arrivalDates.has(String(hotel.arrivalDate).slice(0, 10))) &&
      (!hotel.departureDate ||
        !constraint.departureDates?.size ||
        constraint.departureDates.has(String(hotel.departureDate).slice(0, 10)));
    if (!ok) clearTripHotelSelection({ silent: true });
  }
  if (!$("flightResults")?.hidden) {
    // Avoid scoring mid-search (hotels may not be loaded yet).
    if (state.scanning) {
      refreshTable();
      updatePriceOptimalSelectButtons();
    } else resolveAndHighlightBestTripCombo();
  } else {
    updateTripSummary();
  }
}

function pruneColumnSelection(id, values) {
  const selected = columnFilterSelected(id);
  if (!selected.size) return false;
  const allowed = new Set(values);
  const next = new Set([...selected].filter((v) => allowed.has(v)));
  const changed = next.size !== selected.size;
  state.columnFilters[id] = next;
  return changed;
}

function clearColumnFilters() {
  for (const def of COLUMN_FILTERS) {
    state.columnFilters[def.id] = new Set();
  }
  state.openColumnFilter = null;
}

function updateColumnFilterUi(id = null) {
  // Always refresh every column so options cascade when one filter changes.
  void id;
  // Prune in passes so interdependent selections settle (e.g. city then hotel).
  for (let pass = 0; pass < COLUMN_FILTERS.length; pass += 1) {
    let changed = false;
    for (const def of COLUMN_FILTERS) {
      const values = availableColumnValues(def.id);
      if (pruneColumnSelection(def.id, values)) changed = true;
    }
    if (!changed) break;
  }

  for (const def of COLUMN_FILTERS) {
    const trigger = document.querySelector(
      `.col-filter-trigger[data-col-filter="${def.id}"]`
    );
    const meta = document.querySelector(
      `.col-filter-meta[data-col-filter-meta="${def.id}"]`
    );
    if (!trigger || !meta) continue;
    const values = availableColumnValues(def.id);
    const selected = columnFilterSelected(def.id);
    const count = selected.size;
    trigger.classList.toggle("has-filter", count > 0);
    trigger.disabled = !values.length && !count;
    if (!count) {
      meta.textContent = "";
    } else if (count <= 2) {
      meta.textContent = [...selected].sort((a, b) => a.localeCompare(b)).join(", ");
    } else {
      meta.textContent = `${count} ${def.plural}`;
    }
    renderColumnFilterList(def.id, values);
  }
}

function renderColumnFilterList(id, values = availableColumnValues(id)) {
  const list = document.querySelector(`.col-filter-list[data-col-filter-list="${id}"]`);
  if (!list) return;
  const def = columnFilterDef(id);
  if (!values.length) {
    list.innerHTML = `<div class="col-filter-empty">No ${def?.plural || "values"} in results</div>`;
    return;
  }
  const selected = columnFilterSelected(id);
  list.innerHTML = values
    .map((value) => {
      const checked = selected.has(value) ? " checked" : "";
      return `<label>
        <input type="checkbox" value="${escapeHtml(value)}"${checked} />
        <span>${escapeHtml(value)}</span>
      </label>`;
    })
    .join("");
}

function syncColumnFilterFromDom(id) {
  const list = document.querySelector(`.col-filter-list[data-col-filter-list="${id}"]`);
  if (!list) return;
  state.columnFilters[id] = new Set(
    [...list.querySelectorAll("input[type=checkbox]:checked")].map((el) => el.value)
  );
  state.page = 0;
  // Defer rebuild so we don't remove the checkbox mid-click (which cancels the toggle
  // / retargets the click to document and makes options feel dead).
  requestAnimationFrame(() => refreshTable());
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
  const approxH = Math.min(panel.scrollHeight || 240, window.innerHeight * 0.6);
  if (top + approxH > window.innerHeight - 8) {
    top = Math.max(8, rect.top - gap - approxH);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${w}px`;
}

function positionColumnFilterPanel(id) {
  const trigger = document.querySelector(`.col-filter-trigger[data-col-filter="${id}"]`);
  const panel = document.querySelector(`.col-filter-panel[data-col-filter-panel="${id}"]`);
  const def = columnFilterDef(id);
  if (!trigger || !panel || panel.hidden || !def) return;
  pinOverlayPanel(panel, trigger, { width: def.panelWidth || 220 });
}

function positionDowLikePanel(panelId, triggerId) {
  const panel = $(panelId);
  const trigger = $(triggerId);
  if (!panel || !trigger || panel.hidden) return;
  pinOverlayPanel(panel, trigger, { width: 280, gap: 8 });
}

function repositionOpenHotelOverlays() {
  if (state.openColumnFilter) positionColumnFilterPanel(state.openColumnFilter);
  if ($("dowPanel") && !$("dowPanel").hidden) positionDowLikePanel("dowPanel", "dowTrigger");
  if ($("rateTypePanel") && !$("rateTypePanel").hidden) {
    positionDowLikePanel("rateTypePanel", "rateTypeTrigger");
  }
}

function setColumnFilterOpen(id, open) {
  for (const def of COLUMN_FILTERS) {
    const panel = document.querySelector(
      `.col-filter-panel[data-col-filter-panel="${def.id}"]`
    );
    const trigger = document.querySelector(
      `.col-filter-trigger[data-col-filter="${def.id}"]`
    );
    if (!panel || !trigger) continue;
    const isOpen = Boolean(open) && def.id === id;
    if (isOpen) {
      setDowOpen(false);
      setRateTypeOpen(false);
      renderColumnFilterList(def.id);
    }
    panel.hidden = !isOpen;
    if (!isOpen) unmountOverlayPanel(panel);
    trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) positionColumnFilterPanel(def.id);
  }
  state.openColumnFilter = open ? id : null;
}

function closeAllColumnFilters() {
  setColumnFilterOpen(null, false);
}

function setupColumnFilters() {
  for (const def of COLUMN_FILTERS) {
    const trigger = document.querySelector(
      `.col-filter-trigger[data-col-filter="${def.id}"]`
    );
    const panel = document.querySelector(
      `.col-filter-panel[data-col-filter-panel="${def.id}"]`
    );
    const list = document.querySelector(
      `.col-filter-list[data-col-filter-list="${def.id}"]`
    );
    const reset = document.querySelector(
      `.col-filter-reset[data-col-filter-reset="${def.id}"]`
    );
    if (!trigger || !panel || !list || !reset) continue;

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (trigger.disabled) return;
      const opening = panel.hidden;
      setColumnFilterOpen(def.id, opening);
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    // Prevent text-selection drags; toggle explicitly so label clicks always apply.
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
      syncColumnFilterFromDom(def.id);
    });
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      state.columnFilters[def.id] = new Set();
      state.page = 0;
      requestAnimationFrame(() => refreshTable());
    });
  }
  window.addEventListener("resize", () => {
    repositionOpenHotelOverlays();
  });
  window.addEventListener("scroll", repositionOpenHotelOverlays, true);
  updateColumnFilterUi();
}

function updateDowUi() {
  const trigger = $("dowTrigger");
  const meta = $("dowTriggerMeta");
  const count = state.dowSelected.size;
  trigger.classList.toggle("has-filter", count > 0);
  if (!count) {
    meta.textContent = "";
  } else {
    meta.textContent = [...state.dowSelected]
      .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
      .map((d) => DAY_NAMES[d])
      .join(" ");
  }
  $("dowDays").querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.checked = state.dowSelected.has(Number(input.value));
  });
}

function syncDowFromDom() {
  state.dowSelected = new Set(
    [...$("dowDays").querySelectorAll("input[type=checkbox]:checked")].map((el) => Number(el.value))
  );
  updateDowUi();
  state.page = 0;
  refreshTable();
}

function rateTypeLabel(value) {
  return value === "tm" ? "Team Member" : "Friends & Family";
}

function updateRateTypeUi() {
  const trigger = $("rateTypeTrigger");
  const meta = $("rateTypeMeta");
  const hidden = $("rateType");
  if (!trigger || !meta || !hidden) return;
  const value = hidden.value === "tm" ? "tm" : "fnf";
  hidden.value = value;
  meta.textContent = rateTypeLabel(value);
  trigger.classList.toggle("has-filter", value !== "fnf");
  $("rateTypeOptions")
    ?.querySelectorAll("input[type=radio]")
    .forEach((input) => {
      input.checked = input.value === value;
    });
}

function setRateTypeOpen(open) {
  const panel = $("rateTypePanel");
  const trigger = $("rateTypeTrigger");
  if (!panel || !trigger) return;
  panel.hidden = !open;
  if (!open) unmountOverlayPanel(panel);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  const chevron = trigger.querySelector(".dow-chevron");
  if (chevron) chevron.textContent = open ? "▴" : "▾";
  if (open) {
    setDowOpen(false);
    closeAllColumnFilters();
    positionDowLikePanel("rateTypePanel", "rateTypeTrigger");
  }
}

function setupRateTypeFilter() {
  updateRateTypeUi();
  $("rateTypeTrigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setRateTypeOpen($("rateTypePanel").hidden);
  });
  $("rateTypePanel")?.addEventListener("click", (e) => e.stopPropagation());
  $("rateTypeOptions")?.addEventListener("mousedown", (e) => {
    if (e.target.closest("label")) e.preventDefault();
  });
  $("rateTypeOptions")?.addEventListener("click", (e) => {
    const label = e.target.closest("label");
    const options = $("rateTypeOptions");
    if (!label || !options?.contains(label)) return;
    e.preventDefault();
    e.stopPropagation();
    const input = label.querySelector('input[type="radio"]');
    if (!input) return;
    input.checked = true;
    $("rateType").value = input.value === "tm" ? "tm" : "fnf";
    updateRateTypeUi();
    writeParams(formValues());
    setRateTypeOpen(false);
  });
}

function setDowOpen(open) {
  const panel = $("dowPanel");
  const trigger = $("dowTrigger");
  if (!panel || !trigger) return;
  panel.hidden = !open;
  if (!open) unmountOverlayPanel(panel);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  const chevron = trigger.querySelector(".dow-chevron");
  if (chevron) chevron.textContent = open ? "▴" : "▾";
  if (open) {
    setRateTypeOpen(false);
    closeAllColumnFilters();
    positionDowLikePanel("dowPanel", "dowTrigger");
  }
}

function setupDowFilter() {
  updateDowUi();
  $("dowTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    setDowOpen($("dowPanel").hidden);
  });
  $("dowPanel").addEventListener("click", (e) => e.stopPropagation());
  $("dowDays").addEventListener("mousedown", (e) => {
    if (e.target.closest("label")) e.preventDefault();
  });
  $("dowDays").addEventListener("click", (e) => {
    const label = e.target.closest("label");
    if (!label || !$("dowDays").contains(label)) return;
    e.preventDefault();
    e.stopPropagation();
    const input = label.querySelector('input[type="checkbox"]');
    if (!input) return;
    input.checked = !input.checked;
    syncDowFromDom();
  });
  $("dowReset").addEventListener("click", (e) => {
    e.stopPropagation();
    state.dowSelected = new Set();
    updateDowUi();
    state.page = 0;
    refreshTable();
  });
  document.addEventListener("click", (e) => {
    if (
      e.target.closest(".col-filter") ||
      e.target.closest("[data-col-filter-panel]") ||
      e.target.closest("#dowPanel") ||
      e.target.closest("#rateTypePanel") ||
      e.target.closest("#dowTrigger") ||
      e.target.closest("#rateTypeTrigger")
    ) {
      return;
    }
    setDowOpen(false);
    setRateTypeOpen(false);
    closeAllColumnFilters();
  });
  document.addEventListener("goplus:close-overlays", () => {
    setDowOpen(false);
    setRateTypeOpen(false);
    closeAllColumnFilters();
  });
}

function rowKey(row) {
  return [
    row.ctyhocn || "",
    row.arrivalDate || "",
    row.departureDate || "",
    row.amount ?? "",
    row.ratePlanCode || "",
    row.roomTypeCode || "",
  ].join("|");
}

function stayKey(row) {
  return [
    String(row.ctyhocn || "").toUpperCase(),
    row.arrivalDate || "",
    row.departureDate || "",
  ].join("|");
}

/** Room-shop cache key: hotel + stay + rate program (not amount/plan — those change during scans). */
function roomDetailKey(row, friendsAndFamily = formValues().rateType !== "tm") {
  const stay = stayDatesForRoomFetch(row);
  const arrival = stay?.arrivalDate || row?.arrivalDate || "";
  const departure = stay?.departureDate || row?.departureDate || "";
  const hotel = String(row?.ctyhocn || "").toUpperCase();
  return `${hotel}|${arrival}|${departure}|${friendsAndFamily ? "fnf" : "tm"}`;
}

function isStayExpanded(row) {
  const detailKey = roomDetailKey(row);
  for (const r of state.allRows) {
    if (roomDetailKey(r) === detailKey && state.expanded.has(rowKey(r))) return true;
  }
  return false;
}

function migrateRowKeyState(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  for (const set of [state.expanded, state.refreshingKeys]) {
    if (set.has(oldKey)) {
      set.delete(oldKey);
      set.add(newKey);
    }
  }
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

function cacheIconHtml(row, key) {
  if (!row.fromCache && !state.refreshingKeys.has(key)) return "";
  const refreshing = state.refreshingKeys.has(key);
  const captured = formatCacheCapturedAt(row.fetchedAt);
  const title = refreshing
    ? "Refreshing…"
    : captured
      ? `Cached · captured ${captured} — click to refresh`
      : "Cached (less than 4 hours old) — click to refresh";
  return `<button
    type="button"
    class="cache-icon${refreshing ? " refreshing" : ""}"
    data-cache-refresh="${escapeHtml(key)}"
    title="${escapeHtml(title)}"
    aria-label="${escapeHtml(title)}"
    ${refreshing ? "disabled" : ""}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <ellipse cx="8" cy="4.2" rx="5.2" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.8 4.2v3.4c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.8 7.6v3.4c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V7.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
    </svg>
  </button>`;
}

async function refreshCachedEntry(key) {
  const row =
    state.allRows.find((r) => rowKey(r) === key) ||
    state.rows.find((r) => rowKey(r) === key);
  if (!row?.ctyhocn || !row.arrivalDate || state.refreshingKeys.has(key)) return;

  state.refreshingKeys.add(key);
  refreshTable();

  const values = formValues();
  const realName =
    row.hotelName &&
    String(row.hotelName).toUpperCase() !== String(row.ctyhocn).toUpperCase()
      ? row.hotelName
      : null;
  const res = await sendMessage({
    type: "REFRESH_RATE_ENTRY",
    ctyhocn: row.ctyhocn,
    arrivalDate: row.arrivalDate,
    departureDate: row.departureDate,
    nights: stayNightsFor(row),
    friendsAndFamily: values.rateType !== "tm",
    hotelName: realName,
    brandCode: row.brandCode,
    city: row.city,
    country: row.country,
  });

  state.refreshingKeys.delete(key);

  if (!res.ok) {
    if (res.unauthorized) {
      markUnauthorized(res.error);
    } else if (/unknown message/i.test(String(res.error || ""))) {
      setStatus("Reload go+ on chrome://extensions to enable cache refresh, then try again.", "warn");
    } else {
      setStatus(res.error || "Refresh failed.", "warn");
    }
    refreshTable();
    return;
  }

  const daysByStay = new Map(
    (res.days || []).map((day) => [stayKey(day), day])
  );
  const monthPrefix = String(row.arrivalDate || "").slice(0, 7);
  const hotelCode = String(row.ctyhocn || "").toUpperCase();

  const nextRows = [];
  for (const existing of state.allRows) {
    const sameHotelMonth =
      String(existing.ctyhocn || "").toUpperCase() === hotelCode &&
      String(existing.arrivalDate || "").startsWith(monthPrefix);
    if (!sameHotelMonth) {
      nextRows.push(existing);
      continue;
    }
    const fresh = daysByStay.get(stayKey(existing));
    if (!fresh) {
      // Night disappeared from calendar — drop it.
      const old = rowKey(existing);
      state.expanded.delete(old);
      continue;
    }
    // Re-apply current search filters to refreshed day.
    if (values.goOnly && !fresh.isGoRate) continue;
    if (values.maxRate != null && Number(fresh.amount) > Number(values.maxRate)) continue;
    if ((fresh.roomsAvail ?? 0) < Number(values.minRooms ?? 1)) continue;

    const oldKey = rowKey(existing);
    const merged = {
      ...existing,
      ...fresh,
      hotelName: fresh.hotelName || existing.hotelName,
      brandCode: fresh.brandCode || existing.brandCode,
      city: fresh.city || existing.city,
      country: fresh.country || existing.country,
      fromCache: false,
    };
    const newKey = rowKey(merged);
    migrateRowKeyState(oldKey, newKey);
    nextRows.push(merged);
  }

  state.allRows = nextRows;

  const refreshedStay = stayKey(row);
  const updated =
    state.allRows.find((r) => stayKey(r) === refreshedStay) || null;
  if (updated) {
    const detailKey = roomDetailKey(updated);
    if (!res.roomsError) {
      const rooms = res.rooms || [];
      state.roomDetails.set(detailKey, {
        status: "ok",
        rooms,
        fromCache: false,
        currency: res.currency || null,
        savedAt: Date.now(),
      });
      // ShopAvail is authoritative — don't keep a calendar-only teaser price.
      syncRowsToShopRooms(detailKey, rooms, res.currency || null);
      schedulePersistRoomDetails();
    } else {
      state.roomDetails.delete(detailKey);
      enqueueRoomRateFetch(updated, { priority: true });
    }
  }

  refreshTable();
  setStatus(`Refreshed ${row.hotelName || row.ctyhocn} · ${row.arrivalDate}`);
}

function weekdayLabel(isoDate) {
  if (!isoDate) return "—";
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[arrivalWeekday(isoDate)] || "—";
}

function detailItems(row, compareWith = null) {
  if (row.inventoryOnly) {
    return [
      ["Hotel code", row.ctyhocn || "—"],
      ["Brand", row.brandCode || "—"],
      ["City", row.city || "—"],
      ["Country", row.country || "—"],
      ["Lead nightly", formatMoneyAmount(row.amount, row.currency, row.amountFmt)],
      ["Rate", row.ratePlanName || "—"],
      ["Rate code", row.ratePlanCode || "—"],
      ["Source", "Country inventory (lead rate)"],
    ];
  }
  const nights = stayNightsFor(row);
  const stayEst = formatStayEstimate(row.amount, row.currency, nights);
  const saved =
    compareWith?.amount != null && row.amount != null
      ? Number(compareWith.amount) - Number(row.amount)
      : null;
  return [
    ["Check-in", row.arrivalDate || "—"],
    ["Check-out", row.departureDate || "—"],
    ["Stay nights", nights],
    ["Weekday (check-in)", weekdayLabel(row.arrivalDate)],
    ["Hotel code", row.ctyhocn || "—"],
    ["Brand", row.brandCode || "—"],
    ["City", row.city || "—"],
    ["Country", row.country || "—"],
    ["Nightly price", formatMoneyAmount(row.amount, row.currency, row.amountFmt)],
    ["Est. stay total", stayEst || "—"],
    compareWith?.amount != null
      ? [
          "Next rate nightly",
          `${formatMoneyAmount(compareWith.amount, row.currency)}${
            compareWith.ratePlanName ? ` · ${compareWith.ratePlanName}` : ""
          }`,
        ]
      : null,
    saved != null && saved > 0 ? ["F&F savings / night", formatMoneyAmount(saved, row.currency)] : null,
    row.currencyOriginal && row.currencyOriginal !== "USD" && row.amountOriginal != null
      ? ["Original nightly", `${Number(row.amountOriginal).toLocaleString()} ${row.currencyOriginal}`]
      : null,
    ["Rooms left (calendar)", row.roomsAvail ?? "—"],
    ["Rate", row.ratePlanName || "—"],
    ["Rate code", row.ratePlanCode || "—"],
    ["Room type code", row.roomTypeCode || "—"],
    ["Special rate", row.specialRateType || "—"],
    ["Source", row.fromCache ? "Cached (< 4h)" : "Live fetch"],
  ].filter(Boolean);
}

function roomGroupKey(stayKey, code) {
  return `${stayKey}::${code}`;
}

function isRoomGroupOpen(stayKey, code) {
  return state.roomGroupsOpen.has(roomGroupKey(stayKey, code));
}

function toggleRoomGroup(stayKey, code) {
  const id = roomGroupKey(stayKey, code);
  if (state.roomGroupsOpen.has(id)) state.roomGroupsOpen.delete(id);
  else state.roomGroupsOpen.add(id);
  refreshTable();
}

function isRoomsSectionOpen(stayKey) {
  return state.roomsSectionOpen.has(stayKey);
}

function toggleRoomsSection(stayKey) {
  if (state.roomsSectionOpen.has(stayKey)) state.roomsSectionOpen.delete(stayKey);
  else state.roomsSectionOpen.add(stayKey);
  refreshTable();
}

function roomsSectionHeading(key, label, { toggleable = false, open = true } = {}) {
  if (!toggleable) {
    return `<div class="rooms-title">${escapeHtml(label)}</div>`;
  }
  return `<button
    type="button"
    class="rooms-title-btn"
    data-rooms-toggle="${escapeHtml(key)}"
    aria-expanded="${open ? "true" : "false"}"
  >
    <span class="rooms-title-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>
    <span class="rooms-title-label">${escapeHtml(label)}</span>
  </button>`;
}

function roomsSectionHtml(key, row) {
  const detailKey = roomDetailKey(row);
  const detail = state.roomDetails.get(detailKey);
  const stay = stayDatesForRoomFetch(row);
  const inventoryNote = row.inventoryOnly
    ? `<div class="inventory-rooms-note">${escapeHtml(COUNTRY_ROOMS_HINT)}</div>`
    : "";
  const rooms = detail?.rooms || [];
  // Keep previously loaded rooms visible (incl. F&F compares) — never flash Loading again.
  if (detail?.status === "ok" || rooms.length) {
    /* fall through to render rooms / empty */
  } else if (!detail || detail.status === "loading" || detail.status === "queued") {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      detailKey,
      "Available rooms"
    )}<div class="rooms-status">${
      row.inventoryOnly
        ? "Loading room rates for this hotel…"
        : "Loading room rates for this stay…"
    }</div></div>`;
  }
  if (detail?.status === "error" && !rooms.length) {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      detailKey,
      "Available rooms"
    )}<div class="rooms-status bad">${escapeHtml(
      detail.error || "Could not load rooms."
    )}</div></div>`;
  }
  if (!rooms.length) {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      detailKey,
      "Available rooms"
    )}<div class="rooms-status">No room rates returned for this stay.</div></div>`;
  }
  const cacheNote = detail?.fromCache ? ` · cached` : "";
  const open = isRoomsSectionOpen(detailKey);
  const arrivalDate = stay?.arrivalDate || row.arrivalDate;
  const departureDate = stay?.departureDate || row.departureDate;
  const bookUrl = `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
    row.ctyhocn
  )}&arrivalDate=${encodeURIComponent(arrivalDate || "")}&departureDate=${encodeURIComponent(
    departureDate || ""
  )}&room1NumAdults=1`;
  const groups = sortedRoomGroups(rooms);
  const title = `Available rooms (${rooms.length} prices · ${groups.length} types${cacheNote})`;
  if (!open) {
    return `<div class="rooms-section collapsed">${inventoryNote}${roomsSectionHeading(detailKey, title, {
      toggleable: true,
      open: false,
    })}</div>`;
  }
  const nights = stay?.nights ?? stayNightsFor(row);
  const currency = row.currency || detail?.currency;
  const rowsHtml = groups
    .map((group) => {
      const openGroup = isRoomGroupOpen(detailKey, group.code);
      const cheapest = group.rooms.reduce((best, room) => {
        if (room.amount == null) return best;
        if (!best || Number(room.amount) < Number(best.amount)) return room;
        return best;
      }, null);
      const cheapestCompare =
        cheapest && isFamilyAndFriendsRate(cheapest)
          ? findNextHigherDifferentPlan(cheapest, group.rooms)
          : null;
      const cheapestHtml = cheapest
        ? rateDisplayHtml(
            cheapest.amount,
            cheapest.currency || currency,
            cheapest.amountFmt,
            nights,
            cheapestCompare
          )
        : "—";
      const maxAvail = Math.max(...group.rooms.map((r) => Number(r.roomsAvail) || 0), 0);
      const displayName =
        group.name && String(group.name).trim() ? String(group.name).trim() : group.code;
      const showCode = displayName.toUpperCase() !== String(group.code).toUpperCase();
      const groupTitle = showCode
        ? `${escapeHtml(displayName)} <span class="room-group-code">${escapeHtml(group.code)}</span>`
        : escapeHtml(displayName);
      const descParts = roomGroupDescriptionParts(detailKey, group);
      const header = `<tr
        class="room-group-row${openGroup ? " open" : ""}"
        data-stay-key="${escapeHtml(detailKey)}"
        data-room-code="${escapeHtml(group.code)}"
        tabindex="0"
        role="button"
        aria-expanded="${openGroup ? "true" : "false"}"
      >
        <td>
          <div class="room-group-cell">
            <div class="room-group-main">
              <div class="room-group-title">${groupTitle}</div>
              ${descParts.meta}
            </div>
          </div>
        </td>
        <td class="rate">${cheapestHtml}</td>
        <td class="rooms-avail">${maxAvail || "—"}</td>
        <td class="rooms-plan"><span class="plan-count">${group.rooms.length} rate${
          group.rooms.length === 1 ? "" : "s"
        }</span></td>
        <td></td>
      </tr>${descParts.row}`;
      if (!openGroup) return header;
      const rates = group.rooms
        .map((room) => {
          const go = room.isGoRate
            ? `<span class="badge go">${escapeHtml(room.specialRateType || "go")}</span>`
            : "";
          const compare =
            isFamilyAndFriendsRate(room) ? findNextHigherDifferentPlan(room, group.rooms) : null;
          const priceHtml = rateDisplayHtml(
            room.amount,
            room.currency || currency,
            room.amountFmt,
            nights,
            compare
          );
          return `<tr class="room-rate-row">
            <td class="room-rate-spacer"><span class="room-rate-branch" aria-hidden="true"></span></td>
            <td class="rate">${priceHtml}</td>
            <td class="rooms-avail">${escapeHtml(room.roomsAvail ?? "—")}</td>
            <td class="rooms-plan">${go}<span class="plan-name">${escapeHtml(
              room.ratePlanName || room.ratePlanCode || "—"
            )}</span></td>
            <td class="rooms-book"><a class="book-link" href="${escapeHtml(
              bookUrl
            )}" target="_blank" rel="noopener">Book</a></td>
          </tr>`;
        })
        .join("");
      return header + rates;
    })
    .join("");
  return `<div class="rooms-section">
    ${roomsSectionHeading(detailKey, title, { toggleable: true, open: true })}
    <div class="rooms-body">
      <table class="rooms-table">
        <thead>
          <tr>
            <th><button type="button" class="sort-btn room-sort-btn" data-sort="room">Room</button></th>
            <th><button type="button" class="sort-btn room-sort-btn" data-sort="amount">Price</button></th>
            <th><button type="button" class="sort-btn room-sort-btn" data-sort="roomsAvail">Avail</button></th>
            <th><button type="button" class="sort-btn room-sort-btn" data-sort="ratePlanName">Rate</button></th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

function cheapestShopRoom(rooms) {
  let best = null;
  for (const room of rooms || []) {
    if (room == null || room.amount == null) continue;
    const amount = Number(room.amount);
    if (!Number.isFinite(amount)) continue;
    if (!best || amount < Number(best.amount)) best = room;
  }
  return best;
}

/** Prefer bookable shopAvail prices over calendar lead rates for a stay. */
function patchRowFromShopRoom(row, best, currency = null) {
  if (!row || !best || best.amount == null) return row;
  const amount = Number(best.amount);
  if (!Number.isFinite(amount)) return row;
  const nextCurrency = currency || best.currency || row.currency || "USD";
  const same =
    row.shopPriced &&
    Number(row.amount) === amount &&
    String(row.ratePlanCode || "") === String(best.ratePlanCode || "") &&
    String(row.roomTypeCode || "") === String(best.roomTypeCode || "") &&
    String(row.specialRateType || "") === String(best.specialRateType || "");
  if (same) return row;
  return {
    ...row,
    amount,
    amountFmt: best.amountFmt || `$${Math.round(amount)}`,
    currency: nextCurrency,
    roomsAvail: best.roomsAvail ?? row.roomsAvail,
    ratePlanCode: best.ratePlanCode || null,
    ratePlanName: best.ratePlanName || null,
    ratePlanDesc: best.ratePlanDesc || null,
    roomTypeCode: best.roomTypeCode || null,
    specialRateType: best.specialRateType || null,
    isGoRate: Boolean(best.isGoRate),
    shopPriced: true,
  };
}

function syncRowsToShopRooms(detailKey, rooms, currency = null) {
  const best = cheapestShopRoom(rooms);
  if (!best || !detailKey) return 0;
  let changed = 0;
  const nextRows = [];
  for (const existing of state.allRows) {
    if (roomDetailKey(existing) !== detailKey) {
      nextRows.push(existing);
      continue;
    }
    const oldKey = rowKey(existing);
    const patched = patchRowFromShopRoom(existing, best, currency);
    if (patched === existing) {
      nextRows.push(existing);
      continue;
    }
    migrateRowKeyState(oldKey, rowKey(patched));
    nextRows.push(patched);
    changed += 1;
  }
  if (changed) state.allRows = nextRows;
  return changed;
}

function reconcileShopPricesIntoRows() {
  let changed = 0;
  for (const [key, detail] of state.roomDetails) {
    if (detail?.status !== "ok" || !detail.rooms?.length) continue;
    changed += syncRowsToShopRooms(key, detail.rooms, detail.currency);
  }
  return changed;
}

async function loadRoomRates(detailKey, row) {
  if (!row?.ctyhocn || !detailKey) return;
  const stay = stayDatesForRoomFetch(row);
  if (!stay) return;
  const existing = state.roomDetails.get(detailKey);
  if (existing?.status === "loading") return;
  if (existing?.status === "ok") {
    // Already have shop rooms — keep the entry price aligned with bookable rates.
    if (syncRowsToShopRooms(detailKey, existing.rooms, existing.currency)) refreshTable();
    return;
  }

  state.roomDetails.set(detailKey, {
    status: "loading",
    rooms: existing?.rooms || [],
    fromCache: existing?.fromCache,
    currency: existing?.currency || null,
  });
  if (isStayExpanded(row)) refreshTable();

  const values = formValues();
  const res = await sendMessage({
    type: "FETCH_ROOM_RATES",
    ctyhocn: row.ctyhocn,
    arrivalDate: stay.arrivalDate,
    departureDate: stay.departureDate,
    friendsAndFamily: values.rateType !== "tm",
  });

  // Keep results so F&F "vs / save" stays on the main price cell after collapse.
  if (!res.ok) {
    if (res.unauthorized) {
      markUnauthorized(res.error);
      state.roomDetails.set(detailKey, {
        status: "error",
        error: res.error || "Session expired.",
        rooms: existing?.rooms || [],
      });
    } else {
      state.roomDetails.set(detailKey, {
        status: "error",
        error: res.error || "Room shop failed.",
        rooms: existing?.rooms || [],
      });
    }
    refreshTable();
    return;
  }

  const rooms = res.rooms || [];
  state.roomDetails.set(detailKey, {
    status: "ok",
    rooms,
    fromCache: Boolean(res.fromCache),
    currency: res.currency || null,
    savedAt: Date.now(),
  });
  // Calendar lead rates can advertise F&F prices that aren't bookable on shopAvail.
  syncRowsToShopRooms(detailKey, rooms, res.currency || null);
  schedulePersistRoomDetails();
  refreshTable();
}

let persistRoomDetailsTimer = null;

function schedulePersistRoomDetails() {
  if (persistRoomDetailsTimer) return;
  persistRoomDetailsTimer = setTimeout(() => {
    persistRoomDetailsTimer = null;
    persistRoomDetails().catch(() => {});
  }, 300);
}

async function persistRoomDetails() {
  const entries = [];
  for (const [key, detail] of state.roomDetails) {
    if (detail?.status !== "ok" || !Array.isArray(detail.rooms) || !detail.rooms.length) continue;
    entries.push({
      key,
      savedAt: Number(detail.savedAt) || Date.now(),
      status: "ok",
      rooms: detail.rooms,
      fromCache: Boolean(detail.fromCache),
      currency: detail.currency || null,
    });
  }
  entries.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const trimmed = entries.slice(0, MAX_ROOM_DETAILS);
  const map = {};
  for (const entry of trimmed) {
    map[entry.key] = {
      status: "ok",
      rooms: entry.rooms,
      fromCache: entry.fromCache,
      currency: entry.currency,
      savedAt: entry.savedAt,
    };
  }
  await storageSet({ [ROOM_DETAILS_KEY]: map });
}

async function loadPersistedRoomDetails() {
  const data = await storageGet([ROOM_DETAILS_KEY]);
  const map = data[ROOM_DETAILS_KEY];
  if (!map || typeof map !== "object") return;
  for (const [key, detail] of Object.entries(map)) {
    if (!detail?.rooms?.length) continue;
    if (state.roomDetails.has(key) && state.roomDetails.get(key)?.status === "ok") continue;
    state.roomDetails.set(key, {
      status: "ok",
      rooms: detail.rooms,
      fromCache: Boolean(detail.fromCache),
      currency: detail.currency || null,
      savedAt: Number(detail.savedAt) || Date.now(),
    });
  }
}

const ROOM_CACHE_LOOKUP_BATCH = 250;
let hydrateFnfTimer = null;
let hydrateFnfToken = 0;

/** Apply F&F compares for stays that already have shopAvail in the local room cache (no Hilton calls). */
function scheduleHydrateFnfComparesFromCache() {
  if (state.scanning) return;
  if (hydrateFnfTimer) clearTimeout(hydrateFnfTimer);
  hydrateFnfTimer = setTimeout(() => {
    hydrateFnfTimer = null;
    hydrateFnfComparesFromCache(state.allRows).catch(() => {});
  }, 40);
}

async function hydrateFnfComparesFromCache(rows) {
  const values = formValues();
  if (values.rateType === "tm") return;
  const friendsAndFamily = true;
  const token = ++hydrateFnfToken;
  let applied = reconcileShopPricesIntoRows();
  const stays = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.ctyhocn || row.error) continue;
    if (row.inventoryOnly && !row.stayPriced) continue;
    // Pull shop cache for advertised F&F leads (to correct teaser prices) and already shop-priced stays.
    if (!isFamilyAndFriendsRate(row) && !row.shopPriced) continue;
    const detailKey = roomDetailKey(row, friendsAndFamily);
    if (seen.has(detailKey)) continue;
    seen.add(detailKey);
    const existing = state.roomDetails.get(detailKey);
    if (existing?.status === "ok" && existing.rooms?.length) continue;
    const stay = stayDatesForRoomFetch(row);
    if (!stay?.arrivalDate || !stay?.departureDate) continue;
    stays.push({
      key: detailKey,
      ctyhocn: String(row.ctyhocn).toUpperCase(),
      arrivalDate: stay.arrivalDate,
      departureDate: stay.departureDate,
      friendsAndFamily,
    });
  }
  if (!stays.length) {
    if (applied > 0 && token === hydrateFnfToken) refreshTable();
    return;
  }

  for (let i = 0; i < stays.length; i += ROOM_CACHE_LOOKUP_BATCH) {
    if (token !== hydrateFnfToken || state.scanning) return;
    const chunk = stays.slice(i, i + ROOM_CACHE_LOOKUP_BATCH);
    const res = await sendMessage({
      type: "LOOKUP_CACHED_ROOM_RATES",
      stays: chunk.map(({ ctyhocn, arrivalDate, departureDate, friendsAndFamily: fnf }) => ({
        ctyhocn,
        arrivalDate,
        departureDate,
        friendsAndFamily: fnf,
      })),
    });
    if (token !== hydrateFnfToken || !res?.ok || !Array.isArray(res.results)) return;
    for (let j = 0; j < chunk.length; j += 1) {
      const hit = res.results[j];
      if (!hit?.rooms?.length) continue;
      const { key } = chunk[j];
      const existing = state.roomDetails.get(key);
      let did = false;
      if (!(existing?.status === "ok" && existing.rooms?.length)) {
        state.roomDetails.set(key, {
          status: "ok",
          rooms: hit.rooms,
          fromCache: true,
          currency: hit.currency || null,
          savedAt: Date.now(),
        });
        did = true;
      }
      if (syncRowsToShopRooms(key, hit.rooms, hit.currency || null)) did = true;
      if (did) applied += 1;
    }
  }
  if (applied > 0 && token === hydrateFnfToken) {
    schedulePersistRoomDetails();
    refreshTable();
  }
}

function clearRoomFetchQueue() {
  state.roomFetchPending = [];
  for (const [key, detail] of [...state.roomDetails.entries()]) {
    if (detail?.status === "queued") {
      if (detail.rooms?.length) {
        state.roomDetails.set(key, { ...detail, status: "ok" });
      } else {
        state.roomDetails.delete(key);
      }
    }
  }
}

function enqueueRoomRateFetch(row, { priority = false } = {}) {
  if (!row?.ctyhocn) return;
  const detailKey = roomDetailKey(row);
  const existing = state.roomDetails.get(detailKey);
  if (existing?.status === "ok") {
    // Already shopped — still align the entry price with bookable rates.
    syncRowsToShopRooms(detailKey, existing.rooms, existing.currency);
    return;
  }
  if (existing?.status === "loading" || existing?.status === "queued") {
    return;
  }
  state.roomDetails.set(detailKey, {
    status: "queued",
    rooms: existing?.rooms || [],
    fromCache: existing?.fromCache,
    currency: existing?.currency || null,
  });
  const item = { key: detailKey, row };
  if (priority) state.roomFetchPending.unshift(item);
  else state.roomFetchPending.push(item);
  pumpRoomFetches();
}

function pumpRoomFetches() {
  while (
    state.roomFetchInFlight < ROOM_FETCH_CONCURRENCY &&
    state.roomFetchPending.length
  ) {
    const { key, row } = state.roomFetchPending.shift();
    const existing = state.roomDetails.get(key);
    if (existing?.status === "ok" || existing?.status === "loading") continue;
    state.roomFetchInFlight += 1;
    Promise.resolve()
      .then(() => loadRoomRates(key, row))
      .finally(async () => {
        await new Promise((r) => setTimeout(r, ROOM_FETCH_DELAY_MS));
        state.roomFetchInFlight = Math.max(0, state.roomFetchInFlight - 1);
        pumpRoomFetches();
      });
  }
}

function inventoryRowsFromHotels(hotels) {
  return (hotels || [])
    .filter((h) => h?.ctyhocn)
    .map((h) => {
      const ctyhocn = String(h.ctyhocn).toUpperCase();
      return {
        ctyhocn,
        hotelName: h.name || ctyhocn,
        brandCode: h.brandCode || null,
        city: h.city || null,
        country: h.country || null,
        amount: h.amount ?? null,
        amountFmt: h.amountFmt || null,
        currency: h.currency || (h.amount != null ? "USD" : null),
        ratePlanCode: h.ratePlanCode || null,
        ratePlanName: h.ratePlanName || null,
        specialRateType: h.amount != null ? "lead" : null,
        isGoRate: false,
        roomsAvail: null,
        arrivalDate: null,
        departureDate: null,
        nights: null,
        inventoryOnly: true,
        bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
          ctyhocn
        )}`,
      };
    });
}

/** Rate matches / errors from the in-flight scan only (no unscanned placeholders). */
function rowsForScanProgress(rateRows) {
  return Array.isArray(rateRows) ? rateRows : [];
}

/** Hilton prices its results page 20 hotels at a time — mirror that batch size. */
const INVENTORY_RATE_PAGE_SIZE = 20;

function applyInventoryRates(rates, { arrivalDate, departureDate, nights }) {
  const byCtyhocn = new Map();
  for (const rate of rates || []) {
    if (rate?.ctyhocn) byCtyhocn.set(String(rate.ctyhocn).toUpperCase(), rate);
  }
  if (!byCtyhocn.size) return 0;

  let updated = 0;
  for (const row of state.allRows) {
    const rate = byCtyhocn.get(String(row.ctyhocn || "").toUpperCase());
    if (!rate) continue;
    const oldKey = rowKey(row);
    row.stayPriced = true;
    row.arrivalDate = arrivalDate;
    row.departureDate = departureDate;
    row.nights = nights;
    row.soldOut = Boolean(rate.soldOut);
    if (rate.amount != null) {
      row.amount = rate.amount;
      row.amountFmt = rate.amountFmt;
      row.currency = rate.currency || "USD";
      row.amountAfterTax = rate.amountAfterTax ?? null;
      row.ratePlanCode = rate.ratePlanCode;
      row.ratePlanName = rate.ratePlanName;
      row.specialRateType = rate.specialRateType;
      row.isGoRate = Boolean(rate.isGoRate);
    } else {
      row.amount = null;
      row.amountFmt = null;
      row.specialRateType = rate.soldOut ? "sold out" : row.specialRateType;
    }
    row.bookUrl = `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
      row.ctyhocn
    )}&arrivalDate=${encodeURIComponent(arrivalDate)}&departureDate=${encodeURIComponent(
      departureDate
    )}`;
    migrateRowKeyState(oldKey, rowKey(row));
    updated += 1;
  }
  return updated;
}

/**
 * Walk the inventory in pages of 20 and fill in Go rates for the stay, the same
 * shopMultiPropAvail pagination the Go Hilton results page uses.
 */
async function populateInventoryRates(placeLabel) {
  const values = formValues();
  const stay = values.ranges?.[0];
  const arrivalDate = stay?.from || values.fromDate;
  if (!arrivalDate) return;
  const nights = Math.max(1, Number(stay?.nights || values.nights) || 1);
  const departureDate = stay?.to || addDaysISO(arrivalDate, nights);
  const friendsAndFamily = values.rateType !== "tm";

  const codes = [
    ...new Set(state.allRows.map((r) => String(r.ctyhocn || "").toUpperCase()).filter(Boolean)),
  ];
  const total = codes.length;
  if (!total) return;

  let done = 0;
  let priced = 0;
  let failed = 0;
  for (let i = 0; i < total; i += INVENTORY_RATE_PAGE_SIZE) {
    if (state.stopRequested) {
      setStatus(`Stopped. ${formatCount(priced)} of ${formatCount(total)} hotels priced in ${placeLabel}.`, "warn");
      return;
    }
    const page = codes.slice(i, i + INVENTORY_RATE_PAGE_SIZE);
    const res = await sendMessage({
      type: "FETCH_INVENTORY_RATES",
      ctyhocns: page,
      arrivalDate,
      departureDate,
      numAdults: 1,
      numRooms: Math.max(1, Number(values.minRooms) || 1),
      friendsAndFamily,
    });
    if (res?.cancelled || state.stopRequested) {
      setStatus(`Stopped. ${formatCount(priced)} of ${formatCount(total)} hotels priced in ${placeLabel}.`, "warn");
      return;
    }
    if (res?.unauthorized) {
      markUnauthorized(res.error);
      return;
    }
    if (res?.ok) {
      priced += applyInventoryRates(res.rates, { arrivalDate, departureDate, nights });
      refreshTable();
    } else {
      failed += page.length;
    }
    done += page.length;
    setProgress((done / total) * 100);
    setStatus(
      `${placeLabel}: priced ${formatCount(priced)} of ${formatCount(total)} hotels for ${arrivalDate} → ${departureDate}…`
    );
  }

  const failBit = failed ? ` · ${formatCount(failed)} hotel(s) failed to price` : "";
  setProgress(100);
  setStatus(
    `Done. ${formatCount(total)} hotels in ${placeLabel} · ${formatCount(priced)} priced for ${nightsLabel(nights)} from ${arrivalDate}${failBit}. ${COUNTRY_ROOMS_HINT}`,
    failed ? "warn" : ""
  );
}

function isCountrySuggestionPick(picked) {
  return (
    picked?.type === "country" ||
    /^dx-location::country::/i.test(String(picked?.placeId || ""))
  );
}

function isLargeAreaSuggestionPick(picked) {
  return (
    isCountrySuggestionPick(picked) ||
    picked?.type === "region" ||
    (Boolean(picked?.state) && !picked?.city && !picked?.ctyhocn && !isCountrySuggestionPick(picked))
  );
}

/** Dates for on-demand room shop (inventory rows use the form stay window). */
function stayDatesForRoomFetch(row) {
  if (row?.arrivalDate && row?.departureDate) {
    return {
      arrivalDate: row.arrivalDate,
      departureDate: row.departureDate,
      nights: stayNightsFor(row),
    };
  }
  if (!row?.inventoryOnly) return null;
  const values = formValues();
  const stay = values.ranges?.[0];
  const arrivalDate = stay?.from || values.fromDate;
  if (!arrivalDate) return null;
  const nights = Math.max(1, Number(stay?.nights || values.nights) || 1);
  return {
    arrivalDate,
    departureDate: stay?.to || addDaysISO(arrivalDate, nights),
    nights,
  };
}

const COUNTRY_ROOMS_HINT =
  "Country-wide search: ▾ Available rooms aren’t loaded until you open a hotel you’re interested in.";

function toggleExpanded(key) {
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    refreshTable();
    return;
  }
  state.expanded.add(key);
  const row =
    state.rows.find((r) => rowKey(r) === key) ||
    state.allRows.find((r) => rowKey(r) === key);
  if (row) {
    const detail = state.roomDetails.get(roomDetailKey(row));
    // Already have rooms — keep them (and F&F compare) without reloading.
    if (detail?.status === "ok" && detail.rooms?.length) {
      syncRowsToShopRooms(roomDetailKey(row), detail.rooms, detail.currency);
    } else {
      enqueueRoomRateFetch(row, { priority: true });
    }
  }
  refreshTable();
}

function summarizeScanErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return [];
  const byMsg = new Map();
  for (const err of list) {
    const msg = String(err.message || err.error || "Unknown error").trim() || "Unknown error";
    if (!byMsg.has(msg)) byMsg.set(msg, []);
    const label = err.hotelName || err.ctyhocn || "Hotel";
    const withMonth = err.arrivalDate ? `${label} (${err.arrivalDate})` : label;
    byMsg.get(msg).push(withMonth);
  }
  return [...byMsg.entries()].map(([msg, hotels]) => {
    const sample = hotels.slice(0, 4).join(", ");
    const extra = hotels.length > 4 ? ` +${hotels.length - 4} more` : "";
    return { msg, count: hotels.length, sample: `${sample}${extra}` };
  });
}

function formatScanErrorStatus(errors) {
  const groups = summarizeScanErrors(errors);
  if (!groups.length) return "";
  return groups
    .map((g) => `${g.count} failed: ${String(g.msg || "").replace(/\.+$/, "")}`)
    .join(" · ");
}

function scanErrorsTooltipText(errors) {
  const groups = summarizeScanErrors(errors);
  if (!groups.length) return "";
  return groups
    .map((g) => `${g.count}× ${g.msg}${g.sample ? `\n${g.sample}` : ""}`)
    .join("\n\n");
}

function scanErrorsTooltipHtml(errors) {
  const groups = summarizeScanErrors(errors);
  if (!groups.length) return "";
  return groups
    .map(
      (g) =>
        `<div class="results-failed-group">
          <div class="results-failed-msg"><strong>${formatCount(g.count)}×</strong> ${escapeHtml(g.msg)}</div>
          ${g.sample ? `<div class="results-failed-hotels">${escapeHtml(g.sample)}</div>` : ""}
        </div>`
    )
    .join("");
}

function resultsFailedBitHtml(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return "";
  const tipText = scanErrorsTooltipText(list);
  return ` · <span class="results-failed" tabindex="0" aria-label="${escapeHtml(
    `${formatCount(list.length)} failed. ${tipText}`
  )}"><span class="results-failed-label">${formatCount(
    list.length
  )} failed</span><span class="results-failed-tip" role="tooltip">${scanErrorsTooltipHtml(
    list
  )}</span></span>`;
}

function setResultsLabel(baseLabel, { failedCount = 0 } = {}) {
  const el = $("resultsLabel");
  if (!el) return;
  if (failedCount > 0) {
    el.innerHTML = `${escapeHtml(baseLabel)}${resultsFailedBitHtml(state.scanErrors)}`;
  } else {
    el.textContent = baseLabel;
  }
}

function scanErrorsHtml(errors) {
  const groups = summarizeScanErrors(errors);
  if (!groups.length) return "";
  const items = groups
    .map(
      (g) =>
        `<li>
          <div class="scan-error-title"><strong>${g.count}×</strong> ${escapeHtml(g.msg)}</div>
          <div class="scan-error-hotels">(${escapeHtml(g.sample)})</div>
        </li>`
    )
    .join("");
  return `<ul class="scan-errors">${items}</ul>`;
}

function uniqueHotelCount(rows) {
  return new Set(
    (rows || []).map((r) => String(r.ctyhocn || "").toUpperCase()).filter(Boolean)
  ).size;
}

function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Math.trunc(n).toLocaleString("en-US");
}

function resultsCountLabel(visibleRows, { totalRows = null, filtersActive = false } = {}) {
  const list = visibleRows || [];
  const priced = list.filter((r) => !r.inventoryOnly);
  const stays = priced.length;
  const hotels = uniqueHotelCount(priced.length ? priced : list);
  const cached = priced.filter((r) => r.fromCache).length;
  if (!priced.length && hotels) {
    return `${formatCount(hotels)} hotel${hotels === 1 ? "" : "s"}`;
  }
  if (!priced.length) {
    return "0 stays • 0 hotels matching";
  }
  const staysCore =
    filtersActive && totalRows != null && stays !== totalRows
      ? `${formatCount(stays)} of ${formatCount(totalRows)} stays`
      : `${formatCount(stays)} stay${stays === 1 ? "" : "s"}`;
  const cacheBit = cached > 0 ? ` (${formatCount(cached)} from cache)` : "";
  return `${staysCore}${cacheBit} • ${formatCount(hotels)} hotel${hotels === 1 ? "" : "s"} matching`;
}

function totalPagesFor(rowCount) {
  const size = Math.max(1, Number(state.pageSize) || 25);
  return Math.max(1, Math.ceil(Math.max(0, rowCount) / size));
}

function clampResultsPage(rowCount) {
  const totalPages = totalPagesFor(rowCount);
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;
  return totalPages;
}

function pageRows(rows) {
  const list = rows || [];
  clampResultsPage(list.length);
  const size = Math.max(1, Number(state.pageSize) || 25);
  const start = state.page * size;
  return list.slice(start, start + size);
}

function updatePagerUi(rowCount) {
  const pager = $("resultsPager");
  const prev = $("pagePrev");
  const next = $("pageNext");
  const meta = $("pageMeta");
  const rangeLabel = $("pageRangeLabel");
  const totalLabel = $("pageTotalLabel");
  const pageJump = $("pageJump");
  const sizeSelect = $("pageSize");
  if (!pager || !prev || !next || !meta) return;

  if (sizeSelect && String(sizeSelect.value) !== String(state.pageSize)) {
    sizeSelect.value = String(state.pageSize);
  }

  const total = Math.max(0, rowCount || 0);
  if (!total) {
    pager.hidden = true;
    prev.disabled = true;
    next.disabled = true;
    if (rangeLabel) rangeLabel.textContent = "";
    if (totalLabel) totalLabel.textContent = "";
    if (pageJump) pageJump.value = "";
    return;
  }

  pager.hidden = false;
  const totalPages = clampResultsPage(total);
  const size = Math.max(1, Number(state.pageSize) || 25);
  const start = state.page * size + 1;
  const end = Math.min(total, (state.page + 1) * size);
  if (rangeLabel) {
    rangeLabel.textContent = `${formatCount(start)}–${formatCount(end)} of ${formatCount(total)} ·`;
  }
  if (totalLabel) totalLabel.textContent = `of ${formatCount(totalPages)}`;
  if (pageJump) {
    pageJump.max = String(totalPages);
    // Don't fight the user while they're typing in this field.
    if (document.activeElement !== pageJump) {
      pageJump.value = String(state.page + 1);
    }
  }
  prev.disabled = state.page <= 0;
  next.disabled = state.page >= totalPages - 1;
}

function jumpToResultsPage(rawValue) {
  const totalPages = totalPagesFor(state.rows.length);
  if (!totalPages || !state.rows.length) return;
  const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    updatePagerUi(state.rows.length);
    return;
  }
  const nextPage = Math.min(totalPages, Math.max(1, parsed)) - 1;
  if (nextPage === state.page) {
    updatePagerUi(state.rows.length);
    return;
  }
  state.page = nextPage;
  refreshTable();
}

function refreshTable() {
  // ShopAvail is authoritative once rooms are known — don't leave calendar teaser prices.
  if (!state._reconcilingShop) {
    state._reconcilingShop = true;
    try {
      reconcileShopPricesIntoRows();
    } finally {
      state._reconcilingShop = false;
    }
  }
  updateColumnFilterUi();
  const filtered = filterResultRows(state.allRows);
  state.rows = sortedRows(filtered);
  const validKeys = new Set(state.rows.map(rowKey));
  state.expanded = new Set([...state.expanded].filter((k) => validKeys.has(k)));

  const body = $("resultsBody");
  $("exportBtn").disabled = !state.rows.length;
  updateSortHeaders();

  const filtersActive =
    state.dowSelected.size > 0 || anyColumnFilterActive() || Boolean(getTripPairStayConstraint());

  if (!state.rows.length) {
    let emptyMsg = state.allRows.length
      ? filtersActive
        ? getTripPairStayConstraint()
          ? "No hotel stays match the selected flight dates."
          : "No nights match the current filters."
        : "No matching Go rates in range."
      : state.scanErrors.length
        ? `No matching nights. ${formatCount(state.scanErrors.length)} hotel request(s) failed.`
        : "No matching Go rates in range.";
    body.innerHTML = `<tr class="empty"><td colspan="9"><div class="empty-msg">${escapeHtml(
      emptyMsg
    )}</div>${scanErrorsHtml(state.scanErrors)}</td></tr>`;
    const emptyLabel = state.allRows.length
      ? resultsCountLabel([], {
          totalRows: state.allRows.length,
          filtersActive: true,
        })
      : "0 stays • 0 hotels matching";
    setResultsLabel(emptyLabel, { failedCount: state.scanErrors.length });
    updatePagerUi(0);
    updateTripSummary();
    return;
  }

  const label = resultsCountLabel(state.rows, {
    totalRows: state.allRows.length,
    filtersActive,
  });
  setResultsLabel(label, { failedCount: state.scanErrors.length });

  const visible = pageRows(state.rows);
  updatePagerUi(state.rows.length);

  body.innerHTML = visible
    .map((row) => {
      const key = rowKey(row);
      const open = state.expanded.has(key);
      const badge = row.inventoryOnly && !row.stayPriced
        ? `<span class="badge">lead</span>`
        : row.isGoRate
          ? `<span class="badge go">${escapeHtml(row.specialRateType || "go")}</span>`
          : `<span class="badge">${escapeHtml(row.specialRateType || "other")}</span>`;
      const cacheIcon = row.inventoryOnly ? "" : cacheIconHtml(row, key);
      const nights = stayNightsFor(row);
      const detail = state.roomDetails.get(roomDetailKey(row));
      let mainCompare = null;
      if (
        !row.inventoryOnly &&
        isFamilyAndFriendsRate(row) &&
        detail?.rooms?.length
      ) {
        const sameType = row.roomTypeCode
          ? detail.rooms.filter(
              (r) =>
                String(r.roomTypeCode || "").toUpperCase() ===
                String(row.roomTypeCode || "").toUpperCase()
            )
          : [];
        mainCompare = findNextHigherDifferentPlan(
          row,
          sameType.length ? sameType : detail.rooms
        );
      }
      const details = detailItems(row, mainCompare)
        .map(
          ([labelText, value]) =>
            `<div class="detail-item"><dt>${escapeHtml(labelText)}</dt><dd>${escapeHtml(value)}</dd></div>`
        )
        .join("");
      const dateLabel = row.arrivalDate || "—";
      const selected = state.selectedHotelKey === key;
      const bestCombo = !isHotelSearchMode() && state.bestComboHotelKey === key;
      const optimalTag = bestCombo
        ? `<span class="most-optimal-tag" title="Price optimal for this trip">PRICE OPTIMAL</span>`
        : "";
      return `<tr class="result-row${open ? " open" : ""}${
        selected ? " is-trip-selected" : ""
      }${bestCombo ? " is-best-combo" : ""}" data-row-key="${escapeHtml(key)}" tabindex="0" aria-expanded="${open ? "true" : "false"}">
        <td class="select-col">${hotelSelectButtonHtml(row, key)}</td>
        <td class="date-cell">${cacheIcon}${escapeHtml(dateLabel)}</td>
        <td>
          <div class="hotel-name">${escapeHtml(row.hotelName)}</div>
          ${optimalTag}
          <div class="hotel-code">${escapeHtml(row.ctyhocn)}</div>
        </td>
        <td>${escapeHtml(row.brandCode || "—")}</td>
        <td>${escapeHtml(row.city || "—")}</td>
        <td class="rate">${
          row.inventoryOnly && !row.stayPriced
            ? rateDisplayHtml(row.amount, row.currency, row.amountFmt, null, null)
            : rateDisplayHtml(row.amount, row.currency, row.amountFmt, nights, mainCompare)
        }</td>
        <td>${escapeHtml(row.roomsAvail ?? "—")}</td>
        <td><div class="rate-plan-cell">${badge}<div class="hotel-code">${escapeHtml(row.ratePlanName || "")}</div></div></td>
        <td><a class="book-link" href="${escapeHtml(row.bookUrl)}" target="_blank" rel="noopener">Book</a></td>
      </tr>
      <tr class="detail-row${open ? " open" : ""}"${open ? "" : " hidden"}>
        <td colspan="9">
          <div class="detail-panel">
            <dl class="detail-grid">${details}</dl>
            ${open ? roomsSectionHtml(key, row) : ""}
            <div class="detail-actions">
              <a class="book-link" href="${escapeHtml(row.bookUrl)}" target="_blank" rel="noopener">Open booking</a>
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join("");
  updateTripSummary();
}

function setHotelResultsVisible(visible) {
  setSectionVisible("hotelResults", visible);
}

function setSectionVisible(id, visible) {
  const el = $(id);
  if (!el) return;
  if (visible) {
    el.hidden = false;
    el.removeAttribute("hidden");
  } else {
    el.hidden = true;
    el.setAttribute("hidden", "");
  }
}

/** Flight+hotel mode always shows award travel + hotel stays shells; hotel mode hides award travel. */
function syncFlightHotelResultsLayout() {
  const flightMode = !isHotelSearchMode();
  setSectionVisible("flightResultsHeading", flightMode);
  setSectionVisible("flightResults", flightMode);
  setSectionVisible("hotelResultsHeading", flightMode);
  setHotelResultsVisible(true);
}

function setAwardTravelVisible(visible) {
  const show = Boolean(visible) && !isHotelSearchMode();
  setSectionVisible("flightResultsHeading", show);
  setSectionVisible("flightResults", show);
}

function renderRows(rows, { syncSession = true, resetPage = false } = {}) {
  const incoming = Array.isArray(rows) ? rows : [];
  if (resetPage) state.page = 0;
  state.scanErrors = incoming.filter((r) => r.error);
  state.allRows = incoming.filter((r) => !r.error);
  if (
    state.selectedHotelKey &&
    !state.allRows.some((r) => rowKey(r) === state.selectedHotelKey)
  ) {
    clearTripHotelSelection({ silent: true });
  }
  // Show the hotel results card once a search has started or returned rows.
  if (state.scanning || incoming.length || state.allRows.length || state.scanErrors.length) {
    setHotelResultsVisible(true);
  }
  refreshTable();
  // F&F strike-through for stays that already have shopAvail cached locally.
  if (!state.scanning) scheduleHydrateFnfComparesFromCache();
  if (syncSession && scanErrorsAreUnauthorized(state.scanErrors)) {
    markUnauthorized("Hilton session expired. Sign in again to continue.");
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function exportCsv() {
  if (!state.rows.length) return;
  const headers = [
    "arrivalDate",
    "departureDate",
    "hotelName",
    "ctyhocn",
    "brandCode",
    "city",
    "amount",
    "currency",
    "roomsAvail",
    "specialRateType",
    "ratePlanName",
    "ratePlanCode",
    "bookUrl",
  ];
  const lines = [headers.join(",")];
  for (const row of state.rows) {
    lines.push(
      headers
        .map((key) => {
          const s = String(row[key] ?? "");
          return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        })
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dest = $("destination").value.trim().replace(/[^\w]+/g, "-").slice(0, 40) || "rates";
  a.href = url;
  a.download = `go-plus-${dest}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function hideSuggestions() {
  const panel = $("destinationSuggest");
  const input = $("destination");
  panel.hidden = true;
  panel.innerHTML = "";
  input.setAttribute("aria-expanded", "false");
  state.suggestItems = [];
  state.suggestIndex = -1;
}

function sectionTitle(type) {
  if (type === "hotel") return "Hotels";
  if (type === "airport") return "Airports";
  if (type === "poi") return "Places";
  if (type === "country") return "Countries";
  if (type === "region") return "States / regions";
  if (type === "destination") return "Cities";
  if (type === "recent") return "Recent searches";
  if (type === "cached") return "Local cache";
  return "Destinations";
}

function storageGet(keys) {
  return new Promise((resolve) => {
    if (chrome?.storage?.local) {
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
    if (chrome?.storage?.local) {
      chrome.storage.local.set(obj, () => resolve());
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    resolve();
  });
}

async function loadRecentSearches() {
  const data = await storageGet([RECENT_SEARCHES_KEY]);
  const list = Array.isArray(data[RECENT_SEARCHES_KEY]) ? data[RECENT_SEARCHES_KEY] : [];
  state.recentSearches = list.slice(0, MAX_RECENT_SEARCHES);
  return state.recentSearches;
}

async function persistRecentSearches(list) {
  state.recentSearches = list.slice(0, MAX_RECENT_SEARCHES);
  await storageSet({ [RECENT_SEARCHES_KEY]: state.recentSearches });
}

function searchFingerprint(entry) {
  const sug = entry.selectedSuggestion;
  const rangesKey = (entry.ranges || [])
    .map((r) =>
      r.mode === "window"
        ? `${r.from}_${r.to}_w${Number(r.nights) || 1}`
        : `${r.from}_${r.to}`
    )
    .join(",");
  return [
    entry.searchMode || "hotel",
    entry.destination || "",
    rangesKey || `${entry.fromDate || ""}_${entry.toDate || ""}`,
    entry.maxRate ?? "",
    entry.minRooms ?? "",
    entry.rateType || "",
    sug?.ctyhocn || sug?.placeId || sug?.query || "",
    entry.flightOrigins || "",
    entry.flightDestinations || "",
    entry.flightStartDate || "",
    entry.flightEndDate || "",
    encodeRangesParam(entry.flightRanges || []),
    entry.flightTripType || "roundtrip",
  ].join("|");
}

function snapshotFromForm() {
  const values = formValues();
  const sug = state.selectedSuggestion;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    searchMode: values.searchMode,
    destination: values.destination,
    ranges: values.ranges,
    fromDate: values.fromDate,
    toDate: values.toDate,
    maxRate: values.maxRate,
    minRooms: values.minRooms,
    rateType: values.rateType,
    flightOrigins: values.flightOrigins,
    flightDestinations: values.flightDestinations,
    flightStartDate: values.flightStartDate,
    flightEndDate: values.flightEndDate,
    flightRanges: values.flightRanges || [],
    flightTripType: values.flightTripType || "roundtrip",
    selectedSuggestion: sug
      ? {
          type: sug.type || null,
          query: sug.query || null,
          primary: sug.primary || null,
          secondary: sug.secondary || null,
          label: sug.label || null,
          ctyhocn: sug.ctyhocn || null,
          placeId: sug.placeId || null,
          city: sug.city || null,
          country: sug.country || null,
          state: sug.state || null,
        }
      : null,
  };
}

async function rememberCurrentSearch() {
  const entry = snapshotFromForm();
  if (entry.searchMode === "flight") {
    if (!entry.flightOrigins || !entry.flightDestinations) return;
    const trips = enrichRanges(entry.flightRanges || []);
    if (!trips.length && !(entry.flightStartDate && entry.flightEndDate)) return;
  } else {
    if (!entry.destination) return;
    const cached = /^cached$/i.test(entry.destination) || entry.selectedSuggestion?.type === "cached";
    if (!cached && !entry.ranges?.length) return;
  }
  const fp = searchFingerprint(entry);
  const next = [entry, ...state.recentSearches.filter((r) => searchFingerprint(r) !== fp)];
  await persistRecentSearches(next);
}

async function removeRecentSearch(id) {
  await persistRecentSearches(state.recentSearches.filter((r) => r.id !== id));
}

function formatRecentMeta(entry) {
  const bits = [];
  if (entry.searchMode === "flight") {
    bits.push(entry.flightTripType === "oneway" ? "One-way" : "Round-trip");
    bits.push(`${entry.flightOrigins || "?"} → ${entry.flightDestinations || "?"}`);
    const trips = enrichRanges(entry.flightRanges || []);
    if (trips.length > 1) {
      bits.push(formatRangesSummary(trips).replace(/stays?/g, "trips"));
    } else if (trips[0]) {
      bits.push(`${trips[0].from}→${trips[0].to}`);
    } else if (entry.flightStartDate && entry.flightEndDate) {
      bits.push(`${entry.flightStartDate}→${entry.flightEndDate}`);
    }
  } else {
    const ranges =
      entry.ranges?.length
        ? entry.ranges
        : entry.fromDate && entry.toDate
          ? [{ from: entry.fromDate, to: entry.toDate }]
          : entry.fromDate && entry.nights
            ? [{ from: entry.fromDate, to: addDaysISO(entry.fromDate, entry.nights) }]
            : [];
    bits.push(formatRangesSummary(ranges));
  }
  if (entry.maxRate != null && entry.maxRate !== "") bits.push(`max ${entry.maxRate}`);
  bits.push(entry.rateType === "tm" ? "Team Member" : "F&F");
  return bits.join(" · ");
}

function applySearchSnapshot(entry) {
  const mode = entry.searchMode === "flight" ? "flight" : "hotel";
  setSearchMode(mode);
  $("destination").value = entry.destination || "";
  let ranges =
    entry.ranges?.length
      ? entry.ranges
      : entry.fromDate && entry.toDate
        ? [{ from: entry.fromDate, to: entry.toDate }]
        : [];
  if (!ranges.length && entry.fromDate && entry.nights) {
    ranges = [{ from: entry.fromDate, to: addDaysISO(entry.fromDate, entry.nights) }];
  }
  setDateRanges(ranges);
  $("maxRate").value = entry.maxRate == null || entry.maxRate === "" ? "" : String(entry.maxRate);
  $("minRooms").value = String(parseMinRooms(entry.minRooms, 1));
  $("rateType").value = entry.rateType || "fnf";
  updateRateTypeUi();
  if ($("flightOrigins")) setIataCodes("flightOrigins", entry.flightOrigins || "");
  if ($("flightDestinations")) setIataCodes("flightDestinations", entry.flightDestinations || "");
  const tripRanges =
    entry.flightRanges?.length
      ? entry.flightRanges
      : entry.flightStartDate && entry.flightEndDate
        ? [{ from: entry.flightStartDate, to: entry.flightEndDate, mode: "exact" }]
        : [];
  setDateRanges(tripRanges, "flightDateRanges");
  setFlightTripType(entry.flightTripType === "oneway" ? "oneway" : "roundtrip");
  state.selectedSuggestion = entry.selectedSuggestion || null;
  writeParams(formValues());
}

function filteredRecentSearches(query, { mode = null } = {}) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  const wantedMode = mode || formValues().searchMode || "hotel";
  const list = state.recentSearches.filter((entry) => {
    const entryMode = entry.searchMode === "flight" ? "flight" : "hotel";
    return entryMode === wantedMode;
  });
  if (!q) return list;
  return list.filter((entry) => {
    const hay = [
      entry.destination,
      entry.flightOrigins,
      entry.flightDestinations,
      entry.selectedSuggestion?.primary,
      entry.selectedSuggestion?.secondary,
      entry.selectedSuggestion?.query,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

const CACHED_SUGGESTION = {
  id: "goplus:cached",
  type: "cached",
  kind: "suggestion",
  label: "Cached",
  primary: "Cached",
  secondary: "Search all cached rates",
  query: "Cached",
  placeId: null,
  ctyhocn: null,
};

function isCachedSuggestion(item) {
  return (
    item?.type === "cached" ||
    item?.id === "goplus:cached" ||
    /^cached$/i.test(String(item?.query || item?.primary || ""))
  );
}

function renderRecentSearches(query = "") {
  const panel = $("destinationSuggest");
  const input = $("destination");
  const q = String(query || "").trim().toLowerCase();
  const showCached = !q || "cached".startsWith(q) || q.includes("cach");
  const recents = filteredRecentSearches(query, { mode: "hotel" });
  if (!showCached && !recents.length) {
    hideSuggestions();
    return;
  }

  const flat = [];
  let html = "";

  if (showCached) {
    html += `<div class="suggest-section"><div class="suggest-section-title">${sectionTitle(
      "cached"
    )}</div>`;
    const idx = flat.length;
    flat.push({ ...CACHED_SUGGESTION });
    html += `<button type="button" class="suggest-item" role="option" data-index="${idx}">
      <span class="suggest-primary">${escapeHtml(CACHED_SUGGESTION.primary)}</span>
      <span class="suggest-secondary">${escapeHtml(CACHED_SUGGESTION.secondary)}</span>
    </button></div>`;
  }

  if (recents.length) {
    html += `<div class="suggest-section"><div class="suggest-section-title">${sectionTitle("recent")}</div>`;
    for (const entry of recents) {
      const idx = flat.length;
      flat.push({ kind: "recent", entry });
      const primary =
        entry.searchMode === "flight"
          ? `${entry.flightOrigins || "?"} → ${entry.flightDestinations || "?"}`
          : entry.destination;
      html += `<div class="recent-row">
      <button type="button" class="suggest-item recent-item" role="option" data-index="${idx}">
        <span class="suggest-primary">${escapeHtml(primary)}</span>
        <span class="suggest-secondary">${escapeHtml(formatRecentMeta(entry))}</span>
      </button>
      <button type="button" class="recent-remove" data-recent-id="${escapeHtml(
        entry.id
      )}" aria-label="Remove recent search" title="Remove">×</button>
    </div>`;
    }
    html += `</div>`;
  }

  state.suggestItems = flat;
  state.suggestIndex = -1;
  panel.innerHTML = html;
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");

  panel.querySelectorAll(".suggest-item").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const item = flat[Number(btn.dataset.index)];
      if (!item) return;
      if (item.kind === "recent") selectRecentSearch(item.entry);
      else selectSuggestion(item);
    });
  });
  panel.querySelectorAll(".recent-remove").forEach((btn) => {
    btn.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await removeRecentSearch(btn.dataset.recentId);
      renderRecentSearches($("destination").value);
    });
  });
}

function selectRecentSearch(entry) {
  closeFlightRecentPanel();
  hideSuggestions();
  applySearchSnapshot(entry);
}

function closeFlightRecentPanel() {
  const panel = $("flightRecentPanel");
  const btn = $("flightRecentBtn");
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function renderFlightRecentSearches() {
  const panel = $("flightRecentPanel");
  const btn = $("flightRecentBtn");
  if (!panel || !btn) return;
  const recents = filteredRecentSearches("", { mode: "flight" });
  if (!recents.length) {
    panel.innerHTML = `<div class="suggest-empty">No recent flight + hotel searches yet.</div>`;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    return;
  }

  let html = `<div class="suggest-section"><div class="suggest-section-title">${sectionTitle(
    "recent"
  )}</div>`;
  for (const entry of recents) {
    const primary = `${entry.flightOrigins || "?"} → ${entry.flightDestinations || "?"}`;
    html += `<div class="recent-row">
      <button type="button" class="suggest-item recent-item" role="option" data-recent-apply="${escapeHtml(
        entry.id
      )}">
        <span class="suggest-primary">${escapeHtml(primary)}</span>
        <span class="suggest-secondary">${escapeHtml(formatRecentMeta(entry))}</span>
      </button>
      <button type="button" class="recent-remove" data-recent-id="${escapeHtml(
        entry.id
      )}" aria-label="Remove recent search" title="Remove">×</button>
    </div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");

  panel.querySelectorAll("[data-recent-apply]").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const entry = state.recentSearches.find((r) => r.id === el.dataset.recentApply);
      if (entry) selectRecentSearch(entry);
    });
  });
  panel.querySelectorAll(".recent-remove").forEach((el) => {
    el.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await removeRecentSearch(el.dataset.recentId);
      renderFlightRecentSearches();
    });
  });
}

async function toggleFlightRecentPanel() {
  const panel = $("flightRecentPanel");
  if (!panel) return;
  if (!panel.hidden) {
    closeFlightRecentPanel();
    return;
  }
  await loadRecentSearches();
  renderFlightRecentSearches();
}

function setupFlightRecentSearches() {
  $("flightRecentBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFlightRecentPanel();
  });
  $("flightRecentPanel")?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (e.target.closest("#flightRecentBtn, #flightRecentPanel")) return;
    closeFlightRecentPanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFlightRecentPanel();
  });
}

function renderSuggestions(suggestions) {
  const panel = $("destinationSuggest");
  const input = $("destination");
  if (!suggestions.length) {
    panel.hidden = false;
    panel.innerHTML = `<div class="suggest-empty">No results found</div>`;
    input.setAttribute("aria-expanded", "true");
    state.suggestItems = [];
    state.suggestIndex = -1;
    return;
  }

  // Preserve Hilton autocomplete order (not regrouped).
  const flat = suggestions.map((item) => ({ kind: "suggestion", ...item }));
  const html = flat
    .map((item, idx) => {
      const meta = item.secondary || sectionTitle(item.type);
      return `<button type="button" class="suggest-item" role="option" data-index="${idx}">
        <span class="suggest-primary">${escapeHtml(item.primary)}</span>
        <span class="suggest-secondary">${escapeHtml(meta)}</span>
      </button>`;
    })
    .join("");

  state.suggestItems = flat;
  state.suggestIndex = -1;
  panel.innerHTML = html;
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");

  panel.querySelectorAll(".suggest-item").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const item = flat[Number(btn.dataset.index)];
      if (item) selectSuggestion(item);
    });
  });
}

function highlightSuggestion(index) {
  const items = $("destinationSuggest").querySelectorAll(".suggest-item");
  items.forEach((el) => el.classList.remove("active"));
  if (index < 0 || index >= items.length) {
    state.suggestIndex = -1;
    return;
  }
  state.suggestIndex = index;
  items[index].classList.add("active");
  items[index].scrollIntoView({ block: "nearest" });
}

function selectSuggestion(item) {
  state.selectedSuggestion = item;
  $("destination").value = item.query || item.label || item.primary;
  hideSuggestions();
}

/** Mirror Hilton "Where to?" ranking for free-text submit. */
function pickBestDestinationSuggestion(suggestions, query) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length) return null;
  const q = String(query || "").trim().toLowerCase();
  if (/^cached$/i.test(q)) {
    return list.find(isCachedSuggestion) || CACHED_SUGGESTION;
  }
  const scored = list.map((s) => {
    const primary = String(s.primary || "").toLowerCase();
    const label = String(s.label || s.query || "").toLowerCase();
    const city = String(s.city || "").toLowerCase();
    const isCountry =
      s.type === "country" || /^dx-location::country::/i.test(String(s.placeId || ""));
    const isRegion =
      s.type === "region" ||
      (Boolean(s.state) && !s.city && !s.ctyhocn && !isCountry);
    let score = 0;
    if (isCachedSuggestion(s)) score -= 200;
    if (primary === q || label === q) score += 120;
    if (city === q) score += isCountry ? 0 : 40;
    if (primary.startsWith(q) || (!isCountry && city.startsWith(q))) score += 60;
    if (label.includes(q)) score += 20;
    if (isCountry) score += 90;
    else if (s.type === "destination") score += 40;
    else if (isRegion) score += 30;
    else if (s.type === "hotel") score += 25;
    else if (s.type === "airport") score += 10;
    else if (s.type === "poi") score += 8;
    if (s.placeId) score += 15;
    if (!isCountry && city === q && String(s.countryCode || "").toUpperCase() === "US") {
      score -= 100;
    }
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].s : list[0];
}

async function fetchSuggestions(query) {
  const reqId = ++state.suggestReq;
  const res = await sendMessage({
    type: "AUTOCOMPLETE_DESTINATION",
    query,
    limit: 20,
  });
  if (reqId !== state.suggestReq) return;
  if (!res.ok) {
    hideSuggestions();
    return;
  }
  renderSuggestions(res.suggestions || []);
}

function setupDestinationAutocomplete() {
  const input = $("destination");

  input.addEventListener("focus", () => {
    const q = input.value.trim();
    if (q.length < 2) renderRecentSearches(q);
  });

  input.addEventListener("input", () => {
    state.selectedSuggestion = null;
    const q = input.value.trim();
    clearTimeout(state.suggestTimer);
    if (q.length < 2) {
      renderRecentSearches(q);
      return;
    }
    state.suggestTimer = setTimeout(() => fetchSuggestions(q), 180);
  });

  input.addEventListener("keydown", (e) => {
    if ($("destinationSuggest").hidden || !state.suggestItems.length) {
      if (e.key === "Escape") hideSuggestions();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightSuggestion(Math.min(state.suggestIndex + 1, state.suggestItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightSuggestion(Math.max(state.suggestIndex - 1, 0));
    } else if (e.key === "Enter" && state.suggestIndex >= 0) {
      e.preventDefault();
      const item = state.suggestItems[state.suggestIndex];
      if (item?.kind === "recent") selectRecentSearch(item.entry);
      else if (item) selectSuggestion(item);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(hideSuggestions, 120);
  });
}

const IATA_FIELDS = ["flightOrigins", "flightDestinations"];

const iataTagState = {
  flightOrigins: [],
  flightDestinations: [],
};

function parseIataCodes(value) {
  return [
    ...new Set(
      String(value || "")
        .toUpperCase()
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => /^[A-Z]{3}$/.test(s))
    ),
  ];
}

function getIataCodes(fieldId) {
  return [...(iataTagState[fieldId] || [])];
}

function iataTagsEl(fieldId) {
  return $(`${fieldId}Tags`);
}

function renderIataTags(fieldId) {
  const tagsEl = iataTagsEl(fieldId);
  const input = $(fieldId);
  if (!tagsEl || !input) return;
  const codes = getIataCodes(fieldId);
  tagsEl.innerHTML = codes
    .map(
      (code) =>
        `<span class="iata-tag" data-code="${escapeHtml(code)}">
          <span class="iata-tag-label">${escapeHtml(code)}</span>
          <button type="button" class="iata-tag-remove" data-remove-iata="${escapeHtml(
            code
          )}" aria-label="Remove ${escapeHtml(code)}">×</button>
        </span>`
    )
    .join("");
  input.placeholder = codes.length ? "" : fieldId === "flightOrigins" ? "SFO" : "JFK";
  tagsEl.querySelectorAll("[data-remove-iata]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeIataCode(fieldId, btn.getAttribute("data-remove-iata"));
    });
  });
}

function setIataCodes(fieldId, valueOrList) {
  const codes = Array.isArray(valueOrList) ? valueOrList : parseIataCodes(valueOrList);
  iataTagState[fieldId] = [
    ...new Set(codes.map((c) => String(c || "").toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c))),
  ];
  const input = $(fieldId);
  if (input) input.value = "";
  renderIataTags(fieldId);
}

function addIataCode(fieldId, code) {
  const next = String(code || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(next)) return false;
  const list = getIataCodes(fieldId);
  if (list.includes(next)) return false;
  iataTagState[fieldId] = [...list, next];
  const input = $(fieldId);
  if (input) input.value = "";
  renderIataTags(fieldId);
  writeParams(formValues());
  updateSeatsApiCostHint();
  return true;
}

function removeIataCode(fieldId, code) {
  const target = String(code || "").toUpperCase();
  iataTagState[fieldId] = getIataCodes(fieldId).filter((c) => c !== target);
  renderIataTags(fieldId);
  writeParams(formValues());
  updateSeatsApiCostHint();
  $(fieldId)?.focus();
}

function commitIataToken(fieldId, { preferSuggestion = false } = {}) {
  const input = $(fieldId);
  if (!input) return false;
  if (preferSuggestion && state.iataIndex >= 0 && state.iataItems[state.iataIndex]) {
    selectIataSuggestion(fieldId, state.iataItems[state.iataIndex]);
    return true;
  }
  const token = String(input.value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(token)) return false;
  const added = addIataCode(fieldId, token);
  hideIataSuggestions(fieldId);
  return added;
}

function iataSuggestPanel(fieldId) {
  return $(`${fieldId}Suggest`);
}

function hideIataSuggestions(fieldId = null) {
  for (const id of IATA_FIELDS) {
    if (fieldId && id !== fieldId) continue;
    const panel = iataSuggestPanel(id);
    const input = $(id);
    if (!panel || !input) continue;
    panel.hidden = true;
    panel.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  }
  if (!fieldId || state.iataField === fieldId) {
    state.iataItems = [];
    state.iataIndex = -1;
    state.iataField = null;
  }
}

function highlightIataSuggestion(index) {
  const fieldId = state.iataField;
  const panel = fieldId ? iataSuggestPanel(fieldId) : null;
  if (!panel) return;
  const items = panel.querySelectorAll(".suggest-item");
  items.forEach((el) => el.classList.remove("active"));
  if (index < 0 || index >= items.length) {
    state.iataIndex = -1;
    return;
  }
  state.iataIndex = index;
  items[index].classList.add("active");
  items[index].scrollIntoView({ block: "nearest" });
}

function selectIataSuggestion(fieldId, item) {
  const input = $(fieldId);
  if (!input || !item) return;
  if (item.kind === "country" && Array.isArray(item.codes)) {
    for (const code of item.codes) addIataCode(fieldId, code);
  } else if (item.code) {
    addIataCode(fieldId, item.code);
  } else {
    return;
  }
  hideIataSuggestions(fieldId);
  input.focus();
}

function renderIataSuggestions(fieldId, items) {
  const panel = iataSuggestPanel(fieldId);
  const input = $(fieldId);
  if (!panel || !input) return;
  const existing = new Set(getIataCodes(fieldId));
  const filtered = items.filter((item) => {
    if (item?.kind === "country" && Array.isArray(item.codes)) {
      return item.codes.some((c) => !existing.has(String(c).toUpperCase()));
    }
    return item?.code && !existing.has(String(item.code).toUpperCase());
  });
  if (!filtered.length) {
    panel.hidden = true;
    panel.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    state.iataItems = [];
    state.iataIndex = -1;
    state.iataField = null;
    return;
  }
  hideSuggestions();
  for (const other of IATA_FIELDS) {
    if (other !== fieldId) hideIataSuggestions(other);
  }
  state.iataField = fieldId;
  state.iataItems = filtered;
  state.iataIndex = -1;
  panel.innerHTML = filtered
    .map((item, idx) => {
      if (item.kind === "country") {
        const codes = (item.codes || []).join(", ");
        return `<button type="button" class="suggest-item suggest-item-country" role="option" data-index="${idx}">
          <span class="suggest-primary">${escapeHtml(item.name || item.city)}</span>
          <span class="suggest-secondary">${escapeHtml(codes)}</span>
        </button>`;
      }
      const country = item.countryName || countryLabel(item.country) || item.country || "";
      const secondary = [item.city, country].filter(Boolean).join(", ");
      return `<button type="button" class="suggest-item" role="option" data-index="${idx}">
        <span class="suggest-primary"><span class="iata-code">${escapeHtml(
          item.code
        )}</span> · ${escapeHtml(item.name)}</span>
        <span class="suggest-secondary">${escapeHtml(secondary)}</span>
      </button>`;
    })
    .join("");
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");
  panel.querySelectorAll(".suggest-item").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const item = state.iataItems[Number(btn.dataset.index)];
      if (item) selectIataSuggestion(fieldId, item);
    });
  });
}

async function fetchIataSuggestions(fieldId, token) {
  const reqId = ++state.iataReq;
  const localRaw = searchAirports(token, { limit: 40 });
  const isCountryResult = localRaw.some((x) => x?.kind === "country");
  const local = localRaw.map((entry) => ({
    code: entry.code,
    name: entry.name,
    city: entry.city,
    country: entry.country,
    metro: Boolean(entry.metro),
    kind: entry.kind || null,
    codes: entry.codes || null,
    countryName: entry.countryName || null,
    source: "local",
  }));

  // Enrich with Hilton airport hits when the token looks like a place name.
  // Skip when we already expanded a country — local list is the source of truth.
  let hilton = [];
  if (!isCountryResult && token.length >= 2) {
    try {
      const res = await sendMessage({
        type: "AUTOCOMPLETE_DESTINATION",
        query: token,
        limit: 12,
      });
      if (reqId !== state.iataReq) return;
      if (res?.ok && Array.isArray(res.suggestions)) {
        const seen = new Set(local.map((x) => x.code).filter(Boolean));
        for (const s of res.suggestions) {
          if (s.type && s.type !== "airport" && s.type !== "destination") continue;
          const code =
            extractIataCode(s.primary) ||
            extractIataCode(s.secondary) ||
            extractIataCode(s.label) ||
            extractIataCode(s.query);
          if (!code || seen.has(code)) continue;
          if (s.type !== "airport" && !/\bairport\b/i.test(`${s.primary} ${s.secondary} ${s.label}`)) {
            continue;
          }
          seen.add(code);
          hilton.push({
            code,
            name: s.primary || s.label || code,
            city: s.city || s.secondary || "",
            country: s.countryCode || s.country || "",
            metro: false,
            source: "hilton",
          });
        }
      }
    } catch {
      /* local list is enough */
    }
  }
  if (reqId !== state.iataReq) return;

  const merged = [...local];
  for (const hit of hilton) {
    if (merged.some((x) => x.code === hit.code)) continue;
    merged.push(hit);
  }
  renderIataSuggestions(fieldId, merged.slice(0, isCountryResult ? 40 : 12));
}

function setupIataAutocomplete() {
  state.iataItems = [];
  state.iataIndex = -1;
  state.iataField = null;
  state.iataTimer = null;
  state.iataReq = 0;

  for (const fieldId of IATA_FIELDS) {
    const input = $(fieldId);
    const box = document.querySelector(`[data-iata-box="${fieldId}"]`);
    if (!input) continue;

    renderIataTags(fieldId);

    box?.addEventListener("mousedown", (e) => {
      if (e.target.closest(".iata-tag-remove")) return;
      if (e.target === input) return;
      e.preventDefault();
      input.focus();
    });

    input.addEventListener("focus", () => {
      const token = String(input.value || "").trim();
      if (token.length >= 1) fetchIataSuggestions(fieldId, token);
    });

    input.addEventListener("input", () => {
      const raw = String(input.value || "");
      // Commit completed codes when the user types a comma/semicolon (keep spaces for city names).
      if (/[,;]/.test(raw)) {
        const parts = raw
          .toUpperCase()
          .split(/[\s,;]+/)
          .map((p) => p.trim())
          .filter(Boolean);
        const endsWithSep = /[,;]\s*$/.test(raw);
        const complete = endsWithSep ? parts : parts.slice(0, -1);
        const remainder = endsWithSep ? "" : parts[parts.length - 1] || "";
        let changed = false;
        for (const code of complete) {
          if (/^[A-Z]{3}$/.test(code) && addIataCode(fieldId, code)) changed = true;
        }
        input.value = remainder;
        if (changed && !remainder) {
          hideIataSuggestions(fieldId);
          return;
        }
      }
      const token = String(input.value || "").trim();
      clearTimeout(state.iataTimer);
      if (!token) {
        hideIataSuggestions(fieldId);
        return;
      }
      state.iataTimer = setTimeout(() => fetchIataSuggestions(fieldId, token), 140);
    });

    input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") || "";
      const codes = parseIataCodes(text);
      if (codes.length < 2 && !/[\s,;]/.test(text)) return;
      e.preventDefault();
      for (const code of codes) addIataCode(fieldId, code);
      hideIataSuggestions(fieldId);
    });

    input.addEventListener("keydown", (e) => {
      const panel = iataSuggestPanel(fieldId);
      const panelOpen =
        panel && !panel.hidden && state.iataItems.length && state.iataField === fieldId;

      if (e.key === "Backspace" && !input.value && getIataCodes(fieldId).length) {
        e.preventDefault();
        const codes = getIataCodes(fieldId);
        removeIataCode(fieldId, codes[codes.length - 1]);
        return;
      }

      if (e.key === "Enter" || e.key === "," || e.key === ";") {
        if (panelOpen && state.iataIndex >= 0) {
          e.preventDefault();
          commitIataToken(fieldId, { preferSuggestion: true });
          return;
        }
        const token = String(input.value || "").trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(token)) {
          e.preventDefault();
          commitIataToken(fieldId);
          return;
        }
        if (panelOpen && state.iataItems[0] && e.key === "Enter") {
          e.preventDefault();
          selectIataSuggestion(fieldId, state.iataItems[0]);
          return;
        }
      }

      if (!panelOpen) {
        if (e.key === "Escape") hideIataSuggestions(fieldId);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightIataSuggestion(Math.min(state.iataIndex + 1, state.iataItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightIataSuggestion(Math.max(state.iataIndex - 1, 0));
      } else if (e.key === "Enter" && state.iataIndex >= 0) {
        e.preventDefault();
        const item = state.iataItems[state.iataIndex];
        if (item) selectIataSuggestion(fieldId, item);
      } else if (e.key === "Escape") {
        hideIataSuggestions(fieldId);
      } else if (e.key === "Tab" && (state.iataIndex >= 0 || state.iataItems[0])) {
        const item = state.iataItems[state.iataIndex >= 0 ? state.iataIndex : 0];
        if (item) {
          e.preventDefault();
          selectIataSuggestion(fieldId, item);
        }
      }
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        const token = String(input.value || "").trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(token)) commitIataToken(fieldId);
        hideIataSuggestions(fieldId);
      }, 140);
    });
  }
}

function nightsLabel(nights) {
  const n = Number(nights) || 1;
  return n === 1 ? "1-night" : `${n}-night`;
}

function setScanningUi(scanning) {
  state.scanning = scanning;
  for (const id of ["searchBtn", "flightSearchBtn"]) {
    const btn = $(id);
    if (!btn) continue;
    if (scanning) {
      btn.type = "button";
      btn.textContent = "Stop";
      btn.classList.remove("search-btn");
      btn.classList.add("stop-btn");
      btn.setAttribute("aria-label", "Stop search");
    } else {
      btn.type = "submit";
      btn.textContent = "Search";
      btn.classList.remove("stop-btn");
      btn.classList.add("search-btn");
      btn.setAttribute("aria-label", "Search");
    }
  }
  if (scanning) setHotelResultsVisible(true);
  if (!scanning) {
    clearRoomFetchQueue();
    scheduleHydrateFnfComparesFromCache();
  }
  updatePriceOptimalSelectButtons();
}

function estimateSeatsSearchCalls(values = formValues()) {
  const roundTrip = values.flightTripType !== "oneway";
  const origins = parseIataCodes(values.flightOrigins);
  const destinations = parseIataCodes(values.flightDestinations);
  const tripRanges = enrichRanges(values.flightRanges || []).filter(
    (r) => r?.from && r?.to && r.to > r.from
  );
  if (!tripRanges.length || !origins.length || !destinations.length) {
    return {
      total: 0,
      outbound: 0,
      returning: 0,
      trips: tripRanges.length,
      originCount: origins.length,
      destinationCount: destinations.length,
      departureDates: 0,
      returnDates: 0,
      roundTrip,
    };
  }
  // One Seats /search request per unique date per leg; airports are comma-batched.
  const departureDates = new Set(tripRanges.map((r) => r.from)).size;
  const returnDates = roundTrip ? new Set(tripRanges.map((r) => r.to)).size : 0;
  return {
    total: departureDates + returnDates,
    outbound: departureDates,
    returning: returnDates,
    trips: tripRanges.length,
    originCount: origins.length,
    destinationCount: destinations.length,
    departureDates,
    returnDates,
    roundTrip,
  };
}

function updateSeatsApiCostHint() {
  const el = $("seatsApiCostHint");
  if (!el) return;
  if ($("searchMode")?.value !== "flight") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const est = estimateSeatsSearchCalls();
  if (!est.trips) {
    el.textContent = "Add trips to estimate Seats.aero API cost.";
    return;
  }
  if (!est.originCount || !est.destinationCount) {
    el.hidden = true;
    return;
  }
  el.textContent = `~${formatCount(est.total)} Seats.aero API call${
    est.total === 1 ? "" : "s"
  }`;
}

function setFlightTripType(type, { writeUrl = false } = {}) {
  const next = type === "oneway" ? "oneway" : "roundtrip";
  if ($("flightTripType")) $("flightTripType").value = next;
  document.querySelectorAll("[data-flight-trip-type]").forEach((btn) => {
    const active = btn.dataset.flightTripType === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const tripsLabel = $("flightTripsLabel");
  if (tripsLabel) tripsLabel.textContent = "Trips";
  setDateRangesHints("flightDateRanges", {
    exactStart: "Select departure",
    exactEnd: next === "oneway" ? "Select check-out" : "Select return",
  });
  setDateRangesPlaceholder(
    "flightDateRanges",
    next === "oneway" ? "Add departure → check-out" : "Add departure → return"
  );
  const returnSection = document.querySelector('.flight-leg-section[data-flight-leg="return"]');
  if (returnSection) returnSection.hidden = next === "oneway";
  if (next === "oneway") clearSelectedReturnFlight({ silent: false });
  const lede = $("heroLede");
  if (lede && $("searchMode")?.value === "flight") {
    lede.textContent =
      next === "oneway"
        ? "Find award flights on your departure dates, then scan Hilton hotels through check-out."
        : "Find award flights for each trip window, then scan Hilton hotels for those stays.";
  }
  if ($("searchMode")?.value === "flight") {
    setStatus(
      next === "oneway"
        ? "Enter airports and one or more departure → check-out trips."
        : "Enter airports and one or more departure → return trips."
    );
  }
  updateTripSummary();
  updateSeatsApiCostHint();
  if (writeUrl) writeParams(formValues());
}

function setSearchMode(mode) {
  const next = mode === "flight" ? "flight" : "hotel";
  if ($("searchMode")) $("searchMode").value = next;
  document.querySelectorAll("[data-search-mode]").forEach((btn) => {
    const active = btn.dataset.searchMode === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-mode-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.modePanel !== next;
  });
  if (next !== "flight") closeFlightRecentPanel();
  const tripType = $("flightTripType")?.value === "oneway" ? "oneway" : "roundtrip";
  const lede = $("heroLede");
  if (lede) {
    lede.textContent =
      next === "flight"
        ? tripType === "oneway"
          ? "Find award flights for each departure → check-out trip, then scan Hilton hotels."
          : "Find award flights for each departure → return trip, then scan Hilton hotels."
        : "Add one or more stays.";
  }
  if ($("destination")) $("destination").required = next === "hotel";
  if (next === "flight") {
    const returnSection = document.querySelector('.flight-leg-section[data-flight-leg="return"]');
    if (returnSection) returnSection.hidden = tripType === "oneway";
  }
  setStatus(
    next === "flight"
      ? tripType === "oneway"
        ? "Enter airports and one or more departure → check-out trips."
        : "Enter airports and one or more departure → return trips."
      : "Enter a destination and at least one stay to begin."
  );
  updateSeatsApiCostHint();
  if (next !== "flight") {
    clearBestTripComboHighlight();
    const notice = $("bestComboNotice");
    if (notice) {
      notice.hidden = true;
      notice.textContent = "";
    }
  }
  syncFlightHotelResultsLayout();
  updateTripSummary();
  updatePriceOptimalSelectButtons();
  refreshTable();
}

function setupSearchMode() {
  document.querySelectorAll("[data-search-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.scanning) return;
      setSearchMode(btn.dataset.searchMode);
      writeParams(formValues());
    });
  });
  document.querySelectorAll("[data-flight-trip-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.scanning) return;
      setFlightTripType(btn.dataset.flightTripType, { writeUrl: true });
    });
  });
}

function renderFlightResults(flights, meta = {}) {
  setFlightResults(flights, meta);
  syncFlightHotelResultsLayout();
  updatePriceOptimalSelectButtons();
}

function clearFlightResultsUi() {
  clearFlightResults();
  clearTripHotelSelection({ silent: true });
  clearBestTripComboHighlight();
  // Keep both table shells visible in Flight + hotel mode (empty state).
  syncFlightHotelResultsLayout();
  updateTripSummary();
}

function flightAwardCost(flight) {
  const miles = Number(flight?.mileageCost);
  if (!Number.isFinite(miles) || miles < 0) return null;
  const tax = taxAmountDollars(flight);
  return { points: miles, cash: tax != null ? tax : 0 };
}

function hotelDepartureFor(row) {
  if (!row) return null;
  if (row.departureDate) return String(row.departureDate).slice(0, 10);
  if (row.arrivalDate) {
    return addDaysISO(String(row.arrivalDate).slice(0, 10), stayNightsFor(row));
  }
  return null;
}

/**
 * Cheapest outbound (+ return) + hotel stay for searched trip windows.
 * Cost = (award miles × $0.01) + flight taxes + hotel stay cash (USD).
 * Optional locks fix a chosen leg/stay; remaining legs are re-optimized.
 */
function findCheapestTripCombo({
  flights,
  hotels,
  tripRanges,
  roundTrip,
  lockOutboundId = null,
  lockReturnId = null,
  lockHotelKey = null,
} = {}) {
  const MILE_VALUE_USD = 0.01;
  const ranges = (tripRanges || []).filter((t) => t?.from && t?.to && t.to > t.from);
  if (!ranges.length) return null;

  const lockOut = lockOutboundId != null ? String(lockOutboundId) : null;
  const lockRet = lockReturnId != null ? String(lockReturnId) : null;
  const lockHotel = lockHotelKey != null ? String(lockHotelKey) : null;

  const outsByDate = new Map();
  const retsByDate = new Map();
  for (const flight of flights || []) {
    const date = String(flight?.date || "").slice(0, 10);
    if (!date) continue;
    const isReturn = flight.direction === "return";
    if (isReturn) {
      if (!roundTrip) continue;
      if (lockRet && String(flight.id) !== lockRet) continue;
      const list = retsByDate.get(date) || [];
      list.push(flight);
      retsByDate.set(date, list);
    } else {
      if (lockOut && String(flight.id) !== lockOut) continue;
      const list = outsByDate.get(date) || [];
      list.push(flight);
      outsByDate.set(date, list);
    }
  }

  const hotelsByStay = new Map();
  for (const hotel of hotels || []) {
    if (hotel?.error) continue;
    if (lockHotel && rowKey(hotel) !== lockHotel) continue;
    const stayCash = hotelStayCashTotal(hotel);
    if (stayCash == null) continue;
    const arrival = String(hotel.arrivalDate || "").slice(0, 10);
    const departure = hotelDepartureFor(hotel);
    if (!arrival || !departure) continue;
    const key = `${arrival}|${departure}`;
    const list = hotelsByStay.get(key) || [];
    list.push({ hotel, stayCash });
    hotelsByStay.set(key, list);
  }

  let best = null;

  for (const trip of ranges) {
    const from = String(trip.from).slice(0, 10);
    const to = String(trip.to).slice(0, 10);
    const outs = outsByDate.get(from) || [];
    const stays = hotelsByStay.get(`${from}|${to}`) || [];
    if (!outs.length || !stays.length) continue;

    const rets = roundTrip ? retsByDate.get(to) || [] : [null];
    if (roundTrip && !rets.length) continue;

    for (const outbound of outs) {
      const outCost = flightAwardCost(outbound);
      if (!outCost) continue;
      for (const ret of rets) {
        let retCost = { points: 0, cash: 0 };
        if (roundTrip) {
          retCost = flightAwardCost(ret);
          if (!retCost) continue;
        }
        for (const { hotel, stayCash } of stays) {
          const points = outCost.points + retCost.points;
          const cash = outCost.cash + retCost.cash + stayCash;
          const total = points * MILE_VALUE_USD + cash;
          if (!best || total < best.total) {
            best = {
              outbound,
              return: roundTrip ? ret : null,
              hotel,
              points,
              cash,
              total,
            };
          }
        }
      }
    }
  }

  return best;
}

function setBestComboNotice(message) {
  const el = $("bestComboNotice");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function clearBestTripComboHighlight() {
  state.bestComboHotelKey = null;
  clearBestComboFlightIds();
  setBestComboNotice(null);
  updatePriceOptimalSelectButtons();
}

function hasPriceOptimalCombo({ roundTrip = isFlightRoundTrip() } = {}) {
  if (isHotelSearchMode()) return false;
  const { outboundId, returnId } = getBestComboFlightIds();
  if (!outboundId || !state.bestComboHotelKey) return false;
  if (roundTrip && !returnId) return false;
  return true;
}

function priceOptimalSelectDisabledReason() {
  if (hasPriceOptimalCombo()) return "";
  if (isHotelSearchMode()) {
    return "Price-optimal selection is only available in Flight + hotel mode.";
  }
  if (state.scanning) {
    const hasFlights = Boolean(getFlightResults()?.all?.length);
    return hasFlights
      ? "Hotel search is still in progress."
      : "Search is still in progress.";
  }
  const flightMode = !$("flightResults")?.hidden;
  if (!flightMode || !getFlightResults()?.all?.length) {
    return "Run a Flight + hotel search to find a price-optimal combination.";
  }
  if (!state.allRows?.length) {
    return "No hotel rates available — a price-optimal combination is not possible.";
  }
  const notice = $("bestComboNotice");
  if (notice && !notice.hidden && notice.textContent?.trim()) {
    return notice.textContent.trim();
  }
  return "A price-optimal combination is not possible for these results.";
}

function updatePriceOptimalSelectButtons() {
  const hotelMode = isHotelSearchMode();
  const enabled = hasPriceOptimalCombo();
  const reason = priceOptimalSelectDisabledReason();
  const pairs = [
    ["selectPriceOptimalFlightBtn", "selectPriceOptimalFlightWrap"],
    ["selectPriceOptimalHotelBtn", "selectPriceOptimalHotelWrap"],
  ];
  for (const [btnId, wrapId] of pairs) {
    const btn = $(btnId);
    const wrap = $(wrapId);
    if (!btn) continue;
    btn.disabled = !enabled;
    btn.removeAttribute("title");
    if (wrap) {
      wrap.hidden = hotelMode;
      wrap.title = enabled || hotelMode ? "" : reason;
      wrap.classList.toggle("is-disabled", !enabled);
    } else if (!enabled) {
      btn.title = reason;
    }
  }
}

function selectPriceOptimalTripCombo() {
  if (isHotelSearchMode() || !hasPriceOptimalCombo()) return;
  const { outboundId, returnId } = getBestComboFlightIds();
  const hotelKey = state.bestComboHotelKey;
  const roundTrip = isFlightRoundTrip();
  const hotel =
    state.allRows.find((r) => rowKey(r) === hotelKey) ||
    state.rows.find((r) => rowKey(r) === hotelKey) ||
    null;
  if (!hotel) return;

  setTripFlightSelection({
    outboundId,
    returnId: roundTrip ? returnId : null,
    silent: true,
  });
  state.selectedHotelKey = hotelKey;
  setSelectedStayConstraint(
    {
      arrivalDate: hotel.arrivalDate,
      departureDate:
        hotel.departureDate ||
        (hotel.arrivalDate ? addDaysISO(hotel.arrivalDate, stayNightsFor(hotel)) : null),
      nights: stayNightsFor(hotel),
    },
    { silent: true }
  );
  syncHotelDateFiltersFromSelection();
  resolveAndHighlightBestTripCombo({ roundTrip });
}

function applyBestTripCombo(combo, { roundTrip = true, hasLocks = false } = {}) {
  if (!combo?.outbound || !combo?.hotel || (roundTrip && !combo.return)) {
    state.bestComboHotelKey = null;
    clearBestComboFlightIds();
    setBestComboNotice(
      hasLocks
        ? roundTrip
          ? "No cheapest outbound, return, and hotel combination works with your current selection."
          : "No cheapest outbound and hotel combination works with your current selection."
        : roundTrip
          ? "A cheapest combination of outbound, return, and hotel stay could not be found for these trip dates."
          : "A cheapest combination of outbound flight and hotel stay could not be found for these trip dates."
    );
    updatePriceOptimalSelectButtons();
    refreshFlightTable();
    refreshTable();
    return null;
  }

  state.bestComboHotelKey = rowKey(combo.hotel);
  setBestComboFlightIds({
    outboundId: combo.outbound.id,
    returnId: combo.return?.id || null,
  });
  setBestComboNotice(null);
  updatePriceOptimalSelectButtons();
  refreshFlightTable();
  refreshTable();
  return combo;
}

function resolveAndHighlightBestTripCombo({ roundTrip } = {}) {
  if (isHotelSearchMode()) {
    clearBestTripComboHighlight();
    refreshFlightTable();
    refreshTable();
    return null;
  }
  const flightData = getFlightResults();
  if (!flightData?.all?.length) {
    clearBestTripComboHighlight();
    return null;
  }
  const flights = flightData.all || [];
  const tripRanges = flightData?.meta?.search?.tripRanges || [];
  const isRound =
    roundTrip != null
      ? Boolean(roundTrip)
      : String(flightData?.meta?.search?.tripType || "") !== "oneway";
  const hotels = state.allRows || [];
  const { outbound, return: ret, hotel } = currentTripSelection();
  const hasLocks = Boolean(outbound || ret || hotel);
  const combo = findCheapestTripCombo({
    flights,
    hotels,
    tripRanges,
    roundTrip: isRound,
    lockOutboundId: outbound?.id || null,
    lockReturnId: isRound ? ret?.id || null : null,
    lockHotelKey: hotel ? rowKey(hotel) : null,
  });
  return applyBestTripCombo(combo, { roundTrip: isRound, hasLocks });
}

async function resolveAirportHotels(iata) {
  const code = String(iata || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return { hotels: [], placeLabel: code };

  let suggestion = null;
  const ac = await sendMessage({
    type: "AUTOCOMPLETE_DESTINATION",
    query: code,
    limit: 12,
  });
  if (ac.ok && ac.suggestions?.length) {
    suggestion =
      ac.suggestions.find(
        (s) =>
          s.type === "airport" &&
          (String(s.primary || "").toUpperCase().includes(code) ||
            String(s.query || "").toUpperCase().includes(code) ||
            String(s.label || "").toUpperCase().includes(code))
      ) ||
      ac.suggestions.find((s) => s.type === "airport") ||
      pickBestDestinationSuggestion(ac.suggestions, code);
  }

  const hotelRes = await sendMessage({
    type: "SEARCH_DESTINATION_HOTELS",
    destination: suggestion?.query || code,
    suggestion,
  });
  if (!hotelRes.ok) {
    if (hotelRes.unauthorized) throw Object.assign(new Error(hotelRes.error || "Unauthorized"), { unauthorized: true });
    throw new Error(hotelRes.error || `Hotel search failed for ${code}`);
  }
  return {
    hotels: hotelRes.hotels || [],
    placeLabel:
      hotelRes.place?.displayName ||
      hotelRes.resolvedSuggestion?.label ||
      suggestion?.label ||
      code,
    cancelled: Boolean(hotelRes.cancelled),
  };
}

function mergeHotelsByCode(lists) {
  const map = new Map();
  for (const hotels of lists) {
    for (const h of hotels || []) {
      const code = String(h?.ctyhocn || "").toUpperCase();
      if (!code || map.has(code)) continue;
      map.set(code, h);
    }
  }
  return [...map.values()];
}

async function runFlightHotelSearch(values) {
  if (!values.flightOrigins) {
    setStatus("Origin airport(s) required (e.g. SFO, OAK).");
    return;
  }
  if (!values.flightDestinations) {
    setStatus("Destination airport(s) required (e.g. LHR, LGW).");
    return;
  }
  const roundTrip = values.flightTripType !== "oneway";
  const tripRanges = enrichRanges(values.flightRanges || []).filter(
    (r) => r?.from && r?.to && r.to > r.from
  );
  if (!tripRanges.length) {
    setStatus(
      roundTrip
        ? "Add at least one departure → return trip."
        : "Add at least one departure → check-out trip."
    );
    return;
  }
  const tooLong = tripRanges.find((r) => (r.nights || nightsBetween(r.from, r.to)) > 7);
  if (tooLong) {
    const n = tooLong.nights || nightsBetween(tooLong.from, tooLong.to);
    setStatus(`Hotel stays can be at most 7 nights (got ${n} for ${tooLong.from}→${tooLong.to}).`);
    return;
  }

  writeParams(values);
  rememberCurrentSearch();
  state.stopRequested = false;
  clearRoomFetchQueue();
  state.expanded.clear();
  state.roomGroupsOpen.clear();
  state.roomsSectionOpen.clear();
  state.roomDescOpen.clear();
  state.refreshingKeys.clear();
  clearColumnFilters();
  state.dowSelected = new Set();
  updateDowUi();
  setScanningUi(true);
  setProgress(0);
  hideSuggestions();
  state.scanHotels = [];
  state.scanProgressDone = 0;
  clearFlightResultsUi();
  renderRows([], { resetPage: true });
  clearBestTripComboHighlight();

  try {
    const status = await sendMessage({ type: "GET_STATUS" });
    if (status.unauthorized || state.awaitingReauth) {
      state.awaitingReauth = false;
      const restored = await sendMessage({ type: "RESTORE_SESSION" });
      if (restored.guestId) setSession(restored.guestId, { userName: restored.userName || null });
    }

    const tripLabel = `${formatCount(tripRanges.length)} trip${tripRanges.length === 1 ? "" : "s"}`;
    setStatus(
      roundTrip
        ? `Searching Seats.aero for ${tripLabel} (outbound + return)…`
        : `Searching Seats.aero for ${tripLabel} (outbound)…`
    );
    setProgress(8);

    const seatsCommon = {
      type: "SEATS_CACHED_SEARCH",
      transferPartners: "all",
    };

    const departureDates = [...new Set(tripRanges.map((r) => r.from))];
    const returnDates = roundTrip ? [...new Set(tripRanges.map((r) => r.to))] : [];

    // Map each departure date to hotel stay end dates so Seats can build stay windows.
    const stayEndByDepart = new Map();
    for (const trip of tripRanges) {
      const ends = stayEndByDepart.get(trip.from) || [];
      if (!ends.includes(trip.to)) ends.push(trip.to);
      stayEndByDepart.set(trip.from, ends);
    }

    const outboundJobs = departureDates.map((depart) => {
      // Prefer the shortest matching stay for this depart when seeding hotel stays;
      // all trip windows are still scanned for hotels later.
      const ends = (stayEndByDepart.get(depart) || []).slice().sort();
      const stayEnd = ends[0] || addDaysISO(depart, 1);
      return sendMessage({
        ...seatsCommon,
        originAirports: values.flightOrigins,
        destinationAirports: values.flightDestinations,
        startDate: depart,
        endDate: depart,
        arrivalDate: depart,
        departureDate: stayEnd,
      }).then((res) => ({ depart, res }));
    });

    const returnJobs = returnDates.map((retDate) =>
      sendMessage({
        ...seatsCommon,
        originAirports: values.flightDestinations,
        destinationAirports: values.flightOrigins,
        startDate: retDate,
        endDate: retDate,
        arrivalDate: null,
        departureDate: null,
      }).then((res) => ({ retDate, res }))
    );

    const [outboundResults, returnResults] = await Promise.all([
      Promise.all(outboundJobs),
      Promise.all(returnJobs),
    ]);

    if (state.stopRequested) {
      setStatus("Stopped.");
      return;
    }

    const seatsError = [...outboundResults, ...returnResults]
      .map((x) => x.res)
      .find((r) => !r?.ok);
    if (seatsError) {
      if (seatsError.code === "missing_api_key") {
        const details = document.querySelector(".seats-key-details");
        if (details) details.open = true;
      }
      throw new Error(seatsError.error || "Seats.aero search failed");
    }

    const tagLeg = (list, direction, searchMeta = {}) =>
      (list || []).map((f, i) => ({
        ...f,
        direction,
        fromCache: Boolean(searchMeta.fromCache),
        fetchedAt: searchMeta.fetchedAt || null,
        id: `${direction}:${f.id || `${f.source}-${f.date}-${f.origin}-${f.destination}-${i}`}`,
      }));

    const outboundFlights = [];
    const returnFlights = [];
    const destinations = new Set();
    let anyOutCached = false;
    let anyRetCached = false;

    for (const { res } of outboundResults) {
      if (res.fromCache) anyOutCached = true;
      const tagged = tagLeg(res.flights, "outbound", {
        fromCache: res.fromCache,
        fetchedAt: res.fetchedAt,
      });
      outboundFlights.push(...tagged);
      for (const code of res.destinationsWithFlights || []) {
        if (code) destinations.add(String(code).toUpperCase());
      }
      for (const f of tagged) {
        if (f.destination) destinations.add(String(f.destination).toUpperCase());
      }
    }
    for (const { res } of returnResults) {
      if (res.fromCache) anyRetCached = true;
      returnFlights.push(
        ...tagLeg(res.flights, "return", {
          fromCache: res.fromCache,
          fetchedAt: res.fetchedAt,
        })
      );
    }

    // Deduplicate identical award rows across trip dates.
    const dedupeFlights = (list) => {
      const seen = new Set();
      const out = [];
      for (const f of list) {
        const key = f.id || JSON.stringify(f);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
      return out;
    };
    const outboundUnique = dedupeFlights(outboundFlights);
    const returnUnique = dedupeFlights(returnFlights);
    const flights = [...outboundUnique, ...returnUnique];
    const cacheBits = [];
    if (anyOutCached) cacheBits.push("out cached");
    if (roundTrip && anyRetCached) cacheBits.push("ret cached");
    const flightCacheNote = cacheBits.length ? ` · ${cacheBits.join(", ")}` : "";

    // Actual Seats HTTP /search calls (airports batched; cache hits = 0).
    let seatsApiCallsSpent = 0;
    for (const { res } of [...outboundResults, ...returnResults]) {
      if (!res?.ok) continue;
      if (typeof res.apiCalls === "number") seatsApiCallsSpent += res.apiCalls;
      else if (!res.fromCache) seatsApiCallsSpent += 1;
    }

    const destinationList = [...destinations];
    renderFlightResults(flights, {
      destinations: destinationList,
      transferPartners: "all",
      outboundCount: outboundUnique.length,
      returnCount: returnUnique.length,
      seatsApiCallsSpent,
      search: {
        origins: values.flightOrigins,
        destinations: values.flightDestinations,
        departureDate: tripRanges[0].from,
        returnDate: tripRanges[0].to,
        tripRanges,
        tripType: roundTrip ? "roundtrip" : "oneway",
        transferPartners: "all",
      },
    });

    const uniqueRanges = tripRanges.map((r) => ({
      from: r.from,
      to: r.to,
      nights: r.nights || nightsBetween(r.from, r.to),
      mode: "exact",
    }));

    if (!outboundUnique.length && !returnUnique.length) {
      setProgress(100);
      setStatus(
        roundTrip
          ? `No award availability ${values.flightOrigins} ⇄ ${values.flightDestinations} across ${tripLabel}${flightCacheNote}.`
          : `No award availability ${values.flightOrigins} → ${values.flightDestinations} across ${tripLabel}${flightCacheNote}.`
      );
      applyBestTripCombo(null, { roundTrip });
      return;
    }

    if (!outboundUnique.length || !uniqueRanges.length) {
      setProgress(100);
      setStatus(
        `Found ${formatCount(flights.length)} award flight${flights.length === 1 ? "" : "s"}${flightCacheNote} (${formatCount(
          outboundUnique.length
        )} outbound${roundTrip ? ` · ${formatCount(returnUnique.length)} return` : ""}). No outbound awards for hotel search.`
      );
      applyBestTripCombo(null, { roundTrip });
      return;
    }

    setStatus(
      `Found ${formatCount(outboundUnique.length)} outbound${
        roundTrip ? ` · ${formatCount(returnUnique.length)} return` : ""
      }${flightCacheNote} · ${formatCount(uniqueRanges.length)} hotel stay${
        uniqueRanges.length === 1 ? "" : "s"
      }. Finding Hilton hotels…`
    );
    setProgress(18);

    const hotelLists = [];
    for (let i = 0; i < destinationList.length; i += 1) {
      if (state.stopRequested) {
        setStatus("Stopped.");
        return;
      }
      const dest = destinationList[i];
      setStatus(`Finding Hilton hotels near ${dest} (${i + 1}/${destinationList.length})…`);
      const resolved = await resolveAirportHotels(dest);
      if (resolved.cancelled || state.stopRequested) {
        setStatus("Stopped.");
        return;
      }
      hotelLists.push(resolved.hotels);
      setProgress(18 + Math.round(((i + 1) / Math.max(1, destinationList.length)) * 22));
    }

    const hotels = mergeHotelsByCode(hotelLists);
    if (!hotels.length) {
      setProgress(100);
      setStatus(`Award flights found, but no Hilton hotels near ${destinationList.join(", ")}.`);
      applyBestTripCombo(null, { roundTrip });
      return;
    }

    state.scanHotels = hotels;
    setStatus(
      `Found ${formatCount(hotels.length)} hotel${hotels.length === 1 ? "" : "s"} near ${destinationList.join(
        ", "
      )}. Scanning ${formatCount(uniqueRanges.length)} stay${uniqueRanges.length === 1 ? "" : "s"}…`
    );
    setProgress(42);

    const scanRes = await sendMessage({
      type: "SCAN_RATES",
      hotels,
      ranges: uniqueRanges,
      friendsAndFamily: values.rateType !== "tm",
      goOnly: values.goOnly,
      maxRate: values.maxRate,
      minRooms: values.minRooms,
      delayMs: SCAN_DELAY_MS,
    });

    if (!scanRes.ok) {
      if (scanRes.unauthorized || scanErrorsAreUnauthorized(scanRes.rows)) {
        renderRows(scanRes.rows || []);
        markUnauthorized(scanRes.error || "Hilton session expired. Sign in again to continue.");
        return;
      }
      throw new Error(scanRes.error || "Rate scan failed");
    }

    state.scanHotels = [];
    renderRows(scanRes.rows || []);
    if (scanRes.unauthorized || scanErrorsAreUnauthorized(state.scanErrors)) {
      markUnauthorized(scanRes.error || "Hilton session expired. Sign in again to continue.");
      return;
    }

    setSession(scanRes.guestId || null, { userName: scanRes.userName || state.userName || null });
    const matchedRows = (scanRes.rows || []).filter((r) => !r.error);
    const matched = matchedRows.length;
    const matchedHotels = uniqueHotelCount(matchedRows);
    const failCount = state.scanErrors.length;
    setProgress(100);
    setStatus(
      matched
        ? `Done. ${formatCount(outboundUnique.length)} outbound${
            roundTrip ? ` · ${formatCount(returnUnique.length)} return` : ""
          } → ${formatCount(matched)} hotel rate${matched === 1 ? "" : "s"} across ${formatCount(
            matchedHotels
          )} hotel${matchedHotels === 1 ? "" : "s"} · ${formatCount(uniqueRanges.length)} stay${
            uniqueRanges.length === 1 ? "" : "s"
          }${failCount ? ` · ${formatCount(failCount)} failed` : ""}.`
        : `Award flights found, but no matching hotel rates near ${destinationList.join(", ")}${
            failCount ? ` · ${formatCount(failCount)} failed` : ""
          }.`
    );
    resolveAndHighlightBestTripCombo({ roundTrip });
    setHotelResultsVisible(true);
  } catch (err) {
    console.error(err);
    setStatus(String(err?.message || err), "bad");
  } finally {
    setScanningUi(false);
  }
}

async function setupSeatsApiKey() {
  const input = $("seatsApiKey");
  const saveBtn = $("saveSeatsKeyBtn");
  if (!input || !saveBtn) return;
  const SEATS_KEY_STORAGE = "seatsAeroApiKey";
  try {
    const data = await chrome.storage.local.get(SEATS_KEY_STORAGE);
    if (data[SEATS_KEY_STORAGE]) input.value = String(data[SEATS_KEY_STORAGE]);
  } catch {
    /* ignore */
  }
  saveBtn.addEventListener("click", async () => {
    const value = String(input.value || "").trim();
    try {
      await chrome.storage.local.set({ [SEATS_KEY_STORAGE]: value });
      input.value = value;
      setStatus(value ? "Seats.aero API key saved." : "Seats.aero API key cleared.", "ok");
    } catch (err) {
      setStatus(String(err?.message || err || "Could not save Seats.aero API key."), "bad");
    }
  });
}

function stopSearch() {
  if (!state.scanning) return;
  state.stopRequested = true;
  clearRoomFetchQueue();
  setStatus("Stopping…");
  sendMessage({ type: "STOP_SCAN" });
}

async function runSearch(event) {
  event?.preventDefault();
  if (state.scanning) {
    stopSearch();
    return;
  }

  const values = formValues();
  if (values.searchMode === "flight") {
    await runFlightHotelSearch(values);
    return;
  }

  const cachedSearch =
    isCachedSuggestion(state.selectedSuggestion) || /^cached$/i.test(values.destination);
  if (!values.destination) {
    setStatus("Destination is required.");
    return;
  }
  if (!cachedSearch && !values.ranges?.length) {
    setStatus("Destination and at least one stay are required.");
    return;
  }
  const tooLong = values.ranges?.find((r) => Number(r.nights) > 7);
  if (tooLong) {
    setStatus(
      tooLong.mode === "window"
        ? `Wide-range stays can be at most 7 nights (got ${tooLong.nights}).`
        : `Stays can be at most 7 nights (${formatRangeLabel(tooLong)}).`
    );
    return;
  }

  clearFlightResultsUi();
  writeParams(values);
  rememberCurrentSearch();
  state.stopRequested = false;
  clearRoomFetchQueue();
  // Keep previously fetched room shops so F&F compares and room lists stay available.
  state.expanded.clear();
  state.roomGroupsOpen.clear();
  state.roomsSectionOpen.clear();
  state.roomDescOpen.clear();
  state.refreshingKeys.clear();
  clearColumnFilters();
  state.dowSelected = new Set();
  updateDowUi();
  setScanningUi(true);
  setProgress(0);
  hideSuggestions();
  state.scanHotels = [];
  state.scanProgressDone = 0;
  renderRows([], { resetPage: true });

  try {
    const status = await sendMessage({ type: "GET_STATUS" });
    if (status.unauthorized || state.awaitingReauth) {
      state.awaitingReauth = false;
      const restored = await sendMessage({ type: "RESTORE_SESSION" });
      if (restored.guestId) setSession(restored.guestId, { userName: restored.userName || null });
    }

    let hotels = [];
    let picked = state.selectedSuggestion;

    // Match Go Hilton: resolve free text through Hilton autocomplete when nothing is selected.
    if (!picked && values.destination) {
      setStatus(`Resolving “${values.destination}”…`);
      const ac = await sendMessage({
        type: "AUTOCOMPLETE_DESTINATION",
        query: values.destination,
        limit: 20,
      });
      if (state.stopRequested || ac.cancelled) {
        setStatus("Stopped.");
        return;
      }
      if (ac.ok && ac.suggestions?.length) {
        picked = pickBestDestinationSuggestion(ac.suggestions, values.destination);
        if (picked) {
          state.selectedSuggestion = picked;
          $("destination").value = picked.query || picked.label || picked.primary || values.destination;
        }
      }
    }

    if (
      !picked &&
      values.destination &&
      !/^cached$/i.test(values.destination)
    ) {
      setStatus(
        `Couldn’t resolve “${values.destination}” in Hilton. Pick a suggestion from the list.`,
        "warn"
      );
      return;
    }

    if (picked?.type === "hotel" && picked.ctyhocn) {
      hotels = [
        {
          ctyhocn: picked.ctyhocn,
          name: picked.primary,
          brandCode: null,
          city: picked.city,
          country: picked.country,
          state: picked.state,
        },
      ];
      state.scanHotels = hotels;
      setStatus(`Found 1 hotel. Scanning ${picked.primary}…`);
    } else if (isCachedSuggestion(picked) || /^cached$/i.test(values.destination)) {
      const dateBit = formatRangesSummary(values.ranges);
      setStatus(
        values.ctyhocn
          ? `Searching cached stays for ${values.hotel || values.ctyhocn}…`
          : `Searching cached stays (${dateBit})…`
      );
      const scanRes = await sendMessage({
        type: "SCAN_CACHED_RATES",
        ranges: values.ranges.map((r) => ({
          from: r.from,
          to: r.to,
          nights: r.nights,
          mode: r.mode || "exact",
        })),
        friendsAndFamily: values.rateType !== "tm",
        goOnly: values.goOnly,
        maxRate: values.maxRate,
        minRooms: values.minRooms,
        ctyhocn: values.ctyhocn || null,
      });
      if (state.stopRequested || scanRes.cancelled) {
        renderRows(scanRes.rows || []);
        setStatus(
          `Stopped. ${formatCount((scanRes.rows || []).filter((r) => !r.error).length)} cached matches so far.`
        );
        return;
      }
      if (!scanRes.ok) {
        throw new Error(scanRes.error || "Cached search failed");
      }
      let rows = scanRes.rows || [];
      if (values.ctyhocn) {
        const code = String(values.ctyhocn).toUpperCase();
        rows = rows.filter((r) => String(r.ctyhocn || "").toUpperCase() === code);
        if (rows.length) {
          const hotelLabel =
            COLUMN_FILTERS.find((c) => c.id === "hotelName")?.value(rows[0]) ||
            rows[0].hotelName ||
            code;
          state.columnFilters.hotelName = new Set([hotelLabel]);
        }
      }
      renderRows(rows);
      if (values.ctyhocn) updateColumnFilterUi("hotelName");
      const matched = rows.filter((r) => !r.error).length;
      const hotelsCached = values.ctyhocn
        ? matched
          ? 1
          : 0
        : uniqueHotelCount(rows.filter((r) => !r.error));
      setProgress(100);
      setStatus(
        matched
          ? values.ctyhocn
            ? `Done. ${formatCount(matched)} cached rate${matched === 1 ? "" : "s"} for ${
                values.hotel || values.ctyhocn
              }.`
            : `Done. ${formatCount(matched)} cached rates across ${formatCount(hotelsCached)} hotel${
                hotelsCached === 1 ? "" : "s"
              } (local only).`
          : values.ctyhocn
            ? `No cached rates for ${values.hotel || values.ctyhocn}.`
            : hotelsCached
              ? `No matching nights in ${formatCount(hotelsCached)} cached hotel calendar${
                  hotelsCached === 1 ? "" : "s"
                }.`
              : "No cached rates yet. Run a normal search first to populate the cache."
      );
      return;
    } else {
      const destination = picked?.query || values.destination;
      setStatus(
        isLargeAreaSuggestionPick(picked)
          ? `Loading hotels for ${destination}… This can take a while for large regions.`
          : `Finding hotels near ${destination}…`
      );
      const hotelRes = await sendMessage({
        type: "SEARCH_DESTINATION_HOTELS",
        destination,
        suggestion: picked,
      });
      if (state.stopRequested || hotelRes.cancelled) {
        setStatus("Stopped.");
        return;
      }
      if (!hotelRes.ok) {
        if (hotelRes.unauthorized) {
          markUnauthorized(hotelRes.error);
          return;
        }
        throw new Error(hotelRes.error || "Hotel search failed");
      }
      hotels = hotelRes.hotels || [];
      const placeLabel =
        hotelRes.place?.displayName ||
        hotelRes.resolvedSuggestion?.label ||
        destination;

      if (!hotels.length) {
        setProgress(100);
        setStatus(`No Hilton hotels in ${placeLabel}.`);
        renderRows([]);
        return;
      }

      state.scanHotels = hotels;
      setStatus(
        `Found ${formatCount(hotels.length)} hotel${hotels.length === 1 ? "" : "s"} for ${placeLabel}. Scanning calendars…`
      );
    }

    if (state.stopRequested) {
      setStatus("Stopped.");
      return;
    }

    const hotelTotal = state.scanHotels.length || hotels.length;
    if (hotelTotal) {
      setStatus(
        `Found ${formatCount(hotelTotal)} hotel${hotelTotal === 1 ? "" : "s"}. Scanning ${formatRangesSummary(values.ranges)}…`
      );
    } else {
      setStatus(`Scanning ${formatRangesSummary(values.ranges)}…`);
    }

    const scanRes = await sendMessage({
      type: "SCAN_RATES",
      hotels,
      ranges: values.ranges.map((r) => ({
        from: r.from,
        to: r.to,
        nights: r.nights,
        mode: r.mode || "exact",
      })),
      friendsAndFamily: values.rateType !== "tm",
      goOnly: values.goOnly,
      maxRate: values.maxRate,
      minRooms: values.minRooms,
      delayMs: SCAN_DELAY_MS,
    });
    if (!scanRes.ok) {
      if (scanRes.unauthorized || scanErrorsAreUnauthorized(scanRes.rows)) {
        renderRows(scanRes.rows || []);
        markUnauthorized(scanRes.error || "Hilton session expired. Sign in again to continue.");
        return;
      }
      throw new Error(scanRes.error || "Rate scan failed");
    }

    state.scanHotels = [];
    renderRows(scanRes.rows || []);
    if (scanRes.unauthorized || scanErrorsAreUnauthorized(state.scanErrors)) {
      markUnauthorized(scanRes.error || "Hilton session expired. Sign in again to continue.");
      return;
    }

    setSession(scanRes.guestId || null, { userName: scanRes.userName || state.userName || null });
    const matchedRows = (scanRes.rows || []).filter((r) => !r.error);
    const matched = matchedRows.length;
    const matchedHotels = uniqueHotelCount(matchedRows);
    const cachedMatched = matchedRows.filter((r) => r.fromCache).length;
    const failCount = state.scanErrors.length;
    const cacheBit = cachedMatched > 0 ? ` · ${formatCount(cachedMatched)} from cache` : "";
    const failBit = failCount ? ` · ${formatScanErrorStatus(state.scanErrors)}` : "";
    if (scanRes.cancelled || state.stopRequested) {
      setProgress(scanRes.total ? (scanRes.done / scanRes.total) * 100 : 0);
      setStatus(
        `Stopped. ${formatCount(matchedHotels)} matching hotel${matchedHotels === 1 ? "" : "s"} so far${cacheBit}${failBit}.`,
        failCount ? "warn" : ""
      );
    } else if (failCount && !matched) {
      setProgress(100);
      setStatus(`No matching hotels. ${formatScanErrorStatus(state.scanErrors)}`, "warn");
    } else if (failCount) {
      setProgress(100);
      setStatus(
        `Done. ${formatCount(matchedHotels)} matching hotel${matchedHotels === 1 ? "" : "s"}${cacheBit}${failBit}.`,
        "warn"
      );
    } else {
      setProgress(100);
      setStatus(`Done. ${formatCount(matchedHotels)} matching hotel${matchedHotels === 1 ? "" : "s"}${cacheBit}.`);
    }
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    state.stopRequested = false;
    state.scanHotels = [];
    state.scanProgressDone = 0;
    setScanningUi(false);
  }
}

chrome.runtime?.onMessage?.addListener((message) => {
  if (message?.type !== "SCAN_PROGRESS" || !message.total) return;
  if (!state.scanning) return;
  // Cache-hit streaks emit progress with no delay, so multiple snapshots can be
  // in flight. Applying an older one overwrites newer rows (failed count / cache
  // icons flicker). Only accept monotonic `done`.
  const done = Number(message.done) || 0;
  if (done < state.scanProgressDone) return;
  state.scanProgressDone = done;
  if (message.unauthorized) {
    state.scanHotels = [];
    renderRows(message.rows || []);
    markUnauthorized("Hilton session expired. Sign in again to continue.");
    return;
  }
  const pct = message.total
    ? Math.min(100, Math.round((done / message.total) * 100))
    : 0;
  setProgress(pct);
  const hotelTotal = state.scanHotels.length || message.hotelCount || 0;
  const foundBit = hotelTotal
    ? `Found ${formatCount(hotelTotal)} hotel${hotelTotal === 1 ? "" : "s"} · `
    : "";
  const matchCount = Number(message.matches);
  const failCount = Array.isArray(message.rows)
    ? message.rows.filter((r) => r?.error).length
    : 0;
  const tallyBit =
    Number.isFinite(matchCount) && matchCount >= 0
      ? ` · ${formatCount(matchCount)} stay${matchCount === 1 ? "" : "s"}${
          failCount ? ` · ${formatCount(failCount)} failed` : ""
        }`
      : "";
  setStatus(`${foundBit}Scanning ${message.hotel || "…"}… · ${pct}%${tallyBit}`);
  if (Array.isArray(message.rows)) {
    renderRows(rowsForScanProgress(message.rows));
  }
});

function setupClearableDateFields() {
  setupDateRangesField("dateRanges", {
    onChange() {
      writeParams(formValues());
    },
  });
  setupDateRangesField("flightDateRanges", {
    placeholder: "Add departure → return",
    allowWindow: false,
    ariaLabel: "Choose trip dates",
    exactStartHint: "Select departure",
    exactEndHint: "Select return",
    onChange() {
      writeParams(formValues());
      updateSeatsApiCostHint();
    },
  });
}

async function boot() {
  const params = readParams();
  const start = todayISO();
  const end = addDaysISO(start, 1);
  setupClearableDateFields();
  setupSearchMode();
  setupFlightResultsUi();
  setupFlightRecentSearches();
  setTripSelectionListener(onTripFlightSelectionChange);
  $("selectPriceOptimalFlightBtn")?.addEventListener("click", () => {
    selectPriceOptimalTripCombo();
  });
  $("selectPriceOptimalHotelBtn")?.addEventListener("click", () => {
    selectPriceOptimalTripCombo();
  });
  updatePriceOptimalSelectButtons();
  $("tripSummaryClear")?.addEventListener("click", () => {
    clearTripSelection();
  });
  $("tripSummarySave")?.addEventListener("click", () => {
    toggleSaveCurrentItinerary();
  });
  $("destination").value = "";
  state.selectedSuggestion = null;
  const initialRanges = params.ranges?.length
    ? params.ranges
    : [{ from: start, to: end }];
  setDateRanges(initialRanges);
  $("maxRate").value = params.maxRate;
  $("minRooms").value = String(parseMinRooms(params.minRooms, 1));
  $("rateType").value = "fnf";
  updateRateTypeUi();
  state.dowSelected = new Set();
  state.focusCtyhocn = params.ctyhocn || null;
  state.focusHotelName = params.hotel || null;

  if ($("flightOrigins")) setIataCodes("flightOrigins", params.flightOrigins || "");
  if ($("flightDestinations")) setIataCodes("flightDestinations", params.flightDestinations || "");
  const initialFlightRanges =
    params.flightRanges?.length
      ? params.flightRanges
      : [{ from: start, to: end, mode: "exact" }];
  setDateRanges(initialFlightRanges, "flightDateRanges");
  setFlightTripType(params.flightTripType === "oneway" ? "oneway" : "roundtrip");
  setSearchMode(params.searchMode || "hotel");

  // Deep-link from map: open Cached search for one hotel (all dates / lengths).
  if (params.ctyhocn) {
    setSearchMode("hotel");
    $("destination").value = "Cached";
    state.selectedSuggestion = { ...CACHED_SUGGESTION };
    setDateRanges([]);
  }

  writeParams(formValues());

  await loadPersistedRoomDetails();
  await loadRecentSearches();
  state.savedItineraries = await loadSavedItineraries();
  await setupSeatsApiKey();

  $("searchForm").addEventListener("submit", runSearch);
  $("searchBtn").addEventListener("click", (e) => {
    if (!state.scanning) return;
    e.preventDefault();
    stopSearch();
  });
  $("flightSearchBtn")?.addEventListener("click", (e) => {
    if (!state.scanning) return;
    e.preventDefault();
    stopSearch();
  });
  $("exportBtn").addEventListener("click", exportCsv);
  $("pageSize")?.addEventListener("change", () => {
    const next = Number($("pageSize").value) || 25;
    state.pageSize = [25, 50, 75, 100].includes(next) ? next : 25;
    state.page = 0;
    refreshTable();
  });
  $("pagePrev")?.addEventListener("click", () => {
    if (state.page <= 0) return;
    state.page -= 1;
    refreshTable();
  });
  $("pageNext")?.addEventListener("click", () => {
    const totalPages = totalPagesFor(state.rows.length);
    if (state.page >= totalPages - 1) return;
    state.page += 1;
    refreshTable();
  });
  $("pageJump")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpToResultsPage($("pageJump").value);
      $("pageJump").blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      updatePagerUi(state.rows.length);
      $("pageJump").blur();
    }
  });
  $("pageJump")?.addEventListener("change", () => {
    jumpToResultsPage($("pageJump").value);
  });
  $("pageJump")?.addEventListener("focus", () => {
    $("pageJump").select();
  });
  $("resultsBody").addEventListener("click", (e) => {
    const cacheRefresh = e.target.closest("[data-cache-refresh]");
    if (cacheRefresh?.dataset.cacheRefresh) {
      e.preventDefault();
      e.stopPropagation();
      refreshCachedEntry(cacheRefresh.dataset.cacheRefresh);
      return;
    }
    const descToggle = e.target.closest("[data-room-desc-stay][data-room-desc-code]");
    if (descToggle) {
      e.preventDefault();
      e.stopPropagation();
      toggleRoomDesc(descToggle.dataset.roomDescStay, descToggle.dataset.roomDescCode);
      return;
    }
    const roomsToggle = e.target.closest("[data-rooms-toggle]");
    if (roomsToggle?.dataset.roomsToggle) {
      e.preventDefault();
      e.stopPropagation();
      toggleRoomsSection(roomsToggle.dataset.roomsToggle);
      return;
    }
    const roomGroupRow = e.target.closest("tr.room-group-row");
    if (roomGroupRow?.dataset.stayKey && roomGroupRow?.dataset.roomCode) {
      e.preventDefault();
      e.stopPropagation();
      toggleRoomGroup(roomGroupRow.dataset.stayKey, roomGroupRow.dataset.roomCode);
      return;
    }
    const roomSortBtn = e.target.closest(".room-sort-btn");
    if (roomSortBtn?.dataset.sort) {
      e.preventDefault();
      e.stopPropagation();
      setRoomSort(roomSortBtn.dataset.sort);
      return;
    }
    if (e.target.closest("a")) return;
    const hotelSelect = e.target.closest("[data-hotel-select]");
    if (hotelSelect?.dataset.hotelSelect) {
      e.preventDefault();
      e.stopPropagation();
      selectHotelForTrip(hotelSelect.dataset.hotelSelect);
      return;
    }
    const row = e.target.closest("tr.result-row");
    if (!row?.dataset.rowKey) return;
    toggleExpanded(row.dataset.rowKey);
  });
  $("resultsBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("[data-room-desc-stay][data-room-desc-code], [data-rooms-toggle], [data-cache-refresh], button, a")) {
      return;
    }
    const roomGroupRow = e.target.closest("tr.room-group-row");
    if (roomGroupRow?.dataset.stayKey && roomGroupRow?.dataset.roomCode) {
      e.preventDefault();
      toggleRoomGroup(roomGroupRow.dataset.stayKey, roomGroupRow.dataset.roomCode);
      return;
    }
    const row = e.target.closest("tr.result-row");
    if (!row?.dataset.rowKey) return;
    e.preventDefault();
    toggleExpanded(row.dataset.rowKey);
  });
  document.querySelectorAll("#resultsTable > thead .sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSort(btn.dataset.sort));
  });
  updateSortHeaders();
  setupDowFilter();
  setupRateTypeFilter();
  setupColumnFilters();
  setupDestinationAutocomplete();
  setupIataAutocomplete();
  setupReauthHandling();
  setupMetricsSession();
  refreshSession();

  if (params.ctyhocn) {
    queueMicrotask(() => runSearch());
  }
}

boot();
