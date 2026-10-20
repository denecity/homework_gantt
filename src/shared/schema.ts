import { z } from "zod";
import { isDate, isInstant, isTime } from "./time";

// ---- primitives ----------------------------------------------------------

export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase letters, digits, - and _ (max 64)");
export const DateStr = z.string().refine(isDate, "expected YYYY-MM-DD");
export const TimeStr = z.string().refine(isTime, "expected HH:MM (24h)");
const INSTANT_HINT = "ISO-8601 instant, or Europe/Zurich local time 'YYYY-MM-DDTHH:MM'";
export const Instant = z
  .string()
  .refine(isInstant, `expected ${INSTANT_HINT}`)
  .describe(INSTANT_HINT);
/** Instant with a field-specific description (keeps the format hint). */
export const instant = (description: string) => Instant.describe(`${description} — ${INSTANT_HINT}`);
export const Color = z.string().regex(/^#([0-9a-fA-F]{6})$/, "expected #RRGGBB");
export const Url = z.url({ protocol: /^https?$/ });
export const Weekday = z.number().int().min(1).max(7).describe("1 = Monday … 7 = Sunday");

// ---- inputs --------------------------------------------------------------

export const SemesterInput = z.object({
  name: z.string().min(1).describe("e.g. 'HS 2026'"),
  starts_on: DateStr.describe("first day shown (usually semester start)"),
  ends_on: DateStr.describe("last day shown (usually end of exam session)"),
  lectures_end_on: DateStr.nullish().describe("last lecture day; defaults to ends_on"),
  review_hours: z.number().int().min(1).max(24 * 14).optional().describe("length of lecture review window, default 48"),
});

export const CourseInput = z.object({
  id: Id.describe("stable slug, e.g. 'qm2'"),
  name: z.string().min(1),
  short: z.string().min(1).max(8).describe("abbreviation for narrow screens, e.g. 'QM'"),
  color: Color,
  link: Url.nullish().describe("course page (e.g. Moodle)"),
  sort_order: z.number().int().optional(),
});
export const CoursePatch = CourseInput.omit({ id: true }).partial();

export const MarkerKind = z.enum(["semester", "break", "exam", "other"]);
export const MarkerInput = z.object({
  id: Id,
  kind: MarkerKind.describe(
    "semester = labelled full-width line (semester start/end, session start…); break = shaded range without lectures (needs end_at); exam = diamond; other = thin line",
  ),
  label: z.string().min(1),
  at: Instant,
  end_at: Instant.nullish(),
  course_id: Id.nullish().describe("exams: the course column to place the diamond in"),
});
export const MarkerPatch = MarkerInput.omit({ id: true }).partial();

export const LectureSlotInput = z.object({
  id: Id,
  course_id: Id,
  weekday: Weekday,
  start_time: TimeStr,
  end_time: TimeStr,
  skip_dates: z.array(DateStr).optional().describe("dates with no lecture"),
});
export const LectureSlotPatch = LectureSlotInput.omit({ id: true, course_id: true }).partial();

export const SeriesInput = z.object({
  id: Id,
  course_id: Id,
  title_template: z.string().min(1).optional().describe("'{n}' is replaced with the sheet number. Default 'Sheet {n}'"),
  first_release: instant("release of the first sheet"),
  first_due: instant("deadline of the first sheet"),
  every_days: z.number().int().min(1).max(60).optional().describe("default 7"),
  until: DateStr.nullish().describe("no releases after this date; default lectures_end_on"),
  start_number: z.number().int().min(0).optional().describe("default 1"),
  skip_dates: z.array(DateStr).optional().describe("release dates with no sheet (numbering continues with the next one)"),
});
export const SeriesPatch = SeriesInput.omit({ id: true, course_id: true }).partial();

export const AssignmentInput = z.object({
  id: Id.optional().describe("generated if omitted"),
  course_id: Id,
  title: z.string().min(1),
  release_at: Instant,
  due_at: Instant,
  link: Url.nullish().describe("overrides course link"),
  notes: z.string().optional(),
  done: z.boolean().optional(),
});
export const AssignmentPatch = AssignmentInput.omit({ id: true, course_id: true }).partial();

// ---- rows / state --------------------------------------------------------

export interface Semester {
  name: string;
  starts_on: string;
  ends_on: string;
  lectures_end_on: string | null;
  review_hours: number;
}
export interface Course {
  id: string;
  name: string;
  short: string;
  color: string;
  link: string | null;
  sort_order: number;
}
export interface Marker {
  id: string;
  kind: z.infer<typeof MarkerKind>;
  label: string;
  at: string;
  end_at: string | null;
  course_id: string | null;
}
export interface LectureSlot {
  id: string;
  course_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  skip_dates: string[];
}
export interface Series {
  id: string;
  course_id: string;
  title_template: string;
  first_release: string;
  first_due: string;
  every_days: number;
  until: string | null;
  start_number: number;
  skip_dates: string[];
}
export interface Assignment {
  id: string;
  course_id: string;
  series_id: string | null;
  seq: number | null;
  title: string;
  release_at: string;
  due_at: string;
  link: string | null;
  notes: string;
  done: boolean;
  done_at: string | null;
  detached: boolean;
}
export interface AppState {
  version: number;
  semester: Semester | null;
  courses: Course[];
  markers: Marker[];
  lecture_slots: LectureSlot[];
  series: Series[];
  assignments: Assignment[];
  review_done: string[];
}
