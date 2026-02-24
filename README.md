# Homework Gantt (Cloudflare Pages)

Config-driven homework tracker with:

- real-time scrolling 10-day Gantt window (now centered)
- release-to-deadline bars
- checkbox to mark assignments done
- persistent done state across devices via Cloudflare KV

## Project structure

- `public/index.html` - HTML entry point
- `public/app.js` - timeline + UI logic
- `public/styles.css` - styling
- `public/config/homework.json` - assignment config
- `functions/api/status.js` - persistent API for done status
- `wrangler.toml` - Cloudflare Pages + KV bindings

## Edit assignments

Update `public/config/homework.json`:

```json
{
  "assignments": [
    {
      "id": "unique-id",
      "title": "Homework title",
      "release": "2026-02-24T09:00:00",
      "deadline": "2026-03-01T23:59:00",
      "color": "#0f6c7a"
    }
  ]
}
```

Notes:

- `id` must stay stable so done state persists.
- Date-time strings are interpreted in browser local time when no timezone suffix is provided.

## Cloudflare setup

1. Create KV namespaces:
   - `npx wrangler@3 kv namespace create HOMEWORK_KV`
   - `npx wrangler@3 kv namespace create HOMEWORK_KV --preview`
2. Put returned IDs into `wrangler.toml` (`id` and `preview_id`).
3. Create Pages project once:
   - `npx wrangler@3 pages project create homework-gantt`
4. Deploy:
   - `npx wrangler@3 pages deploy public --project-name homework-gantt`

## Local dev

- `npx wrangler@3 pages dev public`

This runs static files and Pages Functions together.
