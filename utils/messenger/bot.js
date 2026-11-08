// Messenger sales bot conversation (H4). Pure: (state, event, ctx) -> { state, replies, action }.
// The bot only collects course + Gmail + bill and creates a "Chờ duyệt" order; payment is checked by a human
// in Admin, and access is granted only by the existing approval path (approveV5Order -> /api/v5-sync).
// It never reports order or enrollment status for a typed Gmail, so typing someone else's Gmail reveals nothing.

export const PAUSE_MS = 12 * 60 * 60 * 1000;
// Owner text (08/11). Says it is an automated assistant, as Meta policy requires.
const GREETING = "Chào bạn! 👋 Mình là trợ lý tự động của Yêu học bánh. Bạn muốn đăng ký khóa học hay cần hỗ trợ gì ạ?";
const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/i;
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[^\x00-\x7F]/.test(email); // = website
const HUMAN = /(gặp|nói chuyện|chat).{0,12}(người|admin|nhân viên)|tư vấn viên/i;
const RESTART = /^(khóa|khoá) khác$|^bắt đầu lại$/i;
// "menu" only shows the menu: it keeps the conversation (draft, orders), unlike RESTART.
// MENU and GREET are matched against clean(text): no accents, punctuation or emoji.
const MENU = /^menu( a)?$/;
// Greetings: "Hi!", "Chào shop", "xin chào ạ", "shop ơi", "dạ chào bạn ơi".
const GREET = /^(da )?((hi+|hello|helo|hey|alo+|xin chao|chao)( (ban|shop|ad|admin|em|anh|chi))?|shop|ad|admin)( oi)?( a)?$/;
const MAX_ORDERS = 10;

// Ticket replies (Owner text, 08/11). Used by the DO after it knows whether the ticket was written.
export const TICKET_OK_TEXT = "Mình đã chuyển yêu cầu của bạn tới Admin. Admin sẽ hỗ trợ trực tiếp trong cuộc trò chuyện này.";
export const TICKET_FAIL_TEXT = "Hệ thống chưa ghi nhận được yêu cầu. Admin vẫn đọc được tin nhắn này trong Hộp thư của Trang và sẽ trả lời bạn.";
export const ticketReply = (ok) => ({ text: ok ? TICKET_OK_TEXT : TICKET_FAIL_TEXT });

// Draft = course, gmail, gmailOk. Placed orders live in `orders` ([{ id, slug }], absent in states saved before V2).
export const emptyState = () => ({ course: null, gmail: null, gmailOk: false, orderId: null, pendingAdmin: null, ref: null, pausedUntil: 0, greeted: false });
export const ordersOf = (s) => (Array.isArray(s?.orders) ? s.orders : s?.orderId ? [{ id: s.orderId, slug: s.course }] : []);
export const clearDraft = (s) => ({ ...s, course: null, gmail: null, gmailOk: false });
// A new order spends the draft and the campaign ref; a stale pendingAdmin must not open a ticket afterwards.
export const addOrder = (s, id, slug) => ({ ...s, orders: [...ordersOf(s), { id, slug }].slice(-MAX_ORDERS), orderId: id, pendingAdmin: null, ref: null });
// Full state from a saved one. An orderId missing from `orders` (saved before V2, or by an older build after a rollback)
// is an order already placed: add it and clear the draft, or the next bill would create it twice.
export function normalizeState(prev) {
  const s = { ...emptyState(), ...prev };
  const base = Array.isArray(prev?.orders) ? prev.orders : [];
  if (!s.orderId || base.some((o) => o.id === s.orderId)) return { ...s, orders: base };
  return clearDraft({ ...s, orders: [...base, { id: s.orderId, slug: s.course }].slice(-MAX_ORDERS) });
}

const text = (t, quick = []) => (quick.length
  ? { text: t, quick_replies: quick.map(([title, payload]) => ({ content_type: "text", title: title.slice(0, 20), payload })) }
  : { text: t });

// Main menu with tickets on (V2): three buttons.
export const MENU3 = [["Đăng ký khóa học", "BUY"], ["Xem khóa đang mở bán", "LIST"], ["Chat với Admin", "ADMIN"]];
const mainMenu = (intro) => [text(`${intro}Bạn cần mình giúp gì?`, MENU3)];
const adminBtn = (T) => (T ? ["Chat với Admin", "ADMIN"] : ["Gặp người thật", "HUMAN"]);

