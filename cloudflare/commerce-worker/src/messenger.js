// Messenger webhook (H4) for the commerce Worker. Not an api/*.js file on purpose: the Vercel Hobby build is
// capped at 12 functions, and the bot only runs on Workers.
// Webhook: GET = Meta verification; POST = signed events -> one Durable Object per sender (PSID), which
// serialises that sender's events, drops duplicate deliveries and keeps the conversation state.
import { createBillOrder } from "../../../utils/bill-order.js";
import { supabase } from "../../../utils/supabase.js";
import { AI_MODEL_DEFAULT, AI_SCHEMA, AI_TIMEOUT_MS, aiMessages, parseAiResult } from "../../../utils/messenger/ai.js";
import { HANDOFF_TEXT, addOrder, adminIntent, aiReply, billRefusedReply, billSlowReply, busyAdminReplies, busyReplies, buyDuplicateReplies, clearDraft, dupBillReplies, emptyState, extraImageReply, hasPlaceholder, myOrdersReplies, normalizeState, openCourse, orderCreatedReply, orderFailedReply, orderSystemFailedReply, ordersOf, ordersSummaryReplies, paymentInfo, pendingOrdersReplies, refCourse, renderReplies, stepRaw, switchAsk, ticketReply } from "../../../utils/messenger/bot.js";
import faqData from "../../../utils/messenger/faq.json" with { type: "json" };
import { activeTicket, openTicket, redactSummary, touchTicket } from "../../../utils/messenger/tickets.js";
import { cloneConfig } from "../../../utils/clone-config.js";
import { downloadBill, sendMessage, sendTyping, verifySignature } from "../../../utils/messenger/meta.js";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SEEN_MIDS = 200;
const RATE_PER_MINUTE = 20;
// C4-2: one limit for download + upload + order insert. The lookups before it (up to 5 s each), the ticket (5 s) and
// the reply (8 s) come on top, so this stays well under the ~30 s the webhook's waitUntil is given in the usual case.
const BILL_TIMEOUT_MS = 15000;
// C3-2: one JSON line per failure for `wrangler tail`. Fixed event names and Meta's numbers only: never a PSID, a Gmail or message text.
const logEvent = (evt, extra = {}) => console.error(JSON.stringify({ evt, ...extra }));
const enabled = (env) => String(env.MESSENGER_BOT_ENABLED || "").trim() === "1";
const ticketsEnabled = (env) => String(env.MESSENGER_TICKETS_ENABLED || "").trim() === "1";
// G-MC1: AI answers free text only when the flag is "1" and the Workers AI binding exists.
const aiEnabled = (env) => String(env.MESSENGER_AI_ENABLED || "").trim() === "1" && Boolean(env.AI) && typeof env.AI.run === "function";
// G-LIVE-ux O1: one registration run lasts 30 minutes from the moment it opens. MESSENGER_REG_TIMEOUT_MS only shortens it
// for staging tests: a whole number in [60000, 1800000]; anything else (and Production, which never sets it) is 30 minutes.
const REG_MS = 1_800_000;
const CREATING_MS = 180_000;
export const regMs = (env) => {
  const raw = String(env?.MESSENGER_REG_TIMEOUT_MS ?? "").trim();
  return /^\d{1,7}$/.test(raw) && Number(raw) >= 60000 && Number(raw) <= REG_MS ? Number(raw) : REG_MS;
};
const runOpen = (reg) => Boolean(reg) && ["active", "creating", "handing"].includes(reg.status);
export const loadFaq = () => faqData.filter((f) => f.status === "approved");

export async function messengerWebhook(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe"
      && env.META_VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === env.META_VERIFY_TOKEN;
    return ok
      ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "Content-Type": "text/plain" } })
      : new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return new Response("Payload Too Large", { status: 413 });
  if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("Bad Request", { status: 400 }); }
  if (body?.object !== "page") return new Response("EVENT_RECEIVED", { status: 200 });
  // Bot off: Meta still gets 200 (no retries); the Owner answers from the Page inbox as before.
  if (!enabled(env) || !env.MESSENGER_CONVERSATIONS) return new Response("EVENT_RECEIVED", { status: 200 });

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    if (env.META_PAGE_ID && String(entry?.id) !== String(env.META_PAGE_ID)) continue;
    for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const psid = String(ev?.message?.is_echo ? ev?.recipient?.id : ev?.sender?.id || "");
      if (!/^\d{5,32}$/.test(psid)) continue;
      const stub = env.MESSENGER_CONVERSATIONS.get(env.MESSENGER_CONVERSATIONS.idFromName(psid));
      const work = stub.fetch("https://messenger.internal/event", { method: "POST", body: JSON.stringify({ psid, ev }) });
      // Meta wants 200 within seconds; the bill upload can take longer, so it finishes after the response.
      // C3-2: an event that failed inside the Durable Object used to vanish. The log carries no PSID and no text.
      if (ctx?.waitUntil) ctx.waitUntil(work.then((res) => { if (res && res.ok === false) logEvent("messenger_event_failed", { status: res.status }); }, (err) => { logEvent("messenger_event_failed", { error: String(err?.name || "Error").slice(0, 40) }); })); else await work;
    }
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// Keycap digits are not matched: the digit is not in this class. Text symbols (© ™) and question marks stay text (the check in toEvent).
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D|\s)+$/u;

// Meta messaging object -> bot event (null = ignore: delivery/read receipts, ...).
export function toEvent(ev, appId) {
  const m = ev?.message;
  if (m?.is_echo) return { kind: "echo", fromThisApp: Boolean(appId) && String(m.app_id || "") === String(appId) };
  if (m?.quick_reply?.payload) {
    const p = String(m.quick_reply.payload);
    // user_email quick reply: the payload is the e-mail itself; handle it as typed text.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) return { kind: "text", text: p };
    return { kind: "text", text: String(m.text || ""), payload: p };
  }
  const attachments = Array.isArray(m?.attachments) ? m.attachments : [];
  // Gate 1: a sticker is never a bill. Meta sends it as type "sticker" or as an "image" carrying sticker_id.
  if (m?.sticker_id || attachments.some((a) => a?.type === "sticker" || a?.payload?.sticker_id)) return { kind: "sticker" };
  const images = attachments.filter((a) => a?.type === "image" && a?.payload?.url);
  if (images.length) return { kind: "image", url: String(images[0].payload.url), ...(images.length > 1 ? { imageCount: images.length } : {}) };
  // Gate 1b: a message of emoji only says as much as a sticker: no AI call, no order list.
  if (typeof m?.text === "string" && EMOJI_ONLY.test(m.text) && /\p{Emoji_Presentation}|️|\p{Regional_Indicator}/u.test(m.text) && !/[❓❔]/u.test(m.text)) return { kind: "sticker" };
  if (typeof m?.text === "string") return { kind: "text", text: m.text.slice(0, 1000) };
  if (attachments.length || m?.is_unsupported) return { kind: "unsupported", type: String(attachments[0]?.type || "unknown").slice(0, 20) };
  if (ev?.postback?.payload) {
    const ref = ev.postback.referral?.ref;
    return { kind: "postback", payload: String(ev.postback.payload), ...(ref ? { ref: String(ref).slice(0, 200) } : {}) };
  }
  if (ev?.referral?.ref) return { kind: "referral", ref: String(ev.referral.ref).slice(0, 200) };
  return null;
}

