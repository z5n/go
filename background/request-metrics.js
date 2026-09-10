/** Session activity log for go+ Search tabs — requests + extension lifecycle. */

const MAX_SESSIONS = 20;
/** How many recent events to include in the live Metrics UI list (export is uncapped). */
const UI_EVENTS_PREVIEW = 400;
const STORAGE_KEY = "metricsSessions";

/** @type {Map<string, SessionMetrics>} */
const sessions = new Map();

let currentSessionId = null;
let loaded = false;
/** @type {Promise<void> | null} */
let loadPromise = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let persistTimer = null;

/**
 * @typedef {{
 *   id: string,
 *   startedAt: number,
 *   endedAt: number | null,
 *   active: boolean,
 *   total: number,
 *   activityTotal: number,
 *   byKind: Record<string, number>,
 *   byOperation: Record<string, number>,
 *   byHost: Record<string, number>,
 *   byActivity: Record<string, number>,
 *   events: Array<Record<string, unknown>>,
 * }} SessionMetrics
 */

function emptySession(id) {
  return {
    id,
    startedAt: Date.now(),
    endedAt: null,
    active: true,
    total: 0,
    activityTotal: 0,
    byKind: {},
    byOperation: {},
    byHost: {},
    byActivity: {},
    events: [],
  };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function operationFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("operationName") || u.pathname.split("/").filter(Boolean).pop() || u.pathname;
  } catch {
    return "unknown";
  }
}

/** Drop non-JSON-safe / oversized values before persistence. */
function sanitizeDetail(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) {
    const max = 40;
    const sliced = value.slice(0, max).map((v) => sanitizeDetail(v, depth + 1));
    if (value.length > max) sliced.push(`…+${value.length - max} more`);
    return sliced;
  }
  if (typeof value === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n >= 30) {
        out["…"] = "truncated";
        break;
      }
      // Never persist full hotel/rate inventories in the activity log.
      if (/^(hotels|rows|days|rooms|suggestions|events)$/i.test(k) && Array.isArray(v)) {
        out[k] = { count: v.length };
        n += 1;
        continue;
      }
      out[k] = sanitizeDetail(v, depth + 1);
      n += 1;
    }
    return out;
  }
  return String(value).slice(0, 200);
}

function resolveSessionId(explicitId = null) {
  let id = explicitId || currentSessionId;
  if (!id) {
    const actives = [...sessions.values()].filter((s) => s.active);
    if (actives.length === 1) id = actives[0].id;
  }
  return id || null;
}

function pushEvent(session, event) {
  session.activityTotal = (session.activityTotal || 0) + 1;
  bump(session.byActivity, event.type || "event");
  session.events.push(event);
  schedulePersist();
}

function serializeSession(session) {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    active: false,
    total: session.total || 0,
    activityTotal: session.activityTotal || session.events?.length || 0,
    byKind: { ...(session.byKind || {}) },
    byOperation: { ...(session.byOperation || {}) },
    byHost: { ...(session.byHost || {}) },
    byActivity: { ...(session.byActivity || {}) },
    events: Array.isArray(session.events) ? session.events.slice() : [],
  };
}

function pruneSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const keep = new Set(ordered.slice(0, MAX_SESSIONS).map((s) => s.id));
  for (const id of [...sessions.keys()]) {
    if (!keep.has(id)) sessions.delete(id);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSessions().catch(() => {});
  }, 400);
}

async function persistSessions() {
  if (!loaded) return;
  pruneSessions();
  const list = [...sessions.values()]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, MAX_SESSIONS)
    .map((s) => ({
      ...serializeSession(s),
      active: Boolean(s.active),
      endedAt: s.active ? null : s.endedAt,
    }));
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

async function ensureLoaded() {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const data = await chrome.storage.local.get(STORAGE_KEY);
        const list = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
        for (const raw of list) {
          if (!raw?.id || sessions.has(raw.id)) continue;
          sessions.set(raw.id, {
            id: String(raw.id),
            startedAt: Number(raw.startedAt) || Date.now(),
            endedAt: raw.endedAt != null ? Number(raw.endedAt) : Number(raw.startedAt) || Date.now(),
            active: false,
            total: Number(raw.total) || 0,
            activityTotal: Number(raw.activityTotal) || (Array.isArray(raw.events) ? raw.events.length : 0),
            byKind: { ...(raw.byKind || {}) },
            byOperation: { ...(raw.byOperation || {}) },
            byHost: { ...(raw.byHost || {}) },
            byActivity: { ...(raw.byActivity || {}) },
            events: Array.isArray(raw.events) ? raw.events.slice() : [],
          });
        }
        pruneSessions();
      } catch {
        /* ignore corrupt storage */
      } finally {
        loaded = true;
      }
    })();
  }
  await loadPromise;
}

