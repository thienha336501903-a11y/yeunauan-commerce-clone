#!/usr/bin/env node
// scripts/check-m0d-readiness.js
// Executable tool for Milestone M0D Pre-Cutover Readiness Verification & Legacy Dependency Audit
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Read-only execution. Does not mutate database or disable legacy endpoints.
//   - Outputs machine-readable JSON & human-readable markdown table.
//   - Returns M0D_READINESS_TOOLING = PASS and M0D_EXECUTION = NOT_STARTED.

import { checkM0dCutoverReadiness } from "../utils/m0d-dependency-checker.js";

function printMarkdownReport(result) {
  console.log("# SYSTEM B — M0D LEGACY DEPENDENCY MATRIX & READINESS AUDIT");
  console.log(`Audited at: ${new Date().toISOString()}`);
  console.log("");
  console.log("## 1. LEGACY DEPENDENCY MATRIX");
  console.log("| Path Name | Description | Legacy Required | Legacy Reference Found | Blocking Reference |");
  console.log("|---|---|---|---|---|");

  for (const row of result.matrix) {
    const blocking = row.BLOCKING_REFERENCE ? JSON.stringify(row.BLOCKING_REFERENCE) : "NONE";
    console.log(`| **${row.pathName}** | ${row.description} | \`${row.LEGACY_REQUIRED}\` | \`${row.LEGACY_REFERENCE_FOUND}\` | \`${blocking}\` |`);
  }

  console.log("");
  console.log("## 2. PRE-CUTOVER OPERATIONAL GATES");
  for (const [gate, status] of Object.entries(result.gates)) {
    console.log(`- **${gate}**: \`${status ? "PASS" : "FAIL"}\``);
  }

  console.log("");
  console.log("## 3. AUDIT RESULT");
  console.log(`M0D_READINESS_TOOLING = ${result.M0D_READINESS_TOOLING}`);
  console.log(`M0D_EXECUTION = ${result.M0D_EXECUTION}`);
}

function main() {
  const result = checkM0dCutoverReadiness();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printMarkdownReport(result);
  }

  if (result.M0D_READINESS_TOOLING !== "PASS") {
    process.exit(1);
  }
}

main();
