// Pure notification planning: given state + rules + a time window, work out exactly which
// notifications should fire and when. No I/O, so it is fully testable and the cron, the
// `preview_notifications` tool and the tests all agree by construction.

import { isOverdue, timelineItems, type TimelineItem } from "./expand";
import type { AppState, NotificationRule } from "./schema";
import { DAY, HOUR, MINUTE, TZ, addDays, atTime, dateKey, weekdayOf } from "./time";

export interface PlannedNotification {
  /** Stable dedupe key: a rule fires at most once per item (relative) or per day (digest). */
  key: string;
  rule_id: string;
  rule_label: string;
  fire_at: number;
  title: string;
  body: string;
  /** Items the notification is about, for previews. */
  item_ids: string[];
}

const fmtDue = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const fmtShort = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit" });

/** "3d 4h", "5h", "20m" — the amount of time, without direction. */
export function humanSpan(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / MINUTE);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole).trim();
}

function matches(rule: NotificationRule, item: TimelineItem, now: number): boolean {
  if (rule.applies_to === "assignments" && item.kind !== "assignment") return false;
  if (rule.applies_to === "reviews" && item.kind !== "review") return false;
  if (rule.course_ids.length && !rule.course_ids.includes(item.course_id)) return false;
  if (rule.only_open && item.done) return false;
  void now;
  return true;
}

/** Shifts an instant out of a rule's quiet hours, to the next `quiet_until`. */
export function applyQuietHours(ms: number, rule: NotificationRule): number {
  const { quiet_from: from, quiet_until: until } = rule;
  if (!from || !until || from === until) return ms;
  const date = dateKey(ms);
  const start = atTime(date, from);
  const endSameDay = atTime(date, until);
  const wraps = until < from;

  if (wraps) {
    // e.g. 22:00 -> 07:30: quiet late evening and early morning.
    if (ms >= start) return atTime(addDays(date, 1), until);
    if (ms < endSameDay) return endSameDay;
    return ms;
  }
  return ms >= start && ms < endSameDay ? endSameDay : ms;
}

function courseName(state: AppState, id: string): string {
  return state.courses.find((c) => c.id === id)?.name ?? id;
}
function courseShort(state: AppState, id: string): string {
  return state.courses.find((c) => c.id === id)?.short ?? id;
}

function relativePlans(
  rule: NotificationRule,
  state: AppState,
  items: TimelineItem[],
  from: number,
  to: number,
): PlannedNotification[] {
  const out: PlannedNotification[] = [];
  for (const item of items) {
    if (!matches(rule, item, from)) continue;
    const anchor = rule.anchor === "release" ? item.startMs : item.endMs;
    const fire = applyQuietHours(anchor + rule.offset_minutes * MINUTE, rule);
    if (fire < from || fire > to) continue;
    const values = {
      course: courseName(state, item.course_id),
      short: courseShort(state, item.course_id),
      title: item.title,
      due: fmtDue.format(item.endMs),
      left: humanSpan(item.endMs - fire),
      count: "1",
      list: `${courseShort(state, item.course_id)} ${item.title}`,
    };
    out.push({
      key: `${rule.id}|${item.id}`,
      rule_id: rule.id,
      rule_label: rule.label,
      fire_at: fire,
      title: render(rule.title, values),
      body: render(rule.body, values),
      item_ids: [item.id],
    });
  }
  return out;
}

function digestPlans(
  rule: NotificationRule,
  state: AppState,
  items: TimelineItem[],
  from: number,
  to: number,
): PlannedNotification[] {
  const out: PlannedNotification[] = [];
  const days = new Set<string>([dateKey(from), dateKey(to)]);
  for (let t = from; t < to; t += DAY / 2) days.add(dateKey(t));

  for (const date of [...days].sort()) {
    if (rule.weekdays.length && !rule.weekdays.includes(weekdayOf(date))) continue;
    const fire = applyQuietHours(atTime(date, rule.at_time), rule);
    if (fire < from || fire > to) continue;

    const horizon = fire + rule.window_hours * HOUR;
    const upcoming = items.filter((i) => matches(rule, i, fire) && i.endMs >= fire && i.endMs <= horizon);
    const overdue = rule.include_overdue ? items.filter((i) => matches(rule, i, fire) && isOverdue(i, fire)) : [];
    const all = [...overdue, ...upcoming];
    if (!all.length && rule.skip_if_empty) continue;

    const shown = all.slice(0, Math.max(1, rule.max_items));
    const lines = shown.map((i) => {
      const late = i.endMs < fire;
      return `${courseShort(state, i.course_id)} ${i.title} — ${late ? `${humanSpan(fire - i.endMs)} late` : fmtShort.format(i.endMs)}`;
    });
    if (all.length > shown.length) lines.push(`+${all.length - shown.length} more`);
    const values = {
      count: String(all.length),
      list: lines.join("\n") || "nothing due",
      course: "",
      short: "",
      title: all[0]?.title ?? "",
      due: all[0] ? fmtDue.format(all[0].endMs) : "",
      left: all[0] ? humanSpan(all[0].endMs - fire) : "",
      overdue: String(overdue.length),
    };
    out.push({
      key: `${rule.id}|${date}`,
      rule_id: rule.id,
      rule_label: rule.label,
      fire_at: fire,
      title: render(rule.title, values),
      body: render(rule.body, values),
      item_ids: all.map((i) => i.id),
    });
  }
  return out;
}

/**
 * Every notification that should fire in [from, to]. Callers drop keys already in the log.
 * Items are evaluated against the state as it is *now*, so marking something done before the
 * reminder fires cancels it.
 */
export function planNotifications(state: AppState, from: number, to: number): PlannedNotification[] {
  const items = timelineItems(state);
  const out: PlannedNotification[] = [];
  for (const rule of state.notification_rules) {
    if (!rule.enabled) continue;
    out.push(
      ...(rule.trigger_kind === "digest"
        ? digestPlans(rule, state, items, from, to)
        : relativePlans(rule, state, items, from, to)),
    );
  }
  return out.sort((a, b) => a.fire_at - b.fire_at);
}

/** Starter rules offered on first run; all of them editable or removable afterwards. */
export const DEFAULT_RULES: Array<Partial<NotificationRule> & { id: string; label: string; title: string; body: string }> = [
  {
    id: "morning-digest",
    label: "Morning digest",
    trigger_kind: "digest",
    at_time: "08:00",
    window_hours: 48,
    include_overdue: true,
    max_items: 8,
    title: "{count} due in the next 2 days",
    body: "{list}",
    sort_order: 0,
  },
  {
    id: "day-before",
    label: "Day before a deadline",
    trigger_kind: "relative",
    anchor: "due",
    offset_minutes: -24 * 60,
    applies_to: "assignments",
    quiet_from: "22:00",
    quiet_until: "08:00",
    title: "{short} {title} — due tomorrow",
    body: "Due {due}, {left} left.",
    sort_order: 1,
  },
  {
    id: "review-nudge",
    label: "Lecture review nudge",
    trigger_kind: "relative",
    anchor: "release",
    offset_minutes: 4 * 60,
    applies_to: "reviews",
    quiet_from: "21:00",
    quiet_until: "09:00",
    title: "Review {short}",
    body: "Go over today's lecture while it is fresh. {left} left.",
    sort_order: 2,
  },
];
