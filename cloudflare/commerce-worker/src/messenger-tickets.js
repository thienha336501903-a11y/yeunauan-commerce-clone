// Admin endpoint for Messenger support tickets (M-A). Not under api/ on purpose (Hobby 12-function cap);
// routed by app.js through runCompatHandler, same (req, res) shape and Admin auth as api/orders.js.
import { enforceSameOriginAdminRequest } from "../../../utils/admin-cors.js";
import { supabase } from "../../../utils/supabase.js";
import { getActiveTicket, isTicketId, listActiveTicketRows, listTicketRows, markTicketSeen, setTicketStatus, toView } from "../../../utils/messenger/tickets.js";
import { fetchProfileName } from "../../../utils/messenger/meta.js";
import { loadCourses } from "./messenger.js";

const SLUG = /^[a-z0-9_-]{1,100}$/;
const NAME_LOOKUPS = 20;

// Active tickets get the customer's Facebook name (the inbox is searched by name; Meta has no link to one chat).
// Server side only: the UI gets the name and psidTail, never the full PSID. Names are not stored.
async function ticketsWithNames(env, db, fetchImpl) {
  const rows = await listTicketRows(db);
  const token = env.META_PAGE_ACCESS_TOKEN;
  // Newest first, so a backlog over the cap leaves the oldest tickets without a name, not the new ones.
  const active = rows.filter((r) => r.status !== "done").reverse().slice(0, NAME_LOOKUPS);
  const names = new Map(await Promise.all(active.map(async (r) => [r.id, await fetchProfileName(r.psid, { token, fetchImpl })])));
  return rows.map((r) => ({ ...toView(r), ...(names.get(r.id) ? { name: names.get(r.id) } : {}) }));
}

export function createHandler(db = supabase, { fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    // Flag off: the endpoint does not exist (checked before auth so it reveals nothing).
    if (String(process.env.MESSENGER_TICKETS_ENABLED || "").trim() !== "1") return res.status(404).json({ error: "Not found" });
    if (!enforceSameOriginAdminRequest(req, res, ["GET", "POST", "OPTIONS"])) return;
    const adminPassword = req.headers["x-admin-password"];
    const systemPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword !== systemPassword) return res.status(401).json({ error: "Unauthorized" });
    // Worker bindings (MESSENGER_CONVERSATIONS) come from req.__env, passed by app.js; vars also live in process.env.
    const env = req.__env || process.env;
    try {
      if (req.method === "GET") {
        // Sellable courses for the "send registration" picker; a failure only empties the picker.
        // ?changes=1: the page's 30-second check. Ids, status and times only: no Meta call, no courses, no text.
        if (String(req.query?.changes || "") === "1") {
          const rows = await listActiveTicketRows(db);
          return res.status(200).json({ changes: rows.map(({ id, status, updated_at, customer_msg_at, seen_at }) => ({ id, status, updated_at, customer_msg_at: customer_msg_at || null, seen_at: seen_at || null })) });
        }
        const courses = await loadCourses(env, db).then((list) => list.map(({ slug, title }) => ({ slug, title }))).catch(() => []);
        return res.status(200).json({ tickets: await ticketsWithNames(env, db, fetchImpl), courses });
      }
      if (req.method === "POST") {
        const { id, status, action, slug, seenAsOf } = req.body || {};
        if (action === "offer") return await offer(env, db, id, slug, res);
        if (action === "seen") {
          const seen = await markTicketSeen(id, db, seenAsOf);
          return seen.ok ? res.status(200).json({ success: true }) : res.status(seen.status).json({ error: seen.error });
        }
        const result = await setTicketStatus(id, status, db);
        return result.ok ? res.status(200).json({ success: true }) : res.status(result.status).json({ error: result.error });
      }
      return res.status(405).json({ error: "Method not allowed" });
    } catch {
      return res.status(500).json({ error: "Không xử lý được yêu cầu." }); // no DB detail to the client
    }
  };
}

// Admin sends the customer a registration card for a course. The ticket is closed only after Meta accepted the messages.
async function offer(env, db, id, slug, res) {
  if (!isTicketId(id) || !SLUG.test(String(slug || ""))) return res.status(400).json({ error: "invalid_request" });
  const ticket = await getActiveTicket(id, db);
  if (!ticket) return res.status(404).json({ error: "ticket_not_found" });
  const ns = env.MESSENGER_CONVERSATIONS;
  if (String(env.MESSENGER_BOT_ENABLED || "").trim() !== "1" || !ns) return res.status(503).json({ error: "bot_unavailable" });
  const reply = await ns.get(ns.idFromName(String(ticket.psid))).fetch("https://messenger.internal/offer", {
    method: "POST",
    body: JSON.stringify({ psid: String(ticket.psid), slug })
  });
  if (reply.status === 409) return res.status(409).json({ error: "course_unavailable" });
  if (!reply.ok) return res.status(502).json({ ok: false, sent: false, error: "send_failed" });
  // Already sent: a failed status write must not look like a failed send (the Admin would send twice).
  const done = await setTicketStatus(id, "done", db).then((r) => r.ok, () => false);
  return res.status(200).json({ ok: true, sent: true, done });
}

export default createHandler();
