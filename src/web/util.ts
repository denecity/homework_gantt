import { DAY, HOUR, MINUTE, TZ } from "../shared/time";

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper. `on*` attributes become listeners; `style` accepts a CSS string. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = String(value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const formatter = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts });

const timeFmt = formatter({ hour: "2-digit", minute: "2-digit" });
const dayFmt = formatter({ weekday: "short", day: "numeric" });
const monthFmt = formatter({ month: "short" });
const fullFmt = formatter({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const longDayFmt = formatter({ weekday: "short", day: "numeric", month: "short" });

export const fmtTime = (ms: number) => timeFmt.format(ms);
export const fmtDay = (ms: number) => dayFmt.format(ms);
export const fmtMonth = (ms: number) => monthFmt.format(ms);
export const fmtFull = (ms: number) => fullFmt.format(ms);
export const fmtLongDay = (ms: number) => longDayFmt.format(ms);

/** Compact duration: "3d 4h", "5h 12m", "42m". */
export function fmtSpan(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const hr = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / MINUTE);
  if (d >= 7) return `${d}d`;
  if (d > 0) return hr ? `${d}d ${hr}h` : `${d}d`;
  if (hr > 0) return `${hr}h ${String(m).padStart(2, "0")}m`;
  return `${Math.max(m, abs > 0 ? 1 : 0)}m`;
}

/** Largest unit only: "3d", "5h", "42m". */
export function fmtSpanShort(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= DAY) return `${Math.floor(abs / DAY)}d`;
  if (abs >= HOUR) return `${Math.floor(abs / HOUR)}h`;
  return `${Math.max(1, Math.floor(abs / MINUTE))}m`;
}

export type Urgency = "done" | "overdue" | "urgent" | "soon" | "open" | "future";

export function urgencyOf(startMs: number, endMs: number, done: boolean, now: number): Urgency {
  if (done) return "done";
  const left = endMs - now;
  if (left < 0) return "overdue";
  if (left < 6 * HOUR) return "urgent";
  if (left < DAY) return "soon";
  return startMs > now ? "future" : "open";
}

let toastTimer = 0;
export function toast(message: string, kind: "info" | "error" = "info") {
  const el = $("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === "error" ? 5000 : 2200);
}
