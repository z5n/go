/**
 * Calendar / date-picker widgets inspired by shadcn/ui Calendar
 * (https://ui.shadcn.com/docs/components/base/calendar).
 * Vanilla JS for the go+ extension (no React / DayPicker dependency).
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
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

function yearOptions(centerYear) {
  const start = centerYear - 80;
  const end = centerYear + 20;
  const years = [];
  for (let y = end; y >= start; y -= 1) years.push(y);
  return years;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   selected?: string | null,
 *   month?: Date,
 *   onSelect?: (iso: string | null) => void,
 *   showOutsideDays?: boolean,
 * }} options
 */
function createCalendar(root, options = {}) {
  const state = {
    selected: options.selected || null,
    month: startOfMonth(options.month || parseISODate(options.selected) || new Date()),
    showOutsideDays: options.showOutsideDays !== false,
  };

  root.classList.add("ui-calendar");
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "Calendar");

  function emitSelect(iso) {
    state.selected = iso;
    options.onSelect?.(iso);
    render();
  }

  function render() {
    const month = state.month;
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const today = new Date();
    const selected = parseISODate(state.selected);

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
      const isSelected = sameDay(cellDate, selected);
      const isToday = sameDay(cellDate, today);
      const classes = [
        "ui-calendar-day",
        outside ? "outside" : "",
        isSelected ? "selected" : "",
        isToday ? "today" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        `<button type="button" class="${classes}" data-date="${iso}" aria-label="${iso}"${
          isSelected ? ' aria-pressed="true"' : ""
        }>${dayNum}</button>`
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
      emitSelect(iso);
      return;
    }
    if (e.target.closest("[data-cal-clear]")) {
      e.preventDefault();
      emitSelect(null);
      return;
    }
    const day = e.target.closest(".ui-calendar-day[data-date]");
    if (day) {
      e.preventDefault();
      emitSelect(day.dataset.date);
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
    setSelected(iso) {
      state.selected = iso || null;
      const parsed = parseISODate(iso);
      if (parsed) state.month = startOfMonth(parsed);
      render();
    },
    getSelected() {
      return state.selected;
    },
    destroy() {
      root.innerHTML = "";
    },
  };
}

const pickers = new Map();
let openPickerId = null;
let sharedPanel = null;
let sharedCalendar = null;
let sharedCalendarApi = null;

function ensurePanel() {
  if (sharedPanel) return sharedPanel;
  sharedPanel = document.createElement("div");
  sharedPanel.className = "date-picker-panel";
  sharedPanel.hidden = true;
  sharedPanel.setAttribute("role", "dialog");
  sharedPanel.setAttribute("aria-label", "Choose a date");
  sharedCalendar = document.createElement("div");
  sharedPanel.appendChild(sharedCalendar);
  document.body.appendChild(sharedPanel);

  sharedPanel.addEventListener("click", (e) => e.stopPropagation());

  sharedCalendarApi = createCalendar(sharedCalendar, {
    onSelect(iso) {
      if (!openPickerId) return;
      const picker = pickers.get(openPickerId);
      if (!picker) return;
      picker.setValue(iso || "");
      closeDatePicker();
    },
  });

  document.addEventListener("click", () => closeDatePicker());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDatePicker();
  });
  window.addEventListener("resize", () => {
    if (openPickerId) positionPanel(openPickerId);
  });

  return sharedPanel;
}

