// Messenger sales bot conversation (H4). Pure: (state, event, ctx) -> { state, replies, action }.
// The bot only collects course + Gmail + bill and creates a "Chờ duyệt" order; payment is checked by a human
// in Admin, and access is granted only by the existing approval path (approveV5Order -> /api/v5-sync).
// It never reports order or enrollment status for a typed Gmail, so typing someone else's Gmail reveals nothing.

import { AI_DAILY_CAP, badAnswer } from "./ai.js";

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
// Typed form of the "Đơn chờ duyệt" button, matched against clean(text).
const PENDING_TEXT = /^(don cua toi|don hang|kiem tra don|xem don)$/;

// Ticket replies (Owner text, 08/11). Used by the DO after it knows whether the ticket was written.
export const TICKET_OK_TEXT = "Mình đã chuyển yêu cầu của bạn tới Admin. Admin sẽ hỗ trợ trực tiếp trong cuộc trò chuyện này.";
export const TICKET_FAIL_TEXT = "Hệ thống chưa ghi nhận được yêu cầu. Admin vẫn đọc được tin nhắn này trong Hộp thư của Trang và sẽ trả lời bạn.";
export const ticketReply = (ok) => ({ text: ok ? TICKET_OK_TEXT : TICKET_FAIL_TEXT });

// Draft = course, gmail, gmailOk. Placed orders live in `orders` ([{ id, slug }], absent in states saved before V2).
// draftMisses (U4): consecutive non-email texts while a draft is open.
export const emptyState = () => ({ course: null, gmail: null, gmailOk: false, orderId: null, pendingAdmin: null, ref: null, pausedUntil: 0, greeted: false, draftMisses: 0, lastInboundAt: 0, adminSeenAt: 0, ticketBusyAt: 0, switchRef: null });
export const ordersOf = (s) => (Array.isArray(s?.orders) ? s.orders : s?.orderId ? [{ id: s.orderId, slug: s.course }] : []);
export const clearDraft = (s) => ({ ...s, course: null, courseTitle: null, courseTitleFor: null, gmail: null, gmailOk: false, draftMisses: 0, switchRef: null });
// A new order spends the draft and the campaign ref; a stale pendingAdmin must not open a ticket afterwards.
export const addOrder = (s, id, slug) => ({ ...s, orders: [...ordersOf(s), { id, slug }].slice(-MAX_ORDERS), orderId: id, pendingAdmin: null, ref: null, switchRef: null });
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

// Main menu with tickets on (V2): three buttons, plus "Đơn chờ duyệt" for a customer with a pending order (U6b).
export const MENU3 = [["Đăng ký khóa học", "BUY"], ["Xem khóa đang mở bán", "LIST"], ["Chat với Admin", "ADMIN"]];
const PENDING_BTN = ["Đơn chờ duyệt", "PENDING_ORDERS"];
const DRAFT_BTNS = [["Tiếp tục đăng ký", "CONTINUE_DRAFT"], ["Hủy đăng ký", "CANCEL_DRAFT"]];
// The one builder of the main menu (B6). pendingMenu: "show" | "hide" | "unknown" (DB error: show only if the DO already holds an order id, B5).
export function menuButtons(pendingMenu, hasOrdersInDo, extra = [], resume = false) {
  const show = pendingMenu === "show" || (pendingMenu === "unknown" && Boolean(hasOrdersInDo));
  // U8 (back after a long gap with a draft): continue / see courses / [pending orders] / Admin.
  if (resume) return [DRAFT_BTNS[0], ["Xem các khóa học", "LIST"], ...(show ? [PENDING_BTN] : []), MENU3[2]];
  return [...(show ? [MENU3[0], MENU3[1], PENDING_BTN, MENU3[2]] : MENU3), ...extra];
}
// Every message with the main menu is a placeholder; renderReplies fills it in once the DO knows pendingMenu.
// ask:false = the intro is the whole text (greeting, busy, orders summary).
const mainMenu = (intro, extra = [], ask = true) => [{ menu: { intro, extra, ask } }];
const draftExtra = (state) => (state.course ? DRAFT_BTNS : []);
const adminBtn = (T) => (T ? ["Chat với Admin", "ADMIN"] : ["Gặp người thật", "HUMAN"]);

