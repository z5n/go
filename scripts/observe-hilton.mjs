/**
 * Observation harness for Go Hilton.
 * Launches headed Chrome, records GraphQL + clicks + periodic screenshots.
 *
 * Usage: node scripts/observe-hilton.mjs
 * Stop: close the browser, or Ctrl+C.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "observe-out");
const PROFILE = path.join(OUT, "chrome-profile");
const SHOTS = path.join(OUT, "screenshots");
const FULL = path.join(OUT, "graphql-full");
const START_URL =
  process.env.GO_HILTON_URL ||
  "https://www.hilton.com/en/go-hilton/search/?query=Geneva%2C%20Geneva%2C%20Switzerland&arrivalDate=2026-09-11&departureDate=2026-09-13&flexibleDates=true&numRooms=1&numAdults=1&numChildren=0&room1ChildAges=&room1AdultAges=&friendsAndFamilyRate=true&specialRateTokens=&sortBy=DISTANCE";

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(PROFILE, { recursive: true });
await fs.mkdir(SHOTS, { recursive: true });
await fs.mkdir(FULL, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const eventsPath = path.join(OUT, `events-${stamp}.jsonl`);
const graphqlPath = path.join(OUT, `graphql-${stamp}.jsonl`);
const summaryPath = path.join(OUT, `summary-${stamp}.json`);
const statusPath = path.join(OUT, "live-status.json");
const harPath = path.join(OUT, `session-${stamp}.har`);

const events = [];
const graphqlOps = new Map();
let lastUrl = START_URL;
let pageTitle = "";
let shotIndex = 0;

async function appendJsonl(file, row) {
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

function note(type, payload) {
  const row = { t: new Date().toISOString(), type, ...payload };
  events.push(row);
  appendJsonl(eventsPath, row).catch(() => {});
  if (type === "graphql") {
    console.log(
      `[observe] GQL ${payload.operationName || "?"} ${payload.status || ""} rates=${payload.dailyRateHints ?? "?"} hotels=${payload.hotelCodes ?? "?"}`
    );
  } else if (type === "nav") {
    console.log(`[observe] NAV ${payload.url}`);
  } else if (type === "click") {
    console.log(`[observe] CLICK ${payload.text || payload.href || ""}`);
  } else if (type !== "screenshot") {
    console.log(`[observe] ${type}`, payload.message || "");
  }
}

function extractOperationName(url, postData) {
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get("operationName") || u.searchParams.get("originalOpName");
    if (fromQuery) return fromQuery;
  } catch {
    /* ignore */
  }
  try {
    return postData ? JSON.parse(postData)?.operationName || null : null;
  } catch {
    return null;
  }
}

function countRateHints(json) {
  if (!json) return 0;
  const text = JSON.stringify(json);
  const matches = text.match(/"rateAmount"|"amountBeforeTax"|"averageRate"|"cashRate"|"price"/g);
  return matches ? matches.length : 0;
}

function deepFindCtyhocns(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) deepFindCtyhocns(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    // Hilton property codes are commonly 5–8 chars (e.g. GVALCHI, ZRHVHLX)
    if ((/^ctyhocn$/i.test(k) || /^propCode$/i.test(k)) && typeof v === "string" && /^[A-Z0-9]{4,10}$/i.test(v)) {
      out.add(v.toUpperCase());
    } else if (v && typeof v === "object") {
      deepFindCtyhocns(v, out);
    }
  }
  return out;
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: String(text).slice(0, 4000) };
  }
}

function truncateJson(value, max) {
  if (value == null) return null;
  const s = JSON.stringify(value);
  if (s.length <= max) return value;
  return { _truncated: true, preview: s.slice(0, max), length: s.length };
}

function isInterestingOp(name = "") {
  return /shop|avail|calendar|flex|rate|summary|guest|prop|book|search|room/i.test(name);
}

console.log(`
╔══════════════════════════════════════════════════════════╗
║  Go Hilton observation session                           ║
║                                                          ║
║  A Chrome window should be open in front of you.         ║
║  1. Sign in to Go Hilton / Honors                        ║
║  2. Run the Geneva (or any) search                       ║
║  3. Open 1–2 hotels and their flexible-date calendars    ║
║  4. Flip a month forward on the calendar                 ║
║  5. Close the browser when finished                      ║
║                                                          ║
║  I am recording GraphQL, clicks, and screenshots.        ║
╚══════════════════════════════════════════════════════════╝
Artifacts → ${OUT}
`);

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 960 },
  recordHar: { path: harPath, content: "embed", mode: "full" },
  args: [
    "--disable-blink-features=AutomationControlled",
    "--remote-debugging-port=9222",
  ],
});

const page = context.pages()[0] || (await context.newPage());

