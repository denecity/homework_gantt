/* ── Homework Gantt ── */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_VISIBLE_DAYS = 10;
const REPEAT_INTERVAL_MS = 7 * MS_PER_DAY;
const TICK_MS = 60_000;
const INSTANCE_REFRESH_MS = 60 * 1000;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const TOOLTIP_HIDE_MS = 400;
const LOCAL_DONE_KEY = "homework_done_map_local_v1";
const LOCAL_ZOOM_KEY = "homework_zoom_v1";
const LOCAL_OFFSET_KEY = "homework_offset_v1";
const LOCAL_THEME_KEY = "homework_theme_v1";
const COLLAPSED_KEY = "homework_collapsed_v1";
const LOCAL_STATS_KEY = "homework_stats_v1";
const UNDO_MAX = 200;
const PINCH_ZOOM_SENSITIVITY = 0.002;
const PINCH_DIST_THRESHOLD = 40;
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

/* ── Urgency thresholds ── */
const URGENT_IM_MS = 24 * 60 * 60 * 1000;
const URGENT_SOON_MS = 2 * 24 * 60 * 60 * 1000;
const NOTIFY_THRESHOLD_MS = 2 * 60 * 60 * 1000; /* notify if ≤2h before deadline */

/* ── Panning ── */
const PAN_STEP_MS = 2 * MS_PER_DAY;
const PAN_SMALL_MS = 1 * MS_PER_DAY;
const MAX_PAN_MS = 90 * MS_PER_DAY;
const PAN_MOMENTUM_DECAY = 0.92;
const PAN_VELOCITY_THRESHOLD = 0.3;

/* ── DOM refs ── */
const axisLane = document.getElementById("axisLane");
const rowsEl = document.getElementById("rows");
const chartEl = document.getElementById("chart");
const statusText = document.getElementById("statusText");
const retryBtn = document.getElementById("retryBtn");
const searchInput = document.getElementById("searchInput");
const summaryEl = document.getElementById("summary");
const zoomBtns = document.querySelectorAll(".zoom-btn");
const panLeftBtn = document.getElementById("panLeftBtn");
const panRightBtn = document.getElementById("panRightBtn");
const todayBtn = document.getElementById("todayBtn");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");
const addBtn = document.getElementById("addBtn");
const addModal = document.getElementById("addModal");
const addForm = document.getElementById("addForm");
const helpModal = document.getElementById("helpModal");
const themeToggle = document.getElementById("themeToggle");
const skeletonEl = document.getElementById("skeleton");
const markAllDoneBtn = document.getElementById("markAllDoneBtn");
const markAllUndoneBtn = document.getElementById("markAllUndoneBtn");
const dateJumpInput = document.getElementById("dateJumpInput");
const icsExportBtn = document.getElementById("icsExportBtn");
let contextMenuEl = null;

/* ── Global tooltip ── */
let tooltipEl = null;
let tooltipHideTimer = null;

function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(evt, instance) {
  clearTimeout(tooltipHideTimer);
  const tip = ensureTooltip();
  const nowMs = Date.now();
  const remainingMs = instance.deadlineMs - nowMs;
  const isPast = remainingMs < 0;
  const absRemainingMs = Math.abs(remainingMs);

  const days = Math.floor(absRemainingMs / MS_PER_DAY);
  const hours = Math.floor((absRemainingMs % MS_PER_DAY) / (60 * 60 * 1000));
  const mins = Math.floor((absRemainingMs % (60 * 60 * 1000)) / (60 * 1000));

  let relative;
  if (days > 0) {
    relative = `${days}d ${hours}h`;
  } else if (hours > 0) {
    relative = `${hours}h ${mins}m`;
  } else {
    relative = `${mins}m`;
  }

  const dl = new Date(instance.deadlineMs);
  const dlStr = dl.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const urgencyCls = isPast ? "tt-urgent" : "";

  tip.innerHTML = [
    `<strong>${escapeHtml(instance.lecture)}</strong>`,
    `<span class="tt-detail">Deadline: ${dlStr}</span>`,
    `<span class="${urgencyCls}">${isPast ? "Overdue by " : "Due in "}${relative}</span>`,
  ].join("");

  const rect = evt.currentTarget.getBoundingClientRect();
  let left = rect.left + rect.width / 2;
  let top = rect.top - tip.offsetHeight - 8;

  if (top < 4) top = rect.bottom + 8;
  if (left + tip.offsetWidth / 2 > window.innerWidth - 8) left = window.innerWidth - tip.offsetWidth / 2 - 8;
  if (left - tip.offsetWidth / 2 < 8) left = tip.offsetWidth / 2 + 8;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.display = "block";
}

function hideTooltip() {
  tooltipHideTimer = setTimeout(() => {
    if (tooltipEl) tooltipEl.style.display = "none";
  }, TOOLTIP_HIDE_MS);
}

/* ── State ── */
const state = {
  assignments: [],
  instances: [],
  doneMap: {},
  rowRefs: [],
  persistenceMode: "unknown",
  lastInstanceBuildMs: 0,
  lastConfigFetchMs: 0,
  visibleDays: DEFAULT_VISIBLE_DAYS,
  searchFilter: "",
  online: navigator.onLine,
  tickerId: null,
  windowOffsetMs: 0,
  undoStack: [],
  redoStack: [],
  notificationsGranted: false,
  lastNotifyTime: 0,
  collapsedGroups: new Set(),
  pinchDist0: 0,
  pinchZoom0: 0,
};

/* ── Helpers ── */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showStatus(message) {
  statusText.textContent = message || "";
  retryBtn.classList.toggle("hidden", !message);
}

function getWindowCenter() {
  return Date.now() + state.windowOffsetMs;
}

function getHalfWindow() {
  return (state.visibleDays / 2) * MS_PER_DAY;
}

/* ── Local storage helpers ── */

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function readLocalDoneMap() {
  return readLocal(LOCAL_DONE_KEY, {});
}

function writeLocalDoneMap(map) {
  writeLocal(LOCAL_DONE_KEY, map);
}

function readLocalZoom() {
  const v = readLocal(LOCAL_ZOOM_KEY, DEFAULT_VISIBLE_DAYS);
  return [5, 10, 14].includes(v) ? v : DEFAULT_VISIBLE_DAYS;
}

function writeLocalZoom(days) {
  writeLocal(LOCAL_ZOOM_KEY, days);
}

function readLocalOffset() {
  const v = readLocal(LOCAL_OFFSET_KEY, 0);
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.max(-MAX_PAN_MS, Math.min(MAX_PAN_MS, v));
}

function writeLocalOffset(offsetMs) {
  writeLocal(LOCAL_OFFSET_KEY, offsetMs);
}

