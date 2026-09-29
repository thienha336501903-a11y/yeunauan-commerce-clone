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
      { repo: "lms", file: "api/lms/admin.js" }
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
  if (visited.has(fullPath)) {
    return visited;
  }
  visited.add(fullPath);
  if (!fs.existsSync(fullPath)) return visited;

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const importRegex = /(?:import\s+.*?from\s+["'](\.[^"']+)["']|import\(["'](\.[^"']+)["']\)|from\s+["'](\.[^"']+)["']|import\s+["'](\.[^"']+)["'])/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const relPath = match[1] || match[2] || match[3] || match[4];
      if (relPath) {
        const dir = path.dirname(fullPath);
        let resolved = path.resolve(dir, relPath);
        if (!fs.existsSync(resolved)) {
          if (fs.existsSync(resolved + ".js")) resolved = resolved + ".js";
          else if (fs.existsSync(path.join(resolved, "index.js"))) resolved = path.join(resolved, "index.js");
        }
        if (!visited.has(resolved)) {
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
 * Generates the M0D Legacy Dependency Matrix by auditing real entrypoints and agency modules.
 */
export function generateLegacyDependencyMatrix(rootDir = process.cwd()) {
  const matrix = [];

  // Determine current repository type
  const isLmsRepo = fs.existsSync(path.resolve(rootDir, "api/lms/portal.js"));
  const isCommerceRepo = fs.existsSync(path.resolve(rootDir, "api/config.js"));
  const currentRepoType = isLmsRepo ? "lms" : (isCommerceRepo ? "commerce" : "unknown");

  // Check if sibling repo exists for comprehensive cross-repo audit
  const siblingDir = process.env.M0D_SIBLING_ROOT || path.resolve(rootDir,
    isLmsRepo ? "../yeunauan-commerce-clone" : "../yeunauan-lms-clone");
  const siblingMarker = isLmsRepo ? "api/config.js" : "api/lms/portal.js";
  const hasSibling = currentRepoType !== "unknown" &&
    fs.existsSync(path.resolve(siblingDir, siblingMarker));

  for (const surf of REQUIRED_SURFACES) {
    let status = "UNKNOWN";
    let legacyRequired = null;
    let legacyReferenceFound = "NO";
    const auditedFiles = [];
    const violations = [];
    let entrypointGuarded = false;
    let missingEvidence = !hasSibling;

    // 1. Audit Entrypoints
    for (const ep of surf.entrypoints) {
      const belongsToCurrent = ep.repo === currentRepoType;
      const targetDir = belongsToCurrent ? rootDir : (hasSibling ? siblingDir : null);

      if (!targetDir) {
        missingEvidence = true;
        continue;
      }

      const fullPath = path.resolve(targetDir, ep.file);
      if (!fs.existsSync(fullPath)) {
        missingEvidence = true;
        continue;
      }

      auditedFiles.push(ep.file);
      const content = fs.readFileSync(fullPath, "utf8");

      // Verify routing guard in entrypoint
      const routing = auditEntrypointRouting(ep.file, content);
      if (!routing.hasRoutingGuard || !routing.hasAgencyBranch) missingEvidence = true;
      else entrypointGuarded = true;

      // Audit Agency execution branch inside entrypoint
      const agencyBranchContent = extractAgencyBranchContent(content);
      if (agencyBranchContent) {
        const epViolations = auditFileContent(ep.file, agencyBranchContent);
        if (epViolations.length > 0) {
          violations.push(...epViolations);
          legacyReferenceFound = "YES";
        }
      }
    }

    // 2. Audit Agency Modules & their transitive imports
    for (const mod of surf.agencyModules) {
      const fullPath = path.resolve(rootDir, mod);
      const targetDir = fs.existsSync(fullPath) ? rootDir : (hasSibling ? siblingDir : null);

      if (!targetDir) {
        missingEvidence = true;
        continue;
      }

      const modPath = path.resolve(targetDir, mod);
      if (!fs.existsSync(modPath)) {
        missingEvidence = true;
        continue;
      }

      if (!auditedFiles.includes(mod)) auditedFiles.push(mod);
      const content = fs.readFileSync(modPath, "utf8");
      const fileViolations = auditFileContent(mod, content);
      if (fileViolations.length > 0) {
        violations.push(...fileViolations);
        legacyReferenceFound = "YES";
      }

      // Trace transitive imports from agency modules in Agency execution path
      const traced = traceTransitiveLocalImports(mod, targetDir);
      for (const tFile of traced) {
        const relTFile = path.relative(targetDir, tFile);
        if (!fs.existsSync(tFile)) {
          missingEvidence = true;
          continue;
        }
        if (!auditedFiles.includes(relTFile)) {
          auditedFiles.push(relTFile);
          const tContent = fs.readFileSync(tFile, "utf8");
          const tViolations = auditFileContent(relTFile, tContent);
          if (tViolations.length > 0) {
            violations.push(...tViolations);
            legacyReferenceFound = "YES";
          }
        }
      }
    }

    // Determine Status
    // A module's existence is not proof that an Agency request can reach it.
    // These checks use the concrete entrypoint and browser caller at this HEAD.
    const lmsDir = isLmsRepo ? rootDir : siblingDir;
    const commerceDir = isCommerceRepo ? rootDir : siblingDir;
    const read = (dir, file) => fs.existsSync(path.resolve(dir, file))
      ? fs.readFileSync(path.resolve(dir, file), "utf8") : "";
    const portal = hasSibling ? read(lmsDir, "api/lms/portal.js") : "";
    const admin = hasSibling ? read(lmsDir, "api/lms/admin.js") : "";
    const storefront = hasSibling ? read(commerceDir, "index.html") : "";
    const register = hasSibling ? read(commerceDir, "api/register.js") : "";
    const apiFiles = hasSibling ? [lmsDir, commerceDir].flatMap(dir => {
      const apiDir = path.resolve(dir, "api");
      const scan = current => fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? scan(path.join(current, entry.name)) :
          entry.name.endsWith(".js") ? [fs.readFileSync(path.join(current, entry.name), "utf8")] : []) : [];
      return scan(apiDir);
    }) : [];
    const reachable = symbol => apiFiles.some(code => code.includes(symbol));
    const dependency = (pattern, description, file) => {
      violations.push({ file, pattern, description });
      legacyReferenceFound = "YES";
    };
    if (hasSibling && surf.surface === "storefront" &&
        storefront.includes("fetch('/api/register'") && register.includes("agency_legacy_order_prohibited")) {
      dependency("agency_storefront_legacy_registration", "Agency storefront still submits to the rejected Legacy registration endpoint.", "index.html");
    }
    if (hasSibling && surf.surface === "checkout" && !reachable("checkoutOffering(")) {
      missingEvidence = true;
    }
    if (hasSibling && surf.surface === "agency admin" &&
        (!admin.includes("resolveRequestRoute") || !admin.includes("requireAgencyRole"))) {
      missingEvidence = true;
    }
    if (hasSibling && surf.surface === "homework" &&
        !reachable("submitAgencyHomework(") && !reachable("agencyHomeworkOperations.submitHomework(")) {
      missingEvidence = true;
    }
    if (hasSibling && surf.surface === "learner" && !portal.includes("handleAgencyLearnerDashboard(req, res)")) missingEvidence = true;
    if (hasSibling && surf.surface === "learning/player" &&
        (!portal.includes("handleAgencyV5Feed(req, res)") || !portal.includes("handleAgencyCourseIntro(req, res)"))) missingEvidence = true;
    if (hasSibling && surf.surface === "V5 playback" && !portal.includes("handleAgencyV5Play(req, res)")) missingEvidence = true;

    if (auditedFiles.length === 0 || missingEvidence) {
      status = "UNKNOWN";
      legacyRequired = "UNKNOWN";
    } else if (violations.length > 0) {
      status = "FAIL";
      legacyRequired = "YES";
    } else if (entrypointGuarded && surf.agencyModules.every(m => auditedFiles.includes(m))) {
      status = "PASS";
      legacyRequired = "NO";
    } else {
      status = "UNKNOWN";
      legacyRequired = "UNKNOWN";
    }

    matrix.push({
      surface: surf.surface,
      description: surf.description,
      status,
      LEGACY_REQUIRED: legacyRequired,
      LEGACY_REFERENCE_FOUND: legacyReferenceFound,
      auditedFiles,
      violations: violations.length > 0 ? violations : null
    });
  }

  // FIX 13: matrix.ok requires ALL surfaces to PASS; UNKNOWN makes ok = false
  const hasUnknown = matrix.some(r => r.status === "UNKNOWN");
  const hasFail = matrix.some(r => r.status === "FAIL");
  const allPass = matrix.every(r => r.status === "PASS");
  const ok = allPass && !hasUnknown && !hasFail;

  return {
    ok,
    matrix,
    summary: {
      totalSurfaces: matrix.length,
      passedSurfaces: matrix.filter(r => r.status === "PASS").length,
      failedSurfaces: matrix.filter(r => r.status === "FAIL").length,
      unknownSurfaces: matrix.filter(r => r.status === "UNKNOWN").length
    }
  };
}

/**
 * Checks overall M0D Cutover Readiness across all 8 operational gates.
 * Computes checkable evidence from real code and file audits (NO hardcoded true).
 */
export function checkM0dCutoverReadiness(rootDir = process.cwd()) {
  const matrixResult = generateLegacyDependencyMatrix(rootDir);

  const isLmsRepo = fs.existsSync(path.resolve(rootDir, "api/lms/portal.js"));
  const siblingDir = process.env.M0D_SIBLING_ROOT || path.resolve(rootDir,
    isLmsRepo ? "../yeunauan-commerce-clone" : "../yeunauan-lms-clone");
  const lmsDir = isLmsRepo ? rootDir : siblingDir;
  const commerceDir = isLmsRepo ? siblingDir : rootDir;
  const read = (dir, file) => fs.existsSync(path.resolve(dir, file))
    ? fs.readFileSync(path.resolve(dir, file), "utf8") : "";
  const bothRepos = Boolean(read(lmsDir, "api/lms/portal.js") && read(commerceDir, "api/config.js"));

  // 1. Verify routing table integrity
  const routingClean = bothRepos && [lmsDir, commerceDir].every(dir => {
    const routingCode = read(dir, "utils/agency-routing.js");
    return routingCode.includes('route: "AGENCY"') &&
      routingCode.includes("overlapping_host_configuration") &&
      routingCode.includes("resolver_error");
  });
  const lmsPortal = read(lmsDir, "api/lms/portal.js");
  const lmsAdmin = read(lmsDir, "api/lms/admin.js");
  const learning = read(lmsDir, "api/learning.js");
  const commerceConfig = read(commerceDir, "api/config.js");
  const storefront = read(commerceDir, "index.html");
  const register = read(commerceDir, "api/register.js");
  const guardedEntrypoints = [lmsPortal, lmsAdmin, learning, commerceConfig,
    read(commerceDir, "api/courses.js"), register, read(commerceDir, "api/orders.js")]
    .every(code => code.includes("resolveRequestRoute") && code.includes('routeDecision.route === "DENY"'));
  // Other live Legacy endpoints are still callable on an Agency hostname.
  // Do not claim a host-wide boundary from only the seven audited entrypoints.
  const legacyEndpoints = [
    [lmsDir, "api/sync.js"], [lmsDir, "api/v5-sync.js"],
    [lmsDir, "api/legacy-post-redirect.js"],
    [commerceDir, "api/approve-all.js"], [commerceDir, "api/check-auth.js"],
    [commerceDir, "api/upload.js"], [commerceDir, "api/telegram-connect.js"],
    [commerceDir, "api/telegram-setup.js"], [commerceDir, "api/telegram-webhook.js"]
  ];
  const legacyEndpointsGuarded = legacyEndpoints.every(([dir, file]) => {
    const code = read(dir, file);
    return !code || (code.includes("resolveRequestRoute") && code.includes('routeDecision.route === "AGENCY"'));
  });

  // 2. Evidence-based verification for entitlement grant model
  const entitlementGrantModelEvidence = bothRepos &&
    read(lmsDir, "utils/agency-lms-bridge.js").includes('.from("student_entitlements")') &&
    read(commerceDir, "utils/agency-commerce.js").includes('rpc("approve_agency_order"');

  // 3. Evidence-based verification for B1.1 agency playback authorization
  const playbackBridge = read(lmsDir, "utils/agency-lms-bridge.js");
  const playbackEvidence = bothRepos && lmsPortal.includes("handleAgencyV5Play(req, res)") &&
    playbackBridge.includes('rpc("v5_authorize_agency_playback"') &&
    playbackBridge.includes("issueV5PlaybackLease({") &&
    read(lmsDir, "utils/v5-playback-lease.js").includes("export function issueV5PlaybackLease");

  // 4. Evidence-based verification for agency scoped progress
  const progressEvidence = bothRepos &&
    [lmsPortal, learning, read(lmsDir, "utils/agency-lms-bridge.js")]
      .some(code => code.includes('.from("agency_lesson_progress")'));

  // 5. Evidence-based verification for agency homework model
  const homeworkModule = read(lmsDir, "utils/agency-homework.js");
  const homeworkEvidence = bothRepos &&
    homeworkModule.includes('rpc("submit_agency_homework"') &&
    homeworkModule.includes('rpc("grade_agency_homework"') &&
    [lmsPortal, lmsAdmin].some(code => code.includes("submitAgencyHomework(") || code.includes("agencyHomeworkOperations.submitHomework("));

  const gates = {
    AGENCY_HOST_ROUTES_NEVER_FALL_TO_LEGACY: routingClean && guardedEntrypoints && legacyEndpointsGuarded,
    AUTHENTICATED_AGENCY_USER_NEVER_USES_HMAC: bothRepos && guardedEntrypoints && legacyEndpointsGuarded &&
      read(lmsDir, "utils/agency-auth.js").includes("client.auth.getUser(token)") &&
      read(commerceDir, "utils/agency-auth.js").includes("client.auth.getUser(token)"),
    COMMERCE_USES_AGENCY_TABLES_EXCLUSIVELY: bothRepos &&
      commerceConfig.includes("getAgencyCommerceConfig(req)") &&
      !storefront.includes("fetch('/api/register'") &&
      read(commerceDir, "utils/agency-commerce.js").includes('.from("agency_orders")'),
    ENTITLEMENT_USES_NEW_GRANT_MODEL: entitlementGrantModelEvidence,
    PLAYBACK_USES_B1_1_AGENCY_AUTHORIZATION: playbackEvidence,
    PROGRESS_USES_AGENCY_SCOPED_PROGRESS: progressEvidence,
    HOMEWORK_USES_AGENCY_SCOPED_MODEL: homeworkEvidence,
    NO_AGENCY_REQUESTS_REQUIRE_LEGACY_DB: matrixResult.ok && guardedEntrypoints && legacyEndpointsGuarded &&
      !storefront.includes("fetch('/api/register'")
  };

  const allGatesPass = Object.values(gates).every(v => v === true);

  return {
    ok: allGatesPass,
    M0D_DEPENDENCY_MATRIX: matrixResult.ok ? "PASS" : "FAIL",
    M0D_CUTOVER_CHECKER: allGatesPass ? "PASS" : "FAIL",
    M0D_EXECUTION: "NOT_STARTED", // Invariant: Real M0D cutover has NOT been started
    gates,
    matrix: matrixResult.matrix,
    summary: matrixResult.summary
  };
}

if (process.argv[1] && process.argv[1].endsWith("m0d-dependency-checker.js")) {
  const res = checkM0dCutoverReadiness();
  console.log("=== M0D READINESS CHECKER RESULTS ===");
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
