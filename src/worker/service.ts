import { z } from "zod";
import { expandSeries, isOverdue, timelineItems, type TimelineItem } from "../shared/expand";
import { DEFAULT_RULES, planNotifications } from "../shared/notify";
import { DEFAULT_SETTINGS, Settings, SettingsPatch, describeSettings, parseSettings } from "../shared/settings";
import {
  AssignmentInput,
  AssignmentPatch,
  CourseInput,
  CoursePatch,
  DateStr,
  Id,
  Instant,
  LectureSlotInput,
  LectureSlotPatch,
  MarkerInput,
  MarkerPatch,
  NotificationRuleInput,
  NotificationRulePatch,
  PushSubscriptionInput,
  SemesterInput,
  SeriesInput,
  SeriesPatch,
  type AppState,
  type NotificationRule,
  type Series,
} from "../shared/schema";
import { DAY, HOUR, addDays, localInput, parseInstant, startOfDay, toIso, weekdayOf, dateKey } from "../shared/time";
import { bytesToB64url, sendPush, type VapidKeys } from "./push";
import {
  HttpError,
  getAssignment,
  getCourse,
  getMarker,
  getRule,
  getSemester,
  getSeries,
  getSlot,
  listDevices,
  listSeriesAssignments,
  loadState,
  loadVersion,
  readSettings,
  upsert,
  write,
} from "./db";

export interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface Ctx {
  db: D1Database;
  env: Env;
  now: number;
}

export interface Operation<S extends z.ZodType = z.ZodType> {
  description: string;
  input: S;
  readOnly?: boolean;
  run(ctx: Ctx, input: z.infer<S>): Promise<unknown>;
}

const op = <S extends z.ZodType>(o: Operation<S>) => o;
const Empty = z.object({});
const ById = z.object({ id: Id });

// ---- helpers --------------------------------------------------------------------

const iso = (s: string) => toIso(parseInstant(s));
const isoOrNull = (s: string | null | undefined) => (s ? iso(s) : s === undefined ? undefined : null);
const local = (s: string) => localInput(parseInstant(s));

function assertRange(start: string, end: string) {
  if (parseInstant(end) < parseInstant(start)) throw new HttpError(400, "end must not be before start");
}

async function ensureCourse(db: D1Database, id: string) {
  await getCourse(db, id);
}

function seriesRow(s: Series) {
  return { ...s, skip_dates: JSON.stringify([...new Set(s.skip_dates)].sort()) };
}

/** Writes the series row and reconciles its assignments. Detached (individually edited) rows are left alone. */
async function saveSeries(db: D1Database, series: Series) {
  assertRange(series.first_release, series.first_due);
  const semester = await getSemester(db);
  const occurrences = expandSeries(series, semester);
  const existing = new Map((await listSeriesAssignments(db, series.id)).map((a) => [a.id, a]));
  const stmts: D1PreparedStatement[] = [upsert(db, "series", seriesRow(series))];

  for (const o of occurrences) {
    const prev = existing.get(o.id);
    existing.delete(o.id);
    if (prev?.detached) continue;
    if (prev) {
      stmts.push(
        db
          .prepare("UPDATE assignments SET seq = ?, title = ?, release_at = ?, due_at = ? WHERE id = ?")
          .bind(o.seq, o.title, o.release_at, o.due_at, o.id),
      );
    } else {
      stmts.push(
        db
          .prepare(
            "INSERT INTO assignments (id, course_id, series_id, seq, title, release_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(o.id, series.course_id, series.id, o.seq, o.title, o.release_at, o.due_at),
      );
    }
  }
  for (const stale of existing.values()) {
    if (!stale.detached) stmts.push(db.prepare("DELETE FROM assignments WHERE id = ?").bind(stale.id));
  }
  await write(db, stmts);
  return { series, occurrences: occurrences.length };
}

// ---- text formatting for Claude ------------------------------------------------------

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / 60_000);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

function describeItem(item: TimelineItem, state: AppState, now: number, anchor: "start" | "end" = "end") {
  const course = state.courses.find((c) => c.id === item.course_id);
  const ms = anchor === "end" ? item.endMs : item.startMs;
  const verb = anchor === "end" ? "due" : "releases";
  const tag = item.kind === "review" ? " [review]" : "";
  return `- ${course?.name ?? item.course_id}: ${item.title}${tag} — ${verb} ${fmt.format(ms)} (${relative(ms, now)})${item.done ? " ✓ done" : ""} [id: ${item.id}]`;
}

