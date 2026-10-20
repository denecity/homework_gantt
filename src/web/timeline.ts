// Vertical timeline renderer.
//
// Positions are expressed in *minutes since the view origin* and turned into pixels by CSS
// (`calc(var(--s) * var(--ppm) * 1px)`), so:
//   - zooming only changes `--ppm` on the root (no JS layout),
//   - the clock tick only changes `--now` (now line + progress fills follow in CSS),
//   - JS per tick touches countdown text of cards that are actually on screen.
// DOM nodes are keyed and reused across data refreshes.

import { expandLectures, packLanes, timelineItems, type TimelineItem } from "../shared/expand";
import type { AppState, Course, Marker } from "../shared/schema";
import { HOUR, MINUTE, addDays, dateKey, daysBetween, parseInstant, startOfDay, weekdayOf } from "../shared/time";
import { $, fmtDay, fmtFull, fmtMonth, fmtSpan, fmtSpanShort, fmtTime, h, urgencyOf } from "./util";

export interface TimelineCallbacks {
  open(item: TimelineItem): void;
  toggle(item: TimelineItem): void;
  moveDeadline(item: TimelineItem, dueMs: number): void;
  openCourse(course: Course): void;
  reorderCourses(ids: string[]): void;
  openMarker(marker: Marker): void;
}

interface CardRef {
  el: HTMLElement;
  item: TimelineItem;
  sig: string;
}

const MIN_PXH = 0.6; // px per hour (≈ 6 weeks on a laptop screen)
const MAX_PXH = 160;
const PPM_KEY = "hg.pxh";