export const eventId = (ev) => String(ev?.message?.mid || ev?.postback?.mid || `${ev?.timestamp || ""}:${ev?.postback?.payload || ev?.referral?.ref || ""}`);

// Timeout like the other order reads (P1-4): a stuck DB must not leave the customer without an answer.
export async function loadOrder(orderId, db = supabase, timeoutMs = 5000) {
  const { data, error } = await db.from("orders").select("status,course_slug,course_title,customer_email").eq("id", orderId).abortSignal(AbortSignal.timeout(timeoutMs)).maybeSingle();
  if (error) throw error;
  return data;
}

// This sender's live ("Chờ duyệt" / "Đã duyệt") orders for ONE course (P0-1): same scope rules as loadPendingOrders
// (psid, and pageId = this Page or no pageId), plus course_slug. A blank/odd pageId, psid or slug is an error and no query.
export async function loadCourseOrders({ psid, pageId, slug }, db = supabase, timeoutMs = 5000) {
  if (!/^\d{1,32}$/.test(String(pageId || ""))) throw new Error("page_id_missing");
  if (!/^\d{5,32}$/.test(String(psid || ""))) throw new Error("psid_invalid");
  if (!/^[a-z0-9_-]+$/.test(String(slug || ""))) throw new Error("slug_invalid");
  const { data, error } = await db.from("orders").select("id,course_slug,course_title,customer_email,status,created_at,raw_data")
    .eq("course_slug", slug).in("status", ["Chờ duyệt", "Đã duyệt"]).eq("raw_data->>psid", psid)
    .or(`raw_data->>pageId.eq.${pageId},raw_data->>pageId.is.null`)
    .order("created_at", { ascending: true }).limit(10).abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id, slug: r.course_slug, status: r.status, title: r.course_title || r.course_slug, email: r.customer_email || "", createdAt: r.created_at,
    psid: String(r.raw_data?.psid ?? ""), pageId: r.raw_data?.pageId == null ? "" : String(r.raw_data.pageId)
  }));
}

// This sender's "Chờ duyệt" orders (U6): one read, never by Gmail, name or phone. A blank or odd pageId is an error and
// no query (R3). The DB filter takes pageId = this Page or no pageId at all (not "id in the DO"): that finds old orders
// without pageId (R1) yet never an order of another Page (I7). The caller re-checks each row.
export async function loadPendingOrders({ psid, pageId }, db = supabase) {
  if (!/^\d{1,32}$/.test(String(pageId || ""))) throw new Error("page_id_missing");
  if (!/^\d{5,32}$/.test(String(psid || ""))) throw new Error("psid_invalid");
  const { data, error } = await db.from("orders").select("id,course_slug,course_title,created_at,raw_data")
    .eq("status", "Chờ duyệt").eq("raw_data->>psid", psid)
    .or(`raw_data->>pageId.eq.${pageId},raw_data->>pageId.is.null`)
    .order("created_at", { ascending: true }).limit(50).abortSignal(AbortSignal.timeout(5000));
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id, slug: r.course_slug, title: r.course_title || r.course_slug, createdAt: r.created_at,
    psid: String(r.raw_data?.psid ?? ""), pageId: r.raw_data?.pageId == null ? "" : String(r.raw_data.pageId)
  }));
}

// G-LIVE-ux F-A1: this sender's "Chờ duyệt" and "Đã duyệt" orders, same scope rules as loadPendingOrders (psid, this Page or no pageId).
export async function loadMyOrders({ psid, pageId }, db = supabase, timeoutMs = 5000) {
  if (!/^\d{1,32}$/.test(String(pageId || ""))) throw new Error("page_id_missing");
  if (!/^\d{5,32}$/.test(String(psid || ""))) throw new Error("psid_invalid");
  const { data, error } = await db.from("orders").select("id,course_slug,course_title,customer_email,status,created_at,raw_data")
    .in("status", ["Chờ duyệt", "Đã duyệt"]).eq("raw_data->>psid", psid)
    .or(`raw_data->>pageId.eq.${pageId},raw_data->>pageId.is.null`)
    .order("created_at", { ascending: true }).limit(50).abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id, slug: r.course_slug, status: r.status, title: r.course_title || r.course_slug, email: r.customer_email || "", createdAt: r.created_at,
    psid: String(r.raw_data?.psid ?? ""), pageId: r.raw_data?.pageId == null ? "" : String(r.raw_data.pageId)
  }));
}

// Courses the bot may sell: Admin switch messengerSale, price and bank account set, not paused, not Telegram.
// MESSENGER_COURSE_SLUGS (if set) only narrows the list. Featured first (one only: the first in order; the table does
// have updated_at, but picking the newest is not done, behaviour unchanged), then env order, or sort_order (empty last), then title.
const rank = (c) => (c.sort_order === null || c.sort_order === undefined || !Number.isFinite(Number(c.sort_order)) ? Infinity : Number(c.sort_order));
export async function loadCourses(env, db = supabase) {
  const slugs = String(env.MESSENGER_COURSE_SLUGS || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9_-]+$/.test(s));
  // Pre-filter in the DB (messenger flag and active); the JS filters below stay as the final check.
  let query = db.from("courses").select("slug,title,subtitle,description,price,active,raw_data,delivery_mode,image_url,sort_order").eq("active", true).eq("raw_data->>messengerSale", "true");
  if (slugs.length) query = query.in("slug", slugs);
  const { data, error } = await query;
  if (error) throw error;
  const list = (data || [])
    .filter((c) => /^[a-z0-9_-]+$/.test(String(c.slug)) && c.active === true && c.raw_data?.salePaused !== true && String(c.delivery_mode || "").toLowerCase() !== "telegram")
    .filter((c) => c.raw_data?.messengerSale === true && c.price && c.raw_data?.bankAccount)
    .sort((a, b) => (slugs.length ? slugs.indexOf(a.slug) - slugs.indexOf(b.slug) : (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || String(a.title || a.slug).localeCompare(String(b.title || b.slug), "vi")))
    .sort((a, b) => Number(b.raw_data?.messengerFeatured === true) - Number(a.raw_data?.messengerFeatured === true));
  let featuredSeen = false;
  return list.map((c) => {
    const featured = c.raw_data?.messengerFeatured === true && !featuredSeen;
    featuredSeen ||= featured;
    return {
      slug: c.slug, title: c.title, subtitle: c.subtitle || "", description: c.description || "", sortOrder: c.sort_order ?? null,
      price: c.price || "", featured, imageUrl: c.image_url || "", contentApproved: c.raw_data?.messengerContentApproved === true,
      bankName: c.raw_data?.bankName || "", bankAccount: c.raw_data?.bankAccount || "", bankOwner: c.raw_data?.bankOwner || "",
      transferNote: c.raw_data?.transferNote || "", qrImageUrl: c.raw_data?.qrImageUrl || ""
    };
  });
}

