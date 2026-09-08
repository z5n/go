import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const PROFILE = path.resolve("observe-out/chrome-profile");
const OUT = path.resolve("observe-out/autocomplete-capture.json");

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || (await context.newPage());
const hits = [];

page.on("request", (req) => {
  const url = req.url();
  if (!/graphql|suggest|autocomplete|places|typeahead|search/i.test(url)) return;
  if (req.method() !== "POST" && req.method() !== "GET") return;
  hits.push({
    t: Date.now(),
    method: req.method(),
    url,
    postData: req.postData()?.slice(0, 4000) || null,
  });
});

page.on("response", async (res) => {
  const url = res.url();
  if (!/graphql|suggest|autocomplete|places|typeahead/i.test(url)) return;
  try {
    const text = await res.text();
    const match = hits.find((h) => h.url === url && !h.response);
    if (match) match.response = text.slice(0, 8000);
  } catch {
    /* ignore */
  }
});

await page.goto("https://www.hilton.com/en/go-hilton/", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(3000);

// Try common search input selectors
const selectors = [
  'input[placeholder*="Where" i]',
  'input[aria-label*="Where" i]',
  'input[name*="query" i]',
  'input[data-testid*="destination" i]',
  'input[id*="search" i]',
  'input[type="search"]',
];

let filled = false;
for (const sel of selectors) {
  const el = page.locator(sel).first();
  if (await el.count()) {
    try {
      await el.click({ timeout: 2000 });
      await el.fill("");
      await el.type("Barce", { delay: 120 });
      filled = true;
      console.log("typed into", sel);
      break;
    } catch {
      /* try next */
    }
  }
}

if (!filled) {
  // fallback: click visible textbox near Find Hotels
  const inputs = page.locator("input:visible");
  const n = await inputs.count();
  console.log("visible inputs", n);
  for (let i = 0; i < Math.min(n, 8); i++) {
    const input = inputs.nth(i);
    const ph = (await input.getAttribute("placeholder")) || "";
    const aria = (await input.getAttribute("aria-label")) || "";
    console.log(i, ph, aria);
  }
}

await page.waitForTimeout(5000);
await fs.writeFile(OUT, JSON.stringify(hits, null, 2));
console.log("wrote", OUT, "hits", hits.length);
await context.close();
