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
    // Owner 14/11: an Admin reply from the inbox (admin_reply echo) counts as "seen" for the "Có tin mới" badge.
    const scope = (q) => q.eq("page_id", row.page_id).eq("psid", row.psid).in("status", ACTIVE);
    let upd = await scope(db.from(TABLE).update(reason === "admin_reply" ? { updated_at: now, seen_at: now } : { updated_at: now }));
    if (upd.error && reason === "admin_reply" && isMissingColumn(upd.error)) upd = await scope(db.from(TABLE).update({ updated_at: now }));
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

// Migration 20261114100000 adds customer_msg_at / seen_at. Until a database has it (Production before its gate), every
// read and write here falls back to the old columns instead of failing: Postgres 42703 / PostgREST PGRST204 = unknown column.
const isMissingColumn = (error) => ["42703", "PGRST204"].includes(String(error?.code || ""));

// Called by the DO only for customer events while a ticket is open (echoes and duplicate deliveries never get here).
// Only a still-open ticket is marked: a message racing the Admin's "Hoàn thành" does not flag a closed ticket.
export async function touchTicket(id, db = supabase) {
  try {
    const now = new Date().toISOString();
    const { error } = await db.from(TABLE).update({ updated_at: now, customer_msg_at: now }).eq("id", id).in("status", ACTIVE);
    if (error && isMissingColumn(error)) await db.from(TABLE).update({ updated_at: now }).eq("id", id).in("status", ACTIVE);
  } catch { /* best effort */ }
}

// "Đã xem" from the Admin page: open tickets only. A database without the columns answers 409 (feature not migrated).
// seenAsOf = the customer_msg_at the Admin was looking at: a message that arrived after the page loaded stays "new".
export async function markTicketSeen(id, db = supabase, seenAsOf) {
  if (!UUID.test(String(id || ""))) return { ok: false, status: 400, error: "invalid_id" };
  const asOf = Date.parse(String(seenAsOf || ""));
  const seenAt = Number.isFinite(asOf) && asOf <= Date.now() ? new Date(asOf).toISOString() : new Date().toISOString();
  const { data, error } = await db.from(TABLE).update({ seen_at: seenAt }).eq("id", id).in("status", ACTIVE).select("id");
  if (error && isMissingColumn(error)) return { ok: false, status: 409, error: "not_migrated" };
  if (error) throw error;
  return data?.length ? { ok: true } : { ok: false, status: 400, error: "invalid_transition" };
}

// updated_at = last activity on the ticket (customer message via touchTicket, Admin reply echo, status change): the Admin finds the chat by that time.
// customer_msg_at / seen_at: the "Có tin mới" badge (customer wrote after the Admin last saw or answered).
const COLUMNS_BASE = "id,psid,reason,summary,status,created_at,updated_at,taken_at,done_at";
const COLUMNS = `${COLUMNS_BASE},customer_msg_at,seen_at`;
async function selectTickets(db, build) {
  const r = await build(db.from(TABLE).select(COLUMNS));
  return r.error && isMissingColumn(r.error) ? build(db.from(TABLE).select(COLUMNS_BASE)) : r;
}
export const toView = ({ psid, ...rest }) => ({ ...rest, psidTail: String(psid || "").slice(-4) });

// Open tickets only (the page's 30-second check).
export async function listActiveTicketRows(db = supabase) {
  const open = await selectTickets(db, (q) => q.in("status", ACTIVE).order("created_at", { ascending: true }));
  if (open.error) throw open.error;
  return open.data || [];
}

// Rows with the full PSID, for server-side use only (the endpoint looks up names, then maps through toView).
export async function listTicketRows(db = supabase) {
  const open = await selectTickets(db, (q) => q.in("status", ACTIVE).order("created_at", { ascending: true }));
  if (open.error) throw open.error;
  const done = await selectTickets(db, (q) => q.eq("status", "done").order("done_at", { ascending: false }).limit(20));
  if (done.error) throw done.error;
  return [...(open.data || []), ...(done.data || [])];
}

// Returns psidTail only: the full PSID never leaves this module toward the Admin UI.
export async function listTickets(db = supabase) {
  return (await listTicketRows(db)).map(toView);
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

export const isTicketId = (id) => UUID.test(String(id || ""));

// One active ticket by id (psid stays server-side: used to reach the sender's conversation, never sent to the Admin UI).
export async function getActiveTicket(id, db = supabase) {
  if (!isTicketId(id)) return null;
  const { data, error } = await db.from(TABLE).select("id,psid,page_id,status").eq("id", id).in("status", ACTIVE).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}
