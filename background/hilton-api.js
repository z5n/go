/**
 * Hilton GraphQL client for the extension service worker.
 * Uses the user's Chrome Hilton cookies (host_permissions).
 */

import { recordOutbound } from "./request-metrics.js";
import { convertToUsd } from "./exchange-rates.js";

const CALENDAR_QUERY = `query hotel_shopAvailOptions_shopCalendarPropAvail($arrivalDate: String!, $ctyhocn: String!, $language: String!, $guestLocationCountry: String, $numAdults: Int!, $numChildren: Int!, $numRooms: Int!, $displayCurrency: String, $lengthOfStay: Int!, $guestId: BigInt, $specialRates: ShopSpecialRateInput, $rateCategoryTokens: [String], $ratePlanCodes: [String], $childAges: [Int], $modifyingReservation: Boolean, $programAccountId: BigInt) {
  hotel(ctyhocn: $ctyhocn, language: $language) {
    ctyhocn
    shopCalendarAvail(
      input: {
        guestLocationCountry: $guestLocationCountry
        arrivalDate: $arrivalDate
        displayCurrency: $displayCurrency
        numAdults: $numAdults
        numChildren: $numChildren
        numRooms: $numRooms
        lengthOfStay: $lengthOfStay
        displayRateType: average
        guestId: $guestId
        specialRates: $specialRates
        rateCategoryTokens: $rateCategoryTokens
        ratePlanCodes: $ratePlanCodes
        childAges: $childAges
        modifyingReservation: $modifyingReservation
        programAccountId: $programAccountId
      }
    ) {
      statusCode
      currencyCode
      calendars {
        arrivalDate
        departureDate
        roomRate {
          numRoomsAvail
          rateAmount(strategy: ceiling)
          rateAmountFmt(decimal: 0, strategy: ceiling)
          ratePlan { ratePlanName ratePlanDesc specialRateType }
          ratePlanCode
          roomTypeCode
        }
      }
    }
  }
}`;

const SHOP_AVAIL_QUERY = `query hotel_shopAvailOptions_shopAvailProp($arrivalDate: String!, $departureDate: String!, $ctyhocn: String!, $language: String!, $guestLocationCountry: String, $numAdults: Int!, $numChildren: Int!, $numRooms: Int!, $displayCurrency: String, $guestId: BigInt, $specialRates: ShopSpecialRateInput, $rateCategoryTokens: [String], $ratePlanCodes: [String], $childAges: [Int], $modifyingReservation: Boolean, $programAccountId: BigInt) {
  hotel(ctyhocn: $ctyhocn, language: $language) {
    ctyhocn
    shopAvail(
      input: {
        guestLocationCountry: $guestLocationCountry
        arrivalDate: $arrivalDate
        departureDate: $departureDate
        displayCurrency: $displayCurrency
        numAdults: $numAdults
        numChildren: $numChildren
        numRooms: $numRooms
        guestId: $guestId
        specialRates: $specialRates
        rateCategoryTokens: $rateCategoryTokens
        ratePlanCodes: $ratePlanCodes
        childAges: $childAges
        modifyingReservation: $modifyingReservation
        programAccountId: $programAccountId
      }
    ) {
      statusCode
      currencyCode
      roomTypes {
        roomTypeCode
        roomTypeName
        roomTypeDesc
        numBeds
        smokingRoom
        adaAccessibleRoom
      }
      roomRates {
        numRoomsAvail
        rateAmount(strategy: ceiling)
        rateAmountFmt(decimal: 0, strategy: ceiling)
        averageRate
        amountAfterTax
        ratePlanCode
        roomTypeCode
        ratePlan {
          ratePlanName
          ratePlanDesc
          specialRateType
        }
      }
    }
  }
}`;

const SHOP_AVAIL_QUERY_SIMPLE = `query hotel_shopAvailOptions_shopAvailProp($arrivalDate: String!, $departureDate: String!, $ctyhocn: String!, $language: String!, $guestLocationCountry: String, $numAdults: Int!, $numChildren: Int!, $numRooms: Int!, $displayCurrency: String, $guestId: BigInt, $specialRates: ShopSpecialRateInput, $childAges: [Int], $modifyingReservation: Boolean) {
  hotel(ctyhocn: $ctyhocn, language: $language) {
    ctyhocn
    shopAvail(
      input: {
        guestLocationCountry: $guestLocationCountry
        arrivalDate: $arrivalDate
        departureDate: $departureDate
        displayCurrency: $displayCurrency
        numAdults: $numAdults
        numChildren: $numChildren
        numRooms: $numRooms
        guestId: $guestId
        specialRates: $specialRates
        childAges: $childAges
        modifyingReservation: $modifyingReservation
      }
    ) {
      statusCode
      currencyCode
      roomTypes {
        roomTypeCode
        roomTypeName
        roomTypeDesc
        numBeds
        smokingRoom
        adaAccessibleRoom
      }
      roomRates {
        numRoomsAvail
        rateAmount(strategy: ceiling)
        rateAmountFmt(decimal: 0, strategy: ceiling)
        ratePlanCode
        roomTypeCode
        ratePlan {
          ratePlanName
          ratePlanDesc
          specialRateType
        }
      }
    }
  }
}`;

const GUEST_USERNAME_QUERY = `query guest($guestId: BigInt!, $language: String!) {
  guest(guestId: $guestId, language: $language) {
    guestId
    userName
    personalinfo {
      name {
        firstName
        nameFmt
      }
    }
  }
}`;