// One instance per PSID. Plain class (no cloudflare:workers import) so node --test can drive it with a fake storage.
export class MessengerConversation {
  constructor(state, env, deps = {}) {
    this.storage = state.storage;
    this.env = env;
    this.deps = { fetchImpl: fetch, loadCourses, loadOrder, createBillOrder, loadPendingOrders, loadMyOrders, loadCourseOrders, now: Date.now, loadFaq, activeTicket, openTicket, touchTicket, ...deps };
  }

  // /event: a webhook event (the only path the webhook calls). /offer: Admin sends a registration card (messenger-tickets.js).
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const body = await request.json();
    if (pathname === "/offer") {
      const result = await this.offer(String(body.psid || ""), String(body.slug || ""));
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
    }
    if (pathname !== "/event") return new Response("not found", { status: 404 });
    await this.handle(body.psid, body.ev);
    return new Response("ok");
  }

  // Run a lookup with a timeout (deps.lookupMs for tests); rejects on error or timeout.
  timed(fn, ms = this.deps.lookupMs ?? 5000) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timedOut: true })), ms); });
    return Promise.race([(async () => fn())(), limit]).finally(() => clearTimeout(timer));
  }

  async sendAll(psid, replies) {
    for (const message of replies) {
      const res = await sendMessage(psid, message, { token: this.env.META_PAGE_ACCESS_TOKEN, fetchImpl: this.deps.fetchImpl });
      if (!res?.ok) return false;
    }
    return true;
  }

  async setAlarm(at) { if (typeof this.storage.setAlarm === "function") await this.storage.setAlarm(at); }
  async clearAlarm() { if (typeof this.storage.deleteAlarm === "function") await this.storage.deleteAlarm(); }

  // G-LIVE-ux D3/D4: a ticket the DO opens is tracked in `handoff` (pending -> confirmed | local) and ends the run ("handed").
  // begin: read, change, write (no network between). While pending/local the bot is silent (A6 step 3).
  async beginHandoff(args, t1 = false) {
    if (!ticketsEnabled(this.env)) return;
    const cur = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    cur.handoff = { at: this.deps.now(), state: "pending", tries: (cur.handoff?.tries || 0) + 1, retry: args, ...(t1 ? { t1: true } : {}) };
    if (runOpen(cur.reg)) cur.reg = { ...cur.reg, status: "handing" };
    await this.storage.put("s", cur);
  }

  // existing: openTicket found a ticket already open (an Admin holds the chat): the 30-minute sentence is not sent then (O9).
  async settleHandoff(psid, ok, existing = false) {
    if (!ticketsEnabled(this.env)) return;
    const cur = await this.storage.get("s");
    if (!cur?.handoff) return;
    const now = this.deps.now();
    const h = cur.handoff;
    if (ok) {
      cur.handoff = { at: h.at, state: "confirmed", confirmedAt: now, tries: h.tries };
      if (cur.reg) cur.reg = { ...cur.reg, status: "handed" };
      await this.storage.put("s", cur);
      await this.clearAlarm();
      if (h.t1 && !existing) {
        const res = await sendMessage(psid, { text: HANDOFF_TEXT }, { token: this.env.META_PAGE_ACCESS_TOKEN, fetchImpl: this.deps.fetchImpl });
        if (!res?.ok) logEvent("messenger_send_failed", { error: String(res?.error || "").slice(0, 60) });
      }
      return;
    }
    cur.handoff = { ...h, state: "local" };
    await this.storage.put("s", cur);
    // The bot stays silent; try again in a minute (at most 30 times). Every new customer message also tries once (handle).
    if (h.tries < 30) await this.setAlarm(now + 60000); else logEvent("messenger_handoff_failed");
  }

  // openTicket for every ticket the DO writes: the handoff is marked before and after the network call.
  async ticketOut(args, { limited = false } = {}) {
    await this.beginHandoff(args);
    const call = () => Promise.resolve(this.deps.openTicket(args));
    const result = await (limited ? this.timed(call) : call()).catch(() => ({ ok: false }));
    await this.settleHandoff(args.psid, Boolean(result?.ok), Boolean(result?.existing));
    return result;
  }

  // The ticket of a handoff did not get written: try again (alarm, or the customer's next message). Silent unless it was the 30-minute handoff.
  async retryHandoff(psid) {
    const cur = await this.storage.get("s");
    const h = cur?.handoff;
    if (!h?.retry || !(h.state === "local" || (h.state === "pending" && this.deps.now() - h.at > 60000))) return;
    cur.handoff = { ...h, state: "pending", at: this.deps.now(), tries: (h.tries || 0) + 1 };
    await this.storage.put("s", cur);
    const result = await this.timed(() => this.deps.openTicket(h.retry)).catch(() => ({ ok: false }));
    await this.settleHandoff(psid, Boolean(result?.ok), Boolean(result?.existing));
  }

  // D3 steps 4-7: the run ran out (alarm, or a message after the deadline). Ticket first, then one sentence to the customer.
  // extra: { summary } replaces the default summary, { held } is a request the customer made meanwhile (kept in the ticket).
  async handoffRun(psid, extra = {}) {
    const cur = await this.storage.get("s");
    const reg = cur?.reg;
    if (!reg || reg.status === "done" || reg.status === "handed") return;
    // handing with a handoff record = a ticket write is in flight or failed (retry); handing without one = a crash between the two writes: do the handoff now.
    if (reg.status === "handing" && cur.handoff?.retry) return this.retryHandoff(psid);
    const st = normalizeState(cur.state);
    const title = st.courseTitle || st.course || "";
    const summary = reg.status === "creating"
      ? `Tạo đơn không rõ kết quả cho khóa ${title}; khách có thể đã chuyển khoản. Kiểm tra đơn và ảnh bill trong Hộp thư Trang.`
      : `Đăng ký khóa ${title} chưa hoàn tất sau 30 phút; xem tin và ảnh trong Hộp thư Trang.`;
    const base = extra.summary || summary;
    const args = { pageId: this.env.META_PAGE_ID, psid, reason: "support", summary: extra.held ? `${base} Khách cũng nhắn: ${redactSummary(extra.held.summary || "cần gặp Admin")}`.slice(0, 500) : base };
    await this.beginHandoff(args, true);
    const result = await this.timed(() => this.deps.openTicket(args)).catch(() => ({ ok: false }));
    await this.settleHandoff(psid, Boolean(result?.ok), Boolean(result?.existing));
  }

  // Durable Object alarm: the run's deadline. Never throws (Cloudflare retries a throwing alarm only 6 times).
  async alarm() {
    try {
      const s = await this.storage.get("s");
      if (!s) return;
      const now = this.deps.now();
      if (s.handoff?.retry && s.psid) {
        if (s.handoff.state === "local" || (s.handoff.state === "pending" && now - s.handoff.at > 60000)) return await this.retryHandoff(s.psid);
        // a ticket write that started a moment ago: look again after it should have finished (a crash in between would leave it pending forever)
        if (s.handoff.state === "pending") return await this.setAlarm(s.handoff.at + 61000);
      }
      const reg = s.reg;
      if (!reg || reg.status === "done" || reg.status === "handed" || !s.psid) return;
      if (now < reg.deadline) return await this.setAlarm(reg.deadline);
      const lockAt = s.creating?.at ?? s.creatingAt;
      if (reg.status === "creating" && lockAt && now - lockAt < CREATING_MS) return await this.setAlarm(lockAt + CREATING_MS);
      await this.handoffRun(s.psid);
    } catch (err) {
      logEvent("messenger_alarm_failed", { error: String(err?.name || "Error").slice(0, 40) });
      try { await this.setAlarm(this.deps.now() + 60000); } catch { /* nothing more to do */ }
    }
  }

  // Open the draft after the status lookup said "no live order": re-read, change, write, no network in between.
  // ask: a customer pick (not an Admin /offer). If another draft was opened meanwhile (I11), ask before replacing it.
  // ref: campaign ref of the pick (P1-3): stored with the draft, or kept as switchRef while the switch question is open.
  async openDraft(course, ctx, { ask = false, ref, psid } = {}) {
    const cur = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    const st = normalizeState(cur.state);
    if (ask && st.course && st.course !== course.slug) {
      cur.state = { ...st, switchRef: ref ? { slug: course.slug, ref } : null };
      await this.storage.put("s", cur);
      return switchAsk(st, course, ctx);
    }
    const r = openCourse(ref ? { ...st, ref } : st, course, ctx);
    cur.state = r.state;
    // G-LIVE-ux O1/O2: a run opens only when the course goes from none/another run's end to this one; a SWITCH inside a run keeps its deadline.
    let deadline = 0;
    if (r.opened && ticketsEnabled(this.env) && !runOpen(cur.reg)) {
      const now = this.deps.now();
      deadline = now + regMs(this.env);
      cur.reg = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, startedAt: now, deadline, status: "active", pendingTicket: null };
      if (psid) cur.psid = psid;
    }
    await this.storage.put("s", cur);
    if (deadline) await this.setAlarm(deadline);
    return r.replies;
  }

  // Read-only lookups of this sender's own orders (by order id from the conversation, never a typed Gmail).
  // Returns replies, or null when a buy request should open a fresh draft.
  async statusReplies(action, ctx) {
    const { deps, env } = this;
    const full = { ...ctx, lmsUrl: cloneConfig(env).lmsPublicUrl };
    // A lookup error is not "order not found": answer "busy" and change nothing.
    let failed = false;
    const orders = await Promise.all(action.orders.map((o) => Promise.resolve(deps.loadOrder(o.id)).catch(() => { failed = true; return null; })));
    if (failed) return busyReplies();
    if (action.mode === "buy") return buyDuplicateReplies(orders[0], full);
    const title = (slug) => ctx.courses.find((c) => c.slug === slug)?.title || slug;
    return ordersSummaryReplies(action.orders.map((o, i) => ({ title: title(o.slug), order: orders[i] })), full);
  }

  // P0-1: does this sender already hold a live order for the course? One read (timeout); null = it failed, or no usable Page ID.
  // verified = this Page, or no pageId and the id is in this conversation (R2); unverified = no pageId and not in it (R1).
  async courseOrder(psid, slug, state) {
    const pageId = String(this.env.META_PAGE_ID || "").trim();
    let rows;
    try { rows = await this.deps.loadCourseOrders({ psid, pageId, slug }); } catch { return null; }
    const ids = new Set(ordersOf(state).map((o) => o.id));
    const live = (rows || []).filter((r) => r.psid === psid && r.slug === slug && ["Chờ duyệt", "Đã duyệt"].includes(r.status));
    const verified = live.find((r) => r.pageId === pageId || (!r.pageId && ids.has(r.id))) || null;
    return { verified, unverified: !verified && live.some((r) => !r.pageId), pageId };
  }

  // Order found in the DB: put its id back into the conversation (self-heal after lost storage). Only an order of this Page
  // and only while there is room (< 10); an order without pageId is never added (R1/I7). Read, change, write, no network between.
  async healOrder(row, pageId) {
    if (!row || row.pageId !== pageId) return;
    const cur = await this.storage.get("s");
    if (!cur) return;
    const st = normalizeState(cur.state);
    const list = ordersOf(st);
    if (list.length >= 10 || list.some((o) => o.id === row.id)) return;
    cur.state = { ...st, orders: [...list, { id: row.id, slug: row.slug }] };
    await this.storage.put("s", cur);
  }

  // Replies for "there is already an order" from a courseOrder result, or null when there is none.
  async existingOrderReplies(r, ctx) {
    if (r.verified) {
      await this.healOrder(r.verified, r.pageId);
      return buyDuplicateReplies({ status: r.verified.status, course_title: r.verified.title, customer_email: r.verified.email }, { ...ctx, lmsUrl: cloneConfig(this.env).lmsPublicUrl });
    }
    if (r.unverified) return pendingOrdersReplies([], [{ title: "", createdAt: "" }]);
    return null;
  }

  // action checkCourse: nothing was changed yet. DB error / no Page ID: busy, no draft. Order exists: say so. Else open (or ask to switch).
  async checkCourseReplies(psid, action, state, ctx) {
    const course = ctx.courses.find((c) => c.slug === action.slug);
    const r = await this.courseOrder(psid, action.slug, state);
    if (!r) return busyAdminReplies();
    const existing = await this.existingOrderReplies(r, ctx);
    if (existing) return existing;
    return this.openDraft(course, ctx, { ask: !action.confirmed, ref: action.ref || undefined, psid });
  }

  // action checkPayment (GMAIL_OK): same check before the transfer details; gmailOk is set only when it is clear.
  async checkPaymentReplies(psid, state, ctx, gmail = state.gmail) {
    const course = ctx.courses.find((c) => c.slug === state.course);
    const r = await this.courseOrder(psid, state.course, state);
    if (!r) return busyAdminReplies();
    const existing = await this.existingOrderReplies(r, ctx);
    if (existing) return existing;
    const cur = await this.storage.get("s");
    const st = normalizeState(cur?.state);
    // Only the Gmail the customer confirmed: one typed during the lookup is not confirmed yet.
    if (!cur || st.course !== course.slug || !st.gmail || st.gmail !== gmail) return [];
    cur.state = { ...st, gmailOk: true };
    await this.storage.put("s", cur);
    return paymentInfo(course, true);
  }

  // Pending orders of this sender, classified (R2): verified = this Page, or no pageId and the id is in this conversation;
  // unverified (R1) = no pageId and not in this conversation. null = the read failed (DB error, timeout, no Page ID).
  async pendingView(psid, state) {
    const pageId = String(this.env.META_PAGE_ID || "").trim();
    let rows;
    try { rows = await this.deps.loadPendingOrders({ psid, pageId }); } catch { return null; }
    const ids = new Set(ordersOf(state).map((o) => o.id));
    const verified = [];
    const unverified = [];
    for (const r of rows || []) {
      if (r.psid !== psid) continue;
      if (r.pageId === pageId) verified.push(r);
      else if (!r.pageId) (ids.has(r.id) ? verified : unverified).push(r);
    }
    return { verified, unverified };
  }

  // Fill in the menu / course-list placeholders. At most one pending-orders read, none without a placeholder (B6);
  // run after the state is saved. Tickets off: no read, the 3-button menu as before.
  async finish(psid, replies, state, ctx, tickets) {
    if (!hasPlaceholder(replies)) return replies;
    const view = { pendingMenu: "hide", pendingSlugs: new Set(), doOrderIds: ordersOf(state).map((o) => o.id) };
    if (tickets) {
      const pv = await this.pendingView(psid, state);
      if (!pv) view.pendingMenu = "unknown";
      else {
        view.pendingMenu = pv.verified.length + pv.unverified.length ? "show" : "hide";
        view.pendingSlugs = new Set(pv.verified.map((r) => r.slug));
      }
    }
    return renderReplies(replies, view, ctx);
  }

  async pendingOrdersActionReplies(psid, state) {
    const pv = await this.pendingView(psid, state);
    if (!pv) return busyAdminReplies();
    const row = (r) => ({ title: r.title, createdAt: r.createdAt });
    return pendingOrdersReplies(pv.verified.map(row), pv.unverified.map(row));
  }

  // G-LIVE-ux F-A1 (T7/T8): pending and approved orders of this PSID, verified like pendingView.
  async myOrdersActionReplies(psid, state) {
    const pageId = String(this.env.META_PAGE_ID || "").trim();
    let rows;
    try { rows = await this.deps.loadMyOrders({ psid, pageId }); } catch { return busyAdminReplies(); }
    const ids = new Set(ordersOf(state).map((o) => o.id));
    const verified = [];
    const unverified = [];
    for (const r of rows || []) {
      if (r.psid !== psid || !["Chờ duyệt", "Đã duyệt"].includes(r.status)) continue;
      if (r.pageId === pageId) verified.push(r);
      else if (!r.pageId) (ids.has(r.id) ? verified : unverified).push(r);
    }
    return myOrdersReplies(verified, unverified, cloneConfig(this.env).lmsPublicUrl);
  }

  // Gate 1: an image after the order exists may be the real bill. It is not attached to the order: the Admin is told to check it.
  async extraImageReplies(psid, state) {
    const pv = await this.pendingView(psid, state);
    if (!pv) return busyAdminReplies();
    if (!pv.verified.length && !pv.unverified.length) return pendingOrdersReplies([], []);
    return [await this.extraImageTicket(psid, "Khách gửi thêm ảnh khi đang có đơn chờ duyệt. Xem ảnh trong Hộp thư Trang.")];
  }

  async extraImageTicket(psid, summary) {
    const result = await this.ticketOut({ pageId: this.env.META_PAGE_ID, psid, reason: "support", summary });
    return result?.ok ? extraImageReply() : ticketReply(false);
  }

  // "Đăng ký khóa khác": the course list without the courses this conversation has a pending or approved order for (read only).
  async listOtherReplies(state, page = 1) {
    const orders = ordersOf(state);
    let failed = false;
    const found = await Promise.all(orders.map((o) => Promise.resolve(this.deps.loadOrder(o.id)).catch(() => { failed = true; return null; })));
    if (failed) return busyReplies();
    const exclude = orders.filter((o, i) => ["Chờ duyệt", "Đã duyệt"].includes(found[i]?.status)).map((o) => o.slug);
    return [{ courses: { page, intro: "", exclude, other: true } }];
  }

  // Admin picked a course for a customer with an open ticket. Done only if the course is sellable and Meta took the messages.
  async offer(psid, slug) {
    const { env, deps } = this;
    const courses = await deps.loadCourses(env);
    const course = courses.find((c) => c.slug === slug);
    if (!course) return { status: 409, body: { ok: false, sent: false, error: "course_unavailable" } };
    const tickets = ticketsEnabled(env);
    const ctx = { now: deps.now(), courses, commerceUrl: cloneConfig(env).commercePublicUrl, ...(tickets ? { ticketsEnabled: true } : {}) };
    const saved = (await this.storage.get("s")) || { state: emptyState() };
    const dup = normalizeState(saved.state).orders.find((o) => o.slug === slug);
    let replies = dup ? await this.statusReplies({ mode: "buy", orders: [dup] }, ctx) : null;
    if (!replies) {
      // G-LIVE-ux D5: the Admin's card opens a fresh run; the handoff of the ticket the endpoint just closed must not reset it later.
      // Any old run is dropped too, so the offer always opens a fresh 30-minute run (and an old alarm finds nothing).
      const cur = await this.storage.get("s");
      // The old draft goes too: the same course offered again must still open a run (openCourse only opens on a course change).
      if (cur) { cur.handoff = null; cur.reg = null; cur.state = clearDraft(normalizeState(cur.state)); await this.storage.put("s", cur); }
      await this.clearAlarm();
      replies = await this.openDraft(course, ctx, { psid });
    }
    replies = await this.finish(psid, replies, normalizeState(saved.state), ctx, tickets);
    const sent = await this.sendAll(psid, replies);
    return sent ? { status: 200, body: { ok: true, sent: true } } : { status: 502, body: { ok: false, sent: false, error: "send_failed" } };
  }

  async handle(psid, ev) {
    const { env, deps } = this;
    const event = toEvent(ev, env.META_APP_ID);
    if (!event) return;
    // Outbound I/O before the state read: between storage.get and storage.put nothing may await the network,
    // or another event of this sender could interleave and be overwritten.
    // C1-3: a DB error or a 5 s timeout here used to end the event with no answer at all. It is now handled like an
    // unknown ticket below (P0-2): no order, the draft stays, one busy message with the Admin button per 10 minutes.
    let coursesFailed = false;
    const courses = event.kind === "echo" ? [] : await this.timed(() => deps.loadCourses(env)).catch(() => { coursesFailed = true; return []; });
    if (coursesFailed) logEvent("messenger_courses_failed");
    // Tickets on: is there an open ticket for this sender? Read before storage.get like the other network calls.
    // A DB error counts as "no ticket": the sales flow keeps working, and a new ticket would report its own failure
    // honestly. Staying silent instead could leave a customer unanswered while no Admin is handling them.
    const tickets = ticketsEnabled(env);
    // P0-2: an error or a 5 s timeout is "unknown", not "no ticket": the bot then stays out of an Admin's way (see bot.js).
    let ticket = null;
    let ticketUnknown = false;
    // G-LIVE-ux D5: taken BEFORE the ticket read, so a read that started before a handoff was confirmed cannot trigger the reset.
    const readAt = deps.now();
    if (tickets && event.kind !== "echo") ticket = await this.timed(() => deps.activeTicket({ pageId: env.META_PAGE_ID, psid })).catch(() => { ticketUnknown = true; return null; });
    if (coursesFailed) {
      // Tickets off has no P0-2 path: say the system is busy rather than nothing (state untouched).
      if (!tickets) { await this.sendAll(psid, busyAdminReplies(false)); return; }
      ticketUnknown = true;
    }
    // G-LIVE-ux D6: a ticket that could not be written is tried again at the customer's next message (the alarm also retries).
    if (tickets && event.kind !== "echo") {
      const pre = await this.storage.get("s");
      if (pre?.handoff && (pre.handoff.state === "local" || pre.handoff.state === "pending")) await this.retryHandoff(psid).catch(() => {});
    }
    const now = deps.now();
    const saved = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    const mid = eventId(ev);
    if (saved.mids.includes(mid)) return; // Meta redelivers; each mid is handled once.
    saved.mids = [...saved.mids, mid].slice(-SEEN_MIDS);
    saved.hits = saved.hits.filter((t) => now - t < 60000);
    if (event.kind !== "echo" && saved.hits.length >= RATE_PER_MINUTE) { await this.storage.put("s", saved); return; }
    if (event.kind !== "echo") saved.hits.push(now);
    if (tickets) saved.psid = psid;
    // A6 step 4: the Admin pressed "Hoàn thành" (no ticket now, the handoff was confirmed, and this read began after that): a new run.
    if (tickets && event.kind !== "echo" && !ticket && !ticketUnknown && saved.handoff?.state === "confirmed" && readAt > saved.handoff.confirmedAt) {
      const old = normalizeState(saved.state);
      saved.state = { ...emptyState(), orders: old.orders, greeted: old.greeted, ai: old.ai, lastInboundAt: old.lastInboundAt, adminSeenAt: old.adminSeenAt };
      saved.reg = null;
      saved.handoff = null;
      saved.creating = null;
      saved.creatingAt = 0;
      saved.postOrderUntil = 0;
      await this.storage.put("s", saved);
      await this.clearAlarm();
    }
    const ctx = { now, courses, commerceUrl: cloneConfig(env).commercePublicUrl, psid };
    if (tickets) Object.assign(ctx, { ticketsEnabled: true, faq: deps.loadFaq(), activeTicket: ticket, ticketUnknown, appIdKnown: Boolean(String(env.META_APP_ID || "").trim()), postOrderUntil: saved.postOrderUntil || 0 });
    if (tickets && !ticketUnknown && aiEnabled(env)) ctx.aiEnabled = true;
    // A DO only blocks other events during storage calls, not during outbound fetch: while one bill is being
    // uploaded, a second image must not start a second order. The lock lasts until createOrder settles, or 180 s so a crash cannot stick it.
    const lockAt = saved.creating?.at ?? saved.creatingAt;
    const locked = Boolean(lockAt) && now - lockAt < CREATING_MS;
    if (tickets && event.kind !== "echo") {
      // A6 step 3: an open ticket (the bot's own touchTicket path), or a handoff still being written / not written: silent for every kind.
      // A handoff confirmed after this ticket read began (retry above, or another event meanwhile): the read may be stale, stay silent.
      if (!ticket && saved.reg?.status === "handing" && !saved.handoff) { await this.storage.put("s", saved); await this.handoffRun(psid); return; } // crashed between marking and writing the handoff
      if (!ticket && (["pending", "local"].includes(saved.handoff?.state) || saved.reg?.status === "handing" || (saved.handoff?.state === "confirmed" && saved.handoff.confirmedAt >= readAt))) { await this.storage.put("s", saved); return; }
      // A6 step 5: the run ran out. Hand over now (the alarm may be late); this message is not handled as a registration.
      if (saved.reg && !ticket && !ticketUnknown && (saved.reg.status === "active" || (saved.reg.status === "creating" && !locked)) && now >= saved.reg.deadline) {
        await this.storage.put("s", saved);
        await this.handoffRun(psid);
        return;
      }
    }
    if (locked && (tickets ? !ticket && event.kind !== "echo" : event.kind === "image")) {
      // A6 step 6: another bill gets the "processing" line; a request for an Admin is held and opened right after the order; everything else is silent.
      if (tickets && event.kind !== "image" && adminIntent(event)) {
        const pending = { reason: event.payload === "HUMAN" ? "human" : "support", summary: event.payload === "HUMAN" ? "" : event.text };
        if (saved.reg) saved.reg = { ...saved.reg, pendingTicket: pending }; else saved.pendingTicket = pending; // no run (legacy draft): kept at the top
      }
      await this.storage.put("s", saved);
      if (event.kind === "image") await sendMessage(psid, { text: "Mình đang xử lý bill bạn vừa gửi, bạn chờ chút nhé." }, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
      return;
    }
    const out = stepRaw(saved.state, event, ctx);
    const replies = [...out.replies];
    let finalState = out.state;
    if (out.action?.type === "createOrder") {
      saved.creating = { at: now, mid };
      saved.creatingAt = 0;
      if (saved.reg && saved.reg.status === "active") saved.reg = { ...saved.reg, status: "creating" };
      // Keep this message's time mark even if the upload fails; the draft itself is changed only after the order.
      saved.state = { ...saved.state, lastInboundAt: out.state.lastInboundAt };
      await this.storage.put("s", saved);
      const result = await this.createOrder(psid, out.state, out.action.url, mid, courses);
      // Re-read: events handled during the upload (e.g. "gặp người") must not be lost.
      const latest = (await this.storage.get("s")) || saved;
      // After a timeout the upload may still finish and insert the order: the lock stays (it expires 180 s after it
      // was set), so an image sent again meanwhile cannot start a second order.
      if (!result.keepLock) { latest.creating = null; latest.creatingAt = 0; }
      const endAt = deps.now();
      const reg = latest.reg;
      // G-LIVE-ux O7: a failure the customer would be told to retry, after the deadline, is a handoff instead.
      const lateRetry = Boolean(tickets && reg && !result.ok && result.retryable && endAt >= reg.deadline);
      if (reg?.status === "creating") latest.reg = { ...reg, status: result.ok ? "done" : "active" };
      let alarmAt = 0;
      if (result.ok) {
        const slug = out.state.course;
        let next = addOrder(normalizeState(latest.state), result.orderId, slug);
        // The draft is spent; one the customer started during the upload (another course) stays.
        if (next.course === slug) next = clearDraft(next);
        latest.state = next;
        latest.postOrderUntil = endAt + REG_MS;
        // A ticket opened below silences the bot, so no "Đơn chờ duyệt" button then.
        replies.push(orderCreatedReply(tickets && !(event.imageCount > 1) && !(latest.reg?.pendingTicket || latest.pendingTicket)));
        finalState = latest.state;
      } else if (lateRetry) {
        // no retry text: handoffRun below
      } else if (result.handled) {
        replies.push(...result.replies); // duplicate bill / DB error: the draft stays, the lock is released
        if (latest.reg?.status === "active") alarmAt = latest.reg.deadline;
      } else {
        replies.push(orderFailedReply());
        if (latest.reg?.status === "active") alarmAt = latest.reg.deadline;
      }
      const held = latest.reg?.pendingTicket || latest.pendingTicket;
      if (held) { if (latest.reg) latest.reg = { ...latest.reg, pendingTicket: null }; latest.pendingTicket = null; }
      await this.storage.put("s", latest);
      if (result.ok && latest.reg) { if (latest.handoff?.state === "local") await this.setAlarm(endAt + 60000); else await this.clearAlarm(); } // a ticket still to be written keeps its retry alarm
      else if (alarmAt) await this.setAlarm(alarmAt);
      // Gate 1: only the first image of a message becomes the bill; the Admin is told to look at the others in the Page inbox.
      // After the put: no network between storage.get and storage.put.
      if (result.ok && event.imageCount > 1 && tickets && !held) replies.push(await this.extraImageTicket(psid, `Khách gửi ${event.imageCount} ảnh trong một tin; đơn chỉ lấy ảnh đầu. Xem các ảnh còn lại trong Hộp thư Trang.`));
      if (lateRetry) await this.handoffRun(psid, { summary: "Khách đã gửi bill trước hạn nhưng tạo đơn lỗi sau hạn; kiểm tra ảnh trong Hộp thư Trang.", held });
      // A request for an Admin that came in during the upload (A6 step 6): opened now, after the order. A ticket the createOrder path already opened covers it.
      else if (held && latest.reg?.status !== "handed" && latest.reg?.status !== "handing") replies.push(...await this.openTicketReplies(psid, { type: "openTicket", reason: held.reason, summary: held.summary }, event));
    } else {
      saved.state = out.state;
      if (out.closeRun && tickets && saved.reg) saved.reg = null; // Cancel / restart: the run ends, no ticket
      await this.storage.put("s", saved);
      if (out.closeRun && tickets) await this.clearAlarm();
      // Read-only lookup after the state is saved, so no other event can be overwritten meanwhile.
      if (out.action?.type === "orderStatus") {
        const found = await this.statusReplies(out.action, ctx);
        if (found) replies.push(...found);
        // No live order for that course: open it (U9.3/I11: if another draft was opened meanwhile, ask before replacing it).
        else replies.push(...await this.openDraft(courses.find((c) => c.slug === out.action.slug), ctx, { ask: !out.action.confirmed, ref: out.action.ref || undefined }));
      }
      if (out.action?.type === "checkCourse") replies.push(...await this.checkCourseReplies(psid, out.action, finalState, ctx));
      if (out.action?.type === "checkPayment") replies.push(...await this.checkPaymentReplies(psid, finalState, ctx, out.action.gmail));
      if (out.action?.type === "pendingOrders") replies.push(...await this.pendingOrdersActionReplies(psid, finalState));
      if (out.action?.type === "myOrders") replies.push(...await this.myOrdersActionReplies(psid, finalState));
      if (out.action?.type === "extraImage") replies.push(...await this.extraImageReplies(psid, finalState));
      if (out.action?.type === "listOther") replies.push(...await this.listOtherReplies(finalState, out.action.page));
      // Ticket writes also run after the state is saved. Admin replies (echo) are recorded without answering the customer.
      if (out.action?.type === "touchTicket" && ticket) await this.timed(() => deps.touchTicket(ticket.id)).catch(() => {}); // a stuck DB must not hang the event
      if (out.action?.type === "openTicket") replies.push(...await this.openTicketReplies(psid, out.action, event));
      if (out.action?.type === "ai") {
        const r = aiReply(finalState, await this.runAi(out.action.text, ctx), ctx, out.action.match);
        if (r.filtered) console.log(JSON.stringify({ evt: "messenger_ai_filtered" })); // an answer was refused; never the text
        // Re-read after the AI wait (up to 8 s). Another customer event or an Admin reply meanwhile makes this answer
        // stale: send nothing and open no ticket, so a draft, an Admin request or an Admin chat is never overridden.
        // The daily AI count was already saved before the call; only `misses` is written here.
        const cur = (await this.storage.get("s")) || saved;
        const st = normalizeState(cur.state);
        const stale = st.lastInboundAt !== finalState.lastInboundAt || st.adminSeenAt !== finalState.adminSeenAt || st.course !== finalState.course || st.pendingAdmin !== finalState.pendingAdmin;
        if (stale) finalState = st; // a first-message greeting already in `replies` is still sent (Meta: say it is a bot)
        else {
          replies.push(...r.replies);
          cur.state = { ...st, misses: r.state.misses };
          await this.storage.put("s", cur);
          finalState = cur.state;
          if (r.action?.type === "openTicket") replies.push(...await this.openTicketReplies(psid, r.action, event));
          if (r.action?.type === "pendingOrders") replies.push(...await this.pendingOrdersActionReplies(psid, finalState));
          if (r.action?.type === "myOrders") replies.push(...await this.myOrdersActionReplies(psid, finalState));
        }
      }
    }
    for (const message of await this.finish(psid, replies, finalState, ctx, tickets)) {
      const res = await sendMessage(psid, message, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
      // C3-2: a reply Meta did not take (token revoked, window, timeout) was invisible. Meta's numbers only.
      if (!res?.ok) logEvent("messenger_send_failed", { error: String(res?.error || "").slice(0, 60) });
    }
  }

  // Opens the ticket after the state is saved; returns the reply for the customer (none for an Admin echo).
  async openTicketReplies(psid, action, event) {
    const { env, deps } = this;
    const { reason, status } = action;
    const summary = redactSummary(action.summary ?? (event.kind === "text" ? event.text : ""));
    const result = await this.ticketOut({ pageId: env.META_PAGE_ID, psid, reason, summary, status });
    return reason !== "admin_reply" ? [ticketReply(Boolean(result?.ok))] : [];
  }

  // G-MC1: ask Workers AI; any error, timeout or bad JSON is null (the caller falls back). Logs no customer text, PSID or answer.
  async runAi(text, ctx) {
    const { env, deps } = this;
    const t0 = Date.now();
    let timer;
    let ai = null;
    try {
      if (deps.runAi) ai = await deps.runAi(text, ctx);
      else {
        await sendTyping(ctx.psid, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
        const call = env.AI.run(env.MESSENGER_AI_MODEL || AI_MODEL_DEFAULT, {
          messages: aiMessages(text, ctx.courses, ctx.faq),
          max_tokens: 300, temperature: 0, chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_schema", json_schema: AI_SCHEMA }
        });
        const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), deps.aiTimeoutMs ?? AI_TIMEOUT_MS); });
        ai = parseAiResult(await Promise.race([call, limit]));
      }
    } catch { ai = null; } finally { clearTimeout(timer); }
    console.log(JSON.stringify({ evt: "messenger_ai", route: ai?.route ?? null, ms: Date.now() - t0, ok: Boolean(ai) }));
    return ai;
  }

  // C4-2: the order may or may not exist by now (the upload keeps running). The customer is told an Admin will check
  // and not to pay again; a bill sent again later meets the duplicate check in createOrder (no second order).
  async billTimedOut(psid, state, T) {
    logEvent("messenger_bill_timeout");
    if (!T) return { ok: false, handled: true, keepLock: true, replies: [billSlowReply(false)] };
    const opened = await this.ticketOut({ pageId: this.env.META_PAGE_ID, psid, reason: "support", summary: `Tạo đơn quá thời gian cho khóa ${state.course}; khách có thể đã chuyển khoản. Kiểm tra đơn và ảnh bill trong Hộp thư Trang.` }, { limited: true });
    return { ok: false, handled: true, keepLock: true, replies: [billSlowReply(Boolean(opened?.ok))] };
  }

  async createOrder(psid, state, url, mid, courses = []) {
    // P0-1 layer (b), before anything is uploaded or created (also with tickets off): a course that already has an order
    // gets no second one; the Admin checks the bill instead. A failed read (or no Page ID) creates nothing either.
    const T = ticketsEnabled(this.env);
    const dup = await this.courseOrder(psid, state.course, state);
    if (!dup) return { ok: false, handled: true, retryable: true, replies: busyAdminReplies(T) };
    if (dup.verified || dup.unverified) {
      if (T) await this.ticketOut({ pageId: this.env.META_PAGE_ID, psid, reason: "support", summary: `Bill gửi lại cho khóa đã có đơn: ${state.course}` });
      return { ok: false, handled: true, replies: dupBillReplies(T) };
    }
    let result;
    try {
      // C4-2: the image upload and the DB writes have no timeout of their own. A hang used to leave a customer who
      // may already have paid with no answer, no ticket and no log.
      const done = await this.timed(async () => {
        const bill = await downloadBill(url, { fetchImpl: this.deps.fetchImpl });
        if (bill.error === "download_failed") return { early: { ok: false, handled: true, retryable: true, replies: [orderSystemFailedReply()] } }; // Meta CDN, not the customer's image
        if (!bill.ok) return { early: { ok: false, error: bill.error } };
        return { result: await this.deps.createBillOrder({
          gmail: state.gmail,
          course: state.course,
          billName: `messenger-${mid}`.slice(0, 120),
          billType: bill.type,
          billData: Buffer.from(bill.bytes).toString("base64")
        }, { rawExtra: { channel: "facebook", psid, ...(String(this.env.META_PAGE_ID || "").trim() ? { pageId: String(this.env.META_PAGE_ID).trim() } : {}), ...(state.ref && refCourse(state.ref, { courses })?.slug === state.course ? { ref: state.ref } : {}) } }) };
      }, this.deps.billMs ?? BILL_TIMEOUT_MS);
      if (done.early) return done.early;
      result = done.result;
    } catch (err) {
      if (err?.timedOut) return this.billTimedOut(psid, state, T);
      return { ok: false, handled: true, retryable: true, replies: [orderSystemFailedReply()] }; // the caller releases the lock; the draft stays for a retry
    }
    if (result.status === 200 && result.body?.orderId) return { ok: true, orderId: result.body.orderId };
    // Gate 1: the image was fine but the course refused the order (paused, closed): the customer may already have paid, so an Admin must know.
    if (result.status === 404 || result.status === 409) {
      if (!T) return { ok: false, handled: true, replies: [billRefusedReply(false)] };
      const opened = await this.ticketOut({ pageId: this.env.META_PAGE_ID, psid, reason: "support", summary: `Khách gửi bill nhưng khóa ${state.course} không nhận đăng ký (${String(result.body?.code || result.status).slice(0, 40)}). Xem ảnh trong Hộp thư Trang.` });
      return { ok: false, handled: true, replies: [billRefusedReply(Boolean(opened?.ok))] };
    }
    if (result.status >= 500) return { ok: false, handled: true, retryable: true, replies: [orderSystemFailedReply()] };
    return { ok: false, error: result.body?.code || "order_failed", retryable: true };
  }
}
