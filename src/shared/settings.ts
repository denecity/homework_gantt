// Every design choice that was once a hard-coded decision lives here, so it can be changed
// over MCP instead of by editing code. Stored as one JSON blob in the `settings` table.

import { z } from "zod";
import { DEFAULT_SETTINGS, type Settings as SettingsType } from "./settings-defaults";

export { DEFAULT_SETTINGS };
export type { SettingsType };

export const Settings = z.object({
  // ---- layout ----------------------------------------------------------------------
  phone_layout: z
    .enum(["lane", "columns"])
    .default("lane")
    .describe("Narrow screens: 'lane' = one full-width lane, cards anchored at the deadline; 'columns' = a column per course"),
  lane_mode: z
    .enum(["split", "single"])
    .default("single")
    .describe(
      "Lane layout: 'single' = one lane of pennant cards (each points at its own deadline); 'split' = two lanes, work on one side and lecture repetition on the other",
    ),
  work_lane_pct: z
    .number()
    .int()
    .min(25)
    .max(85)
    .default(58)
    .describe("Width of the work lane as a percentage, when lane_mode is 'split'"),
  work_lane_label: z.string().min(1).max(20).default("Work").describe("Header above the exercises/deadlines lane"),
  review_lane_label: z.string().min(1).max(20).default("Repetition").describe("Header above the lecture review lane"),
  desktop_layout: z
    .enum(["columns", "lane"])
    .default("columns")
    .describe("Wide screens: 'columns' = a column per course; 'lane' = the phone layout everywhere"),
  phone_breakpoint_px: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .default(720)
    .describe("Screens at or below this width use phone_layout. 0 = never, 2000 = always"),

  // ---- what the timeline shows ------------------------------------------------------
  show_release_marks: z
    .boolean()
    .default(true)
    .describe("Phone: mark where each assignment opens with a dotted line and a small label"),
  show_next_up: z.boolean().default(true).describe("Banner above the timeline with the single most urgent open item"),
  show_overdue_shelf: z.boolean().default(true).describe("Strip of overdue items pinned at the top"),
  show_reviews: z.boolean().default(true).describe("Show lecture review windows at all"),
  show_lectures: z.boolean().default(true).describe("Show the lectures themselves as blocks/ticks"),
  show_progress_fill: z.boolean().default(true).describe("Fill cards from release to now"),
  hide_done: z.boolean().default(false).describe("Hide finished items instead of fading them"),

  // ---- urgency ----------------------------------------------------------------------
  soon_hours: z.number().int().min(1).max(336).default(24).describe("Under this many hours left, a card turns amber"),
  urgent_hours: z.number().int().min(1).max(336).default(6).describe("Under this many hours left, a card turns red"),
  review_grace_days: z
    .number()
    .int()
    .min(0)
    .max(90)
    .default(7)
    .describe("A missed lecture review drops off the overdue list after this many days. Assignments never drop off"),

  // ---- zoom -------------------------------------------------------------------------
  phone_zoom_pxh: z.number().min(1).max(200).default(9).describe("Default phone zoom, in pixels per hour"),
  desktop_zoom_pxh: z.number().min(0.5).max(200).default(10).describe("Default desktop zoom, in pixels per hour"),
  remember_zoom: z.boolean().default(true).describe("Remember the zoom level per device instead of using the default"),
});

export type Settings = SettingsType;
export const SettingsPatch = Settings.partial();

/** Tolerant parse: unknown or invalid keys fall back to their default rather than erroring. */
export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in Settings.shape)) continue;
    const field = Settings.shape[key as keyof Settings];
    const parsed = field.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as unknown as Settings;
}

/** One line per setting, for `get_settings`. */
export function describeSettings(settings: Settings): string {
  return Object.entries(Settings.shape)
    .map(([key, field]) => {
      const current = JSON.stringify(settings[key as keyof Settings]);
      const fallback = JSON.stringify(DEFAULT_SETTINGS[key as keyof Settings]);
      const changed = current !== fallback ? `  (default ${fallback})` : "";
      return `${key} = ${current}${changed}\n  ${field.description ?? ""}`;
    })
    .join("\n");
}
