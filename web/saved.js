import {
  itineraryFingerprint,
  itineraryTitle,
  loadSavedItineraries,
  removeSavedItinerary,
  snapshotFlight,
  snapshotHotel,
  upsertSavedItinerary,
} from "./saved-itineraries.js";
import {
  ensureTripDetails,
  formatMiles,
  formatPointsWithTaxes,
  formatProgramName,
  prepareFlightForSave,
  renderFlightLegSectionHtml,
  resolveFlightFromState,
  seedFlightsForSavedView,
  setFlightLegRefreshing,
  setFlightTableRefreshHook,
  taxAmountDollars,
  toggleFlightExpanded,
} from "./flights.js";

const $ = (id) => document.getElementById(id);

/** @type {string | null} */
let expandedId = null;
/** @type {any[]} */
let savedList = [];
let renderQueued = false;
/** Hotel detail row open per itinerary id */
const hotelDetailOpen = new Set();
/** Available-rooms section open per itinerary id */
const hotelRoomsOpen = new Set();
/** Room type groups open: `${itinId}::${roomCode}` */
const hotelRoomGroupsOpen = new Set();
/** `${itinId}:outbound|return` while a flight cache refresh runs */
const refreshingFlightKeys = new Set();
/** Itinerary ids with hotel cache refresh in flight */
const refreshingHotelIds = new Set();

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Extension messaging unavailable." });
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMoneyAmount(amount, currency, amountFmt = null) {
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

function formatMoney(amount, currency = "USD") {
  return formatMoneyAmount(amount, currency);
}

function formatSavedAt(ts) {
  const when = new Date(Number(ts));
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hotelBookUrl(hotel) {
  if (hotel?.bookUrl) return hotel.bookUrl;
  if (!hotel?.ctyhocn) return null;
  const url = new URL("https://www.hilton.com/en/book/reservation/rooms/");
  url.searchParams.set("ctyhocn", hotel.ctyhocn);
  if (hotel.arrivalDate) url.searchParams.set("arrivalDate", hotel.arrivalDate);
  if (hotel.departureDate) url.searchParams.set("departureDate", hotel.departureDate);
  url.searchParams.set("room1NumAdults", "1");
  return url.toString();
}

function totalLabel(entry) {
  const parts = [];
  let points = entry?.totals?.points;
  let cash = entry?.totals?.cash;
  if (points == null) {
    points = 0;
    for (const leg of [entry?.outbound, entry?.return]) {
      const m = Number(leg?.mileageCost);
      if (Number.isFinite(m)) points += m;
    }
  }
  if (cash == null) {
    cash = 0;
    for (const leg of [entry?.outbound, entry?.return]) {
      const tax = taxAmountDollars(leg);
      if (tax != null) cash += tax;
    }
    const hotel = entry?.hotel;
    if (hotel?.amount != null && Number.isFinite(Number(hotel.amount))) {
      const nights = hotelNights(hotel);
      cash += Number(hotel.amount) * nights;
    }
  }
  if (Number.isFinite(points) && points > 0) parts.push(`${formatMiles(points)} pts`);
  if (Number.isFinite(cash) && cash > 0) parts.push(formatMoney(cash));
  return parts.length ? parts.join(" + ") : "—";
}

function weekdayLabel(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
}

function hotelNights(hotel) {
  if (hotel?.arrivalDate && hotel?.departureDate) {
    const a = new Date(`${hotel.arrivalDate}T12:00:00`);
    const b = new Date(`${hotel.departureDate}T12:00:00`);
    const diff = Math.round((b - a) / 86400000);
    if (Number.isFinite(diff) && diff > 0) return diff;
  }
  const n = Number(hotel?.nights);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isFamilyAndFriendsRate(rate) {
  if (!rate) return false;
  if (rate.specialRateType === "familyAndFriends") return true;
  return /family\s*and\s*friends|fft|go hilton fftp/i.test(
    `${rate.specialRateType || ""} ${rate.ratePlanName || ""}`
  );
}

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
    if (!best || amount < Number(best.amount)) best = cand;
  }
  return best;
}

function rateDisplayHtml(amount, currency, amountFmt, nights, compareWith = null) {
  const nightly = formatMoneyAmount(amount, currency, amountFmt);
  const n = Number(nights);
  const estimate =
    Number.isFinite(Number(amount)) && Number.isFinite(n) && n > 0
      ? formatMoneyAmount(Number(amount) * n, currency)
      : null;
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

function hotelCacheIconHtml(itinId, hotel) {
  if (!hotel) return "";
  const refreshing = refreshingHotelIds.has(itinId);
  const captured = formatSavedAt(hotel.fetchedAt);
  const title = refreshing
    ? "Refreshing…"
    : captured
      ? `Cached · captured ${captured} — click to refresh`
      : "Cached saved result — click to refresh";
  return `<button
    type="button"
    class="cache-icon${refreshing ? " refreshing" : ""}"
    data-saved-hotel-cache-refresh="${escapeHtml(itinId)}"
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

function hotelDetailItems(hotel) {
  const nights = hotelNights(hotel);
  const compare = hotel.compareRate || null;
  const saved =
    compare?.amount != null && hotel.amount != null
      ? Number(compare.amount) - Number(hotel.amount)
      : null;
  if (hotel.inventoryOnly) {
    return [
      ["Hotel code", hotel.ctyhocn || "—"],
      ["Brand", hotel.brandCode || "—"],
      ["City", hotel.city || "—"],
      ["Country", hotel.country || "—"],
      ["Lead nightly", formatMoneyAmount(hotel.amount, hotel.currency, hotel.amountFmt)],
      ["Rate", hotel.ratePlanName || "—"],
      ["Rate code", hotel.ratePlanCode || "—"],
      ["Source", "Country inventory (lead rate)"],
    ];
  }
  return [
    ["Check-in", hotel.arrivalDate || "—"],
    ["Check-out", hotel.departureDate || "—"],
    ["Stay nights", nights],
    ["Weekday (check-in)", weekdayLabel(hotel.arrivalDate)],
    ["Hotel code", hotel.ctyhocn || "—"],
    ["Brand", hotel.brandCode || "—"],
    ["City", hotel.city || "—"],
    ["Country", hotel.country || "—"],
    ["Nightly price", formatMoneyAmount(hotel.amount, hotel.currency, hotel.amountFmt)],
    [
      "Est. stay total",
      Number.isFinite(Number(hotel.amount))
        ? formatMoneyAmount(Number(hotel.amount) * nights, hotel.currency)
        : "—",
    ],
    compare?.amount != null
      ? [
          "Next rate nightly",
          `${formatMoneyAmount(compare.amount, hotel.currency)}${
            compare.ratePlanName ? ` · ${compare.ratePlanName}` : ""
          }`,
        ]
      : null,
    saved != null && saved > 0
      ? ["F&F savings / night", formatMoneyAmount(saved, hotel.currency)]
      : null,
    hotel.currencyOriginal && hotel.currencyOriginal !== "USD" && hotel.amountOriginal != null
      ? ["Original nightly", `${Number(hotel.amountOriginal).toLocaleString()} ${hotel.currencyOriginal}`]
      : null,
    ["Rooms left (calendar)", hotel.roomsAvail ?? "—"],
    ["Rate", hotel.ratePlanName || "—"],
    ["Rate code", hotel.ratePlanCode || "—"],
    ["Room type code", hotel.roomTypeCode || "—"],
    ["Special rate", hotel.specialRateType || "—"],
    ["Source", hotel.fromCache === false ? "Live refresh" : "Cached (< 4h)"],
  ].filter(Boolean);
}

function groupRoomsByType(rooms) {
  const map = new Map();
  for (const room of rooms || []) {
    const code = String(room.roomTypeCode || room.roomTypeName || "OTHER").toUpperCase();
    if (!map.has(code)) {
      map.set(code, {
        code,
        name: room.roomTypeName || room.roomTypeCode || code,
        rooms: [],
      });
    }
    map.get(code).rooms.push(room);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function hotelRoomsSectionHtml(itinId, hotel) {
  const rooms = hotel?.roomDetails?.rooms || [];
  if (!rooms.length) {
    return `<div class="rooms-section">
      <div class="rooms-title">Available rooms</div>
      <div class="rooms-status">Room rates were not loaded when this trip was saved.</div>
    </div>`;
  }
  const groups = groupRoomsByType(rooms);
  const cacheNote = hotel.roomDetails?.fromCache ? " · cached" : "";
  const title = `Available rooms (${rooms.length} prices · ${groups.length} types${cacheNote})`;
  const open = hotelRoomsOpen.has(itinId);
  const nights = hotelNights(hotel);
  const currency = hotel.currency || hotel.roomDetails?.currency;
  const bookUrl = hotelBookUrl(hotel);
  if (!open) {
    return `<div class="rooms-section collapsed">
      <button type="button" class="rooms-title-btn" data-saved-rooms-toggle="${escapeHtml(
        itinId
      )}" aria-expanded="false">
        <span class="rooms-title-chevron" aria-hidden="true">▸</span>
        <span class="rooms-title-label">${escapeHtml(title)}</span>
      </button>
    </div>`;
  }
  const rowsHtml = groups
    .map((group) => {
      const groupKey = `${itinId}::${group.code}`;
      const openGroup = hotelRoomGroupsOpen.has(groupKey);
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
      const header = `<tr
        class="room-group-row${openGroup ? " open" : ""}"
        data-saved-room-group="${escapeHtml(groupKey)}"
        tabindex="0"
        role="button"
        aria-expanded="${openGroup ? "true" : "false"}"
      >
        <td>
          <div class="room-group-cell">
            <div class="room-group-main">
              <div class="room-group-title">${groupTitle}</div>
            </div>
          </div>
        </td>
        <td class="rate">${cheapestHtml}</td>
        <td class="rooms-avail">${maxAvail || "—"}</td>
        <td class="rooms-plan"><span class="plan-count">${group.rooms.length} rate${
          group.rooms.length === 1 ? "" : "s"
        }</span></td>
        <td></td>
      </tr>`;
      if (!openGroup) return header;
      const rates = group.rooms
        .map((room) => {
          const go = room.isGoRate
            ? `<span class="badge go">${escapeHtml(room.specialRateType || "go")}</span>`
            : "";
          const compare = isFamilyAndFriendsRate(room)
            ? findNextHigherDifferentPlan(room, group.rooms)
            : null;
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
            <td class="rooms-book">${
              bookUrl
                ? `<a class="book-link" href="${escapeHtml(bookUrl)}" target="_blank" rel="noopener">Book</a>`
                : ""
            }</td>
          </tr>`;
        })
        .join("");
      return header + rates;
    })
    .join("");
  return `<div class="rooms-section">
    <button type="button" class="rooms-title-btn" data-saved-rooms-toggle="${escapeHtml(
      itinId
    )}" aria-expanded="true">
      <span class="rooms-title-chevron" aria-hidden="true">▾</span>
      <span class="rooms-title-label">${escapeHtml(title)}</span>
    </button>
    <div class="rooms-body">
      <table class="rooms-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Price</th>
            <th>Avail</th>
            <th>Rate</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

function hotelResultsHtml(itinId, hotel) {
  if (!hotel) {
    return `<section class="hotel-results-heading">
      <div class="flight-results-title">Hotel stays</div>
    </section>
    <section class="results-wrap">
      <div class="table-scroll">
        <table class="results">
          <tbody><tr class="empty"><td>Not saved</td></tr></tbody>
        </table>
      </div>
    </section>`;
  }
  const open = hotelDetailOpen.has(itinId);
  const nights = hotelNights(hotel);
  const compare = hotel.compareRate || null;
  const badge =
    hotel.inventoryOnly && !hotel.stayPriced
      ? `<span class="badge">lead</span>`
      : hotel.isGoRate || hotel.specialRateType
        ? `<span class="badge go">${escapeHtml(hotel.specialRateType || "go")}</span>`
        : `<span class="badge">rate</span>`;
  const bookUrl = hotelBookUrl(hotel);
  const rateHtml =
    hotel.inventoryOnly && !hotel.stayPriced
      ? rateDisplayHtml(hotel.amount, hotel.currency, hotel.amountFmt, null, null)
      : rateDisplayHtml(hotel.amount, hotel.currency, hotel.amountFmt, nights, compare);
  const details = hotelDetailItems(hotel)
    .map(
      ([label, value]) =>
        `<div class="detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join("");
  return `<section class="hotel-results-heading">
      <div class="flight-results-title">Hotel stays</div>
    </section>
    <section class="results-wrap">
      <div class="results-meta">
        <div>1 stay · ${escapeHtml(hotel.hotelName || hotel.ctyhocn || "hotel")}</div>
      </div>
      <div class="table-scroll">
        <table class="results">
          <thead>
            <tr>
              <th>Check-in</th>
              <th>Hotel</th>
              <th>Brand</th>
              <th>City</th>
              <th>Price</th>
              <th>Rooms</th>
              <th>Rate</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr class="result-row${open ? " open" : ""}" data-saved-hotel-expand="${escapeHtml(
              itinId
            )}" tabindex="0" aria-expanded="${open ? "true" : "false"}">
              <td class="date-cell">${hotelCacheIconHtml(itinId, hotel)}${escapeHtml(
                hotel.arrivalDate || "—"
              )}</td>
              <td>
                <div class="hotel-name">${escapeHtml(hotel.hotelName || "Hotel")}</div>
                <div class="hotel-code">${escapeHtml(hotel.ctyhocn || "")}</div>
              </td>
              <td>${escapeHtml(hotel.brandCode || "—")}</td>
              <td>${escapeHtml(hotel.city || "—")}</td>
              <td class="rate">${rateHtml}</td>
              <td>${escapeHtml(hotel.roomsAvail ?? "—")}</td>
              <td><div class="rate-plan-cell">${badge}<div class="hotel-code">${escapeHtml(
                hotel.ratePlanName || ""
              )}</div></div></td>
              <td>${
                bookUrl
                  ? `<a class="book-link" href="${escapeHtml(bookUrl)}" target="_blank" rel="noopener">Book</a>`
                  : "—"
              }</td>
            </tr>
            <tr class="detail-row${open ? " open" : ""}"${open ? "" : " hidden"}>
              <td colspan="8">
                <div class="detail-panel">
                  <dl class="detail-grid">${details}</dl>
                  ${open ? hotelRoomsSectionHtml(itinId, hotel) : ""}
                  <div class="detail-actions">
                    ${
                      bookUrl
                        ? `<a class="book-link" href="${escapeHtml(
                            bookUrl
                          )}" target="_blank" rel="noopener">Open booking</a>`
                        : ""
                    }
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>`;
}

function summaryLinesHtml(entry) {
  const hotel = entry.hotel;
  const nights = Math.max(1, Number(hotel?.nights) || 1);
  const outboundLine = entry.outbound
    ? `<div class="trip-summary-line"><span>Outbound</span><span><strong>${escapeHtml(
        formatProgramName(entry.outbound?.source || entry.outbound?.program) || "—"
      )}</strong> · ${escapeHtml(
        `${entry.outbound?.origin || "?"} → ${entry.outbound?.destination || "?"}`
      )}</span><span class="trip-summary-price">${escapeHtml(
        formatPointsWithTaxes(entry.outbound)
      )}</span></div>`
    : "";
  const returnLine = entry.return
    ? `<div class="trip-summary-line"><span>Return</span><span><strong>${escapeHtml(
        formatProgramName(entry.return?.source || entry.return?.program) || "—"
      )}</strong> · ${escapeHtml(
        `${entry.return?.origin || "?"} → ${entry.return?.destination || "?"}`
      )}</span><span class="trip-summary-price">${escapeHtml(
        formatPointsWithTaxes(entry.return)
      )}</span></div>`
    : "";
  return `<div class="trip-summary-lines">
    ${outboundLine}
    ${returnLine}
    <div class="trip-summary-line"><span>Hotel</span><span><strong>${escapeHtml(
      hotel?.hotelName || hotel?.ctyhocn || "—"
    )}</strong> · ${escapeHtml(String(nights))} night${
      nights === 1 ? "" : "s"
    }</span><span class="trip-summary-price">${escapeHtml(
      hotel?.amount != null && Number.isFinite(Number(hotel.amount))
        ? `est. ${formatMoney(Number(hotel.amount) * nights, hotel.currency)}`
        : "—"
    )}</span></div>
  </div>`;
}

function itineraryHtml(entry) {
  const when = formatSavedAt(entry.savedAt);
  const open = expandedId === entry.id;
  return `<article class="saved-itinerary${open ? " is-expanded" : ""}" data-saved-id="${escapeHtml(
    entry.id
  )}">
    <div
      class="trip-summary-inner saved-trip-banner"
      role="button"
      tabindex="0"
      data-expand-saved="${escapeHtml(entry.id)}"
      aria-expanded="${open ? "true" : "false"}"
    >
      <div class="trip-summary-main">
        <div class="trip-summary-heading">
          ${escapeHtml(itineraryTitle(entry))}
          <span class="saved-expand-hint">${open ? "Hide details" : "Show details"}</span>
        </div>
        <div class="trip-summary-total">${escapeHtml(totalLabel(entry))}</div>
        ${when ? `<div class="saved-card-when">Saved ${escapeHtml(when)}</div>` : ""}
      </div>
      ${summaryLinesHtml(entry)}
      <div class="trip-summary-actions">
        <span class="saved-expand-caret" aria-hidden="true">${open ? "▴" : "▾"}</span>
        <button
          type="button"
          class="trip-save-btn is-saved"
          data-remove-saved="${escapeHtml(entry.id)}"
          aria-label="Remove saved itinerary"
          title="Remove saved itinerary"
        >
          <svg class="trip-save-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M12 21s-6.7-4.35-9.33-7.6C.8 11.2 1.1 7.6 3.6 5.7c2-1.5 4.7-1.2 6.3.5L12 8.4l2.1-2.2c1.6-1.7 4.3-2 6.3-.5 2.5 1.9 2.8 5.5.93 7.7C18.7 16.65 12 21 12 21z"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    ${
      open
        ? `<div class="saved-itinerary-details">
      ${
        entry.outbound || entry.return
          ? `<section class="flight-results">
        ${
          entry.outbound
            ? renderFlightLegSectionHtml("outbound", resolveFlightFromState(entry.outbound), {
                asCached: true,
                cachedAt: entry.outbound?.fetchedAt || entry.savedAt,
                hideSelect: true,
                cacheReadOnly: false,
              })
            : ""
        }
        ${
          entry.return
            ? renderFlightLegSectionHtml("return", resolveFlightFromState(entry.return), {
                asCached: true,
                cachedAt: entry.return?.fetchedAt || entry.savedAt,
                hideSelect: true,
                cacheReadOnly: false,
              })
            : ""
        }
      </section>`
          : ""
      }
      ${hotelResultsHtml(entry.id, entry.hotel)}
    </div>`
        : ""
    }
  </article>`;
}

function recomputeTotals(entry) {
  let points = 0;
  let cash = 0;
  for (const leg of [entry?.outbound, entry?.return]) {
    const m = Number(leg?.mileageCost);
    if (Number.isFinite(m)) points += m;
    const tax = taxAmountDollars(leg);
    if (tax != null) cash += tax;
  }
  const hotel = entry?.hotel;
  if (hotel?.amount != null && Number.isFinite(Number(hotel.amount))) {
    cash += Number(hotel.amount) * hotelNights(hotel);
  }
  return { points, cash };
}

function asAirportList(value, fallback) {
  const list = [];
  const push = (v) => {
    const code = String(v || "")
      .trim()
      .toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && !list.includes(code)) list.push(code);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (typeof value === "string") {
    value.split(/[\s,]+/).forEach(push);
  }
  if (!list.length && fallback) push(fallback);
  return list;
}

function flightMatchScore(saved, candidate) {
  if (!saved || !candidate) return -1;
  let score = 0;
  if (saved.availabilityId && candidate.availabilityId === saved.availabilityId) score += 100;
  const savedNums = (saved.flightNumbers || []).join(",");
  const candNums = (candidate.flightNumbers || []).join(",");
  if (savedNums && savedNums === candNums) score += 50;
  const savedProg = String(saved.source || saved.program || "").toLowerCase();
  const candProg = String(candidate.source || candidate.program || "").toLowerCase();
  if (savedProg && savedProg === candProg) score += 20;
  if (saved.date && saved.date === candidate.date) score += 10;
  if (
    String(saved.origin || "").toUpperCase() === String(candidate.origin || "").toUpperCase() &&
    String(saved.destination || "").toUpperCase() === String(candidate.destination || "").toUpperCase()
  ) {
    score += 10;
  }
  if (
    saved.mileageCost != null &&
    Number(saved.mileageCost) === Number(candidate.mileageCost)
  ) {
    score += 5;
  }
  return score;
}

function pickMatchingFlight(saved, flights) {
  let best = null;
  let bestScore = 0;
  for (const candidate of flights || []) {
    const score = flightMatchScore(saved, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 20 ? best : null;
}

function pickHotelRateFromRooms(hotel, rooms) {
  if (!rooms?.length) return null;
  const wantPlan = String(hotel?.ratePlanCode || "").toUpperCase();
  const wantRoom = String(hotel?.roomTypeCode || "").toUpperCase();
  if (wantPlan || wantRoom) {
    const exact = rooms.find(
      (r) =>
        (!wantPlan || String(r.ratePlanCode || "").toUpperCase() === wantPlan) &&
        (!wantRoom || String(r.roomTypeCode || "").toUpperCase() === wantRoom)
    );
    if (exact) return exact;
  }
  const fnf = rooms
    .filter((r) => isFamilyAndFriendsRate(r) && r.amount != null)
    .sort((a, b) => Number(a.amount) - Number(b.amount));
  if (fnf.length) return fnf[0];
  return rooms
    .filter((r) => r.amount != null)
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0] || null;
}

function hotelCompareFromRooms(hotel, rooms) {
  if (!hotel || !isFamilyAndFriendsRate(hotel) || !rooms?.length) return null;
  const sameType = hotel.roomTypeCode
    ? rooms.filter(
        (r) =>
          String(r.roomTypeCode || "").toUpperCase() ===
          String(hotel.roomTypeCode || "").toUpperCase()
      )
    : [];
  const compare = findNextHigherDifferentPlan(
    hotel,
    sameType.length ? sameType : rooms
  );
  if (!compare) return null;
  return {
    amount: compare.amount ?? null,
    amountFmt: compare.amountFmt || null,
    currency: compare.currency || hotel.currency || null,
    ratePlanName: compare.ratePlanName || null,
    ratePlanCode: compare.ratePlanCode || null,
  };
}

async function persistEntryUpdate(entry) {
  const next = {
    ...entry,
    name: entry.name || itineraryTitle(entry),
    totals: recomputeTotals(entry),
    fingerprint: itineraryFingerprint(entry),
  };
  const idx = savedList.findIndex((e) => e.id === entry.id);
  if (idx >= 0) savedList[idx] = next;
  await upsertSavedItinerary(next);
  return next;
}

function setSavedStatus(message, kind = "") {
  const status = $("savedStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind || "";
}

async function refreshSavedFlight(itinId, leg) {
  const key = `${itinId}:${leg}`;
  if (refreshingFlightKeys.has(key)) return;
  const entry = savedList.find((e) => e.id === itinId);
  const savedFlight = leg === "return" ? entry?.return : entry?.outbound;
  if (!entry || !savedFlight) return;

  const search = entry.search || {};
  const isReturn = leg === "return";
  const origins = asAirportList(
    isReturn ? search.destinations || search.origins : search.origins,
    savedFlight.origin
  );
  const destinations = asAirportList(
    isReturn ? search.origins || search.destinations : search.destinations,
    savedFlight.destination
  );
  const date = savedFlight.date;
  if (!origins.length || !destinations.length || !date) {
    setSavedStatus("Missing route/date to refresh this flight.", "warn");
    return;
  }

  refreshingFlightKeys.add(key);
  setFlightLegRefreshing(leg, true);
  renderSaved({ keepList: true });

  let statusMessage = null;
  let statusKind = "";
  try {
    const res = await sendMessage({
      type: "SEATS_CACHED_SEARCH",
      originAirports: origins,
      destinationAirports: destinations,
      startDate: date,
      endDate: date,
      transferPartners: "all",
      skipCache: true,
    });
    if (!res?.ok) {
      statusMessage = res?.error || "Flight refresh failed.";
      statusKind = "warn";
      return;
    }
    const match = pickMatchingFlight(savedFlight, res.flights || []);
    if (!match) {
      statusMessage = "Refreshed search, but the saved flight was no longer listed.";
      statusKind = "warn";
      return;
    }
    const direction = isReturn ? "return" : "outbound";
    const merged = {
      ...match,
      id: savedFlight.id,
      direction,
      fromCache: false,
      fetchedAt: Date.now(),
    };
    seedFlightsForSavedView([merged]);
    const hydrated = (await ensureTripDetails(merged)) || merged;
    const snap = snapshotFlight(prepareFlightForSave(hydrated) || hydrated);
    const nextEntry = {
      ...entry,
      outbound: direction === "outbound" ? snap : entry.outbound,
      return: direction === "return" ? snap : entry.return,
    };
    await persistEntryUpdate(nextEntry);
    statusMessage = `Refreshed ${direction} · ${snap.origin || "?"} → ${snap.destination || "?"} · ${
      snap.date || ""
    }`;
  } finally {
    refreshingFlightKeys.delete(key);
    setFlightLegRefreshing(leg, false);
    await renderSaved({ keepList: true });
    if (statusMessage) setSavedStatus(statusMessage, statusKind);
  }
}

async function refreshSavedHotel(itinId) {
  if (refreshingHotelIds.has(itinId)) return;
  const entry = savedList.find((e) => e.id === itinId);
  const hotel = entry?.hotel;
  if (!entry || !hotel?.ctyhocn || !hotel.arrivalDate) return;

  refreshingHotelIds.add(itinId);
  renderSaved({ keepList: true });

  let statusMessage = null;
  let statusKind = "";
  try {
    const nights = hotelNights(hotel);
    const res = await sendMessage({
      type: "REFRESH_RATE_ENTRY",
      ctyhocn: hotel.ctyhocn,
      arrivalDate: hotel.arrivalDate,
      departureDate: hotel.departureDate,
      nights,
      friendsAndFamily: true,
      hotelName: hotel.hotelName,
      brandCode: hotel.brandCode,
      city: hotel.city,
      country: hotel.country,
    });
    if (!res?.ok) {
      statusMessage = res?.error || "Hotel refresh failed.";
      statusKind = "warn";
      return;
    }
    const day =
      (res.days || []).find((d) => d.arrivalDate === hotel.arrivalDate) ||
      (res.days || [])[0] ||
      null;
    const rooms = res.rooms || [];
    const shopRate = pickHotelRateFromRooms(
      {
        ...hotel,
        ...(day || {}),
      },
      rooms
    );
    const merged = {
      ...hotel,
      ...(day || {}),
      hotelName: day?.hotelName || hotel.hotelName,
      brandCode: day?.brandCode || hotel.brandCode,
      city: day?.city || hotel.city,
      country: day?.country || hotel.country,
      arrivalDate: hotel.arrivalDate,
      departureDate: hotel.departureDate || day?.departureDate,
      nights,
      fromCache: false,
      fetchedAt: Date.now(),
      bookUrl: hotelBookUrl({ ...hotel, ...(day || {}) }),
    };
    if (shopRate) {
      merged.amount = shopRate.amount ?? merged.amount;
      merged.amountFmt = shopRate.amountFmt || merged.amountFmt;
      merged.currency = shopRate.currency || res.currency || merged.currency;
      merged.roomsAvail = shopRate.roomsAvail ?? merged.roomsAvail;
      merged.ratePlanCode = shopRate.ratePlanCode || merged.ratePlanCode;
      merged.ratePlanName = shopRate.ratePlanName || merged.ratePlanName;
      merged.roomTypeCode = shopRate.roomTypeCode || merged.roomTypeCode;
      merged.specialRateType = shopRate.specialRateType || merged.specialRateType;
      merged.isGoRate = Boolean(shopRate.isGoRate);
    }
    merged.compareRate = hotelCompareFromRooms(merged, rooms);
    merged.roomDetails = rooms.length
      ? {
          currency: res.currency || merged.currency || null,
          fromCache: false,
          rooms,
        }
      : hotel.roomDetails || null;

    const snap = snapshotHotel(merged, { nights });
    const nextEntry = { ...entry, hotel: snap };
    await persistEntryUpdate(nextEntry);
    statusMessage = `Refreshed ${snap.hotelName || snap.ctyhocn} · ${snap.arrivalDate || ""}`;
  } finally {
    refreshingHotelIds.delete(itinId);
    await renderSaved({ keepList: true });
    if (statusMessage) setSavedStatus(statusMessage, statusKind);
  }
}

function bindSavedEvents(body) {
  body.querySelectorAll("[data-remove-saved]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute("data-remove-saved");
      await removeSavedItinerary(id);
      if (expandedId === id) expandedId = null;
      hotelDetailOpen.delete(id);
      hotelRoomsOpen.delete(id);
      for (const key of [...hotelRoomGroupsOpen]) {
        if (key.startsWith(`${id}::`)) hotelRoomGroupsOpen.delete(key);
      }
      await renderSaved({ keepList: false });
    });
  });

  body.querySelectorAll("[data-expand-saved]").forEach((el) => {
    const toggle = () => {
      const id = el.getAttribute("data-expand-saved");
      if (expandedId === id) {
        expandedId = null;
      } else {
        expandedId = id;
        // Match Search: show hotel stay details as soon as the trip is opened.
        hotelDetailOpen.add(id);
      }
      renderSaved({ keepList: true });
    };
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove-saved]")) return;
      toggle();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("[data-remove-saved]")) return;
      e.preventDefault();
      toggle();
    });
  });

  const details = body.querySelector(".saved-itinerary-details");
  if (!details) return;

  const flights = details.querySelector(".flight-results");
  if (flights) {
    flights.addEventListener("click", (e) => {
      const cacheRefresh = e.target.closest("[data-flight-cache-refresh]");
      if (cacheRefresh?.dataset.flightCacheRefresh) {
        e.preventDefault();
        e.stopPropagation();
        const itinId =
          cacheRefresh.closest("[data-saved-id]")?.getAttribute("data-saved-id") ||
          expandedId;
        if (itinId) refreshSavedFlight(itinId, cacheRefresh.dataset.flightCacheRefresh);
        return;
      }
      if (e.target.closest("a, button, input, label")) return;
      const row = e.target.closest("tr.flight-row[data-flight-id]");
      if (row?.dataset.flightId) toggleFlightExpanded(row.dataset.flightId);
    });
    flights.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("a, button, input")) return;
      const row = e.target.closest("tr.flight-row[data-flight-id]");
      if (!row?.dataset.flightId) return;
      e.preventDefault();
      toggleFlightExpanded(row.dataset.flightId);
    });
  }

  details.addEventListener("click", (e) => {
    const hotelCache = e.target.closest("[data-saved-hotel-cache-refresh]");
    if (hotelCache?.dataset.savedHotelCacheRefresh) {
      e.preventDefault();
      e.stopPropagation();
      refreshSavedHotel(hotelCache.dataset.savedHotelCacheRefresh);
      return;
    }
    const roomsToggle = e.target.closest("[data-saved-rooms-toggle]");
    if (roomsToggle) {
      e.preventDefault();
      e.stopPropagation();
      const id = roomsToggle.getAttribute("data-saved-rooms-toggle");
      if (hotelRoomsOpen.has(id)) hotelRoomsOpen.delete(id);
      else hotelRoomsOpen.add(id);
      renderSaved({ keepList: true });
      return;
    }
    const roomGroup = e.target.closest("[data-saved-room-group]");
    if (roomGroup) {
      e.preventDefault();
      e.stopPropagation();
      const key = roomGroup.getAttribute("data-saved-room-group");
      if (hotelRoomGroupsOpen.has(key)) hotelRoomGroupsOpen.delete(key);
      else hotelRoomGroupsOpen.add(key);
      renderSaved({ keepList: true });
      return;
    }
    if (e.target.closest("a, button, input, label")) return;
    const hotelRow = e.target.closest("[data-saved-hotel-expand]");
    if (hotelRow) {
      const id = hotelRow.getAttribute("data-saved-hotel-expand");
      if (hotelDetailOpen.has(id)) hotelDetailOpen.delete(id);
      else hotelDetailOpen.add(id);
      renderSaved({ keepList: true });
    }
  });

  details.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("a, button, input")) return;
    const roomGroup = e.target.closest("[data-saved-room-group]");
    if (roomGroup) {
      e.preventDefault();
      const key = roomGroup.getAttribute("data-saved-room-group");
      if (hotelRoomGroupsOpen.has(key)) hotelRoomGroupsOpen.delete(key);
      else hotelRoomGroupsOpen.add(key);
      renderSaved({ keepList: true });
      return;
    }
    const hotelRow = e.target.closest("[data-saved-hotel-expand]");
    if (!hotelRow) return;
    e.preventDefault();
    const id = hotelRow.getAttribute("data-saved-hotel-expand");
    if (hotelDetailOpen.has(id)) hotelDetailOpen.delete(id);
    else hotelDetailOpen.add(id);
    renderSaved({ keepList: true });
  });
}

async function renderSaved({ keepList = false } = {}) {
  const body = $("savedBody");
  const status = $("savedStatus");
  if (!body || !status) return;

  if (!keepList) {
    savedList = await loadSavedItineraries();
    savedList.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
  }

  if (!savedList.length) {
    expandedId = null;
    status.textContent = "No saved itineraries yet. Heart a full trip on Search to keep it here.";
    body.innerHTML = "";
    return;
  }

  if (expandedId && !savedList.some((e) => e.id === expandedId)) {
    expandedId = null;
  }

  const openEntry = expandedId ? savedList.find((e) => e.id === expandedId) : null;
  if (openEntry) {
    seedFlightsForSavedView(
      [
        openEntry.outbound
          ? { ...openEntry.outbound, direction: openEntry.outbound.direction || "outbound" }
          : null,
        openEntry.return
          ? { ...openEntry.return, direction: openEntry.return.direction || "return" }
          : null,
      ].filter(Boolean)
    );
  }

  status.textContent = `${savedList.length} saved itinerar${savedList.length === 1 ? "y" : "ies"} · click a trip to expand`;
  body.innerHTML = savedList.map(itineraryHtml).join("");
  bindSavedEvents(body);
}

async function persistOpenEntryHydration() {
  if (!expandedId) return;
  const idx = savedList.findIndex((e) => e.id === expandedId);
  if (idx < 0) return;
  const entry = savedList[idx];
  const nextOutbound = snapshotFlight(prepareFlightForSave(entry.outbound) || entry.outbound);
  const nextReturn = snapshotFlight(prepareFlightForSave(entry.return) || entry.return);
  const richer = (next, prev) =>
    (next?.segments?.length || 0) > (prev?.segments?.length || 0) ||
    (next?.bookingLinks?.length || 0) > (prev?.bookingLinks?.length || 0) ||
    (next?.aircraft?.length || 0) > (prev?.aircraft?.length || 0);
  if (!richer(nextOutbound, entry.outbound) && !richer(nextReturn, entry.return)) return;
  const next = {
    ...entry,
    outbound: nextOutbound || entry.outbound,
    return: nextReturn || entry.return,
  };
  savedList[idx] = next;
  await upsertSavedItinerary(next);
}

setFlightTableRefreshHook(() => {
  if (!expandedId || renderQueued) return;
  renderQueued = true;
  queueMicrotask(async () => {
    renderQueued = false;
    await persistOpenEntryHydration();
    renderSaved({ keepList: true });
  });
});

renderSaved();