// Course list: quick reply per course (BUY:<slug>) + Admin button. Without tickets this is also the menu.
function listReply(ctx, intro, T = Boolean(ctx.ticketsEnabled)) {
  if (!ctx.courses.length) return [text(`${intro}Hiện chưa có khoá nào mở đăng ký qua Messenger. Bạn nhắn "gặp người" để Admin hỗ trợ nhé.`, [adminBtn(T)])];
  const quick = ctx.courses.slice(0, 12).map((c) => [c.title || c.slug, `BUY:${c.slug}`]);
  quick.push(adminBtn(T));
  return [text(`${intro}Bạn muốn đăng ký khóa nào?`, quick)];
}

const norm = (t) => String(t || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
const clean = (t) => norm(t).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ticket = (state, reason, summary) => ({
  state: { ...state, misses: 0, pendingAdmin: null },
  replies: [],
  action: { type: "openTicket", reason, ...(summary === undefined ? {} : { summary }) }
});
const faqAnswer = (f) => text(f.answer, [["Gặp Admin", "HUMAN"]]);
// Only FAQ the Owner approved are ever sent (faq.json entries start as "draft").
const approvedFaq = (ctx) => (ctx.faq || []).filter((f) => f.status === "approved");

// Campaign ref (m.me ?ref= / ad): c__<slug>[__<label>]. Slug charset = loadCourses; the label is cut at the last "__".
export function refCourse(ref, ctx) {
  const m = /^c__([a-z0-9_-]+)$/.exec(String(ref || ""));
  if (!m) return null;
  let slug = m[1];
  for (;;) {
    const c = ctx.courses.find((x) => x.slug === slug);
    if (c) { const label = m[1].length - slug.length - 2; return slug === m[1] || (label >= 1 && label <= 40) ? c : null; }
    const i = slug.lastIndexOf("__");
    if (i < 1) return null;
    slug = slug.slice(0, i);
  }
}

// Tickets on: payload/keyword handling that replaces the H4 pause. Returns null when the event is not ours.
function ticketStep(state, event, ctx, payload) {
  const isText = event.kind === "text";
  const base = { ...state, misses: 0, pendingAdmin: null };
  const faq = approvedFaq(ctx);
  if (payload === "HUMAN" || (isText && !payload && HUMAN.test(event.text || ""))) return ticket(state, "human");
  if (payload === "RESTART" || (isText && RESTART.test((event.text || "").trim()))) {
    return { state: { ...clearDraft(base), ref: null }, replies: mainMenu("") };
  }
  if (payload === "MENU" || (isText && MENU.test(clean(event.text)))) return { state: base, replies: mainMenu("") };
  if (payload === "GET_STARTED") return { state: base, replies: [text(GREETING, MENU3)] };
  if (payload === "ADMIN") {
    return { state: base, replies: [text("Bạn muốn Admin hỗ trợ việc gì?", [["Hỏi về khóa học khác", "ADMIN_COURSE"], ["Hỗ trợ vấn đề khác", "ADMIN_SUPPORT"], ["Quay lại menu", "MENU"]])] };
  }
  if (payload === "ADMIN_COURSE" || payload === "ADMIN_SUPPORT") {
    const ask = payload === "ADMIN_COURSE" ? "Bạn quan tâm khóa học nào?" : "Bạn mô tả ngắn vấn đề giúp mình nhé.";
    return { state: { ...base, pendingAdmin: payload === "ADMIN_COURSE" ? "other_course" : "support" }, replies: [text(ask, [["Bỏ qua, gặp Admin", "ADMIN_SKIP"]])] };
  }
  // The next message after the question (any text, or "Bỏ qua") opens the ticket; its text is the summary.
  if (state.pendingAdmin && (payload === "ADMIN_SKIP" || (isText && !payload))) {
    return ticket(state, state.pendingAdmin, payload === "ADMIN_SKIP" ? "" : event.text || "");
  }
  if (payload === "MENU_BOUGHT") {
    const items = ["faq-login", "faq-wrong-account", "faq-video"].map((id) => faq.find((f) => f.id === id)).filter((f) => f?.answer);
    if (!items.length) return ticket(state, "self_help");
    return { state: base, replies: items.map((f, i) => (i === items.length - 1 ? text(f.answer, [["Vẫn cần giúp", "HELP_MORE"]]) : text(f.answer))) };
  }
  if (payload === "MENU_FAQ") {
    if (!faq.length) return { state: base, replies: [text("Hiện chưa có câu hỏi thường gặp.", [["Gặp Admin", "HUMAN"]])] };
    return { state: base, replies: [text("Bạn chọn câu hỏi nhé:", faq.slice(0, 12).map((f) => [f.question, `FAQ:${f.id}`]))] };
  }
  if (payload === "HELP_MORE") return ticket(state, "self_help");
  if (payload.startsWith("FAQ:")) {
    const f = faq.find((x) => x.id === payload.slice(4));
    return f?.answer ? { state: base, replies: [faqAnswer(f)] } : ticket(state, "unclear");
  }
  return null;
}

const listOrders = (state) => ({ state, replies: [], action: { type: "orderStatus", mode: "list", orders: ordersOf(state) } });

// Tickets on, free text while there is no draft: FAQ keyword or course name, else (past orders -> their status), else ask once more, then ticket.
function freeText(state, event, ctx) {
  const q = norm(event.text);
  // A greeting is not a miss: show the menu and keep the counter at 0.
  if (GREET.test(clean(event.text))) return { state: { ...state, misses: 0 }, replies: mainMenu("") };
  const hit = approvedFaq(ctx).find((f) => (f.keywords || []).some((k) => k && q.includes(k)));
  if (hit) return hit.answer ? { state: { ...state, misses: 0 }, replies: [faqAnswer(hit)] } : ticket(state, "unclear");
  const course = ctx.courses.find((c) => (norm(c.title).length >= 4 && q.includes(norm(c.title))) || q.includes(String(c.slug).toLowerCase()));
  if (course) return buy({ ...state, misses: 0 }, ctx, course.slug);
  if (ordersOf(state).length) return listOrders({ ...state, misses: 0 });
  if ((state.misses || 0) >= 1) return ticket(state, "unclear");
  return { state: { ...state, misses: 1 }, replies: mainMenu("Mình chưa hiểu ý bạn. ") };
}

const gmailAsk = () => ({
  text: "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học) nhé.",
  quick_replies: [{ content_type: "user_email" }]
});
const retryGmailAsk = () => ({ text: "Bạn gửi lại Gmail dùng để học nhé.", quick_replies: [{ content_type: "user_email" }] });

// Generic template card for a course (G3-2). Needs ctx.commerceUrl for the "view" button.
export function courseCard(c, ctx) {
  const buttons = [];
  if (ctx.commerceUrl) buttons.push({ type: "web_url", url: `${ctx.commerceUrl.replace(/\/$/, "")}/?course=${encodeURIComponent(c.slug)}`, title: "Xem nội dung khóa" });
  buttons.push({ type: "postback", title: "Đổi khóa khác", payload: "LIST" });
  const element = { title: String(c.title || c.slug).slice(0, 80), subtitle: `Học phí: ${c.price}`.slice(0, 80), buttons };
  if (/^https:\/\//i.test(c.imageUrl || "")) element.image_url = c.imageUrl;
  return { attachment: { type: "template", payload: { template_type: "generic", elements: [element] } } };
}

// Payment details, sent only after the customer confirmed the Gmail.
function paymentInfo(c) {
  const lines = [`Khoá: ${c.title || c.slug}`];
  if (c.price) lines.push(`Học phí: ${c.price}`);
  if (c.bankAccount) lines.push(`Chuyển khoản: ${[c.bankName, c.bankAccount, c.bankOwner && `(${c.bankOwner})`].filter(Boolean).join(" ")}`);
  if (c.transferNote) lines.push(`Nội dung chuyển khoản: ${c.transferNote}`);
  const out = [text(lines.join("\n"))];
  if (c.qrImageUrl) out.push({ attachment: { type: "image", payload: { url: c.qrImageUrl, is_reusable: true } } });
  out.push(text("Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé."));
  return out;
}

const titleOf = (ctx, slug) => ctx.courses.find((c) => c.slug === slug)?.title || slug;
const confirmGmail = (gmail, title) => text(`Đăng ký khóa "${title}" bằng Gmail ${gmail}. Đúng không?`, [["Đúng", "GMAIL_OK"], ["Sai, nhập lại", "GMAIL_NO"]]);

function nextPrompt(state, ctx) {
  if (!state.course) return ctx.ticketsEnabled ? mainMenu("") : listReply(ctx, "");
  if (!state.gmail) return [gmailAsk()];
  if (!state.gmailOk) return [confirmGmail(state.gmail, titleOf(ctx, state.course))];
  return [text("Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé.")];
}

// Start (or continue) the draft for a course. Pure; the duplicate-order check is done by the caller.
export function openCourse(state, course, ctx) {
  if (state.course === course.slug) return { state, replies: nextPrompt(state, ctx) };
  return { state: { ...state, course: course.slug, gmail: null, gmailOk: false, misses: 0 }, replies: [courseCard(course, ctx), gmailAsk()] };
}

// BUY / BUY:<slug> / COURSE:<slug>. A course with an order already goes to a status lookup first (the DO decides).
function buy(state, ctx, slug) {
  const course = slug == null
    ? refCourse(state.ref, ctx) || ctx.courses.find((c) => c.featured)
    : ctx.courses.find((c) => c.slug === slug);
  if (!course) return { state, replies: listReply(ctx, slug == null ? "" : "Khóa này hiện chưa mở đăng ký. ") };
  const dup = ordersOf(state).find((o) => o.slug === course.slug);
  if (dup) return { state, replies: [], action: { type: "orderStatus", mode: "buy", slug: course.slug, orders: [dup] } };
  return openCourse(state, course, ctx);
}

// event: { kind: "text", text, payload? } | { kind: "postback", payload, ref? } | { kind: "referral", ref } | { kind: "image", url } | { kind: "echo", fromThisApp }
// The first reply in a conversation always carries the greeting, which says the bot is automated.
export function step(prev, event, ctx) {
  const out = stepInner(prev, event, ctx);
  // A customer ticket gets its reply from the DO after the insert; the greeting must still come first.
  const answersLater = out.action?.type === "openTicket" && out.action.reason !== "admin_reply";
  if (prev?.greeted || (!out.replies.length && !answersLater)) return out;
  const first = out.replies[0];
  const replies = first?.text?.startsWith(GREETING) ? out.replies : [text(GREETING), ...out.replies];
  return { ...out, state: { ...out.state, greeted: true }, replies };
}

function stepInner(prev, event, ctx) {
  const state = normalizeState(prev);
  const now = ctx.now;

  const T = Boolean(ctx.ticketsEnabled);
  if (event.kind === "echo") {
    // Tickets on: an Admin reply from the Page inbox opens an in-progress ticket (the bot stays silent while one is open).
    // Without META_APP_ID our own sends cannot be told apart from Admin replies: ignore echoes, or the bot
    // would open a ticket on its own first answer and go silent for good.
    if (T) return { state, replies: [], action: event.fromThisApp || !ctx.appIdKnown ? undefined : { type: "openTicket", reason: "admin_reply", status: "in_progress" } };
    // A human replied from the Page inbox: stay silent for 12 hours. Our own sends echo back with our app id.
    if (!event.fromThisApp) state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [] };
  }
  // Open ticket: silent for every kind (text, postback, image, referral).
  if (T && ctx.activeTicket) return { state, replies: [], action: { type: "touchTicket" } };
  if (!T && state.pausedUntil > now) return { state, replies: [] };

  const payload = event.payload || "";
  // Campaign entry (m.me ref / ad): a valid, sellable course opens the buy flow, anything else the menu.
  if (event.ref) {
    const course = refCourse(event.ref, ctx);
    state.pendingAdmin = null;
    if (!course) return { state, replies: T ? mainMenu("") : listReply(ctx, "") };
    return buy({ ...state, ref: event.ref }, ctx, course.slug);
  }
  if (T) {
    const t = ticketStep(state, event, ctx, payload);
    if (t) return t;
  }
  state.pendingAdmin = null;

  if (payload === "HUMAN" || payload === "ADMIN" || (event.kind === "text" && !payload && HUMAN.test(event.text || ""))) {
    state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [text(TICKET_OK_TEXT)] };
  }
  if (payload === "RESTART" || (event.kind === "text" && RESTART.test((event.text || "").trim()))) {
    return { state: { ...clearDraft(state), ref: null }, replies: listReply(ctx, "") };
  }
  if (payload === "MENU" || (event.kind === "text" && MENU.test(clean(event.text)))) return { state, replies: listReply(ctx, "") };
  if (payload === "GET_STARTED") {
    return { state, replies: listReply(ctx, `${GREETING}\n\n`) };
  }
  if (payload === "LIST" || payload === "MENU_COURSES") return { state, replies: listReply(ctx, "") };
  if (payload === "BUY") return buy(state, ctx, null);
  if (payload.startsWith("BUY:") || payload.startsWith("COURSE:")) return buy(state, ctx, payload.slice(payload.indexOf(":") + 1));
  if (payload === "GMAIL_OK" && state.gmail && state.course) {
    const course = ctx.courses.find((c) => c.slug === state.course);
    if (!course) return { state: clearDraft(state), replies: listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
    state.gmailOk = true;
    return { state, replies: paymentInfo(course) };
  }
  if (payload === "GMAIL_NO") {
    return { state: { ...state, gmail: null, gmailOk: false }, replies: [retryGmailAsk()] };
  }

  if (event.kind === "text") {
    const match = EMAIL.exec(event.text || "");
    if (match && state.course) {
      const gmail = match[0].toLowerCase();
      if (!isValidEmail(gmail)) return { state, replies: [text("Địa chỉ email chưa đúng. Bạn kiểm tra và gửi lại nhé.")] };
      const replies = [];
      if (!gmail.endsWith("@gmail.com")) replies.push(text("Lưu ý: trang học đăng nhập bằng Google. Nếu đây không phải tài khoản Google, bạn hãy gửi Gmail khác."));
      replies.push(confirmGmail(gmail, titleOf(ctx, state.course)));
      return { state: { ...state, gmail, gmailOk: false }, replies };
    }
    if (T && !state.course) return freeText(state, event, ctx);
    // No draft but past orders: any message reopens Meta's 24-hour window, so answer with this sender's own
    // orders (looked up by the order ids in this conversation, never by a typed Gmail).
    if (!state.course && state.orders.length) return listOrders(state);
    return { state, replies: nextPrompt(state, ctx) };
  }

  if (event.kind === "image") {
    if (!state.course && state.orders.length) return listOrders(state);
    if (!state.course || !state.gmail || !state.gmailOk) return { state, replies: nextPrompt(state, ctx) };
    return { state, replies: [], action: { type: "createOrder", url: event.url } };
  }

  return { state, replies: nextPrompt(state, ctx) };
}

export const orderCreatedReply = () => text("Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản. Khi được duyệt, mình sẽ nhắn bạn cách vào học.");
export const orderFailedReply = () => text("Mình chưa ghi nhận được bill (ảnh phải là JPG/PNG/WEBP dưới 5MB). Bạn gửi lại ảnh khác, hoặc nhắn \"gặp người\" để Admin hỗ trợ.");
export const approvedMessage = ({ courseTitle, gmail, lmsUrl }) =>
  `Đơn khoá "${courseTitle}" đã được duyệt. Bạn vào ${lmsUrl.replace(/\/$/, "")}/my-courses.html, đăng nhập Google bằng ${gmail} để học nhé.`;

export function orderStatusReplies(order, ctx) {
  if (order?.status === "Đã duyệt") {
    return [text(approvedMessage({ courseTitle: order.course_title || order.course_slug, gmail: order.customer_email, lmsUrl: ctx.lmsUrl }), [["Khoá khác", "RESTART"]])];
  }
  if (order?.status === "Chờ duyệt") {
    return [text("Đơn của bạn đang chờ Admin xác nhận. Muốn đăng ký khoá khác, bấm \"Khoá khác\".", [["Khoá khác", "RESTART"], ["Gặp người thật", "HUMAN"]])];
  }
  return [text("Đơn của bạn chưa được duyệt. Bạn bấm \"Gặp người thật\" để Admin hỗ trợ nhé.", [["Gặp người thật", "HUMAN"], ["Khoá khác", "RESTART"]])];
}

export const busyReplies = () => [text("Hệ thống đang bận, bạn thử lại sau ít phút nhé.", MENU3)];

// Customer picked a course that already has an order: pending -> say so (no new draft), approved -> the approved notice.
// Any other status returns null: the DO then opens a fresh draft.
export function buyDuplicateReplies(order, ctx) {
  if (order?.status === "Chờ duyệt") return [text("Bạn đã có đơn khóa này đang chờ Admin xác nhận.", [["Quay lại menu", "MENU"]])];
  if (order?.status === "Đã duyệt") return orderStatusReplies(order, ctx);
  return null;
}

// One message for all orders of this conversation: `<course>: <status>`; items = [{ title, order }].
export function ordersSummaryReplies(items, ctx) {
  const lines = items.map(({ title, order }) => {
    const status = order?.status === "Đã duyệt" ? `Đã duyệt - ${String(ctx.lmsUrl || "").replace(/\/$/, "")}/my-courses.html`
      : order?.status === "Chờ duyệt" ? "Chờ duyệt" : "chưa được duyệt";
    return `${title}: ${status}`;
  });
  return [text(`Các đơn của bạn:\n${lines.join("\n")}`, MENU3)];
}
