// Messenger webhook (H4) for the commerce Worker. Not an api/*.js file on purpose: the Vercel Hobby build is
// capped at 12 functions, and the bot only runs on Workers.
// Webhook: GET = Meta verification; POST = signed events -> one Durable Object per sender (PSID), which
// serialises that sender's events, drops duplicate deliveries and keeps the conversation state.
import { createBillOrder } from "../../../utils/bill-order.js";
import { supabase } from "../../../utils/supabase.js";
import { emptyState, orderCreatedReply, orderFailedReply, orderStatusReplies, step } from "../../../utils/messenger/bot.js";
import { cloneConfig } from "../../../utils/clone-config.js";
import { downloadBill, sendMessage, verifySignature } from "../../../utils/messenger/meta.js";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SEEN_MIDS = 200;
const RATE_PER_MINUTE = 20;
const enabled = (env) => String(env.MESSENGER_BOT_ENABLED || "").trim() === "1";

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
  if (m?.quick_reply?.payload) return { kind: "text", text: String(m.text || ""), payload: String(m.quick_reply.payload) };
  const image = Array.isArray(m?.attachments) ? m.attachments.find((a) => a?.type === "image" && a?.payload?.url) : null;
  if (image) return { kind: "image", url: String(image.payload.url) };
  if (typeof m?.text === "string") return { kind: "text", text: m.text.slice(0, 1000) };
  if (ev?.postback?.payload) return { kind: "postback", payload: String(ev.postback.payload) };
  return null;
}

export const eventId = (ev) => String(ev?.message?.mid || ev?.postback?.mid || `${ev?.timestamp || ""}:${ev?.postback?.payload || ""}`);

export async function loadOrder(orderId, db = supabase) {
  const { data, error } = await db.from("orders").select("status,course_slug,course_title,customer_email").eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadCourses(env, db = supabase) {
  const slugs = String(env.MESSENGER_COURSE_SLUGS || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9_-]+$/.test(s));
  if (!slugs.length) return [];
  const { data, error } = await db.from("courses").select("slug,title,price,active,raw_data,delivery_mode").in("slug", slugs);
  if (error) throw error;
  return (data || [])
    .filter((c) => c.active === true && c.raw_data?.salePaused !== true && String(c.delivery_mode || "").toLowerCase() !== "telegram")
    .sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug))
    .map((c) => ({
      slug: c.slug, title: c.title, price: c.price || "",
      bankName: c.raw_data?.bankName || "", bankAccount: c.raw_data?.bankAccount || "", bankOwner: c.raw_data?.bankOwner || "",
      transferNote: c.raw_data?.transferNote || "", qrImageUrl: c.raw_data?.qrImageUrl || ""
    }));
}

// One instance per PSID. Plain class (no cloudflare:workers import) so node --test can drive it with a fake storage.
export class MessengerConversation {
  constructor(state, env, deps = {}) {
    this.storage = state.storage;
    this.env = env;
    this.deps = { fetchImpl: fetch, loadCourses, loadOrder, createBillOrder, now: Date.now, ...deps };
  }

  async fetch(request) {
    const { psid, ev } = await request.json();
    await this.handle(psid, ev);
    return new Response("ok");
  }

  async handle(psid, ev) {
    const { env, deps } = this;
    const event = toEvent(ev, env.META_APP_ID);
    if (!event) return;
    // Outbound I/O before the state read: between storage.get and storage.put nothing may await the network,
    // or another event of this sender could interleave and be overwritten.
    const courses = event.kind === "echo" ? [] : await deps.loadCourses(env);
    const now = deps.now();
    const saved = (await this.storage.get("s")) || { state: emptyState(), mids: [], hits: [] };
    const mid = eventId(ev);
    if (saved.mids.includes(mid)) return; // Meta redelivers; each mid is handled once.
    saved.mids = [...saved.mids, mid].slice(-SEEN_MIDS);
    saved.hits = saved.hits.filter((t) => now - t < 60000);
    if (event.kind !== "echo" && saved.hits.length >= RATE_PER_MINUTE) { await this.storage.put("s", saved); return; }
    if (event.kind !== "echo") saved.hits.push(now);
    const ctx = { now, courses, approveSla: String(env.MESSENGER_APPROVE_SLA || "").trim() };
    // A DO only blocks other events during storage calls, not during outbound fetch: while one bill is being
    // uploaded, a second image must not start a second order. The lock expires so a crash cannot stick it.
    if (event.kind === "image" && saved.creatingAt && now - saved.creatingAt < 120000) {
      await this.storage.put("s", saved);
      await sendMessage(psid, { text: "Mình đang xử lý bill bạn vừa gửi, bạn chờ chút nhé." }, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
      return;
    }
    const out = step(saved.state, event, ctx);
    const replies = [...out.replies];
    if (out.action?.type === "createOrder") {
      saved.creatingAt = now;
      await this.storage.put("s", saved);
      const result = await this.createOrder(psid, out.state, out.action.url, mid);
      // Re-read: events handled during the upload (e.g. "gặp người") must not be lost.
      const latest = (await this.storage.get("s")) || saved;
      latest.creatingAt = 0;
      if (result.ok) {
        latest.state = { ...latest.state, orderId: result.orderId };
        replies.push(orderCreatedReply(ctx));
      } else {
        replies.push(orderFailedReply());
      }
      await this.storage.put("s", latest);
    } else {
      saved.state = out.state;
      await this.storage.put("s", saved);
      // Read-only lookup after the state is saved, so no other event can be overwritten meanwhile.
      if (out.action?.type === "orderStatus") {
        const order = await deps.loadOrder(out.action.orderId).catch(() => null);
        replies.push(...orderStatusReplies(order, { ...ctx, lmsUrl: cloneConfig(env).lmsPublicUrl }));
      }
    }
    for (const message of replies) {
      await sendMessage(psid, message, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl: deps.fetchImpl });
    }
  }

  async createOrder(psid, state, url, mid) {
    const bill = await downloadBill(url, { fetchImpl: this.deps.fetchImpl });
    if (!bill.ok) return { ok: false, error: bill.error };
    const result = await this.deps.createBillOrder({
      gmail: state.gmail,
      course: state.course,
      billName: `messenger-${mid}`.slice(0, 120),
      billType: bill.type,
      billData: Buffer.from(bill.bytes).toString("base64")
    }, { rawExtra: { channel: "facebook", psid } });
    return result.status === 200 && result.body?.orderId ? { ok: true, orderId: result.body.orderId } : { ok: false, error: result.body?.code || "order_failed" };
  }
}
