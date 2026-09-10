/**
 * Calendar / date-picker widgets inspired by shadcn/ui Calendar
 * (https://ui.shadcn.com/docs/components/base/calendar).
 * Vanilla JS for the go+ extension (no React / DayPicker dependency).
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseISODate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function sameDay(a, b) {
  return (
    a &&
    b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDisplayDate(iso) {
  const date = parseISODate(iso);
  if (!date) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRangeLabel(from, to, { compact = false } = {}) {
  if (!from && !to) return "";
  const nights = nightsBetween(from, to || from);
  const stayBit = nights === 1 ? "1 night" : `${nights} nights`;
  if (from && to && from === to) {
    return compact ? formatDisplayDate(from) : `${formatDisplayDate(from)} · ${stayBit}`;
  }
  if (from && to) {
    const span = `${formatDisplayDate(from)} → ${formatDisplayDate(to)}`;
    return compact ? span : `${span} · ${stayBit}`;
  }
  if (from) return `from ${formatDisplayDate(from)}`;
  return `to ${formatDisplayDate(to)}`;
}

function nightsBetween(from, to) {
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (!a || !b) return 1;
  const ms = b.getTime() - a.getTime();
  const days = Math.round(ms / 86400000);
  return Math.max(1, days);
}

function normalizeRange(from, to) {
  if (!from) return null;
  let start = from;
  let end = to || from;
  if (end < start) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  // Same-day pick = 1-night stay (check-out next day).
  if (end === start) {
    const d = parseISODate(start);
    if (!d) return null;
    d.setDate(d.getDate() + 1);
    end = toISODate(d);
  }
  return { from: start, to: end };
}

function isoInRange(iso, from, to) {
  if (!iso || !from || !to) return false;
  return iso >= from && iso <= to;
}

function yearOptions(centerYear) {
  const start = centerYear - 80;
  const end = centerYear + 20;
  const years = [];
  for (let y = end; y >= start; y -= 1) years.push(y);
  return years;
}

/**
 * Range calendar: first click = start, second = end.
 * @param {HTMLElement} root
 * @param {{
 *   from?: string | null,
 *   to?: string | null,
 *   existingRanges?: Array<{ from: string, to: string }>,
 *   month?: Date,
 *   onChange?: (draft: { from: string | null, to: string | null }) => void,
 *   onComplete?: (range: { from: string, to: string }) => void,
 *   showOutsideDays?: boolean,
 * }} options
 */
