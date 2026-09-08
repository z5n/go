/** In-memory outbound request metrics, scoped to UI page sessions. */

const MAX_EVENTS = 200;
const MAX_SESSIONS = 20;

/** @type {Map<string, SessionMetrics>} */
const sessions = new Map();

let currentSessionId = null;

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

function pruneSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.values()].sort((a, b) => (a.endedAt || a.startedAt) - (b.endedAt || b.startedAt));
  while (sessions.size > MAX_SESSIONS && ordered.length) {
    const oldest = ordered.shift();
    if (oldest && !oldest.active) sessions.delete(oldest.id);
    else break;
  }
}

export function startMetricsSession(sessionId) {
  if (!sessionId) return null;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.active = true;
    existing.endedAt = null;
    return snapshotSession(existing);
  }
  const session = emptySession(sessionId);
  sessions.set(sessionId, session);
  pruneSessions();
  return snapshotSession(session);
}

export function endMetricsSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.active = false;
  session.endedAt = Date.now();
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
}

export async function runWithMetricsSession(sessionId, fn) {
  const prev = currentSessionId;
  currentSessionId = sessionId || null;
  // Ensure the search page session exists even if START raced behind the first request.
  if (sessionId && !sessions.has(sessionId)) {
    startMetricsSession(sessionId);
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

export function getMetricsSnapshot(sessionId = null) {
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
    .map(snapshotSession);
  return {
    sessions: list,
    activeCount: list.filter((s) => s.active).length,
    totalRequests: list.reduce((sum, s) => sum + s.total, 0),
  };
}
