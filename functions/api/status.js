const STATUS_KEY = "homework_done_map";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readDoneMap(env) {
  const raw = await env.HOMEWORK_KV.get(STATUS_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDoneMap(env, map) {
  await env.HOMEWORK_KV.put(STATUS_KEY, JSON.stringify(map));
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.HOMEWORK_KV) {
    return json(
      { error: "Missing KV binding. Configure HOMEWORK_KV in wrangler.toml." },
      500,
    );
  }

  if (request.method === "GET") {
    const done = await readDoneMap(env);
    return json({ done });
  }

  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }

    const id = payload?.id;
    const done = payload?.done;

    if (typeof id !== "string" || typeof done !== "boolean") {
      return json({ error: "Expected payload { id: string, done: boolean }." }, 400);
    }

    const map = await readDoneMap(env);
    map[id] = done;
    await writeDoneMap(env, map);
    return json({ done: map });
  }

  return json({ error: "Method not allowed." }, 405);
}