const readStored = () => {
  try {
    const v = Number(localStorage.getItem(PPM_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const store = (v: number) => {
  try {
    localStorage.setItem(PPM_KEY, String(v));
  } catch {
    /* per-device convenience only */
  }
};

/** "Sheet 12" → "#12", "Problem set 3" → "#3", otherwise the first word (max 6 chars). */
function shortTitle(title: string): string {
  const num = /(\d+)\s*$/.exec(title);
  return num ? `#${num[1]}` : title.split(/\s+/)[0]!.slice(0, 6);
}

export class Timeline {
  private root = document.documentElement;
  private scroller = $("scroller");
  private canvas = $("canvas");
  private heads = $("heads");
  private gutter = $("gutter");
  private grid = $("grid");
  private daysLayer = $("days");
  private markersLayer = $("markers");
  private cols = $("cols");

  origin = 0;
  private totalMin = 0;
  private pxh: number;
  private density = "";
  private viewSig = "";
  private markersSig = "";
  private now = Date.now();

  private cards = new Map<string, CardRef>();
  private columns = new Map<string, { head: HTMLElement; col: HTMLElement; tasks: HTMLElement; reviews: HTMLElement; sig: string }>();
  private statics = new Map<string, HTMLElement>(); // lectures + exams inside columns
  private visible = new Set<CardRef>();
  private visibleDays = new Set<HTMLElement>();
  items: TimelineItem[] = [];
  selectedId: string | null = null;
  private suppressClick = false;

  private cardObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const ref = this.cards.get((e.target as HTMLElement).dataset.id!);
        if (!ref) continue;
        if (e.isIntersecting) {
          this.visible.add(ref);
          this.updateCard(ref);
        } else this.visible.delete(ref);
      }
    },
    { root: this.scroller, rootMargin: "50% 0px" },
  );

  private dayObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) {
          this.visibleDays.add(el);
          this.fillHours(el);
        } else this.visibleDays.delete(el);
      }
    },
    { root: this.scroller, rootMargin: "100% 0px" },
  );

  constructor(private cb: TimelineCallbacks) {
    this.pxh = readStored() ?? Math.max(4, Math.min(24, (window.innerHeight - 140) / 96));
    this.applyZoom();
    this.bindGestures();
  }

  // ---- coordinates --------------------------------------------------------------

  private min(ms: number) {
    return (ms - this.origin) / MINUTE;
  }

  private get headsH() {
    return this.heads.offsetHeight;
  }

  private get ppm() {
    return this.pxh / 60;
  }

  timeAtY(clientY: number): number {
    const rect = this.grid.getBoundingClientRect();
    return this.origin + ((clientY - rect.top) / this.ppm) * MINUTE;
  }

  // ---- data render ------------------------------------------------------------------

  render(state: AppState) {
    this.renderView(state);
    this.renderMarkers(state);
    this.renderColumns(state);
    this.renderItems(state);
    this.tick(this.now);
  }

  private renderView(state: AppState) {
    const today = dateKey(Date.now());
    const first = state.semester?.starts_on ?? addDays(today, -7);
    const last = state.semester?.ends_on ?? addDays(today, 60);
    const sig = `${first}|${last}`;
    if (sig === this.viewSig) return;
    this.viewSig = sig;
    this.origin = startOfDay(first);
    this.totalMin = this.min(startOfDay(addDays(last, 1)));
    this.root.style.setProperty("--total", String(this.totalMin));

    this.daysLayer.replaceChildren();
    this.gutter.replaceChildren();
    this.dayObserver.disconnect();
    this.visibleDays.clear();

    for (let date = first; date <= last; date = addDays(date, 1)) {
      const s = this.min(startOfDay(date));
      const e = this.min(startOfDay(addDays(date, 1)));
      const weekday = weekdayOf(date);
      const style = `--s:${s};--len:${e - s}`;
      const dayStart = startOfDay(date);
      const cls = `day${weekday >= 6 ? " weekend" : ""}${weekday === 1 ? " monday" : ""}`;
      this.daysLayer.append(h("div", { class: cls, style, "data-date": date }));

      const week = Math.floor(daysBetween(first, date) / 7) + 1;
      const label = h(
        "div",
        { class: "day-label" },
        h("span", { class: "dl-wd" }, fmtDay(dayStart).split(" ")[0]!),
        h("span", { class: "dl-num" }, String(Number(date.slice(8)))),
        date.endsWith("-01") || date === first || weekday === 1
          ? h("span", { class: `dl-month${date.endsWith("-01") || date === first ? "" : " dl-month-weekly"}` }, fmtMonth(dayStart))
          : null,
        weekday === 1 ? h("span", { class: "dl-week" }, `W${week}`) : null,
      );
      const gutterDay = h("div", { class: cls, style, "data-date": date }, label);
      this.gutter.append(gutterDay);
      this.dayObserver.observe(gutterDay);
    }
  }

  /** Hour labels are only created for days near the viewport. */
  private fillHours(dayEl: HTMLElement) {
    const step = this.density === "high" ? (this.pxh >= 40 ? 1 : 3) : this.density === "mid" ? 6 : 0;
    if (dayEl.dataset.step === String(step)) return;
    dayEl.dataset.step = String(step);
    dayEl.querySelectorAll(".hour").forEach((n) => n.remove());
    if (!step) return;
    const dayStart = startOfDay(dayEl.dataset.date!);
    const next = startOfDay(addDays(dayEl.dataset.date!, 1));
    for (let t = dayStart + step * HOUR; t < next; t += step * HOUR) {
      dayEl.append(h("span", { class: "hour", style: `--m:${(t - dayStart) / MINUTE}` }, fmtTime(t)));
    }
  }

  private renderMarkers(state: AppState) {
    const general = state.markers.filter((m) => !(m.kind === "exam" && m.course_id));
    const sig = JSON.stringify(general) + this.viewSig;
    if (sig === this.markersSig) return;
    this.markersSig = sig;
    this.markersLayer.replaceChildren(
      ...general.map((m) => {
        const at = parseInstant(m.at);
        const s = this.min(at);
        const open = () => this.cb.openMarker(m);
        if (m.kind === "break") {
          const e = m.end_at ? this.min(parseInstant(m.end_at)) : s + 24 * 60;
          return h(
            "div",
            { class: "mk-break", style: `--s:${s};--len:${e - s}` },
            h("button", { class: "mk-label", type: "button", onclick: open }, m.label),
          );
        }
        return h(
          "div",
          { class: `mk-line mk-${m.kind}`, style: `--s:${s}` },
          h(
            "button",
            { class: "mk-label", type: "button", onclick: open },
            m.kind === "exam" ? "◆ " : "",
            m.label,
            h("span", { class: "mk-date" }, fmtFull(at)),
          ),
        );
      }),
    );
  }

  private renderColumns(state: AppState) {
    const withSlots = new Set(state.lecture_slots.map((s) => s.course_id));
    const seen = new Set<string>();
    this.root.style.setProperty("--ncols", String(Math.max(state.courses.length, 1)));

    if (!this.heads.querySelector(".corner")) this.heads.append(h("div", { class: "corner" }));

    for (const course of state.courses) {
      seen.add(course.id);
      let c = this.columns.get(course.id);
      if (!c) {
        const tasks = h("div", { class: "area tasks" });
        const reviews = h("div", { class: "area reviews" });
        c = {
          head: h("button", { class: "head", type: "button" }),
          col: h("div", { class: "col" }, h("div", { class: "col-inner" }, tasks, reviews)),
          tasks,
          reviews,
          sig: "",
        };
        this.columns.set(course.id, c);
        this.bindReorder(c.head, course.id);
      }
      const sig = JSON.stringify(course) + withSlots.has(course.id);
      if (c.sig !== sig) {
        c.sig = sig;
        c.head.style.setProperty("--c", course.color);
        c.col.style.setProperty("--c", course.color);
        c.col.classList.toggle("has-reviews", withSlots.has(course.id));
        c.head.title = `${course.name} — edit course`;
        c.head.onclick = () => {
          if (!this.suppressClick) this.cb.openCourse(course);
        };
        c.head.replaceChildren(
          h("span", { class: "head-dot" }),
          h("span", { class: "head-name" }, course.name),
          h("span", { class: "head-short" }, course.short),
          course.link
            ? h(
                "a",
                {
                  class: "head-link",
                  href: course.link,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "Open course page",
                  "aria-label": `Open ${course.name} course page`,
                  onclick: (e: Event) => e.stopPropagation(),
                },
                "↗",
              )
            : "",
        );
      }
      // Keep DOM order in sync with sort order (appendChild moves existing nodes).
      this.heads.append(c.head);
      this.cols.append(c.col);
    }

    for (const [id, c] of this.columns) {
      if (seen.has(id)) continue;
      c.head.remove();
      c.col.remove();
      this.columns.delete(id);
    }
  }

  private renderItems(state: AppState) {
    this.items = timelineItems(state);
    const courses = new Map(state.courses.map((c) => [c.id, c]));
    const liveCards = new Set<string>();
    const liveStatics = new Set<string>();

    // Lectures (background) and course exams.
    for (const lec of expandLectures(state.lecture_slots, state.semester, state.markers)) {
      const col = this.columns.get(lec.course_id);
      if (!col) continue;
      const key = `lec:${lec.key}`;
      liveStatics.add(key);
      let el = this.statics.get(key);
      if (!el) {
        el = h("div", { class: "lecture", "aria-hidden": "true" });
        this.statics.set(key, el);
      }
      el.style.cssText = `--s:${this.min(lec.startMs)};--e:${this.min(lec.endMs)}`;
      el.title = `Lecture ${fmtTime(lec.startMs)}–${fmtTime(lec.endMs)}`;
      if (el.parentElement !== col.reviews) col.reviews.append(el);
    }
    for (const m of state.markers) {
      if (m.kind !== "exam" || !m.course_id) continue;
      const col = this.columns.get(m.course_id);
      if (!col) continue;
      const key = `exam:${m.id}`;
      liveStatics.add(key);
      let el = this.statics.get(key);
      if (!el) {
        el = h("button", { class: "exam", type: "button" });
        this.statics.set(key, el);
      }
      const at = parseInstant(m.at);
      el.style.cssText = `--s:${this.min(at)}`;
      el.onclick = () => this.cb.openMarker(m);
      el.replaceChildren(h("span", { class: "exam-diamond" }), h("span", { class: "exam-label" }, m.label, h("small", {}, fmtFull(at))));
      const inner = col.col.firstElementChild!;
      if (el.parentElement !== inner) inner.append(el);
    }
    for (const [key, el] of this.statics) {
      if (!liveStatics.has(key)) {
        el.remove();
        this.statics.delete(key);
      }
    }

    // Cards, lane-packed per column area.
    const groups = new Map<string, TimelineItem[]>();
    for (const item of this.items) {
      if (!courses.has(item.course_id)) continue;
      const key = `${item.course_id}|${item.kind}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
    }
    for (const [key, list] of groups) {
      const [courseId, kind] = key.split("|");
      const col = this.columns.get(courseId!)!;
      const area = kind === "review" ? col.reviews : col.tasks;
      const packed = packLanes(list.map((item) => ({ item, start: item.startMs, end: Math.max(item.endMs, item.startMs + 30 * MINUTE) })));
      for (const { item, lane, lanes, span } of packed) {
        liveCards.add(item.id);
        const sig = `${item.startMs}|${item.endMs}|${item.title}|${item.done}|${lane}|${lanes}|${span}`;
        let ref = this.cards.get(item.id);
        if (!ref) {
          ref = { el: this.createCard(item), item, sig: "" };
          this.cards.set(item.id, ref);
          this.cardObserver.observe(ref.el);
        }
        ref.item = item;
        if (ref.sig !== sig) {
          ref.sig = sig;
          this.fillCard(ref, lane, lanes, span);
        }
        if (ref.el.parentElement !== area) area.append(ref.el);
      }
    }
    for (const [id, ref] of this.cards) {
      if (liveCards.has(id)) continue;
      this.cardObserver.unobserve(ref.el);
      this.visible.delete(ref);
      ref.el.remove();
      this.cards.delete(id);
    }
    if (this.selectedId && !this.cards.has(this.selectedId)) this.selectedId = null;
  }

  private createCard(item: TimelineItem): HTMLElement {
    const el = h(
      "div",
      { class: `card ${item.kind}`, "data-id": item.id, tabindex: "-1" },
      h("div", { class: "card-fill" }),
      h(
        "div",
        { class: "card-top" },
        h("button", { class: "card-check", type: "button", "aria-label": "Toggle done" }),
        h("span", { class: "card-title" }),
        h("span", { class: "card-short" }),
      ),
      h(
        "div",
        { class: "card-bottom" },
        h("span", { class: "card-due" }),
        h("span", { class: "card-cd" }, h("span", { class: "cd-long" }), h("span", { class: "cd-short" })),
      ),
    );
    el.addEventListener("click", (e) => {
      if (this.suppressClick) return;
      const ref = this.cards.get(item.id)!;
      if ((e.target as HTMLElement).closest(".card-check")) this.cb.toggle(ref.item);
      else {
        this.select(ref.item.id, false);
        this.cb.open(ref.item);
      }
    });
    if (item.kind === "assignment") {
      const handle = h("div", { class: "card-handle", title: "Drag to move deadline" });
      el.append(handle);
      this.bindDrag(handle, item.id);
    }
    return el;
  }

  private fillCard(ref: CardRef, lane: number, lanes: number, span: number) {
    const { el, item } = ref;
    el.style.setProperty("--s", String(this.min(item.startMs)));
    el.style.setProperty("--e", String(this.min(item.endMs)));
    el.style.setProperty("--lane", String(lane));
    el.style.setProperty("--lanes", String(lanes));
    el.style.setProperty("--span", String(span));
    const isReview = item.kind === "review";
    el.querySelector(".card-title")!.textContent = isReview ? `↻ ${fmtDay(item.startMs).split(" ")[0]} lecture` : item.title;
    el.querySelector(".card-short")!.textContent = isReview ? "↻" : shortTitle(item.title);
    el.querySelector(".card-due")!.textContent = `${fmtDay(item.endMs)} ${fmtTime(item.endMs)}`;
    el.title = `${item.title}\n${fmtFull(item.startMs)} → ${fmtFull(item.endMs)}`;
    el.classList.toggle("selected", this.selectedId === item.id);
    this.updateCard(ref);
  }

  private updateCard(ref: CardRef) {
    const { el, item } = ref;
    const u = urgencyOf(item.startMs, item.endMs, item.done, this.now);
    if (el.dataset.u !== u) el.dataset.u = u;
    const left = item.endMs - this.now;
    // The chip sits at the card's bottom edge, i.e. the deadline, so it always counts down to the deadline.
    const long = u === "done" ? "done" : u === "overdue" ? `${fmtSpan(left)} late` : fmtSpan(left);
    const short = u === "done" ? "✓" : u === "overdue" ? `-${fmtSpanShort(left)}` : fmtSpanShort(left);
    const [longEl, shortEl] = el.querySelector(".card-cd")!.children as unknown as [HTMLElement, HTMLElement];
    if (longEl.textContent !== long) longEl.textContent = long;
    if (shortEl.textContent !== short) shortEl.textContent = short;
  }

  // ---- clock ------------------------------------------------------------------------

  tick(now: number) {
    this.now = now;
    this.root.style.setProperty("--now", this.min(now).toFixed(2));
    $("nowPill").textContent = fmtTime(now);
    for (const ref of this.visible) this.updateCard(ref);
  }

  // ---- zoom & scroll ------------------------------------------------------------------

  private applyZoom() {
    this.root.style.setProperty("--ppm", String(this.ppm));
    const density = this.pxh < 1.2 ? "tiny" : this.pxh < 4 ? "low" : this.pxh < 16 ? "mid" : "high";
    if (density !== this.density) {
      this.density = density;
      this.canvas.dataset.density = density;
      for (const d of this.visibleDays) this.fillHours(d);
    }
    const hours = (this.scroller.clientHeight - this.headsH) / this.pxh;
    $("zoomLabel").textContent =
      hours < 36 ? `${Math.round(hours)} h` : hours < 24 * 10 ? `${Math.round(hours / 24)} d` : `${Math.round(hours / 168)} wk`;
  }

  /** Zooms keeping the time under `clientY` (default: viewport centre) fixed on screen. */
  zoomTo(pxh: number, clientY?: number) {
    const next = Math.min(MAX_PXH, Math.max(MIN_PXH, pxh));
    if (Math.abs(next - this.pxh) < 1e-3) return;
    const rect = this.scroller.getBoundingClientRect();
    const y = clientY ?? rect.top + this.headsH + (rect.height - this.headsH) / 2;
    const anchor = this.timeAtY(y);
    this.pxh = next;
    this.applyZoom();
    this.scroller.scrollTop += this.min(anchor) * this.ppm - (y - this.grid.getBoundingClientRect().top);
    store(next);
  }

  zoomBy(factor: number, clientY?: number) {
    this.zoomTo(this.pxh * factor, clientY);
  }

  /** Scrolls so `ms` sits at `fraction` of the visible timeline height. */
  scrollToTime(ms: number, fraction = 0.3, smooth = false) {
    const visibleH = this.scroller.clientHeight - this.headsH;
    const clamped = Math.min(Math.max(this.min(ms), 0), this.totalMin);
    this.scroller.scrollTo({ top: clamped * this.ppm - visibleH * fraction, behavior: smooth ? "smooth" : "auto" });
  }

  private resizeAnchor: { time: number; frac: number } | null = null;

  /** Keeps whatever time was at the viewport centre in place when the viewport changes size. */
  onResize() {
    if (this.resizeAnchor) this.scrollToTime(this.resizeAnchor.time, this.resizeAnchor.frac);
    this.applyZoom();
  }

  /** Records the current centre time; call on scroll. */
  rememberAnchor() {
    const visibleH = this.scroller.clientHeight - this.headsH;
    this.resizeAnchor = { time: this.origin + ((this.scroller.scrollTop + visibleH / 2) / this.ppm) * MINUTE, frac: 0.5 };
  }

  private bindGestures() {
    this.scroller.addEventListener("scroll", () => this.rememberAnchor(), { passive: true });
    // Trackpad pinch / ctrl+wheel.
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientY);
      },
      { passive: false },
    );

    // Touch pinch.
    let pinch: { dist: number; pxh: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    this.scroller.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) pinch = { dist: dist(e.touches), pxh: this.pxh };
      },
      { passive: true },
    );
    this.scroller.addEventListener(
      "touchmove",
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
        this.zoomTo(pinch.pxh * (dist(e.touches) / pinch.dist), midY);
      },
      { passive: false },
    );
    this.scroller.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) pinch = null;
    });
  }

  // ---- column reordering -------------------------------------------------------------

  /** Drag a course header sideways to reorder columns. A plain click still opens the course panel. */
  private bindReorder(head: HTMLElement, id: string) {
    head.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest(".head-link")) return;
      const startX = down.clientX;
      let dragging = false;
      let ids: string[] = [];
      let centers: number[] = [];
      let from = 0;
      let to = 0;
      let width = 0;

      const shift = (courseId: string, px: number) => {
        const c = this.columns.get(courseId);
        if (!c) return;
        c.head.style.transform = px ? `translateX(${px}px)` : "";
        c.col.style.transform = px ? `translateX(${px}px)` : "";
      };

      const move = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        if (!dragging) {
          if (Math.abs(dx) < 6) return;
          dragging = true;
          ids = [...this.columns.entries()]
            .sort((a, b) => a[1].head.getBoundingClientRect().left - b[1].head.getBoundingClientRect().left)
            .map(([cid]) => cid);
          centers = ids.map((cid) => {
            const r = this.columns.get(cid)!.head.getBoundingClientRect();
            return r.left + r.width / 2;
          });
          from = to = ids.indexOf(id);
          width = head.getBoundingClientRect().width;
          this.heads.classList.add("reordering");
          this.cols.classList.add("reordering");
          this.columns.get(id)!.col.classList.add("dragging");
          head.classList.add("dragging");
        }
        const x = centers[from]! + dx;
        to = centers.filter((c, i) => i !== from && c < x).length;
        ids.forEach((cid, i) => {
          if (i === from) shift(cid, dx);
          else if (from < to && i > from && i <= to) shift(cid, -width);
          else if (from > to && i >= to && i < from) shift(cid, width);
          else shift(cid, 0);
        });
      };

      // Window listeners: the pointer leaves the header as soon as the drag starts.
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!dragging) return;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        this.heads.classList.remove("reordering");
        this.cols.classList.remove("reordering");
        this.columns.get(id)?.col.classList.remove("dragging");
        head.classList.remove("dragging");
        ids.forEach((cid) => shift(cid, 0));
        if (to !== from) {
          const next = ids.filter((cid) => cid !== id);
          next.splice(to, 0, id);
          this.cb.reorderCourses(next);
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  // ---- deadline drag ------------------------------------------------------------------

  private bindDrag(handle: HTMLElement, id: string) {
    handle.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      down.stopPropagation();
      const ref = this.cards.get(id);
      if (!ref) return;
      const { el, item } = ref;
      const startY = down.clientY;
      const origEnd = this.min(item.endMs);
      const minEnd = this.min(item.startMs) + 15;
      let end = origEnd;
      handle.setPointerCapture(down.pointerId);
      el.classList.add("dragging");

      const move = (e: PointerEvent) => {
        const raw = origEnd + (e.clientY - startY) / this.ppm;
        const snap = this.pxh >= 16 ? 15 : this.pxh >= 4 ? 60 : 360;
        end = Math.max(minEnd, Math.round(raw / snap) * snap);
        el.style.setProperty("--e", String(end));
        handle.dataset.tip = fmtFull(this.origin + end * MINUTE);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        el.classList.remove("dragging");
        delete handle.dataset.tip;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (end !== origEnd) this.cb.moveDeadline(item, this.origin + end * MINUTE);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ---- selection (keyboard) --------------------------------------------------------------

  select(id: string | null, scroll = true) {
    if (this.selectedId) this.cards.get(this.selectedId)?.el.classList.remove("selected");
    this.selectedId = id;
    const ref = id ? this.cards.get(id) : undefined;
    if (!ref) return;
    ref.el.classList.add("selected");
    if (scroll) this.scrollToTime(ref.item.endMs, 0.6, true);
  }

  /** Moves selection chronologically by deadline. Starts from the item closest to now. */
  selectStep(dir: 1 | -1) {
    const list = this.items.filter((i) => this.cards.has(i.id));
    if (!list.length) return;
    let idx = list.findIndex((i) => i.id === this.selectedId);
    if (idx === -1) {
      idx = list.findIndex((i) => i.endMs >= this.now);
      if (idx === -1) idx = list.length - 1;
      else if (dir === -1) idx = Math.max(0, idx - 1);
    } else idx = Math.min(list.length - 1, Math.max(0, idx + dir));
    this.select(list[idx]!.id);
  }

  selected(): TimelineItem | undefined {
    return this.selectedId ? this.cards.get(this.selectedId)?.item : undefined;
  }
}
