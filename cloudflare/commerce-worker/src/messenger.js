// Messenger webhook (H4) for the commerce Worker. Not an api/*.js file on purpose: the Vercel Hobby build is
// capped at 12 functions, and the bot only runs on Workers.
// Webhook: GET = Meta verification; POST = signed events -> one Durable Object per sender (PSID), which
// serialises that sender's events, drops duplicate deliveries and keeps the conversation state.
import { createBillOrder } from "../../../utils/bill-order.js";
import { supabase } from "../../../utils/supabase.js";
import { addOrder, busyAdminReplies, busyReplies, buyDuplicateReplies, clearDraft, emptyState, hasPlaceholder, normalizeState, openCourse, orderCreatedReply, orderFailedReply, ordersOf, ordersSummaryReplies, pendingOrdersReplies, refCourse, renderReplies, stepRaw, ticketReply } from "../../../utils/messenger/bot.js";
import faqData from "../../../utils/messenger/faq.json" with { type: "json" };
import { activeTicket, openTicket, redactSummary, touchTicket } from "../../../utils/messenger/tickets.js";
import { cloneConfig } from "../../../utils/clone-config.js";
import { downloadBill, sendMessage, verifySignature } from "../../../utils/messenger/meta.js";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SEEN_MIDS = 200;
const RATE_PER_MINUTE = 20;
const enabled = (env) => String(env.MESSENGER_BOT_ENABLED || "").trim() === "1";
const ticketsEnabled = (env) => String(env.MESSENGER_TICKETS_ENABLED || "").trim() === "1";
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
      if (ctx?.waitUntil) ctx.waitUntil(work.catch(() => {})); else await work;
    }
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// Meta messaging object -> bot event (null = ignore: delivery/read receipts, stickers, files, ...).
export function toEvent(ev, appId) {
  const m = ev?.message;
  if (m?.is_echo) return { kind: "echo", fromThisApp: Boolean(appId) && String(m.app_id || "") === String(appId) };
  if (m?.quick_reply?.payload) {
    const p = String(m.quick_reply.payload);
    // user_email quick reply: the payload is the e-mail itself; handle it as typed text.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) return { kind: "text", text: p };
    return { kind: "text", text: String(m.text || ""), payload: p };
  }
  const image = Array.isArray(m?.attachments) ? m.attachments.find((a) => a?.type === "image" && a?.payload?.url) : null;
  if (image) return { kind: "image", url: String(image.payload.url) };
  if (typeof m?.text === "string") return { kind: "text", text: m.text.slice(0, 1000) };
  if (ev?.postback?.payload) {
    const ref = ev.postback.referral?.ref;
    return { kind: "postback", payload: String(ev.postback.payload), ...(ref ? { ref: String(ref).slice(0, 200) } : {}) };
  }
  if (ev?.referral?.ref) return { kind: "referral", ref: String(ev.referral.ref).slice(0, 200) };
  return null;
}

export const eventId = (ev) => String(ev?.message?.mid || ev?.postback?.mid || `${ev?.timestamp || ""}:${ev?.postback?.payload || ev?.referral?.ref || ""}`);

