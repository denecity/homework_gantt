import { isOverdue, type TimelineItem } from "../shared/expand";
import type { AppState } from "../shared/schema";
import { daysBetween, dateKey } from "../shared/time";
import { api } from "./api";
import { Panel } from "./panel";
import { Timeline } from "./timeline";
import { $, fmtLongDay, fmtSpan, h, toast } from "./util";

const TICK_MS = 15_000;
const POLL_MS = 15_000;

let state: AppState = {
  version: 0,
  semester: null,
  courses: [],
  markers: [],
  lecture_slots: [],
  series: [],
  assignments: [],
  review_done: [],
};

const timeline = new Timeline({
  open: (item) => panel.openItem(item),
  toggle: (item) => void toggle(item),
  moveDeadline: (item, dueMs) =>
    void mutate(() => api.updateAssignment(item.id, { due_at: new Date(dueMs).toISOString() }), "Deadline moved"),
  openCourse: (course) => panel.openCourse(course),
  reorderCourses: (ids) => {
    const byId = new Map(state.courses.map((c) => [c.id, c]));
    apply({ ...state, courses: ids.map((id, i) => ({ ...byId.get(id)!, sort_order: i })) });
    void mutate(() => api.reorderCourses(ids));
  },
  openMarker: (marker) => panel.openMarker(marker),
});

const panel = new Panel({
  state: () => state,
  items: () => timeline.items,
  toggle,
  mutate,
});

// ---- state flow -----------------------------------------------------------------------------

function apply(next: AppState) {
  state = next;
  timeline.render(state);
  renderChrome(Date.now());
  panel.refresh();
}

async function reload() {
  apply(await api.state());
}

/** Runs a write, then pulls fresh state. Returns false (and shows the error) on failure. */
async function mutate(action: () => Promise<unknown>, message?: string): Promise<boolean> {
  try {
    await action();
    await reload();
    if (message) toast(message);
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
    await reload().catch(() => undefined);
    return false;
  }
}

/** Optimistic done toggle. */
async function toggle(item: TimelineItem) {
  const done = !item.done;
  const optimistic: AppState =
    item.kind === "review"
      ? { ...state, review_done: done ? [...state.review_done, item.id] : state.review_done.filter((k) => k !== item.id) }
      : { ...state, assignments: state.assignments.map((a) => (a.id === item.id ? { ...a, done } : a)) };
  apply(optimistic);
  await mutate(() => api.setDone(item.id, done), done ? "Marked done ✓" : "Marked not done");
}

// ---- chrome: header + overdue shelf ------------------------------------------------------------

function renderChrome(now: number) {
  const s = state.semester;
  $("semesterName").textContent = s?.name ?? "Homework";
  if (s) {
    const today = dateKey(now);
    const week = Math.floor(daysBetween(s.starts_on, today) / 7) + 1;
    const lecturesEnd = s.lectures_end_on ?? s.ends_on;
    const weeks = Math.floor(daysBetween(s.starts_on, lecturesEnd) / 7) + 1;
    const phase =
      today < s.starts_on ? "Before semester" : today <= lecturesEnd ? `Week ${week} of ${weeks}` : today <= s.ends_on ? "Exam period" : "Semester over";
    $("semesterMeta").textContent = `${phase} · ${fmtLongDay(now)}`;
  } else {
    $("semesterMeta").textContent = fmtLongDay(now);
  }

  const empty = $("empty");
  empty.hidden = state.courses.length > 0;
  if (!empty.hidden) {
    empty.replaceChildren(
      h("h2", {}, s ? "No courses yet" : "Nothing set up yet"),
      h("p", {}, "Connect the MCP server in Claude and ask it to set up this semester: dates, courses, lecture times and exercise series."),
      h("code", {}, `${location.origin}/mcp`),
    );
  }

  const overdue = timeline.items.filter((i) => isOverdue(i, now)).sort((a, b) => a.endMs - b.endMs);
  const shelf = $("shelf");
  shelf.hidden = overdue.length === 0;
  if (!overdue.length) return;
  const courses = new Map(state.courses.map((c) => [c.id, c]));
  shelf.replaceChildren(
    h("span", { class: "shelf-title" }, `Overdue · ${overdue.length}`),
    h(
      "div",
      { class: "shelf-list" },
      ...overdue.map((item) => {
        const c = courses.get(item.course_id);
        return h(
          "div",
          { class: `chip ${item.kind}`, style: `--c:${c?.color ?? "#888"}` },
          h("button", { class: "chip-check", type: "button", "aria-label": `Mark ${item.title} done`, onclick: () => toggle(item) }),
          h(
            "button",
            {
              class: "chip-main",
              type: "button",
              onclick: () => {
                timeline.select(item.id);
                panel.openItem(item);
              },
            },
            h("span", { class: "chip-course" }, c?.short ?? item.course_id),
            h("span", { class: "chip-title" }, item.kind === "review" ? item.title.replace("Review lecture", "↻ Review") : item.title),
            h("span", { class: "chip-late" }, `${fmtSpan(now - item.endMs)} late`),
          ),
        );
      }),
    ),
  );
}

// ---- clock & live updates ---------------------------------------------------------------------------

let lastChromeMinute = -1;
function tick() {
  const now = Date.now();
  timeline.tick(now);
  const minute = Math.floor(now / 60_000);
  if (minute !== lastChromeMinute) {
    lastChromeMinute = minute;
    renderChrome(now);
  }
}

let polling = false;
async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const version = await api.version();
    if (version !== state.version) await reload();
  } catch {
    /* offline: try again next time */
  } finally {
    polling = false;
  }
}

// ---- keyboard ------------------------------------------------------------------------------------------

function bindKeys() {
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape") (target as HTMLElement).blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const selected = timeline.selected();
    switch (e.key) {
      case "j":
      case "ArrowDown":
        if (e.key === "ArrowDown" && !e.shiftKey) return;
        timeline.selectStep(1);
        break;
      case "k":
      case "ArrowUp":
        if (e.key === "ArrowUp" && !e.shiftKey) return;
        timeline.selectStep(-1);
        break;
      case "x":
        if (selected) void toggle(selected);
        break;
      case "Enter":
        if (selected) panel.openItem(selected);
        break;
      case "Escape":
        if (panel.isOpen) panel.close();
        else timeline.select(null);
        break;
      case "t":
        timeline.scrollToTime(Date.now(), 0.3, true);
        break;
      case "+":
      case "=":
        timeline.zoomBy(1.5);
        break;
      case "-":
      case "_":
        timeline.zoomBy(1 / 1.5);
        break;
      case "?":
        toast("j/k move · x done · Enter open · t now · +/− zoom · Esc close");
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}

// ---- boot ---------------------------------------------------------------------------------------------------

async function boot() {
  $("zoomIn").addEventListener("click", () => timeline.zoomBy(1.5));
  $("zoomOut").addEventListener("click", () => timeline.zoomBy(1 / 1.5));
  $("nowBtn").addEventListener("click", () => timeline.scrollToTime(Date.now(), 0.3, true));
  window.addEventListener("resize", () => timeline.onResize());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      tick();
      void poll();
    }
  });
  window.addEventListener("focus", () => void poll());
  bindKeys();

  try {
    await reload();
  } catch (error) {
    toast(`Could not load data: ${error instanceof Error ? error.message : error}`, "error");
  }
  timeline.scrollToTime(Date.now(), 0.3);
  tick();
  setInterval(tick, TICK_MS);
  setInterval(() => void poll(), POLL_MS);
}

void boot();
