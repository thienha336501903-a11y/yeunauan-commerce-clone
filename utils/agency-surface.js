const SURFACES = new Set(["lms", "commerce"]);

function clean(value) {
  return String(value || "").trim();
}

function originForHost(hostname) {
  const host = clean(hostname).toLowerCase();
  if (!host) return "";
  return `https://${host}`;
}

export async function getAgencyPrimarySurfaceHost(agencyId, surface, options = {}) {
  const client = options.supabaseClient;
  if (!client) throw new Error("agency_surface_supabase_required");

  const agency = clean(agencyId);
  const typedSurface = clean(surface).toLowerCase();
  if (!agency || !SURFACES.has(typedSurface)) {
    return { ok: false, status: 400, code: "invalid_agency_surface" };
  }

  const { data, error } = await client
    .from("agency_domains")
    .select("hostname,surface,is_primary,status,ssl_status")
    .eq("agency_id", agency)
    .eq("surface", typedSurface)
    .eq("status", "active")
    .eq("ssl_status", "active")
    .order("is_primary", { ascending: false })
    .limit(2);

  if (error) {
    return { ok: false, status: 500, code: "agency_surface_lookup_failed", error };
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1 || !clean(rows[0]?.hostname)) {
    return {
      ok: false,
      status: rows.length > 1 ? 409 : 404,
      code: rows.length > 1 ? "agency_surface_ambiguous" : "agency_surface_not_found"
    };
  }

  return {
    ok: true,
    hostname: clean(rows[0].hostname).toLowerCase(),
    origin: originForHost(rows[0].hostname),
    surface: typedSurface
  };
}

export async function getAgencySurfaceOriginOrFallback(agencyId, surface, fallbackOrigin, options = {}) {
  const result = await getAgencyPrimarySurfaceHost(agencyId, surface, options);
  if (result.ok) return result.origin;

  // Backward compatibility only for pre-Factory tenants such as current Agency A,
  // whose historical domains have surface = NULL. New Factory tenants are typed.
  if (options.allowUntypedFallback === true && result.code === "agency_surface_not_found") {
    const fallback = clean(fallbackOrigin);
    return fallback;
  }

  const error = new Error(result.code || "agency_surface_lookup_failed");
  error.status = result.status || 500;
  error.code = result.code || "agency_surface_lookup_failed";
  throw error;
}
