import type { TimelineItem } from "../shared/expand";
import type { AppState, Course, Marker } from "../shared/schema";

export interface TimelineCallbacks {
  open(item: TimelineItem): void;
  toggle(item: TimelineItem): void;
  moveDeadline(item: TimelineItem, dueMs: number): void;
  openCourse(course: Course): void;
  openMarker(marker: Marker): void;
  reorderCourses(ids: string[]): void;
}

/** What `main.ts` needs from a timeline, so the desktop and phone views are interchangeable. */
export interface TimelineView {
  items: TimelineItem[];
  render(state: AppState): void;
  tick(now: number): void;
  scrollToTime(ms: number, fraction?: number, smooth?: boolean): void;
  zoomBy(factor: number, clientY?: number): void;
  onResize(): void;
  select(id: string | null, scroll?: boolean): void;
  selectStep(dir: 1 | -1): void;
  selected(): TimelineItem | undefined;
  destroy(): void;
}
