// Admin endpoint for Messenger support tickets (M-A). Not under api/ on purpose (Hobby 12-function cap);
// routed by app.js through runCompatHandler, same (req, res) shape and Admin auth as api/orders.js.
import { enforceSameOriginAdminRequest } from "../../../utils/admin-cors.js";
import { supabase } from "../../../utils/supabase.js";
import { listTickets, setTicketStatus } from "../../../utils/messenger/tickets.js";

export function createHandler(db = supabase) {
  return async function handler(req, res) {
    // Flag off: the endpoint does not exist (checked before auth so it reveals nothing).
    if (String(process.env.MESSENGER_TICKETS_ENABLED || "").trim() !== "1") return res.status(404).json({ error: "Not found" });
    if (!enforceSameOriginAdminRequest(req, res, ["GET", "POST", "OPTIONS"])) return;
    const adminPassword = req.headers["x-admin-password"];
    const systemPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword !== systemPassword) return res.status(401).json({ error: "Unauthorized" });
    try {
      if (req.method === "GET") return res.status(200).json({ tickets: await listTickets(db) });
      if (req.method === "POST") {
        const { id, status } = req.body || {};
        const result = await setTicketStatus(id, status, db);
        return result.ok ? res.status(200).json({ success: true }) : res.status(result.status).json({ error: result.error });
      }
      return res.status(405).json({ error: "Method not allowed" });
    } catch {
      return res.status(500).json({ error: "Không xử lý được yêu cầu." }); // no DB detail to the client
    }
  };
}

export default createHandler();
