import {
  setupDatePickers,
  refreshDatePickers,
} from "./calendar.js";

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
  roomGroupsOpen: new Set(),
  roomsSectionOpen: new Set(),
  roomDescOpen: new Set(),
  scanErrors: [],
  awaitingReauth: false,
  userName: null,
  roomFetchPending: [],
  roomFetchInFlight: 0,
  refreshingKeys: new Set(),
};

const RECENT_SEARCHES_KEY = "recentSearches";
const MAX_RECENT_SEARCHES = 8;
const ROOM_FETCH_CONCURRENCY = 1;
const ROOM_FETCH_DELAY_MS = 750;
const SCAN_DELAY_MS = 1000;
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

function readParams() {
  const params = new URLSearchParams(location.search);
  return {
    destination: params.get("destination") || params.get("destinations") || "",
    fromDate: params.get("from") || params.get("date") || "",
    toDate: params.get("to") || "",
    nights: Number(params.get("nights") || 1),
    maxRate: params.get("max_rate") || params.get("max_fees") || "",
    minRooms: Number(params.get("min_rooms") || params.get("min_seats") || 1),
    rateType: params.get("rate_type") || "fnf",
  };
}

function writeParams(values) {
  const params = new URLSearchParams();
  if (values.destination) params.set("destination", values.destination);
  if (values.fromDate) params.set("date", values.fromDate);
  if (values.toDate) params.set("to", values.toDate);
  if (values.nights) params.set("nights", String(values.nights));
  if (values.maxRate !== "" && values.maxRate != null) params.set("max_rate", String(values.maxRate));
  if (values.minRooms) params.set("min_rooms", String(values.minRooms));
  params.set("rate_type", values.rateType);
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
  const nightsRaw = $("nights").value;
  const rateType = $("rateType")?.value === "tm" ? "tm" : "fnf";
  return {
    destination: $("destination").value.trim(),
    fromDate: $("fromDate").value,
    toDate: $("toDate").value,
    nights: nightsRaw === "" ? null : Number(nightsRaw || 1),
    maxRate: $("maxRate").value === "" ? null : Number($("maxRate").value),
    minRooms: Number($("minRooms").value || 1),
    goOnly: false,
    rateType,
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
  const fromRow = Number(row?.nights);
  if (Number.isFinite(fromRow) && fromRow > 0) return fromRow;
  const fromForm = Number($("nights")?.value);
  if (Number.isFinite(fromForm) && fromForm > 0) return fromForm;
  return 1;
}

function formatStayEstimate(amount, currency, nights) {
  const rate = Number(amount);
  const n = Math.max(1, Number(nights) || 1);
  if (!Number.isFinite(rate)) return null;
  return formatMoneyAmount(rate * n, currency);
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
  return [...new Set(rowsMatchingFiltersExcept(id).map((row) => def.value(row)))].sort((a, b) =>
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

function filterResultRows(rows) {
  return filterByColumnFilters(filterByDow(rows));
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
    trigger.disabled = !values.length;
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
  // Defer rebuild so we don't remove the checkbox mid-click (which cancels the toggle
  // / retargets the click to document and makes options feel dead).
  requestAnimationFrame(() => refreshTable());
}

function positionColumnFilterPanel(id) {
  const trigger = document.querySelector(`.col-filter-trigger[data-col-filter="${id}"]`);
  const panel = document.querySelector(`.col-filter-panel[data-col-filter-panel="${id}"]`);
  const def = columnFilterDef(id);
  if (!trigger || !panel || panel.hidden || !def) return;
  const rect = trigger.getBoundingClientRect();
  const width = def.panelWidth || 220;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.width = `${width}px`;
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
      renderColumnFilterList(def.id);
    }
    panel.hidden = !isOpen;
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
      requestAnimationFrame(() => refreshTable());
    });
  }
  window.addEventListener("resize", () => {
    if (state.openColumnFilter) positionColumnFilterPanel(state.openColumnFilter);
  });
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
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  const chevron = trigger.querySelector(".dow-chevron");
  if (chevron) chevron.textContent = open ? "▴" : "▾";
  if (open) {
    setDowOpen(false);
    closeAllColumnFilters();
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
  $("dowPanel").hidden = !open;
  $("dowTrigger").setAttribute("aria-expanded", open ? "true" : "false");
  $("dowTrigger").querySelector(".dow-chevron").textContent = open ? "▴" : "▾";
  if (open) {
    setRateTypeOpen(false);
    closeAllColumnFilters();
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
    refreshTable();
  });
  document.addEventListener("click", () => {
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

function migrateRowKeyState(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  for (const set of [
    state.expanded,
    state.refreshingKeys,
    state.roomsSectionOpen,
  ]) {
    if (set.has(oldKey)) {
      set.delete(oldKey);
      set.add(newKey);
    }
  }
  if (state.roomDetails.has(oldKey)) {
    state.roomDetails.set(newKey, state.roomDetails.get(oldKey));
    state.roomDetails.delete(oldKey);
  }
  for (const set of [state.roomGroupsOpen, state.roomDescOpen]) {
    for (const id of [...set]) {
      if (id.startsWith(`${oldKey}::`)) {
        set.delete(id);
        set.add(`${newKey}::${id.slice(oldKey.length + 2)}`);
      }
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
      : "Cached (less than 24 hours old) — click to refresh";
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
      state.roomDetails.delete(old);
      state.roomsSectionOpen.delete(old);
      continue;
    }
    // Re-apply current search filters to refreshed day.
    if (values.goOnly && !fresh.isGoRate) continue;
    if (values.maxRate != null && Number(fresh.amount) > Number(values.maxRate)) continue;
    if ((fresh.roomsAvail ?? 0) < Number(values.minRooms || 1)) continue;

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
    const newKey = rowKey(updated);
    if (!res.roomsError) {
      state.roomDetails.set(newKey, {
        status: "ok",
        rooms: res.rooms || [],
        fromCache: false,
        currency: res.currency || null,
      });
    } else {
      state.roomDetails.delete(newKey);
      enqueueRoomRateFetch(newKey, updated, { priority: true });
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
    ["Source", row.fromCache ? "Cached (< 24h)" : "Live fetch"],
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
  const detail = state.roomDetails.get(key);
  const stay = stayDatesForRoomFetch(row);
  const inventoryNote = row.inventoryOnly
    ? `<div class="inventory-rooms-note">${escapeHtml(COUNTRY_ROOMS_HINT)}</div>`
    : "";
  if (!detail || detail.status === "loading" || detail.status === "queued") {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      key,
      "Available rooms"
    )}<div class="rooms-status">${
      row.inventoryOnly
        ? "Loading room rates for this hotel…"
        : "Loading room rates for this stay…"
    }</div></div>`;
  }
  if (detail.status === "error") {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      key,
      "Available rooms"
    )}<div class="rooms-status bad">${escapeHtml(
      detail.error || "Could not load rooms."
    )}</div></div>`;
  }
  const rooms = detail.rooms || [];
  if (!rooms.length) {
    return `<div class="rooms-section">${inventoryNote}${roomsSectionHeading(
      key,
      "Available rooms"
    )}<div class="rooms-status">No room rates returned for this stay.</div></div>`;
  }
  const cacheNote = detail.fromCache ? ` · cached` : "";
  const open = isRoomsSectionOpen(key);
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
    return `<div class="rooms-section collapsed">${inventoryNote}${roomsSectionHeading(key, title, {
      toggleable: true,
      open: false,
    })}</div>`;
  }
  const nights = stay?.nights ?? stayNightsFor(row);
  const currency = row.currency || detail.currency;
  const rowsHtml = groups
    .map((group) => {
      const openGroup = isRoomGroupOpen(key, group.code);
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
      const descParts = roomGroupDescriptionParts(key, group);
      const header = `<tr
        class="room-group-row${openGroup ? " open" : ""}"
        data-stay-key="${escapeHtml(key)}"
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
    ${roomsSectionHeading(key, title, { toggleable: true, open: true })}
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

async function loadRoomRates(key, row) {
  if (!row?.ctyhocn) return;
  const stay = stayDatesForRoomFetch(row);
  if (!stay) return;
  const existing = state.roomDetails.get(key);
  if (existing?.status === "loading" || existing?.status === "ok") return;

  state.roomDetails.set(key, { status: "loading", rooms: [] });
  // Only paint a loading state when the detail panel is open.
  if (state.expanded.has(key)) refreshTable();

  const values = formValues();
  const res = await sendMessage({
    type: "FETCH_ROOM_RATES",
    ctyhocn: row.ctyhocn,
    arrivalDate: stay.arrivalDate,
    departureDate: stay.departureDate,
    friendsAndFamily: values.rateType !== "tm",
  });

  // Always keep results so F&F "vs / save" can show on the main price cell
  // even when the rooms dropdown is still collapsed.
  if (!res.ok) {
    if (res.unauthorized) {
      markUnauthorized(res.error);
      state.roomDetails.set(key, {
        status: "error",
        error: res.error || "Session expired.",
        rooms: [],
      });
    } else {
      state.roomDetails.set(key, {
        status: "error",
        error: res.error || "Room shop failed.",
        rooms: [],
      });
    }
  } else {
    state.roomDetails.set(key, {
      status: "ok",
      rooms: res.rooms || [],
      fromCache: Boolean(res.fromCache),
      currency: res.currency || null,
    });
  }
  refreshTable();
}

function clearRoomFetchQueue() {
  state.roomFetchPending = [];
}

function enqueueRoomRateFetch(key, row, { priority = false } = {}) {
  const existing = state.roomDetails.get(key);
  if (
    existing?.status === "ok" ||
    existing?.status === "loading" ||
    existing?.status === "queued"
  ) {
    return;
  }
  state.roomDetails.set(key, { status: "queued", rooms: [] });
  const item = { key, row };
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

/** Prefetch shop rooms as soon as calendar entries land (for F&F compare + expand). */
function prefetchRoomRatesForRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || row.error || row.inventoryOnly) continue;
    if (!row.arrivalDate || !row.departureDate) continue;
    const key = rowKey(row);
    enqueueRoomRateFetch(key, row, { priority: isFamilyAndFriendsRate(row) });
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
  const arrivalDate = values.fromDate;
  if (!arrivalDate) return;
  const nights = Math.max(1, Number(values.nights) || 1);
  const departureDate = addDaysISO(arrivalDate, nights);
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
      setStatus(`Stopped. ${priced} of ${total} hotels priced in ${placeLabel}.`, "warn");
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
      setStatus(`Stopped. ${priced} of ${total} hotels priced in ${placeLabel}.`, "warn");
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
      `${placeLabel}: priced ${priced} of ${total} hotels for ${arrivalDate} → ${departureDate}…`
    );
  }

  const failBit = failed ? ` · ${failed} hotel(s) failed to price` : "";
  setProgress(100);
  setStatus(
    `Done. ${total} hotels in ${placeLabel} · ${priced} priced for ${nightsLabel(nights)} from ${arrivalDate}${failBit}. ${COUNTRY_ROOMS_HINT}`,
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
  const arrivalDate = values.fromDate;
  if (!arrivalDate) return null;
  const nights = Math.max(1, Number(values.nights) || 1);
  return {
    arrivalDate,
    departureDate: addDaysISO(arrivalDate, nights),
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
  refreshTable();
  const row =
    state.rows.find((r) => rowKey(r) === key) ||
    state.allRows.find((r) => rowKey(r) === key);
  if (row) enqueueRoomRateFetch(key, row, { priority: true });
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

function resultsCountLabel(visibleRows, { totalRows = null, filtersActive = false } = {}) {
  const stays = (visibleRows || []).length;
  const hotels = uniqueHotelCount(visibleRows);
  const staysBit =
    filtersActive && totalRows != null && stays !== totalRows
      ? `${stays} of ${totalRows} stays`
      : `${stays} stay${stays === 1 ? "" : "s"}`;
  return `${staysBit} • ${hotels} hotel${hotels === 1 ? "" : "s"}`;
}

function refreshTable() {
  updateColumnFilterUi();
  const filtered = filterResultRows(state.allRows);
  state.rows = sortedRows(filtered);
  const validKeys = new Set(state.rows.map(rowKey));
  state.expanded = new Set([...state.expanded].filter((k) => validKeys.has(k)));

  const body = $("resultsBody");
  $("exportBtn").disabled = !state.rows.length;
  updateSortHeaders();

  const filtersActive = state.dowSelected.size > 0 || anyColumnFilterActive();

  if (!state.rows.length) {
    let emptyMsg = state.allRows.length
      ? filtersActive
        ? "No nights match the current filters."
        : "No matching Go rates in range."
      : state.scanErrors.length
        ? `No matching nights. ${state.scanErrors.length} hotel request(s) failed.`
        : "No matching Go rates in range.";
    body.innerHTML = `<tr class="empty"><td colspan="8"><div class="empty-msg">${escapeHtml(
      emptyMsg
    )}</div>${scanErrorsHtml(state.scanErrors)}</td></tr>`;
    const emptyLabel = state.allRows.length
      ? resultsCountLabel([], {
          totalRows: state.allRows.length,
          filtersActive: true,
        })
      : "0 stays • 0 hotels";
    $("resultsLabel").textContent = state.scanErrors.length
      ? `${emptyLabel} · ${state.scanErrors.length} failed`
      : emptyLabel;
    return;
  }

  const label = resultsCountLabel(state.rows, {
    totalRows: state.allRows.length,
    filtersActive,
  });
  $("resultsLabel").textContent = state.scanErrors.length
    ? `${label} · ${state.scanErrors.length} failed`
    : label;
  body.innerHTML = state.rows
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
      const detail = state.roomDetails.get(key);
      let mainCompare = null;
      if (
        !row.inventoryOnly &&
        isFamilyAndFriendsRate(row) &&
        detail?.status === "ok" &&
        detail.rooms?.length
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
      return `<tr class="result-row${open ? " open" : ""}" data-row-key="${escapeHtml(key)}" tabindex="0" aria-expanded="${open ? "true" : "false"}">
        <td class="date-cell">${cacheIcon}${escapeHtml(dateLabel)}</td>
        <td>
          <div class="hotel-name">${escapeHtml(row.hotelName)}</div>
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
        <td colspan="8">
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
}

function renderRows(rows, { syncSession = true } = {}) {
  const incoming = Array.isArray(rows) ? rows : [];
  state.scanErrors = incoming.filter((r) => r.error);
  state.allRows = incoming.filter((r) => !r.error);
  refreshTable();
  prefetchRoomRatesForRows(state.allRows);
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
  return [
    entry.destination || "",
    entry.fromDate || "",
    entry.toDate || "",
    entry.nights ?? "",
    entry.maxRate ?? "",
    entry.minRooms ?? "",
    entry.rateType || "",
    sug?.ctyhocn || sug?.placeId || sug?.query || "",
  ].join("|");
}

function snapshotFromForm() {
  const values = formValues();
  const sug = state.selectedSuggestion;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    destination: values.destination,
    fromDate: values.fromDate,
    toDate: values.toDate,
    nights: values.nights,
    maxRate: values.maxRate,
    minRooms: values.minRooms,
    rateType: values.rateType,
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
  if (!entry.destination) return;
  const cached = /^cached$/i.test(entry.destination) || entry.selectedSuggestion?.type === "cached";
  if (!cached && (!entry.fromDate || !entry.toDate)) return;
  const fp = searchFingerprint(entry);
  const next = [entry, ...state.recentSearches.filter((r) => searchFingerprint(r) !== fp)];
  await persistRecentSearches(next);
}

async function removeRecentSearch(id) {
  await persistRecentSearches(state.recentSearches.filter((r) => r.id !== id));
}

function formatRecentMeta(entry) {
  const bits = [];
  if (entry.fromDate && entry.toDate) bits.push(`${entry.fromDate} → ${entry.toDate}`);
  else if (entry.fromDate) bits.push(`from ${entry.fromDate}`);
  else if (entry.toDate) bits.push(`to ${entry.toDate}`);
  if (entry.nights != null && entry.nights !== "") bits.push(nightsLabel(entry.nights));
  else bits.push("any nights");
  if (entry.maxRate != null && entry.maxRate !== "") bits.push(`max ${entry.maxRate}`);
  bits.push(entry.rateType === "tm" ? "Team Member" : "F&F");
  return bits.join(" · ");
}

function applySearchSnapshot(entry) {
  $("destination").value = entry.destination || "";
  $("fromDate").value = entry.fromDate || "";
  $("toDate").value = entry.toDate || "";
  refreshDatePickers();
  $("nights").value = entry.nights == null || entry.nights === "" ? "" : String(entry.nights);
  $("maxRate").value = entry.maxRate == null || entry.maxRate === "" ? "" : String(entry.maxRate);
  $("minRooms").value = String(entry.minRooms || 1);
  $("rateType").value = entry.rateType || "fnf";
  updateRateTypeUi();
  state.selectedSuggestion = entry.selectedSuggestion || null;
  writeParams(formValues());
}

function filteredRecentSearches(query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return state.recentSearches;
  return state.recentSearches.filter((entry) => {
    const hay = [
      entry.destination,
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
  const recents = filteredRecentSearches(query);
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
      html += `<div class="recent-row">
      <button type="button" class="suggest-item recent-item" role="option" data-index="${idx}">
        <span class="suggest-primary">${escapeHtml(entry.destination)}</span>
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
  hideSuggestions();
  applySearchSnapshot(entry);
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

function nightsLabel(nights) {
  const n = Number(nights) || 1;
  return n === 1 ? "1-night" : `${n}-night`;
}

function setScanningUi(scanning) {
  state.scanning = scanning;
  const btn = $("searchBtn");
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
  const cachedSearch =
    isCachedSuggestion(state.selectedSuggestion) || /^cached$/i.test(values.destination);
  if (!values.destination) {
    setStatus("Destination is required.");
    return;
  }
  if (!cachedSearch && (!values.fromDate || !values.toDate)) {
    setStatus("Destination and dates are required.");
    return;
  }
  if (values.fromDate && values.toDate && values.toDate < values.fromDate) {
    setStatus("“To” date must be on or after “From”.");
    return;
  }
  if (!cachedSearch && (values.nights == null || values.nights < 1)) {
    setStatus("Nights must be at least 1.");
    return;
  }

  writeParams(values);
  rememberCurrentSearch();
  state.stopRequested = false;
  clearRoomFetchQueue();
  state.roomDetails.clear();
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
  renderRows([]);

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
      setStatus(`Scanning ${picked.primary}…`);
    } else if (isCachedSuggestion(picked) || /^cached$/i.test(values.destination)) {
      const nightsBit =
        values.nights == null ? "any length" : nightsLabel(values.nights);
      const dateBit =
        values.fromDate && values.toDate
          ? `${values.fromDate} → ${values.toDate}`
          : values.fromDate
            ? `from ${values.fromDate}`
            : values.toDate
              ? `to ${values.toDate}`
              : "any dates";
      setStatus(`Searching cached ${nightsBit} stays (${dateBit})…`);
      const scanRes = await sendMessage({
        type: "SCAN_CACHED_RATES",
        fromDate: values.fromDate || null,
        toDate: values.toDate || null,
        nights: values.nights,
        friendsAndFamily: values.rateType !== "tm",
        goOnly: values.goOnly,
        maxRate: values.maxRate,
        minRooms: values.minRooms,
      });
      if (state.stopRequested || scanRes.cancelled) {
        renderRows(scanRes.rows || []);
        setStatus(
          `Stopped. ${(scanRes.rows || []).filter((r) => !r.error).length} cached matches so far.`
        );
        return;
      }
      if (!scanRes.ok) {
        throw new Error(scanRes.error || "Cached search failed");
      }
      renderRows(scanRes.rows || []);
      const matched = (scanRes.rows || []).filter((r) => !r.error).length;
      const hotelsCached = scanRes.hotelsCached || 0;
      setProgress(100);
      setStatus(
        matched
          ? `Done. ${matched} cached rates across ${hotelsCached} hotel${hotelsCached === 1 ? "" : "s"} (local only).`
          : hotelsCached
            ? `No matching nights in ${hotelsCached} cached hotel calendar${hotelsCached === 1 ? "" : "s"}.`
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

      setStatus(
        `Found ${hotels.length} hotels for ${placeLabel}. Scanning calendars at a steady pace…`
      );
    }

    if (state.stopRequested) {
      setStatus("Stopped.");
      return;
    }

    setStatus(
      `Scanning ${nightsLabel(values.nights)} stays with check-in ${values.fromDate} → ${values.toDate}…`
    );

    const scanRes = await sendMessage({
      type: "SCAN_RATES",
      hotels,
      fromDate: values.fromDate,
      toDate: values.toDate,
      nights: values.nights,
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

    renderRows(scanRes.rows || []);
    if (scanRes.unauthorized || scanErrorsAreUnauthorized(state.scanErrors)) {
      markUnauthorized(scanRes.error || "Hilton session expired. Sign in again to continue.");
      return;
    }

    setSession(scanRes.guestId || null, { userName: scanRes.userName || state.userName || null });
    const matchedRows = (scanRes.rows || []).filter((r) => !r.error);
    const matched = matchedRows.length;
    const cachedMatched = matchedRows.filter((r) => r.fromCache).length;
    const failCount = state.scanErrors.length;
    const cacheBit = cachedMatched > 0 ? ` · ${cachedMatched} from cache` : "";
    const failBit = failCount ? ` · ${formatScanErrorStatus(state.scanErrors)}` : "";
    if (scanRes.cancelled || state.stopRequested) {
      setProgress(scanRes.total ? (scanRes.done / scanRes.total) * 100 : 0);
      setStatus(`Stopped. ${matched} matching hotels so far${cacheBit}${failBit}.`, failCount ? "warn" : "");
    } else if (failCount && !matched) {
      setProgress(100);
      setStatus(`No matching hotels. ${formatScanErrorStatus(state.scanErrors)}`, "warn");
    } else if (failCount) {
      setProgress(100);
      setStatus(`Done. ${matched} matching hotels${cacheBit}${failBit}.`, "warn");
    } else {
      setProgress(100);
      setStatus(`Done. ${matched} matching hotels${cacheBit}.`);
    }
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    state.stopRequested = false;
    setScanningUi(false);
  }
}

chrome.runtime?.onMessage?.addListener((message) => {
  if (message?.type !== "SCAN_PROGRESS" || !message.total) return;
  if (!state.scanning) return;
  if (message.unauthorized) {
    renderRows(message.rows || []);
    markUnauthorized("Hilton session expired. Sign in again to continue.");
    return;
  }
  setProgress((message.done / message.total) * 100);
  const matchedRows = Array.isArray(message.rows) ? message.rows.filter((r) => !r.error) : [];
  const cachedMatched = matchedRows.filter((r) => r.fromCache).length;
  const cacheBit = cachedMatched > 0 ? ` · ${cachedMatched} from cache` : "";
  const matchBit = matchedRows.length ? ` · ${matchedRows.length} hotels found` : "";
  setStatus(`Scanning ${message.hotel}… (${message.done}/${message.total})${matchBit}${cacheBit}`);
  if (Array.isArray(message.rows)) {
    renderRows(message.rows);
  }
});

function setupClearableDateFields() {
  // Dates use the custom calendar picker; clearing is via the panel "Clear" control.
  setupDatePickers(["fromDate", "toDate"]);
}

async function boot() {
  const params = readParams();
  const start = todayISO();
  const end = addDaysISO(start, 1);
  setupClearableDateFields();
  $("destination").value = "";
  state.selectedSuggestion = null;
  $("fromDate").value = start;
  $("toDate").value = end;
  refreshDatePickers();
  $("nights").value = String(params.nights || 1);
  $("maxRate").value = params.maxRate;
  $("minRooms").value = String(params.minRooms || 1);
  $("rateType").value = "fnf";
  updateRateTypeUi();
  state.dowSelected = new Set();
  writeParams(formValues());

  await loadRecentSearches();

  $("searchForm").addEventListener("submit", runSearch);
  $("searchBtn").addEventListener("click", (e) => {
    if (!state.scanning) return;
    e.preventDefault();
    stopSearch();
  });
  $("exportBtn").addEventListener("click", exportCsv);
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
  setupReauthHandling();
  setupMetricsSession();
  refreshSession();
}

boot();
