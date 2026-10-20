# Homework Gantt

A vertical, dark-mode timeline of the current semester's homework. It runs as a Cloudflare Worker with D1
and has a built-in **MCP server**, so Claude can set it up and edit it.

- One column per course. Time runs top to bottom, with a live "now" line.
- Assignment cards run from release to deadline. They show a countdown, a progress fill, done state and an overdue shelf.
- **Lecture reviews:** every lecture creates a review window (lecture end → +48h) to go over that lecture.
- Semester dates, breaks and exams appear as markers. The view is limited to the semester.
- Zoom (buttons, `+`/`−`, ctrl+scroll, pinch), jump to now, and a click-to-edit panel (a bottom sheet on mobile).
- Drag a card's bottom edge to move its deadline. Keyboard: `j/k` move, `x` done, `Enter` open, `t` now, `Esc` close.
- **Installable** (PWA) with a service worker, and **push notifications** driven by rules you edit over MCP.
- Open tabs pick up changes made through MCP or on other devices within about 15s.
- On phones the timeline switches to two lanes — **Work** (exercises, deadlines, submissions) and
  **Repetition** (lecture reviews). Cards sit at their deadline with a tail up to their release, and each
  lane stacks independently. Layout, lane split and labels are settings, not hard-coded rules.

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
`create/update/delete_series`, `skip_week`, `create/update/delete_assignment`, `move_deadline`, `set_done`,
`get/update/reset_settings`, `list/create/update/delete_notification_rule`, `install_default_notification_rules`,
`preview_notifications`, `list_recent_notifications`, `list/delete_notification_device`, `send_test_notification`,
`run_notifications_now`. There is also a `homework_briefing` prompt.

## Settings

Layout and behaviour are data, not code. `get_settings` lists every key with its current value, its
default and what it does; `update_settings` changes any subset; `reset_settings` restores the defaults.
Open tabs apply the change within ~15s, including swapping the whole layout.

Covered: `phone_layout` / `desktop_layout` (`lane` or `columns`) and `phone_breakpoint_px`;
`lane_mode` (`split` or `single`), `work_lane_pct`, `work_lane_label`, `review_lane_label`;
`show_next_up`, `show_overdue_shelf`, `show_reviews`, `show_lectures`, `show_progress_fill`, `hide_done`;
`soon_hours` and `urgent_hours` (when a card turns amber, then red), `review_grace_days`;
`phone_zoom_pxh`, `desktop_zoom_pxh`, `remember_zoom`.

## Notifications

Nothing about reminders is hard-coded. A rule is either:

- **`relative`** — one notification per item, `offset_minutes` from its `anchor` (`due` or `release`).
  `-1440` is 24h before a deadline; `+240` is 4h after a lecture ends.
- **`digest`** — one summary at `at_time` on the chosen `weekdays`, covering the next `window_hours`,
  optionally including overdue work, capped at `max_items`.

Every rule filters by `applies_to` (assignments / reviews / all), `course_ids` and `only_open`, writes its own
`title` and `body` from `{course} {short} {title} {due} {left} {count} {list}`, and can defer around its own
`quiet_from` / `quiet_until`.

`install_default_notification_rules` adds a starter set (morning digest, a day before each deadline, a lecture
review nudge) that you can then rewrite or delete. `preview_notifications` dry-runs the next N days without
sending anything — use it before trusting a new rule.

A cron trigger evaluates the rules every 5 minutes. Each notification is logged by key, so a rule never fires
twice, and a missed window is caught up once rather than flooding the device.

### Push setup

Generate a VAPID keypair and store it as Worker secrets:

```bash
node -e 'const{webcrypto:c}=require("node:crypto");const b=b=>Buffer.from(b).toString("base64url");c.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]).then(async k=>console.log("public:",b(await c.subtle.exportKey("raw",k.publicKey)),"\nprivate:",b(await c.subtle.exportKey("pkcs8",k.privateKey))))'
```

Then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (an `https:` URL or `mailto:`) with
`npx wrangler secret put <NAME>`. Install the app on the phone (iOS requires this before it will allow
notifications), then turn notifications on from the bell button.

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
| GET/PATCH | `/api/settings` | read / update settings |
| POST | `/api/settings/reset` | `reset_settings` |
| GET/POST, PATCH/DELETE `:id` | `/api/notification-rules` | rule CRUD |
| GET | `/api/notifications/preview?days=7` | dry run |
| POST | `/api/notifications/test`, `/api/notifications/run` | send a test / run the scheduler now |
| GET/POST | `/api/push/config`, `/api/push/subscribe`, `/api/push/unsubscribe` | device registration |
| PUT | `/api/courses/order` `{ids}` | `reorder_courses` |
| POST, PATCH/DELETE `:id` | `/api/courses`, `/api/markers`, `/api/lecture-slots`, `/api/series` | CRUD |
| POST | `/api/series/:id/skip` `{date, unskip?}` | `skip_week` |
