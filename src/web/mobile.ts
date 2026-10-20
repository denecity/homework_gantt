// Phone layout: one lane of "pennant" cards.
//
// A card's body floats wherever there is room, but its left side sweeps into a sharp point that
// touches the time axis at the exact DEADLINE — the cusp of a `{`. That decouples where a card sits
// from when it is due, so deadlines minutes apart can stack without crowding each other.
//
// The whole shape (taper + body) is one SVG path, so the outline stays continuous; the HTML card is a
// transparent overlay on the rectangular part, which keeps text, tap targets and the checkbox normal.
//
// Releases are no longer bars: each one is a dotted line across the lane with a short label saying
// what opens.

import { expandLectures, viewItems, type TimelineItem } from "../shared/expand";
import type { AppState, Course, Marker } from "../shared/schema";
import type { Settings } from "../shared/settings-defaults";
import { MINUTE, addDays, dateKey, parseInstant, startOfDay, weekdayOf } from "../shared/time";
import { $, fmtDay, fmtFull, fmtMonth, fmtSpan, fmtSpanShort, fmtTime, h, urgencyOf } from "./util";
import type { TimelineCallbacks, TimelineView } from "./view";

const CARD_H = 58;
const REVIEW_H = 40;
const GAP = 7;
const TAPER = 54; // horizontal room the cusp needs to read as a point
const RIGHT_PAD = 8;
const RADIUS = 12;
const RELEASE_H = 15;
const MIN_PXH = 5;
const MAX_PXH = 90;
const PXH_KEY = "hg.mpxh";
const SVG_NS = "http://www.w3.org/2000/svg";

interface Placed {
  item: TimelineItem;
  course: Course | undefined;
  top: number;
  height: number;
  dueY: number;
}

interface ReleaseMark {
  course: Course;
  title: string;
  y: number;
  labelTop: number;
}

interface CardRef {
  el: HTMLElement;
  item: TimelineItem;
}

