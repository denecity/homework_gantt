// Seeds demo data through the MCP endpoint (so it doubles as an end-to-end test).
// Usage: node scripts/seed-demo.mjs [http://localhost:8787]
const base = process.argv[2] ?? "http://localhost:8787";
let id = 0;

async function call(name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  if (body.error || body.result?.isError) throw new Error(`${name}: ${text}`);
  console.log(`✓ ${name} ${args.id ?? ""}`);
  return text;
}

await call("set_semester", { name: "HS 2026 (demo)", starts_on: "2026-09-14", ends_on: "2027-02-14", lectures_end_on: "2026-12-18" });

for (const m of [
  { id: "sem-start", kind: "semester", label: "Semester start", at: "2026-09-14T00:00" },
  { id: "lectures-end", kind: "semester", label: "Last lecture day", at: "2026-12-18T18:00" },
  { id: "xmas", kind: "break", label: "Christmas break", at: "2026-12-19T00:00", end_at: "2027-01-04T00:00" },
  { id: "session-start", kind: "semester", label: "Exam session start", at: "2027-01-18T00:00" },
  { id: "session-end", kind: "semester", label: "Exam session end", at: "2027-02-12T18:00" },
]) await call("create_marker", m);

const courses = [
  { id: "qft", name: "Quantum Field Theory I", short: "QFT", color: "#7C9CFF", link: "https://moodle-app2.let.ethz.ch/" },
  { id: "gr", name: "General Relativity", short: "GR", color: "#FF7AB6", link: "https://moodle-app2.let.ethz.ch/" },
  { id: "ssp", name: "Solid State Physics", short: "SSP", color: "#5FD4B0", link: "https://moodle-app2.let.ethz.ch/" },
  { id: "stat", name: "Statistical Physics", short: "Stat", color: "#FFB35C", link: "https://moodle-app2.let.ethz.ch/" },
  { id: "ml", name: "Machine Learning", short: "ML", color: "#B98CFF", link: "https://moodle-app2.let.ethz.ch/" },
];
for (const [i, c] of courses.entries()) await call("create_course", { ...c, sort_order: i });

const slots = [
  ["qft-mon", "qft", 1, "10:15", "12:00"], ["qft-thu", "qft", 4, "08:15", "10:00"],
  ["gr-tue", "gr", 2, "13:15", "15:00"],
  ["ssp-wed", "ssp", 3, "10:15", "12:00"],
  ["stat-tue", "stat", 2, "08:15", "10:00"], ["stat-fri", "stat", 5, "10:15", "12:00"],
  ["ml-thu", "ml", 4, "14:15", "16:00"],
];
for (const [sid, course_id, weekday, start_time, end_time] of slots)
  await call("create_lecture_slot", { id: sid, course_id, weekday, start_time, end_time });

await call("create_series", { id: "qft-sheets", course_id: "qft", first_release: "2026-09-14T12:00", first_due: "2026-09-21T12:00", skip_dates: ["2026-10-19"] });
await call("create_series", { id: "gr-sheets", course_id: "gr", title_template: "Problem set {n}", first_release: "2026-09-15T15:00", first_due: "2026-09-22T13:00" });
await call("create_series", { id: "ssp-sheets", course_id: "ssp", first_release: "2026-09-16T12:00", first_due: "2026-09-23T10:00" });
await call("create_series", { id: "stat-sheets", course_id: "stat", title_template: "Exercise {n}", first_release: "2026-09-11T18:00", first_due: "2026-09-18T18:00" });
await call("create_series", { id: "ml-proj", course_id: "ml", title_template: "Task {n}", first_release: "2026-09-17T16:00", first_due: "2026-10-01T23:59", every_days: 14 });

await call("create_assignment", { id: "ssp-quiz", course_id: "ssp", title: "Online quiz", release_at: "2026-09-10T09:00", due_at: "2026-09-16T23:59" });
await call("set_done", { id: "qft-sheets-0", done: true });
await call("set_done", { id: "qft-mon@2026-09-14", done: true });
await call("create_marker", { id: "exam-qft", kind: "exam", label: "QFT exam", at: "2027-01-25T09:00", course_id: "qft" });
await call("create_marker", { id: "exam-ml", kind: "exam", label: "ML midterm", at: "2026-11-05T14:15", course_id: "ml" });

console.log("\n" + (await call("get_briefing", { days: 3 })));
