import { describe, expect, it } from "vitest";
import { expandLectures, expandSeries, packLanes } from "../src/shared/expand";
import type { Semester, Series } from "../src/shared/schema";
import { addDays, dateKey, localInput, parseInstant, weekdayOf, zonedToMs } from "../src/shared/time";

const semester: Semester = {
  name: "HS 2026",
  starts_on: "2026-09-14",
  ends_on: "2027-02-14",
  lectures_end_on: "2026-12-18",
  review_hours: 48,
};

describe("time", () => {
  it("interprets local strings in Europe/Zurich across DST", () => {
    expect(new Date(parseInstant("2026-09-18T12:00")).toISOString()).toBe("2026-09-18T10:00:00.000Z");
    expect(new Date(parseInstant("2026-11-06T12:00")).toISOString()).toBe("2026-11-06T11:00:00.000Z");
    expect(parseInstant("2026-09-18T10:00:00Z")).toBe(Date.UTC(2026, 8, 18, 10));
  });
  it("round-trips local inputs and date keys", () => {
    const ms = zonedToMs(2026, 10, 25, 23, 30);
    expect(localInput(ms)).toBe("2026-10-25T23:30");
    expect(dateKey(zonedToMs(2026, 10, 25, 0, 0))).toBe("2026-10-25");
  });
  it("does calendar arithmetic", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(weekdayOf("2026-09-14")).toBe(1);
    expect(weekdayOf("2026-09-20")).toBe(7);
  });
});

describe("expandSeries", () => {
  const series: Series = {
    id: "qm",
    course_id: "qm",
    title_template: "Sheet {n}",
    first_release: "2026-09-14T12:00",
    first_due: "2026-09-21T12:00",
    every_days: 7,
    until: null,
    start_number: 1,
    skip_dates: ["2026-09-28"],
  };
  const occ = expandSeries(series, semester);

  it("stops at lecture end and keeps wall-clock time over DST", () => {
    expect(occ.at(-1)!.release_at.startsWith("2026-12-14")).toBe(true);
    expect(localInput(parseInstant(occ.find((o) => o.id === "qm-7")!.release_at))).toBe("2026-11-02T12:00");
  });
  it("skips dates without shifting ids, and numbering continues", () => {
    expect(occ.map((o) => o.id).slice(0, 3)).toEqual(["qm-0", "qm-1", "qm-3"]);
    expect(occ.map((o) => o.title).slice(0, 3)).toEqual(["Sheet 1", "Sheet 2", "Sheet 3"]);
  });
});

describe("expandLectures", () => {
  it("creates weekly lectures outside breaks with a review window", () => {
    const lectures = expandLectures(
      [{ id: "qm-tue", course_id: "qm", weekday: 2, start_time: "10:15", end_time: "12:00", skip_dates: ["2026-09-22"] }],
      semester,
      [{ id: "b", kind: "break", label: "Break", at: "2026-10-05", end_at: "2026-10-10", course_id: null }],
    );
    expect(lectures[0]!.date).toBe("2026-09-15");
    expect(lectures.map((l) => l.date)).not.toContain("2026-09-22");
    expect(lectures.map((l) => l.date)).not.toContain("2026-10-06");
    expect(lectures.at(-1)!.date).toBe("2026-12-15");
    expect(lectures[0]!.reviewEndMs - lectures[0]!.endMs).toBe(48 * 3600_000);
  });
});

describe("packLanes", () => {
  const lanes = (items: Array<{ id: string; start: number; end: number }>) =>
    Object.fromEntries(packLanes(items).map((o) => [o.id, [o.lane, o.lanes, o.span]]));

  it("packs per overlap cluster", () => {
    expect(
      lanes([
        { id: "a", start: 0, end: 10 },
        { id: "b", start: 5, end: 15 },
        { id: "c", start: 12, end: 20 },
        { id: "d", start: 30, end: 40 },
      ]),
    ).toEqual({ a: [0, 2, 1], b: [1, 2, 1], c: [0, 2, 1], d: [0, 1, 1] });
  });

  it("widens items into lanes that are free for their whole duration", () => {
    expect(
      lanes([
        { id: "a", start: 0, end: 10 },
        { id: "b", start: 1, end: 4 },
        { id: "c", start: 2, end: 12 },
        { id: "d", start: 5, end: 11 },
        { id: "e", start: 11, end: 13 },
      ]),
    ).toEqual({ a: [0, 3, 1], b: [1, 3, 1], c: [2, 3, 1], d: [1, 3, 1], e: [0, 3, 2] });
  });
});