function readLocalTheme() {
  const v = readLocal(LOCAL_THEME_KEY, "dark");
  return v === "light" ? "light" : "dark";
}

function writeLocalTheme(theme) {
  writeLocal(LOCAL_THEME_KEY, theme);
}

/* ── Undo / Redo ── */

function pushUndo(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_MAX) state.undoStack.shift();
  state.redoStack = [];
}

function performUndo() {
  if (!state.undoStack.length) return false;
  const entry = state.undoStack.pop();
  state.redoStack.push(entry);
  applyToggle(entry.instanceId, entry.doneKey, entry.wasDone, /* pushUndo= */ false);
  return true;
}

function performRedo() {
  if (!state.redoStack.length) return false;
  const entry = state.redoStack.pop();
  state.undoStack.push(entry);
  applyToggle(entry.instanceId, entry.doneKey, !entry.wasDone, /* pushUndo= */ false);
  return true;
}

/* ── Mark all visible ── */
function markAllVisible(toDone) {
  const rows = rowsEl.querySelectorAll(".row-lane:not(.group-collapsed)");
  let changed = 0;
  rows.forEach((row) => {
    const bars = row.querySelectorAll(".bar");
    bars.forEach((bar) => {
      const inst = bar._instance;
      if (!inst) return;
      const doneKey = inst.id + "|" + inst.doneKeySuffix;
      if (state.doneMap[doneKey] !== toDone) {
        state.doneMap[doneKey] = toDone;
        setDoneVisual(bar, toDone);
        changed++;
      }
    });
  });
  if (changed) {
    writeLocalDoneMap(state.doneMap);
    updateSummary();
    updateTitleBadge();
    renderBars(getWindowCenter()); // refresh urgency
  }
}

/* ── Group collapse ── */
function toggleGroupCollapse(groupName) {
  let collapsed = readLocalCollapsed();
  if (collapsed[groupName]) {
    delete collapsed[groupName];
  } else {
    collapsed[groupName] = true;
  }
  writeLocal(COLLAPSED_KEY, collapsed);
  refreshAllGroupsCollapse();
}

function readLocalCollapsed() {
  return readLocal(COLLAPSED_KEY, {});
}

function refreshAllGroupsCollapse() {
  const collapsed = readLocalCollapsed();
  const headers = rowsEl.querySelectorAll(".group-header");
  headers.forEach((h) => {
    const name = h.dataset.group;
    if (collapsed[name]) {
      h.classList.add("collapsed");
    } else {
      h.classList.remove("collapsed");
    }
  });
  const rowLanes = rowsEl.querySelectorAll(".row-lane");
  rowLanes.forEach((rl) => {
    const group = rl.dataset.group;
    if (collapsed[group]) {
      rl.classList.add("group-collapsed");
    } else {
      rl.classList.remove("group-collapsed");
    }
  });
}

function collapseAllGroups() {
  const collapsed = readLocalCollapsed();
  const allCollapsed = Object.keys(collapsed).length > 0 &&
    Object.values(collapsed).every(Boolean);
  const newState = {};
  if (!allCollapsed) {
    // collapse everything
    const groups = new Set();
    state.assignments.forEach((a) => { if (a.group) groups.add(a.group); });
    groups.forEach((g) => { newState[g] = true; });
  }
  writeLocal(COLLAPSED_KEY, newState);
  refreshAllGroupsCollapse();
}

/* ── Date jump ── */
function jumpToDate(dateStr) {
  if (!dateStr) return;
  const target = new Date(dateStr + "T12:00:00").getTime();
  const offset = target - Date.now();
  state.windowOffsetMs = Math.max(-MAX_PAN_MS, Math.min(MAX_PAN_MS, offset));
  writeLocalOffset(state.windowOffsetMs);
  state.lastInstanceBuildMs = 0;
  const c = getWindowCenter();
  refreshInstances(c, true);
  renderBars(c);
  updateTodayButton();
}

