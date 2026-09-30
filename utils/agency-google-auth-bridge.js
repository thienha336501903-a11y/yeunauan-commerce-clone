// utils/agency-google-auth-bridge.js
// M0D Agency Commerce browser-auth bridge.
//
// Purpose:
// Agency Commerce authenticates the human with Google Identity Services,
// while Agency Commerce authorization intentionally accepts only Supabase Auth principals.
// This bridge verifies the Google access token server-side, resolves the same
// existing auth.users principal, mints a short-lived Supabase session through
// Supabase Auth itself, and then lets the normal requireAgencyMembership path
// authorize by stable auth.users.id.
//
// Security invariants:
// - Never trusts a browser-supplied email.
// - Binds Google access tokens to this app's configured OAuth client ID.
// - Requires an unexpired token and verified Google email from both tokeninfo
//   and OIDC userinfo; the Google-owned introspection endpoints anchor issuer.
// - Never creates a new auth user.
// - Requires an existing active membership in the request-resolved tenant.
// - Never exposes service_role credentials to the browser.
// - Downstream Agency auth still verifies the Supabase session with auth.getUser().

import { createClient } from "@supabase/supabase-js";
import { supabase as defaultSupabase } from "./supabase.js";

function clean(value) {
  return String(value || "").trim();
}

function lowerEmail(value) {
  return clean(value).toLowerCase();
}

function isVerifiedGoogleEmail(value) {
  return value === true || value === "true";
}

function googleTokenClientMatches(tokenInfo, googleClientId) {
  const clientClaims = {
    azp: clean(tokenInfo?.azp),
    issuedTo: clean(tokenInfo?.issued_to),
    aud: clean(tokenInfo?.aud),
    audience: clean(tokenInfo?.audience)
  };

  // azp is the modern "authorized party" field; issued_to is the older
  // tokeninfo equivalent. At least one requester identity must be present.
  const requestedBy = clientClaims.azp || clientClaims.issuedTo;
  if (!requestedBy || requestedBy !== googleClientId) return false;

  // Reject any other client-identifying claim that is present but conflicts.
  return Object.values(clientClaims).every(
    (value) => !value || value === googleClientId
  );
}

function googleTokenUnexpired(tokenInfo) {
  const expiresIn = Number(tokenInfo?.expires_in);
  if (Number.isFinite(expiresIn)) return expiresIn > 0;

  const exp = Number(tokenInfo?.exp);
  if (Number.isFinite(exp)) return exp > Math.floor(Date.now() / 1000);

  return false;
}

export async function verifyGoogleAccessToken(accessToken, options = {}) {
  const token = clean(accessToken);
  const fetchImpl = options.fetchImpl || fetch;
  const googleClientId = clean(options.googleClientId || process.env.GOOGLE_CLIENT_ID);

  if (!token) {
    return { ok: false, status: 401, code: "missing_google_access_token", error: "Missing Google access token." };
  }

  if (!googleClientId) {
    return { ok: false, status: 500, code: "google_oauth_not_configured", error: "Google OAuth client is not configured." };
  }

  try {
    // Google's tokeninfo endpoint introspects only Google-issued access tokens
    // and exposes the audience, expiry and verified-email state for the token.
    const tokenInfoResponse = await fetchImpl(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" }
      }
    );

    if (!tokenInfoResponse.ok) {
      return { ok: false, status: 401, code: "invalid_google_access_token", error: "Google sign-in token is invalid or expired." };
    }

    const tokenInfo = await tokenInfoResponse.json();
    if (!googleTokenClientMatches(tokenInfo, googleClientId)) {
      return { ok: false, status: 401, code: "google_token_audience_mismatch", error: "Google sign-in token was issued to or requested by a different OAuth client." };
    }

    if (!googleTokenUnexpired(tokenInfo)) {
      return { ok: false, status: 401, code: "invalid_google_access_token", error: "Google sign-in token is invalid or expired." };
    }

    const tokenInfoEmail = lowerEmail(tokenInfo?.email);
    const tokenInfoVerified =
      isVerifiedGoogleEmail(tokenInfo?.email_verified) ||
      isVerifiedGoogleEmail(tokenInfo?.verified_email);

    if (!tokenInfoEmail || !tokenInfoVerified) {
      return { ok: false, status: 401, code: "google_email_unverified", error: "Google account email is missing or unverified." };
    }

    const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });

    if (!response.ok) {
      return { ok: false, status: 401, code: "invalid_google_access_token", error: "Google sign-in token is invalid or expired." };
    }

    const profile = await response.json();
    const email = lowerEmail(profile?.email);

    // Fail closed: missing email_verified is not equivalent to verified.
    if (!email || profile?.email_verified !== true) {
      return { ok: false, status: 401, code: "google_email_unverified", error: "Google account email is missing or unverified." };
    }

    if (email !== tokenInfoEmail) {
      return { ok: false, status: 401, code: "google_identity_mismatch", error: "Google identity claims are inconsistent." };
    }

    const tokenSubject = clean(tokenInfo?.sub || tokenInfo?.user_id);
    const profileSubject = clean(profile?.sub);
    if (tokenSubject && profileSubject && tokenSubject !== profileSubject) {
      return { ok: false, status: 401, code: "google_identity_mismatch", error: "Google identity claims are inconsistent." };
    }

    return { ok: true, email };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: "google_identity_unavailable",
      error: "Unable to verify Google identity."
    };
  }
}

