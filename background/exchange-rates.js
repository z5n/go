/**
 * USD conversion via https://github.com/fawazahmed0/exchange-api
 * Primary: jsDelivr CDN · Fallback: Cloudflare Pages
 */

import { recordOutbound } from "./request-metrics.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USD_ENDPOINTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
];

/** @type {{ fetchedAt: number, rates: Record<string, number> } | null} */
let cached = null;
let inflight = null;

function normalizeCurrencyCode(code) {
  const c = String(code || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!c || c === "usd" || c === "us$" || c === "$") return "usd";
  return c;
}

async function fetchUsdTable() {
  let lastError = null;
  for (const url of USD_ENDPOINTS) {
    try {
      const response = await fetch(url, { method: "GET", credentials: "omit" });
      recordOutbound({
        url,
        method: "GET",
        kind: "fx",
        operation: "usd_rates",
        status: response.status,
        ok: response.ok,
        via: "service_worker",
      });
      if (!response.ok) {
        lastError = new Error(`FX HTTP ${response.status}`);
        continue;
      }
      const json = await response.json();
      const rates = json?.usd;
      if (!rates || typeof rates !== "object") {
        lastError = new Error("FX payload missing usd rates");
        continue;
      }
      return { date: json.date || null, rates };
    } catch (err) {
      recordOutbound({
        url,
        method: "GET",
        kind: "fx",
        operation: "usd_rates",
        ok: false,
        error: err?.message || err,
        via: "service_worker",
      });
      lastError = err;
    }
  }
  throw lastError || new Error("Could not load USD exchange rates.");
}

async function getUsdRateTable() {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rates;
  }
  if (!inflight) {
    inflight = fetchUsdTable()
      .then((result) => {
        cached = { fetchedAt: Date.now(), rates: result.rates };
        return result.rates;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Convert an amount in `fromCurrency` into USD.
 * With USD-base table: `rates.eur` = EUR per 1 USD ⇒ USD = amount / rates.eur
 */
export async function convertToUsd(amount, fromCurrency) {
  if (amount == null || amount === "") {
    return { amount: null, rate: null, fromCurrency: null, converted: false };
  }
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    return { amount: null, rate: null, fromCurrency: null, converted: false };
  }
  const code = normalizeCurrencyCode(fromCurrency);
  if (code === "usd") {
    return { amount: n, rate: 1, fromCurrency: "USD", converted: false };
  }

  const rates = await getUsdRateTable();
  const perUsd = Number(rates[code]);
  if (!Number.isFinite(perUsd) || perUsd <= 0) {
    throw new Error(`No USD rate for currency “${fromCurrency || "unknown"}”.`);
  }
  return {
    amount: n / perUsd,
    rate: 1 / perUsd,
    fromCurrency: String(fromCurrency || code).toUpperCase(),
    converted: true,
  };
}

export async function localizeMoneyFields(fields, fromCurrency) {
  const currency = fromCurrency || fields?.currency || null;
  const converted = await convertToUsd(fields?.amount, currency);
  if (converted.amount == null) {
    return {
      ...fields,
      currency: "USD",
      amount: null,
      amountFmt: null,
      amountOriginal: fields?.amount ?? null,
      currencyOriginal: currency || null,
      fxRateToUsd: null,
    };
  }
  const usd = converted.amount;
  return {
    ...fields,
    amount: Math.round(usd),
    amountFmt: `$${Math.round(usd)}`,
    currency: "USD",
    amountOriginal: fields?.amount ?? null,
    currencyOriginal: converted.fromCurrency,
    fxRateToUsd: converted.rate,
    amountAfterTax:
      fields?.amountAfterTax == null
        ? fields?.amountAfterTax
        : Math.round((await convertToUsd(fields.amountAfterTax, currency)).amount ?? fields.amountAfterTax),
  };
}