/* ── ICS / iCal export ── */
function exportICS() {
  const now = new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Homework Gantt//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  state.flatInstances.forEach((inst) => {
    const doneKey = inst.id + "|" + inst.doneKeySuffix;
    if (state.doneMap[doneKey]) return; // skip done
    const dtStart = toICSDate(new Date(inst.releaseMs));
    const dtEnd = toICSDate(new Date(inst.deadlineMs));
    const uid = inst.id + "@gantt";
    const summary = `${inst.courseCode}: ${inst.title}`;
    lines.push(
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${summary}`,
      `UID:${uid}`,
      `DTSTAMP:${toICSDate(now)}`,
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  downloadBlob(blob, `homework-${toICSDate(now)}.ics`);
}

function toICSDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Right-click context menu ── */
function showContextMenu(e, instance) {
  hideContextMenu();
  contextMenuEl = document.createElement("div");
  contextMenuEl.className = "context-menu open";
  const doneKey = instance.id + "|" + instance.doneKeySuffix;
  const isDone = !!state.doneMap[doneKey];
  contextMenuEl.innerHTML = [
    `<div class="context-menu-item" data-action="toggle">${isDone ? "Mark Undone" : "Mark Done"}</div>`,
    `<div class="context-menu-item" data-action="markall">Mark All Visible ${isDone ? "Undone" : "Done"}</div>`,
    `<div class="context-menu-item" data-action="pan">Center Here</div>`,
  ].join("");

  contextMenuEl.addEventListener("click", (ev) => {
    const action = ev.target.dataset.action;
    if (action === "toggle") {
      const bar = document.querySelector(`.bar[data-id="${CSS.escape(instance.id)}"]`);
      if (bar) toggleBar(instance, bar);
    } else if (action === "markall") {
      markAllVisible(!isDone);
    } else if (action === "pan") {
      state.windowOffsetMs = instance.deadlineMs - Date.now();
      writeLocalOffset(state.windowOffsetMs);
      const c = getWindowCenter();
      renderBars(c);
      updateTodayButton();
    }
    hideContextMenu();
  });

  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 120);
  contextMenuEl.style.left = x + "px";
  contextMenuEl.style.top = y + "px";
  document.body.appendChild(contextMenuEl);

  const close = (ev) => {
    if (!contextMenuEl.contains(ev.target)) {
      hideContextMenu();
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

/* ── Shift+click range toggle ── */
function rangeToggle(firstId, secondId) {
  const bars = [...chartEl.querySelectorAll(".bar")];
  const idx1 = bars.findIndex((b) => b._instance?.id === firstId);
  const idx2 = bars.findIndex((b) => b._instance?.id === secondId);
  if (idx1 < 0 || idx2 < 0) return;
  const [lo, hi] = [Math.min(idx1, idx2), Math.max(idx1, idx2)];
  const targetDone = !state.doneMap[bars[lo]._instance.doneKey];
  let changed = 0;
  for (let i = lo; i <= hi; i++) {
    const bar = bars[i];
    const inst = bar._instance;
    if (!inst) continue;
    if (!!state.doneMap[inst.doneKey] !== targetDone) {
      state.doneMap[inst.doneKey] = targetDone;
      setDoneVisual(bar, targetDone);
      changed++;
    }
  }
  if (changed) {
    writeLocalDoneMap(state.doneMap);
    updateSummary();
    updateTitleBadge();
    renderBars(getWindowCenter());
    trackCompletionStats();
  }
}

/* ── Pinch zoom ── */
function handlePinchStart(e) {
  if (e.touches.length !== 2) return;
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  state.pinchDist0 = Math.sqrt(dx * dx + dy * dy);
  state.pinchZoom0 = state.visibleDays;
}

function handlePinchMove(e) {
  if (e.touches.length !== 2 || !state.pinchDist0) return;
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(dist - state.pinchDist0) < PINCH_DIST_THRESHOLD) return;
  const scale = dist / state.pinchDist0;
  const newDays = Math.round(state.pinchZoom0 * scale);
  const clamped = Math.max(3, Math.min(30, newDays));
  if (clamped !== state.visibleDays) {
    state.visibleDays = clamped;
    writeLocalZoom(clamped);
    updateZoomButtons();
    state.lastInstanceBuildMs = 0;
    const c = getWindowCenter();
    refreshInstances(c, true);
    renderBars(c);
  }
}

function handlePinchEnd() {
  state.pinchDist0 = 0;
}

/* ── Completion stats ── */
function trackCompletionStats() {
  const total = state.flatInstances.length;
  if (!total) return;
  let done = 0;
  state.flatInstances.forEach((inst) => {
    const dk = inst.id + "|" + inst.doneKeySuffix;
    if (state.doneMap[dk]) done++;
  });
  const today = new Date().toISOString().slice(0, 10);
  const stats = readLocal(LOCAL_STATS_KEY, {});
  stats[today] = { total, done, pct: Math.round((done / total) * 100) };
  // keep last 90 days
  const keys = Object.keys(stats).sort();
  while (keys.length > 90) delete stats[keys.shift()];
  writeLocal(LOCAL_STATS_KEY, stats);
}

/* ── Apply toggle (modified to track stats) ── */
function applyToggle(instanceId, doneKey, done, pushUndoFlag = true) {
  state.doneMap[doneKey] = done;
  writeLocalDoneMap(state.doneMap);

  /* update bar visuals */
  for (const row of state.rowRefs) {
    for (const entry of row.bars) {
      if (entry.instance.instanceId === instanceId) {
        setDoneVisual(entry.bar, done);
      }
    }
  }

  updateSummary();
  updateTitleBadge();

  if (state.persistenceMode === "remote") {
    saveDoneState(doneKey, done).catch(() => {});
  }
}

/* ── Parsing ── */

function sanitizeHexColor(value) {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color) ? color : null;
}

function sanitizeAssignmentLink(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch { return null; }
}

function parseAssignments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const releaseMs = new Date(item.release).getTime();
      const deadlineMs = new Date(item.deadline).getTime();
      if (!item.id || Number.isNaN(releaseMs) || Number.isNaN(deadlineMs)) return null;
      const startMs = Math.min(releaseMs, deadlineMs);
      const endMs = Math.max(releaseMs, deadlineMs);
      return {
        id: String(item.id),
        lecture: String(item.lecture || item.title || item.id),
        group: item.group ? String(item.group) : null,
        releaseMs: startMs,
        deadlineMs: endMs,
        repeatWeekly: Boolean(item.repeatWeekly || item.weeklyRepeat),
        color: sanitizeHexColor(item.color),
        link: sanitizeAssignmentLink(item.link),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.releaseMs - b.releaseMs);
}

/* ── Positioning ── */

function xForTime(ms, centerMs, width) {
  const half = getHalfWindow();
  const progress = (ms - (centerMs - half)) / (state.visibleDays * MS_PER_DAY);
  return progress * width;
}

function overlapsWindow(startMs, endMs, windowStart, windowEnd) {
  return endMs >= windowStart && startMs <= windowEnd;
}

/* ── Instance building ── */

function buildInstance(assignment, releaseMs, deadlineMs, repeatIndex) {
  const doneKey = assignment.repeatWeekly ? `${assignment.id}::${repeatIndex}` : assignment.id;
  return {
    instanceId: `${assignment.id}@${repeatIndex}`,
    assignmentId: assignment.id,
    doneKey,
    lecture: assignment.lecture,
    color: assignment.color,
    link: assignment.link,
    group: assignment.group,
    releaseMs,
    deadlineMs,
    repeatWeekly: assignment.repeatWeekly,
  };
}

function expandAssignmentsForWindow(assignments, centerMs) {
  const half = getHalfWindow();
  const windowStart = centerMs - half;
  const windowEnd = centerMs + half;
  const instances = [];

  for (const assignment of assignments) {
    if (state.searchFilter && !assignment.lecture.toLowerCase().includes(state.searchFilter)) {
      continue;
    }

    if (!assignment.repeatWeekly) {
      if (overlapsWindow(assignment.releaseMs, assignment.deadlineMs, windowStart, windowEnd)) {
        instances.push(buildInstance(assignment, assignment.releaseMs, assignment.deadlineMs, 0));
      }
      continue;
    }

    const kMin = Math.ceil((windowStart - assignment.deadlineMs) / REPEAT_INTERVAL_MS);
    const kMax = Math.floor((windowEnd - assignment.releaseMs) / REPEAT_INTERVAL_MS);

    for (let repeatIndex = kMin; repeatIndex <= kMax; repeatIndex += 1) {
      const releaseMs = assignment.releaseMs + repeatIndex * REPEAT_INTERVAL_MS;
      const deadlineMs = assignment.deadlineMs + repeatIndex * REPEAT_INTERVAL_MS;
      if (overlapsWindow(releaseMs, deadlineMs, windowStart, windowEnd)) {
        instances.push(buildInstance(assignment, releaseMs, deadlineMs, repeatIndex));
      }
    }
  }

  return instances.sort((a, b) => {
    if (a.releaseMs !== b.releaseMs) return a.releaseMs - b.releaseMs;
    return a.lecture.localeCompare(b.lecture);
  });
}

/* ── Urgency classes ── */

function urgencyClass(instance, done) {
  if (done) return "";
  const nowMs = Date.now();
  const remaining = instance.deadlineMs - nowMs;
  if (remaining < 0) return "overdue";
  if (remaining < URGENT_IM_MS) return "urgency-imminent";
  if (remaining < URGENT_SOON_MS) return "urgency-soon";
  return "";
}

/* ── Title badge ── */

function updateTitleBadge() {
  let overdue = 0;
  const nowMs = Date.now();
  for (const instance of state.instances) {
    if (!state.doneMap[instance.doneKey] && instance.deadlineMs < nowMs) {
      overdue++;
    }
  }
  document.title = overdue > 0 ? `(${overdue}) Homework Gantt` : "Homework Gantt";
}

/* ── Bars ── */

function setDoneVisual(bar, done) {
  bar.classList.toggle("done", done);
  bar.classList.remove("urgency-soon", "urgency-imminent", "overdue");
  bar.setAttribute("aria-pressed", done ? "true" : "false");
}

function updateUrgencyVisual(bar, instance) {
  const done = Boolean(state.doneMap[instance.doneKey]);
  bar.classList.remove("urgency-soon", "urgency-imminent", "overdue");
  if (!done) {
    const cls = urgencyClass(instance, false);
    if (cls) bar.classList.add(cls);
  }
}

/* ── Bar stacking: detect overlap and assign levels ── */

function computeStackLevels(instances) {
  const levels = new Map(); /* instanceId -> level */
  const sorted = [...instances].sort((a, b) => a.releaseMs - b.releaseMs);
  const active = []; /* { instanceId, endMs } */

  for (const inst of sorted) {
    /* remove ended bars */
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endMs <= inst.releaseMs) active.splice(i, 1);
    }
    /* find first free level */
    let level = 0;
    while (active.some((a) => a.level === level)) level++;
    active.push({ instanceId: inst.instanceId, endMs: inst.deadlineMs, level });
    levels.set(inst.instanceId, level);
  }

  const maxLevel = active.reduce((m, a) => Math.max(m, a.level), 0);
  return { levels, maxLevel };
}

/* ── Bar toggle ── */

async function toggleBar(instance, bar) {
  if (bar.dataset.busy === "true") return;

  const wasDone = Boolean(state.doneMap[instance.doneKey]);
  const done = !wasDone;

  bar.dataset.busy = "true";
  bar.setAttribute("aria-disabled", "true");

  pushUndo({ instanceId: instance.instanceId, doneKey: instance.doneKey, wasDone });
  applyToggle(instance.instanceId, instance.doneKey, done, /* pushUndo= */ false);

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(done ? [15, 30, 15] : [10]);

  // Checkmark animation
  if (done) {
    bar.classList.add("just-done");
    bar.addEventListener("animationend", () => bar.classList.remove("just-done"), { once: true });
  }

  try {
    await saveDoneState(instance.doneKey, done);
    if (state.persistenceMode === "remote") {
      showStatus("");
    } else {
      showStatus("Saved on this device only. Cloud sync is unavailable.");
    }
  } catch {
    state.persistenceMode = "local";
    showStatus(`Saved "${instance.lecture}" locally only. Cloud sync is unavailable.`);
  } finally {
    delete bar.dataset.busy;
    bar.removeAttribute("aria-disabled");
  }
  trackCompletionStats();
}

function createBar(instance, stackLevel, maxLevel) {
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "button");
  bar.tabIndex = 0;
  bar.title = "";

  const label = document.createElement("span");
  label.className = "bar-label";

  if (instance.link) {
    const link = document.createElement("a");
    link.className = "bar-link";
    link.href = instance.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = instance.link;
    link.textContent = instance.lecture;
    link.addEventListener("click", (event) => event.stopPropagation());
    label.appendChild(link);
  } else {
    label.textContent = instance.lecture;
  }

  if (instance.color) {
    bar.style.setProperty("--bar-color", instance.color);
  }

  /* stacking */
  if (stackLevel > 0) {
    const rowHeight = 52;
    const barHeight = 14;
    bar.style.setProperty("--stack-level", stackLevel);
    bar.style.setProperty("--stack-max-level", maxLevel || stackLevel);
  }

  bar.appendChild(label);

  bar.addEventListener("mouseenter", (e) => {
    clearTimeout(tooltipHideTimer);
    showTooltip(e, instance);
  });
  bar.addEventListener("mouseleave", hideTooltip);
  bar.addEventListener("click", () => toggleBar(instance, bar));
  bar.addEventListener("keydown", (event) => {
    if (event.target !== bar) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleBar(instance, bar);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      navigateBar(event.key === "ArrowRight" ? 1 : -1);
    }
  });

  const done = Boolean(state.doneMap[instance.doneKey]);
  setDoneVisual(bar, done);
  if (!done) {
    const cls = urgencyClass(instance, false);
    if (cls) bar.classList.add(cls);
  }

  return { instance, bar };
}

/* ── Keyboard navigation ── */

function navigateBar(direction) {
  const allBars = [...rowsEl.querySelectorAll(".bar")];
  const idx = allBars.indexOf(document.activeElement);
  if (idx === -1) return;
  const nextIdx = (idx + direction + allBars.length) % allBars.length;
  allBars[nextIdx].focus();
}

/* ── Row building ── */

function createRow(instances) {
  const lane = document.createElement("div");
  lane.className = "row-lane";

  const decoration = document.createElement("div");
  decoration.className = "lane-decoration";

  /* group label */
  const group = instances[0]?.group;
  if (group) {
    lane.setAttribute("data-group", group);
    const label = document.createElement("span");
    label.className = "row-group-label";
    label.textContent = group;
    lane.appendChild(label);
  }

  /* bar stacking */
  const { levels, maxLevel } = computeStackLevels(instances);
  if (maxLevel > 0) {
    /* expand row height */
    const extraRows = maxLevel;
    const rowHeight = 52 + extraRows * 18;
    lane.style.setProperty("--row-height", `${rowHeight}px`);
    lane.style.minHeight = `${rowHeight}px`;
  }

  const bars = instances.map((inst) => {
    const level = levels.get(inst.instanceId) || 0;
    return createBar(inst, level, maxLevel);
  });

  lane.append(decoration, ...bars.map((entry) => entry.bar));
  rowsEl.appendChild(lane);
  return { lane, decoration, bars };
}

/* ── Decorations ── */

function renderDayDecoration(container, centerMs, width, withLabels) {
  container.innerHTML = "";
  const half = getHalfWindow();
  const windowStart = centerMs - half;
  const windowEnd = centerMs + half;
  const firstDay = new Date(windowStart);
  firstDay.setHours(0, 0, 0, 0);
  const nowMs = Date.now();

  for (let dayStartMs = firstDay.getTime(); dayStartMs <= windowEnd + MS_PER_DAY; dayStartMs += MS_PER_DAY) {
    const dayEndMs = dayStartMs + MS_PER_DAY;
    const left = xForTime(dayStartMs, centerMs, width);
    const right = xForTime(dayEndMs, centerMs, width);
    const visibleLeft = Math.max(0, left);
    const visibleRight = Math.min(width, right);
    const dayOfWeek = new Date(dayStartMs).getDay();

    /* weekend bands */
    if ((dayOfWeek === 0 || dayOfWeek === 6) && visibleRight > visibleLeft) {
      const weekendBand = document.createElement("div");
      weekendBand.className = "weekend-band";
      weekendBand.style.left = `${visibleLeft}px`;
      weekendBand.style.width = `${visibleRight - visibleLeft}px`;
      container.appendChild(weekendBand);
    }

    /* day tick */
    if (left >= 0 && left <= width) {
      const dayTick = document.createElement("div");
      dayTick.className = "day-tick";
      dayTick.style.left = `${left}px`;
      container.appendChild(dayTick);
    }

    /* today marker */
    const todayStart = new Date(nowMs);
    todayStart.setHours(0, 0, 0, 0);
    if (dayStartMs === todayStart.getTime() && withLabels) {
      const todayLine = document.createElement("div");
      todayLine.className = "today-line";
      todayLine.style.left = `${xForTime(nowMs, centerMs, width)}px`;
      container.appendChild(todayLine);
    }

    /* labels */
    if (withLabels) {
      const middle = (left + right) / 2;
      if (middle >= -20 && middle <= width + 20) {
        const label = document.createElement("div");
        label.className = "tick-label";
        if (dayStartMs === todayStart.getTime()) {
          label.classList.add("today-label");
        }
        label.style.left = `${middle}px`;
        label.textContent = new Date(dayStartMs).toLocaleDateString([], { weekday: "short" });
        container.appendChild(label);
      }
    }
  }
}

/* ── Summary stats ── */

function updateSummary() {
  let pending = 0, overdue = 0, done = 0;

  for (const row of state.rowRefs) {
    for (const entry of row.bars) {
      if (state.doneMap[entry.instance.doneKey]) {
        done++;
        continue;
      }
      if (entry.instance.deadlineMs < Date.now()) {
        overdue++;
      } else {
        pending++;
      }
    }
  }

  const parts = [];
  if (overdue > 0) parts.push(`<span class="stat"><span class="stat-dot overdue"></span> ${overdue} overdue</span>`);
  if (pending > 0) parts.push(`<span class="stat"><span class="stat-dot warning"></span> ${pending} pending</span>`);
  if (done > 0 && (overdue + pending === 0)) {
    parts.push(`<span class="stat"><span class="stat-dot done"></span> ${done} done</span>`);
  }
  if (parts.length === 0 && state.instances.length === 0) {
    parts.push(`<span class="stat">${state.searchFilter ? "No matches" : "No assignments in view"}</span>`);
  }
  summaryEl.innerHTML = parts.join("");

  updateTitleBadge();
}

/* ── Render ── */

function renderAxis(centerMs, width) {
  renderDayDecoration(axisLane, centerMs, width, true);
}

function renderBars(centerMs) {
  if (!state.rowRefs.length) {
    axisLane.innerHTML = "";
    return;
  }

  const width = axisLane.clientWidth || state.rowRefs[0].lane.clientWidth;
  if (!width) return;

  window.requestAnimationFrame(() => {
    renderAxis(centerMs, width);
    for (const row of state.rowRefs) {
      renderDayDecoration(row.decoration, centerMs, width, false);
      for (const entry of row.bars) {
        const left = xForTime(entry.instance.releaseMs, centerMs, width);
        const right = xForTime(entry.instance.deadlineMs, centerMs, width);
        const clampedLeft = Math.max(0, Math.min(width, left));
        const clampedRight = Math.max(0, Math.min(width, right));
        const barWidth = Math.max(10, clampedRight - clampedLeft);

        entry.bar.style.left = `${clampedLeft}px`;
        entry.bar.style.width = `${barWidth}px`;
        entry.bar.style.opacity = right < 0 || left > width ? "0.35" : "1";

        /* text visibility: hide label if bar is too narrow */
        const labelEl = entry.bar.querySelector(".bar-label");
        if (labelEl) {
          labelEl.style.display = barWidth < 36 ? "none" : "";
        }
      }
    }
  });
}

/* ── Row rebuild ── */

function sameInstanceList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].instanceId !== b[i].instanceId ||
      a[i].releaseMs !== b[i].releaseMs ||
      a[i].deadlineMs !== b[i].deadlineMs
    ) return false;
  }
  return true;
}

function buildRows() {
  rowsEl.innerHTML = "";
  state.rowRefs = [];
  const instancesByAssignment = new Map();

  for (const instance of state.instances) {
    if (!instancesByAssignment.has(instance.assignmentId)) {
      instancesByAssignment.set(instance.assignmentId, []);
    }
    instancesByAssignment.get(instance.assignmentId).push(instance);
  }

  const sortedAssignments = [...state.assignments].sort((a, b) => {
    const ga = a.group || "";
    const gb = b.group || "";
    if (ga !== gb) return ga.localeCompare(gb);
    return a.releaseMs - b.releaseMs;
  });

  for (const assignment of sortedAssignments) {
    const grouped = instancesByAssignment.get(assignment.id);
    if (!grouped || !grouped.length) continue;
    grouped.sort((a, b) => a.releaseMs - b.releaseMs);
    state.rowRefs.push(createRow(grouped));
  }

  updateSummary();
}

function refreshInstances(centerMs, force = false) {
  if (!force && centerMs - state.lastInstanceBuildMs < INSTANCE_REFRESH_MS) return;
  const nextInstances = expandAssignmentsForWindow(state.assignments, centerMs);
  if (!sameInstanceList(nextInstances, state.instances)) {
    state.instances = nextInstances;
    buildRows();
  }
  state.lastInstanceBuildMs = centerMs;
}

/* ── Urgency refresh ── */

function refreshUrgency() {
  for (const row of state.rowRefs) {
    for (const entry of row.bars) {
      updateUrgencyVisual(entry.bar, entry.instance);
    }
  }
}

/* ── Panning ── */

function applyOffset(deltaMs) {
  const next = state.windowOffsetMs + deltaMs;
  state.windowOffsetMs = Math.max(-MAX_PAN_MS, Math.min(MAX_PAN_MS, next));
  writeLocalOffset(state.windowOffsetMs);
  updateTodayButton();
}

function panToToday(animate = true) {
  if (state.windowOffsetMs === 0) return;
  if (animate) {
    const startOffset = state.windowOffsetMs;
    const startTime = performance.now();
    const duration = 300;

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      state.windowOffsetMs = Math.round(startOffset * (1 - eased));
      const center = getWindowCenter();
      state.lastInstanceBuildMs = 0;
      refreshInstances(center, true);
      renderBars(center);
      updateTodayButton();
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        state.windowOffsetMs = 0;
        writeLocalOffset(0);
        updateTodayButton();
      }
    }
    requestAnimationFrame(step);
  } else {
    state.windowOffsetMs = 0;
    writeLocalOffset(0);
    updateTodayButton();
    const center = getWindowCenter();
    state.lastInstanceBuildMs = 0;
    refreshInstances(center, true);
    renderBars(center);
  }
}

function updateTodayButton() {
  todayBtn.classList.toggle("active", state.windowOffsetMs === 0);
}

/* ── Drag panning ── */

let dragState = null;
let dragLastRebuildOffset = 0;

function startDrag(e) {
  if (e.target.closest(".bar, button, a, input")) return;
  e.preventDefault();

  dragState = {
    startX: e.type === "touchstart" ? e.touches[0].clientX : e.clientX,
    startOffset: state.windowOffsetMs,
    lastX: e.type === "touchstart" ? e.touches[0].clientX : e.clientX,
    lastTime: performance.now(),
    velocity: 0,
    rafId: null,
  };
  dragLastRebuildOffset = state.windowOffsetMs;

  chartEl.setAttribute("data-dragging", "true");
  chartEl.style.cursor = "grabbing";
}

function moveDrag(e) {
  if (!dragState) return;
  e.preventDefault();

  const clientX = e.type === "touchmove" ? e.touches[0].clientX : e.clientX;
  const now = performance.now();
  const dx = clientX - dragState.lastX;
  const dt = now - dragState.lastTime;
  dragState.velocity = dt > 0 ? dx / dt : 0;
  dragState.lastX = clientX;
  dragState.lastTime = now;

  const width = axisLane.clientWidth;
  if (!width) return;

  const totalDeltaX = dragState.startX - clientX;
  const deltaMs = (totalDeltaX / width) * state.visibleDays * MS_PER_DAY;
  state.windowOffsetMs = dragState.startOffset + deltaMs;
  state.windowOffsetMs = Math.max(-MAX_PAN_MS, Math.min(MAX_PAN_MS, state.windowOffsetMs));

  const center = getWindowCenter();

  if (Math.abs(state.windowOffsetMs - dragLastRebuildOffset) > MS_PER_DAY) {
    dragLastRebuildOffset = state.windowOffsetMs;
    state.lastInstanceBuildMs = 0;
    refreshInstances(center, true);
  }

  renderBars(center);
}

function endDrag(e) {
  if (!dragState) return;

  chartEl.removeAttribute("data-dragging");
  chartEl.style.cursor = "";

  const velocity = dragState.velocity;
  const width = axisLane.clientWidth || 800;

  if (Math.abs(velocity) > PAN_VELOCITY_THRESHOLD) {
    const momentumMs = -(velocity / width) * state.visibleDays * MS_PER_DAY;
    let remaining = momentumMs;

    function momentumStep() {
      remaining *= PAN_MOMENTUM_DECAY;
      if (Math.abs(remaining) < MS_PER_DAY / 4) {
        writeLocalOffset(state.windowOffsetMs);
        updateTodayButton();
        const center = getWindowCenter();
        state.lastInstanceBuildMs = 0;
        refreshInstances(center, true);
        renderBars(center);
        return;
      }
      state.windowOffsetMs = Math.max(-MAX_PAN_MS, Math.min(MAX_PAN_MS, state.windowOffsetMs + Math.round(remaining)));
      const center = getWindowCenter();
      renderBars(center);
      requestAnimationFrame(momentumStep);
    }
    requestAnimationFrame(momentumStep);
  } else {
    writeLocalOffset(state.windowOffsetMs);
    updateTodayButton();
    const center = getWindowCenter();
    state.lastInstanceBuildMs = 0;
    refreshInstances(center, true);
    renderBars(center);
  }

  dragState = null;
}

/* ── Network ── */

async function fetchAssignments() {
  const response = await fetch("/config/homework.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Config fetch failed (${response.status})`);
  const data = await response.json();
  return parseAssignments(data.assignments);
}

