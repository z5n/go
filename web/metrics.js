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

function isSessionExpanded(session) {
  const id = String(session.id);
  if (manuallyCollapsed.has(id)) return false;
  if (manuallyExpanded.has(id)) return true;
  // Current (active search-tab) sessions stay open; previous ones start collapsed.
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
      <div class="metrics-session-total">${session.total} requests</div>
    </button>
    <div class="metrics-session-id-row">
      <span class="metrics-session-id-label">Session ID</span>
      <code class="metrics-session-id mono" title="${escapeHtml(id)}">${escapeHtml(id)}</code>
      <button
        type="button"
        class="ghost-btn metrics-copy-id"
        data-copy-session-id="${escapeHtml(id)}"
        title="Copy session ID"
      >Copy</button>
    </div>
    <div class="metrics-session-body">
      <div class="metrics-grid">
        ${entriesHtml("By kind", session.byKind)}
        ${entriesHtml("By host", session.byHost)}
        ${entriesHtml("By operation", session.byOperation)}
      </div>
      <div class="metrics-events">
        <div class="metrics-breakdown-title">Recent outbound requests</div>
        ${
          events.length
            ? `<table class="metrics-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Kind</th>
                    <th>Operation</th>
                    <th>Status</th>
                    <th>Via</th>
                  </tr>
                </thead>
                <tbody>
                  ${events
                    .map(
                      (ev) => `<tr>
                        <td>${escapeHtml(formatTime(ev.t))}</td>
                        <td>${escapeHtml(ev.kind || "—")}</td>
                        <td class="mono">${escapeHtml(ev.operation || "—")}</td>
                        <td>${escapeHtml(ev.status ?? (ev.error ? "err" : "—"))}</td>
                        <td>${escapeHtml(ev.via || "—")}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="metrics-empty">No outbound requests recorded in this session yet. Run a search to generate traffic.</div>`
        }
      </div>
    </div>
  </article>`;
}

async function copySessionId(sessionId, button) {
  const id = String(sessionId || "");
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    if (button) {
      const prev = button.textContent;
      button.textContent = "Copied";
      button.classList.add("copied");
      setTimeout(() => {
        button.textContent = prev || "Copy ID";
        button.classList.remove("copied");
      }, 1200);
    }
  } catch {
    // Fallback for restricted clipboard — select via prompt.
    window.prompt("Copy session ID:", id);
  }
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
  $("metricActive").textContent = String(res.activeCount || currentCount || 0);
  $("metricTotal").textContent = String(res.totalRequests || 0);
  $("metricSessions").textContent = String(sessions.length);
  $("metricsLabel").textContent = sessions.length
    ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${currentCount} current`
    : "No search sessions yet — open Search and run a query";

  $("metricsBody").innerHTML = sessions.length
    ? sessions.map(sessionHtml).join("")
    : `<div class="metrics-empty">Open the Search page and run a destination search. Outbound Hilton / geocode requests will show up here for that session.</div>`;
}

function boot() {
  $("refreshMetricsBtn").addEventListener("click", refreshMetrics);
  $("metricsBody").addEventListener("click", (e) => {
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
