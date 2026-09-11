/**
 * Local capture server for the Go Hilton recorder extension.
 * Receives GraphQL + click events from your normal Chrome session.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "observe-out");
const FULL = path.join(OUT, "graphql-full");
const PORT = Number(process.env.GO_OBSERVE_PORT || 3847);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(FULL, { recursive: true });

const eventsPath = path.join(OUT, `recorder-events-${stamp}.jsonl`);
const graphqlPath = path.join(OUT, `recorder-graphql-${stamp}.jsonl`);
const statusPath = path.join(OUT, "live-status.json");

const opCounts = new Map();
let lastUrl = "";
let eventCount = 0;

function isInteresting(name = "") {
  return /shop|avail|calendar|flex|rate|summary|guest|prop|book|search|room|price/i.test(name);
}

async function writeStatus() {
  await fs.writeFile(
    statusPath,
    JSON.stringify(
      {
        mode: "recorder-extension",
        updatedAt: new Date().toISOString(),
        lastUrl,
        eventCount,
        graphqlOpCounts: Object.fromEntries(opCounts),
        artifacts: { eventsPath, graphqlPath, FULL },
      },
      null,
      2
    )
  );
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  // Chrome Private Network Access preflight from https://hilton.com → localhost
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(await fs.readFile(statusPath, "utf8").catch(() => "{}"));
    return;
  }

  if (req.method === "POST" && req.url === "/event") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    eventCount += 1;
    lastUrl = body.href || body.url || lastUrl;
    const row = { t: new Date().toISOString(), ...body };
    await fs.appendFile(eventsPath, `${JSON.stringify(row)}\n`);

    if (body.type === "graphql") {
      const name = body.operationName || "?";
      opCounts.set(name, (opCounts.get(name) || 0) + 1);
      await fs.appendFile(graphqlPath, `${JSON.stringify(row)}\n`);
      console.log(
        `[recorder] GQL ${name} status=${body.status} rates=${body.dailyRateHints ?? "?"} hotels=${(body.ctyhocns || []).length}`
      );

      if (isInteresting(name) && (body.dailyRateHints > 0 || body.requestBody)) {
        const n = opCounts.get(name);
        const file = path.join(FULL, `rec_${stamp}_${name.replace(/[^\w.-]+/g, "_")}_${n}.json`);
        await fs.writeFile(
          file,
          JSON.stringify(
            {
              operationName: name,
              url: body.url,
              requestBody: body.requestBody,
              response: body.response,
            },
            null,
            2
          )
        );
      }
    } else if (body.type === "click") {
      console.log(`[recorder] CLICK ${body.text || body.href || ""}`);
    } else if (body.type === "nav") {
      console.log(`[recorder] NAV ${body.url || body.href}`);
    } else {
      console.log(`[recorder] ${body.type}`);
    }

    await writeStatus();
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

await writeStatus();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Go Hilton recorder server on http://127.0.0.1:${PORT}   ║
║                                                          ║
║  1. chrome://extensions → Load unpacked                  ║
║  2. Open Hilton in THAT Chrome profile (already signed   ║
║     in is ideal) and use Go Hilton normally              ║
║  3. Search Geneva, open a hotel, open flexible dates,    ║
║     flip to the next month                               ║
║  4. Tell me when you're done                             ║
╚══════════════════════════════════════════════════════════╝
`);
});