function createRangeCalendar(root, options = {}) {
  const state = {
    from: options.from || null,
    to: options.to || null,
    hover: null,
    month: startOfMonth(
      options.month ||
        parseISODate(options.from) ||
        parseISODate(options.to) ||
        new Date()
    ),
    existingRanges: Array.isArray(options.existingRanges) ? options.existingRanges : [],
    showOutsideDays: options.showOutsideDays !== false,
  };

  root.classList.add("ui-calendar");
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "Date range calendar");

  function previewEnd() {
    if (state.from && !state.to && state.hover) return state.hover;
    return state.to;
  }

  function emitChange() {
    options.onChange?.({ from: state.from, to: state.to });
  }

  function render() {
    const month = state.month;
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const today = new Date();
    const draftEnd = previewEnd();
    const draft = normalizeRange(state.from, draftEnd);
    const hint =
      state.from && !state.to
        ? "Select check-out"
        : "Select check-in";

    const firstDow = new Date(year, monthIndex, 1).getDay();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const daysInPrev = new Date(year, monthIndex, 0).getDate();

    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      let dayNum;
      let cellDate;
      let outside = false;
      if (i < firstDow) {
        dayNum = daysInPrev - firstDow + i + 1;
        cellDate = new Date(year, monthIndex - 1, dayNum);
        outside = true;
      } else if (i >= firstDow + daysInMonth) {
        dayNum = i - firstDow - daysInMonth + 1;
        cellDate = new Date(year, monthIndex + 1, dayNum);
        outside = true;
      } else {
        dayNum = i - firstDow + 1;
        cellDate = new Date(year, monthIndex, dayNum);
      }
      if (outside && !state.showOutsideDays) {
        cells.push(`<div class="ui-calendar-day-spacer" aria-hidden="true"></div>`);
        continue;
      }
      const iso = toISODate(cellDate);
      const isStart = state.from && iso === state.from;
      const isEnd = draftEnd && iso === draftEnd && Boolean(state.from);
      const inDraft =
        draft && isoInRange(iso, draft.from, draft.to) && !isStart && !isEnd;
      const inExisting = state.existingRanges.some(
        (r) => isoInRange(iso, r.from, r.to)
      );
      const isToday = sameDay(cellDate, today);
      const classes = [
        "ui-calendar-day",
        outside ? "outside" : "",
        isStart || isEnd ? "selected" : "",
        isStart ? "range-start" : "",
        isEnd ? "range-end" : "",
        inDraft ? "in-range" : "",
        inExisting && !isStart && !isEnd && !inDraft ? "existing-range" : "",
        isToday ? "today" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        `<button type="button" class="${classes}" data-date="${iso}" aria-label="${iso}">${dayNum}</button>`
      );
    }

    const monthOpts = MONTHS_SHORT.map(
      (label, idx) =>
        `<option value="${idx}"${idx === monthIndex ? " selected" : ""}>${label}</option>`
    ).join("");
    const yearOpts = yearOptions(year)
      .map((y) => `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`)
      .join("");

    root.innerHTML = `
      <div class="ui-calendar-hint">${hint}</div>
      <div class="ui-calendar-header">
        <button type="button" class="ui-calendar-nav" data-cal-nav="-1" aria-label="Previous month">‹</button>
        <div class="ui-calendar-caption">
          <select class="ui-calendar-month" aria-label="Month">${monthOpts}</select>
          <select class="ui-calendar-year" aria-label="Year">${yearOpts}</select>
        </div>
        <button type="button" class="ui-calendar-nav" data-cal-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="ui-calendar-weekdays" aria-hidden="true">
        ${WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}
      </div>
      <div class="ui-calendar-grid">${cells.join("")}</div>
      <div class="ui-calendar-footer">
        <button type="button" class="ui-calendar-today-btn" data-cal-today>Today</button>
        <button type="button" class="ui-calendar-clear-btn" data-cal-clear>Clear</button>
      </div>
    `;
  }

  root.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-cal-nav]");
    if (nav) {
      e.preventDefault();
      state.month = addMonths(state.month, Number(nav.dataset.calNav));
      render();
      return;
    }
    if (e.target.closest("[data-cal-today]")) {
      e.preventDefault();
      const iso = toISODate(new Date());
      state.month = startOfMonth(new Date());
      state.from = iso;
      state.to = null;
      state.hover = null;
      emitChange();
      render();
      return;
    }
    if (e.target.closest("[data-cal-clear]")) {
      e.preventDefault();
      state.from = null;
      state.to = null;
      state.hover = null;
      emitChange();
      render();
      return;
    }
    const day = e.target.closest(".ui-calendar-day[data-date]");
    if (day) {
      e.preventDefault();
      const iso = day.dataset.date;
      if (!state.from || state.to) {
        state.from = iso;
        state.to = null;
        state.hover = null;
        emitChange();
        render();
        return;
      }
      const range = normalizeRange(state.from, iso);
      state.from = range.from;
      state.to = range.to;
      state.hover = null;
      emitChange();
      render();
      options.onComplete?.(range);
    }
  });

  root.addEventListener("pointerover", (e) => {
    const day = e.target.closest(".ui-calendar-day[data-date]");
    if (!day || !state.from || state.to) return;
    if (state.hover === day.dataset.date) return;
    state.hover = day.dataset.date;
    render();
  });

  root.addEventListener("change", (e) => {
    const monthSelect = e.target.closest(".ui-calendar-month");
    const yearSelect = e.target.closest(".ui-calendar-year");
    if (monthSelect) {
      state.month = new Date(state.month.getFullYear(), Number(monthSelect.value), 1);
      render();
    } else if (yearSelect) {
      state.month = new Date(Number(yearSelect.value), state.month.getMonth(), 1);
      render();
    }
  });

  render();

  return {
    setDraft(from, to) {
      state.from = from || null;
      state.to = to || null;
      state.hover = null;
      const parsed = parseISODate(state.from || state.to);
      if (parsed) state.month = startOfMonth(parsed);
      render();
    },
    setExistingRanges(ranges) {
      state.existingRanges = Array.isArray(ranges) ? ranges : [];
      render();
    },
    resetDraft() {
      state.from = null;
      state.to = null;
      state.hover = null;
      render();
      emitChange();
    },
    destroy() {
      root.innerHTML = "";
    },
  };
}

let rangesFieldApi = null;
let sharedPanel = null;
let sharedCalendar = null;
let sharedCalendarApi = null;
let panelOpen = false;

function ensureRangesPanel() {
  if (sharedPanel) return sharedPanel;
  sharedPanel = document.createElement("div");
  sharedPanel.className = "date-picker-panel date-ranges-panel";
  sharedPanel.hidden = true;
  sharedPanel.setAttribute("role", "dialog");
  sharedPanel.setAttribute("aria-label", "Choose date ranges");
  sharedCalendar = document.createElement("div");
  sharedPanel.appendChild(sharedCalendar);
  document.body.appendChild(sharedPanel);

  sharedPanel.addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("click", () => closeRangesPanel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRangesPanel();
  });
  window.addEventListener("resize", () => {
    if (panelOpen) positionRangesPanel();
  });

  return sharedPanel;
}

