import { resolveRequestRoute } from "../utils/agency-routing.js";
import { requireAgencyMembership } from "../utils/agency-auth.js";
import { bridgeGoogleAccessTokenToSupabaseSession } from "../utils/agency-google-auth-bridge.js";

function clearAccessTokenCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const options = req.__options || {};

  const routeDecision = await resolveRequestRoute(req, options);
  if (routeDecision.route === "DENY") {
    return res.status(routeDecision.status || 403).json({
      success: false,
      code: routeDecision.code,
      error: routeDecision.error
    });
  }

  if (routeDecision.route !== "AGENCY") {
    return res.status(404).json({
      success: false,
      code: "agency_session_not_available",
      error: "Agency session endpoint is available only on an active Agency domain."
    });
  }

  if (req.method === "POST") {
    const bridge = await bridgeGoogleAccessTokenToSupabaseSession(
      req,
      res,
      routeDecision.tenant,
      options
    );
    if (!bridge.ok) {
      return res.status(bridge.status || 401).json({
        success: false,
        code: bridge.code,
        error: bridge.error
      });
    }

    return res.status(200).json({
      success: true,
      userId: bridge.userId,
      membershipId: bridge.membershipId,
      agency: {
        id: routeDecision.tenant.agencyId,
        slug: routeDecision.tenant.agencySlug,
        name: routeDecision.tenant.agencyName
      }
    });
  }

  if (req.method === "GET") {
    const auth = await requireAgencyMembership(req, options);
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        success: false,
        code: auth.code,
        error: auth.error
      });
    }

    return res.status(200).json({
      success: true,
      member: {
        id: auth.membership.id,
        userId: auth.user.id,
        email: auth.user.email || "",
        displayName: auth.membership.display_name || "",
        role: auth.membership.role,
        status: auth.membership.status
      },
      agency: {
        id: auth.tenant.agencyId,
        slug: auth.tenant.agencySlug,
        name: auth.tenant.agencyName
      }
    });
  }

  if (req.method === "DELETE") {
    clearAccessTokenCookie(res);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({
    success: false,
    code: "method_not_allowed",
    error: "Method not allowed."
  });
}
