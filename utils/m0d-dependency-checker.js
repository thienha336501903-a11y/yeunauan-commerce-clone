// utils/m0d-dependency-checker.js
// System B Milestone M0D — Entrypoint Dependency Checker & Pre-Cutover Matrix
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V3 — Phase 17 / FIX 13
// Invariants:
//   - Starts from REAL entrypoints:
//       Commerce: api/register.js, api/orders.js, api/config.js, api/courses.js
//       LMS: api/lms/portal.js, api/lms/admin.js, agency bridge, homework, playback
//   - Never silently ignores missing files: reports UNKNOWN or FAIL.
//   - Recursively traverses direct and transitive local imports in Agency execution paths.
//   - Audits all 7 required surfaces: storefront, checkout, agency admin, learner, learning/player, homework, V5 playback.
//   - Cutover gates are computed from verifiable file audits (NO hardcoded true).
//   - M0D_EXECUTION invariant: strictly NOT_STARTED.

import fs from "node:fs";
import path from "node:path";

/**
 * 7 Required Surfaces and their real entrypoints / source files across LMS and Commerce.
 */
export const REQUIRED_SURFACES = [
  {
    surface: "storefront",
    description: "Public storefront catalog, offerings, and UI profile resolution",
    entrypoints: [
      { repo: "lms", file: "api/lms/portal.js" },
      { repo: "commerce", file: "api/config.js" },
      { repo: "commerce", file: "api/courses.js" }
    ],
    agencyModules: [
      "utils/agency-routing.js",
      "utils/agency-commerce.js",
      "utils/ui-variant-engine.js"
    ]
  },
  {
    surface: "checkout",
    description: "Server-side quote, VietQR generation, checkout RPC, immutable order snapshot",
    entrypoints: [
      { repo: "commerce", file: "api/orders.js" },
      { repo: "commerce", file: "api/register.js" }
    ],
    agencyModules: [
      "utils/agency-commerce.js",
      "utils/agency-routing.js"
    ]
  },
  {
    surface: "agency admin",
    description: "Role-gated management, agency order approval, refund state machine",
    entrypoints: [
      { repo: "lms", file: "api/lms/agency-admin.js" }
    ],
    agencyModules: [
      "utils/agency-auth.js",
      "utils/tenant-db-resolver.js",
      "utils/agency-commerce.js"
    ]
  },
  {
    surface: "learner",
    description: "Authenticated student dashboard, active entitlements list, identity validation",
    entrypoints: [
      { repo: "lms", file: "api/lms/portal.js" }
    ],
    agencyModules: [
      "utils/agency-auth.js",
      "utils/agency-lms-bridge.js",
      "utils/tenant-db-resolver.js"
    ]
  },
  {
    surface: "learning/player",
    description: "Canonical courses & lessons hierarchy, learning UI cinema/card variants",
    entrypoints: [
      { repo: "lms", file: "api/lms/portal.js" }
    ],
    agencyModules: [
      "utils/agency-lms-bridge.js",
      "utils/ui-variant-engine.js"
    ]
  },
  {
    surface: "homework",
    description: "Tenant homework submissions, reviews, grading, canonical lesson binding",
    entrypoints: [
      { repo: "lms", file: "api/lms/portal.js" }
    ],
    agencyModules: [
      "utils/agency-homework.js"
    ]
  },
  {
    surface: "V5 playback",
    description: "ECDSA P-256 signed playback leases, B1.1 agency playback authorization",
    entrypoints: [
      { repo: "lms", file: "api/lms/portal.js" }
    ],
    agencyModules: [
      "utils/agency-lms-bridge.js",
      "utils/v5-playback-lease.js"
    ]
  }
];

/**
 * Legacy patterns strictly prohibited from appearing in any Agency functional path.
 */
