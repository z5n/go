/**
 * Hilton GraphQL client for the extension service worker.
 * Uses the user's Chrome Hilton cookies (host_permissions).
 */

import { recordOutbound } from "./request-metrics.js";
import { convertToUsd } from "./exchange-rates.js";
import {
  SHOP_PROP_AVAIL_OPERATION,
  SHOP_PROP_AVAIL_QUERY,
} from "./shop-prop-avail-query.js";

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

/** @type {{ appName: string, appVersion: string, query: string, operationName?: string } | null} */
let shopAvailSuccessCombo = null;

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

/** Go Hilton place resolve — same op as dx-go-hilton2-ui after autocomplete select. */
const GO_HILTON_GEOCODE_QUERY = `query geocode($address: String, $language: String!, $placeId: String, $sessionToken: String) {
  geocode(
    language: $language
    address: $address
    placeId: $placeId
    sessionToken: $sessionToken
  ) {
    match {
      id
      name
      type
      placeUri
      address {
        city
        country
        countryName
        postalCode
        state
        stateName
      }
      geometry {
        location {
          latitude
          longitude
        }
        bounds {
          northeast { latitude longitude }
          southwest { latitude longitude }
        }
      }
    }
  }
}`;

const GEOCODE_QUERY = `query hotelSummaryOptions_geocodePage(
  $language: String!,
  $path: String!,
  $input: HotelSummaryOptionsInput
) {
  geocodePage(language: $language, path: $path) {
    match { name type }
    hotelSummaryOptions(sortBy: distance, input: $input) {
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

/** Hilton country / locations inventory (geocodePage) with explicit page size. */
const COUNTRY_GEOCODE_QUERY = `query hotelSummaryOptions_geocodePage(
  $language: String!,
  $path: String!,
  $queryLimit: Int!,
  $input: HotelSummaryOptionsInput
) {
  geocodePage(language: $language, path: $path) {
    match { name type }
    location {
      pageInterlinks {
        title
        links { name uri }
      }
    }
    hotelSummaryOptions(sortBy: distance, input: $input) {
      hotels(first: $queryLimit) {
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
        leadRate {
          lowest {
            rateAmount(currencyCode: "USD")
            rateAmountFmt(decimal: 0, strategy: ceiling)
            ratePlanCode
            ratePlan {
              ratePlanName
            }
          }
        }
      }
    }
  }
}`;

/** Go Hilton map search — viewport-scoped; keep for city quadrant merges. */
const COUNTRY_INVENTORY_QUERY = `query hotelSummaryOptions($language: String!, $input: HotelSummaryOptionsInput, $queryLimit: Int!) {
  hotelSummaryOptions(language: $language, input: $input) {
    hotels(first: $queryLimit) {
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
      leadRate {
        lowest {
          rateAmount(currencyCode: "USD")
          rateAmountFmt(decimal: 0, strategy: ceiling)
          ratePlanCode
          ratePlan {
            ratePlanName
          }
        }
      }
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
    countries { code states }
  }
}`;

/** One map tile of inventory — the call hilton.com repeats per quadrant on a search. */
const QUADRANT_SUMMARY_QUERY = `query hotelSummaryOptions($language: String!, $input: HotelSummaryOptionsInput) {
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
      leadRate {
        lowest {
          rateAmount(currencyCode: "USD")
          rateAmountFmt(decimal: 0, strategy: ceiling)
          ratePlanCode
          ratePlan { ratePlanName }
        }
      }
    }
  }
}`;

/** Lead rates for up to 20 hotels at a time — how the results page fills each page. */
const MULTI_PROP_AVAIL_QUERY = `query shopMultiPropAvail($ctyhocns: [String!], $language: String!, $input: ShopMultiPropAvailQueryInput!) {
  shopMultiPropAvail(input: $input, language: $language, ctyhocns: $ctyhocns) {
    ctyhocn
    currencyCode
    statusCode
    statusMessage
    lengthOfStay
    summary {
      lowest {
        rateAmount(currencyCode: "USD")
        rateAmountFmt(strategy: ceiling, decimal: 0)
        ratePlanCode
        ratePlan {
          ratePlanName
          specialRateType
          confidentialRates
        }
        amountAfterTax(currencyCode: "USD")
        amountAfterTaxFmt(decimal: 0, strategy: ceiling)
      }
      status { type }
    }
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

function isAkamaiForbidden(result) {
  if (!result) return true;
  const t = result.text || "";
  if (t === "Success") return true;
  if (/access denied/i.test(t)) return true;
  // GraphQL JSON (including HTTP 403 + "Invalid operation name") is not Akamai —
  // return it so callers can parse errors and retry with another client.
  if (result.status === 403) {
    try {
      const json = JSON.parse(t);
      if (json && (Array.isArray(json.errors) || json.data !== undefined)) return false;
    } catch {
      /* HTML / empty 403 */
    }
    return true;
  }
  return /forbidden/i.test(t) && !/"errors"\s*:/.test(t);
}

async function hiltonPageFetch(url, { method = "GET", headers = {}, body = null } = {}) {
  // 1) MAIN-world page fetch (correct browser Origin)
  let result = await hiltonMainWorldFetch(url, { method, headers, body });
  if (!isAkamaiForbidden(result)) return result;

  // 2) SW fetch with DNR Origin rewrite + Bearer token
  result = await hiltonSwFetch(url, { method, headers, body });
  if (!isAkamaiForbidden(result)) return result;

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

function hasGraphqlData(data) {
  if (!data || typeof data !== "object") return false;
  return Object.values(data).some((v) => v != null);
}

function defaultAppVersion(appName) {
  if (appName === "dx-go-hilton2-ui") return "dx-go-hilton2-ui:1013426";
  if (appName === "dx-res-ui") return "dx-res-ui:1029006";
  // Calendar + search still often use shop-search build id.
  return "dx-shop-search-ui:1030775";
}

/** Read live Hilton DX appVersion strings from an open www.hilton.com tab. */
async function discoverHiltonAppVersions() {
  try {
    const tabId = await ensureHiltonTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const found = new Set();
        const re = /(?:dx-res-ui|dx-shop-search-ui|dx-go-hilton2-ui|dx-ohw-ui)[:/][0-9][0-9A-Za-z._-]*/g;
        const bags = [];
        try {
          bags.push(...performance.getEntriesByType("resource").map((e) => e.name));
        } catch {
          /* ignore */
        }
        try {
          for (const s of document.scripts) {
            if (s.src) bags.push(s.src);
          }
        } catch {
          /* ignore */
        }
        try {
          bags.push(document.documentElement?.innerHTML?.slice(0, 400000) || "");
        } catch {
          /* ignore */
        }
        for (const bag of bags) {
          if (!bag) continue;
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(bag))) {
            found.add(String(m[0]).replace("/", ":"));
          }
        }
        return [...found];
      },
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function shopAvailClientAttempts(discovered = []) {
  const attempts = [];
  const seen = new Set();
  const push = (appName, appVersion) => {
    if (!appName || !appVersion) return;
    const key = `${appName}|${appVersion}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ appName, appVersion });
  };

  for (const ver of discovered) {
    if (ver.startsWith("dx-res-ui:")) push("dx-res-ui", ver);
    if (ver.startsWith("dx-shop-search-ui:")) {
      push("dx_shop_search_app", ver);
      push("dx-res-ui", ver);
    }
    if (ver.startsWith("dx-go-hilton2-ui:")) push("dx-go-hilton2-ui", ver);
    if (ver.startsWith("dx-ohw-ui:")) push("dx-ohw-ui", ver);
  }

  // Live rooms UI (2026) — shopPropAvail allowlist.
  push("dx-res-ui", "dx-res-ui:1029006");
  push("dx-res-ui", "dx-res-ui:1030775");
  push("dx-res-ui", "dx-shop-search-ui:1030775");
  push("dx_shop_search_app", "dx-shop-search-ui:1030775");
  return attempts;
}

function isInvalidOperationNameError(errOrMessage) {
  return /invalid operation name/i.test(String(errOrMessage?.message || errOrMessage || ""));
}

/** Keep only variables declared in the query document. */
function variablesForQuery(query, variables) {
  const declared = new Set(
    [...String(query || "").matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1])
  );
  if (!declared.size) return variables;
  const out = {};
  for (const [key, value] of Object.entries(variables || {})) {
    if (declared.has(key)) out[key] = value;
  }
  return out;
}

function newShopCacheId() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `goplus-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadShopAvailSuccessCombo() {
  if (shopAvailSuccessCombo?.query?.includes("shopPropAvail")) return shopAvailSuccessCombo;
  try {
    const stored = await chrome.storage.local.get(["shopAvailSuccessCombo"]);
    const combo = stored?.shopAvailSuccessCombo;
    // Ignore stale shopAvailProp combos from before Hilton renamed the op.
    if (combo?.query?.includes("shopPropAvail") && combo?.appName) {
      shopAvailSuccessCombo = combo;
      return combo;
    }
    if (combo) await chrome.storage.local.remove(["shopAvailSuccessCombo"]);
  } catch {
    /* ignore */
  }
  return null;
}

async function saveShopAvailSuccessCombo(combo) {
  shopAvailSuccessCombo = combo;
  try {
    await chrome.storage.local.set({ shopAvailSuccessCombo: combo });
  } catch {
    /* ignore */
  }
}

async function hiltonGraphql(
  operationName,
  query,
  variables,
  appName = "dx_shop_search_app",
  { appVersion = null } = {}
) {
  const version = appVersion || defaultAppVersion(appName);
  const url = `https://www.hilton.com/graphql/customer?appName=${encodeURIComponent(
    appName
  )}&appVersion=${encodeURIComponent(version)}&operationName=${encodeURIComponent(
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

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    if (status === 401 || textLooksUnauthorized(text)) {
      throw new UnauthorizedError("Hilton session expired. Sign in again to continue.");
    }
    if (status === 403 || /access denied|forbidden/i.test(text)) {
      throw new Error(
        "Hilton returned 403. Open https://www.hilton.com/en/go-hilton/ signed-in in this Chrome profile, reload the extension, then retry."
      );
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
    if (isInvalidOperationNameError(message)) {
      throw new Error(`Invalid operation name (${appName} / ${version})`);
    }
    // Hilton returns field-level errors (nullable leadRate, partial regions) alongside
    // usable data — only fail when nothing came back.
    if (!hasGraphqlData(json.data)) {
      throw new Error(message);
    }
  } else if (status === 403) {
    throw new Error(
      "Hilton returned 403. Open https://www.hilton.com/en/go-hilton/ signed-in in this Chrome profile, reload the extension, then retry."
    );
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
  return countryLocationPathCandidates(country, countryCode)[0] || "usa";
}

/** Hilton locations slugs — prefer autocomplete labels (USA → usa), then ISO overrides. */
function countryLocationPathCandidates(country, countryCode) {
  const code = String(countryCode || "").toUpperCase();
  const nameSlug = slugify(country);
  const byCode = {
    US: ["usa"],
    GB: ["united-kingdom"],
    UK: ["united-kingdom"],
    AE: ["united-arab-emirates"],
    KR: ["south-korea"],
    CZ: ["czech-republic", "czechia"],
    RU: ["russia"],
    NL: ["netherlands"],
  };
  const out = [];
  const push = (slug) => {
    if (!slug || out.includes(slug)) return;
    out.push(slug);
  };
  // Autocomplete countryName is often the working slug ("USA", "Italy").
  push(nameSlug);
  for (const slug of byCode[code] || []) push(slug);
  if (code === "US") push("usa");
  return out;
}

function isGeocodeNotFoundError(err) {
  return /not found/i.test(String(err?.message || err || ""));
}

async function hiltonGeocodePlace({ address = "", placeId = "" } = {}) {
  const json = await hiltonGraphql(
    "geocode",
    GO_HILTON_GEOCODE_QUERY,
    {
      language: "en",
      address: address || null,
      placeId: placeId || "",
      sessionToken: "",
    },
    "dx-go-hilton2-ui"
  );
  return json?.data?.geocode?.match || null;
}

/**
 * Load hotels for a Hilton locations path the same way Go Hilton find-hotels does:
 * `hotelSummaryOptions_geocodePage` with `queryLimit: 150` (no `after` cursor).
 * When a page is capped at 150, expand child city/area interlinks.
 */
async function fetchAllHotelsForPlaceUri(placeUri, countryCode, { pageSize = 150 } = {}) {
  const path = normalizeLocationPath(placeUri);
  if (!path) return { hotels: [], interlinks: [] };

  const first = Math.min(Math.max(Number(pageSize) || 150, 20), 150);
  const result = await fetchGeocodePathInventory(path, countryCode, first);
  const hotels = [];
  const seen = new Set();
  for (const h of result.hotels || []) {
    if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
    seen.add(h.ctyhocn);
    hotels.push(h);
  }
  const interlinks = result.interlinks || [];

  // Dense regions hit Hilton’s 150 cap — walk child city/area pages.
  const children = childLocationPaths(path, interlinks);
  if (children.length && hotels.length >= first) {
    const batches = await mapPool(children, 4, async (childPath) => {
      try {
        return (await fetchAllHotelsForPlaceUri(childPath, countryCode, { pageSize: first }))
          .hotels;
      } catch {
        return [];
      }
    });
    for (const list of batches) {
      for (const h of list || []) {
        if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
        seen.add(h.ctyhocn);
        hotels.push(h);
      }
    }
  }

  return { hotels, interlinks };
}

function suggestionHasCity(match, resolved) {
  return Boolean(match?.address?.city || resolved?.city);
}

function isCountryMatch(match, resolved, placeUri) {
  if (isRegionSuggestion(resolved) || suggestionHasCity(match, resolved)) return false;
  return (
    isCountrySuggestion(resolved) ||
    /country/i.test(String(match?.type || "")) ||
    Boolean(placeUri && /^\/en\/locations\/[^/]+\/$/.test(placeUri))
  );
}

/** State / province / island — not a country, not a city. */
function isRegionMatch(match, resolved, placeUri) {
  if (isCountrySuggestion(resolved) || isCountryMatch(match, resolved, placeUri)) return false;
  // Autocomplete "Bilbao, Basque Country, Spain" is a city even when Hilton's
  // geocode placeUri is the parent subdivision (/en/locations/spain/basque-country/).
  if (suggestionHasCity(match, resolved) && !isRegionSuggestion(resolved)) return false;
  if (isRegionSuggestion(resolved)) return true;
  const t = String(match?.type || "").toLowerCase();
  if (/(state|region|province|administrative)/i.test(t)) return true;
  // /en/locations/{country}/{subdivision}/
  if (placeUri && /^\/en\/locations\/[^/]+\/[^/]+\/$/.test(placeUri)) return true;
  const hasState = Boolean(match?.address?.state || match?.address?.stateName || resolved?.state);
  return hasState && !suggestionHasCity(match, resolved);
}

/**
 * Fetch every hotel for a Go Hilton geocode match.
 * Primary path mirrors hilton.com: fan out over map quadrants (134 tiles for the USA).
 * The /en/locations/ crawl stays as a fallback for places the tiles don't cover.
 */
async function fetchEntirePlaceInventory(match, resolved, countryCode) {
  const placeUri = normalizeLocationPath(match?.placeUri);
  const isCountry = isCountryMatch(match, resolved, placeUri);

  let quadrantError = null;
  try {
    const tiles = await fetchInventoryByQuadrants(match, countryCode, {
      isCountry,
      suggestion: resolved,
    });
    if (tiles.hotels.length) {
      const source = tiles.failures
        ? `quadrants:${tiles.quadrants}+fails:${tiles.failures}`
        : `quadrants:${tiles.quadrants}`;
      return { hotels: tiles.hotels, source, lastError: tiles.lastError, isCountry };
    }
    quadrantError = tiles.lastError;
  } catch (err) {
    if (isUnauthorizedError(err)) throw err;
    quadrantError = err;
  }

  const pages = await fetchInventoryByLocationPages(match, resolved, countryCode);
  return { ...pages, lastError: pages.lastError || quadrantError };
}

async function fetchInventoryByLocationPages(match, resolved, countryCode) {
  const placeUri = normalizeLocationPath(match?.placeUri);
  const seen = new Set();
  const hotels = [];
  const addHotels = (list) => {
    for (const h of list || []) {
      if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
      seen.add(h.ctyhocn);
      hotels.push(h);
    }
  };

  const isCountry = isCountryMatch(match, resolved, placeUri);

  let interlinks = [];
  let sourceParts = [];
  let lastError = null;

  // Country GraphQL geocodePage is Not Found for USA — skip straight to regions.
  if (placeUri && !isCountry) {
    try {
      const page = await fetchAllHotelsForPlaceUri(placeUri, countryCode, { pageSize: 150 });
      addHotels(page.hotels);
      interlinks = page.interlinks || [];
      sourceParts.push(`geocodePage:${placeUri}`);
    } catch (err) {
      lastError = err;
      if (!isGeocodeNotFoundError(err)) throw err;
    }
  } else if (placeUri && isCountry) {
    sourceParts.push(`skipCountryPage:${placeUri}`);
  }

  // Build subdivision list: interlinks from the place page + known US states for country.
  let childPaths = childLocationPaths(placeUri, interlinks);
  const slug =
    (placeUri && placeUri.split("/").filter(Boolean).pop()) ||
    countryLocationPathCandidates(match?.address?.countryName, countryCode)[0];
  if (isCountry) {
    for (const path of knownCountryRegionPaths(countryCode, slug)) {
      if (!childPaths.includes(path)) childPaths.push(path);
    }
  }

  const shouldWalkChildren =
    childPaths.length > 0 &&
    (isCountry || hotels.length === 0 || hotels.length >= 150);

  let regionFailures = 0;
  if (shouldWalkChildren) {
    const batches = await mapPool(childPaths, 4, async (path) => {
      try {
        const child = await fetchAllHotelsForPlaceUri(path, countryCode, { pageSize: 150 });
        return child.hotels || [];
      } catch (err) {
        regionFailures += 1;
        if (!isGeocodeNotFoundError(err)) {
          lastError = err;
        }
        return [];
      }
    });
    for (const list of batches) addHotels(list);
    sourceParts.push(`regions:${childPaths.length}`);
    if (regionFailures) sourceParts.push(`regionFails:${regionFailures}`);
  }

  if (isCountry && !hotels.length && regionFailures > 0 && lastError) {
    throw lastError;
  }

  return {
    hotels,
    source: sourceParts.join("+") || null,
    lastError,
    isCountry,
  };
}

function normalizeHotel(h) {
  if (!h?.ctyhocn) return null;
  const lowest = h.leadRate?.lowest;
  return {
    ctyhocn: String(h.ctyhocn).toUpperCase(),
    name: h.name || h.ctyhocn,
    brandCode: h.brandCode || null,
    distance: h.distance ?? null,
    distanceFmt: h.distanceFmt || null,
    city: h.address?.city || null,
    country: h.address?.countryName || h.address?.country || null,
    countryCode: h.address?.country ? String(h.address.country).toUpperCase() : null,
    state: h.address?.stateName || h.address?.state || null,
    lat: h.localization?.coordinate?.latitude ?? null,
    lon: h.localization?.coordinate?.longitude ?? null,
    currency: lowest?.rateAmount != null ? "USD" : h.localization?.currencyCode || null,
    homeUrl: h.facilityOverview?.homeUrlTemplate || null,
    amount: lowest?.rateAmount ?? null,
    amountFmt: lowest?.rateAmountFmt || null,
    ratePlanCode: lowest?.ratePlanCode || null,
    ratePlanName: lowest?.ratePlan?.ratePlanName || null,
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

/** Pick the Go Hilton map quadrant used for a country inventory request. */
function pickCountryQuadrantId(countryCode, quadrants) {
  const code = String(countryCode || "").toUpperCase();
  if (!code) return null;
  const hits = [];
  for (const q of quadrants || []) {
    if (!q?.id) continue;
    const codes = (q.countries || [])
      .map((c) => String(c?.code || c || "").toUpperCase())
      .filter(Boolean);
    if (!codes.includes(code)) continue;
    hits.push({
      id: q.id,
      depth: String(q.id).split("::").length,
      exclusive: codes.length === 1,
    });
  }
  if (!hits.length) return null;
  // Prefer a tile that is only this country; among those, prefer broader (shallower)
  // coverage so one hotelSummaryOptions call returns the full country inventory.
  hits.sort((a, b) => {
    if (a.exclusive !== b.exclusive) return a.exclusive ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return String(a.id).localeCompare(String(b.id));
  });
  return hits[0].id;
}

function boundsIntersect(a, b) {
  const an = a?.northeast;
  const as = a?.southwest;
  const bn = b?.northeast;
  const bs = b?.southwest;
  if (!an || !as || !bn || !bs) return false;
  const aMinLat = Math.min(as.latitude, an.latitude);
  const aMaxLat = Math.max(as.latitude, an.latitude);
  const bMinLat = Math.min(bs.latitude, bn.latitude);
  const bMaxLat = Math.max(bs.latitude, bn.latitude);
  if (aMinLat > bMaxLat || bMinLat > aMaxLat) return false;
  const aMinLon = Math.min(as.longitude, an.longitude);
  const aMaxLon = Math.max(as.longitude, an.longitude);
  const bMinLon = Math.min(bs.longitude, bn.longitude);
  const bMaxLon = Math.max(bs.longitude, bn.longitude);
  return !(aMinLon > bMaxLon || bMinLon > aMaxLon);
}

/** Drop tiles that fully contain another selected tile — Hilton queries the leaves. */
function keepLeafQuadrants(ids) {
  const list = [...new Set(ids)];
  return list.filter((id) => !list.some((other) => other !== id && other.startsWith(`${id}::`)));
}

/** Axis-aligned box covering a radius (km) around a lat/lon. */
function boundsAroundPoint(lat, lon, km) {
  if (lat == null || lon == null || !(km > 0)) return null;
  const latPad = km / 111;
  const cos = Math.cos((Number(lat) * Math.PI) / 180);
  const lonPad = km / (111 * Math.max(0.2, Math.abs(cos)));
  return {
    northeast: { latitude: Number(lat) + latPad, longitude: Number(lon) + lonPad },
    southwest: { latitude: Number(lat) - latPad, longitude: Number(lon) - lonPad },
  };
}

function unionBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ane = a.northeast;
  const asw = a.southwest;
  const bne = b.northeast;
  const bsw = b.southwest;
  if (!ane || !asw || !bne || !bsw) return a;
  return {
    northeast: {
      latitude: Math.max(ane.latitude, bne.latitude),
      longitude: Math.max(ane.longitude, bne.longitude),
    },
    southwest: {
      latitude: Math.min(asw.latitude, bsw.latitude),
      longitude: Math.min(asw.longitude, bsw.longitude),
    },
  };
}

/**
 * The quadrants hilton.com queries for a search: every tile covering the country
 * (or intersecting the geocoded bounds), one hotelSummaryOptions call each.
 */
function selectSearchQuadrantIds(quadrants, { countryCode = null, bounds = null, isCountry = false } = {}) {
  const code = String(countryCode || "").toUpperCase();
  const byCountry = [];
  const byBounds = [];
  for (const q of quadrants || []) {
    if (!q?.id) continue;
    const codes = (q.countries || [])
      .map((c) => String(c?.code || c || "").toUpperCase())
      .filter(Boolean);
    if (code && codes.includes(code)) byCountry.push(q.id);
    if (bounds && boundsIntersect(q.bounds, bounds)) byBounds.push(q.id);
  }
  if (isCountry && byCountry.length) return keepLeafQuadrants(byCountry);
  if (byBounds.length) return keepLeafQuadrants(byBounds);
  return keepLeafQuadrants(byCountry);
}

async function fetchQuadrantHotels(quadrantId, guestLocationCountry) {
  const json = await hiltonGraphql(
    "hotelSummaryOptions",
    QUADRANT_SUMMARY_QUERY,
    {
      language: "en",
      input: { quadrantId, guestLocationCountry },
    },
    "dx_shop_search_app"
  );
  return extractHotelNodes(json?.data?.hotelSummaryOptions?.hotels)
    .map(normalizeHotel)
    .filter(Boolean);
}

/**
 * Whole-place inventory the way the Go Hilton results page builds it: resolve the
 * quadrant tree once, then fan out one request per tile and merge on ctyhocn.
 */
async function fetchInventoryByQuadrants(match, countryCode, { isCountry = false, suggestion = null } = {}) {
  const quadrants = await loadHotelQuadrants();
  const guestLocationCountry = asIso2CountryCode(countryCode) || "US";
  // City geocode boxes are tight (historic center). Expand to the same metro
  // radius we filter with so airport / suburb hotels land in inventory.
  // Skip regions — their geocode bounds (or country tiles) already cover the area.
  let bounds = match?.geometry?.bounds || null;
  if (!isCountry && !isRegionSuggestion(suggestion)) {
    const loc = match?.geometry?.location;
    const radius = radiusKmForSuggestion(suggestion) ?? 40;
    if (radius != null && radius <= 50) {
      const around =
        loc?.latitude != null && loc?.longitude != null
          ? boundsAroundPoint(loc.latitude, loc.longitude, radius)
          : null;
      bounds = unionBounds(bounds, around) || around || bounds;
    }
  }
  const ids = selectSearchQuadrantIds(quadrants, {
    countryCode: guestLocationCountry,
    bounds,
    isCountry,
  });
  if (!ids.length) return { hotels: [], quadrants: 0, failures: 0, lastError: null };

  let failures = 0;
  let lastError = null;
  const batches = await mapPool(ids, 6, async (id) => {
    try {
      return await fetchQuadrantHotels(id, guestLocationCountry);
    } catch (err) {
      if (isUnauthorizedError(err)) throw err;
      failures += 1;
      lastError = err;
      return [];
    }
  });

  const seen = new Set();
  const hotels = [];
  for (const list of batches) {
    for (const h of list || []) {
      if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
      seen.add(h.ctyhocn);
      hotels.push(h);
    }
  }
  return { hotels, quadrants: ids.length, failures, lastError };
}

async function resolveCountryQuadrantId(countryCode, place = null) {
  const code = String(countryCode || "").toUpperCase();
  const quadrants = await loadHotelQuadrants();
  let quadrantId = pickCountryQuadrantId(code, quadrants);
  if (quadrantId) return quadrantId;

  // Fallback: center of country → containing map tile (Go Hilton map search style).
  let lat = place?.lat;
  let lon = place?.lon;
  if (lat == null || lon == null) {
    const geoQuery = [place?.country, code].filter(Boolean).join(", ") || code;
    const geo = await geocodeDestination(geoQuery);
    lat = geo.lat;
    lon = geo.lon;
  }
  const matches = findContainingQuadrantIds(lat, lon, quadrants);
  if (!matches.length) return null;
  // Prefer mid-depth tiles similar to go-hilton country search captures.
  const mid = matches.filter((m) => m.depth >= 5 && m.depth <= 9);
  return (mid[0] || matches[0]).id;
}

function normalizeLocationPath(uriOrPath) {
  if (!uriOrPath) return null;
  let path = String(uriOrPath).trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* keep raw */
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path = `${path}/`;
  // Go Hilton geocode often returns bare slugs like "/usa/" — GraphQL only
  // resolves the locations tree: "/en/locations/usa/", "/en/locations/usa/texas/", …
  if (!path.includes("/locations/")) {
    const slug = path.split("/").filter(Boolean).join("/");
    if (slug) path = `/en/locations/${slug}/`;
  }
  return path;
}

function childLocationPaths(countryPath, interlinks) {
  const base = normalizeLocationPath(countryPath);
  if (!base) return [];
  const baseParts = base.split("/").filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const group of interlinks || []) {
    for (const link of group?.links || []) {
      const path = normalizeLocationPath(link?.uri);
      if (!path || !path.startsWith(base) || path === base) continue;
      const parts = path.split("/").filter(Boolean);
      // Only immediate children (e.g. /en/locations/united-states/texas/).
      if (parts.length !== baseParts.length + 1) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/** Hilton US state location slugs under /en/locations/usa/{slug}/ */
const US_STATE_LOCATION_SLUGS = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "district-of-columbia",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new-hampshire",
  "new-jersey",
  "new-mexico",
  "new-york",
  "north-carolina",
  "north-dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode-island",
  "south-carolina",
  "south-dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west-virginia",
  "wisconsin",
  "wyoming",
];

function knownCountryRegionPaths(countryCode, countrySlug) {
  const code = String(countryCode || "").toUpperCase();
  const root = String(countrySlug || countryPathName(null, code) || "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const isUs =
    code === "US" ||
    code === "USA" ||
    root === "usa" ||
    root === "united-states";
  // Hilton USA find-hotels always fans out under /en/locations/usa/{state}/.
  if (isUs) {
    return US_STATE_LOCATION_SLUGS.map((s) => `/en/locations/usa/${s}/`);
  }
  return [];
}

async function fetchGeocodePathInventory(path, countryCode, queryLimit = 150) {
  const guestLocationCountry = asIso2CountryCode(countryCode) || "US";
  const json = await hiltonGraphql(
    "hotelSummaryOptions_geocodePage",
    COUNTRY_GEOCODE_QUERY,
    {
      language: "en",
      path,
      queryLimit,
      input: { guestLocationCountry },
    },
    "dx_shop_search_app"
  );
  const page = json?.data?.geocodePage;
  if (!page) {
    throw new Error("Not Found");
  }
  const hotels = extractHotelNodes(page?.hotelSummaryOptions?.hotels)
    .map(normalizeHotel)
    .filter(Boolean);
  const interlinks = page?.location?.pageInterlinks || [];
  return { hotels, interlinks };
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  async function run() {
    while (next < list.length) {
      const i = next++;
      results[i] = await worker(list[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

/**
 * Country hotel inventory from Hilton locations geocodePage.
 * Country-level paths often 404 in GraphQL (HTML can still exist) — use state/region
 * pages instead (same approach as Hilton's own location directory crawlers).
 */
async function fetchCountryHotelInventory(countryCode, place = null) {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`Invalid country code “${countryCode || ""}”.`);
  }
  const queryLimit = 150;
  const slugs = countryLocationPathCandidates(place?.country, code);
  const countrySlug = slugs[0] || "usa";
  const countryPath = `/en/locations/${countrySlug}/`;

  let hotels = [];
  const seen = new Set();
  const addHotels = (list) => {
    let added = 0;
    for (const h of list || []) {
      if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
      seen.add(h.ctyhocn);
      hotels.push(h);
      added += 1;
    }
    return added;
  };

  // Optional: country page (works for some countries; USA GraphQL is often Not Found).
  let childPaths = [];
  let lastError = null;
  const skipCountryPage = code === "US";
  if (!skipCountryPage) {
    for (const slug of slugs) {
      const path = `/en/locations/${slug}/`;
      try {
        const primary = await fetchGeocodePathInventory(path, code, queryLimit);
        addHotels(primary.hotels);
        childPaths = childLocationPaths(path, primary.interlinks);
        break;
      } catch (err) {
        lastError = err;
        if (isGeocodeNotFoundError(err)) continue;
        throw err;
      }
    }
  }

  // USA / large countries: always walk known state (or region) pages.
  const knownRegions = knownCountryRegionPaths(code, countrySlug);
  if (knownRegions.length) {
    const fromInterlinks = new Set(childPaths);
    for (const path of knownRegions) {
      if (!fromInterlinks.has(path)) childPaths.push(path);
    }
  }

  if (childPaths.length) {
    const batches = await mapPool(childPaths, 3, async (path) => {
      try {
        const page = await fetchGeocodePathInventory(path, code, queryLimit);
        const list = page.hotels || [];
        // Dense states hit the 150 cap — pull city pages too.
        if (list.length >= queryLimit) {
          const cities = childLocationPaths(path, page.interlinks);
          if (cities.length) {
            const cityBatches = await mapPool(cities, 2, async (cityPath) => {
              try {
                const cityPage = await fetchGeocodePathInventory(cityPath, code, queryLimit);
                return cityPage.hotels || [];
              } catch {
                return [];
              }
            });
            return list.concat(cityBatches.flat());
          }
        }
        return list;
      } catch {
        return [];
      }
    });
    for (const list of batches) addHotels(list);
  }

  // Fallback: single map quadrant (viewport-scoped; last resort).
  if (!hotels.length) {
    const quadrantId = await resolveCountryQuadrantId(code, place);
    if (!quadrantId) {
      throw lastError || new Error(`No Hilton hotels found for ${code}.`);
    }
    const json = await hiltonGraphql(
      "hotelSummaryOptions",
      COUNTRY_INVENTORY_QUERY,
      {
        language: "en",
        queryLimit,
        input: {
          quadrantId,
          guestLocationCountry: code,
        },
      },
      "dx_shop_search_app"
    );
    addHotels((json?.data?.hotelSummaryOptions?.hotels || []).map(normalizeHotel).filter(Boolean));
    return { path: countryPath, quadrantId, hotels };
  }

  return { path: countryPath, quadrantId: null, hotels };
}

function sortHotelsByDistance(hotels, place) {
  return hotels
    .map((h) => {
      // Always prefer distance from the geocoded place center. Quadrant
      // hotelSummaryOptions `distance` is tile-relative and will pull in
      // Marseille/Barcelona for a Sicily search if trusted.
      let dist = Number.POSITIVE_INFINITY;
      if (h.lat != null && h.lon != null && place?.lat != null && place?.lon != null) {
        dist = haversineKm(place.lat, place.lon, h.lat, h.lon);
      } else if (Number.isFinite(Number(h.distance))) {
        dist = Number(h.distance);
      }
      return { ...h, distance: Number.isFinite(dist) ? dist : null };
    })
    .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

function normalizeCityToken(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Common Hilton/locality aliases so Milan ≡ Milano, etc. */
const CITY_ALIAS_GROUPS = [
  ["milan", "milano"],
  ["rome", "roma"],
  ["florence", "firenze"],
  ["venice", "venezia"],
  ["naples", "napoli"],
  ["munich", "munchen", "muenchen"],
  ["cologne", "koln", "koeln"],
  ["vienna", "wien"],
  ["prague", "praha"],
  ["brussels", "bruxelles", "brussel"],
  ["lisbon", "lisboa"],
  ["seville", "sevilla"],
  ["copenhagen", "kobenhavn", "koebenhavn"],
];

function citiesEquivalent(a, b) {
  const na = normalizeCityToken(a);
  const nb = normalizeCityToken(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  for (const group of CITY_ALIAS_GROUPS) {
    if (group.includes(na) && group.includes(nb)) return true;
  }
  return false;
}

function isRegionSuggestion(suggestion) {
  if (!suggestion || isCountrySuggestion(suggestion)) return false;
  if (suggestion.type === "region") return true;
  // Hilton often returns state/province predictions with place_id: null.
  return Boolean(suggestion.state && !suggestion.city && !suggestion.ctyhocn);
}

function radiusKmForSuggestion(suggestion) {
  const type = suggestion?.type || "destination";
  if (type === "hotel") return 5;
  if (type === "airport") return 45;
  if (type === "poi") return 35;
  if (type === "country") return null; // full country inventory — no radius cut
  if (type === "region" || isRegionSuggestion(suggestion)) return 350;
  // City metro: include airport / suburb hotels Go Hilton shows (e.g. Fiumicino
  // for Rome) without reaching the next city (Bilbao → San Sebastián).
  return 40;
}

function mergeHotelsByCtyhocn(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const h of list || []) {
      if (!h?.ctyhocn || seen.has(h.ctyhocn)) continue;
      seen.add(h.ctyhocn);
      out.push(h);
    }
  }
  return out;
}

/** Diagonal of Hilton geocode bounds — city boxes are tens of km, regions hundreds. */
function boundsSpanKm(bounds) {
  const ne = bounds?.northeast;
  const sw = bounds?.southwest;
  if (!ne || !sw) return null;
  return haversineKm(sw.latitude, sw.longitude, ne.latitude, ne.longitude);
}

function countryCodeFromPlaceId(placeId) {
  const m = typeof placeId === "string" ? placeId.match(/^dx-location::country::([a-z]{2})$/i) : null;
  return m ? m[1].toUpperCase() : null;
}

/** Hilton GraphQL expects ISO-3166 alpha-2 (e.g. "US"), not "United States" / "USA". */
function asIso2CountryCode(value) {
  const s = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

/** ISO-2 for the searched place, or null when Hilton didn't tell us. */
function countryCodeForPlace(match, resolved, placeId) {
  return (
    countryCodeFromPlaceId(placeId) ||
    asIso2CountryCode(match?.address?.country) ||
    asIso2CountryCode(resolved?.countryCode) ||
    asIso2CountryCode(match?.address?.countryCode) ||
    null
  );
}

function resolveGuestLocationCountry(match, resolved, placeId) {
  // guestLocationCountry is required by Hilton — "US" is the safe default.
  return countryCodeForPlace(match, resolved, placeId) || "US";
}

/** Normalize Hilton hotelSummaryOptions.hotels (array or Relay-style connection). */
function extractHotelNodes(hotelsField) {
  if (!hotelsField) return [];
  if (Array.isArray(hotelsField)) return hotelsField;
  if (Array.isArray(hotelsField.nodes)) return hotelsField.nodes;
  if (Array.isArray(hotelsField.edges)) {
    return hotelsField.edges.map((e) => e?.node).filter(Boolean);
  }
  return [];
}

function isCountrySuggestion(suggestion) {
  if (!suggestion) return false;
  if (suggestion.type === "country") return true;
  return Boolean(countryCodeFromPlaceId(suggestion.placeId));
}

function placeFromSuggestion(suggestion, fallbackQuery = "") {
  if (!suggestion) return null;
  const countryCode =
    String(suggestion.countryCode || countryCodeFromPlaceId(suggestion.placeId) || "").toUpperCase() ||
    null;
  const isCountry = isCountrySuggestion(suggestion);
  const isRegion = isRegionSuggestion(suggestion);
  // For countries/regions, primary is the place name — do not treat it as a city.
  const city = isCountry || isRegion ? null : suggestion.city || null;
  const country = suggestion.country || (isCountry ? suggestion.primary : "") || "";
  return {
    lat: suggestion.lat ?? null,
    lon: suggestion.lon ?? null,
    displayName: suggestion.label || suggestion.query || fallbackQuery,
    city,
    country,
    countryCode,
    placeCountryCode: asIso2CountryCode(countryCode),
    state: isCountry ? "" : suggestion.state || "",
    suggestionType: isCountry ? "country" : isRegion ? "region" : suggestion.type || "destination",
    placeId: suggestion.placeId || null,
    ctyhocn: suggestion.ctyhocn || null,
  };
}

/**
 * Prefer Hilton autocomplete picks the same way the Go Hilton "Where to?" box does:
 * countries and cities first, then hotels, then airports/POIs.
 * Prefer predictions that include a placeId when scores are otherwise close.
 */
function pickBestSuggestion(suggestions, query) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length) return null;
  const q = String(query || "").trim().toLowerCase();
  const scored = list.map((s) => {
    const primary = String(s.primary || "").toLowerCase();
    const label = String(s.label || s.query || "").toLowerCase();
    const city = String(s.city || "").toLowerCase();
    const isCountry = isCountrySuggestion(s);
    let score = 0;
    if (primary === q || label === q) score += 120;
    if (city === q) score += isCountry ? 0 : 40;
    if (primary.startsWith(q) || (!isCountry && city.startsWith(q))) score += 60;
    if (label.includes(q)) score += 20;
    if (isCountry) score += 90;
    else if (s.type === "destination") score += 40;
    else if (s.type === "region" || isRegionSuggestion(s)) score += 30;
    else if (s.type === "hotel") score += 25;
    else if (s.type === "airport") score += 10;
    else if (s.type === "poi") score += 8;
    // Prefer Hilton placeIds when present (countries + most cities).
    if (s.placeId) score += 15;
    // Prefer real country hits over same-named US towns (e.g. Italy, Texas).
    if (!isCountry && city === q && String(s.countryCode || "").toUpperCase() === "US") {
      score -= 100;
    }
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].s : list[0];
}

async function resolveDestinationSuggestion(destination, suggestion = null) {
  // Accept an explicit autocomplete pick (placeId may be null for states/regions).
  if (
    suggestion &&
    (suggestion.ctyhocn ||
      suggestion.placeId ||
      suggestion.query ||
      suggestion.label ||
      suggestion.primary ||
      suggestion.type === "region" ||
      suggestion.type === "country" ||
      suggestion.type === "destination")
  ) {
    return suggestion;
  }
  const q = String(destination || "").trim();
  if (q.length < 2) return null;
  try {
    const { suggestions } = await autocompleteDestination(q, { limit: 8 });
    return pickBestSuggestion(suggestions, q);
  } catch {
    return null;
  }
}

function hotelInPlaceBounds(h, bounds) {
  if (!bounds || h?.lat == null || h?.lon == null) return false;
  return pointInBounds(h.lat, h.lon, bounds);
}

function statesEquivalent(a, b) {
  const na = normalizeCityToken(a);
  const nb = normalizeCityToken(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Map tiles are shared between neighbouring countries (one Caribbean tile lists
 * AW + JM + DO), so a country search has to be cut back to the country itself.
 */
function filterHotelsToCountry(hotels, place, suggestion) {
  // Never fall back to place.countryCode — that carries Hilton's "US" default.
  const code =
    asIso2CountryCode(place?.placeCountryCode) ||
    countryCodeFromPlaceId(suggestion?.placeId) ||
    asIso2CountryCode(suggestion?.countryCode);
  const name = normalizeCityToken(place?.country || suggestion?.country || "");
  if (!code && !name) return hotels;

  const kept = hotels.filter((h) => {
    const hCode = asIso2CountryCode(h?.countryCode);
    const hName = normalizeCityToken(h?.country || "");
    if (!hCode && !hName) return true; // unknown country — don't drop silently
    if (code && hCode) return hCode === code;
    return Boolean(name && hName && hName === name);
  });
  // If the country tags don't line up at all, keep Hilton's list rather than nothing.
  return kept.length ? kept : hotels;
}

function filterHotelsToDestination(hotels, place, suggestion) {
  const radiusKm = radiusKmForSuggestion(suggestion);
  // Country inventory: full Hilton country list (no radius cut), country-scoped.
  if (radiusKm == null || isCountrySuggestion(suggestion) || place?.suggestionType === "country") {
    return sortHotelsByDistance(filterHotelsToCountry(hotels, place, suggestion), place);
  }

  const withDistance = sortHotelsByDistance(hotels, place);
  const targetCity = place?.city || suggestion?.city || null;
  const targetState = place?.state || suggestion?.state || null;
  const isRegion =
    isRegionSuggestion(suggestion) ||
    place?.suggestionType === "region" ||
    (!targetCity && Boolean(targetState));

  // Regions (New Jersey, Sicily, …): prefer geocode bounds, then state match,
  // then a wider radius around the place center — never tile-relative distance.
  if (isRegion) {
    const inBounds = place?.bounds
      ? withDistance.filter((h) => hotelInPlaceBounds(h, place.bounds))
      : [];
    if (inBounds.length) return inBounds;

    if (targetState) {
      const byState = withDistance.filter((h) => statesEquivalent(h.state, targetState));
      if (byState.length) return byState;
    }

    // A 350km ring around an island/region would reach the next country over.
    const regionCap = Math.max(radiusKm || 350, 350);
    const inRange = withDistance.filter((h) => {
      const d = Number(h.distance);
      return Number.isFinite(d) && d <= regionCap;
    });
    return filterHotelsToCountry(inRange, place, suggestion);
  }

  // City / destination: named-city hotels plus the metro ring Go Hilton shows
  // (Rome includes Fiumicino-tagged airport properties). Empty is valid when
  // nothing is in-city or within the metro radius (Bilbao).
  if (targetCity) {
    const byCity = withDistance.filter((h) => citiesEquivalent(h.city, targetCity));
    const cap = radiusKm || 40;
    const nearby = withDistance.filter((h) => {
      const d = Number(h.distance);
      return Number.isFinite(d) && d <= cap;
    });
    const span = boundsSpanKm(place?.bounds);
    const inBounds =
      span != null && span <= 80
        ? withDistance.filter((h) => hotelInPlaceBounds(h, place.bounds))
        : [];
    return mergeHotelsByCtyhocn(byCity, inBounds, nearby);
  }

  const nearby = withDistance.filter((h) => {
    const d = Number(h.distance);
    return Number.isFinite(d) && d <= (radiusKm || 40);
  });
  if (nearby.length) return nearby;
  const span = boundsSpanKm(place?.bounds);
  if (span != null && span <= 60) {
    return withDistance.filter((h) => hotelInPlaceBounds(h, place.bounds));
  }
  return [];
}

async function fetchHotelsInQuadrants(place, { maxQuadrants = 2 } = {}) {
  if (place?.lat == null || place?.lon == null) return [];
  const quadrants = await loadHotelQuadrants();
  const matches = findContainingQuadrantIds(place.lat, place.lon, quadrants);
  if (!matches.length) return [];
  const local = matches.filter((m) => m.depth >= 3);
  const use = (local.length ? local : matches).slice(0, maxQuadrants);
  const seen = new Set();
  const hotels = [];
  for (const match of use) {
    const json = await hiltonGraphql(
      "hotelSummaryOptions",
      HOTEL_SUMMARY_QUERY,
      {
        language: "en",
        input: {
          quadrantId: match.id,
          guestLocationCountry: place.countryCode || "US",
        },
      },
      "dx_shop_search_app"
    );
    for (const h of (json?.data?.hotelSummaryOptions?.hotels || []).map(normalizeHotel).filter(Boolean)) {
      if (seen.has(h.ctyhocn)) continue;
      seen.add(h.ctyhocn);
      hotels.push(h);
    }
  }
  return hotels;
}

async function searchHotelsNearDestination(destination, { suggestion = null } = {}) {
  const resolved = await resolveDestinationSuggestion(destination, suggestion);
  if (!resolved) {
    throw new Error(
      `Couldn’t resolve “${String(destination || "").trim()}” via Hilton autocomplete. Pick a suggestion.`
    );
  }
  if (resolved?.ctyhocn) {
    const place = placeFromSuggestion(resolved, destination) || {
      displayName: resolved.primary || destination,
      city: resolved.city,
      country: resolved.country,
      countryCode: resolved.countryCode,
    };
    return {
      place,
      hotels: [
        {
          ctyhocn: String(resolved.ctyhocn).toUpperCase(),
          name: resolved.primary || resolved.label || resolved.ctyhocn,
          brandCode: null,
          distance: 0,
          city: resolved.city || null,
          country: resolved.country || null,
          state: resolved.state || null,
          lat: null,
          lon: null,
        },
      ],
      resolvedSuggestion: resolved,
      inventoryOnly: false,
    };
  }

  const address =
    resolved?.query ||
    resolved?.label ||
    [resolved?.primary, resolved?.secondary].filter(Boolean).join(", ") ||
    destination;
  // Prefer Hilton placeId when autocomplete provided one (countries + most cities).
  // States/regions often have place_id: null — geocode by address only in that case.
  const placeId = resolved?.placeId || "";

  // Same resolve step as Go Hilton after clicking an autocomplete prediction.
  const match = await hiltonGeocodePlace({ address, placeId });
  if (!match) {
    throw new Error(`Hilton could not geocode “${address}”.`);
  }

  // Prefer placeId ISO-2 (dx-location::country::us). match.address.country is often
  // "USA" which breaks guestLocationCountry and skips the US state fan-out.
  const countryCode = resolveGuestLocationCountry(match, resolved, placeId);
  const placeUri = normalizeLocationPath(match?.placeUri);
  const isCountry = isCountryMatch(match, resolved, placeUri);
  const isRegion = !isCountry && isRegionMatch(match, resolved, placeUri);
  const place = {
    displayName: match.name || address,
    city: isCountry || isRegion ? null : match.address?.city || resolved?.city || null,
    state: isCountry
      ? null
      : match.address?.stateName || match.address?.state || resolved?.state || null,
    country: match.address?.countryName || resolved?.country || null,
    countryCode,
    placeCountryCode: countryCodeForPlace(match, resolved, placeId),
    lat: match.geometry?.location?.latitude ?? null,
    lon: match.geometry?.location?.longitude ?? null,
    placeUri: match.placeUri || null,
    bounds: match.geometry?.bounds || null,
    suggestionType: isCountry ? "country" : isRegion ? "region" : match.type || resolved?.type || "destination",
  };

  // Full inventory: map-quadrant fan-out like hilton.com, /en/locations pages as backup.
  const inventory = await fetchEntirePlaceInventory(match, resolved, countryCode);
  let hotels = inventory.hotels || [];

  // Quadrant tiles are far larger than the searched place — one Caribbean tile
  // covers Aruba, Jamaica and the Dominican Republic. Cut back to the place.
  if (hotels.length) {
    hotels = filterHotelsToDestination(hotels, place, resolved);
  }
  let source = inventory.source;
  let lastError = inventory.lastError;

  // Don't widen a city/region miss by pulling neighboring tiles. Go Hilton
  // shows zero hotels when the place itself has none (e.g. Bilbao).
  const allowExpand =
    !isCountry &&
    !isRegion &&
    !place.city &&
    place.suggestionType !== "destination";

  if (!hotels.length && allowExpand && place.lat != null && place.lon != null) {
    try {
      hotels = await fetchHotelsInQuadrants(place, { maxQuadrants: 6 });
      hotels = filterHotelsToDestination(hotels, place, resolved);
      source = source ? `${source}+quadrant` : "quadrant";
    } catch (err) {
      lastError = err;
    }
  }

  if (!hotels.length) {
    if (isCountry && lastError) {
      throw lastError;
    }
    return {
      place,
      hotels: [],
      resolvedSuggestion: resolved,
      source,
      inventoryOnly: false,
    };
  }

  // Always return the full hotel list for calendar / room scanning (including
  // country inventory). Broad searches just take longer at a human request pace.
  return {
    place,
    hotels,
    resolvedSuggestion: resolved,
    source,
    inventoryOnly: false,
  };
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
  const rooms = [];
  const seen = new Set();

  const pushRate = (rt, rate) => {
    if (!rate) return;
    const amount = rate.rateAmount ?? rate.rateAmountUSD ?? rate.averageRate ?? null;
    if (amount == null && rate.amountAfterTax == null) return;
    const code = String(rate.roomTypeCode || rt?.roomTypeCode || "").toUpperCase();
    const plan = rate.ratePlan || {};
    const key = `${code}|${rate.ratePlanCode || ""}|${amount}|${plan.specialRateType || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const desc = formatRoomTypeDescription(rt || {});
    rooms.push({
      roomTypeCode: code || null,
      roomTypeName: String(rt?.roomTypeName || code || "Room").trim() || "Room",
      roomTypeDesc: desc.text || null,
      roomTypeParagraphs: desc.paragraphs || [],
      roomTypeTags: desc.tags || [],
      numBeds: rt?.numBeds ?? null,
      smokingRoom: rt?.smokingRoom ?? null,
      adaAccessibleRoom: rt?.adaAccessibleRoom ?? null,
      amount,
      amountFmt: rate.rateAmountFmt ?? null,
      amountAfterTax: rate.amountAfterTax ?? null,
      roomsAvail: rate.numRoomsAvail ?? null,
      ratePlanCode: rate.ratePlanCode || plan.ratePlanCode || null,
      ratePlanName: plan.ratePlanName || null,
      ratePlanDesc: plan.ratePlanDesc || null,
      specialRateType: plan.specialRateType || null,
      isGoRate:
        plan.specialRateType === "familyAndFriends" ||
        plan.specialRateType === "teamMember" ||
        /go hilton/i.test(plan.ratePlanName || ""),
      currency: sourceCurrency,
    });
  };

  // Live shopPropAvail nests rates under roomTypes.
  for (const rt of avail.roomTypes || []) {
    for (const rate of rt.roomOnlyRates || []) pushRate(rt, rate);
    for (const rate of rt.specialRoomRates || []) pushRate(rt, rate);
    for (const rate of rt.requestedRoomRates || []) pushRate(rt, rate);
    for (const rate of rt.packageRates || []) pushRate(rt, rate);
    if (rt.quickBookRate) pushRate(rt, rt.quickBookRate);
  }

  // Legacy flat roomRates (older documents).
  if (!rooms.length) {
    const typeMap = new Map();
    for (const rt of avail.roomTypes || []) {
      if (!rt?.roomTypeCode) continue;
      typeMap.set(String(rt.roomTypeCode).toUpperCase(), rt);
    }
    for (const rate of avail.roomRates || []) {
      const code = rate.roomTypeCode ? String(rate.roomTypeCode).toUpperCase() : "";
      pushRate(typeMap.get(code) || { roomTypeCode: code }, rate);
    }
  }

  if (!rooms.length) {
    const notes = (avail.notifications || [])
      .map((n) => n?.text || n?.title || n?.subText)
      .filter(Boolean)
      .join(" · ");
    return {
      ctyhocn: json?.data?.hotel?.ctyhocn || null,
      currency: sourceCurrency,
      statusCode: avail.statusCode,
      rooms: [],
      emptyReason:
        notes ||
        (avail.statusCode != null
          ? `Hilton status ${avail.statusCode}`
          : "No room types/rates in shopAvail response"),
    };
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
  const baseVariables = {
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
    selectedRoomRateCodes: null,
    selectedRoomTypeCode: null,
    pnd: null,
    offerId: null,
    cacheId: newShopCacheId(),
    knownGuest: null,
    adjoiningRoomStay: false,
    programAccountId: null,
    ratePlanDescEnhance: true,
    includeCUCEligibility: false,
    bookedFor: null,
  };

  const query = SHOP_PROP_AVAIL_QUERY;
  const operationName = SHOP_PROP_AVAIL_OPERATION;
  const discoveredVersions = await discoverHiltonAppVersions();
  let clients = shopAvailClientAttempts(discoveredVersions);
  const cached = await loadShopAvailSuccessCombo();
  if (cached?.appName && cached?.appVersion) {
    clients = [
      { appName: cached.appName, appVersion: cached.appVersion },
      ...clients.filter(
        (c) => !(c.appName === cached.appName && c.appVersion === cached.appVersion)
      ),
    ];
  }

  let lastError = null;
  for (const client of clients) {
    try {
      const json = await hiltonGraphql(
        operationName,
        query,
        variablesForQuery(query, { ...baseVariables, cacheId: newShopCacheId() }),
        client.appName,
        { appVersion: client.appVersion }
      );
      const parsed = normalizeShopRooms(json);
      if (parsed?.rooms?.length) {
        await saveShopAvailSuccessCombo({
          appName: client.appName,
          appVersion: client.appVersion,
          query,
          operationName,
        });
        return localizeShopRoomsPayload(parsed);
      }
      if (parsed && !parsed.rooms?.length) {
        lastError = new Error(
          parsed.emptyReason || "No room rates returned for that stay."
        );
        // Response shaped correctly but empty — no point trying other clients.
        break;
      }
      lastError = new Error("No room rates returned for that stay.");
    } catch (err) {
      lastError = err;
      if (isUnauthorizedError(err)) throw err;
      if (isInvalidOperationNameError(err)) continue;
      if (/403|blocked|forbidden/i.test(String(err?.message || ""))) continue;
      // Schema mismatch on this client — try next version.
      if (
        /cannot query field|unknown argument|got invalid value|variable/i.test(
          String(err?.message || "")
        )
      ) {
        continue;
      }
    }
  }

  throw lastError || new Error("Room shop failed.");
}

const MULTI_PROP_PAGE_SIZE = 20;

/** specialRates shape ShopMultiPropAvailQueryInput accepts (no nulls, no extra keys). */
function multiPropSpecialRates(friendsAndFamily) {
  return {
    aaa: false,
    aarp: false,
    corporateId: "",
    governmentMilitary: false,
    groupCode: "",
    hhonors: false,
    lta: false,
    pnd: "",
    offerId: null,
    promoCode: "",
    senior: false,
    smb: false,
    travelAgent: false,
    teamMember: !friendsAndFamily,
    familyAndFriends: Boolean(friendsAndFamily),
    owner: false,
    ownerHGV: false,
  };
}

/**
 * Lead rates for one page of hotels (max 20 ctyhocns), the same request the
 * results page fires as you page through inventory.
 */
async function fetchMultiPropRates({
  ctyhocns,
  arrivalDate,
  departureDate,
  numAdults = 1,
  numChildren = 0,
  numRooms = 1,
  childAges = [],
  friendsAndFamily = true,
  guestId = null,
  guestLocationCountry = "US",
}) {
  const codes = [...new Set((ctyhocns || []).map((c) => String(c || "").toUpperCase()).filter(Boolean))]
    .slice(0, MULTI_PROP_PAGE_SIZE);
  if (!codes.length) return [];

  const json = await hiltonGraphql(
    "shopMultiPropAvail",
    MULTI_PROP_AVAIL_QUERY,
    {
      language: "en",
      ctyhocns: codes,
      input: {
        guestId: guestId || null,
        guestLocationCountry: asIso2CountryCode(guestLocationCountry) || "US",
        arrivalDate,
        departureDate,
        numAdults,
        numChildren,
        numRooms,
        childAges: childAges || [],
        ratePlanCodes: [],
        rateCategoryTokens: [],
        specialRates: multiPropSpecialRates(friendsAndFamily),
      },
    },
    "dx_shop_search_app"
  );

  const results = json?.data?.shopMultiPropAvail || [];
  const rates = [];
  for (const entry of results) {
    const ctyhocn = entry?.ctyhocn ? String(entry.ctyhocn).toUpperCase() : null;
    if (!ctyhocn) continue;
    const lowest = entry.summary?.lowest;
    const plan = lowest?.ratePlan || {};
    const specialRateType = plan.specialRateType || null;
    const amount = lowest?.rateAmount ?? null;
    rates.push({
      ctyhocn,
      // rateAmount/amountAfterTax are requested as USD, so no FX pass is needed.
      amount,
      amountFmt: lowest?.rateAmountFmt || (amount != null ? `$${Math.round(amount)}` : null),
      amountAfterTax: lowest?.amountAfterTax ?? null,
      currency: amount != null ? "USD" : entry.currencyCode || null,
      currencyOriginal: entry.currencyCode || null,
      ratePlanCode: lowest?.ratePlanCode || null,
      ratePlanName: plan.ratePlanName || null,
      specialRateType,
      isGoRate:
        specialRateType === "familyAndFriends" ||
        specialRateType === "teamMember" ||
        /go hilton/i.test(plan.ratePlanName || ""),
      lengthOfStay: entry.lengthOfStay ?? null,
      statusCode: entry.statusCode ?? null,
      statusMessage: entry.statusMessage || null,
      soldOut: String(entry.summary?.status?.type || "").toLowerCase() === "unavailable",
    });
  }
  return rates;
}

/**
 * Same endpoint Hilton's Go Hilton "Where to?" box uses:
 * GET /dx-customer/autocomplete?input=...&language=en
 */
async function autocompleteDestination(query, { limit = 12, location = null } = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return { suggestions: [], source: "empty" };

  const url = new URL("https://www.hilton.com/dx-customer/autocomplete");
  url.searchParams.set("input", q);
  url.searchParams.set("language", "en");
  const loc =
    location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))
      ? `${Number(location.lat)},${Number(location.lon)}`
      : null;
  if (loc) url.searchParams.set("location", loc);

  const headers = {
    accept: "*/*",
    origin: "https://www.hilton.com",
    referer: "https://www.hilton.com/en/go-hilton/",
  };
  try {
    const guestId = await readGuestIdFromCookies();
    if (guestId) headers["dx-map-session-token"] = String(guestId);
  } catch {
    /* optional */
  }

  const { ok, status, text } = await hiltonPageFetch(url.toString(), {
    method: "GET",
    headers,
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
    const countryFromId = countryCodeFromPlaceId(placeId);
    const countryCode = (countryFromId || p.address?.country || "").toString().toUpperCase() || null;
    const rawType = String(p.type || "").toLowerCase();
    const hasState = Boolean(p.address?.state || p.address?.stateName);
    const hasCity = Boolean(p.address?.city);
    // Match Hilton prediction kinds (country place_id, state-only geocode, etc.).
    const type = hotelMatch || rawType === "property"
      ? "hotel"
      : countryFromId
        ? "country"
        : rawType === "airport"
          ? "airport"
          : rawType === "pointofinterest" || rawType === "poi"
            ? "poi"
            : hasState && !hasCity && !countryFromId
              ? "region"
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
      city: type === "country" || type === "region" ? null : p.address?.city || null,
      state:
        type === "country"
          ? null
          : p.address?.stateName || p.address?.state || null,
      country: p.address?.countryName || (type === "country" ? primary : null),
      countryCode,
    });
  }

  // Keep Hilton's prediction order and full list (same as go-hilton.com).
  return { suggestions, source: "hilton" };
}

export {
  searchHotelsNearDestination,
  fetchCalendar,
  fetchShopRooms,
  fetchMultiPropRates,
  MULTI_PROP_PAGE_SIZE,
  autocompleteDestination,
  syncGuestIdFromCookies,
  getAuthSession,
  getAccessTokenFingerprint,
  isUnauthorizedError,
};
