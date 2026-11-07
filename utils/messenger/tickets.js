// Messenger support tickets (M-A). Thin DB helpers; `db` is a supabase client (service role), injectable for tests.
// Never log psid, message text or e-mail from here.
import { supabase } from "../supabase.js";

const TABLE = "messenger_support_tickets";
const ACTIVE = ["open", "in_progress"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function redactSummary(text) {
  return String(text || "")
    .replace(/[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/gi, "[email]")
    // 6+ digits, even split by spaces, dots or dashes (phone and account numbers)
    .replace(/\d(?:[ .\-]?\d){5,}/g, "[số]")
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function openTicket({ pageId, psid, reason, summary = "", status = "open" }, db = supabase) {
  try {
    const row = { page_id: String(pageId || ""), psid: String(psid), reason, summary: redactSummary(summary) };
    if (status === "in_progress") Object.assign(row, { status, taken_at: new Date().toISOString() });
    const { data, error } = await db.from(TABLE).insert(row).select("id").single();
    if (!error) return { ok: true, id: data?.id };
    if (error.code !== "23505") return { ok: false };
    const now = new Date().toISOString();
    const upd = await db.from(TABLE).update({ updated_at: now })
      .eq("page_id", row.page_id).eq("psid", row.psid).in("status", ACTIVE);
    if (upd.error) return { ok: false };
    // Admin answered an open ticket from the inbox: it is being handled now (clears the overdue badge).
    if (status === "in_progress") {
      await db.from(TABLE).update({ status, taken_at: now }).eq("page_id", row.page_id).eq("psid", row.psid).eq("status", "open");
    }
    return { ok: true, existing: true };
  } catch {
    return { ok: false };
  }
}

export async function activeTicket({ pageId, psid }, db = supabase) {
  const { data, error } = await db.from(TABLE).select("id,status").eq("page_id", String(pageId || "")).eq("psid", String(psid))
    .in("status", ACTIVE).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function touchTicket(id, db = supabase) {
  try { await db.from(TABLE).update({ updated_at: new Date().toISOString() }).eq("id", id); } catch { /* best effort */ }
}

const COLUMNS = "id,psid,reason,summary,status,created_at,taken_at,done_at";
const toView = ({ psid, ...rest }) => ({ ...rest, psidTail: String(psid || "").slice(-4) });

// Returns psidTail only: the full PSID never leaves this module toward the Admin UI.
export async function listTickets(db = supabase) {
  const open = await db.from(TABLE).select(COLUMNS).in("status", ACTIVE).order("created_at", { ascending: true });
  if (open.error) throw open.error;
  const done = await db.from(TABLE).select(COLUMNS).eq("status", "done").order("done_at", { ascending: false }).limit(20);
  if (done.error) throw done.error;
  return [...(open.data || []), ...(done.data || [])].map(toView);
}

// open -> in_progress, open|in_progress -> done. Anything else is a 400.
export async function setTicketStatus(id, status, db = supabase) {
  if (!UUID.test(String(id || ""))) return { ok: false, status: 400, error: "invalid_id" };
  const now = new Date().toISOString();
  const [patch, from] = status === "in_progress" ? [{ status, taken_at: now }, ["open"]]
    : status === "done" ? [{ status, done_at: now }, ACTIVE] : [null, null];
  if (!patch) return { ok: false, status: 400, error: "invalid_status" };
  const { data, error } = await db.from(TABLE).update({ ...patch, updated_at: now }).eq("id", id).in("status", from).select("id");
  if (error) throw error;
  return data?.length ? { ok: true } : { ok: false, status: 400, error: "invalid_transition" };
}
