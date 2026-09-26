#!/usr/bin/env node
// scripts/provision-agency.js
// CLI tool for System B Multi-Agency Provisioning Lifecycle (Plan / Apply / Validate / Deprovision)
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V2 Hardening
// Invariants:
//   - Zero Secrets: Never prints or logs credentials or service keys.
//   - Idempotent: Safe to execute repeatedly in Plan or Apply mode.
//   - Fails closed on schema violation or domain collisions.
//   - Protected Agencies ("yeunauan", "agency-a") can NEVER be deprovisioned.

import fs from "node:fs";
import path from "node:path";
import {
  planAgencyProvisioning,
  applyAgencyProvisioning,
  verifyAgencyReadiness,
  deprovisionAgency,
  validateManifest
} from "../utils/agency-provisioner.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: "plan",
    manifestPath: null,
    slug: null,
    confirm: false,
    synthetic: false,
    rehearsalRunId: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" && args[i + 1]) {
      options.mode = args[++i];
    } else if (arg === "--manifest" && args[i + 1]) {
      options.manifestPath = args[++i];
    } else if (arg === "--slug" && args[i + 1]) {
      options.slug = args[++i];
    } else if (arg === "--confirm") {
      options.confirm = true;
    } else if (arg === "--synthetic") {
      options.synthetic = true;
    } else if (arg === "--rehearsal-run-id" && args[i + 1]) {
      options.rehearsalRunId = args[++i];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log(`[PROVISION-AGENCY] Mode: ${options.mode}`);

  let manifest = null;
  if (options.manifestPath) {
    const resolvedPath = path.resolve(process.cwd(), options.manifestPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`[ERROR] Manifest file not found: ${resolvedPath}`);
      process.exit(1);
    }
    const rawContent = fs.readFileSync(resolvedPath, "utf8");
    try {
      manifest = JSON.parse(rawContent);
    } catch (e) {
      console.error(`[ERROR] Failed to parse manifest JSON: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    switch (options.mode) {
      case "plan": {
        if (!manifest) {
          console.error("[ERROR] --manifest <file.json> is required for plan mode.");
          process.exit(1);
        }
        console.log(`[PROVISION-AGENCY] Planning provisioning for slug: ${manifest.agency?.slug}...`);
        const result = await planAgencyProvisioning(manifest);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "apply": {
        if (!manifest) {
          console.error("[ERROR] --manifest <file.json> is required for apply mode.");
          process.exit(1);
        }
        console.log(`[PROVISION-AGENCY] Applying provisioning for slug: ${manifest.agency?.slug}...`);
        const result = await applyAgencyProvisioning(manifest, {
          isSynthetic: options.synthetic,
          rehearsalRunId: options.rehearsalRunId
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "validate": {
        const targetSlug = options.slug || manifest?.agency?.slug;
        if (!targetSlug) {
          console.error("[ERROR] Either --slug <slug> or --manifest with agency.slug is required for validate mode.");
          process.exit(1);
        }
        console.log(`[PROVISION-AGENCY] Validating readiness for slug: ${targetSlug}...`);
        const result = await verifyAgencyReadiness(targetSlug);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) {
          process.exit(2);
        }
        break;
      }

      case "deprovision": {
        const targetSlug = options.slug || manifest?.agency?.slug;
        if (!targetSlug) {
          console.error("[ERROR] Either --slug <slug> or --manifest with agency.slug is required for deprovision mode.");
          process.exit(1);
        }
        if (!options.confirm) {
          console.error("[ERROR] --confirm flag is required to execute deprovisioning.");
          process.exit(1);
        }
        if (!options.rehearsalRunId) {
          console.error("[ERROR] --rehearsal-run-id <run_id> is required for safe deprovisioning.");
          process.exit(1);
        }
        console.log(`[PROVISION-AGENCY] Deprovisioning synthetic test fixture slug: ${targetSlug}...`);
        const result = await deprovisionAgency(targetSlug, {
          confirm: options.confirm,
          isTestTarget: true,
          rehearsalRunId: options.rehearsalRunId
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.error(`[ERROR] Unknown mode: '${options.mode}'. Valid modes: plan, apply, validate, deprovision.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`[FATAL] Provisioning command failed: ${err.message}`);
    process.exit(1);
  }
}

main();