// Course list. Tickets on: placeholder, rendered as a carousel (U7). Off: quick reply per course (BUY:<slug>) + Admin button, also the menu.
function listReply(ctx, intro, T = Boolean(ctx.ticketsEnabled), page = 1) {
  if (T) return [{ courses: { page, intro, exclude: [] } }];
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
  const extra = draftExtra(state);
  if (payload === "HUMAN" || (isText && !payload && HUMAN.test(event.text || ""))) return ticket(state, "human");
  if (payload === "RESTART" || (isText && RESTART.test((event.text || "").trim()))) {
    return { state: { ...clearDraft(base), ref: null }, replies: mainMenu("") };
  }
  // U3: with a draft the menu also offers "Tiếp tục đăng ký" / "Hủy đăng ký"; the draft is kept.
  if (payload === "MENU" || (isText && MENU.test(clean(event.text)))) return { state: base, replies: mainMenu("", extra) };
  if (payload === "GET_STARTED") return { state: base, replies: mainMenu(GREETING, extra, false) };
  // U8.3/U8.8: back to the step the draft stopped at (the transfer details again at the bill step); a course no longer sold ends the draft.
  if (payload === "CONTINUE_DRAFT") {
    if (state.course && !ctx.courses.some((c) => c.slug === state.course)) return soldOut(base, ctx);
    return { state: { ...base, switchRef: null }, replies: state.course && state.gmailOk ? paymentInfo(ctx.courses.find((c) => c.slug === state.course), true) : nextPrompt(state, ctx) };
  }
  // U9: change course at any step. The list is the "other courses" one; the draft stays until SWITCH.
  if (payload === "CHANGE_COURSE") return { state: base, replies: [], action: { type: "listOther", page: 1 } };
  // LIST_OTHER:<n> = a later page of the same filtered list (the DO recomputes the exclusions).
  if (payload === "LIST_OTHER" || payload.startsWith("LIST_OTHER:")) {
    const n = payload.slice(11);
    return { state: base, replies: [], action: { type: "listOther", page: /^\d{1,6}$/.test(n) ? Number(n) : 1 } };
  }
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
  // Greeting before the Gmail/step reminder (U3). Read-only: the draft stays.
  if (isText && !payload && GREET.test(clean(event.text))) return { state: base, replies: mainMenu("", extra) };
  if (payload === "PENDING_ORDERS" || (isText && !payload && PENDING_TEXT.test(clean(event.text)))) return { state: base, replies: [], action: { type: "pendingOrders" } };
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
// Tickets on (U6): the customer's pending orders, read from the DB by the DO; replaces listing every order of the DO.
const pendingOrders = (state) => ({ state, replies: [], action: { type: "pendingOrders" } });

// Typo-tolerant course match (U5): words of 4+ letters, optimal-string-alignment distance <= 1 (a swap of two neighbours counts 1).
const STOP = new Set(["khoa", "hoc", "lop", "toi", "muon", "ve", "cho", "minh", "staging", "dang", "ky", "mua", "hoi", "xin", "can", "ban", "shop"]);
const words = (t) => clean(t).split(" ").filter((w) => w.length >= 4 && !STOP.has(w));
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 1;
}
const fuzzyCourses = (q, courses) => {
  const ws = words(q);
  return courses.filter((c) => words(c.title || "").some((cw) => ws.some((w) => near(w, cw))));
};

// A course named outright in the text (its title or slug).
const courseNamed = (ctx, q) => ctx.courses.find((c) => (norm(c.title).length >= 4 && q.includes(norm(c.title))) || q.includes(String(c.slug).toLowerCase()));

// Tickets on, free text (no draft, or a draft after a second miss in a row, U4): FAQ keyword or course name,
// else a close course name (asks, never assigns), else (past orders -> pending orders), else ask once more, then ticket.
// A draft is only replaced when the text names a course outright; it survives everything else.
function freeText(state, event, ctx) {
  const q = norm(event.text);
  // A greeting is not a miss: show the menu and keep the counter at 0.
  if (GREET.test(clean(event.text))) return { state: { ...state, misses: 0 }, replies: mainMenu("") };
  const hit = approvedFaq(ctx).find((f) => (f.keywords || []).some((k) => k && q.includes(k)));
  if (hit) return hit.answer ? { state: { ...state, misses: 0 }, replies: [faqAnswer(hit)] } : ticket(state, "unclear");
  const course = courseNamed(ctx, q);
  if (course) return buy({ ...state, misses: 0 }, ctx, course.slug);
  const close = fuzzyCourses(event.text, ctx.courses);
  if (close.length === 1) return { state: { ...state, misses: 0 }, replies: [text(`Bạn muốn hỏi khóa ${close[0].title || close[0].slug}?`, [["Đúng", `BUY:${close[0].slug}`], ["Không", "LIST"]])] };
  if (close.length > 1) return { state: { ...state, misses: 0 }, replies: listReply(ctx, "") };
  if (ordersOf(state).length) return pendingOrders({ ...state, misses: 0 });
  // G-MC1: text nothing above understood goes to the AI (flag on, no draft, under the daily cap); it only answers.
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  const n = state.ai?.day === day ? state.ai.n : 0;
  if (ctx.aiEnabled && !state.course && n < AI_DAILY_CAP) return { state: { ...state, ai: { day, n: n + 1 } }, replies: [], action: { type: "ai", text: event.text } };
  return freeTextFallback(state);
}