const read = () => {
  try {
    const v = Number(localStorage.getItem(PXH_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const store = (v: number) => {
  try {
    localStorage.setItem(PXH_KEY, String(v));
  } catch {
    /* per-device convenience only */
  }
};

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

export class MobileTimeline implements TimelineView {
  private root = document.documentElement;
  private scroller = $("scroller");
  private canvas = $("mcanvas");
  private gutter = h("div", { class: "mgut" });
  private grid = h("div", { class: "mgrid" });
  private marks = h("div", { class: "mlayer mmarks" });
  private rails = h("div", { class: "mlayer mrails" });
  private releases = h("div", { class: "mlayer mreleases" });
  private shapes = document.createElementNS(SVG_NS, "svg");
  private lane = h("div", { class: "mlane" });
  private nowLine = h("div", { class: "mnow" }, h("b", { id: "mNowPill" }));

  origin = 0;
  items: TimelineItem[] = [];
  selectedId: string | null = null;

  private pxh: number;
  private viewSig = "";
  private dataSig = "";
  private lastDate = "";
  private now = Date.now();
  private width = 0;
  private placed: Placed[] = [];
  private releaseMarks: ReleaseMark[] = [];
  private cards = new Map<string, CardRef>();
  private visible = new Set<CardRef>();
  private state: AppState | null = null;

  private observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const ref = this.cards.get((e.target as HTMLElement).dataset.id!);
        if (!ref) continue;
        if (e.isIntersecting) {
          this.visible.add(ref);
          this.paintCard(ref);
        } else this.visible.delete(ref);
      }
    },
    { root: this.scroller, rootMargin: "60% 0px" },
  );

  constructor(
    private cb: TimelineCallbacks,
    settings: Settings,
  ) {
    this.pxh = (settings.remember_zoom ? read() : null) ?? settings.phone_zoom_pxh;
    this.shapes.setAttribute("class", "mshapes");
    this.canvas.replaceChildren(this.gutter, this.grid);
    this.grid.append(this.marks, this.rails, this.releases, this.shapes, this.lane, this.nowLine);
    document.body.dataset.view = "mobile";
    this.applyZoom();
    this.bindPinch();
  }

  destroy() {
    this.observer.disconnect();
    this.canvas.replaceChildren();
    this.cards.clear();
    this.visible.clear();
    delete document.body.dataset.view;
  }

  private min(ms: number) {
    return (ms - this.origin) / MINUTE;
  }
  private y(ms: number) {
    return this.min(ms) * (this.pxh / 60);
  }

  // ---- render --------------------------------------------------------------------------

  render(state: AppState) {
    this.state = state;
    const today = dateKey(Date.now());
    const first = state.semester?.starts_on ?? addDays(today, -7);
    const last = state.semester?.ends_on ?? addDays(today, 60);
    const viewSig = `${first}|${last}`;
    const changed = viewSig !== this.viewSig;
    if (changed) {
      this.viewSig = viewSig;
      this.origin = startOfDay(first);
      this.lastDate = last;
    }

    this.items = viewItems(state);
    const sig = JSON.stringify([
      this.items.map((i) => [i.id, i.startMs, i.endMs, i.done, i.title]),
      state.courses.map((c) => [c.id, c.color, c.short]),
      state.markers.map((m) => [m.id, m.at, m.end_at, m.kind, m.label]),
      state.lecture_slots.map((s) => [s.id, s.weekday, s.start_time, s.end_time, s.skip_dates]),
      [state.settings.show_lectures, state.settings.show_release_marks],
      state.settings.show_release_marks ? state.assignments.map((a) => [a.id, a.release_at]) : [],
    ]);
    if (sig !== this.dataSig || changed || this.width !== this.grid.clientWidth) {
      this.dataSig = sig;
      this.layout();
    }
    this.tick(this.now);
  }

  /** Chronological sweep: a card wants its middle on the deadline, and gives way to the one above. */
  private layout() {
    const state = this.state!;
    const courses = new Map(state.courses.map((c) => [c.id, c]));
    this.width = this.grid.clientWidth || Math.max(this.scroller.clientWidth - 44, 240);

    // Cards and release labels share one chronological sweep, so a label never lands on a card.
    // The dotted line and the pennant tip keep their exact time; only the boxes give way.
    type Block =
      | { kind: "card"; at: number; height: number; item: TimelineItem }
      | { kind: "rel"; at: number; height: number; course: Course; title: string };

    const blocks: Block[] = this.items
      .filter((i) => courses.has(i.course_id))
      .map((item) => ({ kind: "card" as const, at: item.endMs, height: item.kind === "review" ? REVIEW_H : CARD_H, item }));

    if (state.settings.show_release_marks) {
      for (const a of state.assignments) {
        const course = courses.get(a.course_id);
        if (!course) continue;
        blocks.push({ kind: "rel", at: parseInstant(a.release_at), height: RELEASE_H, course, title: a.title });
      }
    }
    blocks.sort((a, b) => a.at - b.at);

    const placed: Placed[] = [];
    const marks: ReleaseMark[] = [];
    let floor = -Infinity;

    for (const block of blocks) {
      const y = this.y(block.at);
      // A card prefers its middle on the deadline; a label hangs just under its line.
      const ideal = block.kind === "card" ? y - block.height / 2 : y + 2;
      const top = Math.max(ideal, floor + GAP);
      floor = top + block.height;
      if (block.kind === "card") {
        placed.push({ item: block.item, course: courses.get(block.item.course_id), top, height: block.height, dueY: y });
      } else {
        marks.push({ course: block.course, title: block.title, y, labelTop: top });
      }
    }
    this.placed = placed;
    this.releaseMarks = marks;

    const end = this.y(startOfDay(addDays(this.lastDate, 1)));
    const bottom = Math.max(
      placed.reduce((m, p) => Math.max(m, p.top + p.height), end),
      marks.reduce((m, r) => Math.max(m, r.labelTop + RELEASE_H), end),
    );
    this.canvas.style.height = `${bottom + 48}px`;

    this.renderGrid();
    this.renderMarkers();
    this.renderReleases();
    this.renderCards();
  }

  private renderGrid() {
    const state = this.state!;
    this.gutter.replaceChildren();
    const first = dateKey(this.origin);
    const dense = this.pxh >= 14;

    for (let date = first; date <= this.lastDate; date = addDays(date, 1)) {
      const top = this.y(startOfDay(date));
      const height = this.y(startOfDay(addDays(date, 1))) - top;
      const weekday = weekdayOf(date);
      const dayStart = startOfDay(date);
      const cls = `mday${weekday >= 6 ? " wknd" : ""}${weekday === 1 ? " mon" : ""}`;
      this.gutter.append(
        h(
          "div",
          { class: cls, style: `top:${top}px;height:${height}px` },
          h(
            "div",
            { class: "mdlab" },
            h("i", {}, fmtDay(dayStart).split(" ")[0]!),
            h("b", {}, String(Number(date.slice(8)))),
            date.endsWith("-01") || date === first ? h("u", {}, fmtMonth(dayStart)) : null,
          ),
        ),
      );
      if (dense) {
        for (const hour of [6, 12, 18]) {
          this.gutter.append(h("span", { class: "mhlab", style: `top:${top + hour * this.pxh}px` }, `${String(hour).padStart(2, "0")}:00`));
        }
      }
    }

    this.rails.replaceChildren(
      ...(state.settings.show_lectures ? expandLectures(state.lecture_slots, state.semester, state.markers) : []).map((lec) => {
        const course = state.courses.find((c) => c.id === lec.course_id);
        return h("div", {
          class: "mlec",
          style: `--c:${course?.color ?? "#888"};top:${this.y(lec.startMs)}px;height:${Math.max(this.y(lec.endMs) - this.y(lec.startMs), 2)}px`,
          title: `${course?.name ?? lec.course_id} lecture ${fmtTime(lec.startMs)}–${fmtTime(lec.endMs)}`,
        });
      }),
    );
  }

  /** Dotted line where something opens, with a small label under it. */
  private renderReleases() {
    this.releases.replaceChildren(
      ...this.releaseMarks.map(({ course, title, y, labelTop }) =>
        h(
          "div",
          { class: "mrel", style: `--c:${course.color};top:${y}px` },
          h("span", { class: "mrel-label", style: `top:${labelTop - y}px` }, `${course.short} ${title} opens`),
        ),
      ),
    );
  }

  private renderMarkers() {
    const state = this.state!;
    const open = (m: Marker) => () => this.cb.openMarker(m);
    this.marks.replaceChildren(
      ...state.markers.map((m) => {
        const at = parseInstant(m.at);
        const top = this.y(at);
        if (m.kind === "break") {
          const end = m.end_at ? this.y(parseInstant(m.end_at)) : top + 24 * this.pxh;
          return h(
            "div",
            { class: "mbreak", style: `top:${top}px;height:${end - top}px` },
            h("button", { class: "mmlabel", type: "button", onclick: open(m) }, m.label),
          );
        }
        const course = m.course_id ? state.courses.find((c) => c.id === m.course_id) : undefined;
        return h(
          "div",
          { class: `mline mline-${m.kind}`, style: `top:${top}px${course ? `;--mk:${course.color}` : ""}` },
          h("button", { class: "mmlabel", type: "button", onclick: open(m) }, m.kind === "exam" ? "◆ " : "", m.label, h("small", {}, fmtFull(at))),
        );
      }),
    );
  }

  /** Point on the axis at the deadline, swept out into the card's rounded body. */
  private pennantPath(p: Placed): string {
    const t = p.top;
    const b = p.top + p.height;
    const right = Math.max(this.width - RIGHT_PAD, TAPER + 40);
    const dy = p.dueY;
    const bend = TAPER * 0.55;
    return (
      `M 0 ${dy} ` +
      `C ${bend} ${dy}, ${TAPER - 14} ${t}, ${TAPER + 6} ${t} ` +
      `L ${right - RADIUS} ${t} Q ${right} ${t} ${right} ${t + RADIUS} ` +
      `L ${right} ${b - RADIUS} Q ${right} ${b} ${right - RADIUS} ${b} ` +
      `L ${TAPER + 6} ${b} ` +
      `C ${TAPER - 14} ${b}, ${bend} ${dy}, 0 ${dy} Z`
    );
  }

  private renderCards() {
    const live = new Set<string>();
    const frag = document.createDocumentFragment();
    const paths = document.createDocumentFragment();
    this.shapes.setAttribute("width", String(this.width));
    this.shapes.setAttribute("height", this.canvas.style.height.replace("px", "") || "0");

    for (const p of this.placed) {
      live.add(p.item.id);
      let ref = this.cards.get(p.item.id);
      if (!ref) {
        ref = { el: this.createCard(p.item), item: p.item };
        this.cards.set(p.item.id, ref);
        this.observer.observe(ref.el);
      }
      ref.item = p.item;

      const color = p.course?.color ?? "#888";
      const el = ref.el;
      const review = p.item.kind === "review";
      el.className = `mcard${review ? " review" : ""}${this.selectedId === p.item.id ? " sel" : ""}`;
      el.style.cssText = `--c:${color};top:${p.top}px;height:${p.height}px;left:${TAPER + 8}px;right:${RIGHT_PAD + 4}px`;

      const badge = el.querySelector(".mbdg")!;
      const title = el.querySelector(".mtitle")!;
      const sub = el.querySelector(".msub")!;
      if (review) {
        badge.textContent = "↻";
        title.textContent = `${p.course?.short ?? p.item.course_id} lecture`;
        sub.textContent = "";
      } else {
        badge.textContent = p.course?.short ?? p.item.course_id;
        title.textContent = p.item.title;
        sub.textContent = `due ${fmtDay(p.item.endMs)} ${fmtTime(p.item.endMs)}`;
      }
      el.title = `${p.course?.name ?? ""} ${p.item.title}\ndue ${fmtFull(p.item.endMs)}`;
      frag.append(el);

      const d = this.pennantPath(p);
      const dim = p.item.done ? 0.4 : 1;
      // A background-coloured halo first, so pennants stacked tightly stay separable.
      paths.append(
        svgEl("path", { d, fill: "none", stroke: "var(--bg-2)", "stroke-width": 3.5, opacity: dim }),
        svgEl("path", {
          d,
          fill: review ? `color-mix(in oklab, ${color} 7%, var(--bg-2))` : `color-mix(in oklab, ${color} 13%, var(--surface))`,
          stroke: `color-mix(in oklab, ${color} ${review ? 45 : 38}%, transparent)`,
          "stroke-width": 1,
          "stroke-dasharray": review ? "4 3" : "none",
          opacity: dim,
        }),
        svgEl("circle", { cx: 0, cy: p.dueY, r: 2.8, fill: color, opacity: dim }),
      );
    }

    for (const [id, ref] of this.cards) {
      if (live.has(id)) continue;
      this.observer.unobserve(ref.el);
      this.visible.delete(ref);
      this.cards.delete(id);
    }
    this.shapes.replaceChildren(paths);
    this.lane.replaceChildren(frag);
    for (const ref of this.cards.values()) this.paintCard(ref);
    if (this.selectedId && !this.cards.has(this.selectedId)) this.selectedId = null;
  }

  private createCard(item: TimelineItem): HTMLElement {
    const el = h(
      "div",
      { class: "mcard", "data-id": item.id, tabindex: "-1" },
      h("button", { class: "mchk", type: "button", "aria-label": "Toggle done" }),
      h("div", { class: "mbody" }, h("div", { class: "ml1" }, h("span", { class: "mbdg" }), h("b", { class: "mtitle" })), h("div", { class: "msub" })),
      h("div", { class: "mcd" }, h("b", {}), h("span", {})),
    );
    el.addEventListener("click", (e) => {
      const ref = this.cards.get(item.id);
      if (!ref) return;
      if ((e.target as HTMLElement).closest(".mchk")) this.cb.toggle(ref.item);
      else {
        this.select(ref.item.id, false);
        this.cb.open(ref.item);
      }
    });
    return el;
  }

  private paintCard(ref: CardRef) {
    const { el, item } = ref;
    const u = urgencyOf(item.startMs, item.endMs, item.done, this.now);
    if (el.dataset.u !== u) el.dataset.u = u;
    const left = item.endMs - this.now;
    const [big, small] = el.querySelector(".mcd")!.children as unknown as [HTMLElement, HTMLElement];
    const text = u === "done" ? "✓" : item.kind === "review" ? fmtSpanShort(left) : fmtSpan(left);
    if (big.textContent !== text) big.textContent = text;
    const label = u === "done" ? "done" : u === "overdue" ? "late" : "left";
    if (small.textContent !== label) small.textContent = label;
  }

  // ---- clock, zoom, scroll ----------------------------------------------------------------

  tick(now: number) {
    this.now = now;
    this.root.style.setProperty("--now", this.min(now).toFixed(2));
    this.nowLine.style.top = `${this.y(now)}px`;
    const pill = document.getElementById("mNowPill");
    if (pill) pill.textContent = fmtTime(now);
    for (const ref of this.visible) this.paintCard(ref);
  }

  private applyZoom() {
    this.root.style.setProperty("--mppm", String(this.pxh / 60));
    const hours = this.scroller.clientHeight / this.pxh;
    const label = document.getElementById("zoomLabel");
    if (label) label.textContent = hours < 36 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
  }

  zoomTo(pxh: number, clientY?: number) {
    const next = Math.min(MAX_PXH, Math.max(MIN_PXH, pxh));
    if (Math.abs(next - this.pxh) < 1e-3) return;
    const rect = this.scroller.getBoundingClientRect();
    const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top + this.scroller.scrollTop;
    const anchorMs = this.origin + (anchorY / (this.pxh / 60)) * MINUTE;
    this.pxh = next;
    store(next);
    this.applyZoom();
    this.layout();
    this.scroller.scrollTop = this.y(anchorMs) - ((clientY ?? rect.top + rect.height / 2) - rect.top);
    this.tick(this.now);
  }

  zoomBy(factor: number, clientY?: number) {
    this.zoomTo(this.pxh * factor, clientY);
  }

  scrollToTime(ms: number, fraction = 0.3, smooth = false) {
    this.scroller.scrollTo({ top: Math.max(0, this.y(ms) - this.scroller.clientHeight * fraction), behavior: smooth ? "smooth" : "auto" });
  }

  onResize() {
    this.applyZoom();
    if (this.width !== this.grid.clientWidth) this.layout();
  }

  private bindPinch() {
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
        this.zoomTo(pinch.pxh * (dist(e.touches) / pinch.dist), (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2);
      },
      { passive: false },
    );
    this.scroller.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) pinch = null;
    });
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientY);
      },
      { passive: false },
    );
  }

  // ---- selection --------------------------------------------------------------------------

  select(id: string | null, scroll = true) {
    if (this.selectedId) this.cards.get(this.selectedId)?.el.classList.remove("sel");
    this.selectedId = id;
    const ref = id ? this.cards.get(id) : undefined;
    if (!ref) return;
    ref.el.classList.add("sel");
    if (scroll) this.scrollToTime(ref.item.endMs, 0.5, true);
  }

  selectStep(dir: 1 | -1) {
    const list = this.placed.map((p) => p.item);
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
