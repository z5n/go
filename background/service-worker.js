import {
  searchHotelsNearDestination,
  fetchCalendar,
  fetchShopRooms,
  autocompleteDestination,
  syncGuestIdFromCookies,
  getAuthSession,
  getAccessTokenFingerprint,
  isUnauthorizedError,
} from "./hilton-api.js";
import {
  getCachedCalendar,
  setCachedCalendar,
  deleteCachedCalendar,
  getCachedShopRooms,
  setCachedShopRooms,
  deleteCachedShopRooms,
  pruneStaleCache,
} from "./rate-cache.js";
import {
  startMetricsSession,
  endMetricsSession,
  getMetricsSnapshot,
  runWithMetricsSession,
} from "./request-metrics.js";

async function clearGuestSession() {
  const fingerprint = await getAccessTokenFingerprint().catch(() => null);
  await chrome.storage.local.set({
    sessionUnauthorized: true,
    failedAccessTokenFingerprint: fingerprint || "",
  });
  await chrome.storage.local.remove(["guestId", "guestIdUpdatedAt", "guestUserName", "guestUserNameFor"]);
}

async function clearUnauthorizedFlag() {
  await chrome.storage.local.remove(["sessionUnauthorized", "failedAccessTokenFingerprint"]);
}

function extractGuestId(text) {
  if (!text) return null;
  const m = text.match(/"guestId"\s*:\s*"?(\d{5,})"?/);
  return m ? Number(m[1]) : null;
}

function bodyToText(requestBody) {
  if (!requestBody) return "";
  if (requestBody.raw?.length) {
    return requestBody.raw
      .map((part) => (part.bytes ? new TextDecoder("utf-8").decode(part.bytes) : ""))
      .join("");
  }
  return "";
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    (async () => {
      try {
        if (details.method !== "POST") return;
        const guestId = extractGuestId(bodyToText(details.requestBody));
        if (!guestId) return;
        // Always capture guestId from live Hilton traffic so re-login can recover.
        await chrome.storage.local.set({ guestId, guestIdUpdatedAt: Date.now() });
      } catch {
        /* ignore */
      }
    })();
  },
  { urls: ["https://www.hilton.com/graphql/*", "https://*.hilton.com/graphql/*"] },
  ["requestBody"]
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ maxHotels: 25, delayMs: 350 });
});

async function getGuestId() {
  const stored = await chrome.storage.local.get(["guestId", "sessionUnauthorized"]);
  if (stored.sessionUnauthorized) {
    // Still try cookie recovery; getAuthSession decides whether lockout clears.
    const fromCookies = await syncGuestIdFromCookies();
    if (fromCookies) return fromCookies;
    return null;
  }
  if (stored.guestId) return stored.guestId;
  return syncGuestIdFromCookies();
}

function monthStarts(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDate}T00:00:00`);
  const months = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= last) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}-01`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sortScanRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.error || b.error) return a.error ? 1 : -1;
    const amountDiff = (a.amount ?? Number.POSITIVE_INFINITY) - (b.amount ?? Number.POSITIVE_INFINITY);
    if (amountDiff !== 0) return amountDiff;
    if (a.arrivalDate !== b.arrivalDate) return a.arrivalDate.localeCompare(b.arrivalDate);
    return String(a.hotelName || "").localeCompare(String(b.hotelName || ""));
  });
}

function emitScanProgress({ done, total, hotel, rows, fromCache = false, cacheHits = 0 }) {
  chrome.runtime
    .sendMessage({
      type: "SCAN_PROGRESS",
      done,
      total,
      hotel,
      fromCache,
      cacheHits,
      rows: sortScanRows(rows),
      matches: rows.filter((r) => !r.error).length,
    })
    .catch(() => {});
}

async function openSearchPage(windowId = null) {
  const url = chrome.runtime.getURL("web/index.html");
  const createProps = { url };
  if (windowId != null) {
    createProps.windowId = windowId;
  } else {
    const win = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (win?.id != null) createProps.windowId = win.id;
  }
  await chrome.tabs.create(createProps);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openSearchPage(tab?.windowId ?? null);
  } catch {
    await openSearchPage();
  }
});

