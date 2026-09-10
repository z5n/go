const $ = (id) => document.getElementById(id);

/** User overrides for session expand/collapse across live refreshes. */
const manuallyExpanded = new Set();
const manuallyCollapsed = new Set();

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Open this page from the Chrome extension." });
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function entriesHtml(title, obj) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return "";
  return `<div class="metrics-breakdown">
    <div class="metrics-breakdown-title">${escapeHtml(title)}</div>
    <ul>${rows
      .map(([key, count]) => `<li><span>${escapeHtml(key)}</span><strong>${count}</strong></li>`)
      .join("")}</ul>
  </div>`;
}

function eventLabel(ev) {
  if (ev.type === "request") return ev.operation || ev.name || "request";
  if (ev.name) return `${ev.type}:${ev.name}`;
  return ev.type || "event";
}

function eventStatus(ev) {
  if (ev.error) return ev.error;
  if (ev.type === "request") return ev.status ?? (ev.ok === false ? "err" : "—");
  if (ev.ok === false) return "err";
  if (ev.ok === true) return "ok";
  return "—";
}

function eventDetail(ev) {
  if (ev.type === "request") {
    const bits = [ev.via, ev.host, ev.path].filter(Boolean);
    return bits.join(" · ") || "—";
  }
  if (!ev.detail || typeof ev.detail !== "object") return ev.detail ? String(ev.detail) : "—";
  const d = ev.detail;
  const bits = [];
  if (d.destination) bits.push(d.destination);
  if (d.place) bits.push(d.place);
  if (d.hotel) bits.push(d.hotel);
  if (d.hotelCount != null) bits.push(`${d.hotelCount} hotels`);
  if (d.jobs != null) bits.push(`${d.jobs} jobs`);
  if (d.done != null && d.total != null) bits.push(`${d.done}/${d.total}`);
  if (d.matches != null) bits.push(`${d.matches} matches`);
  if (d.matchHotels != null) bits.push(`${d.matchHotels} hotels matching`);
  if (d.errors != null && d.errors > 0) bits.push(`${d.errors} errors`);
  if (d.cacheHits != null) bits.push(`${d.cacheHits} cache hits`);
  if (d.cachedMatches != null && d.cachedMatches > 0) bits.push(`${d.cachedMatches} cached matches`);
  if (d.fromCache) bits.push("from cache");
  if (d.cancelled) bits.push("cancelled");
  if (d.query) bits.push(`q=${d.query}`);
  if (d.messageType) bits.push(d.messageType);
  if (!bits.length) {
    try {
      return JSON.stringify(d).slice(0, 160);
    } catch {
      return "—";
    }
  }
  return bits.join(" · ");
}

function isSessionExpanded(session) {
  const id = String(session.id);
  if (manuallyCollapsed.has(id)) return false;
  if (manuallyExpanded.has(id)) return true;
  return Boolean(session.active);
}

function toggleSessionExpanded(sessionId) {
  const id = String(sessionId);
  const sessionEl = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
  const currentlyOpen = sessionEl ? !sessionEl.classList.contains("collapsed") : false;
  if (currentlyOpen) {
    manuallyExpanded.delete(id);
    manuallyCollapsed.add(id);
  } else {
    manuallyCollapsed.delete(id);
    manuallyExpanded.add(id);
  }
  refreshMetrics();
}

