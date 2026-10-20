import type { AppState, LectureSlot, Marker, Semester, Series } from "./schema";
import { DAY, HOUR, addDays, atTime, daysBetween, parseInstant, splitLocal, toIso, weekdayOf } from "./time";

// ---- series → assignment occurrences ---------------------------------------

export interface Occurrence {
  id: string;
  seq: number;
  title: string;
  release_at: string;
  due_at: string;
}

/**
 * Expands a series into concrete occurrences. The id uses the period index `k`, so adding a skip date
 * later doesn't reassign done-state to a different week. Wall-clock times are kept across DST.
 */
export function expandSeries(series: Series, semester: Semester | null): Occurrence[] {
  const release = splitLocal(series.first_release);
  const due = splitLocal(series.first_due);
  const dueOffsetDays = daysBetween(release.date, due.date);
  const until = series.until ?? semester?.lectures_end_on ?? semester?.ends_on ?? addDays(release.date, 7 * 16);
  const skips = new Set(series.skip_dates);
  const out: Occurrence[] = [];

  let n = series.start_number;
  for (let k = 0; k < 400; k += 1) {
    const releaseDate = addDays(release.date, k * series.every_days);
    if (releaseDate > until) break;
    if (skips.has(releaseDate)) continue;
    out.push({
      id: `${series.id}-${k}`,
      seq: n,
      title: series.title_template.replaceAll("{n}", String(n)),
      release_at: toIso(atTime(releaseDate, release.time)),
      due_at: toIso(atTime(addDays(releaseDate, dueOffsetDays), due.time)),
    });
    n += 1;
  }
  return out;
}

// ---- lecture slots → lectures + reviews -----------------------------------------

export interface Lecture {
  key: string; // `${slot}@${date}`
  slot_id: string;
  course_id: string;
  date: string;
  startMs: number;
  endMs: number;
}

export interface Review extends Lecture {
  reviewEndMs: number;
}

function breakRanges(markers: Marker[]): Array<[number, number]> {
  return markers
    .filter((m) => m.kind === "break")
    .map((m) => [parseInstant(m.at), m.end_at ? parseInstant(m.end_at) : parseInstant(m.at) + DAY] as [number, number]);
}

export function expandLectures(slots: LectureSlot[], semester: Semester | null, markers: Marker[]): Review[] {
  if (!semester) return [];
  const last = semester.lectures_end_on ?? semester.ends_on;
  const breaks = breakRanges(markers);
  const reviewMs = semester.review_hours * HOUR;
  const out: Review[] = [];

  for (const slot of slots) {
    const skips = new Set(slot.skip_dates);
    const offset = (slot.weekday - weekdayOf(semester.starts_on) + 7) % 7;
    for (let date = addDays(semester.starts_on, offset); date <= last; date = addDays(date, 7)) {
      if (skips.has(date)) continue;
      const startMs = atTime(date, slot.start_time);
      const endMs = atTime(date, slot.end_time);
      if (breaks.some(([a, b]) => startMs < b && endMs > a)) continue;
      out.push({
        key: `${slot.id}@${date}`,
        slot_id: slot.id,
        course_id: slot.course_id,
        date,
        startMs,
        endMs,
        reviewEndMs: endMs + reviewMs,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ---- lane packing -------------------------------------------------------------

export interface Interval {
  start: number;
  end: number;
}

/**
 * Assigns side-by-side lanes to overlapping intervals. Lanes are counted per cluster of transitively
 * overlapping items, so a busy week doesn't narrow every card in the column. `span` lets an item widen
 * into lanes to its right that are free for its whole duration.
 */
export function packLanes<T extends Interval>(items: T[]): Array<T & { lane: number; lanes: number; span: number }> {
  type Packed = T & { lane: number; lanes: number; span: number };
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: Packed[] = [];
  let cluster: Packed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const lanes = laneEnds.length;
    for (const item of cluster) {
      item.lanes = lanes;
      let span = 1;
      while (
        item.lane + span < lanes &&
        !cluster.some((o) => o.lane === item.lane + span && o.start < item.end && o.end > item.start)
      ) {
        span += 1;
      }
      item.span = span;
    }
    result.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const item of sorted) {
    if (item.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    cluster.push({ ...item, lane, lanes: 0, span: 1 });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return result;
}

// ---- briefing -----------------------------------------------------------------

export interface TimelineItem {
  kind: "assignment" | "review";
  id: string;
  course_id: string;
  title: string;
  startMs: number;
  endMs: number;
  done: boolean;
}

/** Assignments + lecture reviews as one flat list (used by UI and briefing). */
export function timelineItems(state: AppState): TimelineItem[] {
  const reviewDone = new Set(state.review_done);
  const items: TimelineItem[] = state.assignments.map((a) => ({
    kind: "assignment",
    id: a.id,
    course_id: a.course_id,
    title: a.title,
    startMs: parseInstant(a.release_at),
    endMs: parseInstant(a.due_at),
    done: a.done,
  }));
  for (const r of expandLectures(state.lecture_slots, state.semester, state.markers)) {
    items.push({
      kind: "review",
      id: r.key,
      course_id: r.course_id,
      title: `Review lecture ${r.date.slice(8, 10)}.${r.date.slice(5, 7)}.`,
      startMs: r.endMs,
      endMs: r.reviewEndMs,
      done: reviewDone.has(r.key),
    });
  }
  return items.sort((a, b) => a.endMs - b.endMs);
}

/** Reviews stop nagging a week after their window closed; assignments stay overdue until done. */
export const REVIEW_OVERDUE_GRACE = 7 * DAY;

export function isOverdue(item: TimelineItem, now: number): boolean {
  if (item.done || item.endMs >= now) return false;
  return item.kind === "assignment" || now - item.endMs < REVIEW_OVERDUE_GRACE;
}
