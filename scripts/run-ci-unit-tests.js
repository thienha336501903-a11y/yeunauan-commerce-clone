#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(here, "../test");

// These suites are intentionally outside ordinary PR CI:
// - isolated-target / real-DB suites require the consolidated pre-M0C runner;
// - M0D/M0E suites are deferred and require the sibling LMS workspace;
// - the older B6/B7 harnesses depend on integration authority seams superseded
//   in PR CI by hermetic security tests, while the consolidated gate keeps the
//   full request-bound coverage.
const EXCLUDED = new Set([
  "b6-commerce-routing.test.js",
  "m0e-inventory-consistency.test.js",
  "multi-agency-b5-real-db.test.js",
  "multi-agency-b7.test.js",
  "pre-m0c-test-target-security.test.js",
  "second-tenant-isolation.test.js",
  "synthetic-agency-provisioning.test.js"
]);

const all = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

const missing = [...EXCLUDED].filter((name) => !all.includes(name));
if (missing.length) {
  console.error(`CI test manifest drift: expected excluded suites missing: ${missing.join(", ")}`);
  process.exit(1);
}

const selected = all.filter((name) => !EXCLUDED.has(name));
if (!selected.length) {
  console.error("CI test manifest selected no tests.");
  process.exit(1);
}

console.log(`PR CI: running ${selected.length} hermetic test files.`);
console.log(`PR CI: ${EXCLUDED.size} isolated/deferred suites remain outside this runner.`);

const result = spawnSync(process.execPath, ["--test", ...selected.map((name) => path.join("test", name))], {
  cwd: path.resolve(here, ".."),
  stdio: "inherit",
  env: process.env
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