export function freeTextFallback(state) {
  if ((state.misses || 0) >= 1) return ticket(state, "unclear");
  return { state: { ...state, misses: 1 }, replies: mainMenu("Mình chưa hiểu ý bạn. ", draftExtra(state)) };
}

// AI result -> reply. Pure. The AI never produces BUY, an order, a payment check or a Gmail: only text and fixed buttons.
// Its price is never used: the price comes from the course record (AI-I4).
const SELF_HELP_IDS = ["faq-login", "faq-video", "faq-wrong-account"];
export function aiReply(state, ai, ctx) {
  if (!ai || ai.route === "clarify") return freeTextFallback(state);
  if (ai.route === "ticket") return ticket(state, "unclear");
  if (ai.route === "self_help") {
    const f = approvedFaq(ctx).find((x) => SELF_HELP_IDS.includes(x.id) && (ai.sources || []).includes(x.id) && x.answer);
    return f ? { state: { ...state, misses: 0 }, replies: [faqAnswer(f)] } : ticket(state, "unclear");
  }
  if (badAnswer(ai.answer)) return ticket(state, "unclear");
  const next = { ...state, misses: 0 };
  const course = ctx.courses.find((c) => c.slug === ai.course_slug);
  // Price / payment questions: the AI text is replaced by fixed text with the price from the course record.
  const aboutFee = /học phí|chuyển khoản/i.test(ai.answer);
  if (!course) return { state: next, replies: aboutFee ? listReply(ctx, "Bạn muốn hỏi khóa nào? ") : mainMenu(`${ai.answer.trim()} `) };
  const body = aboutFee ? `Học phí ${course.title || course.slug}: ${course.price}. Thông tin chuyển khoản sẽ gửi sau khi bạn bấm "Đăng ký" và xác nhận Gmail.` : ai.answer.trim();
  return { state: next, replies: [text(body, [["Xem chi tiết", `DETAIL:${course.slug}`], ["Đăng ký", `BUY:${course.slug}`], adminBtn(true)])] };
}

// U2: every draft step has a way out: "Hủy đăng ký" and Admin (tickets off: "Gặp người thật").
const exits = (T) => [...(T ? [["Đổi khóa học", "CHANGE_COURSE"]] : []), ["Hủy đăng ký", "CANCEL_DRAFT"], adminBtn(T)];

// U8.8: the draft's course is no longer sold: say so and drop the draft (orders stay, nothing is written to the DB).
const soldOut = (state, ctx) => ({
  state: clearDraft(state),
  replies: [text(`Khóa ${(state.courseTitleFor === state.course && state.courseTitle) || titleOf(ctx, state.course)} hiện không còn mở đăng ký qua Messenger. Bạn muốn xem các khóa học khác đang mở bán hay trò chuyện với Admin ạ?`, [["Xem các khóa học", "LIST"], ["Chat với Admin", "ADMIN"]])]
});
const withExits = (message, T) => ({ ...message, quick_replies: [...message.quick_replies, ...exits(T).map(([title, payload]) => ({ content_type: "text", title, payload }))] });
const gmailAsk = (T) => withExits({
  text: "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học) nhé.",
  quick_replies: [{ content_type: "user_email" }]
}, T);
const retryGmailAsk = (T) => withExits({ text: "Bạn gửi lại Gmail dùng để học nhé.", quick_replies: [{ content_type: "user_email" }] }, T);

