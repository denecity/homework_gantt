// Phone layout: one full-width lane instead of per-course columns.
//
// A card is anchored at its DEADLINE (its bottom edge) and a thin tail runs up to the RELEASE,
// so both instants stay readable while the text gets the whole screen width. When two deadlines
// are too close for both cards, the later one is pushed down and keeps a dotted leader back to
// its true time.
//
// Positions are resolved in pixels (stacking needs real heights), so layout runs on data or zoom
// changes only. The clock tick just moves `--now` and refreshes visible countdowns.

import { expandLectures, packLanes, viewItems, type TimelineItem } from "../shared/expand";
import type { AppState, Course, Marker } from "../shared/schema";
import type { Settings } from "../shared/settings-defaults";
import { HOUR, MINUTE, addDays, dateKey, parseInstant, startOfDay, weekdayOf } from "../shared/time";
import { $, fmtDay, fmtFull, fmtMonth, fmtSpan, fmtSpanShort, fmtTime, h, urgencyOf } from "./util";
import type { TimelineCallbacks, TimelineView } from "./view";

const CARD_H = 62;
const RAILS = 4; // tail sub-rails before colours start repeating
const RAIL_W = 4;
const REVIEW_H = 40;
const GAP = 6;
const MIN_PXH = 5;
const MAX_PXH = 90;
const PXH_KEY = "hg.mpxh";

interface Placed {
  item: TimelineItem;
  course: Course | undefined;
  top: number;
  height: number;
  dueY: number;
  relY: number;
  pushed: boolean;
  /** Which sub-rail the tail uses, so concurrent windows stay distinguishable. */
  rail: number;
  /** 0 = work lane (exercises, deadlines, submissions), 1 = repetition lane. */
  lane: number;
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

export class MobileTimeline implements TimelineView {
  private root = document.documentElement;
  private scroller = $("scroller");
  private canvas = $("mcanvas");
  private gutter = h("div", { class: "mgut" });
  private grid = h("div", { class: "mgrid" });
  private marks = h("div", { class: "mlayer mmarks" });
  private rails = h("div", { class: "mlayer mrails" });
  private lane = h("div", { class: "mlane" });
  private heads = h("div", { class: "mheads" });
  private nowLine = h("div", { class: "mnow" }, h("b", { id: "mNowPill" }));

  origin = 0;
  items: TimelineItem[] = [];
  selectedId: string | null = null;

  private pxh: number;
  private viewSig = "";
  private dataSig = "";
  private now = Date.now();
  private placed: Placed[] = [];
  private split = true;
  private workPct = 58;
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

  constructor(private cb: TimelineCallbacks, settings: Settings) {
    this.pxh = (settings.remember_zoom ? read() : null) ?? settings.phone_zoom_pxh;
    this.canvas.replaceChildren(this.heads, this.gutter, this.grid);
    this.grid.append(this.marks, this.rails, this.lane, this.nowLine);
    document.body.dataset.view = "mobile";
    this.root.style.setProperty("--mheads-h", "34px");
    this.applyZoom();
    this.bindPinch();
  }

  destroy() {
    this.observer.disconnect();
    this.canvas.replaceChildren();
    this.cards.clear();
    this.visible.clear();
    delete document.body.dataset.view;
    delete document.body.dataset.split;
  }

  private min(ms: number) {
    return (ms - this.origin) / MINUTE;
  }
  private y(ms: number) {
    return this.min(ms) * (this.pxh / 60);
  }
  private get headsH() {
    return this.heads.offsetHeight;
  }

  /** Horizontal bounds of a lane, as percentages of the grid width. */
  private bounds(lane: number) {
    if (!this.split) return { left: 0, right: 0 };
    return lane === 0 ? { left: 0, right: 100 - this.workPct } : { left: this.workPct, right: 0 };
  }

  // ---- render ---------------------------------------------------------------------

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

    this.split = state.settings.lane_mode === "split" && state.settings.show_reviews;
    this.workPct = state.settings.work_lane_pct;
    this.items = viewItems(state);
    const sig = JSON.stringify([
      this.items.map((i) => [i.id, i.startMs, i.endMs, i.done, i.title]),
      state.courses.map((c) => [c.id, c.color, c.short]),
      state.markers.map((m) => [m.id, m.at, m.end_at, m.kind, m.label]),
      state.lecture_slots.map((s) => [s.id, s.weekday, s.start_time, s.end_time, s.skip_dates]),
      [this.split, this.workPct, state.settings.work_lane_label, state.settings.review_lane_label],
    ]);
    if (sig !== this.dataSig || changed) {
      this.dataSig = sig;
      this.layout();
    }
    this.tick(this.now);
  }

  private lastDate = "";

  /** Chronological sweep: ideal position is "bottom edge on the deadline", pushed down on collision. */
  private layout() {
    const state = this.state!;
    const courses = new Map(state.courses.map((c) => [c.id, c]));
    const visible = this.items.filter((i) => courses.has(i.course_id));
    // Tails are packed as intervals so two live windows never sit on the same rail.
    const rails = new Map(
      packLanes(visible.map((item) => ({ item, start: item.startMs, end: item.endMs }))).map((p) => [
        p.item.id,
        p.lane % RAILS,
      ]),
    );
    const sorted = [...visible].sort((a, b) => a.endMs - b.endMs);
    const placed: Placed[] = [];
    // Each lane stacks independently, so a busy week of exercises never pushes the reviews around.
    const floors = [-Infinity, -Infinity];

    for (const item of sorted) {
      const lane = this.split && item.kind === "review" ? 1 : 0;
      const height = item.kind === "review" ? REVIEW_H : CARD_H;
      const dueY = this.y(item.endMs);
      const relY = this.y(item.startMs);
      const top = Math.max(dueY - height, floors[lane]! + GAP);
      floors[lane] = top + height;
      placed.push({
        item,
        course: courses.get(item.course_id),
        top,
        height,
        dueY,
        relY,
        pushed: top + height - dueY > 1,
        rail: rails.get(item.id) ?? 0,
        lane,
      });
    }
    this.placed = placed;

    const end = this.y(startOfDay(addDays(this.lastDate, 1)));
    const bottom = placed.reduce((m, p) => Math.max(m, p.top + p.height), end);
    this.canvas.style.height = `${bottom + 40}px`;

    this.renderHeads();
    this.renderGrid();
    this.renderMarkers();
    this.renderCards();
  }

