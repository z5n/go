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

function formatRangeLabel(from, to, { compact = false, mode = null, nights: nightsOpt = null } = {}) {
  if (from && typeof from === "object") {
    const range = from;
    return formatRangeLabel(range.from, range.to, {
      compact: to?.compact ?? compact,
      mode: range.mode || null,
      nights: range.nights ?? null,
    });
  }
  if (!from && !to) return "";
  if (mode === "window") {
    const n = Math.max(1, Math.min(7, Number(nightsOpt) || 1));
    const stayBit = n === 1 ? "any 1-night" : `any ${n}-night`;
    if (from && to && from === to) {
      return compact
        ? `${formatDisplayDate(from)} · ${stayBit}`
        : `${formatDisplayDate(from)} arrivals · ${stayBit}`;
    }
    if (from && to) {
      const span = `${formatDisplayDate(from)} → ${formatDisplayDate(to)}`;
      return compact ? `${span} · ${stayBit}` : `${span} arrivals · ${stayBit}`;
    }
    return stayBit;
  }
  const nights = nightsOpt != null ? Number(nightsOpt) || 1 : nightsBetween(from, to || from);
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

function normalizeRange(from, to, { mode = "exact", nights = null } = {}) {
  if (!from) return null;
  let start = from;
  let end = to || from;
  if (end < start) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  if (mode === "window") {
    const n = Math.max(1, Math.min(7, Number(nights) || 1));
    return { from: start, to: end, nights: n, mode: "window" };
  }
  // Exact stay: same-day pick = 1-night stay (check-out next day).
  if (end === start) {
    const d = parseISODate(start);
    if (!d) return null;
    d.setDate(d.getDate() + 1);
    end = toISODate(d);
  }
  return { from: start, to: end, nights: nightsBetween(start, end), mode: "exact" };
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
 *   mode?: "exact" | "window",
 *   nights?: number,
 *   onChange?: (draft: { from: string | null, to: string | null }) => void,
 *   onComplete?: (range: { from: string, to: string, nights?: number, mode?: string }) => void,
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
    mode: options.mode === "window" ? "window" : "exact",
    nights: Math.max(1, Math.min(7, Number(options.nights) || 1)),
    labels: {
      exactStart: options.exactStartHint || "Select check-in",
      exactEnd: options.exactEndHint || "Select check-out",
      windowStart: options.windowStartHint || "Select first arrival date",
      windowEnd: options.windowEndHint || "Select last arrival date",
    },
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

  function draftRange() {
    const end = previewEnd();
    if (!state.from || !end) return null;
    return normalizeRange(state.from, end, {
      mode: state.mode,
      nights: state.nights,
    });
  }

  function render() {
    const month = state.month;
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const today = new Date();
    const draftEnd = previewEnd();
    const draft = draftRange();
    const hint =
      state.mode === "window"
        ? state.from && !state.to
          ? state.labels.windowEnd
          : state.labels.windowStart
        : state.from && !state.to
          ? state.labels.exactEnd
          : state.labels.exactStart;

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
      const inExisting = state.existingRanges.some((r) => {
        if (r.mode === "window") return isoInRange(iso, r.from, r.to);
        // Exact stays highlight arrival→departure span.
        return isoInRange(iso, r.from, r.to);
      });
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
      const range = normalizeRange(state.from, iso, {
        mode: state.mode,
        nights: state.nights,
      });
      if (!range) return;
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
    setMode(mode) {
      state.mode = mode === "window" ? "window" : "exact";
      render();
    },
    setNights(nights) {
      state.nights = Math.max(1, Math.min(7, Number(nights) || 1));
      render();
    },
    setLabels(labels = {}) {
      state.labels = {
        ...state.labels,
        ...labels,
      };
      render();
    },
    getMode() {
      return state.mode;
    },
    getNights() {
      return state.nights;
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

/**
 * Single-date calendar — same chrome as the hotel range calendar.
 * @param {HTMLElement} root
 * @param {{
 *   value?: string | null,
 *   month?: Date,
 *   hint?: string,
 *   onChange?: (iso: string | null) => void,
 *   onSelect?: (iso: string) => void,
 *   showOutsideDays?: boolean,
 * }} options
 */
function createDateCalendar(root, options = {}) {
  const state = {
    value: options.value || null,
    month: startOfMonth(
      options.month || parseISODate(options.value) || new Date()
    ),
    showOutsideDays: options.showOutsideDays !== false,
    hint: options.hint || "Select date",
  };

  root.classList.add("ui-calendar");
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "Date calendar");

  function emitChange() {
    options.onChange?.(state.value);
  }

  function render() {
    const month = state.month;
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const today = new Date();

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
      const isSelected = state.value && iso === state.value;
      const isToday = sameDay(cellDate, today);
      const classes = [
        "ui-calendar-day",
        outside ? "outside" : "",
        isSelected ? "selected range-start range-end" : "",
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
      <div class="ui-calendar-hint">${state.hint}</div>
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
      state.value = iso;
      emitChange();
      render();
      options.onSelect?.(iso);
      return;
    }
    if (e.target.closest("[data-cal-clear]")) {
      e.preventDefault();
      state.value = null;
      emitChange();
      render();
      options.onSelect?.(null);
      return;
    }
    const day = e.target.closest(".ui-calendar-day[data-date]");
    if (day) {
      e.preventDefault();
      const iso = day.dataset.date;
      state.value = iso;
      emitChange();
      render();
      options.onSelect?.(iso);
    }
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
    setValue(iso) {
      state.value = iso || null;
      const parsed = parseISODate(state.value);
      if (parsed) state.month = startOfMonth(parsed);
      render();
    },
    getValue() {
      return state.value;
    },
    setHint(hint) {
      state.hint = hint || "Select date";
      render();
    },
    destroy() {
      root.innerHTML = "";
    },
  };
}

const dateRangesFields = new Map();
let activeRangesFieldId = null;
let sharedPanel = null;
let sharedCalendar = null;
let sharedCalendarApi = null;
let panelOpen = false;

function activeRangesField() {
  return activeRangesFieldId ? dateRangesFields.get(activeRangesFieldId) : null;
}

function ensureRangesPanel() {
  if (sharedPanel) return sharedPanel;
  sharedPanel = document.createElement("div");
  sharedPanel.className = "date-picker-panel date-ranges-panel";
  sharedPanel.hidden = true;
  sharedPanel.setAttribute("role", "dialog");
  sharedPanel.setAttribute("aria-label", "Choose dates");
  sharedPanel.innerHTML = `
    <div class="date-ranges-mode" role="tablist" aria-label="Stay type">
      <button type="button" class="date-ranges-mode-btn is-active" data-stay-mode="exact" role="tab" aria-selected="true">
        Exact stay
      </button>
      <button type="button" class="date-ranges-mode-btn" data-stay-mode="window" role="tab" aria-selected="false">
        Wide range
      </button>
    </div>
    <div class="date-ranges-window-opts" hidden>
      <label class="date-ranges-nights">
        <span>Nights</span>
        <input type="number" min="1" max="7" value="1" inputmode="numeric" aria-label="Length of stay in nights" />
      </label>
      <span class="date-ranges-window-help">Search every arrival in the selected dates</span>
    </div>
  `;
  sharedCalendar = document.createElement("div");
  sharedPanel.appendChild(sharedCalendar);
  document.body.appendChild(sharedPanel);

  sharedPanel.addEventListener("click", (e) => {
    e.stopPropagation();
    const modeBtn = e.target.closest("[data-stay-mode]");
    if (!modeBtn) return;
    const mode = modeBtn.dataset.stayMode === "window" ? "window" : "exact";
    setStayPanelMode(mode);
  });
  sharedPanel.addEventListener("change", (e) => {
    const nightsInput = e.target.closest(".date-ranges-nights input");
    if (!nightsInput) return;
    const n = Math.max(1, Math.min(7, Number(nightsInput.value) || 1));
    nightsInput.value = String(n);
    sharedCalendarApi?.setNights?.(n);
  });

  document.addEventListener("click", () => closeRangesPanel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRangesPanel();
  });
  window.addEventListener("resize", () => {
    if (panelOpen) positionRangesPanel();
  });

  return sharedPanel;
}

function applyPanelFieldOptions(api) {
  const panel = ensureRangesPanel();
  const allowWindow = api?.allowWindow !== false;
  const modeRow = panel.querySelector(".date-ranges-mode");
  if (modeRow) modeRow.hidden = !allowWindow;
  sharedPanel.setAttribute("aria-label", api?.ariaLabel || "Choose dates");
  sharedCalendarApi?.setLabels?.({
    exactStart: api?.exactStartHint || "Select check-in",
    exactEnd: api?.exactEndHint || "Select check-out",
    windowStart: api?.windowStartHint || "Select first arrival date",
    windowEnd: api?.windowEndHint || "Select last arrival date",
  });
  if (!allowWindow) setStayPanelMode("exact");
}

function setStayPanelMode(mode) {
  const panel = ensureRangesPanel();
  const api = activeRangesField();
  const allowWindow = api?.allowWindow !== false;
  const next = mode === "window" && allowWindow ? "window" : "exact";
  panel.querySelectorAll("[data-stay-mode]").forEach((btn) => {
    const active = btn.dataset.stayMode === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  const opts = panel.querySelector(".date-ranges-window-opts");
  if (opts) opts.hidden = next !== "window";
  sharedCalendarApi?.setMode?.(next);
  if (next === "window") {
    const nightsInput = panel.querySelector(".date-ranges-nights input");
    const n = Math.max(1, Math.min(7, Number(nightsInput?.value) || 1));
    if (nightsInput) nightsInput.value = String(n);
    sharedCalendarApi?.setNights?.(n);
  }
  sharedCalendarApi?.resetDraft?.();
  positionRangesPanel();
}

function positionRangesPanel() {
  const panel = ensureRangesPanel();
  const trigger = activeRangesField()?.trigger;
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
  activeRangesField()?.trigger?.setAttribute("aria-expanded", "false");
  activeRangesFieldId = null;
  sharedCalendarApi?.resetDraft?.();
}

function openRangesPanel(fieldId) {
  const api = dateRangesFields.get(fieldId);
  if (!api) return;
  ensureRangesPanel();
  closeDatePanel();
  if (panelOpen && activeRangesFieldId === fieldId) {
    closeRangesPanel();
    return;
  }
  activeRangesFieldId = fieldId;
  if (!sharedCalendarApi) {
    sharedCalendarApi = createRangeCalendar(sharedCalendar, {
      onComplete(range) {
        const current = activeRangesField();
        current?.addRange(range);
        sharedCalendarApi?.setExistingRanges(current?.getRanges?.() || []);
        sharedCalendarApi?.resetDraft();
        positionRangesPanel();
      },
    });
  }
  applyPanelFieldOptions(api);
  sharedCalendarApi.setExistingRanges(api.getRanges());
  const allowWindow = api.allowWindow !== false;
  const activeMode =
    sharedPanel.querySelector("[data-stay-mode].is-active")?.dataset.stayMode || "exact";
  setStayPanelMode(allowWindow && activeMode === "window" ? "window" : "exact");
  sharedPanel.hidden = false;
  panelOpen = true;
  api.trigger.setAttribute("aria-expanded", "true");
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
 * @param {{
 *   onChange?: (ranges: Array<{from:string,to:string}>) => void,
 *   placeholder?: string,
 *   allowWindow?: boolean,
 *   ariaLabel?: string,
 *   exactStartHint?: string,
 *   exactEndHint?: string,
 * }} [options]
 */
function setupDateRangesField(rootId, options = {}) {
  const root = document.getElementById(rootId);
  if (!root) return null;
  if (dateRangesFields.has(rootId)) return dateRangesFields.get(rootId);

  root.classList.add("date-ranges-field");
  const placeholder = options.placeholder || "Add stays";
  root.innerHTML = `
    <div class="date-ranges-surface">
      <div class="date-ranges-chips"></div>
      <button type="button" class="date-ranges-trigger" aria-haspopup="dialog" aria-expanded="false">
        <span class="date-ranges-placeholder">${escapeAttr(placeholder)}</span>
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
    return (
      a.from === b.from &&
      a.to === b.to &&
      (a.mode || "exact") === (b.mode || "exact") &&
      Number(a.nights || 0) === Number(b.nights || 0)
    );
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
          `<span class="date-range-chip${r.mode === "window" ? " is-window" : ""}" data-range-index="${i}">
            <span class="date-range-chip-label">${escapeAttr(formatRangeLabel(r, null, { compact: true }))}</span>
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
    allowWindow: options.allowWindow !== false,
    ariaLabel: options.ariaLabel || "Choose dates",
    exactStartHint: options.exactStartHint || "Select check-in",
    exactEndHint: options.exactEndHint || "Select check-out",
    windowStartHint: options.windowStartHint || "Select first arrival date",
    windowEndHint: options.windowEndHint || "Select last arrival date",
    getRanges() {
      return ranges.map((r) => ({ ...r }));
    },
    setRanges(next) {
      ranges = (Array.isArray(next) ? next : [])
        .map((r) =>
          normalizeRange(r.from || r.fromDate, r.to || r.toDate, {
            mode: r.mode === "window" && api.allowWindow ? "window" : "exact",
            nights: r.nights,
          })
        )
        .filter(Boolean);
      sync();
      emit();
      if (panelOpen && activeRangesFieldId === rootId) {
        sharedCalendarApi?.setExistingRanges(api.getRanges());
      }
    },
    addRange(range) {
      const normalized = normalizeRange(range.from, range.to, {
        mode: range.mode === "window" && api.allowWindow ? "window" : "exact",
        nights: range.nights,
      });
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
      if (panelOpen && activeRangesFieldId === rootId) {
        sharedCalendarApi?.setExistingRanges(api.getRanges());
      }
    },
    setHints({ exactStart, exactEnd } = {}) {
      if (exactStart) api.exactStartHint = exactStart;
      if (exactEnd) api.exactEndHint = exactEnd;
      if (panelOpen && activeRangesFieldId === rootId) applyPanelFieldOptions(api);
    },
    setPlaceholder(text) {
      placeholderEl.textContent = text || placeholder;
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
    openRangesPanel(rootId);
  });

  dateRangesFields.set(rootId, api);
  sync();
  return api;
}

function refreshDateRangesField(rootId = "dateRanges") {
  dateRangesFields.get(rootId)?.sync?.();
}

function getDateRanges(rootId = "dateRanges") {
  return dateRangesFields.get(rootId)?.getRanges?.() || [];
}

function setDateRanges(ranges, rootId = "dateRanges") {
  dateRangesFields.get(rootId)?.setRanges?.(ranges);
}

function setDateRangesHints(rootId, hints = {}) {
  dateRangesFields.get(rootId)?.setHints?.(hints);
}

function setDateRangesPlaceholder(rootId, text) {
  dateRangesFields.get(rootId)?.setPlaceholder?.(text);
}

const dateFieldApis = new Map();
let sharedDatePanel = null;
let sharedDateCalendar = null;
let sharedDateCalendarApi = null;
let datePanelOpen = false;
/** @type {string | null} */
let activeDateFieldId = null;

function ensureDatePanel() {
  if (sharedDatePanel) return sharedDatePanel;
  sharedDatePanel = document.createElement("div");
  sharedDatePanel.className = "date-picker-panel date-single-panel";
  sharedDatePanel.hidden = true;
  sharedDatePanel.setAttribute("role", "dialog");
  sharedDatePanel.setAttribute("aria-label", "Choose date");
  sharedDateCalendar = document.createElement("div");
  sharedDatePanel.appendChild(sharedDateCalendar);
  document.body.appendChild(sharedDatePanel);

  sharedDatePanel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => closeDatePanel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDatePanel();
  });
  document.addEventListener("goplus:close-overlays", (e) => {
    if (e.detail?.source === "date-field") return;
    closeDatePanel();
  });
  window.addEventListener("resize", () => {
    if (datePanelOpen) positionDatePanel();
  });

  return sharedDatePanel;
}

function positionDatePanel() {
  const panel = ensureDatePanel();
  const api = activeDateFieldId ? dateFieldApis.get(activeDateFieldId) : null;
  const trigger = api?.trigger;
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

function closeDatePanel() {
  if (!sharedDatePanel) return;
  sharedDatePanel.hidden = true;
  datePanelOpen = false;
  const api = activeDateFieldId ? dateFieldApis.get(activeDateFieldId) : null;
  api?.trigger?.setAttribute("aria-expanded", "false");
  activeDateFieldId = null;
}

function openDatePanel(fieldId) {
  const api = dateFieldApis.get(fieldId);
  if (!api) return;
  ensureDatePanel();
  closeRangesPanel();
  activeDateFieldId = fieldId;
  if (!sharedDateCalendarApi) {
    sharedDateCalendarApi = createDateCalendar(sharedDateCalendar, {
      onSelect(iso) {
        const current = activeDateFieldId ? dateFieldApis.get(activeDateFieldId) : null;
        if (!current) return;
        current.setValue(iso, { emit: true });
        closeDatePanel();
      },
    });
  }
  sharedDateCalendarApi.setHint(api.hint || "Select date");
  sharedDateCalendarApi.setValue(api.getValue());
  sharedDatePanel.hidden = false;
  datePanelOpen = true;
  api.trigger.setAttribute("aria-expanded", "true");
  positionDatePanel();
}

/**
 * Single date field: hotel-style trigger + shared calendar popover.
 * @param {string} rootId
 * @param {{
 *   value?: string | null,
 *   placeholder?: string,
 *   hint?: string,
 *   onChange?: (iso: string | null) => void,
 * }} [options]
 */
function setupDateField(rootId, options = {}) {
  const root = document.getElementById(rootId);
  if (!root) return null;
  if (dateFieldApis.has(rootId)) return dateFieldApis.get(rootId);

  root.classList.add("date-ranges-field", "date-single-field");
  root.innerHTML = `
    <div class="date-ranges-surface is-empty">
      <button type="button" class="date-ranges-trigger" aria-haspopup="dialog" aria-expanded="false">
        <span class="date-ranges-placeholder">${escapeAttr(options.placeholder || "Select date")}</span>
        <span class="date-ranges-value" hidden></span>
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
  const placeholderEl = root.querySelector(".date-ranges-placeholder");
  const valueEl = root.querySelector(".date-ranges-value");
  let value = options.value || null;

  function sync() {
    if (!value) {
      placeholderEl.hidden = false;
      valueEl.hidden = true;
      valueEl.textContent = "";
      surface.classList.add("is-empty");
      return;
    }
    placeholderEl.hidden = true;
    valueEl.hidden = false;
    valueEl.textContent = formatDisplayDate(value);
    surface.classList.remove("is-empty");
  }

  const api = {
    id: rootId,
    trigger,
    hint: options.hint || "Select date",
    getValue() {
      return value;
    },
    setValue(next, { emit = false } = {}) {
      value = next || null;
      sync();
      if (emit) options.onChange?.(value);
    },
    setHint(hint) {
      api.hint = hint || "Select date";
    },
    setPlaceholder(text) {
      placeholderEl.textContent = text || "Select date";
    },
    sync,
  };

  surface.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.dispatchEvent(
      new CustomEvent("goplus:close-overlays", { detail: { source: "date-field" } })
    );
    if (datePanelOpen && activeDateFieldId === rootId) {
      closeDatePanel();
      return;
    }
    openDatePanel(rootId);
  });

  dateFieldApis.set(rootId, api);
  sync();
  return api;
}

function getDateFieldValue(rootId) {
  return dateFieldApis.get(rootId)?.getValue?.() || "";
}

function setDateFieldValue(rootId, iso) {
  dateFieldApis.get(rootId)?.setValue?.(iso || null);
}

function setDateFieldHint(rootId, hint) {
  dateFieldApis.get(rootId)?.setHint?.(hint);
}

function setDateFieldPlaceholder(rootId, text) {
  dateFieldApis.get(rootId)?.setPlaceholder?.(text);
}

export {
  createRangeCalendar,
  createDateCalendar,
  setupDateRangesField,
  setupDateField,
  refreshDateRangesField,
  getDateRanges,
  setDateRanges,
  setDateRangesHints,
  setDateRangesPlaceholder,
  getDateFieldValue,
  setDateFieldValue,
  setDateFieldHint,
  setDateFieldPlaceholder,
  formatDisplayDate,
  formatRangeLabel,
  nightsBetween,
  toISODate,
  parseISODate,
  normalizeRange,
};
