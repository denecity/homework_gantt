const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VISIBLE_DAYS = 10;
const HALF_WINDOW_MS = (VISIBLE_DAYS / 2) * MS_PER_DAY;
const REPEAT_INTERVAL_MS = 7 * MS_PER_DAY;
const TICK_MS = 1000;
const INSTANCE_REFRESH_MS = 60 * 1000;
const LOCAL_DONE_KEY = "homework_done_map_local_v1";

const axisLane = document.getElementById("axisLane");
const rowsEl = document.getElementById("rows");
const statusText = document.getElementById("statusText");

const state = {
  assignments: [],
  instances: [],
  doneMap: {},
  rowRefs: [],
  persistenceMode: "unknown",
  lastInstanceBuildMs: 0,
};

function showStatus(message) {
  statusText.textContent = message || "";
}

function readLocalDoneMap() {
  try {
    const raw = localStorage.getItem(LOCAL_DONE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalDoneMap(map) {
  try {
    localStorage.setItem(LOCAL_DONE_KEY, JSON.stringify(map));
  } catch {
    // Ignore localStorage errors; UI still works in-memory.
  }
}

function sanitizeHexColor(value) {
  if (typeof value !== "string") {
    return null;
  }

  const color = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color) ? color : null;
}

function sanitizeAssignmentLink(value) {
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim();
  if (!candidate) {
    return null;
  }

  try {
    const parsed = new URL(candidate, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseAssignments(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      const releaseMs = new Date(item.release).getTime();
      const deadlineMs = new Date(item.deadline).getTime();

      if (!item.id || Number.isNaN(releaseMs) || Number.isNaN(deadlineMs)) {
        return null;
      }

      const startMs = Math.min(releaseMs, deadlineMs);
      const endMs = Math.max(releaseMs, deadlineMs);

      return {
        id: String(item.id),
        lecture: String(item.lecture || item.title || item.id),
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

function xForTime(ms, nowMs, width) {
  const windowStart = nowMs - HALF_WINDOW_MS;
  const progress = (ms - windowStart) / (VISIBLE_DAYS * MS_PER_DAY);
  return progress * width;
}

function overlapsWindow(startMs, endMs, windowStart, windowEnd) {
  return endMs >= windowStart && startMs <= windowEnd;
}

function buildInstance(assignment, releaseMs, deadlineMs, repeatIndex) {
  const doneKey = assignment.repeatWeekly ? `${assignment.id}::${repeatIndex}` : assignment.id;

  return {
    instanceId: `${assignment.id}@${repeatIndex}`,
    doneKey,
    lecture: assignment.lecture,
    color: assignment.color,
    link: assignment.link,
    releaseMs,
    deadlineMs,
  };
}

function expandAssignmentsForWindow(assignments, nowMs) {
  const windowStart = nowMs - HALF_WINDOW_MS;
  const windowEnd = nowMs + HALF_WINDOW_MS;
  const instances = [];

  for (const assignment of assignments) {
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
    if (a.releaseMs !== b.releaseMs) {
      return a.releaseMs - b.releaseMs;
    }
    return a.lecture.localeCompare(b.lecture);
  });
}

function setDoneVisual(lane, bar, done) {
  lane.classList.toggle("done", done);
  bar.classList.toggle("done", done);
  bar.setAttribute("aria-pressed", done ? "true" : "false");
}

async function toggleBar(instance, lane, bar) {
  if (bar.dataset.busy === "true") {
    return;
  }

  const done = !Boolean(state.doneMap[instance.doneKey]);
  bar.dataset.busy = "true";
  bar.setAttribute("aria-disabled", "true");
  state.doneMap[instance.doneKey] = done;
  writeLocalDoneMap(state.doneMap);
  setDoneVisual(lane, bar, done);

  try {
    await saveDoneState(instance.doneKey, done);
    if (state.persistenceMode === "remote") {
      showStatus("");
    } else {
      showStatus("Saved on this device only. Cloud sync is unavailable.");
    }
  } catch (error) {
    state.persistenceMode = "local";
    showStatus(`Saved "${instance.lecture}" locally only. Cloud sync is unavailable.`);
    console.error(error);
  } finally {
    delete bar.dataset.busy;
    bar.removeAttribute("aria-disabled");
  }
}

function createRow(instance) {
  const lane = document.createElement("div");
  lane.className = "row-lane";

  const decoration = document.createElement("div");
  decoration.className = "lane-decoration";

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "button");
  bar.tabIndex = 0;
  bar.title = instance.link ? `${instance.lecture}\nClick text to open link` : instance.lecture;

  const label = instance.link ? document.createElement("a") : document.createElement("span");
  label.className = instance.link ? "bar-label bar-link" : "bar-label";
  label.textContent = instance.lecture;

  if (instance.link) {
    label.href = instance.link;
    label.target = "_blank";
    label.rel = "noopener noreferrer";
    label.title = instance.link;
    label.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  if (instance.color) {
    bar.style.setProperty("--bar-color", instance.color);
  }

  bar.appendChild(label);
  bar.addEventListener("click", () => toggleBar(instance, lane, bar));
  bar.addEventListener("keydown", (event) => {
    if (event.target !== bar) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleBar(instance, lane, bar);
    }
  });
  lane.append(decoration, bar);
  setDoneVisual(lane, bar, Boolean(state.doneMap[instance.doneKey]));
  rowsEl.appendChild(lane);
  return { instance, lane, decoration, bar };
}

function renderDayDecoration(container, nowMs, width, withLabels) {
  container.innerHTML = "";
  const windowStart = nowMs - HALF_WINDOW_MS;
  const windowEnd = nowMs + HALF_WINDOW_MS;
  const firstDay = new Date(windowStart);
  firstDay.setHours(0, 0, 0, 0);

  for (let dayStartMs = firstDay.getTime(); dayStartMs <= windowEnd + MS_PER_DAY; dayStartMs += MS_PER_DAY) {
    const dayEndMs = dayStartMs + MS_PER_DAY;
    const left = xForTime(dayStartMs, nowMs, width);
    const right = xForTime(dayEndMs, nowMs, width);
    const visibleLeft = Math.max(0, left);
    const visibleRight = Math.min(width, right);
    const dayOfWeek = new Date(dayStartMs).getDay();

    if ((dayOfWeek === 0 || dayOfWeek === 6) && visibleRight > visibleLeft) {
      const weekendBand = document.createElement("div");
      weekendBand.className = "weekend-band";
      weekendBand.style.left = `${visibleLeft}px`;
      weekendBand.style.width = `${visibleRight - visibleLeft}px`;
      container.appendChild(weekendBand);
    }

    if (left >= 0 && left <= width) {
      const dayTick = document.createElement("div");
      dayTick.className = "day-tick";
      dayTick.style.left = `${left}px`;
      container.appendChild(dayTick);
    }

    if (withLabels) {
      const middle = (left + right) / 2;
      if (middle >= -20 && middle <= width + 20) {
        const label = document.createElement("div");
        label.className = "tick-label";
        label.style.left = `${middle}px`;
        label.textContent = new Date(dayStartMs).toLocaleDateString([], { weekday: "short" });
        container.appendChild(label);
      }
    }
  }
}

function renderAxis(nowMs, width) {
  renderDayDecoration(axisLane, nowMs, width, true);
}

function renderBars(nowMs) {
  if (!state.rowRefs.length) {
    axisLane.innerHTML = "";
    return;
  }

  const width = axisLane.clientWidth || state.rowRefs[0].lane.clientWidth;
  if (!width) {
    return;
  }

  renderAxis(nowMs, width);

  for (const row of state.rowRefs) {
    renderDayDecoration(row.decoration, nowMs, width, false);

    const left = xForTime(row.instance.releaseMs, nowMs, width);
    const right = xForTime(row.instance.deadlineMs, nowMs, width);
    const clampedLeft = Math.max(0, Math.min(width, left));
    const clampedRight = Math.max(0, Math.min(width, right));
    const barWidth = Math.max(10, clampedRight - clampedLeft);

    row.bar.style.left = `${clampedLeft}px`;
    row.bar.style.width = `${barWidth}px`;
    row.bar.style.opacity = right < 0 || left > width ? "0.35" : "1";
  }
}

function sameInstanceList(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].instanceId !== b[i].instanceId ||
      a[i].releaseMs !== b[i].releaseMs ||
      a[i].deadlineMs !== b[i].deadlineMs
    ) {
      return false;
    }
  }

  return true;
}

function buildRows() {
  rowsEl.innerHTML = "";
  state.rowRefs = state.instances.map(createRow);
}

function refreshInstances(nowMs, force = false) {
  if (!force && nowMs - state.lastInstanceBuildMs < INSTANCE_REFRESH_MS) {
    return;
  }

  const nextInstances = expandAssignmentsForWindow(state.assignments, nowMs);
  if (!sameInstanceList(nextInstances, state.instances)) {
    state.instances = nextInstances;
    buildRows();
  }

  state.lastInstanceBuildMs = nowMs;
}

async function fetchAssignments() {
  const response = await fetch("/config/homework.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Config fetch failed (${response.status})`);
  }

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
  if (state.persistenceMode !== "remote") {
    return;
  }

  const response = await fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, done }),
  });

  if (!response.ok) {
    throw new Error(`Status save failed (${response.status})`);
  }

  const data = await response.json();
  state.doneMap = data.done || {};
  writeLocalDoneMap(state.doneMap);
}

function startTicker() {
  const tick = () => {
    const nowMs = Date.now();
    refreshInstances(nowMs);
    renderBars(nowMs);
  };

  refreshInstances(Date.now(), true);
  tick();
  setInterval(tick, TICK_MS);
  window.addEventListener("resize", tick);
}

async function init() {
  showStatus("Loading assignments...");

  try {
    state.assignments = await fetchAssignments();
    state.doneMap = readLocalDoneMap();

    try {
      state.doneMap = await fetchDoneMap();
      writeLocalDoneMap(state.doneMap);
      state.persistenceMode = "remote";
      showStatus("");
    } catch (error) {
      state.persistenceMode = "local";
      if (error && error.status === 404) {
        showStatus(
          "Assignments loaded. /api/status not found; using local device storage only.",
        );
      } else {
        showStatus(
          "Assignments loaded. Cloud persistence unavailable; using local device storage only.",
        );
      }
      console.error(error);
    }

    if (!state.assignments.length) {
      showStatus("No assignments found in /config/homework.json.");
    }

    startTicker();
  } catch (error) {
    showStatus("Load failed. Verify /config/homework.json and KV binding.");
    console.error(error);
  }
}

init();
