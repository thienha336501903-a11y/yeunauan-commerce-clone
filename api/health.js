import { createClient } from "@supabase/supabase-js";
import { resolveTenant } from "../utils/tenant-resolver.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Tenant ingress boundary check
  if (req.query?.tenantCheck === "1") {
    const tenantRes = await resolveTenant(req, { surface: "storefront" });
    if (!tenantRes.ok) {
      return res.status(tenantRes.status || 400).json({
        success: false,
        code: tenantRes.code,
        error: tenantRes.error
      });
    }
    return res.status(200).json({
      success: true,
      status: "ok",
      surface: "storefront",
      tenant: {
        agencyId: tenantRes.tenant.agencyId,
        slug: tenantRes.tenant.slug,
        name: tenantRes.tenant.name
      }
    });
  }

  let dbStatus = "ok";
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      dbStatus = "degraded";
    } else {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { error } = await supabase.from("courses").select("id").limit(1);
      if (error) dbStatus = "degraded";
    }
  } catch (e) {
    dbStatus = "error";
  }

  return res.status(200).json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    app: "ok",
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
}

