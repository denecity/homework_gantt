import type { AppState, Assignment, Course, LectureSlot, Marker, Semester, Series } from "../shared/schema";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const json = (s: string | null): string[] => (s ? (JSON.parse(s) as string[]) : []);

type Row = Record<string, unknown>;

const mapSlot = (r: Row): LectureSlot => ({ ...(r as unknown as LectureSlot), skip_dates: json(r.skip_dates as string) });
const mapSeries = (r: Row): Series => ({ ...(r as unknown as Series), skip_dates: json(r.skip_dates as string) });
const mapAssignment = (r: Row): Assignment => ({
  ...(r as unknown as Assignment),
  done: r.done === 1,
  detached: r.detached === 1,
});

export const BUMP_VERSION = "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'";

export async function loadVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'version'").first<{ value: string }>();
  return Number(row?.value ?? 0);
}

export async function loadState(db: D1Database): Promise<AppState> {
  const [meta, semester, courses, markers, slots, series, assignments, reviews] = await db.batch<Row>([
    db.prepare("SELECT value FROM meta WHERE key = 'version'"),
    db.prepare("SELECT name, starts_on, ends_on, lectures_end_on, review_hours FROM semester WHERE id = 1"),
    db.prepare("SELECT * FROM courses ORDER BY sort_order, name"),
    db.prepare("SELECT * FROM markers ORDER BY at"),
    db.prepare("SELECT * FROM lecture_slots ORDER BY weekday, start_time"),
    db.prepare("SELECT * FROM series ORDER BY id"),
    db.prepare("SELECT * FROM assignments ORDER BY due_at"),
    db.prepare("SELECT key FROM review_done"),
  ]);
  return {
    version: Number(meta!.results[0]?.value ?? 0),
    semester: (semester!.results[0] as unknown as Semester | undefined) ?? null,
    courses: courses!.results as unknown as Course[],
    markers: markers!.results as unknown as Marker[],
    lecture_slots: slots!.results.map(mapSlot),
    series: series!.results.map(mapSeries),
    assignments: assignments!.results.map(mapAssignment),
    review_done: reviews!.results.map((r) => r.key as string),
  };
}

export async function getOne<T>(db: D1Database, table: string, id: string, map?: (r: Row) => T): Promise<T> {
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Row>();
  if (!row) throw new HttpError(404, `${table} '${id}' not found`);
  return map ? map(row) : (row as T);
}

export const getCourse = (db: D1Database, id: string) => getOne<Course>(db, "courses", id);
export const getMarker = (db: D1Database, id: string) => getOne<Marker>(db, "markers", id);
export const getSlot = (db: D1Database, id: string) => getOne(db, "lecture_slots", id, mapSlot);
export const getSeries = (db: D1Database, id: string) => getOne(db, "series", id, mapSeries);
export const getAssignment = (db: D1Database, id: string) => getOne(db, "assignments", id, mapAssignment);

export async function getSemester(db: D1Database): Promise<Semester | null> {
  return db
    .prepare("SELECT name, starts_on, ends_on, lectures_end_on, review_hours FROM semester WHERE id = 1")
    .first<Semester>();
}

export async function listSeriesAssignments(db: D1Database, seriesId: string): Promise<Assignment[]> {
  const { results } = await db.prepare("SELECT * FROM assignments WHERE series_id = ?").bind(seriesId).all<Row>();
  return results.map(mapAssignment);
}

/** Builds `INSERT … ON CONFLICT(id) DO UPDATE` for the given columns. */
export function upsert(db: D1Database, table: string, row: Record<string, unknown>): D1PreparedStatement {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
    ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`;
  return db.prepare(sql).bind(...cols.map((c) => row[c] ?? null));
}

export function write(db: D1Database, statements: D1PreparedStatement[]) {
  return db.batch([...statements, db.prepare(BUMP_VERSION)]);
}