const GEOCODE_QUERY = `query hotelSummaryOptions_geocodePage(
  $language: String!,
  $path: String!,
  $distanceUnit: HotelDistanceUnit,
  $input: HotelSummaryOptionsInput
) {
  geocodePage(language: $language, path: $path) {
    match { name type }
    hotelSummaryOptions(distanceUnit: $distanceUnit, sortBy: distance, input: $input) {
      hotels {
        ctyhocn
        name
        brandCode
        distance
        distanceFmt
        address { city country countryName state stateName }
        localization {
          currencyCode
          coordinate { latitude longitude }
        }
        facilityOverview { homeUrlTemplate }
      }
    }
  }
}`;

const HOTEL_SUMMARY_QUERY = `query hotelSummaryOptions($language: String!, $input: HotelSummaryOptionsInput) {
  hotelSummaryOptions(language: $language, input: $input) {
    hotels {
      ctyhocn
      name
      brandCode
      distance
      distanceFmt
      address { city country countryName state stateName }
      localization {
        currencyCode
        coordinate { latitude longitude }
      }
      facilityOverview { homeUrlTemplate }
    }
  }
}`;

const HOTEL_QUADRANTS_QUERY = `query hotelQuadrants {
  hotelQuadrants {
    id
    bounds {
      northeast { latitude longitude }
      southwest { latitude longitude }
    }
    countries { code }
  }
}`;

function inferCurrencyCode(currencyCode, amountFmt) {
  const direct = String(currencyCode || "").trim().toUpperCase();
  if (direct && direct !== "UNKNOWN") return direct;
  const fmt = String(amountFmt || "");
  if (/€|\bEUR\b/i.test(fmt)) return "EUR";
  if (/£|\bGBP\b/i.test(fmt)) return "GBP";
  if (/\bJPY\b|¥/i.test(fmt)) return "JPY";
  if (/\bCHF\b/i.test(fmt)) return "CHF";
  if (/\bCAD\b/i.test(fmt)) return "CAD";
  if (/\bAUD\b/i.test(fmt)) return "AUD";
  if (/\$|\bUSD\b/i.test(fmt)) return "USD";
  return null;
}

async function applyUsdConversion(entry, sourceCurrency) {
  const currency = inferCurrencyCode(sourceCurrency || entry.currency, entry.amountFmt);
  if (entry.amount == null) {
    return {
      ...entry,
      currency: "USD",
      amountOriginal: null,
      currencyOriginal: currency,
      fxRateToUsd: null,
    };
  }
  if (!currency || currency === "USD") {
    const n = Number(entry.amount);
    return {
      ...entry,
      amount: Number.isFinite(n) ? Math.round(n) : entry.amount,
      amountFmt: Number.isFinite(n) ? `$${Math.round(n)}` : entry.amountFmt,
      currency: "USD",
      amountOriginal: entry.amount,
      currencyOriginal: currency || "USD",
      fxRateToUsd: 1,
    };
  }
  const conv = await convertToUsd(entry.amount, currency);
  const usd = Math.round(conv.amount);
  let amountAfterTax = entry.amountAfterTax;
  if (amountAfterTax != null) {
    const taxConv = await convertToUsd(amountAfterTax, currency);
    amountAfterTax = taxConv.amount == null ? amountAfterTax : Math.round(taxConv.amount);
  }
  return {
    ...entry,
    amount: usd,
    amountFmt: `$${usd}`,
    currency: "USD",
    amountAfterTax,
    amountOriginal: entry.amount,
    currencyOriginal: currency,
    fxRateToUsd: conv.rate,
  };
}

function specialRates(friendsAndFamily) {
  return {
    hhonors: false,
    aaa: false,
    corporateId: null,
    familyAndFriends: Boolean(friendsAndFamily),
    senior: false,
    governmentMilitary: false,
    groupCode: null,
    lta: false,
    offerId: null,
    owner: false,
    ownerHGV: false,
    pnd: null,
    promoCode: null,
    teamMember: !friendsAndFamily,
    travelAgent: false,
    specialOffer: false,
    smb: false,
    specialOfferName: null,
  };
}

/**
 * Extension SW fetches send Origin: chrome-extension://… which Akamai forbids.
 * Prefer a MAIN-world fetch inside a Hilton tab (true page Origin).
 * DNR also rewrites Origin/Referer for any extension-initiated Hilton calls.
 */
function safeJsonParse(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  const raw = String(value);
  try {
    return JSON.parse(raw);
  } catch {
    /* try decode */
  }
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function decodeJwtPayload(accessToken) {
  try {
    const part = String(accessToken || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64 + pad));
  } catch {
    return null;
  }
}

