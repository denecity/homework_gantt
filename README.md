# Homework Gantt

A vertical, dark-mode timeline of the current semester's homework. It runs as a Cloudflare Worker with D1
and has a built-in **MCP server**, so Claude can set it up and edit it.

- One column per course. Time runs top to bottom, with a live "now" line.
- Assignment cards run from release to deadline. They show a countdown, a progress fill, done state and an overdue shelf.
- **Lecture reviews:** every lecture creates a review window (lecture end → +48h) to go over that lecture.
- Semester dates, breaks and exams appear as markers. The view is limited to the semester.
- Zoom (buttons, `+`/`−`, ctrl+scroll, pinch), jump to now, and a click-to-edit panel (a bottom sheet on mobile).
- Drag a card's bottom edge to move its deadline. Keyboard: `j/k` move, `x` done, `Enter` open, `t` now, `Esc` close.
- Open tabs pick up changes made through MCP or on other devices within about 15s.

Design decisions and the data model are in [SPEC.md](SPEC.md). **There is no auth by design:** anyone with the URL can
read and edit.

## Stack

```
wrangler.jsonc        Worker + static assets (public/) + D1 binding DB
migrations/           D1 schema
src/shared/           zod schemas, Europe/Zurich time helpers, series/lecture expansion, lane packing
src/worker/           router (index.ts), SQL (db.ts), operations (service.ts), MCP (mcp.ts)
src/web/              frontend TypeScript, bundled by esbuild into public/app.js
test/                 vitest
```

The REST API and the MCP tools both come from the same `operations` table in `src/worker/service.ts`.

## Local development

Needs Node 20+.

```bash
npm install
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

In a second terminal, you can fill the local database with demo data. This also exercises the MCP endpoint:

```bash
npm run db:seed:demo
```

Open http://localhost:8787. Other useful commands:

```bash
npm test
```

```bash
npm run typecheck
```

## Deploy (Cloudflare, via wrangler)

1. Log in once (opens a browser):

   ```bash
   npx wrangler login
   ```

2. Create the D1 database, write its id into `wrangler.jsonc`, run migrations and deploy:

   ```bash
   npm run setup:remote
   ```

3. Later deploys:

   ```bash
   npm run deploy
   ```

   Run `npm run db:migrate:remote` first if new files were added under `migrations/`.

The old Cloudflare **Pages** project (Git integration + KV) is no longer used. Disconnect or delete it in the
Cloudflare dashboard, otherwise pushes to `main` will keep deploying a broken static copy.

## Connecting Claude (MCP)

The MCP endpoint is `https://<your-worker>.workers.dev/mcp` (Streamable HTTP, stateless, no auth).

- **claude.ai / Claude desktop:** Settings → Connectors → *Add custom connector* → paste the URL.
- **Claude Code:**

  ```bash
  claude mcp add --transport http homework https://<your-worker>.workers.dev/mcp
  ```

Tools: `get_briefing`, `week_summary`, `get_upcoming`, `get_overdue`, `list_assignments`, `get_state`,
`set_semester`, `create/update/delete_marker`, `create/update/delete_course`, `reorder_courses`, `create/update/delete_lecture_slot`,
`create/update/delete_series`, `skip_week`, `create/update/delete_assignment`, `move_deadline`, `set_done`.
There is also a `homework_briefing` prompt.

### Typical semester setup (Chrome → MCP)

Ask Claude to read the course pages and then:

1. `set_semester`: name, first day, last day of the exam session, last lecture day
2. `create_marker`: semester start/end, lecture-free weeks (`break` with `end_at`), exam session, exams (`exam` with `course_id`)
3. `create_course` for each course: id, name, abbreviation, color, Moodle link
4. `create_lecture_slot` for each weekly lecture (this is what creates the review windows)
5. `create_series` for weekly exercise sheets (first release + first deadline, repeats weekly until the last lecture), or `create_assignment` for one-offs

Times without a timezone, like `2026-09-21T12:00`, are read as Europe/Zurich.

## REST API

| Method | Path | Operation |
|---|---|---|
| GET | `/api/state`, `/api/version`, `/api/briefing?days=3`, `/api/upcoming?days=7`, `/api/overdue` | reads |
| PUT | `/api/semester` | `set_semester` |
| POST | `/api/done` `{id, done}` | `set_done` (assignment id or review id `slot@YYYY-MM-DD`) |
| GET/POST | `/api/assignments` | list / create |
| PATCH/DELETE | `/api/assignments/:id` | update / delete |
| PUT | `/api/courses/order` `{ids}` | `reorder_courses` |
| POST, PATCH/DELETE `:id` | `/api/courses`, `/api/markers`, `/api/lecture-slots`, `/api/series` | CRUD |
| POST | `/api/series/:id/skip` `{date, unskip?}` | `skip_week` |