function sessionHtml(session) {
  const id = String(session.id);
  const current = Boolean(session.active);
  const open = isSessionExpanded(session);
  const status = current ? "Current" : "Previous";
  const statusClass = current ? "ok" : "";
  const events = (session.events || []).slice().reverse();
  const title = current ? "Current session" : "Previous session";
  const activity = session.activityTotal || events.length || 0;
  const requests = session.total || 0;

  return `<article
    class="metrics-session${current ? " current" : " previous"}${open ? "" : " collapsed"}"
    data-session-id="${escapeHtml(id)}"
  >
    <button
      type="button"
      class="metrics-session-toggle"
      data-session-toggle="${escapeHtml(id)}"
      aria-expanded="${open ? "true" : "false"}"
    >
      <span class="metrics-session-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>
      <div class="metrics-session-toggle-main">
        <div class="metrics-session-title">
          ${escapeHtml(title)}
          ${current ? `<span class="badge ok metrics-current-badge">Live</span>` : ""}
        </div>
        <div class="metrics-session-meta">
          Started ${escapeHtml(formatTime(session.startedAt))} · ${escapeHtml(formatDuration(session.durationMs))}
          · <span class="badge ${statusClass}">${status}</span>
        </div>
      </div>
      <div class="metrics-session-total">${activity} events · ${requests} requests</div>
    </button>
    <div class="metrics-session-id-row">
      <span class="metrics-session-id-label">Session ID</span>
      <code class="metrics-session-id mono" title="${escapeHtml(id)}">${escapeHtml(id)}</code>
      <button
        type="button"
        class="ghost-btn metrics-copy-id"
        data-copy-session-id="${escapeHtml(id)}"
        title="Copy session ID"
      >Copy ID</button>
      <button
        type="button"
        class="ghost-btn metrics-export"
        data-export-session-id="${escapeHtml(id)}"
        title="Download full session JSON (uncapped)"
      >Export</button>
    </div>
    <div class="metrics-session-body">
      <div class="metrics-grid">
        ${entriesHtml("By activity", session.byActivity)}
        ${entriesHtml("By kind", session.byKind)}
        ${entriesHtml("By host", session.byHost)}
        ${entriesHtml("By operation", session.byOperation)}
      </div>
      <div class="metrics-events">
        <div class="metrics-breakdown-title">
          Activity timeline
          ${
            session.eventsTruncated
              ? ` (showing latest ${events.length} of ${activity} — Export for full log)`
              : ` (${events.length})`
          }
        </div>
        ${
          !open
            ? ""
            : events.length
            ? `<table class="metrics-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${events
                    .map((ev) => {
                      const rowClass =
                        ev.error || ev.ok === false
                          ? " metrics-row-error"
                          : ev.type === "scan" && ev.name === "progress"
                            ? " metrics-row-scan"
                            : "";
                      return `<tr class="${rowClass.trim()}">
                        <td>${escapeHtml(formatTime(ev.t))}</td>
                        <td>${escapeHtml(ev.type || "—")}</td>
                        <td class="mono">${escapeHtml(eventLabel(ev))}</td>
                        <td>${escapeHtml(eventStatus(ev))}</td>
                        <td class="metrics-detail">${escapeHtml(eventDetail(ev))}</td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`
            : `<div class="metrics-empty">No activity recorded in this session yet. Open Search and run a query.</div>`
        }
      </div>
    </div>
  </article>`;
}

async function copyText(text, button, resetLabel) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prev = button.textContent;
      button.textContent = "Copied";
      button.classList.add("copied");
      setTimeout(() => {
        button.textContent = prev || resetLabel;
        button.classList.remove("copied");
      }, 1200);
    }
  } catch {
    window.prompt(resetLabel || "Copy:", text);
  }
}

async function copySessionId(sessionId, button) {
  await copyText(String(sessionId || ""), button, "Copy ID");
}

function flashButton(button, label, resetLabel) {
  if (!button) return;
  const prev = button.textContent;
  button.textContent = label;
  button.classList.add("copied");
  setTimeout(() => {
    button.textContent = prev || resetLabel;
    button.classList.remove("copied");
  }, 1200);
}

async function exportSession(sessionId, button) {
  const id = String(sessionId || "");
  if (!id) return;
  const res = await sendMessage({ type: "GET_METRICS", sessionId: id });
  const session = (res.sessions || []).find((s) => String(s.id) === id) || (res.sessions || [])[0];
  if (!session) {
    flashButton(button, "Missing", "Export");
    return;
  }
  const stamp = new Date(session.startedAt || Date.now()).toISOString().replace(/[:.]/g, "-");
  const shortId = id.slice(0, 8);
  const filename = `goplus-session-${shortId}-${stamp}.json`;
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashButton(button, "Saved", "Export");
}

async function refreshMetrics() {
  const res = await sendMessage({ type: "GET_METRICS" });
  if (!res.ok) {
    $("metricsLabel").textContent = res.error || "Could not load metrics.";
    $("metricsBody").innerHTML = `<div class="metrics-empty">${escapeHtml(res.error || "No data")}</div>`;
    return;
  }

  const sessions = [...(res.sessions || [])].sort((a, b) => {
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
  const currentCount = sessions.filter((s) => s.active).length;
  const activity =
    res.totalActivity ??
    sessions.reduce((n, s) => n + (s.activityTotal || (s.events || []).length || 0), 0);
  $("metricActive").textContent = String(res.activeCount || currentCount || 0);
  $("metricTotal").textContent = String(activity);
  $("metricSessions").textContent = String(sessions.length);
  $("metricsLabel").textContent = sessions.length
    ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${currentCount} current · ${activity} events`
    : "No search sessions yet — open Search and run a query";

  $("metricsBody").innerHTML = sessions.length
    ? sessions.map(sessionHtml).join("")
    : `<div class="metrics-empty">Open the Search page and run a destination search. Session activity will show up here.</div>`;
}

function boot() {
  $("refreshMetricsBtn").addEventListener("click", refreshMetrics);
  $("metricsBody").addEventListener("click", (e) => {
    const exportBtn = e.target.closest("[data-export-session-id]");
    if (exportBtn?.dataset.exportSessionId) {
      e.preventDefault();
      e.stopPropagation();
      exportSession(exportBtn.dataset.exportSessionId, exportBtn);
      return;
    }
    const copyBtn = e.target.closest("[data-copy-session-id]");
    if (copyBtn?.dataset.copySessionId) {
      e.preventDefault();
      e.stopPropagation();
      copySessionId(copyBtn.dataset.copySessionId, copyBtn);
      return;
    }
    const btn = e.target.closest("[data-session-toggle]");
    if (!btn?.dataset.sessionToggle) return;
    e.preventDefault();
    toggleSessionExpanded(btn.dataset.sessionToggle);
  });
  refreshMetrics();
  setInterval(refreshMetrics, 2000);
}

boot();
