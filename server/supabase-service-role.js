// server/supabase-service-role.js
// SERVER-ONLY PRIVILEGED SUPABASE CLIENT
// System B Milestone B4 — Strict Server-Side Import Boundary
// Invariants:
// 1. MUST NEVER be imported by browser/static bundles.
// 2. Fails immediately and closed if evaluated in a browser environment.
// 3. Lazy initializes service_role client strictly on server execution.

import { createClient } from "@supabase/supabase-js";

if (typeof window !== "undefined" || typeof document !== "undefined") {
  throw new Error("SECURITY VIOLATION: Privileged service-role module cannot be imported in browser context!");
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  if (process.env.NODE_ENV !== "test") {
    console.warn("CẢNH BÁO: Thiếu biến môi trường SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  }
}

let _serviceClient = null;

/**
 * Returns the singleton privileged service-role Supabase client.
 * Server-only execution guarantee.
 */
export function getServiceRoleClient() {
  if (typeof window !== "undefined" || typeof document !== "undefined") {
    throw new Error("SECURITY VIOLATION: Privileged service-role client cannot be accessed in browser context!");
  }
  if (!_serviceClient) {
    _serviceClient = createClient(supabaseUrl || "", supabaseServiceKey || "", {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }
  return _serviceClient;
}

export const supabaseServiceRole = new Proxy({}, {
  get(target, prop) {
    const client = getServiceRoleClient();
    const val = client[prop];
    return typeof val === "function" ? val.bind(client) : val;
  }
});
export default supabaseServiceRole;
