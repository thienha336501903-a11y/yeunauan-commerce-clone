import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
const minimatch = (branch, pattern) => matchesGlob(branch, pattern); // Vercel matches branch keys with minimatch

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

// Vercel git.deploymentEnabled: a branch no key matches deploys; a branch several keys match deploys when at least
// one of them is true (docs: project-configuration/git-configuration).
function deploys(rule, branch) {
  const hits = Object.keys(rule).filter((key) => minimatch(branch, key));
  return hits.length === 0 || hits.some((key) => rule[key] === true);
}

test("vercel.json deploys main only: this public repo's other branches get no Preview", () => {
  const rule = config.git?.deploymentEnabled;
  // The boolean form (false) would stop every branch, Production on main included.
  assert.deepEqual(rule, { "**": false, "main": true });
  assert.equal(deploys(rule, "main"), true);
  for (const branch of ["feat/one-click-factory-v2", "dependabot/npm_and_yarn/qs-6.16.1", "claude/x", "main-copy", "old/main"]) {
    assert.equal(deploys(rule, branch), false, branch);
  }
  assert.equal(config.github?.enabled, undefined, "deprecated github.enabled would switch the project off entirely");
});

test("the Preview guard leaves the existing Vercel configuration in place", () => {
  assert.deepEqual(Object.keys(config), ["$schema", "regions", "buildCommand", "outputDirectory", "git", "redirects", "headers"]);
  assert.deepEqual(config.regions, ["sin1"]);
  assert.ok(config.headers.some((h) => h.source === "/(.*)"));
});