async function fetchDoneMap() {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`Status fetch failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return data.done || {};
}

async function saveDoneState(id, done) {
  if (state.persistenceMode !== "remote") return;
  const response = await fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, done }),
  });
  if (!response.ok) throw new Error(`Status save failed (${response.status})`);
  const data = await response.json();
  state.doneMap = data.done || {};
  writeLocalDoneMap(state.doneMap);
}

/* ── Export ── */

function exportDoneState() {
  const payload = {
    exportedAt: new Date().toISOString(),
    assignments: state.assignments.map((a) => ({
      id: a.id,
      lecture: a.lecture,
      repeatWeekly: a.repeatWeekly,
    })),
    doneMap: state.doneMap,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `homework-done-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus("Done state exported.");
}

/* ── Import ── */

function importDoneState(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    if (!data || !data.doneMap || typeof data.doneMap !== "object") {
      throw new Error("Invalid format: missing doneMap");
    }

    let imported = 0;
    for (const [key, value] of Object.entries(data.doneMap)) {
      if (typeof value === "boolean") {
        state.doneMap[key] = value;
        imported++;
      }
    }

    writeLocalDoneMap(state.doneMap);
    state.undoStack = [];
    state.redoStack = [];

    /* re-render */
    state.lastInstanceBuildMs = 0;
    const center = getWindowCenter();
    refreshInstances(center, true);
    renderBars(center);

    showStatus(`Imported ${imported} done entries from file.`);
  } catch (err) {
    showStatus(`Import failed: ${err.message}`);
  }
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => importDoneState(reader.result);
  reader.onerror = () => showStatus("Failed to read import file.");
  reader.readAsText(file);
}

