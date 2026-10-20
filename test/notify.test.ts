import { describe, expect, it } from "vitest";
import { applyQuietHours, planNotifications } from "../src/shared/notify";
import type { AppState, NotificationRule } from "../src/shared/schema";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { parseInstant } from "../src/shared/time";

const rule = (over: Partial<NotificationRule>): NotificationRule => ({
  id: "r",
  label: "Rule",
  enabled: true,
  trigger_kind: "relative",
  anchor: "due",
  offset_minutes: 0,
  at_time: "08:00",
  weekdays: [],
  window_hours: 48,
  include_overdue: true,
  skip_if_empty: true,
  max_items: 8,
  applies_to: "all",
  course_ids: [],
  only_open: true,
  title: "{short} {title}",
  body: "{left} left",
  quiet_from: null,
  quiet_until: null,
  sort_order: 0,
  ...over,
});

const state = (rules: NotificationRule[], over: Partial<AppState> = {}): AppState => ({
  version: 1,
  semester: { name: "HS 2026", starts_on: "2026-09-14", ends_on: "2027-02-14", lectures_end_on: "2026-12-18", review_hours: 48 },
  courses: [
    { id: "qft", name: "Quantum Field Theory", short: "QFT", color: "#7C9CFF", link: null, sort_order: 0 },
    { id: "gr", name: "General Relativity", short: "GR", color: "#FF7AB6", link: null, sort_order: 1 },
  ],
  markers: [],
  lecture_slots: [],
  series: [],
  assignments: [
    {
      id: "qft-1",
      course_id: "qft",
      series_id: null,
      seq: 1,
      title: "Sheet 1",
      release_at: "2026-10-12T10:00:00Z",
      due_at: "2026-10-19T10:00:00Z",
      link: null,
      notes: "",
      done: false,
      done_at: null,
      detached: false,
    },
    {
      id: "gr-1",
      course_id: "gr",
      series_id: null,
      seq: 1,
      title: "Problem set 1",
      release_at: "2026-10-12T10:00:00Z",
      due_at: "2026-10-19T14:00:00Z",
      link: null,
      notes: "",
      done: true,
      done_at: "2026-10-18T09:00:00Z",
      detached: false,
    },
  ],
  review_done: [],
  notification_rules: rules,
  settings: DEFAULT_SETTINGS,
  ...over,
});

const at = (s: string) => parseInstant(s);

describe("relative rules", () => {
  it("fires once per item at the offset, skipping done items", () => {
    const plans = planNotifications(
      state([rule({ offset_minutes: -24 * 60, applies_to: "assignments" })]),
      at("2026-10-18T00:00:00Z"),
      at("2026-10-19T00:00:00Z"),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.key).toBe("r|qft-1");
    expect(new Date(plans[0]!.fire_at).toISOString()).toBe("2026-10-18T10:00:00.000Z");
    expect(plans[0]!.title).toBe("QFT Sheet 1");
    expect(plans[0]!.body).toBe("1d left");
  });

  it("includes done items when only_open is off", () => {
    const plans = planNotifications(
      state([rule({ offset_minutes: -24 * 60, only_open: false })]),
      at("2026-10-18T00:00:00Z"),
      at("2026-10-19T00:00:00Z"),
    );
    expect(plans.map((p) => p.key).sort()).toEqual(["r|gr-1", "r|qft-1"]);
  });

  it("filters by course and anchors on the release", () => {
    const plans = planNotifications(
      state([rule({ anchor: "release", offset_minutes: 60, course_ids: ["qft"] })]),
      at("2026-10-12T00:00:00Z"),
      at("2026-10-13T00:00:00Z"),
    );
    expect(plans).toHaveLength(1);
    expect(new Date(plans[0]!.fire_at).toISOString()).toBe("2026-10-12T11:00:00.000Z");
  });

  it("fires nothing outside the window", () => {
    const plans = planNotifications(
      state([rule({ offset_minutes: -24 * 60 })]),
      at("2026-10-01T00:00:00Z"),
      at("2026-10-02T00:00:00Z"),
    );
    expect(plans).toEqual([]);
  });
});

