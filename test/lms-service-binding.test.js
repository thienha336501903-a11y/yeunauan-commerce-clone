import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLmsBinding, lmsFetch } from "../utils/lms-fetch.js";
import { syncV5EnrollmentToLms } from "../utils/v5-sync-helpers.js";
import worker from "../cloudflare/commerce-worker/src/index.js";

function fakeService() {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); } };
}

test("with an LMS service binding, V5 grant goes through the binding with the same URL, secret and body", async () => {
  const saved = { V5_LMS_PUBLIC_URL: process.env.V5_LMS_PUBLIC_URL, V5_SYNC_SECRET: process.env.V5_SYNC_SECRET };
  process.env.V5_LMS_PUBLIC_URL = "https://hoc.example.test";
  process.env.V5_SYNC_SECRET = "s";
  const lms = fakeService();
  setLmsBinding(lms);
  try {
    const res = await syncV5EnrollmentToLms({ customer_email: "A@gmail.com", course_slug: "khoa" }, "create");
    assert.equal(res.lms, "SUCCESS");
    assert.equal(lms.calls.length, 1);
    assert.equal(lms.calls[0].url, "https://hoc.example.test/api/v5-sync");
    assert.equal(lms.calls[0].init.headers["X-Sync-Secret"], "s");
    assert.deepEqual(JSON.parse(lms.calls[0].init.body), { action: "syncEnrollment", email: "a@gmail.com", courseSlug: "khoa", orderId: null });
  } finally {
    setLmsBinding(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("without a binding lmsFetch is plain fetch; a non-service value is ignored", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response("ok"); };
  try {
    setLmsBinding({ notFetch: true });
    await lmsFetch("https://x.test/a");
    setLmsBinding(undefined);
    await lmsFetch("https://x.test/b");
    assert.deepEqual(seen, ["https://x.test/a", "https://x.test/b"]);
  } finally { globalThis.fetch = original; }
});

test("the Worker registers env.LMS on each request", async () => {
  const lms = fakeService();
  const assets = { fetch: async () => new Response("<html></html>", { status: 200 }) };
  await worker.fetch(new Request("https://shop.example.test/index.html"), { ASSETS: assets, LMS: lms });
  await lmsFetch("https://hoc.example.test/api/v5-sync", { method: "POST" });
  assert.equal(lms.calls.length, 1);
  setLmsBinding(null);
});

test("every commerce -> lms call uses lmsFetch", () => {
  for (const f of ["utils/v5-sync-helpers.js", "utils/v4-sync-helpers.js", "utils/sync-helpers.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /await fetch\(`\$\{(lmsUrl|sys3Url)/, f);
    assert.match(src, /lmsFetch\(/, f);
  }
});

test("V4 workflow: the lms /api/sync call passes lmsFetch; Reader calls stay plain fetch", () => {
  const src = readFileSync(new URL("../utils/v4-workflow.js", import.meta.url), "utf8");
  assert.match(src, /internalPost\(`\$\{lmsUrl\}\/api\/sync`[\s\S]*?\}, lmsFetch\);/);
  for (const m of src.matchAll(/internal(?:Post|Get)\(`\$\{(\w+)\}[^`]*`[\s\S]*?\);/g)) {
    assert.equal(m[0].includes("lmsFetch"), m[1] === "lmsUrl", m[0].slice(0, 60));
  }
});