/* ── Quick-add ── */

function openAddModal() {
  /* default: release = now, deadline = 7 days from now */
  const now = new Date();
  const later = new Date(now.getTime() + 7 * MS_PER_DAY);
  addForm.elements.addId.value = "";
  addForm.elements.addName.value = "";
  addForm.elements.addRelease.value = now.toISOString().slice(0, 16);
  addForm.elements.addDeadline.value = later.toISOString().slice(0, 16);
  addForm.elements.addRepeat.value = "none";
  addForm.elements.addGroup.value = "";
  addForm.elements.addColor.value = "#3A86FF";
  addForm.elements.addLink.value = "";
  addModal.classList.add("open");
  addForm.elements.addId.focus();
}

function closeAddModal() {
  addModal.classList.remove("open");
}

function handleAddSubmit(e) {
  e.preventDefault();

  const id = addForm.elements.addId.value.trim();
  const name = addForm.elements.addName.value.trim();
  const release = new Date(addForm.elements.addRelease.value).getTime();
  const deadline = new Date(addForm.elements.addDeadline.value).getTime();
  const repeat = addForm.elements.addRepeat.value;
  const group = addForm.elements.addGroup.value.trim();
  const color = addForm.elements.addColor.value;
  const link = addForm.elements.addLink.value.trim();

  if (!id || !name || Number.isNaN(release) || Number.isNaN(deadline)) {
    showStatus("Please fill in all required fields.");
    return;
  }

  const startMs = Math.min(release, deadline);
  const endMs = Math.max(release, deadline);

  const assignment = {
    id,
    lecture: name,
    group: group || null,
    releaseMs: startMs,
    deadlineMs: endMs,
    repeatWeekly: repeat === "weekly",
    color: sanitizeHexColor(color),
    link: sanitizeAssignmentLink(link),
  };

  /* insert into state.assignments (sorted) */
  state.assignments.push(assignment);
  state.assignments.sort((a, b) => a.releaseMs - b.releaseMs);

  closeAddModal();

  state.lastInstanceBuildMs = 0;
  const center = getWindowCenter();
  refreshInstances(center, true);
  renderBars(center);

  showStatus(`Added "${name}". Refresh to persist manually added items from config.`);
}

