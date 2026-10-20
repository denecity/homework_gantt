# Homework Gantt v2 — Spec & TODO

A vertical, "in the moment" homework timeline for the **current semester only**.
You edit it through the web UI or, mostly, through **Claude over MCP**. For setup, Claude reads
course info in Chrome and then makes MCP calls.

## Decisions (from the planning discussion)

| # | Topic | Decision |
|---|-------|----------|
| 1 | Storage | ✅ Everything lives in a database (Cloudflare **D1**). The old `homework.json` is retired. |
| 2 | Model | ✅ Course / Series / Assignment split |
| 3 | Materialization | ✅ Series expand into real assignment rows with stable ids, so single weeks can be edited |
| 4 | Status | ❌ Just `done` / not done |
| 5 | Semesters | ❌ No archive. Only the current semester matters |
| 6 | History/undo | ❌ Not needed |
| 7 | REST API | ✅ Proper CRUD API, validated in one place |
| 8 | Auth | ❌ **No auth** (site, API and MCP are all open; this is intentional) |
| 9 | MCP server | ✅ Remote MCP endpoint in the same Worker, using the same DB |
| 10 | MCP tools | ✅ list/upcoming/overdue, CRUD courses/assignments/series, move deadline, set done, skip week, week summary |
| 11 | Bulk import | ❌ Setup goes Chrome → MCP calls instead |
| 12 | Other MCP integrations | ❌ Not needed |
| 13 | Briefing | ✅ `get_briefing` tool + `homework_briefing` MCP prompt |
| 14 | Live updates | ✅ Open tabs pick up changes (from MCP or other devices) automatically |
| 15 | Layout | ✅ **Vertical**: time runs top→bottom, one column per course, sticky headers. Must look good on desktop **and** mobile |
| 16 | Per-day agenda | ❌ You need to see where starts and deadlines sit at a point in time |
| 17 | Layout toggle | ❌ |
| 18 | Scroll/zoom | ✅ Zoom levels + "jump to now". The range is **limited to the semester**, with semester dates drawn as labelled lines (semester start/end, lecture-free periods, exam session start/end…) |
| 19 | Time-of-day | ✅ Hour lines, night/weekend shading, noon emphasis |
| 20 | Overlaps | ✅ Overlapping items in a course column get side-by-side lanes |
| 21 | Mobile | ✅ Equal focus with desktop |
| 22 | Countdown | ✅ On every card, amber under 24h, red under 6h |
| 23 | Progress fill | ✅ Card fills from release → now |
| 24 | Done styling | ✅ Faded + struck through |
| 25 | Overdue shelf | ✅ Overdue, not-done items pinned at the top |
| 26 | Theme | ✅ **Dark mode only** |
| 27, 28 | Workload strip, filter chips | ❌ |
| 29 | Exams | ✅ Exam markers (diamonds) on the timeline |
| 30 | Editing | ✅ Click card → side panel (bottom sheet on mobile): done, title, release, deadline, link, notes; drag the bottom edge to move the deadline |
| 31 | Quick-add NL | ❌ |
| 32 | Keyboard | ✅ `j/k` move, `x` toggle done, `t` now, `+/-` zoom, `Enter` open, `Esc` close |
| 33, 34 | Progress slider, time tracking | ❌ |
| 35 | Links | Course page link only (plus an optional per-assignment link override) |
| 36–39 | ICS, notifications, scraping, morning brief | ❌ |
| 40–45 | Engineering | Claude's call: clean TypeScript, shared zod schemas, smart rendering, tests for time logic, Europe/Zurich time zone, new README |
| — | Deploy | **wrangler** (Worker + static assets + D1) replaces Cloudflare Pages Git integration and KV |
| — | Rendering | Must be cleverer than "rebuild all DOM every second" |

### New feature: lecture review windows
- Each course has weekly **lecture slots** (weekday, start, end).
- Each lecture occurrence in the semester (except during breaks) produces a **review** item that runs
  from the lecture's end to **+2 days** (configurable). It's a reminder to quickly go over that lecture.
- Reviews show up in the course column (styled differently from homework) and can be checked off like assignments.
- Lectures themselves are drawn as faint blocks, so each review visibly follows its lecture.

## Architecture

```
wrangler.jsonc          Worker + assets (public/) + D1 binding "DB"
migrations/             D1 SQL migrations
src/shared/             zod schemas, Zurich time helpers, series/lecture expansion (used by worker + web)
src/worker/index.ts     router: /api/*  /mcp  → else static assets
src/worker/db.ts        all SQL
src/worker/service.ts   domain operations (used by both REST and MCP, so they cannot drift)
src/worker/api.ts       REST handlers
src/worker/mcp.ts       MCP (Streamable HTTP, stateless JSON-RPC)
src/web/                frontend TS, bundled by esbuild → public/app.js
test/                   vitest for time/expansion/lane packing
```

