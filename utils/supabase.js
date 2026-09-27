// utils/supabase.js
// Server-side database client adapter
// Re-exports from server-only privileged module.

import { supabaseServiceRole, getServiceRoleClient } from "../server/supabase-service-role.js";

export const supabase = supabaseServiceRole;
export { getServiceRoleClient };
export default supabase;