/* ── Theme ── */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "light" ? "☀️" : "🌙";
  themeToggle.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  writeLocalTheme(next);
}

/* ── Notification permissions ── */

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    state.notificationsGranted = true;
    return;
  }
  const result = await Notification.requestPermission();
  state.notificationsGranted = result === "granted";
}

function maybeNotifyDeadlines() {
  if (!state.notificationsGranted || !("Notification" in window)) return;
  const now = Date.now();
  /* throttle: max one notification every 10 minutes */
  if (now - state.lastNotifyTime < 10 * 60 * 1000) return;

  const imminent = [];
  for (const instance of state.instances) {
    if (state.doneMap[instance.doneKey]) continue;
    const remaining = instance.deadlineMs - now;
    if (remaining > 0 && remaining < NOTIFY_THRESHOLD_MS) {
      imminent.push(instance);
    }
  }

  if (imminent.length === 0) return;

  state.lastNotifyTime = now;
  const names = imminent.map((i) => i.lecture).join(", ");
  new Notification("Homework deadline soon", {
    body: `${names} — due in less than 2 hours`,
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📅</text></svg>",
    tag: "homework-deadline",
  });
}

/* ── Help modal ── */

function toggleHelpModal() {
  const open = helpModal.classList.toggle("open");
  if (open && document.activeElement === document.body) {
    helpModal.querySelector("button")?.focus();
  }
}