page.on("framenavigated", async (frame) => {
  if (frame !== page.mainFrame()) return;
  lastUrl = frame.url();
  try {
    pageTitle = await page.title();
  } catch {
    pageTitle = "";
  }
  note("nav", { url: lastUrl, title: pageTitle });
  writeStatus().catch(() => {});
});

await page.exposeBinding("__goObserveClick", (_source, info) => {
  note("click", info);
});

await page.addInitScript(() => {
  window.addEventListener(
    "click",
    (event) => {
      const el = event.target?.closest?.("a,button,[role='button'],[data-testid]") || event.target;
      if (!el) return;
      window.__goObserveClick?.({
        text: (el.innerText || el.getAttribute?.("aria-label") || "").trim().slice(0, 160),
        href: el.href || el.getAttribute?.("href") || null,
        tag: el.tagName,
        testId: el.getAttribute?.("data-testid"),
      });
    },
    true
  );
});

context.on("response", async (response) => {
  try {
    const req = response.request();
    const url = response.url();
    if (!/hilton\.com\/graphql|hilton\.io\/graphql|\/graphql\/customer/i.test(url)) return;
    if (req.resourceType() !== "fetch" && req.resourceType() !== "xhr") return;

    const operationName = extractOperationName(url, req.postData());
    let json = null;
    try {
      json = await response.json();
    } catch {
      const text = await response.text().catch(() => "");
      json = text ? { _rawText: text.slice(0, 800) } : null;
    }

    const ctyhocns = [...deepFindCtyhocns(json)];
    const dailyRateHints = countRateHints(json);
    const requestBody = safeParse(req.postData());

    const key = operationName || url;
    const prev = graphqlOps.get(key) || { operationName, count: 0, samples: [] };
    prev.count += 1;
    if (prev.samples.length < 5) {
      prev.samples.push({
        url,
        status: response.status(),
        requestBody,
        responsePreview: truncateJson(json, 20000),
        ctyhocns: ctyhocns.slice(0, 40),
        dailyRateHints,
      });
    }
    graphqlOps.set(key, prev);

    const row = {
      t: new Date().toISOString(),
      operationName,
      url,
      status: response.status(),
      method: req.method(),
      ctyhocns,
      dailyRateHints,
      requestBody,
      responsePreview: truncateJson(json, 25000),
    };
    await appendJsonl(graphqlPath, row);

    if (isInterestingOp(operationName) && dailyRateHints > 0) {
      const safeName = (operationName || "op").replace(/[^\w.-]+/g, "_");
      const fullPath = path.join(FULL, `${stamp}_${safeName}_${prev.count}.json`);
      await fs.writeFile(
        fullPath,
        JSON.stringify({ url, operationName, requestBody, response: json }, null, 2)
      );
    }

    note("graphql", {
      operationName,
      status: response.status(),
      dailyRateHints,
      hotelCodes: ctyhocns.length,
    });
    writeStatus().catch(() => {});
  } catch (err) {
    note("graphql_error", { message: String(err) });
  }
});

async function writeStatus() {
  const summary = {
    updatedAt: new Date().toISOString(),
    lastUrl,
    pageTitle,
    eventCount: events.length,
    graphqlOpCounts: Object.fromEntries(
      [...graphqlOps.entries()].map(([k, v]) => [v.operationName || k, v.count])
    ),
    interestingOps: [...graphqlOps.values()]
      .filter((v) => isInterestingOp(v.operationName))
      .map((v) => ({
        operationName: v.operationName,
        count: v.count,
        lastHotels: v.samples.at(-1)?.ctyhocns?.length || 0,
        lastRates: v.samples.at(-1)?.dailyRateHints || 0,
      })),
  };
  await fs.writeFile(statusPath, JSON.stringify(summary, null, 2));
  await fs.writeFile(summaryPath, JSON.stringify({ ...summary, artifacts: { eventsPath, graphqlPath, harPath, SHOTS, FULL } }, null, 2));
}

async function takeShot(label = "auto") {
  try {
    shotIndex += 1;
    const file = path.join(SHOTS, `${stamp}_${String(shotIndex).padStart(3, "0")}_${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    pageTitle = await page.title().catch(() => pageTitle);
    lastUrl = page.url();
    note("screenshot", { file, url: lastUrl, title: pageTitle });
    await writeStatus();
  } catch (err) {
    note("screenshot_error", { message: String(err) });
  }
}

await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 120000 }).catch((err) => {
  note("goto_error", { message: String(err) });
});
await takeShot("start");

const shutdown = async () => {
  try {
    await takeShot("end");
    await writeStatus();
    await context.close();
  } catch (err) {
    console.error("[observe] shutdown error", err);
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
context.on("close", async () => {
  await writeStatus();
  process.exit(0);
});

setInterval(() => {
  takeShot("tick").catch(() => {});
}, 20000);

console.log("[observe] Browser ready — sign in and interact with Go Hilton.");
console.log("[observe] Live status →", statusPath);
