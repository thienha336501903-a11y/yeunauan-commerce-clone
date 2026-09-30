import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

const runtimeFiles = [
  "utils/sync-helpers.js",
  "utils/clone-config.js",
  "api/register.js",
  "api/config.js",
  "index.html",
  ".env.example"
];

test("M0E Commerce runtime contains no retired Legacy portal endpoint references", () => {
  const forbidden = [
    /\bSYSTEM1_URL\b/,
    /\bPORTAL_URL\b/,
    /\bLEGACY_PORTAL_PUBLIC_URL\b/,
    /legacyPortalPublicUrl/,
    /https:\/\/yeunauan\.live/i
  ];
  for (const file of runtimeFiles) {
    const source = read(file);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not reference retired Legacy portal config ${pattern}`);
    }
  }
});

test("M0E Commerce sync helper is Main-LMS-only and marks portal retirement explicitly", () => {
  const source = read("utils/sync-helpers.js");
  assert.match(source, /const sys3Url = process\.env\.SYSTEM3_URL \|\| process\.env\.LMS_PUBLIC_URL/);
  assert.match(source, /portal:\s*"RETIRED_M0E"/);
  assert.doesNotMatch(source, /sys1Url/);
  assert.doesNotMatch(source, /Portal failed:/);
  assert.doesNotMatch(source, /Portal error:/);
});

test("M0E Commerce registration returns learners to Main LMS", () => {
  const register = read("api/register.js");
  const index = read("index.html");
  assert.match(register, /managerPath = runtime\.lmsPublicUrl/);
  assert.doesNotMatch(register, /legacy student Portal/);
  assert.match(index, /redirecting to Main LMS course manager/);
  assert.doesNotMatch(index, /legacyPortalPublicUrl/);
});
