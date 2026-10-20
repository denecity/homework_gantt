// Plain data, no zod: the browser bundle imports this, the Worker validates against it.
// `settings.test.ts` asserts these stay in step with the zod schema in ./settings.

export interface Settings {
  phone_layout: "lane" | "columns";
  lane_mode: "split" | "single";
  show_release_marks: boolean;
  work_lane_pct: number;
  work_lane_label: string;
  review_lane_label: string;
  desktop_layout: "columns" | "lane";
  phone_breakpoint_px: number;
  show_next_up: boolean;
  show_overdue_shelf: boolean;
  show_reviews: boolean;
  show_lectures: boolean;
  show_progress_fill: boolean;
  hide_done: boolean;
  soon_hours: number;
  urgent_hours: number;
  review_grace_days: number;
  phone_zoom_pxh: number;
  desktop_zoom_pxh: number;
  remember_zoom: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  phone_layout: "lane",
  lane_mode: "single",
  show_release_marks: true,
  work_lane_pct: 58,
  work_lane_label: "Work",
  review_lane_label: "Repetition",
  desktop_layout: "columns",
  phone_breakpoint_px: 720,
  show_next_up: true,
  show_overdue_shelf: true,
  show_reviews: true,
  show_lectures: true,
  show_progress_fill: true,
  hide_done: false,
  soon_hours: 24,
  urgent_hours: 6,
  review_grace_days: 7,
  phone_zoom_pxh: 9,
  desktop_zoom_pxh: 10,
  remember_zoom: true,
};