function coerceGuestId(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  const text = String(value);
  if (/^\d{5,}$/.test(text)) return Number(text);
  const nested = text.match(/(?:guestId|guest_id)[\"']?\s*[:=]\s*[\"']?(\d{5,})/i);
  if (nested) return Number(nested[1]);
  const any = text.match(/(\d{5,})/);
  return any ? Number(any[1]) : null;
}

function guestIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const direct =
    coerceGuestId(obj.guestId) ||
    coerceGuestId(obj.guest_id) ||
    coerceGuestId(obj.gid) ||
    coerceGuestId(obj.honorsId) ||
    coerceGuestId(obj.hhonorsNumber);
  if (direct) return direct;
  // Only accept unambiguous subject forms — never scrape arbitrary digit runs.
  if (typeof obj.sub === "string") {
    if (/^\d{5,}$/.test(obj.sub)) return Number(obj.sub);
    const m = obj.sub.match(/^guest[:_-]?(\d{5,})$/i);
    if (m) return Number(m[1]);
  } else if (typeof obj.sub === "number") {
    return coerceGuestId(obj.sub);
  }
  return null;
}

function tokenInfoFromParsed(parsed, cookieExpirationDate = null) {
  if (!parsed || typeof parsed !== "object") return null;
  const accessToken =
    parsed.accessToken ||
    parsed.access_token ||
    parsed.token?.accessToken ||
    parsed.token?.access_token ||
    null;
  if (!accessToken) return null;
  const tokenType = parsed.tokenType || parsed.token_type || parsed.token?.tokenType || "Bearer";
  return {
    authorization: `${tokenType} ${accessToken}`,
    accessToken,
    tokenType,
    raw: parsed,
    cookieExpirationDate,
    fingerprint: String(accessToken).slice(-24),
    guestId: guestIdFromObject(parsed) || guestIdFromObject(decodeJwtPayload(accessToken)),
  };
}

async function listHiltonCookies(name) {
  const byName = await chrome.cookies.getAll({ name });
  const hilton = byName.filter((c) => /hilton\.com$/i.test(String(c.domain || "")));
  // Prefer www host cookies, then longest-lived.
  return hilton.sort((a, b) => {
    const aWww = /www\.hilton\.com/i.test(a.domain) ? 1 : 0;
    const bWww = /www\.hilton\.com/i.test(b.domain) ? 1 : 0;
    if (aWww !== bWww) return bWww - aWww;
    return (b.expirationDate || 0) - (a.expirationDate || 0);
  });
}

async function getGuestAccessToken() {
  try {
    for (const name of ["webGuestToken", "guestToken"]) {
      const cookies = await listHiltonCookies(name);
      for (const cookie of cookies) {
        const info = tokenInfoFromParsed(safeJsonParse(cookie.value), cookie.expirationDate || null);
        if (info) return info;
      }
    }
    // Fallback: direct get (some Chrome builds behave better with url).
    const cookie = await chrome.cookies.get({
      url: "https://www.hilton.com/",
      name: "webGuestToken",
    });
    if (!cookie?.value) return null;
    return tokenInfoFromParsed(safeJsonParse(cookie.value), cookie.expirationDate || null);
  } catch {
    return null;
  }
}

function jwtExpirySeconds(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) ? exp : null;
}

function tokenExpiryMs(tokenInfo) {
  if (!tokenInfo) return null;
  const raw = tokenInfo.raw || {};
  const candidates = [
    raw.expiresAt,
    raw.expires_at,
    raw.accessTokenExpiresAt,
    raw.access_token_expires_at,
    raw.expiration,
    raw.expiry,
    raw.exp,
  ];
  for (const value of candidates) {
    if (value == null || value === "") continue;
    if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    // Heuristic: seconds vs milliseconds.
    return n < 1e12 ? n * 1000 : n;
  }
  if (raw.expires_in != null || raw.expiresIn != null) {
    const seconds = Number(raw.expires_in ?? raw.expiresIn);
    const issuedRaw = raw.issuedAt ?? raw.issued_at ?? raw.iat;
    if (Number.isFinite(seconds) && seconds > 0 && issuedRaw != null) {
      const issuedNum = Number(issuedRaw);
      const issuedMs = Number.isFinite(issuedNum)
        ? issuedNum < 1e12
          ? issuedNum * 1000
          : issuedNum
        : Date.parse(String(issuedRaw));
      if (Number.isFinite(issuedMs)) return issuedMs + seconds * 1000;
    }
  }
  const jwtExp = jwtExpirySeconds(tokenInfo.accessToken);
  if (jwtExp != null) return jwtExp * 1000;
  if (tokenInfo.cookieExpirationDate) return tokenInfo.cookieExpirationDate * 1000;
  return null;
}

function isAccessTokenExpired(tokenInfo) {
  if (!tokenInfo?.accessToken) return true;
  const ms = tokenExpiryMs(tokenInfo);
  if (ms != null) return ms <= Date.now() + 15_000;
  // Hilton DX tokens are encrypted JWEs with no readable exp. Unknown expiry ≠ valid forever.
  return false;
}

