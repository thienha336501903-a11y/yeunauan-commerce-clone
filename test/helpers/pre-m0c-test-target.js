// test/helpers/pre-m0c-test-target.js
// Test-only isolated target guard for destructive synthetic provisioning suites.
// This module is never imported by production application code.

import pg from "pg";

function requireExplicitLocalTarget() {
  const dbUrl = String(process.env.PRE_M0C_TEST_DATABASE_URL || "").trim();
  const supabaseUrl = String(process.env.PRE_M0C_TEST_SUPABASE_URL || "").trim();
  const fingerprint = String(process.env.PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT || "").trim();

  if (!dbUrl || !supabaseUrl || !fingerprint) {
    throw new Error("SKIP_ENVIRONMENT: explicit PRE_M0C_TEST_DATABASE_URL, PRE_M0C_TEST_SUPABASE_URL and PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT are required.");
  }

  const forbidden = ["yyiavtiwtekkocqpephr", "aqozjkfwzmyfunqvcyjv"];
  if (forbidden.some((projectRef) => dbUrl.includes(projectRef) || supabaseUrl.includes(projectRef))) {
    throw new Error("Protected Main/Legacy target cannot install a pre-M0C synthetic test guard.");
  }
  if (!/(127\.0\.0\.1|localhost|\[::1\])/.test(dbUrl)) {
    throw new Error("Synthetic guard installation is restricted to an isolated local PostgreSQL target.");
  }
  const parsed = new URL(supabaseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Synthetic guard installation is restricted to an isolated local Supabase stack.");
  }

  return { dbUrl, fingerprint };
}

export async function installPreM0cTestTargetGuard(runId) {
  if (!runId) throw new Error("runId is required to install the isolated test-target guard.");
  const { dbUrl, fingerprint } = requireExplicitLocalTarget();
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.__pre_m0c_test_target_guard (
        run_id uuid PRIMARY KEY,
        environment_fingerprint text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON TABLE public.__pre_m0c_test_target_guard FROM PUBLIC, anon, authenticated, service_role;
    `);
    await client.query(
      `INSERT INTO public.__pre_m0c_test_target_guard (run_id, environment_fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (run_id) DO UPDATE
       SET environment_fingerprint = EXCLUDED.environment_fingerprint`,
      [runId, fingerprint]
    );
  } finally {
    await client.end();
  }
  return { runId, environmentFingerprint: fingerprint };
}

export async function removePreM0cTestTargetGuard(runId) {
  const { dbUrl } = requireExplicitLocalTarget();
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("DELETE FROM public.__pre_m0c_test_target_guard WHERE run_id = $1", [runId]);
  } finally {
    await client.end();
  }
}