function briefing(state: AppState, now: number, days: number): string {
  const items = timelineItems(state);
  const horizon = now + days * DAY;
  const overdue = items.filter((i) => isOverdue(i, now, state.settings.review_grace_days));
  const due = items.filter((i) => !i.done && i.endMs >= now && i.endMs <= horizon);
  const releasing = items
    .filter((i) => i.kind === "assignment" && i.startMs > now && i.startMs <= horizon)
    .sort((a, b) => a.startMs - b.startMs);
  const exams = state.markers.filter((m) => m.kind === "exam" && parseInstant(m.at) >= now).slice(0, 5);
  const lines = [`Homework briefing — now ${fmt.format(now)} (Europe/Zurich)`];
  if (!state.semester) lines.push("", "No semester configured yet (use set_semester).");
  const section = (title: string, list: string[]) => {
    lines.push("", `## ${title}`, ...(list.length ? list : ["- nothing"]));
  };
  section("Overdue", overdue.map((i) => describeItem(i, state, now)));
  section(`Due in the next ${days} days`, due.map((i) => describeItem(i, state, now)));
  section(`Releasing in the next ${days} days`, releasing.map((i) => describeItem(i, state, now, "start")));
  section(
    "Upcoming exams",
    exams.map((m) => `- ${m.label} — ${fmt.format(parseInstant(m.at))} (${relative(parseInstant(m.at), now)})`),
  );
  return lines.join("\n");
}

const updateAssignment = op({
  description:
    "Update an assignment (title, release, deadline, link, notes, done). Changing title/times of a series occurrence detaches it from the series.",
  input: AssignmentPatch.extend({ id: Id }),
  run: async ({ db, now }, { id, ...patch }) => {
    const prev = await getAssignment(db, id);
    const next = {
      ...prev,
      ...patch,
      release_at: patch.release_at ? iso(patch.release_at) : prev.release_at,
      due_at: patch.due_at ? iso(patch.due_at) : prev.due_at,
      link: patch.link !== undefined ? patch.link ?? null : prev.link,
    };
    assertRange(next.release_at, next.due_at);
    const scheduleChanged =
      next.title !== prev.title || next.release_at !== prev.release_at || next.due_at !== prev.due_at;
    await write(db, [
      upsert(db, "assignments", {
        ...next,
        done: next.done ? 1 : 0,
        done_at: next.done ? prev.done_at ?? toIso(now) : null,
        detached: prev.detached || (prev.series_id !== null && scheduleChanged) ? 1 : 0,
      }),
    ]);
    return getAssignment(db, id);
  },
});

// ---- notifications ------------------------------------------------------------------------

function ruleRow(r: NotificationRule) {
  return {
    ...r,
    enabled: r.enabled ? 1 : 0,
    include_overdue: r.include_overdue ? 1 : 0,
    skip_if_empty: r.skip_if_empty ? 1 : 0,
    only_open: r.only_open ? 1 : 0,
    weekdays: JSON.stringify(r.weekdays),
    course_ids: JSON.stringify(r.course_ids),
  };
}

function ruleFromInput(input: z.infer<typeof NotificationRuleInput>): NotificationRule {
  return {
    id: input.id,
    label: input.label,
    enabled: input.enabled ?? true,
    trigger_kind: input.trigger_kind,
    anchor: input.anchor ?? "due",
    offset_minutes: input.offset_minutes ?? 0,
    at_time: input.at_time ?? "08:00",
    weekdays: input.weekdays ?? [],
    window_hours: input.window_hours ?? 48,
    include_overdue: input.include_overdue ?? true,
    max_items: input.max_items ?? 8,
    skip_if_empty: input.skip_if_empty ?? true,
    applies_to: input.applies_to ?? "all",
    course_ids: input.course_ids ?? [],
    only_open: input.only_open ?? true,
    title: input.title,
    body: input.body,
    quiet_from: input.quiet_from ?? null,
    quiet_until: input.quiet_until ?? null,
    sort_order: input.sort_order ?? 0,
  };
}

export function vapidFrom(env: Env): VapidKeys {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new HttpError(503, "Push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (see README).");
  }
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || "mailto:homework@example.org",
  };
}