async function readLoggedInCookie() {
  try {
    const cookies = await listHiltonCookies("loggedIn");
    if (cookies.some((c) => String(c.value).toLowerCase() === "true")) return true;
    const direct = await chrome.cookies.get({
      url: "https://www.hilton.com/",
      name: "loggedIn",
    });
    return String(direct?.value || "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function readGuestIdFromCookies() {
  try {
    for (const name of ["webGuestMetadata", "guestMetadata"]) {
      const cookies = await listHiltonCookies(name);
      for (const cookie of cookies) {
        const parsed = safeJsonParse(cookie.value);
        const fromObj = guestIdFromObject(parsed);
        if (fromObj) return fromObj;
      }
    }
    // Token cookie may embed guestId, but do not invent one from JWT digit noise.
    for (const name of ["webGuestToken", "guestToken"]) {
      const cookies = await listHiltonCookies(name);
      for (const cookie of cookies) {
        const parsed = safeJsonParse(cookie.value);
        const fromObj = guestIdFromObject(parsed);
        if (fromObj) return fromObj;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort read of Hilton auth from an open www.hilton.com tab (page JS storage). */
async function readAuthFromHiltonTab() {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.hilton.com/*"] });
    const tab =
      tabs.find((t) => /go-hilton|search|locations/i.test(t.url || "")) ||
      tabs.find((t) => t.id != null);
    if (!tab?.id) return null;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const out = { tokenRaw: null, metaRaw: null, guestId: null, loggedIn: false };
        try {
          const cookieMap = Object.fromEntries(
            document.cookie
              .split(";")
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p) => {
                const i = p.indexOf("=");
                return i === -1 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
              })
          );
          out.tokenRaw = cookieMap.webGuestToken || cookieMap.guestToken || null;
          out.metaRaw = cookieMap.webGuestMetadata || cookieMap.guestMetadata || null;
          out.loggedIn = String(cookieMap.loggedIn || "").toLowerCase() === "true";
        } catch {
          /* ignore */
        }
        try {
          for (const key of ["webGuestToken", "guestToken"]) {
            const v = window.localStorage?.getItem(key);
            if (v && !out.tokenRaw) out.tokenRaw = v;
          }
        } catch {
          /* ignore */
        }
        return out;
      },
    });
    if (!result) return null;
    const tokenInfo = tokenInfoFromParsed(safeJsonParse(result.tokenRaw));
    const guestId =
      coerceGuestId(result.guestId) ||
      guestIdFromObject(safeJsonParse(result.metaRaw)) ||
      guestIdFromObject(safeJsonParse(result.tokenRaw)) ||
      null;
    return { tokenInfo, guestId, loggedIn: Boolean(result.loggedIn) };
  } catch {
    return null;
  }
}

async function syncGuestIdFromCookies() {
  try {
    const guestId = await readGuestIdFromCookies();
    if (!guestId) return null;
    await chrome.storage.local.set({ guestId, guestIdUpdatedAt: Date.now() });
    return guestId;
  } catch {
    return null;
  }
}

async function getAccessTokenFingerprint() {
  const tokenInfo = await getGuestAccessToken();
  return tokenInfo?.fingerprint || null;
}

async function fetchGuestUserName(guestId) {
  if (!guestId) return null;
  const json = await hiltonGraphql("guest", GUEST_USERNAME_QUERY, {
    guestId,
    language: "en",
  });
  const guest = json?.data?.guest;
  const userName = String(guest?.userName || "").trim();
  if (userName) return userName;
  const nameFmt = String(guest?.personalinfo?.name?.nameFmt || "").trim();
  if (nameFmt) return nameFmt;
  const firstName = String(guest?.personalinfo?.name?.firstName || "").trim();
  return firstName || null;
}

async function resolveGuestUserName(guestId) {
  const stored = await chrome.storage.local.get(["guestUserName", "guestUserNameFor"]);
  if (stored.guestUserName && Number(stored.guestUserNameFor) === Number(guestId)) {
    return stored.guestUserName;
  }
  try {
    const userName = await fetchGuestUserName(guestId);
    if (userName) {
      await chrome.storage.local.set({
        guestUserName: userName,
        guestUserNameFor: guestId,
      });
      return userName;
    }
  } catch {
    /* profile fetch is best-effort for display only */
  }
  return stored.guestUserName && Number(stored.guestUserNameFor) === Number(guestId)
    ? stored.guestUserName
    : null;
}

/**
 * Signed-in only with a usable Hilton browser session: token + loggedIn + guestId.
 * Sticky unauthorized lockout clears only after a *new* token fingerprint appears.
 */
async function getAuthSession() {
  const locked = await chrome.storage.local.get([
    "sessionUnauthorized",
    "guestId",
    "failedAccessTokenFingerprint",
  ]);
  let tokenInfo = await getGuestAccessToken();
  let loggedIn = await readLoggedInCookie();
  let pageAuth = null;

  if (!tokenInfo?.accessToken || !loggedIn) {
    pageAuth = await readAuthFromHiltonTab();
    if (pageAuth?.tokenInfo?.accessToken) tokenInfo = pageAuth.tokenInfo;
    if (pageAuth?.loggedIn) loggedIn = true;
  }

  const hasToken = Boolean(tokenInfo?.accessToken);
  const expired = hasToken && isAccessTokenExpired(tokenInfo);
  const fingerprint = tokenInfo?.fingerprint || null;
  const tokenChangedSinceFailure =
    Boolean(fingerprint) &&
    Boolean(locked.failedAccessTokenFingerprint) &&
    fingerprint !== locked.failedAccessTokenFingerprint;

  let guestId = await readGuestIdFromCookies();
  if (!guestId) guestId = pageAuth?.guestId || null;
  if (!guestId && !pageAuth) {
    pageAuth = await readAuthFromHiltonTab();
    if (pageAuth?.loggedIn) loggedIn = true;
    guestId = pageAuth?.guestId || null;
  }
  // Stale stored guestId is only trusted when Hilton still looks logged in.
  if (!guestId && loggedIn && hasToken && !expired && !locked.sessionUnauthorized) {
    guestId = locked.guestId || null;
  }

  const looksSignedIn = hasToken && !expired && loggedIn && Boolean(guestId);

  if (locked.sessionUnauthorized) {
    if (looksSignedIn && (tokenChangedSinceFailure || !locked.failedAccessTokenFingerprint)) {
      await chrome.storage.local.remove(["sessionUnauthorized", "failedAccessTokenFingerprint"]);
    } else {
      return {
        signedIn: false,
        unauthorized: true,
        guestId: null,
        reason: expired ? "token_expired" : hasToken && !loggedIn ? "not_logged_in" : "unauthorized",
      };
    }
  }

  if (!hasToken) {
    return { signedIn: false, unauthorized: false, guestId: null, reason: "no_token" };
  }
  if (expired) {
    return { signedIn: false, unauthorized: true, guestId: null, reason: "token_expired" };
  }
  if (!loggedIn) {
    return { signedIn: false, unauthorized: true, guestId: null, reason: "not_logged_in" };
  }
  if (!guestId) {
    return { signedIn: false, unauthorized: false, guestId: null, userName: null, reason: "no_guest" };
  }

  await chrome.storage.local.set({ guestId, guestIdUpdatedAt: Date.now() });
  const userName = await resolveGuestUserName(guestId);
  return { signedIn: true, unauthorized: false, guestId, userName, reason: "ok" };
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          clearInterval(timer);
          resolve(tab);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for Hilton tab to load."));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 250);
  });
}

