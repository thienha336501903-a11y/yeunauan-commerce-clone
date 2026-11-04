// Local smoke (H1): run the commerce Worker in real workerd (wrangler dev --local) against a fake Supabase
// PostgREST + fake Cloudinary on 127.0.0.1. All values are dummies; nothing leaves the machine.
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const WORKER = process.argv[2] || path.resolve(import.meta.dirname, "..");
const FAKE = 54701, DEV = 8799;
const log = [];
const COURSE = { id: "11111111-1111-4111-8111-111111111111", slug: "smoke-course", title: "Smoke", image_url: "", active: true, is_published: false, raw_data: {}, delivery_mode: "v5", telegram_chat_id: null, telegram_invite_ttl_hours: null };

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const u = new URL(req.url, "http://x");
    log.push(`${req.method} ${u.pathname}${u.search.slice(0, 80)} ${body.length}B`);
    const send = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const one = String(req.headers.accept || "").includes("vnd.pgrst.object");
    if (u.pathname === "/rest/v1/rpc/resolve_agency_domain") return send(200, null);
    if (u.pathname === "/rest/v1/courses") return one ? send(200, COURSE) : send(200, [COURSE]);
    if (u.pathname === "/rest/v1/orders" && req.method === "POST") return send(201, []);
    if (u.pathname.includes("/image/upload")) {
      const fields = Object.fromEntries([...body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)].map((m) => [m[1], m[1] === "file" ? `<${m[2].length} chars>` : m[2]]));
      log.push("UPLOAD fields " + JSON.stringify(fields));
      const ok = fields.api_key === "dummykey" && /^[0-9a-f]{40}$/.test(fields.signature || "") && fields.folder === "bill-chuyen-khoan/smoke-course" && fields.file?.startsWith("<");
      return send(ok ? 200 : 400, ok ? { secure_url: "https://res.example/bill.png", public_id: "bill-chuyen-khoan/smoke-course/x" } : { error: { message: "bad upload request" } });
    }
    send(404, { message: "fake: not handled" });
  });
}).listen(FAKE, "127.0.0.1");

writeFileSync(path.join(WORKER, ".dev.vars"), [
  `SUPABASE_URL=http://127.0.0.1:${FAKE}`,
  "SUPABASE_SERVICE_ROLE_KEY=dummy-service-key",
  "LEGACY_HOST_ALLOWLIST=127.0.0.1",
  "ADMIN_PASSWORD=dummy-admin",
  "CLOUDINARY_CLOUD_NAME=dummycloud",
  "CLOUDINARY_API_KEY=dummykey",
  "CLOUDINARY_API_SECRET=dummysecret",
  `CLOUDINARY_URL=cloudinary://dummykey:dummysecret@dummycloud?upload_prefix=http://127.0.0.1:${FAKE}`
].join("\n"));

const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(DEV), "--ip", "127.0.0.1", "--config", "wrangler.toml"], { cwd: WORKER, shell: true });
let out = "";
dev.stdout.on("data", (d) => (out += d)); dev.stderr.on("data", (d) => (out += d));

const base = `http://127.0.0.1:${DEV}`;
const H = { host: "yeubep.shop" };
async function ready() {
  for (let i = 0; i < 90; i++) { try { await fetch(base + "/index.html", { headers: H }); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  throw new Error("wrangler dev did not start:\n" + out.slice(-2000));
}
const results = [];
const check = (name, ok, info = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`);

try {
  await ready();
  // Host header is what wrangler dev forwards as the request URL host only via --host; we send it and read it back.
  let r = await fetch(base + "/", { headers: H, redirect: "manual" });
  check("/ serves index.html", r.status === 200 && (await r.text()).includes("<html"), r.status);
  check("security header HSTS on static", r.headers.get("strict-transport-security") === "max-age=31536000");
  r = await fetch(base + "/?course=abc&x=1", { headers: H, redirect: "manual" });
  check("/?course redirect 307", r.status === 307 && r.headers.get("location") === "/course-gate.html?course=abc&x=1", `${r.status} ${r.headers.get("location")}`);
  r = await fetch(base + "/admin", { headers: H, redirect: "manual" });
  check("/admin is 404 (no clean URLs, like Vercel)", r.status === 404, r.status);
  r = await fetch(base + "/admin.html", { headers: H, redirect: "manual" });
  check("/admin.html 200, no redirect", r.status === 200, r.status);
  r = await fetch(base + "/package.json", { headers: H });
  check("/package.json not served", r.status === 404, r.status);
  r = await fetch(base + "/api/nope", { headers: H });
  check("/api/nope 404", r.status === 404, r.status);
  r = await fetch(base + "/api/health", { headers: H });
  const health = await r.text();
  check("/api/health runs in workerd", r.status === 200, `${r.status} ${health.slice(0, 160)}`);
  r = await fetch(base + "/api/orders", { headers: H });
  check("/api/orders without password 401", r.status === 401, r.status);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  r = await fetch(base + "/api/register", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ gmail: "smoke@gmail.com", course: "smoke-course", billName: "b.png", billType: "image/png", billData: png }) });
  const reg = await r.text();
  check("/api/register end-to-end (supabase-js + cloudinary SDK in workerd)", r.status === 200 && reg.includes('"success":true'), `${r.status} ${reg.slice(0, 200)}`);
  r = await fetch(base + "/api/register", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "x".repeat(4.5 * 1024 * 1024 + 10) });
  check("body > 4.5 MB → 413", r.status === 413, r.status);
} catch (e) {
  results.push("FAIL " + e.message);
} finally {
  try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'commerce-worker' -and $_.CommandLine -match 'wrangler|workerd' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`); } catch {}
  fake.close();
  rmSync(path.join(WORKER, ".dev.vars"), { force: true });
  console.log(results.join("\n"));
  console.log("fake requests:\n  " + log.join("\n  "));
  if (results.some((l) => l.startsWith("FAIL"))) console.log("--- wrangler tail ---\n" + out.slice(-3000));
  setTimeout(() => process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0), 1500);
}
