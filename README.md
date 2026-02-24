# Homework Gantt (Cloudflare Pages)

Config-driven homework tracker with:

- real-time scrolling 10-day Gantt window (now centered)
- release-to-deadline bars
- click bars to toggle done/undone
- persistent done state across devices via Cloudflare KV

## Project structure

- `public/index.html` - HTML entry point
- `public/app.js` - timeline + UI logic
- `public/styles.css` - styling
- `public/config/homework.json` - assignment config
- `functions/api/status.js` - persistent API for done status

## Deployment model

- Cloudflare Pages with Git integration (branch: `main`)
- Dashboard-managed bindings (KV is configured in Pages settings, not in repo)

## Edit assignments

Update `public/config/homework.json`:

```json
{
  "assignments": [
    {
      "id": "unique-id",
      "lecture": "Lecture name",
      "release": "2026-02-24T09:00:00",
      "deadline": "2026-03-01T23:59:00",
      "repeatWeekly": false,
      "color": "#0F6C7A"
    }
  ]
}
```

Notes:

- `id` must stay stable so done state persists.
- `lecture` is printed directly on the bar.
- `repeatWeekly` controls whether the assignment repeats every 7 days.
- `color` accepts hex only (`#RGB`, `#RRGGBB`, `#RRGGBBAA`).
- Date-time strings are interpreted in browser local time when no timezone suffix is provided.

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
   - Production environment -> production namespace
   - Preview environment -> preview namespace
5. Deploy by pushing commits to `main`.

Expected successful deploy behavior:

- no `Executing user deploy command: npx wrangler deploy`
- no `Missing entry-point to Worker script or to assets directory`
- Pages deployment publishes successfully

## Local dev

- Static preview (no persistence): `python3 -m http.server 8788 --directory public`
- Then open `http://localhost:8788`

Notes:

- Local static preview does not provide `/api/status`.
- The UI still loads assignments; persistence works once deployed with KV binding.

## Temporary fallback (if migration is blocked)

If your current pipeline still forces a deploy command, use:

- `npx wrangler pages deploy public --project-name homework-gantt`

This is only a temporary unblock. Preferred setup is native Pages Git builds.

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