async function ensureHiltonTab() {
  const existing = await chrome.tabs.query({ url: ["https://www.hilton.com/*"] });
  // Prefer an already signed-in Go Hilton / shop tab over a blank homepage.
  const preferred =
    existing.find((t) => /go-hilton|search|locations/i.test(t.url || "")) ||
    existing.find((t) => t.id != null);
  if (preferred?.id) {
    if (preferred.status !== "complete") await waitForTabComplete(preferred.id);
    return preferred.id;
  }
  const created = await chrome.tabs.create({
    url: "https://www.hilton.com/en/go-hilton/",
    active: false,
  });
  await waitForTabComplete(created.id);
  await new Promise((r) => setTimeout(r, 1500));
  return created.id;
}

async function buildAuthHeaders(extra = {}) {
  const auth = await getGuestAccessToken();
  const headers = {
    accept: "application/json",
    ...extra,
  };
  if (auth?.authorization) headers.Authorization = auth.authorization;
  return headers;
}

async function hiltonSwFetch(url, { method = "GET", headers = {}, body = null } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: await buildAuthHeaders(headers),
      credentials: "include",
      body: body || undefined,
    });
    const text = await response.text();
    const result = { ok: response.ok, status: response.status, text };
    recordOutbound({
      url,
      method,
      kind: "hilton",
      via: "service_worker",
      status: result.status,
      ok: result.ok,
    });
    return result;
  } catch (err) {
    recordOutbound({
      url,
      method,
      kind: "hilton",
      via: "service_worker",
      ok: false,
      error: err?.message || err,
    });
    throw err;
  }
}

async function hiltonMainWorldFetch(url, { method = "GET", headers = {}, body = null } = {}) {
  const tabId = await ensureHiltonTab();
  const finalHeaders = await buildAuthHeaders(headers);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (fetchUrl, fetchMethod, fetchHeaders, fetchBody) => {
      try {
        const response = await fetch(fetchUrl, {
          method: fetchMethod,
          headers: fetchHeaders,
          credentials: "include",
          body: fetchBody || undefined,
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
      } catch (err) {
        return { ok: false, status: 0, text: "", error: String(err?.message || err) };
      }
    },
    args: [url, method, finalHeaders, body],
  });
  if (!result) {
    recordOutbound({
      url,
      method,
      kind: "hilton",
      via: "page",
      ok: false,
      error: "Hilton page fetch returned no result.",
    });
    throw new Error("Hilton page fetch returned no result.");
  }
  recordOutbound({
    url,
    method,
    kind: "hilton",
    via: "page",
    status: result.status,
    ok: result.ok,
    error: result.error || null,
  });
  if (result.error) throw new Error(result.error);
  return result;
}

function isForbidden(result) {
  if (!result) return true;
  if (result.status === 403) return true;
  const t = result.text || "";
  return /access denied|forbidden/i.test(t) || t === "Success";
}

async function hiltonPageFetch(url, { method = "GET", headers = {}, body = null } = {}) {
  // 1) MAIN-world page fetch (correct browser Origin)
  let result = await hiltonMainWorldFetch(url, { method, headers, body });
  if (!isForbidden(result)) return result;

  // 2) SW fetch with DNR Origin rewrite + Bearer token
  result = await hiltonSwFetch(url, { method, headers, body });
  if (!isForbidden(result)) return result;

  return result;
}

function isUnauthorizedGraphql(json, status) {
  if (status === 401) return true;
  const rawErrors = json?.errors;
  const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  return errors.some((err) => {
    const code = err?.extensions?.code ?? err?.extensions?.errorCode ?? err?.code;
    if (code === "401" || code === 401 || String(code || "").toUpperCase() === "UNAUTHORIZED") {
      return true;
    }
    return /unauthorized/i.test(String(err?.message || ""));
  });
}

class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
    this.code = "UNAUTHORIZED";
  }
}

function isUnauthorizedError(err) {
  if (!err) return false;
  if (err instanceof UnauthorizedError) return true;
  if (err.name === "UnauthorizedError" || err.code === "UNAUTHORIZED") return true;
  const text = String(err.message || err || "");
  return /unauthorized/i.test(text);
}

function textLooksUnauthorized(text) {
  if (!text) return false;
  return (
    /"message"\s*:\s*"Unauthorized"/i.test(text) ||
    /"code"\s*:\s*"?401"?/i.test(text) ||
    /\bunauthorized\b/i.test(text)
  );
}

async function hiltonGraphql(operationName, query, variables, appName = "dx_shop_search_app") {
  const url = `https://www.hilton.com/graphql/customer?appName=${encodeURIComponent(
    appName
  )}&appVersion=${encodeURIComponent("dx-shop-search-ui:1017874")}&operationName=${encodeURIComponent(
    operationName
  )}&originalOpName=${encodeURIComponent(operationName)}&bl=en`;

  const { status, text } = await hiltonPageFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName, query, variables }),
  });

  if (!text || text === "Success") {
    throw new Error("Hilton blocked the request. Stay signed into Go Hilton in Chrome, then retry.");
  }
  if (status === 403 || /access denied|forbidden/i.test(text)) {
    throw new Error(
      "Hilton returned 403. Open https://www.hilton.com/en/go-hilton/ signed-in in this Chrome profile, reload the extension, then retry."
    );
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    if (status === 401 || textLooksUnauthorized(text)) {
      throw new UnauthorizedError("Hilton session expired. Sign in again to continue.");
    }
    throw new Error(`Hilton returned non-JSON (${status}).`);
  }

  if (status === 401 || isUnauthorizedGraphql(json, status)) {
    throw new UnauthorizedError("Hilton session expired. Sign in again to continue.");
  }

  if (json.errors?.length) {
    const message = json.errors.map((e) => e.message).filter(Boolean).join("; ") || "GraphQL error";
    if (/unauthorized/i.test(message)) {
      throw new UnauthorizedError("Hilton session expired. Sign in again to continue.");
    }
    throw new Error(message);
  }
  return json;
}