### Data model (D1)
- `semester` (single row): `name`, `starts_on`, `ends_on` (view range, incl. exam session), `lectures_end_on`, `review_hours` (default 48)
- `markers`: `id, kind ('semester'|'break'|'exam'|'other'), label, at, end_at?, course_id?`
  - `semester` → full-width labelled line (semester start, end, session start…)
  - `break` → shaded range with no lectures (e.g. Christmas break)
  - `exam` → diamond in the course column (or full width if no course)
- `courses`: `id (slug), name, short, color, link, sort_order`
- `lecture_slots`: `id, course_id, weekday (1=Mon..7), start_time 'HH:MM', end_time, skip_dates JSON`
- `series`: `id, course_id, title_template ('Sheet {n}'), first_release, first_due, every_days (7), until, start_number, skip_dates JSON`
- `assignments`: `id, course_id, series_id?, seq?, title, release_at, due_at, link?, notes, done, done_at, detached`
  - Series occurrences get the id `"{series}-{k}"` (k = week index, so it survives skips/renumbering). Numbers shown in titles skip skipped weeks. Editing a single occurrence sets `detached=1`, so regenerating the series won't overwrite it.
- `review_done`: `key ('{slot}@{YYYY-MM-DD}')`, `done_at`. Stable even when a slot's time changes.
- `meta`: `version` counter, bumped on every write (used for live updates)

Times are stored as UTC ISO strings. Local wall-clock inputs (e.g. "Mon 12:00") are interpreted in **Europe/Zurich**.

### Rendering pipeline
- Everything is positioned in **minutes since the view origin** via CSS: `top: calc(var(--start) * var(--ppm))`.
  **Zoom = changing one CSS variable** (`--ppm`, px per minute); no JS re-layout.
- The clock tick sets **one CSS variable** (`--now`) on the root. The now line and every card's progress fill
  are derived in CSS from it.
- JS work per tick (every 30s) is limited to countdown text + urgency classes, and only for cards that are
  **visible** (IntersectionObserver).
- DOM is rebuilt only when data changes, and even then keyed diffing reuses existing nodes.
- Day grid: one element per day (real duration, so DST is correct); hour lines are CSS gradients.
- Lane packing (greedy interval partitioning) runs per column only when data changes.

### Live updates
- `GET /api/version` is cheap. Tabs poll every 15s while visible and on focus. If the version changed, they
  refetch `/api/state` and diff-render.

## Implementation notes
- Overdue shelf: assignments stay there until done. Missed lecture reviews drop off 7 days after their window closed.
- Cards widen into lanes that are free for their whole duration; chained overlapping sheets (due after the next release) legitimately use 2 lanes.
- Zoom has four label densities: tiny (weekly labels) / low / mid (6h labels) / high (hour lines and labels). Zoom level is stored per device in localStorage.
- Card contents adapt via container queries: full title → short `#n` → checkbox only; countdown always refers to the deadline (card bottom).
- Polling pauses while the tab is hidden and runs immediately on focus/visibility.
- MCP is a hand-rolled stateless Streamable-HTTP JSON-RPC handler (no SDK, no Durable Objects): initialize, ping, tools/*, prompts/*.

## TODO

- [x] Spec
- [x] Scaffold: package.json, tsconfig, wrangler.jsonc, esbuild, vitest; remove Pages/KV/legacy files
- [x] D1 migration
- [x] Shared: schemas, Zurich time helpers, series expansion, lecture/review expansion, lane packing
- [x] Worker: db + service layer
- [x] REST API
- [x] MCP endpoint: tools + `homework_briefing` prompt + `get_briefing`
- [x] Web: vertical timeline (columns, sticky headers, day gutter, now line, semester lines, breaks, exams)
- [x] Web: cards (countdown, progress fill, done styling, lanes), reviews + lectures
- [x] Web: overdue shelf, zoom (+ pinch / ctrl-wheel), jump to now, semester-bounded scroll
- [x] Web: side panel / bottom sheet editor, drag the deadline, course editor, marker editor
- [x] Web: keyboard shortcuts
- [x] Web: live update polling
- [x] Dark design, mobile polish
- [x] Tests (time, series expansion, lectures/reviews, lane packing)
- [x] Demo seed script for local dev (runs through MCP)
- [x] README (wrangler setup, D1, deploy, connecting MCP in Claude)
- [x] Local verification in browser (desktop + mobile)
- [ ] Remote: `wrangler login` → `npm run setup:remote` (needs the owner's Cloudflare login)
- [ ] Disconnect the old Cloudflare Pages project
- [ ] Real HS 2026 setup via Claude (Chrome → MCP)