function positionPanel(id) {
  const picker = pickers.get(id);
  const panel = ensurePanel();
  if (!picker || panel.hidden) return;
  const rect = picker.trigger.getBoundingClientRect();
  const width = Math.max(288, panel.offsetWidth || 288);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  let top = rect.bottom + 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${width}px`;
  // Flip above if needed after layout.
  requestAnimationFrame(() => {
    const h = panel.offsetHeight;
    if (rect.bottom + 8 + h > window.innerHeight - 8 && rect.top - 8 - h > 8) {
      panel.style.top = `${rect.top - h - 8}px`;
    }
  });
}

function closeDatePicker() {
  if (!sharedPanel) return;
  sharedPanel.hidden = true;
  if (openPickerId) {
    const picker = pickers.get(openPickerId);
    picker?.trigger.setAttribute("aria-expanded", "false");
  }
  openPickerId = null;
}

function openDatePicker(id) {
  ensurePanel();
  const picker = pickers.get(id);
  if (!picker) return;
  if (openPickerId && openPickerId !== id) {
    pickers.get(openPickerId)?.trigger.setAttribute("aria-expanded", "false");
  }
  openPickerId = id;
  sharedCalendarApi.setSelected(picker.input.value || null);
  sharedPanel.hidden = false;
  picker.trigger.setAttribute("aria-expanded", "true");
  positionPanel(id);
}

function syncPickerDisplay(picker) {
  const iso = picker.input.value;
  const label = formatDisplayDate(iso);
  if (label) {
    picker.valueEl.textContent = label;
    picker.valueEl.hidden = false;
    picker.placeholderEl.hidden = true;
    picker.trigger.classList.remove("is-empty");
    if (picker.clearBtn) picker.clearBtn.hidden = false;
  } else {
    picker.valueEl.textContent = "";
    picker.valueEl.hidden = true;
    picker.placeholderEl.hidden = false;
    picker.trigger.classList.add("is-empty");
    if (picker.clearBtn) picker.clearBtn.hidden = true;
  }
}

/**
 * Enhance a field that contains a hidden/text input#id with a calendar popover.
 * @param {string} inputId
 */
function attachDatePicker(inputId) {
  const input = document.getElementById(inputId);
  if (!input || pickers.has(inputId)) return pickers.get(inputId);

  const wrap = document.createElement("div");
  wrap.className = "date-picker";
  wrap.dataset.datePicker = inputId;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "date-picker-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `
    <span class="date-picker-value"></span>
    <span class="date-picker-placeholder">Pick a date</span>
    <span class="date-picker-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="2" y="3.5" width="12" height="10.5" rx="2"/>
        <path d="M2 6.5h12M5.5 2v3M10.5 2v3"/>
      </svg>
    </span>
  `;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "date-picker-clear";
  clearBtn.setAttribute("aria-label", "Clear date");
  clearBtn.hidden = true;
  clearBtn.innerHTML = `
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <path d="M4 4l8 8M12 4l-8 8"/>
    </svg>
  `;

  const parent = input.parentElement;
  input.type = "hidden";
  input.removeAttribute("required");
  parent.insertBefore(wrap, input);
  wrap.appendChild(input);
  wrap.appendChild(trigger);
  wrap.appendChild(clearBtn);

  const picker = {
    id: inputId,
    input,
    wrap,
    trigger,
    clearBtn,
    valueEl: trigger.querySelector(".date-picker-value"),
    placeholderEl: trigger.querySelector(".date-picker-placeholder"),
    setValue(iso) {
      input.value = iso || "";
      syncPickerDisplay(picker);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    sync() {
      syncPickerDisplay(picker);
    },
  };

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent("goplus:close-overlays"));
    if (openPickerId === inputId && sharedPanel && !sharedPanel.hidden) {
      closeDatePicker();
    } else {
      openDatePicker(inputId);
    }
  });

  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openPickerId === inputId) closeDatePicker();
    picker.setValue("");
  });

  pickers.set(inputId, picker);
  syncPickerDisplay(picker);
  return picker;
}

function setupDatePickers(ids = ["fromDate", "toDate"]) {
  for (const id of ids) attachDatePicker(id);
}

function refreshDatePickers(ids = ["fromDate", "toDate"]) {
  for (const id of ids) {
    const picker = pickers.get(id) || attachDatePicker(id);
    picker?.sync();
  }
}

function setDatePickerValue(id, iso) {
  const picker = pickers.get(id) || attachDatePicker(id);
  if (!picker) return;
  picker.input.value = iso || "";
  picker.sync();
}

export {
  createCalendar,
  setupDatePickers,
  refreshDatePickers,
  setDatePickerValue,
  formatDisplayDate,
  toISODate,
  parseISODate,
};