async function geocodeDestination(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "GoRatesSeatsApp/0.1" },
  });
  recordOutbound({
    url: url.toString(),
    method: "GET",
    kind: "nominatim",
    operation: "geocode",
    status: response.status,
    ok: response.ok,
  });
  if (!response.ok) throw new Error("Geocoding failed");
  const results = await response.json();
  if (!results?.length) throw new Error(`No location found for “${query}”`);
  const hit = results[0];
  const address = hit.address || {};
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    displayName: hit.display_name,
    city: address.city || address.town || address.village || address.municipality || query,
    country: address.country || "",
    countryCode: (address.country_code || "us").toUpperCase(),
    state: address.state || "",
  };
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function countryPathName(country, countryCode) {
  const map = {
    US: "united-states",
    GB: "united-kingdom",
    AE: "united-arab-emirates",
    KR: "south-korea",
  };
  if (map[countryCode]) return map[countryCode];
  return slugify(country) || "united-states";
}

function normalizeHotel(h) {
  if (!h?.ctyhocn) return null;
  return {
    ctyhocn: String(h.ctyhocn).toUpperCase(),
    name: h.name || h.ctyhocn,
    brandCode: h.brandCode || null,
    distance: h.distance ?? null,
    distanceFmt: h.distanceFmt || null,
    city: h.address?.city || null,
    country: h.address?.countryName || h.address?.country || null,
    state: h.address?.stateName || h.address?.state || null,
    lat: h.localization?.coordinate?.latitude ?? null,
    lon: h.localization?.coordinate?.longitude ?? null,
    currency: h.localization?.currencyCode || null,
    homeUrl: h.facilityOverview?.homeUrlTemplate || null,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pointInBounds(lat, lon, bounds) {
  const ne = bounds?.northeast;
  const sw = bounds?.southwest;
  if (!ne || !sw) return false;
  const minLat = Math.min(sw.latitude, ne.latitude);
  const maxLat = Math.max(sw.latitude, ne.latitude);
  const minLon = Math.min(sw.longitude, ne.longitude);
  const maxLon = Math.max(sw.longitude, ne.longitude);
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

let quadrantsCache = null;

async function loadHotelQuadrants() {
  if (quadrantsCache?.length) return quadrantsCache;
  const json = await hiltonGraphql(
    "hotelQuadrants",
    HOTEL_QUADRANTS_QUERY,
    {},
    "dx_shop_search_app"
  );
  quadrantsCache = json?.data?.hotelQuadrants || [];
  return quadrantsCache;
}

function findContainingQuadrantIds(lat, lon, quadrants) {
  const hits = [];
  for (const q of quadrants || []) {
    if (!q?.id || !pointInBounds(lat, lon, q.bounds)) continue;
    hits.push({ id: q.id, depth: String(q.id).split("::").length, countries: q.countries || [] });
  }
  hits.sort((a, b) => b.depth - a.depth);
  return hits;
}

function sortHotelsByDistance(hotels, place) {
  return hotels
    .map((h) => {
      const dist =
        h.distance ??
        (h.lat != null && h.lon != null
          ? haversineKm(place.lat, place.lon, h.lat, h.lon)
          : Number.POSITIVE_INFINITY);
      return { ...h, distance: Number.isFinite(dist) ? dist : h.distance };
    })
    .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

async function searchHotelsNearDestination(destination, { limit = 30 } = {}) {
  const place = await geocodeDestination(destination);
  const countryPath = countryPathName(place.country, place.countryCode);
  const citySlug = slugify(place.city);
  const stateSlug = slugify(place.state);
  const paths = [
    `/en/locations/${countryPath}/${citySlug}/`,
    stateSlug ? `/en/locations/${countryPath}/${stateSlug}/${citySlug}/` : null,
    stateSlug ? `/en/locations/${countryPath}/${stateSlug}/` : null,
  ].filter(Boolean);

  let hotels = [];
  let lastError = null;

  for (const path of paths) {
    try {
      const json = await hiltonGraphql(
        "hotelSummaryOptions_geocodePage",
        GEOCODE_QUERY,
        {
          language: "en",
          path,
          distanceUnit: "kilometer",
          input: { guestLocationCountry: place.countryCode },
        },
        "dx_shop_search_app"
      );
      const list = json?.data?.geocodePage?.hotelSummaryOptions?.hotels || [];
      hotels = list.map(normalizeHotel).filter(Boolean);
      if (hotels.length) break;
    } catch (err) {
      lastError = err;
    }
  }

  // Hilton map search uses quadrantId (not lat/lon) on HotelSummaryOptionsInput
  if (!hotels.length) {
    try {
      const quadrants = await loadHotelQuadrants();
      const matches = findContainingQuadrantIds(place.lat, place.lon, quadrants);
      if (!matches.length) {
        throw new Error(`No Hilton map quadrant found for “${place.displayName || destination}”.`);
      }
      const seen = new Set();
      for (const match of matches.slice(0, 3)) {
        const json = await hiltonGraphql(
          "hotelSummaryOptions",
          HOTEL_SUMMARY_QUERY,
          {
            language: "en",
            input: {
              quadrantId: match.id,
              guestLocationCountry: place.countryCode,
            },
          },
          "dx_shop_search_app"
        );
        for (const h of (json?.data?.hotelSummaryOptions?.hotels || []).map(normalizeHotel).filter(Boolean)) {
          if (seen.has(h.ctyhocn)) continue;
          seen.add(h.ctyhocn);
          hotels.push(h);
        }
        if (hotels.length >= limit) break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!hotels.length) {
    throw lastError || new Error("No Hilton hotels found for that destination.");
  }

  hotels = sortHotelsByDistance(hotels, place).slice(0, limit);
  return { place, hotels };
}

async function fetchCalendar({
  ctyhocn,
  arrivalDate,
  lengthOfStay = 1,
  numAdults = 1,
  numRooms = 1,
  friendsAndFamily = true,
  guestId = null,
  guestLocationCountry = "US",
}) {
  const json = await hiltonGraphql(
    "hotel_shopAvailOptions_shopCalendarPropAvail",
    CALENDAR_QUERY,
    {
      arrivalDate,
      ctyhocn,
      guestLocationCountry,
      lengthOfStay,
      numAdults,
      numChildren: 0,
      numRooms,
      language: "en",
      specialRates: specialRates(friendsAndFamily),
      guestId: guestId || null,
      // Request native hotel currency, then convert to USD via FX.
      displayCurrency: null,
      modifyingReservation: false,
      childAges: null,
    },
    "dx-res-ui"
  );

  const avail = json?.data?.hotel?.shopCalendarAvail;
  if (!avail) throw new Error("No calendar data returned.");

  const sourceCurrency = inferCurrencyCode(avail.currencyCode, null);
  const days = [];
  for (const entry of avail.calendars || []) {
    const rate = entry?.roomRate;
    const plan = rate?.ratePlan || {};
    days.push({
      arrivalDate: entry.arrivalDate,
      departureDate: entry.departureDate,
      amount: rate?.rateAmount ?? null,
      amountFmt: rate?.rateAmountFmt ?? null,
      currency: sourceCurrency,
      roomsAvail: rate?.numRoomsAvail ?? null,
      ratePlanCode: rate?.ratePlanCode ?? null,
      roomTypeCode: rate?.roomTypeCode ?? null,
      ratePlanName: plan.ratePlanName ?? null,
      ratePlanDesc: plan.ratePlanDesc ?? null,
      specialRateType: plan.specialRateType ?? null,
      isGoRate:
        plan.specialRateType === "familyAndFriends" ||
        plan.specialRateType === "teamMember" ||
        /go hilton/i.test(plan.ratePlanName || ""),
    });
  }

  const convertedDays = [];
  for (const day of days) {
    convertedDays.push(await applyUsdConversion(day, sourceCurrency));
  }

  return {
    ctyhocn: json?.data?.hotel?.ctyhocn || ctyhocn,
    currency: "USD",
    currencyOriginal: sourceCurrency,
    statusCode: avail.statusCode,
    days: convertedDays,
  };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtmlToText(html) {
  const withBreaks = String(html || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<\/\s*li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withBreaks)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNoiseRoomParagraph(text) {
  return /corresponding photo may not reflect/i.test(text) || /^photo may not/i.test(text);
}

function formatRoomTypeDescription(rt) {
  const paragraphs = [];
  const rawParts = Array.isArray(rt.roomTypeDesc)
    ? rt.roomTypeDesc
    : String(rt.roomTypeDesc || "")
        ? [rt.roomTypeDesc]
        : [];

  for (const part of rawParts) {
    const cleaned = stripHtmlToText(part);
    if (!cleaned || isNoiseRoomParagraph(cleaned)) continue;
    // Some Hilton blobs still contain multiple sentences glued together.
    for (const chunk of cleaned.split(/\n+/)) {
      const line = chunk.trim();
      if (!line || isNoiseRoomParagraph(line)) continue;
      paragraphs.push(line);
    }
  }

  const seen = new Set();
  const uniqueParagraphs = paragraphs.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const tags = [];
  if (rt.numBeds != null && rt.numBeds !== "") {
    const n = Number(rt.numBeds);
    if (Number.isFinite(n) && n > 0) tags.push(`${n} bed${n === 1 ? "" : "s"}`);
  }
  if (rt.smokingRoom) tags.push("Smoking");
  if (rt.adaAccessibleRoom) tags.push("Accessible");

  return {
    paragraphs: uniqueParagraphs,
    tags,
    // Keep a flat string for older UI/cache consumers.
    text: [...uniqueParagraphs, ...tags].join(" · "),
  };
}

function normalizeShopRooms(json) {
  const avail = json?.data?.hotel?.shopAvail;
  if (!avail) return null;
  const sourceCurrency = inferCurrencyCode(avail.currencyCode, null);
  const typeMap = new Map();
  for (const rt of avail.roomTypes || []) {
    if (!rt?.roomTypeCode) continue;
    const code = String(rt.roomTypeCode).toUpperCase();
    const name = String(rt.roomTypeName || "").trim() || code;
    const desc = formatRoomTypeDescription(rt);
    typeMap.set(code, {
      roomTypeCode: code,
      roomTypeName: name,
      roomTypeDesc: desc.text,
      roomTypeParagraphs: desc.paragraphs,
      roomTypeTags: desc.tags,
      numBeds: rt.numBeds ?? null,
      smokingRoom: rt.smokingRoom ?? null,
      adaAccessibleRoom: rt.adaAccessibleRoom ?? null,
    });
  }

  const rooms = [];
  for (const rate of avail.roomRates || []) {
    if (rate?.rateAmount == null && rate?.amountAfterTax == null) continue;
    const code = rate.roomTypeCode ? String(rate.roomTypeCode).toUpperCase() : "";
    const meta = typeMap.get(code) || {};
    const plan = rate.ratePlan || {};
    rooms.push({
      roomTypeCode: code || null,
      roomTypeName: meta.roomTypeName || code || "Room",
      roomTypeDesc: meta.roomTypeDesc || null,
      roomTypeParagraphs: meta.roomTypeParagraphs || [],
      roomTypeTags: meta.roomTypeTags || [],
      numBeds: meta.numBeds ?? null,
      smokingRoom: meta.smokingRoom ?? null,
      adaAccessibleRoom: meta.adaAccessibleRoom ?? null,
      amount: rate.rateAmount ?? rate.averageRate ?? rate.amountAfterTax ?? null,
      amountFmt: rate.rateAmountFmt ?? null,
      amountAfterTax: rate.amountAfterTax ?? null,
      roomsAvail: rate.numRoomsAvail ?? null,
      ratePlanCode: rate.ratePlanCode || null,
      ratePlanName: plan.ratePlanName || null,
      ratePlanDesc: plan.ratePlanDesc || null,
      specialRateType: plan.specialRateType || null,
      isGoRate:
        plan.specialRateType === "familyAndFriends" ||
        plan.specialRateType === "teamMember" ||
        /go hilton/i.test(plan.ratePlanName || ""),
      currency: sourceCurrency,
    });
  }

  return {
    ctyhocn: json?.data?.hotel?.ctyhocn || null,
    currency: sourceCurrency,
    statusCode: avail.statusCode,
    rooms,
  };
}

async function localizeShopRoomsPayload(payload) {
  if (!payload) return null;
  const sourceCurrency = payload.currency;
  const rooms = [];
  for (const room of payload.rooms || []) {
    rooms.push(await applyUsdConversion(room, sourceCurrency || room.currency));
  }
  rooms.sort((a, b) => {
    if (a.isGoRate !== b.isGoRate) return a.isGoRate ? -1 : 1;
    return (a.amount ?? 1e9) - (b.amount ?? 1e9);
  });
  return {
    ...payload,
    currency: "USD",
    currencyOriginal: sourceCurrency,
    rooms,
  };
}

async function fetchShopRooms({
  ctyhocn,
  arrivalDate,
  departureDate,
  numAdults = 1,
  numRooms = 1,
  friendsAndFamily = true,
  guestId = null,
  guestLocationCountry = "US",
}) {
  const variables = {
    arrivalDate,
    departureDate,
    ctyhocn,
    guestLocationCountry,
    numAdults,
    numChildren: 0,
    numRooms,
    language: "en",
    specialRates: specialRates(friendsAndFamily),
    guestId: guestId || null,
    displayCurrency: null,
    modifyingReservation: false,
    childAges: null,
    rateCategoryTokens: null,
    ratePlanCodes: null,
    programAccountId: null,
  };

  let lastError = null;
  for (const query of [SHOP_AVAIL_QUERY, SHOP_AVAIL_QUERY_SIMPLE]) {
    try {
      const json = await hiltonGraphql(
        "hotel_shopAvailOptions_shopAvailProp",
        query,
        variables,
        "dx-res-ui"
      );
      const parsed = normalizeShopRooms(json);
      if (parsed) return localizeShopRoomsPayload(parsed);
      lastError = new Error("No room rates returned for that stay.");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Room shop failed.");
}

/**
 * Same endpoint Hilton's "Where to?" box uses:
 * GET https://www.hilton.com/dx-customer/autocomplete?input=...&language=en
 */
async function autocompleteDestination(query, { limit = 8 } = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return { suggestions: [], source: "empty" };

  const url = new URL("https://www.hilton.com/dx-customer/autocomplete");
  url.searchParams.set("input", q);
  url.searchParams.set("language", "en");

  const { ok, status, text } = await hiltonPageFetch(url.toString(), {
    method: "GET",
  });
  if (!ok) {
    throw new Error(`Autocomplete failed (${status}).`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Autocomplete returned non-JSON.");
  }
  if (data.status && data.status !== "OK") {
    return { suggestions: [], source: "hilton" };
  }

  const suggestions = [];
  for (const p of data.predictions || []) {
    const primary = p.structured_formatting?.main_text || p.description;
    const secondary = p.structured_formatting?.secondary_text || "";
    if (!primary) continue;

    const placeId = p.place_id || null;
    const hotelMatch = typeof placeId === "string" ? placeId.match(/^dx-hotel::([a-z0-9]+)$/i) : null;
    const type = hotelMatch
      ? "hotel"
      : p.type === "airport"
        ? "airport"
        : p.type === "pointOfInterest"
          ? "poi"
          : "destination";

    suggestions.push({
      id: placeId || `${type}:${p.description}`,
      type,
      label: p.description || primary,
      primary,
      secondary,
      query: p.description || primary,
      placeId,
      ctyhocn: hotelMatch ? hotelMatch[1].toUpperCase() : null,
      city: p.address?.city || null,
      state: p.address?.stateName || p.address?.state || null,
      country: p.address?.countryName || null,
      countryCode: p.address?.country || null,
    });
    if (suggestions.length >= Math.max(limit * 2, 12)) break;
  }

  return { suggestions: suggestions.slice(0, Math.max(limit * 2, 12)), source: "hilton" };
}

export {
  searchHotelsNearDestination,
  fetchCalendar,
  fetchShopRooms,
  autocompleteDestination,
  syncGuestIdFromCookies,
  getAuthSession,
  getAccessTokenFingerprint,
  isUnauthorizedError,
};
