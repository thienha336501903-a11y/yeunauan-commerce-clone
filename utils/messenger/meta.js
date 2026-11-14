// Meta Messenger Platform I/O for the Messenger sales bot (H4): webhook signature, Send API, bill download.
// Secrets come from the Worker env (wrangler secret put); nothing here logs a token, a body or a Gmail.

const GRAPH = "https://graph.facebook.com/v23.0";
export const MAX_BILL_BYTES = 5 * 1024 * 1024; // same ceiling as the website checkout (utils/bill-order.js)
const BILL_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Messenger attachment URLs are served by Meta's CDN; anything else is refused (no SSRF through the bot).
const BILL_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com)$/i;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). Compared in constant time.
export async function verifySignature(rawBytes, header, appSecret) {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, rawBytes));
  const got = header.slice(7).toLowerCase();
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Token goes in the Authorization header, never the URL.
export async function sendMessage(psid, message, { token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { ok: false, error: "missing_page_token" };
  try {
    const res = await fetchImpl(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    // G2: Meta's message_id is the proof the message was accepted.
    if (res.ok) return { ok: true, messageId: typeof body?.message_id === "string" ? body.message_id : null };
    // Code 10 / subcode 2018278 = outside the 24-hour window (notify.js classifies the codes).
    return { ok: false, error: `graph_${res.status}_${body?.error?.code || ""}_${body?.error?.error_subcode || ""}`, code: body?.error?.code ?? null, subcode: body?.error?.error_subcode ?? null, httpStatus: res.status };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "graph_timeout" : "graph_network" };
  }
}

// Admin tickets (14/11): the customer's Facebook name, so the Admin can find the chat in the Page inbox (Meta has no deep link).
// "" on any failure: no permission (Meta's Business Asset User Profile Access), phone-only account, private name, timeout.
export async function fetchProfileName(psid, { token, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!token || !/^\d{5,32}$/.test(String(psid || ""))) return "";
  try {
    const res = await fetchImpl(`${GRAPH}/${psid}?fields=first_name,last_name`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    const body = await res.json().catch(() => ({}));
    return [body?.first_name, body?.last_name].filter((v) => typeof v === "string" && v.trim()).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return "";
  }
}

// G3: "typing..." while the AI answers. Best effort: a failure here never affects the reply.
export async function sendTyping(psid, { token, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  if (!token) return;
  try {
    await fetchImpl(`${GRAPH}/me/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" }), signal: AbortSignal.timeout(timeoutMs) });
  } catch { /* best effort */ }
}

export async function downloadBill(url, { fetchImpl = fetch } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: "bad_url" }; }
  if (parsed.protocol !== "https:" || !BILL_HOST.test(parsed.hostname)) return { ok: false, error: "host_not_allowed" };
  let res;
  try {
    res = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(15000) });
  } catch { return { ok: false, error: "download_failed" }; }
  // fbsbx links may redirect; the final host must still be Meta's.
  if (res.url && !BILL_HOST.test(new URL(res.url).hostname)) return { ok: false, error: "host_not_allowed" };
  if (!res.ok) return { ok: false, error: "download_failed" };
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!BILL_TYPES.has(type)) return { ok: false, error: "type_not_allowed" };
  if (Number(res.headers.get("content-length")) > MAX_BILL_BYTES) return { ok: false, error: "too_large" };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.byteLength) return { ok: false, error: "empty" };
  if (bytes.byteLength > MAX_BILL_BYTES) return { ok: false, error: "too_large" };
  return { ok: true, type, bytes };
}
