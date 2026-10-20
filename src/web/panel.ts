// Side panel (desktop) / bottom sheet (mobile) for viewing and editing a single thing.

import type { TimelineItem } from "../shared/expand";
import type { AppState, Course, Marker } from "../shared/schema";
import { MINUTE, localInput, parseInstant, weekdayOf } from "../shared/time";
import { api } from "./api";
import { $, fmtFull, fmtSpan, fmtTime, h, urgencyOf } from "./util";

export interface PanelHost {
  state(): AppState;
  toggle(item: TimelineItem): Promise<void>;
  mutate(action: () => Promise<unknown>, message?: string): Promise<boolean>;
  items(): TimelineItem[];
}

type Target = { kind: "item"; id: string } | { kind: "course"; id: string } | { kind: "marker"; id: string };

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class Panel {
  private el = $("panel");
  private scrim = $("scrim");
  private target: Target | null = null;
  private dirty = false;

  constructor(private host: PanelHost) {
    this.scrim.addEventListener("click", () => this.close());
  }

  get isOpen() {
    return this.target !== null;
  }

  openItem(item: TimelineItem) {
    this.show({ kind: "item", id: item.id });
  }
  openCourse(course: Course) {
    this.show({ kind: "course", id: course.id });
  }
  openMarker(marker: Marker) {
    this.show({ kind: "marker", id: marker.id });
  }

  close() {
    if (!this.target) return;
    this.target = null;
    this.dirty = false;
    this.el.classList.remove("open");
    this.el.setAttribute("aria-hidden", "true");
    this.scrim.hidden = true;
    document.body.classList.remove("panel-open");
  }

  /** Called after state refreshes. Re-renders unless the user is mid-edit. */
  refresh() {
    if (!this.target || this.dirty) return;
    this.render();
  }

  private show(target: Target) {
    this.target = target;
    this.dirty = false;
    this.render();
    this.el.classList.add("open");
    this.el.setAttribute("aria-hidden", "false");
    this.scrim.hidden = false;
    document.body.classList.add("panel-open");
  }

  private render() {
    const t = this.target!;
    const state = this.host.state();
    let content: HTMLElement | null = null;
    if (t.kind === "item") {
      const item = this.host.items().find((i) => i.id === t.id);
      content = item ? (item.kind === "assignment" ? this.assignmentView(item, state) : this.reviewView(item, state)) : null;
    } else if (t.kind === "course") {
      const course = state.courses.find((c) => c.id === t.id);
      content = course ? this.courseView(course, state) : null;
    } else {
      const marker = state.markers.find((m) => m.id === t.id);
      content = marker ? this.markerView(marker) : null;
    }
    if (!content) return this.close();
    this.el.replaceChildren(h("div", { class: "grabber", "aria-hidden": "true" }), content);
  }

  // ---- building blocks -----------------------------------------------------------------

  private header(course: Course | undefined, eyebrow: string, title: string) {
    return h(
      "header",
      { class: "p-head", style: course ? `--c:${course.color}` : "" },
      h(
        "div",
        { class: "p-titles" },
        h("span", { class: "p-eyebrow" }, h("span", { class: "head-dot" }), eyebrow),
        h("h2", {}, title),
      ),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => this.close() }, "✕"),
    );
  }

  private field(label: string, input: HTMLElement, hint?: string) {
    input.addEventListener("input", () => (this.dirty = true));
    return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
  }

  private doneButton(item: TimelineItem) {
    return h(
      "button",
      {
        class: `done-btn${item.done ? " is-done" : ""}`,
        type: "button",
        onclick: async () => {
          await this.host.toggle(item);
        },
      },
      h("span", { class: "done-box" }),
      item.done ? "Done" : "Mark as done",
    );
  }

  private status(item: TimelineItem) {
    const now = Date.now();
    const u = urgencyOf(item.startMs, item.endMs, item.done, now);
    const text =
      u === "done"
        ? "Completed"
        : u === "overdue"
          ? `Overdue by ${fmtSpan(now - item.endMs)}`
          : u === "future"
            ? `Opens in ${fmtSpan(item.startMs - now)}`
            : `Due in ${fmtSpan(item.endMs - now)}`;
    return h(
      "div",
      { class: "p-status", "data-u": u },
      h("strong", {}, text),
      h("span", {}, `${fmtFull(item.startMs)} → ${fmtFull(item.endMs)}`),
    );
  }

  private linkButton(href: string | null | undefined, label: string) {
    return href ? h("a", { class: "btn ghost", href, target: "_blank", rel: "noopener noreferrer" }, label, " ↗") : null;
  }

  // ---- views -------------------------------------------------------------------------------

  private assignmentView(item: TimelineItem, state: AppState) {
    const a = state.assignments.find((x) => x.id === item.id)!;
    const course = state.courses.find((c) => c.id === a.course_id);
    const title = h("input", { type: "text", value: a.title, required: true });
    const release = h("input", { type: "datetime-local", value: localInput(parseInstant(a.release_at)) });
    const due = h("input", { type: "datetime-local", value: localInput(parseInstant(a.due_at)) });
    const link = h("input", { type: "url", value: a.link ?? "", placeholder: course?.link ?? "https://…" });
    const notes = h("textarea", { rows: 4, placeholder: "Notes" });
    notes.value = a.notes;

    const save = async (e: Event) => {
      e.preventDefault();
      const ok = await this.host.mutate(
        () =>
          api.updateAssignment(a.id, {
            title: title.value.trim() || a.title,
            release_at: release.value,
            due_at: due.value,
            link: link.value.trim() || null,
            notes: notes.value,
          }),
        "Saved",
      );
      if (ok) {
        this.dirty = false;
        this.render();
      }
    };
    const remove = async () => {
      const hint = a.series_id ? "\n\nThis sheet is part of a series; skipping the week via Claude is usually better." : "";
      if (!confirm(`Delete “${a.title}”?${hint}`)) return;
      if (await this.host.mutate(() => api.deleteAssignment(a.id), "Deleted")) this.close();
    };

    return h(
      "form",
      { class: "p-body", onsubmit: save },
      this.header(course, course?.name ?? a.course_id, a.title),
      this.status(item),
      this.doneButton(item),
      this.field("Title", title),
      h("div", { class: "row2" }, this.field("Opens", release), this.field("Due", due)),
      this.field("Link", link, a.link ? undefined : "Empty = course page"),
      this.field("Notes", notes),
      a.series_id && !a.detached
        ? h("p", { class: "p-note" }, `Part of series “${a.series_id}”. Changing title or times detaches this sheet from the series.`)
        : a.detached
          ? h("p", { class: "p-note" }, "Edited individually. Series updates won't change this sheet.")
          : null,
      h(
        "div",
        { class: "p-actions" },
        h("button", { class: "btn primary", type: "submit" }, "Save"),
        this.linkButton(a.link ?? course?.link, "Open"),
        h("button", { class: "btn danger", type: "button", onclick: remove }, "Delete"),
      ),
    );
  }

  private reviewView(item: TimelineItem, state: AppState) {
    const [slotId, date] = item.id.split("@") as [string, string];
    const slot = state.lecture_slots.find((s) => s.id === slotId);
    const course = state.courses.find((c) => c.id === item.course_id);
    const lectureEnd = item.startMs;
    const lectureStart = slot ? parseInstant(`${date}T${slot.start_time}`) : lectureEnd;
    return h(
      "div",
      { class: "p-body" },
      this.header(course, `${course?.name ?? item.course_id} · Lecture review`, `Review ${WEEKDAYS[weekdayOf(date)]} lecture`),
      this.status(item),
      this.doneButton(item),
      h(
        "p",
        { class: "p-text" },
        `Lecture ${fmtFull(lectureStart)}–${fmtTime(lectureEnd)}. Go over the notes while it's fresh: `,
        h("strong", {}, "re-read, summarise, flag open questions."),
      ),
      h("div", { class: "p-actions" }, this.linkButton(course?.link, "Course page")),
    );
  }

  private courseView(course: Course, state: AppState) {
    const name = h("input", { type: "text", value: course.name });
    const short = h("input", { type: "text", value: course.short, maxlength: 8 });
    const color = h("input", { type: "color", value: course.color });
    const link = h("input", { type: "url", value: course.link ?? "", placeholder: "https://moodle…" });
    const slots = state.lecture_slots.filter((s) => s.course_id === course.id);
    const series = state.series.filter((s) => s.course_id === course.id);
    const open = state.assignments.filter((a) => a.course_id === course.id && !a.done).length;

    const save = async (e: Event) => {
      e.preventDefault();
      const ok = await this.host.mutate(
        () =>
          api.updateCourse(course.id, {
            name: name.value.trim() || course.name,
            short: short.value.trim() || course.short,
            color: color.value,
            link: link.value.trim() || null,
          }),
        "Saved",
      );
      if (ok) {
        this.dirty = false;
        this.render();
      }
    };
    const add = async () => {
      const start = Math.ceil(Date.now() / (15 * MINUTE)) * 15 * MINUTE;
      let created: { id: string } | undefined;
      const ok = await this.host.mutate(async () => {
        created = await api.createAssignment({
          course_id: course.id,
          title: "New assignment",
          release_at: new Date(start).toISOString(),
          due_at: new Date(start + 7 * 24 * 60 * MINUTE).toISOString(),
        });
      }, "Added");
      if (ok && created) this.show({ kind: "item", id: created.id });
    };

    return h(
      "form",
      { class: "p-body", onsubmit: save },
      this.header(course, "Course", course.name),
      h("div", { class: "p-status" }, h("strong", {}, `${open} open assignment${open === 1 ? "" : "s"}`)),
      this.field("Name", name),
      h("div", { class: "row2" }, this.field("Short", short), this.field("Color", color)),
      this.field("Course page", link),
      h(
        "div",
        { class: "p-list" },
        h("span", {}, "Lectures"),
        slots.length
          ? h("ul", {}, ...slots.map((s) => h("li", {}, `${WEEKDAYS[s.weekday]} ${s.start_time}–${s.end_time}`)))
          : h("small", {}, "None. Ask Claude to add lecture times to get review reminders."),
        h("span", {}, "Series"),
        series.length
          ? h("ul", {}, ...series.map((s) => h("li", {}, `${s.title_template.replace("{n}", "#")} · every ${s.every_days}d`)))
          : h("small", {}, "None"),
      ),
      h(
        "div",
        { class: "p-actions" },
        h("button", { class: "btn primary", type: "submit" }, "Save"),
        h("button", { class: "btn ghost", type: "button", onclick: add }, "+ Assignment"),
        this.linkButton(course.link, "Open"),
      ),
    );
  }

  private markerView(marker: Marker) {
    const label = h("input", { type: "text", value: marker.label });
    const at = h("input", { type: "datetime-local", value: localInput(parseInstant(marker.at)) });
    const end = h("input", { type: "datetime-local", value: marker.end_at ? localInput(parseInstant(marker.end_at)) : "" });
    const kindName = { semester: "Semester date", break: "Break", exam: "Exam", other: "Marker" }[marker.kind];

    const save = async (e: Event) => {
      e.preventDefault();
      const ok = await this.host.mutate(
        () =>
          api.updateMarker(marker.id, {
            label: label.value.trim() || marker.label,
            at: at.value,
            ...(marker.kind === "break" ? { end_at: end.value || null } : {}),
          }),
        "Saved",
      );
      if (ok) {
        this.dirty = false;
        this.render();
      }
    };
    const remove = async () => {
      if (!confirm(`Delete “${marker.label}”?`)) return;
      if (await this.host.mutate(() => api.deleteMarker(marker.id), "Deleted")) this.close();
    };
    return h(
      "form",
      { class: "p-body", onsubmit: save },
      this.header(undefined, kindName, marker.label),
      this.field("Label", label),
      marker.kind === "break"
        ? h("div", { class: "row2" }, this.field("From", at), this.field("Until", end))
        : this.field("When", at),
      h(
        "div",
        { class: "p-actions" },
        h("button", { class: "btn primary", type: "submit" }, "Save"),
        h("button", { class: "btn danger", type: "button", onclick: remove }, "Delete"),
      ),
    );
  }
}