export async function startMetricsSession(sessionId) {
  await ensureLoaded();
  if (!sessionId) return null;
  const existing = sessions.get(sessionId);
  if (existing) {
    const wasInactive = !existing.active;
    existing.active = true;
    existing.endedAt = null;
    if (wasInactive) {
      pushEvent(existing, {
        t: Date.now(),
        type: "session",
        name: "resume",
      });
    }
    await persistSessions();
    return snapshotSession(existing);
  }
  const session = emptySession(sessionId);
  sessions.set(sessionId, session);
  pruneSessions();
  pushEvent(session, {
    t: Date.now(),
    type: "session",
    name: "start",
  });
  await persistSessions();
  return snapshotSession(session);
}

export async function endMetricsSession(sessionId) {
  await ensureLoaded();
  const session = sessions.get(sessionId);
  if (!session) return null;
  pushEvent(session, {
    t: Date.now(),
    type: "session",
    name: "end",
  });
  session.active = false;
  session.endedAt = Date.now();
  pruneSessions();
  await persistSessions();
  return snapshotSession(session);
}

/**
 * Record any extension activity for the current (or explicit) metrics session.
 * @param {{
 *   type: string,
 *   name?: string,
 *   ok?: boolean | null,
 *   error?: string | null,
 *   sessionId?: string | null,
 *   detail?: Record<string, unknown>,
 * }} evt
 */
export function recordActivity(evt = {}) {
  const id = resolveSessionId(evt.sessionId || null);
  if (!id) return;
  const session = sessions.get(id);
  if (!session || !session.active) return;

  const type = String(evt.type || "event");
  const name = evt.name != null ? String(evt.name) : null;
  pushEvent(session, {
    t: Date.now(),
    type,
    name,
    ok: evt.ok ?? null,
    error: evt.error ? String(evt.error).slice(0, 240) : null,
    detail: evt.detail != null ? sanitizeDetail(evt.detail) : null,
  });
}

export function recordOutbound({
  url = "",
  method = "GET",
  kind = "other",
  operation = null,
  status = null,
  ok = null,
  via = null,
  error = null,
} = {}) {
  const id = resolveSessionId();
  if (!id) return;
  const session = sessions.get(id);
  if (!session || !session.active) return;

  const op = operation || operationFromUrl(url);
  const host = hostOf(url);
  session.total += 1;
  bump(session.byKind, kind || "other");
  bump(session.byOperation, op);
  bump(session.byHost, host);

  let path = String(url).slice(0, 120);
  try {
    const u = new URL(url);
    path = `${u.pathname}${
      u.searchParams.get("operationName") ? `?operationName=${u.searchParams.get("operationName")}` : ""
    }`;
  } catch {
    /* keep slice */
  }

  pushEvent(session, {
    t: Date.now(),
    type: "request",
    name: op,
    method,
    kind: kind || "other",
    operation: op,
    host,
    status,
    ok,
    via,
    error: error ? String(error).slice(0, 160) : null,
    path,
  });
}

export async function runWithMetricsSession(sessionId, fn) {
  await ensureLoaded();
  const prev = currentSessionId;
  if (sessionId) {
    await startMetricsSession(sessionId);
    currentSessionId = sessionId;
  }
  try {
    return await fn();
  } finally {
    currentSessionId = prev;
  }
}

function snapshotSession(session, { fullEvents = false } = {}) {
  const all = Array.isArray(session.events) ? session.events : [];
  const events = fullEvents ? all.slice() : all.slice(-UI_EVENTS_PREVIEW);
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    active: session.active,
    durationMs: (session.endedAt || Date.now()) - session.startedAt,
    total: session.total,
    activityTotal: session.activityTotal || all.length,
    byKind: { ...session.byKind },
    byOperation: { ...session.byOperation },
    byHost: { ...session.byHost },
    byActivity: { ...(session.byActivity || {}) },
    events,
    eventsTruncated: !fullEvents && all.length > events.length,
  };
}

export async function getMetricsSnapshot(sessionId = null, { fullEvents = false } = {}) {
  await ensureLoaded();
  if (sessionId) {
    const session = sessions.get(sessionId);
    return {
      sessions: session ? [snapshotSession(session, { fullEvents: true })] : [],
      activeCount: session?.active ? 1 : 0,
      totalRequests: session?.total || 0,
      totalActivity: session?.activityTotal || 0,
    };
  }
  const list = [...sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS)
    .map((s) => snapshotSession(s, { fullEvents }));
  return {
    sessions: list,
    activeCount: list.filter((s) => s.active).length,
    totalRequests: list.reduce((sum, s) => sum + s.total, 0),
    totalActivity: list.reduce((sum, s) => sum + (s.activityTotal || 0), 0),
  };
}

ensureLoaded().catch(() => {});
