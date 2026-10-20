import { HttpError } from "./db";
import { handleMcp } from "./mcp";
import { runOperation, type OperationName } from "./service";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

type Route = [method: string, pattern: RegExp, op: OperationName, merge?: (m: RegExpMatchArray) => object];

const withId = (m: RegExpMatchArray) => ({ id: decodeURIComponent(m[1]!) });

/** REST routes. Every route is a thin mapping onto a service operation. */
const ROUTES: Route[] = [
  ["GET", /^\/api\/state$/, "get_state"],
  ["GET", /^\/api\/version$/, "get_version"],
  ["GET", /^\/api\/briefing$/, "get_briefing"],
  ["GET", /^\/api\/upcoming$/, "get_upcoming"],
  ["GET", /^\/api\/overdue$/, "get_overdue"],
  ["PUT", /^\/api\/semester$/, "set_semester"],
  ["POST", /^\/api\/done$/, "set_done"],
  ["GET", /^\/api\/assignments$/, "list_assignments"],
  ["POST", /^\/api\/assignments$/, "create_assignment"],
  ["PATCH", /^\/api\/assignments\/([^/]+)$/, "update_assignment", withId],
  ["DELETE", /^\/api\/assignments\/([^/]+)$/, "delete_assignment", withId],
  ["POST", /^\/api\/courses$/, "create_course"],
  ["PUT", /^\/api\/courses\/order$/, "reorder_courses"],
  ["PATCH", /^\/api\/courses\/([^/]+)$/, "update_course", withId],
  ["DELETE", /^\/api\/courses\/([^/]+)$/, "delete_course", withId],
  ["POST", /^\/api\/markers$/, "create_marker"],
  ["PATCH", /^\/api\/markers\/([^/]+)$/, "update_marker", withId],
  ["DELETE", /^\/api\/markers\/([^/]+)$/, "delete_marker", withId],
  ["POST", /^\/api\/lecture-slots$/, "create_lecture_slot"],
  ["PATCH", /^\/api\/lecture-slots\/([^/]+)$/, "update_lecture_slot", withId],
  ["DELETE", /^\/api\/lecture-slots\/([^/]+)$/, "delete_lecture_slot", withId],
  ["POST", /^\/api\/series$/, "create_series"],
  ["PATCH", /^\/api\/series\/([^/]+)$/, "update_series", withId],
  ["DELETE", /^\/api\/series\/([^/]+)$/, "delete_series", withId],
  ["POST", /^\/api\/series\/([^/]+)\/skip$/, "skip_week", (m) => ({ series_id: decodeURIComponent(m[1]!) })],
];

const NUMERIC = new Set(["days"]);
const BOOLEAN = new Set(["done", "keep_assignments"]);

function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) out[k] = NUMERIC.has(k) ? Number(v) : BOOLEAN.has(k) ? v === "true" : v;
  return out;
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const route = ROUTES.map((r) => [r, url.pathname.match(r[1])] as const).find(
      ([r, m]) => m && r[0] === request.method,
    );
    if (!route) {
      const pathExists = ROUTES.some((r) => r[1].test(url.pathname));
      throw new HttpError(pathExists ? 405 : 404, pathExists ? "method not allowed" : "not found");
    }
    const [[, , opName, merge], match] = route;
    const body = request.method === "GET" || request.method === "DELETE" ? queryInput(url) : await request.json().catch(() => {
      throw new HttpError(400, "invalid JSON body");
    });
    const result = await runOperation(opName, { ...(body as object), ...(merge ? merge(match!) : {}) }, env.DB);
    return typeof result === "string"
      ? new Response(result, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } })
      : Response.json(result, { headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.message, details: error.details }, { status: error.status, headers });
    }
    console.error(error);
    return Response.json({ error: "internal error" }, { status: 500, headers });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request, env.DB);
    if (url.pathname.startsWith("/api/")) return handleApi(request, url, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