// Generic template card for a course (G3-2). Needs ctx.commerceUrl for the "view" button.
export function courseCard(c, ctx) {
  const buttons = [];
  // Tickets on: the details are shown in Messenger (the website sale pages are closed); off: the old web link.
  if (ctx.ticketsEnabled) buttons.push({ type: "postback", title: "Xem nội dung khóa", payload: `DETAIL:${c.slug}` });
  else if (ctx.commerceUrl) buttons.push({ type: "web_url", url: `${ctx.commerceUrl.replace(/\/$/, "")}/?course=${encodeURIComponent(c.slug)}`, title: "Xem nội dung khóa" });
  buttons.push(ctx.ticketsEnabled ? { type: "postback", title: "Đổi khóa học", payload: "CHANGE_COURSE" } : { type: "postback", title: "Đổi khóa khác", payload: "LIST" });
  const element = { title: String(c.title || c.slug).slice(0, 80), subtitle: `Học phí: ${c.price}`.slice(0, 80), buttons };
  if (/^https:\/\//i.test(c.imageUrl || "")) element.image_url = c.imageUrl;
  return { attachment: { type: "template", payload: { template_type: "generic", elements: [element] } } };
}

// The bill step carries the exits too (U9.1), tickets on only.
const billAsk = (T) => text("Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé.", T ? exits(T) : []);

// Payment details, sent only after the customer confirmed the Gmail.
export function paymentInfo(c, T = false) {
  const lines = [`Khoá: ${c.title || c.slug}`];
  if (c.price) lines.push(`Học phí: ${c.price}`);
  if (c.bankAccount) lines.push(`Chuyển khoản: ${[c.bankName, c.bankAccount, c.bankOwner && `(${c.bankOwner})`].filter(Boolean).join(" ")}`);
  if (c.transferNote) lines.push(`Nội dung chuyển khoản: ${c.transferNote}`);
  const out = [text(lines.join("\n"))];
  if (c.qrImageUrl) out.push({ attachment: { type: "image", payload: { url: c.qrImageUrl, is_reusable: true } } });
  out.push(billAsk(T));
  return out;
}

const titleOf = (ctx, slug) => ctx.courses.find((c) => c.slug === slug)?.title || slug;
const confirmGmail = (gmail, title, T) => text(`Đăng ký khóa "${title}" bằng Gmail ${gmail}. Đúng không?`, [["Đúng", "GMAIL_OK"], ["Sai, nhập lại", "GMAIL_NO"], ...exits(T)]);

function nextPrompt(state, ctx) {
  const T = Boolean(ctx.ticketsEnabled);
  if (!state.course) return T ? mainMenu("") : listReply(ctx, "");
  if (!state.gmail) return [gmailAsk(T)];
  if (!state.gmailOk) return [confirmGmail(state.gmail, titleOf(ctx, state.course), T)];
  return [billAsk(T)];
}

// Start (or continue) the draft for a course. Pure; the duplicate-order check is done by the caller.
export function openCourse(state, course, ctx) {
  if (state.course === course.slug) return { state, replies: nextPrompt(state, ctx) };
  // courseTitle: the title for U8.8 once the course is no longer sold (then loadCourses no longer has it).
  return { state: { ...state, course: course.slug, courseTitle: course.title || course.slug, courseTitleFor: course.slug, gmail: null, gmailOk: false, misses: 0, draftMisses: 0, switchRef: null }, replies: [courseCard(course, ctx), gmailAsk(Boolean(ctx.ticketsEnabled))] };
}

// BUY / BUY:<slug> / COURSE:<slug>. A course with an order already goes to a status lookup first (the DO decides).
// U9.3: with tickets on, picking a course other than the open draft asks first (I11); only SWITCH:<slug> (confirmed) replaces it.
// The duplicate-order check comes first. `ref` (campaign entry) is applied only when the draft is opened.
const needsSwitchAsk = (state, ctx, course, confirmed) => Boolean(ctx.ticketsEnabled && !confirmed && state.course && state.course !== course.slug);
export function switchAsk(state, course, ctx) {
  return [text(`Bạn đang đăng ký dở khóa ${titleOf(ctx, state.course)}. Bạn muốn đổi sang khóa ${course.title || course.slug} không?`, [["Đổi sang khóa này", `SWITCH:${course.slug}`], ["Tiếp tục khóa cũ", "CONTINUE_DRAFT"], ["Xem các khóa học", "LIST"]])];
}
// Tickets on, a course the DO has no order for (and not the draft already open): the DO asks the DB first (P0-1, `checkCourse`),
// then opens the draft or asks about switching. The state does not change before that answer.
function buy(state, ctx, slug, { confirmed = false, ref } = {}) {
  const course = slug == null
    ? refCourse(state.ref, ctx) || ctx.courses.find((c) => c.featured)
    : ctx.courses.find((c) => c.slug === slug);
  if (!course) return { state, replies: listReply(ctx, slug == null ? "" : "Khóa này hiện chưa mở đăng ký. ") };
  const ask = needsSwitchAsk(state, ctx, course, confirmed);
  const dup = ordersOf(state).find((o) => o.slug === course.slug);
  const extra = { ask, confirmed, ref: ref || null };
  if (dup) return { state, replies: [], action: { type: "orderStatus", mode: "buy", slug: course.slug, orders: [dup], ...extra } };
  if (ctx.ticketsEnabled && state.course !== course.slug) return { state, replies: [], action: { type: "checkCourse", slug: course.slug, ...extra } };
  return openCourse(ref ? { ...state, ref } : state, course, ctx);
}

// event: { kind: "text", text, payload? } | { kind: "postback", payload, ref? } | { kind: "referral", ref } | { kind: "image", url } | { kind: "echo", fromThisApp }
// The first reply in a conversation always carries the greeting, which says the bot is automated.
// stepRaw keeps the menu/course-list placeholders (the DO renders them after it read the pending orders);
// step renders them with what the state alone knows (no DB read): pendingMenu "unknown" or ctx.view.
export function step(prev, event, ctx) {
  const out = stepRaw(prev, event, ctx);
  const view = ctx.view || { pendingMenu: ctx.ticketsEnabled ? "unknown" : "hide", pendingSlugs: new Set(), doOrderIds: ordersOf(out.state).map((o) => o.id) };
  return { ...out, replies: renderReplies(out.replies, view, ctx) };
}

export function stepRaw(prev, event, ctx) {
  const out = stepInner(prev, event, ctx);
  // A customer ticket gets its reply from the DO after the insert; the greeting must still come first.
  // A course check (checkCourse) also answers later: the greeting of a first message must not be lost.
  const answersLater = (out.action?.type === "openTicket" && out.action.reason !== "admin_reply") || out.action?.type === "checkCourse" || out.action?.type === "ai";
  if (prev?.greeted || (!out.replies.length && !answersLater)) return out;
  const first = out.replies[0];
  const replies = first?.text?.startsWith(GREETING) || first?.menu?.intro?.startsWith(GREETING) ? out.replies : [text(GREETING), ...out.replies];
  return { ...out, state: { ...out.state, greeted: true }, replies };
}

// U8 exceptions: the customer chose clearly (these buttons, a campaign link), or a bill with a complete draft
// (they may have paid already; blocking it would make them send it again).
const RESUME_PAYLOAD = /^(CONTINUE_DRAFT|LIST|LIST:.*|LIST_OTHER(:.*)?|MENU_COURSES|ADMIN.*|CANCEL_DRAFT|CHANGE_COURSE|BUY.*|COURSE:.*|SWITCH:.*|PENDING_ORDERS|MENU|RESTART|HUMAN|DETAIL:.*)$/;
// Typed requests for a person or a restart are explicit too: they must not need two more taps after a break.
const skipsResume = (state, event, payload) => Boolean(event.ref) || RESUME_PAYLOAD.test(payload)
  || (event.kind === "text" && !payload && (HUMAN.test(event.text || "") || RESTART.test((event.text || "").trim())))
  || (event.kind === "image" && state.gmail && state.gmailOk);

function stepInner(prev, event, ctx) {
  const state = normalizeState(prev);
  const now = ctx.now;

  const T = Boolean(ctx.ticketsEnabled);
  if (event.kind === "echo") {
    // Tickets on: an Admin reply from the Page inbox opens an in-progress ticket (the bot stays silent while one is open).
    // Without META_APP_ID our own sends cannot be told apart from Admin replies: ignore echoes, or the bot
    // would open a ticket on its own first answer and go silent for good.
    if (T) {
      // A human reply from the Page inbox (needs META_APP_ID to tell it from our own sends): remember when, for P0-2.
      if (!event.fromThisApp && ctx.appIdKnown) state.adminSeenAt = now;
      return { state, replies: [], action: event.fromThisApp || !ctx.appIdKnown ? undefined : { type: "openTicket", reason: "admin_reply", status: "in_progress" } };
    }
    // A human replied from the Page inbox: stay silent for 12 hours. Our own sends echo back with our app id.
    if (!event.fromThisApp) state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [] };
  }
  // U8: every customer message (not echoes) moves the mark; the gap is read before. No mark yet (old state) = no U8 this time.
  const sinceLast = typeof state.lastInboundAt === "number" && state.lastInboundAt > 0 ? now - state.lastInboundAt : -1;
  state.lastInboundAt = now;
  // Open ticket: silent for every kind (text, postback, image, referral).
  if (T && ctx.activeTicket) return { state, replies: [], action: { type: "touchTicket" } };
  // P0-2: the ticket lookup failed or timed out, so an open ticket cannot be ruled out. No U8, no order, no ticket, the draft stays.
  // Quiet if an Admin wrote from the inbox within 12 hours; else one busy message (with the Admin button) per 10 minutes.
  if (T && ctx.ticketUnknown) {
    if (state.adminSeenAt && now - state.adminSeenAt < PAUSE_MS) return { state, replies: [] };
    if (!state.ticketBusyAt || now - state.ticketBusyAt >= 10 * 60 * 1000) return { state: { ...state, ticketBusyAt: now }, replies: busyAdminReplies() };
    return { state, replies: [] };
  }
  if (!T && state.pausedUntil > now) return { state, replies: [] };

  const payload = event.payload || "";
  if (T && state.course && !state.pendingAdmin && sinceLast >= (ctx.resumeGapMs ?? PAUSE_MS) && !skipsResume(state, event, payload)) {
    // Back after a long gap with an open draft: ask once (the mark is now fresh) instead of repeating the step.
    if (!ctx.courses.some((c) => c.slug === state.course)) return soldOut(state, ctx);
    return { state, replies: [{ menu: { intro: `Chào bạn! Trước đó bạn đang đăng ký khóa ${titleOf(ctx, state.course)} nhưng chưa hoàn tất. Bạn muốn tiếp tục đăng ký khóa này, xem các khóa học khác đang mở bán hay trò chuyện với Admin ạ?`, ask: false, resume: true } }] };
  }
  if (payload) state.draftMisses = 0; // U4: any button resets the count
  // Campaign entry (m.me ref / ad): a valid, sellable course opens the buy flow, anything else the menu.
  if (event.ref) {
    const course = refCourse(event.ref, ctx);
    state.pendingAdmin = null;
    if (!course) return { state, replies: T ? mainMenu("") : listReply(ctx, "") };
    return buy(state, ctx, course.slug, { ref: event.ref });
  }
  // U2: drop the draft, keep the orders; never touches the DB.
  if (payload === "CANCEL_DRAFT") {
    return { state: { ...clearDraft(state), ref: null, pendingAdmin: null, misses: 0 }, replies: T ? mainMenu("Đã hủy đăng ký dở. ") : listReply(ctx, "Đã hủy đăng ký dở. ") };
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
  // U7: page n of the carousel (a bad number is clamped when rendering).
  if (/^LIST:/.test(payload)) return { state, replies: listReply(ctx, "", T, /^\d{1,6}$/.test(payload.slice(5)) ? Number(payload.slice(5)) : 1) };
  if (payload === "BUY") return buy(state, ctx, null);
  if (payload.startsWith("BUY:") || payload.startsWith("COURSE:")) return buy(state, ctx, payload.slice(payload.indexOf(":") + 1));
  if (payload.startsWith("SWITCH:")) {
    // The campaign ref kept by the switch question counts only for the course it was kept for.
    const slug = payload.slice(7);
    const sr = state.switchRef;
    return buy(state, ctx, slug, { confirmed: true, ref: sr?.slug === slug && refCourse(sr.ref, ctx)?.slug === slug ? sr.ref : undefined });
  }
  // P1-5: course details inside Messenger (tickets on).
  if (T && payload.startsWith("DETAIL:")) {
    const course = ctx.courses.find((c) => c.slug === payload.slice(7));
    return { state, replies: course ? detailReplies(course) : listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
  }
  if (payload === "GMAIL_OK" && state.gmail && state.course) {
    const course = ctx.courses.find((c) => c.slug === state.course);
    if (!course) return { state: clearDraft(state), replies: listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
    // Tickets on: the DO checks the DB for an order of this course before the transfer details (P0-1); it sets gmailOk after.
    if (T) return { state, replies: [], action: { type: "checkPayment", slug: course.slug, gmail: state.gmail } };
    state.gmailOk = true;
    return { state, replies: paymentInfo(course, T) };
  }
  if (payload === "GMAIL_NO") {
    return { state: { ...state, gmail: null, gmailOk: false }, replies: [retryGmailAsk(T)] };
  }

  if (event.kind === "text") {
    const match = EMAIL.exec(event.text || "");
    if (match && state.course) {
      const gmail = match[0].toLowerCase();
      if (!isValidEmail(gmail)) return { state, replies: [text("Địa chỉ email chưa đúng. Bạn kiểm tra và gửi lại nhé.")] };
      const replies = [];
      state.draftMisses = 0;
      if (!gmail.endsWith("@gmail.com")) replies.push(text("Lưu ý: trang học đăng nhập bằng Google. Nếu đây không phải tài khoản Google, bạn hãy gửi Gmail khác."));
      replies.push(confirmGmail(gmail, titleOf(ctx, state.course), T));
      return { state: { ...state, gmail, gmailOk: false }, replies };
    }
    if (T && !state.course) return freeText(state, event, ctx);
    // U4: with a draft, the first stray text repeats the step (with the exit buttons); the second in a row is handled as free text.
    if (T && state.course) {
      // U9.3: a typed name of another course asks about switching right away (never replaces the draft).
      const named = courseNamed(ctx, norm(event.text));
      if (named && named.slug !== state.course) return buy({ ...state, misses: 0 }, ctx, named.slug);
      if (state.draftMisses >= 1) return freeText({ ...state, draftMisses: 2 }, event, ctx);
      return { state: { ...state, draftMisses: 1 }, replies: nextPrompt(state, ctx) };
    }
    // No draft but past orders: any message reopens Meta's 24-hour window, so answer with this sender's own
    // orders (looked up by the order ids in this conversation, never by a typed Gmail).
    if (!state.course && state.orders.length) return listOrders(state);
    return { state, replies: nextPrompt(state, ctx) };
  }

  if (event.kind === "image") {
    if (!state.course && state.orders.length) return T ? pendingOrders(state) : listOrders(state);
    if (!state.course || !state.gmail || !state.gmailOk) return { state, replies: nextPrompt(state, ctx) };
    return { state, replies: [], action: { type: "createOrder", url: event.url } };
  }

  return { state, replies: nextPrompt(state, ctx) };
}

// U6/B7: with tickets on, the receipt carries the "Đơn chờ duyệt" button.
export const orderCreatedReply = (T = true) => text("Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản. Khi được duyệt, mình sẽ nhắn bạn cách vào học.", T ? [PENDING_BTN] : []);
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

export const busyReplies = () => mainMenu("Hệ thống đang bận, bạn thử lại sau ít phút nhé.", [], false);
// A failed "Đơn chờ duyệt" read: never "no orders" (I9); no menu read either, which would hit the same DB.
export const busyAdminReplies = (T = true) => [text("Hệ thống đang bận, bạn thử lại sau ít phút nhé.", [adminBtn(T), ["Quay lại menu", "MENU"]])];

const ALT = [["Đăng ký khóa khác", "LIST_OTHER"], ["Quay lại menu", "MENU"]];
// Customer picked a course that already has an order: pending -> say so (no new draft), approved -> the approved notice.
// Any other status returns null: the DO then opens a fresh draft.
export function buyDuplicateReplies(order, ctx) {
  const T = Boolean(ctx.ticketsEnabled);
  if (order?.status === "Chờ duyệt") return [text("Bạn đã có đơn khóa này đang chờ Admin xác nhận.", T ? [ALT[0], PENDING_BTN, ALT[1]] : [["Quay lại menu", "MENU"]])];
  if (order?.status === "Đã duyệt") {
    const replies = orderStatusReplies(order, ctx);
    return T ? [text(replies[0].text, ALT)] : replies;
  }
  return null;
}

// One message for all orders of this conversation: `<course>: <status>`; items = [{ title, order }].
export function ordersSummaryReplies(items, ctx) {
  const lines = items.map(({ title, order }) => {
    const status = order?.status === "Đã duyệt" ? `Đã duyệt - ${String(ctx.lmsUrl || "").replace(/\/$/, "")}/my-courses.html`
      : order?.status === "Chờ duyệt" ? "Chờ duyệt" : "chưa được duyệt";
    return `${title}: ${status}`;
  });
  return mainMenu(`Các đơn của bạn:\n${lines.join("\n")}`, [], false);
}

// ---- "Đơn chờ duyệt" (U6) ----
export const NO_PENDING_TEXT = "Bạn hiện không có đơn đăng ký nào đang chờ duyệt.";
export const UNVERIFIED_TEXT = "Mình chưa xác minh được một số đơn của bạn. Bạn bấm Chat với Admin để được kiểm tra nhé.";
// dd/mm/yyyy in Vietnam time (UTC+7).
const dmy = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t + 7 * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
// verified / unverified (R1): [{ title, createdAt }]. No Gmail, PSID or order id in the text.
export function pendingOrdersReplies(verified, unverified) {
  if (!verified.length && !unverified.length) return [text(NO_PENDING_TEXT, ALT)];
  if (!verified.length) return [text(UNVERIFIED_TEXT, [adminBtn(true), ALT[1]])];
  const lines = verified.map((o) => `${o.title} — gửi bill ${dmy(o.createdAt)}`.trimEnd());
  // A message is limited to 2000 characters: split long lists, buttons on the last part.
  const parts = [["Đơn của tôi đang chờ duyệt"]];
  for (const line of lines) {
    const cur = parts.at(-1);
    if (cur.join("\n").length + line.length > 1700) parts.push([line]); else cur.push(line);
  }
  const texts = parts.map((p) => p.join("\n"));
  if (unverified.length) texts[texts.length - 1] += `\n\n${UNVERIFIED_TEXT}`;
  return texts.map((t, i) => text(t, i === texts.length - 1 ? ALT : []));
}

// ---- Course details in Messenger (P2-5): one text message (<= 2000), description cut to 600, HTML removed ----
const plain = (t) => String(t || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
  .split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
export function detailReplies(c) {
  const desc = plain(c.description);
  const lines = [cut(plain(c.title) || c.slug, 200), c.price ? `Học phí: ${cut(plain(c.price), 100)}` : "", cut(plain(c.subtitle), 200), cut(desc, 600)].filter(Boolean);
  const out = [];
  if (/^https:\/\//i.test(c.imageUrl || "")) out.push({ attachment: { type: "image", payload: { url: c.imageUrl, is_reusable: true } } });
  out.push(text(cut(lines.join("\n\n"), 2000), [["Đăng ký", `BUY:${c.slug}`], ["Xem các khóa học", "LIST"], adminBtn(true)]));
  return out;
}

// P0-1 layer (b): a bill arrives for a course that already has an order. No order is created; the Admin checks the bill.
export const dupBillReplies = (T) => [text("Mình đã nhận ảnh. Khóa này đã có đơn trước đó, Admin sẽ kiểm tra bill này và trả lời bạn.", [adminBtn(T)])];

// ---- Rendering of the placeholders (menu B6, course carousel U7) ----
const cut = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));
const shortDesc = (c) => String(c.subtitle || c.description || "").replace(/\s+/g, " ").trim();
const quickOf = (quick) => quick.map(([title, payload]) => ({ content_type: "text", title, payload }));

function cardOf(c, ctx, pending) {
  // "Xem chi tiết" is a postback (DETAIL:<slug>): the details are shown in Messenger, the website sale pages are closed.
  const buttons = [{ type: "postback", title: "Xem chi tiết", payload: `DETAIL:${c.slug}` }];
  buttons.push(pending ? { type: "postback", title: PENDING_BTN[0], payload: PENDING_BTN[1] } : { type: "postback", title: "Đăng ký", payload: `BUY:${c.slug}` });
  const desc = shortDesc(c);
  const element = { title: cut(c.title || c.slug, 80), subtitle: pending ? "Bạn đã có đơn chờ duyệt" : cut(`Học phí: ${c.price}${desc ? ` · ${desc}` : ""}`, 80), buttons };
  if (/^https:\/\//i.test(c.imageUrl || "")) element.image_url = c.imageUrl;
  return element;
}

// One carousel page (10 or fewer courses: one page; more: 9 per page). A bad page number goes to page 1 or the last page.
function courseList({ page, intro = "", exclude = [], other = false }, view, ctx) {
  const T = true;
  if (!ctx.courses.length) return [text(`${intro}Hiện chưa có khóa nào mở đăng ký qua Messenger.`, [adminBtn(T), ["Quay lại menu", "MENU"]])];
  const list = ctx.courses.filter((c) => !exclude.includes(c.slug));
  if (!list.length) return [text(`${intro}Hiện chưa có khóa nào khác đang mở đăng ký.`, [["Quay lại menu", "MENU"]])];
  const per = list.length <= 10 ? 10 : 9;
  const pages = Math.ceil(list.length / per);
  const p = Math.min(Math.max(Number.isInteger(page) ? page : 1, 1), pages);
  const pending = view.pendingSlugs || new Set();
  const nav = other ? "LIST_OTHER" : "LIST";
  const quick = quickOf([["Quay lại menu", "MENU"], adminBtn(T), ...(p > 1 ? [["Trang trước", `${nav}:${p - 1}`]] : []), ...(p < pages ? [["Xem tiếp", `${nav}:${p + 1}`]] : [])]);
  const lead = list.length >= 2 ? `${intro}Có ${list.length} khóa đang mở. Vuốt ngang để xem thêm →` : intro.trim();
  const elements = list.slice((p - 1) * per, p * per).map((c) => cardOf(c, ctx, pending.has(c.slug)));
  return [...(lead ? [text(lead)] : []), { attachment: { type: "template", payload: { template_type: "generic", elements } }, quick_replies: quick }];
}

// view = { pendingMenu: "show" | "hide" | "unknown", pendingSlugs: Set, doOrderIds: [id] }
export function renderReplies(replies, view, ctx) {
  return replies.flatMap((r) => {
    if (r.menu) {
      const { intro, extra = [], ask = true, resume = false } = r.menu;
      return [text(`${intro}${ask ? "Bạn cần mình giúp gì?" : ""}`, menuButtons(view.pendingMenu, (view.doOrderIds || []).length > 0, extra, resume))];
    }
    if (r.courses) return courseList(r.courses, view, ctx);
    return [r];
  });
}
export const hasPlaceholder = (replies) => replies.some((r) => r.menu || r.courses);