function positionRangesPanel() {
  const panel = ensureRangesPanel();
  const trigger = rangesFieldApi?.trigger;
  if (!trigger || panel.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(300, panel.offsetWidth || 300);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 8}px`;
  panel.style.width = `${width}px`;
  requestAnimationFrame(() => {
    const h = panel.offsetHeight;
    if (rect.bottom + 8 + h > window.innerHeight - 8 && rect.top - 8 - h > 8) {
      panel.style.top = `${rect.top - h - 8}px`;
    }
  });
}

function closeRangesPanel() {
  if (!sharedPanel) return;
  sharedPanel.hidden = true;
  panelOpen = false;
  rangesFieldApi?.trigger?.setAttribute("aria-expanded", "false");
  sharedCalendarApi?.resetDraft?.();
}

function openRangesPanel() {
  if (!rangesFieldApi) return;
  ensureRangesPanel();
  if (!sharedCalendarApi) {
    sharedCalendarApi = createRangeCalendar(sharedCalendar, {
      onComplete(range) {
        rangesFieldApi?.addRange(range);
        sharedCalendarApi?.setExistingRanges(rangesFieldApi.getRanges());
        sharedCalendarApi?.resetDraft();
        positionRangesPanel();
      },
    });
  }
  sharedCalendarApi.setExistingRanges(rangesFieldApi.getRanges());
  sharedCalendarApi.resetDraft();
  sharedPanel.hidden = false;
  panelOpen = true;
  rangesFieldApi.trigger.setAttribute("aria-expanded", "true");
  positionRangesPanel();
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/**
 * Multi-range dates field: chips + popover range calendar.
 * @param {string} rootId
 * @param {{ onChange?: (ranges: Array<{from:string,to:string}>) => void }} [options]
 */
function setupDateRangesField(rootId, options = {}) {
  const root = document.getElementById(rootId);
  if (!root) return null;
  if (rangesFieldApi?.id === rootId) return rangesFieldApi;

  root.classList.add("date-ranges-field");
  root.innerHTML = `
    <div class="date-ranges-surface">
      <div class="date-ranges-chips"></div>
      <button type="button" class="date-ranges-trigger" aria-haspopup="dialog" aria-expanded="false">
        <span class="date-ranges-placeholder">Add stays</span>
        <span class="date-ranges-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="2" y="3.5" width="12" height="10.5" rx="2"/>
            <path d="M2 6.5h12M5.5 2v3M10.5 2v3"/>
          </svg>
        </span>
      </button>
    </div>
  `;

  const surface = root.querySelector(".date-ranges-surface");
  const trigger = root.querySelector(".date-ranges-trigger");
  const chipsEl = root.querySelector(".date-ranges-chips");
  const placeholderEl = root.querySelector(".date-ranges-placeholder");
  let ranges = [];

  function rangesEqual(a, b) {
    return a.from === b.from && a.to === b.to;
  }

  function sync() {
    if (!ranges.length) {
      chipsEl.innerHTML = "";
      chipsEl.hidden = true;
      placeholderEl.hidden = false;
      surface.classList.add("is-empty");
      return;
    }
    placeholderEl.hidden = true;
    chipsEl.hidden = false;
    surface.classList.remove("is-empty");
    chipsEl.innerHTML = ranges
      .map(
        (r, i) =>
          `<span class="date-range-chip" data-range-index="${i}">
            <span class="date-range-chip-label">${escapeAttr(formatRangeLabel(r.from, r.to, { compact: true }))}</span>
            <button type="button" class="date-range-chip-remove" data-remove-range="${i}" aria-label="Remove range">×</button>
          </span>`
      )
      .join("");
  }

  function emit() {
    options.onChange?.(ranges.map((r) => ({ ...r })));
  }

  const api = {
    id: rootId,
    trigger,
    getRanges() {
      return ranges.map((r) => ({ ...r }));
    },
    setRanges(next) {
      ranges = (Array.isArray(next) ? next : [])
        .map((r) => normalizeRange(r.from || r.fromDate, r.to || r.toDate))
        .filter(Boolean);
      sync();
      emit();
      if (panelOpen) sharedCalendarApi?.setExistingRanges(api.getRanges());
    },
    addRange(range) {
      const normalized = normalizeRange(range.from, range.to);
      if (!normalized) return;
      if (ranges.some((r) => rangesEqual(r, normalized))) return;
      ranges = [...ranges, normalized].sort((a, b) =>
        a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)
      );
      sync();
      emit();
    },
    removeRange(index) {
      if (index < 0 || index >= ranges.length) return;
      ranges = ranges.filter((_, i) => i !== index);
      sync();
      emit();
      if (panelOpen) sharedCalendarApi?.setExistingRanges(api.getRanges());
    },
    sync,
  };

  surface.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove-range]");
    if (remove) {
      e.preventDefault();
      e.stopPropagation();
      api.removeRange(Number(remove.dataset.removeRange));
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent("goplus:close-overlays"));
    if (panelOpen) closeRangesPanel();
    else openRangesPanel();
  });

  rangesFieldApi = api;
  sync();
  return api;
}

function refreshDateRangesField() {
  rangesFieldApi?.sync?.();
}

function getDateRanges() {
  return rangesFieldApi?.getRanges?.() || [];
}

function setDateRanges(ranges) {
  rangesFieldApi?.setRanges?.(ranges);
}

export {
  createRangeCalendar,
  setupDateRangesField,
  refreshDateRangesField,
  getDateRanges,
  setDateRanges,
  formatDisplayDate,
  formatRangeLabel,
  nightsBetween,
  toISODate,
  parseISODate,
  normalizeRange,
};
