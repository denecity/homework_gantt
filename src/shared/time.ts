// Europe/Zurich wall-clock helpers. All instants are epoch milliseconds.

export const TZ = "Europe/Zurich";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
}

export function zonedParts(ms: number): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormat.formatToParts(ms)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!]!,
  };
}

/** Offset of Zurich from UTC at the given instant, in ms. */
function offsetAt(ms: number): number {
  const p = zonedParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Zurich wall-clock time → instant. Nonexistent (spring-forward) times resolve forward. */
export function zonedToMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - offsetAt(naive);
  const second = naive - offsetAt(first);
  return first === second ? first : Math.max(first, second);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isDate = (s: string) => DATE_RE.test(s);
export const isTime = (s: string) => TIME_RE.test(s);

/** Parses either an absolute ISO instant (with Z/offset) or a Zurich-local `YYYY-MM-DDTHH:MM` / `YYYY-MM-DD`. */
export function parseInstant(s: string): number {
  const local = LOCAL_RE.exec(s);
  if (local) {
    const [, y, mo, d, h, mi] = local;
    return zonedToMs(+y!, +mo!, +d!, +h!, +mi!);
  }
  const date = DATE_RE.exec(s);
  if (date) return zonedToMs(+date[1]!, +date[2]!, +date[3]!);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid date/time: ${s}`);
  return ms;
}

export function isInstant(s: string): boolean {
  try {
    parseInstant(s);
    return true;
  } catch {
    return false;
  }
}

export const toIso = (ms: number) => new Date(ms).toISOString();

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of the Zurich calendar day containing `ms`. */
export function dateKey(ms: number): string {
  const p = zonedParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Zurich-local `YYYY-MM-DDTHH:MM` (the format of <input type="datetime-local">). */
export function localInput(ms: number): string {
  const p = zonedParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Pure calendar arithmetic on YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 1 = Monday … 7 = Sunday, for a calendar date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export function startOfDay(date: string): number {
  return parseInstant(date);
}

/** Instant for a calendar date + HH:MM in Zurich. */
export function atTime(date: string, time: string): number {
  return parseInstant(`${date}T${time}`);
}

/** Splits a Zurich-local `YYYY-MM-DDTHH:MM` (or absolute ISO) into date + time in Zurich. */
export function splitLocal(s: string): { date: string; time: string } {
  const ms = parseInstant(s);
  const p = zonedParts(ms);
  return { date: dateKey(ms), time: `${pad(p.hour)}:${pad(p.minute)}` };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}
