import { describe, expect, it } from "vitest";
import { viewItems } from "../src/shared/expand";
import { balancePositions } from "../src/shared/layout";
import type { AppState } from "../src/shared/schema";
import { DEFAULT_SETTINGS, Settings as SettingsSchema, describeSettings, parseSettings } from "../src/shared/settings";

const base: AppState = {
  version: 1,
  semester: { name: "HS", starts_on: "2026-09-14", ends_on: "2026-12-20", lectures_end_on: "2026-12-18", review_hours: 48 },
  courses: [{ id: "qft", name: "QFT", short: "QFT", color: "#7C9CFF", link: null, sort_order: 0 }],
  markers: [],
  lecture_slots: [{ id: "qft-mon", course_id: "qft", weekday: 1, start_time: "10:00", end_time: "12:00", skip_dates: [] }],
  series: [],
  assignments: [
    {
      id: "a1", course_id: "qft", series_id: null, seq: 1, title: "Sheet 1",
      release_at: "2026-09-14T08:00:00Z", due_at: "2026-09-21T08:00:00Z",
      link: null, notes: "", done: true, done_at: "2026-09-20T00:00:00Z", detached: false,
    },
  ],
  review_done: [],
  notification_rules: [],
  settings: DEFAULT_SETTINGS,
};

describe("parseSettings", () => {
  it("keeps the zod schema and the plain defaults in step", () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS);
  });

  it("fills in defaults", () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null).phone_layout).toBe("lane");
  });

  it("keeps valid values and drops invalid or unknown ones", () => {
    const s = parseSettings({ phone_layout: "columns", soon_hours: 12, urgent_hours: "nope", nonsense: 1 });
    expect(s.phone_layout).toBe("columns");
    expect(s.soon_hours).toBe(12);
    expect(s.urgent_hours).toBe(DEFAULT_SETTINGS.urgent_hours);
    expect("nonsense" in s).toBe(false);
  });

  it("rejects out-of-range numbers rather than storing them", () => {
    expect(parseSettings({ phone_breakpoint_px: 99999 }).phone_breakpoint_px).toBe(DEFAULT_SETTINGS.phone_breakpoint_px);
  });

  it("describes every setting with its current value", () => {
    const text = describeSettings(parseSettings({ hide_done: true }));
    expect(text).toContain("hide_done = true");
    expect(text).toContain("(default false)");
    const lines = text.split("\n");
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(lines.some((l) => l.startsWith(`${key} = `))).toBe(true);
    }
  });
});

describe("viewItems", () => {
  it("includes reviews and done work by default", () => {
    const items = viewItems(base);
    expect(items.some((i) => i.kind === "review")).toBe(true);
    expect(items.some((i) => i.done)).toBe(true);
  });

  it("honours show_reviews and hide_done", () => {
    const noReviews = viewItems({ ...base, settings: { ...DEFAULT_SETTINGS, show_reviews: false } });
    expect(noReviews.every((i) => i.kind === "assignment")).toBe(true);

    const noDone = viewItems({ ...base, settings: { ...DEFAULT_SETTINGS, hide_done: true } });
    expect(noDone.every((i) => !i.done)).toBe(true);
  });
});

describe("balancePositions", () => {
  it("leaves blocks alone when they already fit", () => {
    expect(balancePositions([10, 100, 200], [50, 50, 50], 5)).toEqual([10, 100, 200]);
  });

  it("centres a colliding pair on their shared ideal instead of pushing both down", () => {
    // Two cards both want top = 100; pushing would give [100, 155].
    const tops = balancePositions([100, 100], [50, 50], 5);
    expect(tops[0]).toBeCloseTo(72.5);
    expect(tops[1]).toBeCloseTo(127.5);
    // Equal and opposite displacement — the balanced answer.
    expect(100 - tops[0]!).toBeCloseTo(tops[1]! - 100);
  });

  it("never overlaps and keeps order", () => {
    const heights = [58, 40, 58, 15, 58];
    const tops = balancePositions([200, 205, 210, 215, 600], heights, 7);
    for (let i = 1; i < tops.length; i += 1) {
      expect(tops[i]!).toBeGreaterThanOrEqual(tops[i - 1]! + heights[i - 1]! + 7 - 1e-6);
    }
  });

  it("beats a greedy downward sweep on total displacement", () => {
    const ideals = [200, 205, 210, 215];
    const heights = [58, 58, 58, 58];
    const balanced = balancePositions(ideals, heights, 7);
    let floor = -Infinity;
    const greedy = ideals.map((ideal, i) => {
      const top = Math.max(ideal, floor + 7);
      floor = top + heights[i]!;
      return top;
    });
    const cost = (xs: number[]) => xs.reduce((sum, x, i) => sum + Math.abs(x - ideals[i]!), 0);
    expect(cost(balanced)).toBeLessThan(cost(greedy));
  });

  it("keeps the first block on screen", () => {
    expect(balancePositions([-500], [58], 7)[0]).toBe(4);
  });
});
