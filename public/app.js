const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VISIBLE_DAYS = 10;
const HALF_WINDOW_MS = (VISIBLE_DAYS / 2) * MS_PER_DAY;
const TICK_MS = 1000;

const axisLane = document.getElementById("axisLane");
const rowsEl = document.getElementById("rows");
const statusText = document.getElementById("statusText");

const state = {
  assignments: [],
  doneMap: {},
  rowRefs: [],
};

function showStatus(message) {
  statusText.textContent = message || "";
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
        title: String(item.title || item.id),
        releaseMs: startMs,
        deadlineMs: endMs,
        color: item.color ? String(item.color) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deadlineMs - b.deadlineMs);
}

function formatDate(ms) {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createRow(assignment) {
  const meta = document.createElement("div");
  meta.className = "row-meta";

  const labelWrap = document.createElement("div");
  labelWrap.className = "label-wrap";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = assignment.title;

  const dates = document.createElement("div");
  dates.className = "dates";
  dates.textContent = `${formatDate(assignment.releaseMs)} to ${formatDate(assignment.deadlineMs)}`;

  labelWrap.append(title, dates);

  const doneToggle = document.createElement("label");
  doneToggle.className = "done-toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(state.doneMap[assignment.id]);
  checkbox.setAttribute("aria-label", `Mark ${assignment.title} as done`);

  doneToggle.append(checkbox);
  meta.append(labelWrap, doneToggle);

  const lane = document.createElement("div");
  lane.className = "row-lane";

  const bar = document.createElement("div");
  bar.className = "bar";
  if (assignment.color) {
    bar.style.backgroundColor = assignment.color;
  }
  lane.appendChild(bar);

  checkbox.addEventListener("change", async () => {
    const done = checkbox.checked;
    checkbox.disabled = true;
    setDoneVisual(meta, lane, done);
    state.doneMap[assignment.id] = done;

    try {
      await saveDoneState(assignment.id, done);
      showStatus("");
    } catch (error) {
      checkbox.checked = !done;
      setDoneVisual(meta, lane, !done);
      state.doneMap[assignment.id] = !done;
      showStatus(`Could not save "${assignment.title}". Check KV binding and try again.`);
      console.error(error);
    } finally {
      checkbox.disabled = false;
    }
  });

  setDoneVisual(meta, lane, checkbox.checked);
  rowsEl.append(meta, lane);
  return { assignment, meta, lane, bar };
}

function setDoneVisual(meta, lane, done) {
  meta.classList.toggle("done", done);
  lane.classList.toggle("done", done);
}

function xForTime(ms, nowMs, width) {
  const windowStart = nowMs - HALF_WINDOW_MS;
  const progress = (ms - windowStart) / (VISIBLE_DAYS * MS_PER_DAY);
  return progress * width;
}

function renderAxis(nowMs, width) {
  axisLane.innerHTML = "";

  const startMs = nowMs - HALF_WINDOW_MS;
  const endMs = nowMs + HALF_WINDOW_MS;
  const firstTick = new Date(startMs);
  firstTick.setHours(0, 0, 0, 0);

  for (let tickMs = firstTick.getTime(); tickMs <= endMs + MS_PER_DAY; tickMs += MS_PER_DAY) {
    const x = xForTime(tickMs, nowMs, width);
    if (x < -80 || x > width + 80) {
      continue;
    }

    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${x}px`;

    const label = document.createElement("div");
    label.className = "tick-label";
    label.style.left = `${x}px`;
    label.textContent = new Date(tickMs).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });

    axisLane.append(tick, label);
  }
}

function renderBars(nowMs) {
  if (!state.rowRefs.length) {
    return;
  }

  const width = state.rowRefs[0].lane.clientWidth;
  if (!width) {
    return;
  }

  const dayWidth = width / VISIBLE_DAYS;
  axisLane.style.setProperty("--day-width", `${dayWidth}px`);

  renderAxis(nowMs, width);

  for (const row of state.rowRefs) {
    const left = xForTime(row.assignment.releaseMs, nowMs, width);
    const right = xForTime(row.assignment.deadlineMs, nowMs, width);
    const clampedLeft = Math.max(0, Math.min(width, left));
    const clampedRight = Math.max(0, Math.min(width, right));
    const barWidth = Math.max(2, clampedRight - clampedLeft);

    row.lane.style.setProperty("--day-width", `${dayWidth}px`);
    row.bar.style.left = `${clampedLeft}px`;
    row.bar.style.width = `${barWidth}px`;
    row.bar.style.opacity = right < 0 || left > width ? "0.25" : "1";
  }
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
    throw new Error(`Status fetch failed (${response.status})`);
  }

  const data = await response.json();
  return data.done || {};
}

async function saveDoneState(id, done) {
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
}

function buildRows() {
  rowsEl.innerHTML = "";
  state.rowRefs = state.assignments.map(createRow);
}

function startTicker() {
  const tick = () => renderBars(Date.now());
  tick();
  setInterval(tick, TICK_MS);
  window.addEventListener("resize", tick);
}

async function init() {
  showStatus("Loading assignments...");

  try {
    const assignments = await fetchAssignments();
    state.assignments = assignments;

    try {
      state.doneMap = await fetchDoneMap();
      showStatus("");
    } catch (error) {
      state.doneMap = {};
      showStatus("Assignments loaded. Persistent status unavailable until KV is configured.");
      console.error(error);
    }

    buildRows();
    startTicker();
  } catch (error) {
    showStatus("Load failed. Verify /config/homework.json and KV binding.");
    console.error(error);
  }
}

init();