  private renderHeads() {
    const s = this.state!.settings;
    this.heads.hidden = !this.split;
    document.body.dataset.split = this.split ? "1" : "0";
    this.root.style.setProperty("--work-pct", String(this.workPct));
    this.root.style.setProperty("--mheads-h", this.split ? "34px" : "0px");
    if (!this.split) return;
    this.heads.replaceChildren(
      h("div", { class: "mcorner" }),
      h("div", { class: "mhead work", style: `flex-basis:${this.workPct}%` }, s.work_lane_label),
      h("div", { class: "mhead review", style: `flex-basis:${100 - this.workPct}%` }, s.review_lane_label),
    );
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
          this.gutter.append(
            h("span", { class: "mhlab", style: `top:${top + hour * (this.pxh)}px` }, `${String(hour).padStart(2, "0")}:00`),
          );
        }
      }
    }

    // lecture ticks live in the gutter so they never collide with cards
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
          h(
            "button",
            { class: "mmlabel", type: "button", onclick: open(m) },
            m.kind === "exam" ? "◆ " : "",
            m.label,
            h("small", {}, fmtFull(at)),
          ),
        );
      }),
    );
  }

  private renderCards() {
    const live = new Set<string>();
    const frag = document.createDocumentFragment();

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
      const b = this.bounds(p.lane);
      el.className = `mcard${p.item.kind === "review" ? " review" : ""}${this.selectedId === p.item.id ? " sel" : ""}`;
      el.style.cssText =
        `--c:${color};--l:${b.left};--r:${b.right};top:${p.top}px;height:${p.height}px`;

      const badge = el.querySelector(".mbdg")!;
      const title = el.querySelector(".mtitle")!;
      const sub = el.querySelector(".msub")!;
      if (p.item.kind === "review") {
        badge.textContent = "↻";
        // The lane header and the card's position already say it is a lecture review on that day.
        title.textContent = p.course?.short ?? p.item.course_id;
        sub.textContent = "";
      } else {
        badge.textContent = p.course?.short ?? p.item.course_id;
        title.textContent = p.item.title;
        sub.textContent = `due ${fmtDay(p.item.endMs)} ${fmtTime(p.item.endMs)}`;
      }
      el.title = `${p.course?.name ?? ""} ${p.item.title}\n${fmtFull(p.item.startMs)} → ${fmtFull(p.item.endMs)}`;
      frag.append(el);

      // tail (release → deadline) + anchor dot + leader when displaced
      const topY = Math.max(p.relY, -60);
      const x = 4 + p.rail * RAIL_W;
      const at = (px: number) => `calc(${b.left}% + ${px}px)`;
      frag.append(
        h("div", {
          class: `mtail${p.item.done ? " done" : ""}`,
          style:
            `--c:${color};left:${at(x)};top:${topY}px;height:${Math.max(p.dueY - topY, 4)}px;` +
            `--s:${this.min(p.item.startMs)};--e:${this.min(p.item.endMs)}`,
        }),
        h("div", { class: "manchor", style: `--c:${color};left:${at(x - 2.5)};top:${p.dueY}px` }),
      );
      if (p.pushed) {
        frag.append(
          h("div", {
            class: "mlead",
            style: `--c:${color};left:${at(x)};width:${22 - x}px;top:${p.dueY}px;height:${p.top + p.height - p.dueY}px`,
          }),
        );
      }
    }

    for (const [id, ref] of this.cards) {
      if (live.has(id)) continue;
      this.observer.unobserve(ref.el);
      this.visible.delete(ref);
      this.cards.delete(id);
    }
    this.lane.replaceChildren(frag);
    for (const ref of this.cards.values()) this.paintCard(ref);
    if (this.selectedId && !this.cards.has(this.selectedId)) this.selectedId = null;
  }

  private createCard(item: TimelineItem): HTMLElement {
    const el = h(
      "div",
      { class: "mcard", "data-id": item.id, tabindex: "-1" },
      h("div", { class: "mfill" }),
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
    // Narrow lanes get the one-unit countdown so the title keeps the space.
    const compact = this.split || item.kind === "review";
    const text = u === "done" ? "✓" : compact ? fmtSpanShort(left) : fmtSpan(left);
    if (big.textContent !== text) big.textContent = text;
    const label = u === "done" ? "done" : u === "overdue" ? "late" : "left";
    if (small.textContent !== label) small.textContent = label;
  }

  // ---- clock, zoom, scroll -------------------------------------------------------------

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
    const visibleH = this.scroller.clientHeight;
    this.scroller.scrollTo({ top: Math.max(0, this.y(ms) - visibleH * fraction), behavior: smooth ? "smooth" : "auto" });
  }

  onResize() {
    this.applyZoom();
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
    void this.headsH;
    void HOUR;
  }

  // ---- selection ----------------------------------------------------------------------

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