function setAccessTokenCookie(res, accessToken, expiresInSeconds) {
  const maxAge = Math.max(60, Math.min(Number(expiresInSeconds) || 3600, 86400));
  const cookie = [
    `sb-access-token=${encodeURIComponent(accessToken)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ].join("; ");

  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : null;
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
  } else {
    res.setHeader("Set-Cookie", [existing, cookie]);
  }
}

export async function bridgeGoogleAccessTokenToSupabaseSession(req, res, tenant, options = {}) {
  const client = options.supabaseClient || defaultSupabase;
  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = clean(req?.body?.accessToken);

  if (!tenant?.agencyId) {
    return { ok: false, status: 403, code: "untrusted_tenant_context", error: "Trusted Agency tenant is required." };
  }

  const googleIdentity = await verifyGoogleAccessToken(accessToken, {
    fetchImpl,
    googleClientId: options.googleClientId || process.env.GOOGLE_CLIENT_ID
  });
  if (!googleIdentity.ok) return googleIdentity;

  const { data: usersData, error: usersError } = await client.auth.admin.listUsers({
    page: 1,
    perPage: 1000
  });

  if (usersError) {
    return { ok: false, status: 500, code: "auth_user_lookup_failed", error: "Unable to resolve Supabase Auth principal." };
  }

  const authUser = (usersData?.users || []).find(
    (user) => lowerEmail(user?.email) === googleIdentity.email
  );

  if (!authUser?.id) {
    return {
      ok: false,
      status: 403,
      code: "supabase_principal_not_found",
      error: "Google account is not registered as a Supabase Auth principal."
    };
  }

  const { data: membership, error: membershipError } = await client
    .from("agency_memberships")
    .select("id, agency_id, user_id, status")
    .eq("agency_id", tenant.agencyId)
    .eq("user_id", authUser.id)
    .maybeSingle();

  if (membershipError) {
    return { ok: false, status: 500, code: "membership_lookup_failed", error: "Unable to verify Agency membership." };
  }

  if (!membership || membership.status !== "active") {
    return {
      ok: false,
      status: 403,
      code: "membership_not_found",
      error: "Google account is not an active member of this Agency."
    };
  }

  // Mint through Supabase Auth itself. generateLink does not send email; its
  // hashed token is immediately redeemed server-side for a real Supabase session.
  const { data: linkData, error: linkError } = await client.auth.admin.generateLink({
    type: "magiclink",
    email: authUser.email
  });

  const tokenHash =
    clean(linkData?.properties?.hashed_token) ||
    clean(linkData?.properties?.hashedToken);

  if (linkError || !tokenHash) {
    return { ok: false, status: 500, code: "session_mint_failed", error: "Unable to create Supabase authentication session." };
  }

  // IMPORTANT: redeem the OTP on an isolated Supabase client. Redeeming on
  // the shared service-role singleton can replace that client's in-memory auth
  // context with the learner session and make subsequent privileged reads look
  // like user-scoped/RLS reads.
  const exchangeUrl = process.env.SUPABASE_URL || "";
  const exchangeKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!exchangeUrl || !exchangeKey) {
    return { ok: false, status: 500, code: "session_exchange_not_configured", error: "Supabase Auth exchange is not configured." };
  }

  const exchangeClient = createClient(exchangeUrl, exchangeKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const { data: verified, error: verifyError } = await exchangeClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash
  });

  const session = verified?.session;
  if (verifyError || !session?.access_token || verified?.user?.id !== authUser.id) {
    return { ok: false, status: 500, code: "session_exchange_failed", error: "Unable to exchange Google identity for Supabase session." };
  }

  setAccessTokenCookie(res, session.access_token, session.expires_in);

  // The current request immediately continues through the unchanged Agency
  // authorization stack, which will call auth.getUser() on this Supabase token.
  req.headers = req.headers || {};
  req.headers.authorization = `Bearer ${session.access_token}`;

  return {
    ok: true,
    userId: authUser.id,
    membershipId: membership.id
  };
}