/** Sends one notification to every registered device, pruning subscriptions the push service dropped. */
export async function deliver(env: Env, message: { title: string; body: string; tag?: string }) {
  const keys = vapidFrom(env);
  const { results } = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_devices").all<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>();

  let sent = 0;
  let failed = 0;
  let pruned = 0;
  const stmts: D1PreparedStatement[] = [];
  const nowIso = toIso(Date.now());

  for (const device of results) {
    const result = await sendPush(device, { ...message, url: "/" }, keys);
    if (result.ok) {
      sent += 1;
      stmts.push(
        env.DB.prepare("UPDATE push_devices SET last_ok_at = ?, failures = 0, last_error = NULL WHERE id = ?").bind(
          nowIso,
          device.id,
        ),
      );
    } else if (result.gone) {
      pruned += 1;
      stmts.push(env.DB.prepare("DELETE FROM push_devices WHERE id = ?").bind(device.id));
    } else {
      failed += 1;
      stmts.push(
        env.DB.prepare("UPDATE push_devices SET failures = failures + 1, last_error = ? WHERE id = ?").bind(
          `${result.status} ${result.error ?? ""}`.trim(),
          device.id,
        ),
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { sent, failed, pruned };
}

const CATCHUP_MS = 6 * HOUR;

/**
 * Fires everything due since the last run; called by the cron trigger. Every notification is logged
 * by key, so a rule never fires twice even if the cron overlaps, retries or catches up.
 */
export async function dispatchDue(env: Env, now: number) {
  const db = env.DB;
  const state = await loadState(db);
  const lastRaw = await db.prepare("SELECT value FROM meta WHERE key = 'push_last_run'").first<{ value: string }>();
  const last = lastRaw?.value ? parseInstant(lastRaw.value) : now - 15 * 60_000;
  const from = Math.max(last, now - CATCHUP_MS);

  const planned = planNotifications(state, from, now);
  const fired: string[] = [];

  for (const plan of planned) {
    const seen = await db.prepare("SELECT 1 FROM notification_log WHERE key = ?").bind(plan.key).first();
    if (seen) continue;
    const { sent } = await deliver(env, { title: plan.title, body: plan.body, tag: plan.rule_id });
    await db
      .prepare(
        "INSERT OR REPLACE INTO notification_log (key, rule_id, fired_at, title, body, devices) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(plan.key, plan.rule_id, toIso(now), plan.title, plan.body, sent);
    fired.push(plan.key);
  }

  await db.batch([
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('push_last_run', ?)").bind(toIso(now)),
    db.prepare("DELETE FROM notification_log WHERE fired_at < ?").bind(toIso(now - 60 * DAY)),
  ]);
  return { checked: planned.length, fired };
}

// ---- operations -------------------------------------------------------------------------

export const operations = {
  get_state: op({
    description: "Full raw state: semester, courses, markers, lecture slots, series, assignments, done reviews.",
    input: Empty,
    readOnly: true,
    run: ({ db }) => loadState(db),
  }),

  get_version: op({
    description: "Change counter; increments on every write.",
    input: Empty,
    readOnly: true,
    run: async ({ db }) => ({ version: await loadVersion(db) }),
  }),

  get_briefing: op({
    description:
      "Human-readable briefing of what matters right now: overdue items, deadlines and lecture reviews coming up, upcoming releases and exams. Start here.",
    input: z.object({ days: z.number().int().min(1).max(30).optional().describe("look-ahead, default 3") }),
    readOnly: true,
    run: async ({ db, now }, { days }) => briefing(await loadState(db), now, days ?? 3),
  }),

  week_summary: op({
    description: "Everything due in one Monday–Sunday week (assignments and lecture reviews), grouped by day.",
    input: z.object({ week_of: DateStr.optional().describe("any date in the week; default today") }),
    readOnly: true,
    run: async ({ db, now }, { week_of }) => {
      const state = await loadState(db);
      const day = week_of ?? dateKey(now);
      const monday = addDays(day, 1 - weekdayOf(day));
      const from = startOfDay(monday);
      const to = startOfDay(addDays(monday, 7));
      const items = timelineItems(state).filter((i) => i.endMs >= from && i.endMs < to);
      const lines = [`Week of ${monday}`];
      for (let d = 0; d < 7; d += 1) {
        const date = addDays(monday, d);
        const today = items.filter((i) => dateKey(i.endMs) === date);
        if (today.length) lines.push("", `## ${fmt.format(startOfDay(date)).split(",")[0]}`, ...today.map((i) => describeItem(i, state, now)));
      }
      if (lines.length === 1) lines.push("", "Nothing due this week.");
      return lines.join("\n");
    },
  }),

  list_assignments: op({
    description: "List assignments (JSON), optionally filtered by course, done-state, or due date range.",
    input: z.object({
      course_id: Id.optional(),
      done: z.boolean().optional(),
      due_from: Instant.optional(),
      due_to: Instant.optional(),
    }),
    readOnly: true,
    run: async ({ db }, f) => {
      const { assignments } = await loadState(db);
      return assignments.filter(
        (a) =>
          (f.course_id === undefined || a.course_id === f.course_id) &&
          (f.done === undefined || a.done === f.done) &&
          (f.due_from === undefined || parseInstant(a.due_at) >= parseInstant(f.due_from)) &&
          (f.due_to === undefined || parseInstant(a.due_at) <= parseInstant(f.due_to)),
      );
    },
  }),

  get_upcoming: op({
    description: "Open (not done) assignments and lecture reviews due within the next N days, soonest first.",
    input: z.object({ days: z.number().int().min(1).max(120).optional().describe("default 7") }),
    readOnly: true,
    run: async ({ db, now }, { days }) => {
      const horizon = now + (days ?? 7) * DAY;
      return timelineItems(await loadState(db))
        .filter((i) => !i.done && i.endMs >= now && i.endMs <= horizon)
        .map((i) => ({ ...i, start: toIso(i.startMs), end: toIso(i.endMs) }));
    },
  }),

  get_overdue: op({
    description: "Assignments and lecture reviews past their deadline and not done.",
    input: Empty,
    readOnly: true,
    run: async ({ db, now }) => {
      const state = await loadState(db);
      return timelineItems(state)
        .filter((i) => isOverdue(i, now, state.settings.review_grace_days))
        .map((i) => ({ ...i, start: toIso(i.startMs), end: toIso(i.endMs) }));
    },
  }),

  // ---- settings --------------------------------------------------------------------------

  get_settings: op({
    description:
      "All behaviour and layout settings with their current values, defaults and what each one does. These replace hard-coded choices: which layout each screen size uses, what the timeline shows, when cards turn amber or red, and the default zoom.",
    input: Empty,
    readOnly: true,
    run: async ({ db }) => describeSettings((await loadState(db)).settings),
  }),

  update_settings: op({
    description:
      "Change one or more settings. Only the keys you pass are touched. Open tabs pick the change up within ~15s, on every device.",
    input: SettingsPatch,
    run: async ({ db }, patch) => {
      if (!Object.keys(patch).length) throw new HttpError(400, "pass at least one setting");
      const current = (await loadState(db)).settings;
      const next = parseSettings({ ...current, ...patch });
      await write(db, [
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)").bind(JSON.stringify(next)),
      ]);
      return next;
    },
  }),

  reset_settings: op({
    description: "Put every setting back to its default.",
    input: Empty,
    run: async ({ db }) => {
      await write(db, [db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', '{}')")]);
      return DEFAULT_SETTINGS;
    },
  }),

  // semester & markers
  set_semester: op({
    description:
      "Create/replace the current semester (view range and lecture period). Existing series are re-expanded to the new lecture period.",
    input: SemesterInput,
    run: async ({ db }, s) => {
      const row = {
        id: 1,
        name: s.name,
        starts_on: s.starts_on,
        ends_on: s.ends_on,
        lectures_end_on: s.lectures_end_on ?? null,
        review_hours: s.review_hours ?? 48,
      };
      if (row.ends_on < row.starts_on) throw new HttpError(400, "ends_on must not be before starts_on");
      await write(db, [upsert(db, "semester", row)]);
      const { series } = await loadState(db);
      for (const s of series) await saveSeries(db, s);
      return row;
    },
  }),

  create_marker: op({
    description:
      "Add a dated marker: semester lines (semester start/end, exam session start…), breaks (ranges without lectures), exams.",
    input: MarkerInput,
    run: async ({ db }, m) => {
      if (m.end_at) assertRange(m.at, m.end_at);
      if (m.course_id) await ensureCourse(db, m.course_id);
      const row = { ...m, at: iso(m.at), end_at: isoOrNull(m.end_at) ?? null, course_id: m.course_id ?? null };
      await write(db, [upsert(db, "markers", row)]);
      return row;
    },
  }),

  update_marker: op({
    description: "Update fields of a marker.",
    input: MarkerPatch.extend({ id: Id }),
    run: async ({ db }, { id, ...patch }) => {
      const prev = await getMarker(db, id);
      const row = {
        ...prev,
        ...patch,
        at: patch.at ? iso(patch.at) : prev.at,
        end_at: patch.end_at !== undefined ? isoOrNull(patch.end_at) ?? null : prev.end_at,
      };
      if (row.end_at) assertRange(row.at, row.end_at);
      await write(db, [upsert(db, "markers", row)]);
      return row;
    },
  }),

  delete_marker: op({
    description: "Delete a marker.",
    input: ById,
    run: async ({ db }, { id }) => {
      await getMarker(db, id);
      await write(db, [db.prepare("DELETE FROM markers WHERE id = ?").bind(id)]);
      return { deleted: id };
    },
  }),

  // courses
  create_course: op({
    description: "Create a course (one column on the timeline).",
    input: CourseInput,
    run: async ({ db }, c) => {
      const exists = await db.prepare("SELECT 1 FROM courses WHERE id = ?").bind(c.id).first();
      if (exists) throw new HttpError(409, `course '${c.id}' already exists`);
      const row = { ...c, link: c.link ?? null, sort_order: c.sort_order ?? 0 };
      await write(db, [upsert(db, "courses", row)]);
      return row;
    },
  }),

  update_course: op({
    description: "Update a course's name, abbreviation, color, link or order.",
    input: CoursePatch.extend({ id: Id }),
    run: async ({ db }, { id, ...patch }) => {
      const row = { ...(await getCourse(db, id)), ...patch };
      await write(db, [upsert(db, "courses", row)]);
      return row;
    },
  }),

  reorder_courses: op({
    description: "Set the left-to-right column order. Courses not listed keep their relative order after the listed ones.",
    input: z.object({ ids: z.array(Id).min(1).describe("course ids, leftmost first") }),
    run: async ({ db }, { ids }) => {
      const { results } = await db.prepare("SELECT id FROM courses ORDER BY sort_order, name").all<{ id: string }>();
      const known = results.map((r) => r.id);
      const unknown = ids.filter((id) => !known.includes(id));
      if (unknown.length) throw new HttpError(404, `unknown course(s): ${unknown.join(", ")}`);
      const order = [...new Set(ids), ...known.filter((id) => !ids.includes(id))];
      await write(
        db,
        order.map((id, i) => db.prepare("UPDATE courses SET sort_order = ? WHERE id = ?").bind(i, id)),
      );
      return { order };
    },
  }),

  delete_course: op({
    description: "Delete a course and everything attached to it (lecture slots, series, assignments, exams).",
    input: ById,
    run: async ({ db }, { id }) => {
      await getCourse(db, id);
      await write(db, [
        db.prepare("DELETE FROM assignments WHERE course_id = ?").bind(id),
        db.prepare("DELETE FROM series WHERE course_id = ?").bind(id),
        db.prepare("DELETE FROM lecture_slots WHERE course_id = ?").bind(id),
        db.prepare("DELETE FROM markers WHERE course_id = ?").bind(id),
        db.prepare("DELETE FROM courses WHERE id = ?").bind(id),
      ]);
      return { deleted: id };
    },
  }),

  // lecture slots
  create_lecture_slot: op({
    description:
      "Add a weekly lecture time for a course. Each lecture gets a review window (lecture end → +review_hours) on the timeline.",
    input: LectureSlotInput,
    run: async ({ db }, s) => {
      await ensureCourse(db, s.course_id);
      if (s.end_time <= s.start_time) throw new HttpError(400, "end_time must be after start_time");
      const row = { ...s, skip_dates: JSON.stringify(s.skip_dates ?? []) };
      await write(db, [upsert(db, "lecture_slots", row)]);
      return { ...row, skip_dates: s.skip_dates ?? [] };
    },
  }),

  update_lecture_slot: op({
    description: "Update a lecture slot (weekday, times, skipped dates).",
    input: LectureSlotPatch.extend({ id: Id }),
    run: async ({ db }, { id, ...patch }) => {
      const next = { ...(await getSlot(db, id)), ...patch };
      if (next.end_time <= next.start_time) throw new HttpError(400, "end_time must be after start_time");
      await write(db, [upsert(db, "lecture_slots", { ...next, skip_dates: JSON.stringify(next.skip_dates) })]);
      return next;
    },
  }),

  delete_lecture_slot: op({
    description: "Delete a lecture slot.",
    input: ById,
    run: async ({ db }, { id }) => {
      await getSlot(db, id);
      await write(db, [
        db.prepare("DELETE FROM review_done WHERE key LIKE ?").bind(`${id}@%`),
        db.prepare("DELETE FROM lecture_slots WHERE id = ?").bind(id),
      ]);
      return { deleted: id };
    },
  }),

  // series
  create_series: op({
    description:
      "Create a recurring exercise series. Generates one assignment per period, from first_release/first_due until `until` (default: lecture end). Wall-clock times are Europe/Zurich.",
    input: SeriesInput,
    run: async ({ db }, s) => {
      await ensureCourse(db, s.course_id);
      const exists = await db.prepare("SELECT 1 FROM series WHERE id = ?").bind(s.id).first();
      if (exists) throw new HttpError(409, `series '${s.id}' already exists`);
      return saveSeries(db, {
        id: s.id,
        course_id: s.course_id,
        title_template: s.title_template ?? "Sheet {n}",
        first_release: local(s.first_release),
        first_due: local(s.first_due),
        every_days: s.every_days ?? 7,
        until: s.until ?? null,
        start_number: s.start_number ?? 1,
        skip_dates: s.skip_dates ?? [],
      });
    },
  }),

  update_series: op({
    description:
      "Update a series and regenerate its assignments. Done-state is kept; individually edited assignments are not touched.",
    input: SeriesPatch.extend({ id: Id }),
    run: async ({ db }, { id, ...patch }) => {
      const prev = await getSeries(db, id);
      return saveSeries(db, {
        ...prev,
        ...patch,
        first_release: patch.first_release ? local(patch.first_release) : prev.first_release,
        first_due: patch.first_due ? local(patch.first_due) : prev.first_due,
        until: patch.until !== undefined ? patch.until ?? null : prev.until,
        skip_dates: patch.skip_dates ?? prev.skip_dates,
      });
    },
  }),

  skip_week: op({
    description:
      "Skip (or un-skip) one period of a series, e.g. a holiday week. `date` is the release date of that period.",
    input: z.object({ series_id: Id, date: DateStr, unskip: z.boolean().optional() }),
    run: async ({ db }, { series_id, date, unskip }) => {
      const prev = await getSeries(db, series_id);
      const skip_dates = unskip ? prev.skip_dates.filter((d) => d !== date) : [...prev.skip_dates, date];
      return saveSeries(db, { ...prev, skip_dates });
    },
  }),

  delete_series: op({
    description: "Delete a series. Its generated assignments are deleted unless keep_assignments is true.",
    input: z.object({ id: Id, keep_assignments: z.boolean().optional() }),
    run: async ({ db }, { id, keep_assignments }) => {
      await getSeries(db, id);
      await write(db, [
        keep_assignments
          ? db.prepare("UPDATE assignments SET series_id = NULL, detached = 1 WHERE series_id = ?").bind(id)
          : db.prepare("DELETE FROM assignments WHERE series_id = ?").bind(id),
        db.prepare("DELETE FROM series WHERE id = ?").bind(id),
      ]);
      return { deleted: id };
    },
  }),

  // assignments
  create_assignment: op({
    description: "Create a single (non-recurring) assignment.",
    input: AssignmentInput,
    run: async ({ db, now }, a) => {
      await ensureCourse(db, a.course_id);
      assertRange(a.release_at, a.due_at);
      const row = {
        id: a.id ?? `${a.course_id}-${now.toString(36)}`,
        course_id: a.course_id,
        title: a.title,
        release_at: iso(a.release_at),
        due_at: iso(a.due_at),
        link: a.link ?? null,
        notes: a.notes ?? "",
        done: a.done ? 1 : 0,
        done_at: a.done ? toIso(now) : null,
      };
      await write(db, [upsert(db, "assignments", row)]);
      return getAssignment(db, row.id);
    },
  }),

  update_assignment: updateAssignment,

  move_deadline: op({
    description: "Move an assignment's deadline.",
    input: z.object({ id: Id, due_at: Instant }),
    run: (ctx, input) => updateAssignment.run(ctx, input),
  }),

  delete_assignment: op({
    description:
      "Delete an assignment. For a series occurrence prefer skip_week, otherwise it comes back when the series is regenerated.",
    input: ById,
    run: async ({ db }, { id }) => {
      await getAssignment(db, id);
      await write(db, [db.prepare("DELETE FROM assignments WHERE id = ?").bind(id)]);
      return { deleted: id };
    },
  }),

  set_done: op({
    description: "Mark an assignment or a lecture review (id like 'slot@YYYY-MM-DD') as done or not done.",
    input: z.object({ id: z.string().min(1), done: z.boolean() }),
    run: async ({ db, now }, { id, done }) => {
      if (id.includes("@")) {
        const [slotId] = id.split("@");
        await getSlot(db, slotId!);
        await write(db, [
          done
            ? db.prepare("INSERT OR IGNORE INTO review_done (key, done_at) VALUES (?, ?)").bind(id, toIso(now))
            : db.prepare("DELETE FROM review_done WHERE key = ?").bind(id),
        ]);
        return { id, done };
      }
      await getAssignment(db, id);
      await write(db, [
        db
          .prepare("UPDATE assignments SET done = ?, done_at = ? WHERE id = ?")
          .bind(done ? 1 : 0, done ? toIso(now) : null, id),
      ]);
      return { id, done };
    },
  }),

  // ---- notification rules (fully configurable over MCP) ----------------------------------

  list_notification_rules: op({
    description:
      "All notification rules with their settings. Rules decide what gets pushed and when; nothing is hard-coded.",
    input: Empty,
    readOnly: true,
    run: async ({ db }) => (await loadState(db)).notification_rules,
  }),

  create_notification_rule: op({
    description:
      "Create a push rule. trigger_kind 'relative' sends one notification per item at an offset from its deadline or release (offset_minutes negative = before). trigger_kind 'digest' sends one summary at a wall-clock time on chosen weekdays. Filter with applies_to/course_ids/only_open, write the text with {course} {short} {title} {due} {left} {count} {list}, and optionally defer around quiet hours.",
    input: NotificationRuleInput,
    run: async ({ db }, input) => {
      const exists = await db.prepare("SELECT 1 FROM notification_rules WHERE id = ?").bind(input.id).first();
      if (exists) throw new HttpError(409, `notification rule '${input.id}' already exists`);
      for (const id of input.course_ids ?? []) await ensureCourse(db, id);
      const rule = ruleFromInput(input);
      await write(db, [upsert(db, "notification_rules", ruleRow(rule))]);
      return rule;
    },
  }),

  update_notification_rule: op({
    description: "Change any field of a notification rule, including enabling or disabling it.",
    input: NotificationRulePatch.extend({ id: Id }),
    run: async ({ db }, { id, ...patch }) => {
      const prev = await getRule(db, id);
      for (const courseId of patch.course_ids ?? []) await ensureCourse(db, courseId);
      const next: NotificationRule = {
        ...prev,
        ...patch,
        quiet_from: patch.quiet_from !== undefined ? patch.quiet_from ?? null : prev.quiet_from,
        quiet_until: patch.quiet_until !== undefined ? patch.quiet_until ?? null : prev.quiet_until,
      };
      await write(db, [upsert(db, "notification_rules", ruleRow(next))]);
      return next;
    },
  }),

  delete_notification_rule: op({
    description: "Delete a notification rule.",
    input: ById,
    run: async ({ db }, { id }) => {
      await getRule(db, id);
      await write(db, [
        db.prepare("DELETE FROM notification_log WHERE rule_id = ?").bind(id),
        db.prepare("DELETE FROM notification_rules WHERE id = ?").bind(id),
      ]);
      return { deleted: id };
    },
  }),

  install_default_notification_rules: op({
    description:
      "Add a starter set of rules (morning digest, a day before each deadline, a lecture review nudge). Existing ids are left alone. Everything stays editable afterwards.",
    input: z.object({ overwrite: z.boolean().optional().describe("replace rules with the same id") }),
    run: async ({ db }, { overwrite }) => {
      const existing = new Set((await loadState(db)).notification_rules.map((r) => r.id));
      const added: string[] = [];
      const stmts: D1PreparedStatement[] = [];
      for (const template of DEFAULT_RULES) {
        if (existing.has(template.id) && !overwrite) continue;
        const rule = ruleFromInput(NotificationRuleInput.parse(template));
        stmts.push(upsert(db, "notification_rules", ruleRow(rule)));
        added.push(rule.id);
      }
      if (stmts.length) await write(db, stmts);
      return { added, skipped: DEFAULT_RULES.map((r) => r.id).filter((id) => !added.includes(id)) };
    },
  }),

  preview_notifications: op({
    description:
      "Dry run: every notification the current rules would send over the next N days, with its exact time and text. Nothing is sent. Use this to check a rule before relying on it.",
    input: z.object({ days: z.number().int().min(1).max(60).optional().describe("default 7") }),
    readOnly: true,
    run: async ({ db, now }, { days }) => {
      const state = await loadState(db);
      const plans = planNotifications(state, now, now + (days ?? 7) * DAY);
      if (!plans.length) return "No notifications would fire in that window.";
      return plans
        .map((p) => `${fmt.format(p.fire_at)} · [${p.rule_label}]\n  ${p.title}\n  ${p.body.replaceAll("\n", "\n  ")}`)
        .join("\n\n");
    },
  }),

  list_recent_notifications: op({
    description: "Notifications already sent, newest first.",
    input: z.object({ limit: z.number().int().min(1).max(100).optional().describe("default 20") }),
    readOnly: true,
    run: async ({ db }, { limit }) => {
      const { results } = await db
        .prepare("SELECT key, rule_id, fired_at, title, body, devices FROM notification_log ORDER BY fired_at DESC LIMIT ?")
        .bind(limit ?? 20)
        .all();
      return results;
    },
  }),

  list_notification_devices: op({
    description: "Phones and browsers subscribed to push, with their last delivery result.",
    input: Empty,
    readOnly: true,
    run: ({ db }) => listDevices(db),
  }),

  delete_notification_device: op({
    description: "Unsubscribe one device from push.",
    input: ById,
    run: async ({ db }, { id }) => {
      const found = await db.prepare("SELECT 1 FROM push_devices WHERE id = ?").bind(id).first();
      if (!found) throw new HttpError(404, `device '${id}' not found`);
      await db.prepare("DELETE FROM push_devices WHERE id = ?").bind(id).run();
      return { deleted: id };
    },
  }),

  send_test_notification: op({
    description: "Send a notification to every subscribed device right now, to check the setup works.",
    input: z.object({
      title: z.string().optional().describe("default 'Homework'"),
      body: z.string().optional().describe("default 'Test notification'"),
    }),
    run: async ({ env }, { title, body }) =>
      deliver(env, { title: title ?? "Homework", body: body ?? "Test notification", tag: "test" }),
  }),

  run_notifications_now: op({
    description:
      "Run the scheduler immediately instead of waiting for the next cron tick. Sends anything due since the last run that has not already been sent.",
    input: Empty,
    run: ({ env, now }) => dispatchDue(env, now),
  }),

  // ---- push plumbing (used by the web app, hidden from MCP) --------------------------------

  get_push_config: op({
    description: "VAPID public key and whether push is configured.",
    input: Empty,
    readOnly: true,
    run: async ({ env, db }) => ({
      publicKey: env.VAPID_PUBLIC_KEY ?? null,
      configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      devices: (await listDevices(db)).length,
    }),
  }),

  subscribe_push: op({
    description: "Register a browser push subscription.",
    input: PushSubscriptionInput,
    run: async ({ db, now }, sub) => {
      const id = bytesToB64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint))).slice(0, 22);
      await db
        .prepare(
          `INSERT INTO push_devices (id, label, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
             failures = 0, last_error = NULL`,
        )
        .bind(id, sub.label ?? "", sub.endpoint, sub.keys.p256dh, sub.keys.auth, toIso(now))
        .run();
      return { id };
    },
  }),

  unsubscribe_push: op({
    description: "Remove a browser push subscription by endpoint.",
    input: z.object({ endpoint: z.string().min(1) }),
    run: async ({ db }, { endpoint }) => {
      await db.prepare("DELETE FROM push_devices WHERE endpoint = ?").bind(endpoint).run();
      return { ok: true };
    },
  }),

} satisfies Record<string, Operation<any>>;

export type OperationName = keyof typeof operations;

export async function runOperation(name: string, raw: unknown, env: Env) {
  const operation = (operations as Record<string, Operation>)[name];
  if (!operation) throw new HttpError(404, `unknown operation '${name}'`);
  const parsed = operation.input.safeParse(raw ?? {});
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error), parsed.error.issues);
  return operation.run({ db: env.DB, env, now: Date.now() }, parsed.data);
}
