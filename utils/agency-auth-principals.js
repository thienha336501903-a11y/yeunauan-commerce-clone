function clean(value) {
  return String(value || "").trim();
}
function lowerEmail(value) {
  return clean(value).toLowerCase();
}
export async function findAuthUserByEmail(client, email, options = {}) {
  const target = lowerEmail(email);
  if (!client?.auth?.admin?.listUsers) throw new Error("auth_admin_client_required");
  if (!target) return { ok: false, code: "invalid_email" };
  const perPage = Math.max(1, Math.min(Number(options.perPage) || 200, 1000));
  const maxPages = Math.max(1, Math.min(Number(options.maxPages) || 100, 500));
  let found = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) return { ok: false, code: "auth_user_lookup_failed", error };
    const users = Array.isArray(data?.users) ? data.users : [];
    for (const user of users) {
      if (lowerEmail(user?.email) !== target) continue;
      if (found && String(found.id) !== String(user.id)) {
        return { ok: false, code: "auth_user_email_ambiguous" };
      }
      found = user;
    }
    if (users.length < perPage) break;
    if (page === maxPages) return { ok: false, code: "auth_user_lookup_page_limit" };
  }
  return found ? { ok: true, found: true, user: found } : { ok: true, found: false, user: null };
}