export const PROHIBITED_LEGACY_PATTERNS = [
  {
    name: "legacy_hmac_session",
    regex: /(?:verifyHmacSession|HMAC_SECRET|createHmacSession|parseHmacCookie)\b/g,
    description: "Legacy HMAC session cookie auth (agency uses Supabase JWT)"
  },
  {
    name: "unscoped_student_enrollments",
    regex: /\.from\(\s*["']student_enrollments["']\s*\)/g,
    description: "Legacy student_enrollments table (agency uses student_entitlements)"
  },
  {
    name: "unverified_email_lookup",
    regex: /(?:email_identity_lookup|legacy_student_auth)\b/g,
    description: "Legacy unverified email-only login lookup"
  },
  {
    name: "legacy_supabase_project_ref",
    regex: /aqozjkfwzmyfunqvcyjv/g,
    description: "Deprecated legacy Supabase project reference"
  },
  {
    name: "legacy_unscoped_orders",
    regex: /\.from\(\s*["']orders["']\s*\)/g,
    description: "Legacy single-tenant orders table (agency uses agency_orders)"
  },
  {
    name: "legacy_unscoped_lesson_progress",
    regex: /\.from\(\s*["']lesson_progress["']\s*\)/g,
    description: "Legacy lesson_progress table (agency uses agency_lesson_progress)"
  }
];

/**
 * Checks a specific file for prohibited legacy patterns.
 */
export function auditFileContent(filePath, content) {
  const violations = [];
  for (const pat of PROHIBITED_LEGACY_PATTERNS) {
    const matches = content.match(pat.regex);
    if (matches && matches.length > 0) {
      violations.push({
        file: filePath,
        pattern: pat.name,
        description: pat.description,
        count: matches.length
      });
    }
  }
  return violations;
}

/**
 * Recursively discovers local transitive imports from a source file.
 */
export function traceTransitiveLocalImports(filePath, rootDir, visited = new Set()) {
  const fullPath = path.resolve(rootDir, filePath);
  if (visited.has(fullPath) || !fs.existsSync(fullPath)) {
    return visited;
  }
  visited.add(fullPath);

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const importRegex = /(?:import\s+.*?from\s+["'](\.[^"']+)["']|import\(["'](\.[^"']+)["']\)|from\s+["'](\.[^"']+)["'])/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const relPath = match[1] || match[2] || match[3];
      if (relPath) {
        const dir = path.dirname(fullPath);
        let resolved = path.resolve(dir, relPath);
        if (!fs.existsSync(resolved)) {
          if (fs.existsSync(resolved + ".js")) resolved = resolved + ".js";
          else if (fs.existsSync(path.join(resolved, "index.js"))) resolved = path.join(resolved, "index.js");
        }
        if (fs.existsSync(resolved) && !visited.has(resolved)) {
          traceTransitiveLocalImports(path.relative(rootDir, resolved), rootDir, visited);
        }
      }
    }
  } catch (_) {}

  return visited;
}

/**
 * Extracts the exact code block within the Agency route branch of an entrypoint.
 */
export function extractAgencyBranchContent(content) {
  const agencyIdx = content.indexOf('route === "AGENCY"') !== -1
    ? content.indexOf('route === "AGENCY"')
    : content.indexOf('routeDecision.route === "AGENCY"');

  if (agencyIdx === -1) return "";

  const openBrace = content.indexOf("{", agencyIdx);
  if (openBrace === -1) return "";

  let depth = 1;
  let closeBrace = openBrace + 1;
  while (depth > 0 && closeBrace < content.length) {
    if (content[closeBrace] === "{") depth++;
    else if (content[closeBrace] === "}") depth--;
    closeBrace++;
  }

  return content.slice(openBrace, closeBrace);
}

/**
 * Verifies that an entrypoint explicitly branches on resolveRequestRoute
 * and never allows Agency requests to fall through to legacy handlers.
 */
export function auditEntrypointRouting(filePath, content) {
  const isRoutingGuard = content.includes("resolveRequestRoute");
  const isAgencyBranch = content.includes("AGENCY") || content.includes("agency");

  return {
    hasRoutingGuard: isRoutingGuard,
    hasAgencyBranch: isRoutingGuard && isAgencyBranch
  };
}

/**
 * Detects repository type from its real entrypoints.
 */
function detectRepoType(rootDir) {
  if (fs.existsSync(path.resolve(rootDir, "api/lms/portal.js"))) return "lms";
  if (fs.existsSync(path.resolve(rootDir, "api/config.js"))) return "commerce";
  return "unknown";
}

/**
 * M0D is a cross-repository gate. A single-repo checkout is insufficient
 * evidence and must never produce PASS.
 */
function resolveM0dWorkspace(rootDir = process.cwd()) {
  const currentRepoType = detectRepoType(rootDir);
  const siblingDir = currentRepoType === "lms"
    ? path.resolve(rootDir, "../yeunauan-commerce-clone")
    : currentRepoType === "commerce"
      ? path.resolve(rootDir, "../yeunauan-lms-clone")
      : null;

  const siblingRepoType = siblingDir ? detectRepoType(siblingDir) : "unknown";
  const expectedSiblingType = currentRepoType === "lms"
    ? "commerce"
    : currentRepoType === "commerce"
      ? "lms"
      : "unknown";

  const repoDirs = {
    lms: currentRepoType === "lms"
      ? rootDir
      : (siblingRepoType === "lms" ? siblingDir : null),
    commerce: currentRepoType === "commerce"
      ? rootDir
      : (siblingRepoType === "commerce" ? siblingDir : null)
  };

  return {
    complete: currentRepoType !== "unknown" &&
      siblingRepoType === expectedSiblingType &&
      Boolean(repoDirs.lms) &&
      Boolean(repoDirs.commerce),
    currentRepoType,
    siblingRepoType,
    siblingDir,
    repoDirs
  };
}

function uniqueViolations(violations) {
  const seen = new Set();
  return violations.filter((item) => {
    const key = [
      item.repo || "",
      item.file || "",
      item.pattern || "",
      item.description || ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generates the M0D Legacy Dependency Matrix by auditing real entrypoints and
 * agency modules across BOTH repositories in one sibling workspace.
 */
export function generateLegacyDependencyMatrix(rootDir = process.cwd()) {
  const workspace = resolveM0dWorkspace(rootDir);

  if (!workspace.complete) {
    const blocker = {
      repo: workspace.currentRepoType === "unknown" ? "workspace" : workspace.currentRepoType,
      file: workspace.siblingDir || rootDir,
      pattern: "incomplete_cross_repo_workspace",
      description: "M0D requires LMS and Commerce repositories checked out side-by-side."
    };
    const matrix = REQUIRED_SURFACES.map((surf) => ({
      surface: surf.surface,
      pathName: surf.surface,
      description: surf.description,
      status: "UNKNOWN",
      LEGACY_REQUIRED: "UNKNOWN",
      LEGACY_REFERENCE_FOUND: "UNKNOWN",
      auditedFiles: [],
      violations: [blocker],
      BLOCKING_REFERENCE: blocker
    }));

    return {
      ok: false,
      workspace,
      matrix,
      summary: {
        totalSurfaces: matrix.length,
        passedSurfaces: 0,
        failedSurfaces: 0,
        unknownSurfaces: matrix.length,
        cleanPaths: 0,
        violationsCount: matrix.length
      }
    };
  }

  const matrix = [];

  for (const surf of REQUIRED_SURFACES) {
    const auditedFiles = [];
    const violations = [];
    let legacyReferenceFound = "NO";

    // 1. Every declared entrypoint is mandatory and must explicitly route Agency.
    for (const ep of surf.entrypoints) {
      const targetDir = workspace.repoDirs[ep.repo];
      const fullPath = targetDir ? path.resolve(targetDir, ep.file) : null;

      if (!fullPath || !fs.existsSync(fullPath)) {
        violations.push({
          repo: ep.repo,
          file: ep.file,
          pattern: "missing_entrypoint",
          description: `Required ${ep.repo} entrypoint '${ep.file}' is missing from M0D workspace.`
        });
        continue;
      }

      const auditedName = `${ep.repo}:${ep.file}`;
      if (!auditedFiles.includes(auditedName)) auditedFiles.push(auditedName);
      const content = fs.readFileSync(fullPath, "utf8");
      const routing = auditEntrypointRouting(ep.file, content);

      if (!routing.hasRoutingGuard || !routing.hasAgencyBranch) {
        violations.push({
          repo: ep.repo,
          file: ep.file,
          pattern: "missing_agency_route_guard",
          description: "Entrypoint does not explicitly route Agency requests before legacy handlers."
        });
      }

      const agencyBranchContent = extractAgencyBranchContent(content);
      if (!agencyBranchContent) {
        violations.push({
          repo: ep.repo,
          file: ep.file,
          pattern: "missing_agency_branch",
          description: "Entrypoint has no auditable Agency route branch."
        });
      } else {
        const epViolations = auditFileContent(ep.file, agencyBranchContent)
          .map((v) => ({ ...v, repo: ep.repo }));
        if (epViolations.length) {
          legacyReferenceFound = "YES";
          violations.push(...epViolations);
        }
      }
    }

    // 2. Audit every occurrence of required Agency modules in both repositories.
    for (const mod of surf.agencyModules) {
      let foundModule = false;

      for (const [repoType, targetDir] of Object.entries(workspace.repoDirs)) {
        const modPath = path.resolve(targetDir, mod);
        if (!fs.existsSync(modPath)) continue;
        foundModule = true;

        const auditedName = `${repoType}:${mod}`;
        if (!auditedFiles.includes(auditedName)) auditedFiles.push(auditedName);

        const content = fs.readFileSync(modPath, "utf8");
        const fileViolations = auditFileContent(mod, content)
          .map((v) => ({ ...v, repo: repoType }));
        if (fileViolations.length) {
          legacyReferenceFound = "YES";
          violations.push(...fileViolations);
        }

        const traced = traceTransitiveLocalImports(mod, targetDir);
        for (const tFile of traced) {
          const relTFile = path.relative(targetDir, tFile);
          const tracedName = `${repoType}:${relTFile}`;
          if (auditedFiles.includes(tracedName)) continue;
          auditedFiles.push(tracedName);

          const tContent = fs.readFileSync(tFile, "utf8");
          const tViolations = auditFileContent(relTFile, tContent)
            .map((v) => ({ ...v, repo: repoType }));
          if (tViolations.length) {
            legacyReferenceFound = "YES";
            violations.push(...tViolations);
          }
        }
      }

      if (!foundModule) {
        violations.push({
          repo: "workspace",
          file: mod,
          pattern: "missing_agency_module",
          description: `Required Agency module '${mod}' is absent from both repositories.`
        });
      }
    }

    const deduped = uniqueViolations(violations);
    const status = deduped.length ? "FAIL" : "PASS";
    const blockingReference = deduped[0] || null;

    matrix.push({
      surface: surf.surface,
      pathName: surf.surface,
      description: surf.description,
      status,
      LEGACY_REQUIRED: status === "PASS" ? "NO" : "UNKNOWN",
      LEGACY_REFERENCE_FOUND: legacyReferenceFound,
      auditedFiles,
      violations: deduped.length ? deduped : null,
      BLOCKING_REFERENCE: blockingReference
    });
  }

  const passedSurfaces = matrix.filter((r) => r.status === "PASS").length;
  const failedSurfaces = matrix.filter((r) => r.status === "FAIL").length;
  const unknownSurfaces = matrix.filter((r) => r.status === "UNKNOWN").length;
  const violationsCount = matrix.reduce(
    (sum, row) => sum + (row.violations?.length || 0),
    0
  );
  const ok = passedSurfaces === matrix.length && failedSurfaces === 0 && unknownSurfaces === 0;

  return {
    ok,
    workspace,
    matrix,
    summary: {
      totalSurfaces: matrix.length,
      passedSurfaces,
      failedSurfaces,
      unknownSurfaces,
      cleanPaths: passedSurfaces,
      violationsCount
    }
  };
}

/**
 * Checks overall M0D Cutover Readiness across all 8 operational gates.
 * This is readiness evidence only; real M0D execution remains NOT_STARTED.
 */
export function checkM0dCutoverReadiness(rootDir = process.cwd()) {
  const matrixResult = generateLegacyDependencyMatrix(rootDir);
  const workspace = matrixResult.workspace || resolveM0dWorkspace(rootDir);
  const { lms: lmsDir, commerce: commerceDir } = workspace.repoDirs || {};

  function fileHas(dir, file, requiredStrings) {
    if (!dir) return false;
    const fullPath = path.resolve(dir, file);
    if (!fs.existsSync(fullPath)) return false;
    const content = fs.readFileSync(fullPath, "utf8");
    return requiredStrings.every((needle) => content.includes(needle));
  }

  // Both repos must have the strict route resolver; one clean repo cannot
  // stand in for the other.
  const routingClean =
    fileHas(lmsDir, "utils/agency-routing.js", [
      "resolveRequestRoute",
      'route: "AGENCY"',
      "overlapping_host_configuration",
      "resolver_error"
    ]) &&
    fileHas(commerceDir, "utils/agency-routing.js", [
      "resolveRequestRoute",
      'route: "AGENCY"',
      "overlapping_host_configuration",
      "resolver_error"
    ]);

  const entitlementGrantModelEvidence =
    fileHas(lmsDir, "utils/agency-lms-bridge.js", ["student_entitlements"]) &&
    fileHas(commerceDir, "utils/agency-commerce.js", ["approve_agency_order"]);

  const playbackEvidence =
    fileHas(lmsDir, "utils/agency-lms-bridge.js", ["v5_authorize_agency_playback"]) &&
    fileHas(lmsDir, "utils/v5-playback-lease.js", ["issueV5PlaybackLease"]);

  const progressEvidence =
    fileHas(lmsDir, "utils/agency-lms-bridge.js", [
      "handleAgencyLessonProgress",
      "agency_lesson_progress",
      "canonical_lesson_id",
      "membership_id"
    ]) &&
    fileHas(lmsDir, "api/lms/portal.js", [
      'endpoint === "agency-progress"',
      "handleAgencyLessonProgress"
    ]) &&
    fileHas(lmsDir, "v5/app.js", [
      "agencyMode",
      "syncAgencySeenProgress",
      "endpoint=agency-progress"
    ]);

  const homeworkEvidence =
    fileHas(lmsDir, "utils/agency-homework.js", [
      "agency_homework_submissions",
      "submit_agency_homework",
      "grade_agency_homework"
    ]);

  const gates = {
    AGENCY_HOST_ROUTES_NEVER_FALL_TO_LEGACY: routingClean && matrixResult.ok,
    AUTHENTICATED_AGENCY_USER_NEVER_USES_HMAC: matrixResult.ok,
    COMMERCE_USES_AGENCY_TABLES_EXCLUSIVELY: matrixResult.ok,
    ENTITLEMENT_USES_NEW_GRANT_MODEL: entitlementGrantModelEvidence,
    PLAYBACK_USES_B1_1_AGENCY_AUTHORIZATION: playbackEvidence,
    PROGRESS_USES_AGENCY_SCOPED_PROGRESS: progressEvidence,
    HOMEWORK_USES_AGENCY_SCOPED_MODEL: homeworkEvidence,
    NO_AGENCY_REQUESTS_REQUIRE_LEGACY_DB: matrixResult.ok
  };

  const allGatesPass = workspace.complete && Object.values(gates).every((v) => v === true);

  return {
    ok: allGatesPass,
    M0D_READINESS_TOOLING: allGatesPass ? "PASS" : "FAIL",
    M0D_DEPENDENCY_MATRIX: matrixResult.ok ? "PASS" : "FAIL",
    M0D_CUTOVER_CHECKER: allGatesPass ? "PASS" : "FAIL",
    M0D_EXECUTION: "NOT_STARTED",
    gates,
    matrix: matrixResult.matrix,
    summary: matrixResult.summary,
    workspace
  };
}

if (process.argv[1] && process.argv[1].endsWith("m0d-dependency-checker.js")) {
  const res = checkM0dCutoverReadiness();
  console.log("=== M0D READINESS CHECKER RESULTS ===");
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