/* ── Ticker ── */

let tickRafId = null;

function scheduleTick() {
  if (tickRafId) cancelAnimationFrame(tickRafId);
  tickRafId = requestAnimationFrame(() => {
    const center = getWindowCenter();
    refreshInstances(center);
    refreshUrgency();
    renderBars(center);
    updateSummary();
    maybeNotifyDeadlines();
    tickRafId = null;
  });
}

/* ── Event handlers ── */

function onSearchInput() {
  state.searchFilter = searchInput.value.trim().toLowerCase();
  state.lastInstanceBuildMs = 0;
  const center = getWindowCenter();
  refreshInstances(center, true);
  renderBars(center);
}

function onZoomClick(btn) {
  const days = parseInt(btn.dataset.days, 10);
  if (days === state.visibleDays) return;
  state.visibleDays = days;
  writeLocalZoom(days);

  zoomBtns.forEach((b) => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-checked", b === btn ? "true" : "false");
  });

  state.lastInstanceBuildMs = 0;
  const center = getWindowCenter();
  refreshInstances(center, true);
  renderBars(center);
}

function onOnline() { state.online = true; }
function onOffline() { state.online = false; }

let resizeDebounce = null;
function onResize() {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    renderBars(getWindowCenter());
  }, 100);
}

function onChartKeydown(e) {
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    applyOffset(-PAN_SMALL_MS);
    state.lastInstanceBuildMs = 0;
    const center = getWindowCenter();
    refreshInstances(center, true);
    renderBars(center);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    applyOffset(PAN_SMALL_MS);
    state.lastInstanceBuildMs = 0;
    const center = getWindowCenter();
    refreshInstances(center, true);
    renderBars(center);
  } else if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    panToToday();
  }
}

function onWheel(e) {
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
    const delta = e.shiftKey ? e.deltaY : e.deltaX;
    const width = axisLane.clientWidth || 800;
    const deltaMs = (delta / width) * state.visibleDays * MS_PER_DAY;
    applyOffset(deltaMs);
    state.lastInstanceBuildMs = 0;
    const center = getWindowCenter();
    refreshInstances(center, true);
    renderBars(center);
  }
}

function onGlobalKeydown(e) {
  /* don't capture shortcuts inside inputs, textareas, or modals */
  const tag = document.activeElement?.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.activeElement?.isContentEditable;

  /* Ctrl+Z / Cmd+Z — undo */
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    if (performUndo()) {
      const center = getWindowCenter();
      renderBars(center);
    }
    return;
  }

  /* Ctrl+Shift+Z / Cmd+Shift+Z — redo */
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z") {
    e.preventDefault();
    if (performRedo()) {
      const center = getWindowCenter();
      renderBars(center);
    }
    return;
  }

  /* Ctrl+K or / — focus search */
  if (!isInput && (e.key === "/" || (e.ctrlKey && e.key === "k"))) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  /* ? — help modal */
  if (!isInput && e.key === "?") {
    e.preventDefault();
    toggleHelpModal();
    return;
  }

  /* Escape — close modals */
  if (e.key === "Escape") {
    if (helpModal.classList.contains("open")) {
      helpModal.classList.remove("open");
      chartEl.focus();
    } else if (addModal.classList.contains("open")) {
      closeAddModal();
      chartEl.focus();
    }
    hideContextMenu();
  }

  /* Ctrl+Shift+D — mark all done */
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
    e.preventDefault();
    markAllVisible(true);
  }

  /* Ctrl+Shift+U — mark all undone */
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "U") {
    e.preventDefault();
    markAllVisible(false);
  }

  /* Ctrl+Shift+G — collapse all / expand all groups */
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "G") {
    e.preventDefault();
    collapseAllGroups();
  }
}

/* ── Skeleton ── */

function showSkeleton(show) {
  if (skeletonEl) skeletonEl.style.display = show ? "block" : "none";
  if (show) {
    rowsEl.innerHTML = "";
    axisLane.innerHTML = "";
  }
}

/* ── Init ── */