describe("quiet hours", () => {
  const quiet = rule({ quiet_from: "22:00", quiet_until: "08:00" });

  it("defers a late-evening notification to the morning", () => {
    // 23:30 Zurich -> 08:00 next day
    expect(new Date(applyQuietHours(at("2026-10-18T23:30"), quiet)).toISOString()).toBe("2026-10-19T06:00:00.000Z");
  });
  it("defers an early-morning notification to the same morning", () => {
    expect(new Date(applyQuietHours(at("2026-10-18T03:00"), quiet)).toISOString()).toBe("2026-10-18T06:00:00.000Z");
  });
  it("leaves daytime alone", () => {
    expect(applyQuietHours(at("2026-10-18T14:00"), quiet)).toBe(at("2026-10-18T14:00"));
  });
  it("handles a non-wrapping window", () => {
    const lunch = rule({ quiet_from: "12:00", quiet_until: "13:00" });
    expect(new Date(applyQuietHours(at("2026-10-18T12:30"), lunch)).toISOString()).toBe("2026-10-18T11:00:00.000Z");
    expect(applyQuietHours(at("2026-10-18T13:30"), lunch)).toBe(at("2026-10-18T13:30"));
  });
});

describe("digest rules", () => {
  const digest = rule({ trigger_kind: "digest", at_time: "08:00", window_hours: 48, title: "{count} due", body: "{list}" });

  it("fires once a day and lists what is due", () => {
    const plans = planNotifications(state([digest]), at("2026-10-18T00:00:00Z"), at("2026-10-18T23:00:00Z"));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.key).toBe("r|2026-10-18");
    expect(new Date(plans[0]!.fire_at).toISOString()).toBe("2026-10-18T06:00:00.000Z");
    expect(plans[0]!.title).toBe("1 due");
    expect(plans[0]!.body).toContain("QFT Sheet 1");
    expect(plans[0]!.body).not.toContain("Problem set 1"); // done
  });

  it("honours weekdays", () => {
    // 2026-10-18 is a Sunday; restrict to Monday.
    const plans = planNotifications(state([rule({ ...digest, weekdays: [1] })]), at("2026-10-18T00:00:00Z"), at("2026-10-18T23:00:00Z"));
    expect(plans).toEqual([]);
  });

  it("skips empty digests unless asked not to", () => {
    const empty = state([rule({ ...digest, window_hours: 1, include_overdue: false })]);
    expect(planNotifications(empty, at("2026-10-01T00:00:00Z"), at("2026-10-01T23:00:00Z"))).toEqual([]);
    const loud = state([rule({ ...digest, window_hours: 1, include_overdue: false, skip_if_empty: false })]);
    const plans = planNotifications(loud, at("2026-10-01T00:00:00Z"), at("2026-10-01T23:00:00Z"));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.body).toBe("nothing due");
  });

  it("caps the list and says how many were left out", () => {
    const many = state([rule({ ...digest, max_items: 1, only_open: false })]);
    const plans = planNotifications(many, at("2026-10-18T00:00:00Z"), at("2026-10-18T23:00:00Z"));
    expect(plans[0]!.body.split("\n")).toHaveLength(2);
    expect(plans[0]!.body).toContain("+1 more");
    expect(plans[0]!.title).toBe("2 due");
  });

  it("reports overdue items as late", () => {
    const plans = planNotifications(state([digest]), at("2026-10-25T00:00:00Z"), at("2026-10-25T23:00:00Z"));
    expect(plans[0]!.body).toMatch(/QFT Sheet 1 — 5d 21h late/);
  });
});

describe("rule hygiene", () => {
  it("ignores disabled rules", () => {
    const plans = planNotifications(
      state([rule({ enabled: false, offset_minutes: -24 * 60 })]),
      at("2026-10-18T00:00:00Z"),
      at("2026-10-19T00:00:00Z"),
    );
    expect(plans).toEqual([]);
  });

  it("gives every plan a stable, unique key", () => {
    const plans = planNotifications(
      state([
        rule({ id: "a", offset_minutes: -24 * 60 }),
        rule({ id: "b", offset_minutes: -48 * 60 }),
      ]),
      at("2026-10-16T00:00:00Z"),
      at("2026-10-19T00:00:00Z"),
    );
    const keys = plans.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(["a|qft-1", "b|qft-1"]);
  });
});
