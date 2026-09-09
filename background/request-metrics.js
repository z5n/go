/** Outbound request metrics, scoped to UI page sessions. Last 20 are persisted. */

const MAX_EVENTS = 200;
const MAX_SESSIONS = 20;
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
 *   byKind: Record<string, number>,
 *   byOperation: Record<string, number>,
 *   byHost: Record<string, number>,
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
    byKind: {},
    byOperation: {},
    byHost: {},
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

function serializeSession(session) {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    active: false, // never restore as live after SW restart
    total: session.total || 0,
    byKind: { ...(session.byKind || {}) },
    byOperation: { ...(session.byOperation || {}) },
    byHost: { ...(session.byHost || {}) },
    events: Array.isArray(session.events) ? session.events.slice(-MAX_EVENTS) : [],
  };
}

/** Keep the newest MAX_SESSIONS by startedAt. */
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
      // Keep live active flag so an open search tab can be restored if the SW
      // restarts mid-session; ensureLoaded() still marks restored rows inactive
      // until METRICS_SESSION_START re-activates them.
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
            // SW may have died mid-session — treat restored rows as previous, not live.
            endedAt: raw.endedAt != null ? Number(raw.endedAt) : Number(raw.startedAt) || Date.now(),
            active: false,
            total: Number(raw.total) || 0,
            byKind: { ...(raw.byKind || {}) },
            byOperation: { ...(raw.byOperation || {}) },
            byHost: { ...(raw.byHost || {}) },
            events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
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
    existing.active = true;
    existing.endedAt = null;
    await persistSessions();
    return snapshotSession(existing);
  }
  const session = emptySession(sessionId);
  sessions.set(sessionId, session);
  pruneSessions();
  await persistSessions();
  return snapshotSession(session);
}

export async function endMetricsSession(sessionId) {
  await ensureLoaded();
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.active = false;
  session.endedAt = Date.now();
  pruneSessions();
  await persistSessions();
  return snapshotSession(session);
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
  const id = currentSessionId;
  if (!id) return;
  const session = sessions.get(id);
  if (!session || !session.active) return;

  const op = operation || operationFromUrl(url);
  const host = hostOf(url);
  session.total += 1;
  bump(session.byKind, kind || "other");
  bump(session.byOperation, op);
  bump(session.byHost, host);
  session.events.push({
    t: Date.now(),
    method,
    kind,
    operation: op,
    host,
    status,
    ok,
    via,
    error: error ? String(error).slice(0, 160) : null,
    path: (() => {
      try {
        const u = new URL(url);
        return `${u.pathname}${u.searchParams.get("operationName") ? `?operationName=${u.searchParams.get("operationName")}` : ""}`;
      } catch {
        return String(url).slice(0, 120);
      }
    })(),
  });
  if (session.events.length > MAX_EVENTS) {
    session.events.splice(0, session.events.length - MAX_EVENTS);
  }
  schedulePersist();
}

export async function runWithMetricsSession(sessionId, fn) {
  await ensureLoaded();
  const prev = currentSessionId;
  currentSessionId = sessionId || null;
  // Ensure the search page session exists even if START raced behind the first request.
  if (sessionId && !sessions.has(sessionId)) {
    await startMetricsSession(sessionId);
  }
  try {
    return await fn();
  } finally {
    currentSessionId = prev;
  }
}

function snapshotSession(session) {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    active: session.active,
    durationMs: (session.endedAt || Date.now()) - session.startedAt,
    total: session.total,
    byKind: { ...session.byKind },
    byOperation: { ...session.byOperation },
    byHost: { ...session.byHost },
    events: session.events.slice(-80),
  };
}

export async function getMetricsSnapshot(sessionId = null) {
  await ensureLoaded();
  if (sessionId) {
    const session = sessions.get(sessionId);
    return {
      sessions: session ? [snapshotSession(session)] : [],
      activeCount: session?.active ? 1 : 0,
      totalRequests: session?.total || 0,
    };
  }
  const list = [...sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS)
    .map(snapshotSession);
  return {
    sessions: list,
    activeCount: list.filter((s) => s.active).length,
    totalRequests: list.reduce((sum, s) => sum + s.total, 0),
  };
}

// Warm the cache as soon as the service worker loads.
ensureLoaded().catch(() => {});
