// Minimal stateless MCP server over Streamable HTTP (JSON responses, no sessions).
// Every tool is an entry from `operations`, so the MCP surface and the REST API never drift apart.

import { z } from "zod";
import { HttpError } from "./db";
import { operations, runOperation } from "./service";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "homework-gantt", version: "2.0.0" };

const INSTRUCTIONS = `Homework Gantt: a vertical timeline of the current semester's homework at ETH, in Europe/Zurich time.
- Start with get_briefing for "what's due" questions.
- Setup order: set_semester → create_marker (semester lines, breaks, exams) → create_course → create_lecture_slot → create_series (recurring sheets) / create_assignment (one-offs).
- Local times like '2026-09-21T12:00' are interpreted as Europe/Zurich.
- Lecture reviews: every lecture creates a review item from lecture end to +review_hours; its id is 'slotId@YYYY-MM-DD' and can be passed to set_done.
- Prefer skip_week over deleting series occurrences.`;

const HIDDEN = new Set(["get_version"]);

const BRIEFING_PROMPT = {
  name: "homework_briefing",
  description: "Brief me on my homework: what's overdue, what's due soon, and lecture reviews to do.",
  arguments: [{ name: "days", description: "Look-ahead in days (default 3)", required: false }],
};

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function toolList() {
  return Object.entries(operations)
    .filter(([name]) => !HIDDEN.has(name))
    .map(([name, operation]) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(operation.input, { io: "input" }) as Record<string, unknown>;
      return {
        name,
        description: operation.description,
        inputSchema,
        annotations: {
          readOnlyHint: Boolean("readOnly" in operation && operation.readOnly),
          destructiveHint: name.startsWith("delete_"),
          openWorldHint: false,
        },
      };
    });
}

async function handle(req: RpcRequest, db: D1Database): Promise<unknown> {
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, { tools: toolList() });
    case "tools/call": {
      const name = String(params.name ?? "");
      if (HIDDEN.has(name) || !(name in operations)) return rpcError(req.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await runOperation(name, params.arguments, db);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return rpcResult(req.id, { content: [{ type: "text", text }] });
      } catch (error) {
        const message = error instanceof HttpError ? error.message : `Internal error: ${String(error)}`;
        return rpcResult(req.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    case "prompts/list":
      return rpcResult(req.id, { prompts: [BRIEFING_PROMPT] });
    case "prompts/get": {
      if (params.name !== BRIEFING_PROMPT.name) return rpcError(req.id, -32602, `Unknown prompt: ${String(params.name)}`);
      const days = Number((params.arguments as Record<string, string> | undefined)?.days ?? 3) || 3;
      const text = (await runOperation("get_briefing", { days }, db)) as string;
      return rpcResult(req.id, {
        description: BRIEFING_PROMPT.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Here is my current homework state:\n\n${text}\n\nGive me a short, prioritized plan for the next ${days} days. Point out anything overdue and which lecture reviews to do.`,
            },
          },
        ],
      });
    }
    case "resources/list":
      return rpcResult(req.id, { resources: [] });
    default:
      if (req.id === undefined || req.id === null) return null; // notification
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export async function handleMcp(request: Request, db: D1Database): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") {
    // Stateless server: no server-initiated SSE stream, no sessions to delete.
    return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400, headers: CORS });
  }

  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]) as RpcRequest[];
  const responses = (await Promise.all(requests.map((r) => handle(r, db)))).filter((r) => r !== null);

  if (!responses.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(batch ? responses : responses[0], { headers: CORS });
}