export async function loadOrder(orderId, db = supabase) {
  const { data, error } = await db.from("orders").select("status,course_slug,course_title,customer_email").eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data;
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
      price: c.price || "", featured, imageUrl: c.image_url || "",
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
    this.deps = { fetchImpl: fetch, loadCourses, loadOrder, createBillOrder, loadPendingOrders, now: Date.now, loadFaq, activeTicket, openTicket, touchTicket, ...deps };
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

  async sendAll(psid, replies) {
    for (const message of replies) {
      const res = await sendMessage(psid, message, { token: this.env.META_PAGE_ACCESS_TOKEN, fetchImpl: this.deps.fetchImpl });
      if (!res?.ok) return false;
    }
    return true;
  }

  // Open the draft after the status lookup said "no live order": re-read, change, write, no network in between.
  async openDraft(course, ctx) {
    const cur = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    const r = openCourse(normalizeState(cur.state), course, ctx);
    cur.state = r.state;
    await this.storage.put("s", cur);
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
    if (!replies) replies = await this.openDraft(course, ctx);
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
    const courses = event.kind === "echo" ? [] : await deps.loadCourses(env);
    // Tickets on: is there an open ticket for this sender? Read before storage.get like the other network calls.
    // A DB error counts as "no ticket": the sales flow keeps working, and a new ticket would report its own failure
    // honestly. Staying silent instead could leave a customer unanswered while no Admin is handling them.
    const tickets = ticketsEnabled(env);
    let ticket = null;
    if (tickets && event.kind !== "echo") ticket = await deps.activeTicket({ pageId: env.META_PAGE_ID, psid }).catch(() => null);
    const now = deps.now();
    const saved = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    const mid = eventId(ev);
    if (saved.mids.includes(mid)) return; // Meta redelivers; each mid is handled once.
    saved.mids = [...saved.mids, mid].slice(-SEEN_MIDS);
    saved.hits = saved.hits.filter((t) => now - t < 60000);
    if (event.kind !== "echo" && saved.hits.length >= RATE_PER_MINUTE) { await this.storage.put("s", saved); return; }
    if (event.kind !== "echo") saved.hits.push(now);
    const ctx = { now, courses, commerceUrl: cloneConfig(env).commercePublicUrl };
    if (tickets) Object.assign(ctx, { ticketsEnabled: true, faq: deps.loadFaq(), activeTicket: ticket, appIdKnown: Boolean(String(env.META_APP_ID || "").trim()) });
    // A DO only blocks other events during storage calls, not during outbound fetch: while one bill is being
    // uploaded, a second image must not start a second order. The lock expires so a crash cannot stick it.
    if (event.kind === "image" && saved.creatingAt && now - saved.creatingAt < 120000) {
      await this.storage.put("s", saved);
      await sendMessage(psid, { text: "Mình đang xử lý bill bạn vừa gửi, bạn chờ chút nhé." }, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
      return;
    }
    const out = stepRaw(saved.state, event, ctx);
    const replies = [...out.replies];
    let finalState = out.state;
    if (out.action?.type === "createOrder") {
      saved.creatingAt = now;
      await this.storage.put("s", saved);
      const result = await this.createOrder(psid, out.state, out.action.url, mid, courses);
      // Re-read: events handled during the upload (e.g. "gặp người") must not be lost.
      const latest = (await this.storage.get("s")) || saved;
      latest.creatingAt = 0;
      if (result.ok) {
        const slug = out.state.course;
        let next = addOrder(normalizeState(latest.state), result.orderId, slug);
        // The draft is spent; one the customer started during the upload (another course) stays.
        if (next.course === slug) next = clearDraft(next);
        latest.state = next;
        replies.push(orderCreatedReply(tickets));
        finalState = latest.state;
      } else {
        replies.push(orderFailedReply());
      }
      await this.storage.put("s", latest);
    } else {
      saved.state = out.state;
      await this.storage.put("s", saved);
      // Read-only lookup after the state is saved, so no other event can be overwritten meanwhile.
      if (out.action?.type === "orderStatus") {
        const found = await this.statusReplies(out.action, ctx);
        if (found) replies.push(...found);
        else replies.push(...await this.openDraft(courses.find((c) => c.slug === out.action.slug), ctx));
      }
      if (out.action?.type === "pendingOrders") replies.push(...await this.pendingOrdersActionReplies(psid, finalState));
      if (out.action?.type === "listOther") replies.push(...await this.listOtherReplies(finalState, out.action.page));
      // Ticket writes also run after the state is saved. Admin replies (echo) are recorded without answering the customer.
      if (out.action?.type === "touchTicket" && ticket) await deps.touchTicket(ticket.id);
      if (out.action?.type === "openTicket") {
        const { reason, status } = out.action;
        const summary = redactSummary(out.action.summary ?? (event.kind === "text" ? event.text : ""));
        const result = await Promise.resolve(deps.openTicket({ pageId: env.META_PAGE_ID, psid, reason, summary, status })).catch(() => ({ ok: false }));
        if (reason !== "admin_reply") replies.push(ticketReply(Boolean(result?.ok)));
      }
    }
    for (const message of await this.finish(psid, replies, finalState, ctx, tickets)) {
      await sendMessage(psid, message, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
    }
  }

  async createOrder(psid, state, url, mid, courses = []) {
    const bill = await downloadBill(url, { fetchImpl: this.deps.fetchImpl });
    if (!bill.ok) return { ok: false, error: bill.error };
    const result = await this.deps.createBillOrder({
      gmail: state.gmail,
      course: state.course,
      billName: `messenger-${mid}`.slice(0, 120),
      billType: bill.type,
      billData: Buffer.from(bill.bytes).toString("base64")
    }, { rawExtra: { channel: "facebook", psid, ...(String(this.env.META_PAGE_ID || "").trim() ? { pageId: String(this.env.META_PAGE_ID).trim() } : {}), ...(state.ref && refCourse(state.ref, { courses })?.slug === state.course ? { ref: state.ref } : {}) } });
    return result.status === 200 && result.body?.orderId ? { ok: true, orderId: result.body.orderId } : { ok: false, error: result.body?.code || "order_failed" };
  }
}
