import { describe, expect, it } from "vitest";
import { viewItems } from "../src/shared/expand";
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