async function init() {
  showSkeleton(true);
  showStatus("Loading assignments…");

  /* restore preferences */
  state.visibleDays = readLocalZoom();
  state.windowOffsetMs = readLocalOffset();
  updateTodayButton();

  /* theme */
  const theme = readLocalTheme();
  applyTheme(theme);

  zoomBtns.forEach((btn) => {
    const d = parseInt(btn.dataset.days, 10);
    btn.classList.toggle("active", d === state.visibleDays);
    btn.setAttribute("aria-checked", d === state.visibleDays ? "true" : "false");
  });

  /* request notification permission passively */
  requestNotificationPermission();

  try {
    state.assignments = await fetchAssignments();
    state.lastConfigFetchMs = Date.now();
    state.doneMap = readLocalDoneMap();

    /* try cloud sync */
    try {
      state.doneMap = await fetchDoneMap();
      writeLocalDoneMap(state.doneMap);
      state.persistenceMode = "remote";
      showStatus("");
    } catch (error) {
      state.persistenceMode = "local";
      if (error?.status === 404) {
        showStatus("Assignments loaded. /api/status not found; using local device storage.");
      } else {
        showStatus("Assignments loaded. Cloud persistence unavailable; using local storage.");
      }
    }

    if (!state.assignments.length) {
      showStatus("No assignments found in /config/homework.json.");
    }
  } catch (error) {
    showSkeleton(false);
    showStatus("Load failed. Verify /config/homework.json and KV binding.");
    retryBtn.classList.remove("hidden");
    console.error(error);
    return;
  }

  showSkeleton(false);

  /* initial render */
  const center = getWindowCenter();
  refreshInstances(center, true);
  renderBars(center);

  /* tick */
  state.tickerId = setInterval(scheduleTick, TICK_MS);

  /* periodic config refresh */
  setInterval(async () => {
    if (Date.now() - state.lastConfigFetchMs < CONFIG_REFRESH_MS) return;
    try {
      const fresh = await fetchAssignments();
      if (fresh.length) {
        state.assignments = fresh;
        state.lastInstanceBuildMs = 0;
        const c = getWindowCenter();
        refreshInstances(c, true);
        renderBars(c);
      }
      state.lastConfigFetchMs = Date.now();
    } catch { /* silently ignore */ }
  }, CONFIG_REFRESH_MS);

  /* event listeners */
  window.addEventListener("resize", onResize);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("keydown", onGlobalKeydown);

  searchInput.addEventListener("input", onSearchInput);

  zoomBtns.forEach((btn) => {
    btn.addEventListener("click", () => onZoomClick(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const all = [...zoomBtns];
        const idx = all.indexOf(btn);
        const next = e.key === "ArrowRight" ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
        all[next].focus();
        onZoomClick(all[next]);
      }
    });
  });

  /* nav buttons */
  panLeftBtn.addEventListener("click", () => {
    applyOffset(-PAN_STEP_MS);
    state.lastInstanceBuildMs = 0;
    const c = getWindowCenter();
    refreshInstances(c, true);
    renderBars(c);
  });
  panRightBtn.addEventListener("click", () => {
    applyOffset(PAN_STEP_MS);
    state.lastInstanceBuildMs = 0;
    const c = getWindowCenter();
    refreshInstances(c, true);
    renderBars(c);
  });
  todayBtn.addEventListener("click", () => panToToday());

  /* export / import */
  exportBtn.addEventListener("click", exportDoneState);
  importBtn.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", () => {
    if (importFileInput.files[0]) handleImportFile(importFileInput.files[0]);
    importFileInput.value = "";
  });

  /* paste import */
  window.addEventListener("paste", (e) => {
    if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
    const text = e.clipboardData?.getData("text/plain");
    if (text && text.trim().startsWith("{") && text.includes('"doneMap"')) {
      if (confirm("Detected homework export JSON on clipboard. Import it?")) {
        importDoneState(text);
      }
    }
  });

  /* quick-add */
  addBtn.addEventListener("click", openAddModal);
  addModal.addEventListener("click", (e) => {
    if (e.target === addModal) closeAddModal();
  });
  addForm.addEventListener("submit", handleAddSubmit);
  document.getElementById("addCancelBtn")?.addEventListener("click", closeAddModal);

  /* help modal */
  document.getElementById("helpBtn")?.addEventListener("click", toggleHelpModal);
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) toggleHelpModal();
  });
  document.getElementById("helpCloseBtn")?.addEventListener("click", toggleHelpModal);

  /* theme toggle */
  themeToggle.addEventListener("click", toggleTheme);

  /* retry */
  retryBtn.addEventListener("click", () => {
    retryBtn.classList.add("hidden");
    init();
  });

  /* drag panning */
  chartEl.addEventListener("mousedown", startDrag);
  window.addEventListener("mousemove", (e) => moveDrag(e));
  window.addEventListener("mouseup", endDrag);
  chartEl.addEventListener("touchstart", startDrag, { passive: false });
  window.addEventListener("touchmove", (e) => moveDrag(e), { passive: false });
  window.addEventListener("touchend", endDrag);

  /* mark all */
  markAllDoneBtn.addEventListener("click", () => markAllVisible(true));
  markAllUndoneBtn.addEventListener("click", () => markAllVisible(false));

  /* date jump */
  dateJumpInput.addEventListener("change", () => {
    jumpToDate(dateJumpInput.value);
    dateJumpInput.value = "";
  });

  /* ICS export */
  if (icsExportBtn) icsExportBtn.addEventListener("click", exportICS);

  /* right-click context menu on chart (delegated) */
  chartEl.addEventListener("contextmenu", (e) => {
    const bar = e.target.closest(".bar");
    if (bar && bar._instance) {
      e.preventDefault();
      showContextMenu(e, bar._instance);
    }
  });

  /* pinch zoom (on chart, touch) */
  chartEl.addEventListener("touchstart", handlePinchStart, { passive: false });
  chartEl.addEventListener("touchmove", handlePinchMove, { passive: false });
  chartEl.addEventListener("touchend", (e) => {
    if (state.pinchDist0) handlePinchEnd();
  });

  /* group collapse (delegated click on group headers) */
  rowsEl.addEventListener("click", (e) => {
    const header = e.target.closest(".group-header");
    if (header && header.dataset.group) {
      toggleGroupCollapse(header.dataset.group);
    }
  });

  /* shift+click range toggle on bars */
  chartEl.addEventListener("click", (e) => {
    if (!e.shiftKey) return;
    const bar = e.target.closest(".bar");
    if (!bar || !bar._instance) return;
    if (state._lastShiftClick && state._lastShiftClick !== bar._instance.id) {
      e.preventDefault();
      // toggle all bars between last shift click and this one
      rangeToggle(state._lastShiftClick, bar._instance.id);
    }
    state._lastShiftClick = bar._instance.id;
  });

  /* keyboard panning on chart */
  chartEl.addEventListener("keydown", onChartKeydown);

  /* wheel panning */
  chartEl.addEventListener("wheel", onWheel, { passive: false });

  /* global click to hide tooltip */
  document.addEventListener("click", hideTooltip);
}

init();
