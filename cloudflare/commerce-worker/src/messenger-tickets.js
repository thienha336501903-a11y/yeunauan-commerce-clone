// Admin endpoint for Messenger support tickets (M-A). Not under api/ on purpose (Hobby 12-function cap);
// routed by app.js through runCompatHandler, same (req, res) shape and Admin auth as api/orders.js.
import { enforceSameOriginAdminRequest } from "../../../utils/admin-cors.js";
import { supabase } from "../../../utils/supabase.js";
import { getActiveTicket, isTicketId, listTickets, setTicketStatus } from "../../../utils/messenger/tickets.js";
import { loadCourses } from "./messenger.js";

const SLUG = /^[a-z0-9_-]{1,100}$/;

export function createHandler(db = supabase) {
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
        const courses = await loadCourses(env, db).then((list) => list.map(({ slug, title }) => ({ slug, title }))).catch(() => []);
        return res.status(200).json({ tickets: await listTickets(db), courses });
      }
      if (req.method === "POST") {
        const { id, status, action, slug } = req.body || {};
        if (action === "offer") return await offer(env, db, id, slug, res);
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