let scanCancelled = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await runWithMetricsSession(message?.sessionId || null, async () => {
      if (message?.type === "METRICS_SESSION_START") {
        const snap = startMetricsSession(message.sessionId);
        sendResponse({ ok: true, session: snap });
        return;
      }

      if (message?.type === "METRICS_SESSION_END") {
        const snap = endMetricsSession(message.sessionId);
        sendResponse({ ok: true, session: snap });
        return;
      }

      if (message?.type === "GET_METRICS") {
        sendResponse({ ok: true, ...getMetricsSnapshot(message.sessionId || null) });
        return;
      }

      if (message?.type === "GET_STATUS") {
        const session = await getAuthSession();
        if (!session.signedIn && (session.unauthorized || session.reason === "token_expired")) {
          await clearGuestSession();
          sendResponse({
            ok: true,
            guestId: null,
            userName: null,
            unauthorized: true,
            signedIn: false,
            reason: session.reason,
          });
          return;
        }
        sendResponse({
          ok: true,
          guestId: session.guestId || null,
          userName: session.userName || null,
          unauthorized: false,
          signedIn: Boolean(session.signedIn),
          reason: session.reason,
        });
        return;
      }

      if (message?.type === "CLEAR_SESSION") {
        await clearGuestSession();
        sendResponse({ ok: true, guestId: null, userName: null, unauthorized: true, signedIn: false });
        return;
      }

      if (message?.type === "RESTORE_SESSION") {
        await clearUnauthorizedFlag();
        const session = await getAuthSession();
        if (!session.signedIn) {
          // Only re-lock when Hilton still has no usable session.
          if (
            session.reason === "no_token" ||
            session.reason === "token_expired" ||
            session.reason === "not_logged_in" ||
            session.unauthorized
          ) {
            await clearGuestSession();
            sendResponse({
              ok: true,
              guestId: null,
              userName: null,
              unauthorized: true,
              signedIn: false,
              reason: session.reason,
            });
            return;
          }
          sendResponse({
            ok: true,
            guestId: null,
            userName: null,
            unauthorized: false,
            signedIn: false,
            reason: session.reason,
          });
          return;
        }
        sendResponse({
          ok: true,
          guestId: session.guestId || null,
          userName: session.userName || null,
          unauthorized: false,
          signedIn: true,
          reason: session.reason,
        });
        return;
      }

      if (message?.type === "STOP_SCAN") {
        scanCancelled = true;
        sendResponse({ ok: true, stopped: true });
        return;
      }

      if (message?.type === "AUTOCOMPLETE_DESTINATION") {
      const result = await autocompleteDestination(message.query || "", {
        limit: message.limit || 8,
      });
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "SEARCH_DESTINATION_HOTELS") {
      scanCancelled = false;
      const result = await searchHotelsNearDestination(message.destination, {
        limit: message.limit || 25,
      });
      if (scanCancelled) {
        sendResponse({ ok: true, ...result, cancelled: true });
        return;
      }
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "FETCH_ROOM_RATES") {
      const {
        ctyhocn,
        arrivalDate,
        departureDate,
        friendsAndFamily = true,
      } = message;
      if (!ctyhocn || !arrivalDate || !departureDate) {
        sendResponse({ ok: false, error: "Missing stay details for room shop." });
        return;
      }
      const guestId = await getGuestId();
      const cacheParams = {
        ctyhocn,
        arrivalDate,
        departureDate,
        friendsAndFamily,
        guestId,
        currency: "USD",
      };
      let payload = await getCachedShopRooms(cacheParams);
      let fromCache = Boolean(payload);
      if (!payload) {
        try {
          payload = await fetchShopRooms({
            ctyhocn,
            arrivalDate,
            departureDate,
            friendsAndFamily,
            guestId,
          });
          await setCachedShopRooms(cacheParams, payload);
        } catch (err) {
          if (isUnauthorizedError(err)) {
            await clearGuestSession();
            sendResponse({
              ok: false,
              unauthorized: true,
              error: "Hilton session expired. Sign in again to continue.",
            });
            return;
          }
          throw err;
        }
      }
      sendResponse({
        ok: true,
        rooms: payload.rooms || [],
        currency: payload.currency || null,
        fromCache,
        guestId,
      });
      await clearUnauthorizedFlag();
      return;
    }

    if (message?.type === "REFRESH_RATE_ENTRY") {
      const {
        ctyhocn,
        arrivalDate,
        departureDate,
        nights = 1,
        friendsAndFamily = true,
        hotelName = null,
        brandCode = null,
        city = null,
        country = null,
      } = message;
      if (!ctyhocn || !arrivalDate) {
        sendResponse({ ok: false, error: "Missing stay details to refresh." });
        return;
      }
      const guestId = await getGuestId();
      const lengthOfStay = Number(nights) || 1;
      const monthArrival = `${String(arrivalDate).slice(0, 7)}-01`;
      const calendarParams = {
        ctyhocn,
        arrivalDate: monthArrival,
        nights: lengthOfStay,
        friendsAndFamily,
        guestId,
        currency: "USD",
      };
      try {
        await deleteCachedCalendar(calendarParams);
        const calendar = await fetchCalendar({
          ctyhocn,
          arrivalDate: monthArrival,
          lengthOfStay,
          friendsAndFamily,
          guestId,
        });
        await setCachedCalendar(calendarParams, calendar);

        const dep =
          departureDate || addDaysISO(arrivalDate, lengthOfStay);
        const shopParams = {
          ctyhocn,
          arrivalDate,
          departureDate: dep,
          friendsAndFamily,
          guestId,
          currency: "USD",
        };
        await deleteCachedShopRooms(shopParams);
        let roomsPayload = null;
        try {
          roomsPayload = await fetchShopRooms({
            ctyhocn,
            arrivalDate,
            departureDate: dep,
            friendsAndFamily,
            guestId,
          });
          await setCachedShopRooms(shopParams, roomsPayload);
        } catch (shopErr) {
          // Calendar refresh still useful if room shop fails.
          if (isUnauthorizedError(shopErr)) throw shopErr;
          roomsPayload = { rooms: [], currency: null, error: String(shopErr.message || shopErr) };
        }

        const hotelCtyhocn = calendar.ctyhocn || ctyhocn;
        const days = (calendar.days || [])
          .filter((day) => day?.arrivalDate && day.amount != null)
          .map((day) => {
            const arrival = day.arrivalDate;
            const departure = addDaysISO(arrival, lengthOfStay);
            return {
              ...day,
              arrivalDate: arrival,
              departureDate: departure,
              hotelName,
              brandCode,
              city,
              country,
              ctyhocn: hotelCtyhocn,
              nights: lengthOfStay,
              fromCache: false,
              bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
                hotelCtyhocn
              )}&arrivalDate=${encodeURIComponent(arrival)}&departureDate=${encodeURIComponent(
                departure
              )}&room1NumAdults=1`,
            };
          });

        sendResponse({
          ok: true,
          days,
          rooms: roomsPayload?.rooms || [],
          roomsError: roomsPayload?.error || null,
          currency: roomsPayload?.currency || calendar.currency || null,
          fromCache: false,
          guestId,
          monthArrival,
        });
        await clearUnauthorizedFlag();
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await clearGuestSession();
          sendResponse({
            ok: false,
            unauthorized: true,
            error: "Hilton session expired. Sign in again to continue.",
          });
          return;
        }
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return;
    }

    if (message?.type === "SCAN_RATES") {
      scanCancelled = false;
      pruneStaleCache().catch(() => {});
      const {
        hotels,
        fromDate,
        toDate,
        nights = 1,
        friendsAndFamily = true,
        goOnly = true,
        maxRate = null,
        minRooms = 1,
        delayMs = 350,
      } = message;

      const guestId = await getGuestId();
      const months = monthStarts(fromDate, toDate);
      const from = new Date(`${fromDate}T00:00:00`);
      const to = new Date(`${toDate}T00:00:00`);
      const rows = [];
      let done = 0;
      let cacheHits = 0;
      const total = hotels.length * months.length;

      outer: for (const hotel of hotels) {
        for (const arrivalDate of months) {
          if (scanCancelled) break outer;
          const cacheParams = {
            ctyhocn: hotel.ctyhocn,
            arrivalDate,
            nights,
            friendsAndFamily,
            guestId,
            currency: "USD",
          };
          let fromCache = false;
          try {
            let calendar = await getCachedCalendar(cacheParams);
            if (calendar) {
              fromCache = true;
              cacheHits += 1;
            } else {
              calendar = await fetchCalendar({
                ctyhocn: hotel.ctyhocn,
                arrivalDate,
                lengthOfStay: nights,
                friendsAndFamily,
                guestId,
              });
              await setCachedCalendar(cacheParams, calendar);
            }

            for (const day of calendar.days || []) {
              if (day.amount == null) continue;
              const arrival = day.arrivalDate;
              const d = new Date(`${arrival}T00:00:00`);
              // From/To = allowed check-in dates (inclusive). Stay length = nights.
              if (d < from || d > to) continue;
              if (goOnly && !day.isGoRate) continue;
              if (maxRate != null && day.amount > maxRate) continue;
              if ((day.roomsAvail ?? 0) < minRooms) continue;
              const departureDate = addDaysISO(arrival, nights);
              const ctyhocn = calendar.ctyhocn || hotel.ctyhocn;
              rows.push({
                ...day,
                arrivalDate: arrival,
                departureDate,
                hotelName: hotel.name,
                brandCode: hotel.brandCode,
                city: hotel.city,
                country: hotel.country,
                ctyhocn,
                nights,
                fromCache,
                bookUrl: `https://www.hilton.com/en/book/reservation/rooms/?ctyhocn=${encodeURIComponent(
                  ctyhocn
                )}&arrivalDate=${encodeURIComponent(arrival)}&departureDate=${encodeURIComponent(
                  departureDate
                )}&room1NumAdults=1`,
              });
            }
          } catch (err) {
            if (isUnauthorizedError(err)) {
              await clearGuestSession();
              emitScanProgress({
                done,
                total,
                hotel: hotel.name,
                rows,
                fromCache,
                cacheHits,
                unauthorized: true,
              });
              scanCancelled = false;
              sendResponse({
                ok: false,
                unauthorized: true,
                error: "Hilton session expired. Sign in again to continue.",
                rows: sortScanRows(rows),
                guestId: null,
                cancelled: false,
                done,
                total,
                cacheHits,
              });
              return;
            }
            rows.push({
              error: true,
              ctyhocn: hotel.ctyhocn,
              hotelName: hotel.name,
              arrivalDate,
              message: String(err.message || err),
            });
          }
          done += 1;
          emitScanProgress({
            done,
            total,
            hotel: hotel.name,
            rows,
            fromCache,
            cacheHits,
          });
          if (scanCancelled) break outer;
          if (!fromCache) await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      const cancelled = scanCancelled;
      scanCancelled = false;

      const unauthorizedRows = rows.filter(
        (r) => r.error && /unauthorized/i.test(String(r.message || ""))
      );
      if (unauthorizedRows.length) {
        await clearGuestSession();
        sendResponse({
          ok: false,
          unauthorized: true,
          error: "Hilton session expired. Sign in again to continue.",
          rows: sortScanRows(rows),
          guestId: null,
          cancelled,
          done,
          total,
          cacheHits,
        });
        return;
      }

      await clearUnauthorizedFlag();
      sendResponse({
        ok: true,
        rows: sortScanRows(rows),
        guestId: (await getGuestId()) || guestId,
        cancelled,
        done,
        total,
        cacheHits,
      });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
    });
  })().catch(async (err) => {
    if (isUnauthorizedError(err)) {
      await clearGuestSession();
      sendResponse({
        ok: false,
        unauthorized: true,
        error: "Hilton session expired. Sign in again to continue.",
      });
      return;
    }
    sendResponse({ ok: false, error: String(err.message || err) });
  });

  return true;
});
