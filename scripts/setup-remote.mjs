// One-time Cloudflare setup: creates the D1 database (if needed), writes its id into wrangler.jsonc,
// applies migrations remotely and deploys. Requires `npx wrangler login` first.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const run = (cmd, opts = {}) => execSync(cmd, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8" });

let config = readFileSync("wrangler.jsonc", "utf8");

if (config.includes(PLACEHOLDER)) {
  let id;
  try {
    const list = JSON.parse(run("npx wrangler d1 list --json", { capture: true }));
    id = list.find((db) => db.name === "homework-gantt")?.uuid;
  } catch {
    /* fall through to create */
  }
  if (!id) {
    const out = run("npx wrangler d1 create homework-gantt", { capture: true });
    id = /"database_id":\s*"([0-9a-f-]{36})"/.exec(out)?.[1] ?? /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(out)?.[1];
    if (!id) throw new Error(`Could not read database id from:\n${out}`);
  }
  config = config.replace(PLACEHOLDER, id);
  writeFileSync("wrangler.jsonc", config);
  console.log(`✓ D1 database homework-gantt → ${id} (saved to wrangler.jsonc)`);
}

run("npx wrangler d1 migrations apply homework-gantt --remote");
run("npx wrangler deploy");
console.log("\n✓ Deployed. Connect Claude to <your worker url>/mcp");
