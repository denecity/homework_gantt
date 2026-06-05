const STATUS_KEY = "homework_done_map";
const MAX_VALUE_LENGTH = 200;
const MAX_KEYS = 500;
const PRUNE_TARGET = 400;
const MAX_BULK_ITEMS = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function readDoneMap(env) {
  const raw = await env.HOMEWORK_KV.get(STATUS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    /* sanitize: every value must be boolean */
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && k.length > 0 && k.length <= MAX_VALUE_LENGTH && typeof v === "boolean") {
        clean[k] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

async function writeDoneMap(env, map) {
  const serialized = JSON.stringify(map);
  await env.HOMEWORK_KV.put(STATUS_KEY, serialized);
}

function pruneMap(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_KEYS) return map;
  const recent = keys.slice(-PRUNE_TARGET);
  const pruned = {};
  for (const k of recent) {
    pruned[k] = map[k];
  }
  return pruned;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Expected a JSON object.", status: 400 };
  }
  return null;
}

function validateToggle(id, done) {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_VALUE_LENGTH) {
    return { error: "Expected { id: string (1-200 chars), done: boolean }.", status: 400 };
  }
  if (typeof done !== "boolean") {
    return { error: "Expected { id: string, done: boolean }.", status: 400 };
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;

  /* OPTIONS preflight */
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (!env.HOMEWORK_KV) {
    return json(
      { error: "Missing KV binding. Configure HOMEWORK_KV in Cloudflare Pages settings." },
      500,
    );
  }

  /* ── GET: read full done map ── */
  if (request.method === "GET") {
    const done = await readDoneMap(env);
    return json({ done, count: Object.keys(done).length });
  }

  /* ── POST: toggle single or bulk ── */
  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }

    const baseError = validatePayload(payload);
    if (baseError) return json(baseError, baseError.status);

    let map = await readDoneMap(env);

    /* Single toggle: { id, done } */
    if (payload.id !== undefined) {
      const err = validateToggle(payload.id, payload.done);
      if (err) return json(err, err.status);

      map[payload.id] = payload.done;
      map = pruneMap(map);
      await writeDoneMap(env, map);
      return json({ done: map, count: Object.keys(map).length });
    }

    /* Bulk toggle: { items: [{ id, done }, ...] } */
    if (Array.isArray(payload.items)) {
      if (payload.items.length > MAX_BULK_ITEMS) {
        return json({ error: `Maximum ${MAX_BULK_ITEMS} items per bulk request.` }, 400);
      }

      let changed = 0;
      for (const item of payload.items) {
        if (!item || typeof item !== "object") continue;
        const err = validateToggle(item.id, item.done);
        if (err) continue;
        map[item.id] = item.done;
        changed++;
      }

      if (changed === 0) {
        return json({ error: "No valid items in bulk request." }, 400);
      }

      map = pruneMap(map);
      await writeDoneMap(env, map);
      return json({ done: map, count: Object.keys(map).length, changed });
    }

    return json({ error: "Expected { id: string, done: boolean } or { items: [{ id, done }] }." }, 400);
  }

  return json({ error: "Method not allowed." }, 405);
}
