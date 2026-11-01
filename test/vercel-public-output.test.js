// Vercel serves only public/ (vercel.json outputDirectory), built by scripts/build-vercel-public.mjs. Pins that the
// build copies the frontend and nothing else, even when the uploaded tree holds secrets or untracked files (CLI deploy).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPublic } from "../scripts/build-vercel-public.mjs";

const root = path.resolve(import.meta.dirname, "..");
const list = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/")).sort();

test("vercel.json builds public/ and serves only that directory", () => {
  const cfg = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(cfg.buildCommand, "node scripts/build-vercel-public.mjs");
  assert.equal(cfg.outputDirectory, "public");
  assert.match(readFileSync(path.join(root, ".gitignore"), "utf8"), /^\/public\/\r?$/m);
  // the course-gate redirect keeps pointing at a published page
  assert.ok(cfg.redirects.some((r) => r.destination.startsWith("/course-gate.html")));
});

test("a tree with secrets, source and untracked files publishes only the frontend", () => {
  const src = mkdtempSync(path.join(os.tmpdir(), "cpub-src-"));
  for (const d of ["utils", "server", "api", "scripts", "supabase/.temp", "test", "templates"]) mkdirSync(path.join(src, d), { recursive: true });
  for (const f of ["index.html", "orders.html", "favicon.ico", ".env.production", ".env.tmp", "x.diff", "package.json",
    "vercel.json", "README.md", "utils/supabase.js", "server/supabase-service-role.js", "api/orders.js", "scripts/a.py",
    "supabase/.temp/project-ref", "test/a.test.js", "templates/m.json", "notes.md"]) writeFileSync(path.join(src, f), "x");
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "cpub-out-")), "public");
  buildPublic(src, out);
  assert.deepEqual(list(out), ["favicon.ico", "index.html", "orders.html"]);
});

test("the real tree publishes every page, and every same-origin asset a page loads", () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "cpub-real-")), "public");
  const files = buildPublic(root, out);
  assert.deepEqual(list(out), files);
  for (const f of ["index.html", "orders.html", "admin.html", "course-gate.html", "agency-storefront.html", "test-bill-cleanup.html"]) assert.ok(files.includes(f), f);
  for (const f of files) assert.match(f, /^([A-Za-z0-9._-]+\.html|favicon\.ico|robots\.txt)$/, f);
  for (const page of files.filter((f) => f.endsWith(".html"))) {
    const body = readFileSync(path.join(out, page), "utf8");
    for (const [, ref] of body.matchAll(/(?:src|href)=["'](\/?[A-Za-z0-9._/-]+\.(?:js|css|html|json|png|svg|ico|webp|jpg))["']/g)) {
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith("/api/")) continue;
      assert.ok(files.includes(ref.replace(/^\//, "")), `${page} loads ${ref}`);
    }
  }
});
