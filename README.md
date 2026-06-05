# Homework Gantt (Cloudflare Pages)

Config-driven homework tracker with:

- Pannable, zoomable 5/10/14-day Gantt window
- Release-to-deadline bars with urgency pulsing
- Click bar body to toggle done/undone; click bar text to open optional link
- Drag-to-pan, scroll-wheel pan, keyboard navigation
- Course grouping with group labels
- Persistent done state across devices via Cloudflare KV
- PWA support for offline mobile use
- JSON export of done state

## Project structure

- `public/index.html` - HTML entry point
- `public/app.js` - timeline + UI logic + panning
- `public/styles.css` - styling
- `public/sw.js` - service worker (offline cache)
- `public/manifest.json` - PWA manifest
- `public/config/homework.json` - assignment config
- `functions/api/status.js` - persistent API for done status (single + bulk)

## Interaction guide

| Action | How |
|--------|-----|
| Toggle done | Click bar body (or Enter/Space when focused) |
| Open link | Click bar text (link icon) |
| Pan timeline | Drag chart, Shift+scroll, or click ◀ ▶ buttons |
| Jump to today | Click **Today** button or press `T` with chart focused |
| Zoom | Click 5d / 10d / 14d buttons |
| Keyboard nav | Arrow keys on bars or chart; Tab between bars |
| Filter | Type in the search box |
| Export | Click **Export** button → downloads JSON |

## Edit assignments

Update `public/config/homework.json`:

```json
{
  "assignments": [
    {
      "id": "unique-id",
      "lecture": "Lecture name",
      "group": "Optional group label",
      "release": "2026-02-24T09:00:00",
      "deadline": "2026-03-01T23:59:00",
      "repeatWeekly": false,
      "color": "#0F6C7A",
      "link": "https://example.edu/course/homework/1"
    }
  ]
}
```

Notes:

- `id` must stay stable so done state persists.
- `lecture` is printed directly on the bar.
- `group` is optional; when set, rows are sorted by group and a label is shown.
- `link` is optional; when present, clicking bar text opens it in a new tab.
- `repeatWeekly` controls whether the assignment repeats every 7 days.
- `color` accepts hex only (`#RGB`, `#RRGGBB`, `#RRGGBBAA`).
- Date-time strings are interpreted in browser local time when no timezone suffix is provided.

## API endpoints

### `GET /api/status`
Returns the full done map: `{ done: { "id": true, ... }, count: N }`

### `POST /api/status` — single toggle
```json
{ "id": "Quantum Mechanics", "done": true }
```
Returns updated map with count.

### `POST /api/status` — bulk toggle
```json
{ "items": [
  { "id": "Quantum Mechanics", "done": true },
  { "id": "Particle Physics", "done": false }
]}
```
Maximum 50 items per request. Returns `{ done, count, changed }`.

## Cloudflare Pages setup (Git-based)

1. Ensure this repo is connected as a **Pages** project.
2. Build settings (Production + Preview):
   - Framework preset: `None`
   - Build command: *(leave empty)*
   - Build output directory: `public`
   - Root directory: `/`
   - Production branch: `main`
3. Configure KV namespaces in Cloudflare:
   - Create one production namespace for done-state persistence.
   - Create one preview namespace for preview deployments.
4. In Pages project settings, add KV binding:
   - Variable name: `HOMEWORK_KV`
   - Production environment → production namespace
   - Preview environment → preview namespace
5. Deploy by pushing commits to `main`.

## Local dev

- Static preview (no persistence): `python3 -m http.server 8788 --directory public`
- Then open `http://localhost:8788`

Notes:

- Local static preview does not provide `/api/status`.
- The UI still loads assignments; persistence and PWA work once deployed.

## Troubleshooting

If deploy logs show `Executing user deploy command: npx wrangler deploy`, this is a Worker deployment, not Pages Functions.

Symptoms:
- site opens, but checking homework does not sync
- `/api/status` returns `404`
- deployment URL is `*.workers.dev`

Fix:
1. Move to Cloudflare Pages Git build settings (section above).
2. Keep build command empty and output directory `public`.
3. Add `HOMEWORK_KV` binding in Pages settings for both Production and Preview.
