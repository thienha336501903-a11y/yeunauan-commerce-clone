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
// G-LIVE-ux F-A6: matched against clean(text), so "gap admin", "noi chuyen voi nguoi" work like the accented forms.
// G-LIVE-ux F-A9: money trouble goes to an Admin at once. "em vua chuyen khoan roi" is not one.
// "dư"/"thừa" are read on the accented text: stripped, "đủ" (enough) would look like "dư" (too much). Unaccented, only "thua tien" and "chuyen du <amount>" count.
const INCIDENT = /\b(chuyen nham|nham tai khoan|nham stk|chuyen thieu|thieu tien|thua tien|chuyen thua|chuyen du(?= \d)|chuyen (2|hai) lan|chuyen trung|hoan tien|tra lai tien|giao dich (loi|that bai|khong thanh cong)|bi tru tien|sai noi dung)\b/;
const INCIDENT_ACCENTED = /(chuyển dư|dư tiền|thừa tiền|chuyển thừa)/;
const GMAIL_CHANGE_TEXT = /\b(doi gmail|doi email)\b/;
// gmailChange: "đổi gmail" is an incident only at the bill step or for a customer with orders (at the Gmail steps it is just the customer fixing the Gmail).
const isIncident = (raw, gmailChange = false) => {
  const c = clean(raw);
  return INCIDENT.test(c) || INCIDENT_ACCENTED.test(String(raw || "").normalize("NFC").toLowerCase()) || (gmailChange && GMAIL_CHANGE_TEXT.test(c));
};
// G-LIVE-ux F-A2: acknowledgements are not unknown questions.
const FILLER = /^(da )?(ok|oke|okie|okay|vang|u|uh|um|cam on( shop| ban| ad| nhieu)?|thanks?( you)?|tks|hihi|hehe|haha|da)( a| nha| nhe| ah)?$/;
// G-LIVE-ux F-A4: only at the Gmail confirmation step.
const YES = /^(dung|dung roi|ok|oke|vang|da|da dung|yes|phai|chuan|u)$/;
const NO = /^(sai|khong|khong dung|nham|nhap lai)$/;
// G-LIVE-ux F-A1 / F-A5.
const LEARN = /\b(khong vao hoc duoc|khong dang nhap duoc|video loi|khong xem duoc|chua thay khoa|khong thay khoa|loi video)\b/;
const CATALOG = /\b(co nhung khoa nao|khoa nao|xem khoa hoc|danh sach khoa|cac khoa hoc)\b/;
// "chat" must be typed as "chat": stripped of accents, "chất" (quality) would look like it. The DO only asks this while a bill is being created, so "đổi gmail" counts.
const isHuman = (t) => {
  const raw = String(t || "").normalize("NFC").toLowerCase();
  const c = clean(raw);
  if (/\b(gap|noi chuyen)\b.{0,12}\b(nguoi|admin|ad|nhan vien)\b|\btu van vien\b/.test(c)) return true;
  return /(^|[^\p{L}])chat([^\p{L}]|$)/u.test(raw) && /\bchat\b.{0,12}\b(nguoi|admin|ad|nhan vien)\b/.test(c);
};
// The DO needs this to hold a request for an Admin while a bill is being created (A6 step 6).
export const adminIntent = (event) => (event.kind === "text" ? event.payload === "HUMAN" || (!event.payload && (isHuman(event.text) || isIncident(event.text, true))) : false);
const REAL_DOMAINS = new Set(["gmail.com", "yahoo.com", "yahoo.com.vn", "outlook.com", "icloud.com", "hotmail.com", "live.com", "msn.com", "me.com", "mail.com", "email.com", "aol.com", "protonmail.com"]);
const gmailTypo = (email) => {
  const i = email.lastIndexOf("@");
  const domain = email.slice(i + 1);
  return !REAL_DOMAINS.has(domain) && osa(domain, "gmail.com") <= 2 ? `${email.slice(0, i)}@gmail.com` : null;
};
const RESTART = /^(khóa|khoá) khác$|^bắt đầu lại$/i;
// "menu" only shows the menu: it keeps the conversation (draft, orders), unlike RESTART.
// MENU and GREET are matched against clean(text): no accents, punctuation or emoji.
const MENU = /^menu( a)?$/;
// Greetings: "Hi!", "Chào shop", "xin chào ạ", "shop ơi", "dạ chào bạn ơi".
const GREET = /^(da )?((hi+|hello|helo|hey|alo+|xin chao|chao)( (ban|shop|ad|admin|em|anh|chi))?|shop|ad|admin)( oi)?( a)?$/;
const MAX_ORDERS = 10;
// Typed form of the "Đơn chờ duyệt" button, matched against clean(text).
const PENDING_TEXT = /^(don cua toi|don hang|kiem tra don|xem don)$/;
// G-MC1-route: free text about an existing order (only used when the customer has orders; everything else may go to the AI).
// "đơn" is matched with its accent when the text has accents, so "đón" or "đơn giản" never count; unaccented typing uses "don".
// Cooking words ("thực đơn", "đơn vị", "kích hoạt men") are not orders.
const ORDER_WORDS = /\b(bill|duyet|kich hoat(?! men)|cap quyen|(chuyen khoan|ck|chuyen tien|thanh toan) (roi|xong)|da (chuyen khoan|ck|chuyen tien|thanh toan)|vao hoc (chua|duoc chua))\b/;
// G-MC1-intent: matched against clean(text). "gia vi", "gia dinh" are not prices.
const PRICE_TEXT = /\b(hoc phi|bao nhieu tien|bn tien|(?<!(tham|chuyen|quoc|giam) )gia(?! (vi|dinh|su|truyen|han|nhiet|cong)\b))\b/;
const LESSONS_TEXT = /\b(nhung bai|bao nhieu bai|may bai|bai hoc|so bai|danh sach bai)\b/;
const CONTENT_TEXT = /\b((hoc|day)( duoc)?( nhung| cai)?( mon)? gi|mon nao|gom nhung gi|noi dung|chuong trinh(?! (khuyen mai|uu dai)\b)|giao trinh)\b/;
const BARE_FILLER = new Set(["a", "nay", "nhe", "oi", "day"]);
// Clear wish to register. A question about how, or any negative ("chưa muốn mua", "đăng ký được không"), is not one.
// "mua" must be typed without accents: "mùa", "mưa" are other words.
const buyText = (raw) => {
  const t = String(raw || "").normalize("NFC").toLowerCase();
  const c = clean(t);
  if (/\b(the nao|nhu nao|ra sao|o dau|lam sao|khong|ko|chua|cach|huong dan|khi nao|bao gio|roi|la gi|(huy|bo|thoi) (dang ky|dang ki|dk|mua))\b/.test(c)) return false;
  // On the accented text: clean() would turn "dạ đăng ký" into "da dang ky".
  if (/đã (đăng k|đk|mua)|đừng/.test(t)) return false;
  const accented = norm(t) !== t.replace(/đ/g, "d");
  return /\b(dang ky|dang ki|dangky|dk|dat mua)\b/.test(c) || (accented ? /(^|[^\p{L}])mua([^\p{L}]|$)/u.test(t) : /\bmua\b/.test(c));
};
const orderText = (raw) => {
  const t = String(raw || "").normalize("NFC").toLowerCase();
  const accented = norm(t) !== t.replace(/đ/g, "d");
  const don = accented
    ? /(^|[^\p{L}])đơn(?! giản| vị)([^\p{L}]|$)/u.test(t) && !/thực đơn/.test(t)
    : /\bdon\b(?! gian| vi)/.test(clean(t)) && !/\bthuc don\b/.test(clean(t));
  return don || ORDER_WORDS.test(clean(t));
};

// Ticket replies (Owner text, 08/11). Used by the DO after it knows whether the ticket was written.
export const TICKET_OK_TEXT = "Mình đã chuyển yêu cầu của bạn tới Admin. Admin sẽ hỗ trợ trực tiếp trong cuộc trò chuyện này.";
export const TICKET_FAIL_TEXT = "Hệ thống chưa ghi nhận được yêu cầu. Admin vẫn đọc được tin nhắn này trong Hộp thư của Trang và sẽ trả lời bạn.";
export const ticketReply = (ok) => ({ text: ok ? TICKET_OK_TEXT : TICKET_FAIL_TEXT });

// Draft = course, gmail, gmailOk. Placed orders live in `orders` ([{ id, slug }], absent in states saved before V2).
// draftMisses (U4): consecutive non-email texts while a draft is open.
export const emptyState = () => ({ course: null, gmail: null, gmailOk: false, orderId: null, pendingAdmin: null, ref: null, pausedUntil: 0, greeted: false, draftMisses: 0, lastInboundAt: 0, adminSeenAt: 0, ticketBusyAt: 0, switchRef: null });
export const ordersOf = (s) => (Array.isArray(s?.orders) ? s.orders : s?.orderId ? [{ id: s.orderId, slug: s.course }] : []);
export const clearDraft = (s) => ({ ...s, course: null, courseTitle: null, courseTitleFor: null, gmail: null, gmailOk: false, draftMisses: 0, switchRef: null, gmailFix: null, gmailPending: null, billAskAt: 0 });
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
// G-LIVE-ux (Owner 14/11): the button opens "Đơn của bạn" (pending and approved), so it is named for that.
const PENDING_BTN = ["Đơn của tôi", "PENDING_ORDERS"];
const DRAFT_BTNS = [["Tiếp tục đăng ký", "CONTINUE_DRAFT"], ["Hủy đăng ký", "CANCEL_DRAFT"]];
// The one builder of the main menu (B6). pendingMenu: "show" | "hide" | "unknown" (DB error: show only if the DO already holds an order id, B5).
export function menuButtons(pendingMenu, hasOrdersInDo, extra = []) {
  const show = pendingMenu === "show" || (pendingMenu === "unknown" && Boolean(hasOrdersInDo));
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
  if (payload === "HUMAN" || (payload === "ADMIN_SKIP" && !state.pendingAdmin) || (isText && !payload && isHuman(event.text))) return ticket(state, "human");
  if (isText && !payload && isIncident(event.text, Boolean(state.gmailOk) || ordersOf(state).length > 0)) return ticket(state, "support", event.text);
  if (payload === "RESTART" || (isText && RESTART.test((event.text || "").trim()))) {
    return { state: { ...clearDraft(base), ref: null }, replies: mainMenu(""), closeRun: true };
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
  // G-LIVE-ux F-A3: one step. ADMIN_COURSE / ADMIN_SUPPORT stay as aliases for buttons still in old chats.
  if (payload === "ADMIN" || payload === "ADMIN_COURSE" || payload === "ADMIN_SUPPORT") {
    return { state: { ...base, pendingAdmin: "support" }, replies: [text("Bạn mô tả ngắn việc cần Admin hỗ trợ nhé.", [["Bỏ qua, gặp Admin", "ADMIN_SKIP"], ["Quay lại menu", "MENU"]])] };
  }
  // The next message after the question (text, image, or "Bỏ qua") opens the ticket; its text is the summary.
  if (state.pendingAdmin && (payload === "ADMIN_SKIP" || (isText && !payload))) {
    return ticket(state, state.pendingAdmin, payload === "ADMIN_SKIP" ? "" : event.text || "");
  }
  // G-LIVE-ux F-A3: a picture here is the request too (it used to be dropped).
  if (state.pendingAdmin && event.kind === "image") return ticket(state, state.pendingAdmin, "Khách gửi ảnh, xem trong Hộp thư Trang.");
  // Greeting before the Gmail/step reminder (U3). Read-only: the draft stays.
  if (isText && !payload && GREET.test(clean(event.text))) return { state: base, replies: mainMenu("", extra) };
  // A6 step 10: the typed form is only read with no draft; with a draft the step handler below answers.
  if (payload === "PENDING_ORDERS" || (isText && !payload && !state.course && PENDING_TEXT.test(clean(event.text)))) return myOrders(base);
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
// G-LIVE-ux F-A1: pending and approved orders of this PSID (the DO reads and renders T7/T8).
const myOrders = (state) => ({ state: { ...state, misses: 0 }, replies: [], action: { type: "myOrders" } });

// Typo-tolerant course match (U5): optimal-string-alignment distance (a swap of two neighbours counts 1).
// G-LIVE-ux F-A6: a distance of 1 only for words of 5+ letters; shorter words must match exactly ("rảnh" is not "bánh").
const STOP = new Set(["khoa", "hoc", "lop", "toi", "muon", "ve", "cho", "minh", "staging", "dang", "ky", "mua", "hoi", "xin", "can", "ban", "shop"]);
const words = (t) => clean(t).split(" ").filter((w) => w.length >= 4 && !STOP.has(w));
function near(a, b) {
  if (a.length < 5 || b.length < 5) return a === b;
  return Math.abs(a.length - b.length) <= 1 && osa(a, b) <= 1;
}
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
const fuzzyCourses = (q, courses) => {
  const ws = words(q);
  return courses.filter((c) => words(c.title || "").some((cw) => ws.some((w) => near(w, cw))));
};

// A course named outright in the text (its title or slug).
// G-LIVE-ux F-A6: compared on clean() so punctuation in a title ("–") does not stop the match.
const courseNamed = (ctx, q) => {
  const c = clean(q);
  return ctx.courses.find((co) => { const t = clean(co.title); const s = clean(co.slug); return (t.length >= 4 && c.includes(t)) || (s && c.includes(s)); });
};

// Tickets on, free text (no draft, or a draft after a second miss in a row, U4): FAQ keyword or course name,
// else a close course name (asks, never assigns), else price / list / buy wishes, else the AI, else ask once more, then offer an Admin (never a ticket).
// A draft is only replaced when the text names a course outright; it survives everything else.
function freeText(state, event, ctx) {
  const q = norm(event.text);
  const c = clean(event.text);
  // A greeting is not a miss: show the menu and keep the counter at 0.
  if (GREET.test(c)) return { state: { ...state, misses: 0 }, replies: mainMenu("") };
  // G-LIVE-ux F-A2: "ok", "cảm ơn"... need no answer (a first contact still gets the greeting and menu).
  if (FILLER.test(c)) return { state: { ...state, misses: 0 }, replies: state.greeted ? [] : mainMenu("") };
  const hit = approvedFaq(ctx).find((f) => (f.keywords || []).some((k) => k && q.includes(k)));
  if (hit) return hit.answer ? { state: { ...state, misses: 0 }, replies: [faqAnswer(hit)] } : ticket(state, "unclear");
  // G-MC1-intent: without a draft, a question about an order comes before any course match in the same sentence.
  if (!state.course && (orderText(event.text) || LEARN.test(c))) return myOrders(state);
  const course = courseNamed(ctx, q);
  const close = course ? [] : fuzzyCourses(event.text, ctx.courses);
  // G-MC1-intent: without a draft, naming a course is not asking to buy it (Gmail only on a clear wish to register).
  if (!state.course && (course || close.length === 1)) return courseQuestion({ ...state, misses: 0 }, event, ctx, course || close[0], Boolean(course));
  if (course) return buy({ ...state, misses: 0 }, ctx, course.slug);
  if (close.length === 1) return { state: { ...state, misses: 0 }, replies: askCourse(close[0], `BUY:${close[0].slug}`) };
  if (close.length > 1) return { state: { ...state, misses: 0 }, replies: listReply(ctx, "") };
  // G-LIVE-ux F-A5: the basics of buying still work with the AI off.
  if (PRICE_TEXT.test(c)) return { state: { ...state, misses: 0 }, replies: listReply(ctx, "Bạn xem học phí của từng khóa bên dưới nhé. ") };
  if (CATALOG.test(c)) return { state: { ...state, misses: 0 }, replies: listReply(ctx, "") };
  if (buyText(event.text)) return buy({ ...state, misses: 0 }, ctx, null);
  // G-MC1: text nothing above understood goes to the AI (flag on, no draft, under the daily cap); it only answers.
  const ai = aiTurn(state, event, ctx);
  if (ai) return ai;
  return freeTextFallback(state);
}

function aiTurn(state, event, ctx, match) {
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  const n = state.ai?.day === day ? state.ai.n : 0;
  if (!ctx.aiEnabled || state.course || n >= AI_DAILY_CAP) return null;
  return { state: { ...state, ai: { day, n: n + 1 } }, replies: [], action: { type: "ai", text: event.text, ...(match ? { match } : {}) } };
}

const askCourse = (c, yesPayload) => [text(`Bạn muốn hỏi khóa ${c.title || c.slug}?`, [["Đúng", yesPayload], ["Không", "LIST"]])];
// A course was found but the customer asked nothing the code can answer: its card (exact name) or "this course?" (typo, U5: never assign).
const courseFallback = (state, c, exact) => ({ state, replies: exact ? detailReplies(c) : askCourse(c, `INFO:${c.slug}:general`) });

// G-MC1-intent: what a sentence that mentions a course asks for. A question wins over "đăng ký" so Gmail is never asked by mistake.
function courseIntent(raw) {
  const c = clean(raw);
  if (PRICE_TEXT.test(c)) return "price";
  if (LESSONS_TEXT.test(c)) return "lessons";
  if (CONTENT_TEXT.test(c)) return "content";
  return buyText(raw) ? "buy" : "other";
}

// Only the course name (and filler words) in the sentence.
const bareName = (raw, c) => {
  const title = clean(c.title || c.slug).split(" ");
  return clean(raw).split(" ").filter(Boolean).every((w) => STOP.has(w) || BARE_FILLER.has(w) || title.some((t) => t === w || (w.length >= 4 && near(w, t))));
};

// The sentence without the exact course name, so a title like "Bánh không đường" cannot change the intent.
// NFC Vietnamese maps 1:1 onto norm(), so the index found in norm() is valid in the text.
const withoutTitle = (raw, c) => {
  const t = String(raw || "").normalize("NFC").replace(/\p{M}/gu, ""); // combining marks left after NFC (emoji variation selectors) would shift the index
  const name = norm(c.title);
  const i = name ? norm(t).indexOf(name) : -1;
  return i < 0 ? t : `${t.slice(0, i)} ${t.slice(i + name.length)}`;
};

function courseQuestion(state, event, ctx, c, exact) {
  const intent = courseIntent(exact ? withoutTitle(event.text, c) : event.text);
  if (intent === "buy") return exact ? buy(state, ctx, c.slug) : { state, replies: askCourse(c, `BUY:${c.slug}`) };
  // G-LIVE-ux F-A7: a question about lessons or content shows the same card as [Xem chi tiết] (never a made-up answer).
  if (intent === "lessons" || intent === "content") return exact ? { state, replies: detailReplies(c) } : { state, replies: askCourse(c, `DETAIL:${c.slug}`) };
  if (intent !== "other") return exact ? { state, replies: infoReply(c, intent) } : { state, replies: askCourse(c, `INFO:${c.slug}:${intent}`) };
  const ai = bareName(event.text, c) ? null : aiTurn(state, event, ctx, { slug: c.slug, exact });
  return ai || courseFallback(state, c, exact);
}

// Read-only answer about one course: no draft, no Gmail, no DB, no AI. The price is the course record's; content needs Owner approval.
function infoReply(c, topic) {
  const name = plain(c.title) || c.slug;
  const buttons = [["Xem chi tiết", `DETAIL:${c.slug}`], ["Đăng ký", `BUY:${c.slug}`], adminBtn(true)];
  if (topic === "price") return [text(`Học phí ${name}: ${cut(plain(c.price), 100)}.`, buttons)];
  if (topic !== "content" && topic !== "lessons") return detailReplies(c);
  const desc = topic === "content" && c.contentApproved ? plain(c.description) : "";
  if (desc) return [text(`${name}\n\n${cut(desc, 600)}`, buttons)];
  return [text(`Hiện mình chưa có đủ thông tin chi tiết về nội dung khóa ${name}. Bạn chat với Admin để được tư vấn thêm nhé.`, [adminBtn(true), ["Đăng ký", `BUY:${c.slug}`], ["Xem các khóa học", "LIST"]])];
}

// G-LIVE-ux F-A2: the second miss in a row offers an Admin; it never opens a ticket by itself. The counter resets on any button or understood text.
export function freeTextFallback(state) {
  if ((state.misses || 0) >= 1) return { ...offerAdmin(state), state: { ...state, misses: 2 } };
  return { state: { ...state, misses: 1 }, replies: mainMenu("Mình chưa hiểu ý bạn. ", draftExtra(state)) };
}

// AI result -> reply. Pure. The AI never produces BUY, an order, a payment check or a Gmail: only text and fixed buttons.
// Its price is never used: the price comes from the course record (AI-I4).
// G3: the customer decides; a ticket silences the bot until an Admin closes it.
const offerAdmin = (state) => ({ state: { ...state, misses: 0 }, replies: [text("Phần này mình chưa có đủ thông tin để trả lời chắc chắn. Bạn có muốn Admin hỗ trợ thêm không?", [["Chat với Admin", "HUMAN"], ["Xem các khóa học", "LIST"], ["Quay lại menu", "MENU"]])] });
// Only a plain amount ("1.000đ", "1,000 VND"); anything else ("500k", "liên hệ") cannot be compared safely.
const priceVnd = (p) => {
  const m = /^\s*(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(đ|đồng|vnd|vnđ)(?![\p{L}/])(.*)$/iu.exec(plain(p));
  return m && !/\d/.test(m[3]) ? Number(m[1].replace(/[.,]/g, "")) : null;
};
// G3: facts about the catalogue come from code, never from the model.
function factReply(state, intent, ctx) {
  if (intent === "catalog") return { state, replies: listReply(ctx, "") };
  if (intent === "newest") return { state, replies: listReply(ctx, "Mình chưa có thông tin khóa nào mới nhất. Các khóa đang mở đăng ký: ") };
  if (intent !== "cheapest") return null;
  const priced = ctx.courses.map((c) => ({ c, v: priceVnd(c.price) }));
  if (!priced.length || priced.some((p) => p.v === null)) return { state, replies: listReply(ctx, "Bạn xem học phí của từng khóa bên dưới nhé. ") };
  const low = Math.min(...priced.map((p) => p.v));
  const best = priced.filter((p) => p.v === low);
  if (best.length === 1) return { state, replies: infoReply(best[0].c, "price") };
  return { state, replies: listReply(ctx, `Học phí thấp nhất hiện là ${cut(plain(best[0].c.price), 100)}, có ${best.length} khóa cùng mức này. `) };
}
const SELF_HELP_IDS = ["faq-login", "faq-video", "faq-wrong-account"];
export function aiReply(state, ai, ctx, match) {
  if (!ai || ai.route === "clarify") {
    // G-MC1-intent: the sentence mentioned a course: its card or "this course?", never the buy flow.
    const found = match && ctx.courses.find((c) => c.slug === match.slug);
    if (found) return courseFallback({ ...state, misses: 0 }, found, match.exact);
    // Gate 1b: the AI read it and found it unclear ("ok"): a customer with orders did not ask about them, so the menu.
    if (ai && ordersOf(state).length) return { state: { ...state, misses: 0 }, replies: mainMenu("", draftExtra(state)) };
    // No usable answer: the pre-AI behaviour (past orders -> pending orders, else ask once more / ticket).
    return ordersOf(state).length ? myOrders(state) : freeTextFallback(state); // G-LIVE-ux F-A1: pending + approved view
  }
  if (ai.route === "ticket") return ticket(state, "unclear");
  if (ai.route === "offer_admin") return offerAdmin(state);
  if (ai.route === "self_help") {
    const f = approvedFaq(ctx).find((x) => SELF_HELP_IDS.includes(x.id) && (ai.sources || []).includes(x.id) && x.answer);
    return f ? { state: { ...state, misses: 0 }, replies: [faqAnswer(f)] } : ticket(state, "unclear");
  }
  const fact = factReply({ ...state, misses: 0 }, ai.intent, ctx);
  if (fact) return fact;
  // G3: an answer the filter refuses is never sent, but it does not lock the conversation behind a ticket either.
  if (badAnswer(ai.answer)) return { ...offerAdmin(state), filtered: true };
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
  text: "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học), ví dụ ten@gmail.com nhé.",
  quick_replies: [{ content_type: "user_email" }]
}, T);
// G-LIVE-ux F-A8: T5, the domain looks like a typo of gmail.com. Nothing is changed without the customer's answer.
const gmailFixAsk = (fix, T) => withExits({ text: `Có phải ý bạn là ${fix} không?`, quick_replies: [{ content_type: "text", title: "Đúng, sửa lại", payload: "GMAIL_FIX" }, { content_type: "text", title: "Giữ nguyên", payload: "GMAIL_KEEP" }] }, T);
// G-LIVE-ux A6 step 9: T6, another Gmail typed at the bill step. The confirmed Gmail stays until the customer says so.
const gmailChangeAsk = (gmail) => text(`Bạn muốn đổi Gmail học thành ${gmail} không? Nếu đã chuyển khoản, bạn gửi ảnh bill như bình thường nhé.`, [["Đổi Gmail", "GMAIL_CHANGE"], ["Giữ Gmail cũ", "GMAIL_KEEPOLD"]]);
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
  // G-LIVE-ux F-A10: the account number is its own message (T10) so it is easy to copy.
  const bank = [c.bankName, c.bankOwner && `(${c.bankOwner})`].filter(Boolean).join(" ");
  if (c.bankAccount && bank) lines.push(`Chuyển khoản: ${bank}`);
  if (c.transferNote) lines.push(`Nội dung chuyển khoản: ${c.transferNote}`);
  const out = [text(lines.join("\n"))];
  if (c.bankAccount) out.push(text(String(c.bankAccount)));
  if (c.qrImageUrl) out.push({ attachment: { type: "image", payload: { url: c.qrImageUrl, is_reusable: true } } });
  out.push(billAsk(T));
  return out;
}

const titleOf = (ctx, slug) => ctx.courses.find((c) => c.slug === slug)?.title || slug;
const confirmGmail = (gmail, title, T) => text(`Đăng ký khóa "${title}" bằng Gmail ${gmail}. Đúng không?`, [["Đúng", "GMAIL_OK"], ["Sai, nhập lại", "GMAIL_NO"], ...exits(T)]);

function nextPrompt(state, ctx) {
  const T = Boolean(ctx.ticketsEnabled);
  if (!state.course) return T ? mainMenu("") : listReply(ctx, "");
  if (!state.gmail) return [state.gmailFix ? gmailFixAsk(state.gmailFix.fix, T) : gmailAsk(T)];
  if (!state.gmailOk) return [confirmGmail(state.gmail, titleOf(ctx, state.course), T)];
  return [billAsk(T)];
}

// Start (or continue) the draft for a course. Pure; the duplicate-order check is done by the caller.
export function openCourse(state, course, ctx) {
  if (state.course === course.slug) return { state, replies: nextPrompt(state, ctx) };
  // courseTitle: the title for U8.8 once the course is no longer sold (then loadCourses no longer has it).
  // opened: the course went from none/another to this one; the DO starts the 30-minute run only if none is open (SWITCH keeps it).
  return { state: { ...state, course: course.slug, courseTitle: course.title || course.slug, courseTitleFor: course.slug, gmail: null, gmailOk: false, misses: 0, draftMisses: 0, switchRef: null, gmailFix: null, gmailPending: null, billAskAt: 0 }, replies: [courseCard(course, ctx), gmailAsk(Boolean(ctx.ticketsEnabled))], opened: true };
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

// Gate 1: stickers, voice, files, video... never create anything. A draft keeps its step; a sticker with no draft needs no answer.
const UNREADABLE = "Mình chưa đọc được loại tin này";
function attachmentReply(state, event, ctx) {
  const T = Boolean(ctx.ticketsEnabled);
  const billStep = Boolean(state.course && state.gmail && state.gmailOk);
  // Gate 1b: the Admin question is still open; repeat its way out, or the next typed text (a Gmail too) becomes the ticket.
  if (state.pendingAdmin) return { state, replies: [text("Bạn nhắn bằng chữ giúp mình nhé, hoặc bấm bên dưới để gặp Admin.", [["Bỏ qua, gặp Admin", "ADMIN_SKIP"]])] };
  if (event.kind === "sticker") {
    if (!state.course && !state.greeted) return { state, replies: T ? mainMenu("") : listReply(ctx, "") }; // first contact still gets the greeting
    if (!state.course) return { state, replies: [] };
    // G-LIVE-ux A6 step 6/13: a 👍 sent next to the bill must not produce a reminder.
    return { state, replies: billStep ? (T ? [] : [text("Khi chuyển khoản xong, bạn gửi ảnh chụp bill vào đây giúp mình nhé.", exits(T))]) : nextPrompt(state, ctx) };
  }
  if (billStep) return { state, replies: [text(`${UNREADABLE}. Bạn gửi ảnh chụp bill (JPG, PNG hoặc WEBP, dưới 5MB) giúp mình nhé.`, exits(T))] };
  if (state.course) return { state, replies: [text(`${UNREADABLE}.`), ...nextPrompt(state, ctx)] };
  const intro = `${UNREADABLE}, bạn nhắn bằng chữ giúp mình nhé. `;
  return { state, replies: T ? mainMenu(intro) : listReply(ctx, intro) };
}

// GMAIL_OK (button, or a "đúng" typed at the confirmation step, F-A4).
function gmailConfirmed(state, ctx, T) {
  const course = ctx.courses.find((c) => c.slug === state.course);
  if (!course) return { state: clearDraft(state), replies: listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
  // Tickets on: the DO checks the DB for an order of this course before the transfer details (P0-1); it sets gmailOk after.
  if (T) return { state, replies: [], action: { type: "checkPayment", slug: course.slug, gmail: state.gmail } };
  return { state: { ...state, gmailOk: true }, replies: paymentInfo(course, T) };
}

// Tickets on, text with a draft open (A6 step 9). Never "chưa hiểu" at the bill step, never a ticket for not understanding.
function draftText(state, event, ctx) {
  const now = ctx.now;
  const c = clean(event.text);
  const billStep = Boolean(state.gmail && state.gmailOk);
  const match = EMAIL.exec(event.text || "");
  if (match) {
    const gmail = match[0].toLowerCase();
    if (!isValidEmail(gmail)) return { state, replies: [text("Địa chỉ email chưa đúng. Bạn kiểm tra và gửi lại nhé.")] };
    if (billStep) {
      // Same Gmail as confirmed = plain text; another one is asked about without stepping back.
      if (gmail !== state.gmail) return { state: { ...state, gmailPending: gmail }, replies: [gmailChangeAsk(gmail)] };
    } else {
      const fix = gmailTypo(gmail);
      if (fix) return { state: { ...state, gmail: null, gmailOk: false, draftMisses: 0, gmailFix: { fix, typed: gmail } }, replies: [gmailFixAsk(fix, true)] };
      const replies = [];
      if (!gmail.endsWith("@gmail.com")) replies.push(text("Lưu ý: trang học đăng nhập bằng Google. Nếu đây không phải tài khoản Google, bạn hãy gửi Gmail khác."));
      replies.push(confirmGmail(gmail, titleOf(ctx, state.course), true));
      return { state: { ...state, gmail, gmailOk: false, draftMisses: 0, gmailFix: null }, replies };
    }
  }
  // U9.3: a typed name of another course asks about switching right away (never replaces the draft).
  const named = courseNamed(ctx, event.text);
  if (named && named.slug !== state.course) return buy({ ...state, misses: 0 }, ctx, named.slug);
  if (billStep) {
    if (state.billAskAt && now - state.billAskAt < 10 * 60 * 1000) return { state, replies: [] };
    return { state: { ...state, billAskAt: now, draftMisses: 0 }, replies: [billAsk(true)] };
  }
  if (state.gmail && !state.gmailOk) {
    if (YES.test(c)) return gmailConfirmed({ ...state, draftMisses: 0 }, ctx, true);
    if (NO.test(c)) return { state: { ...state, gmail: null, gmailOk: false, draftMisses: 0 }, replies: [retryGmailAsk(true)] };
  }
  // U4: the first stray text repeats the step (with the exit buttons); the second in a row is handled as free text.
  if (state.draftMisses >= 1) return freeText({ ...state, draftMisses: 2 }, event, ctx);
  return { state: { ...state, draftMisses: 1 }, replies: nextPrompt(state, ctx) };
}

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
  state.lastInboundAt = now;
  // Open ticket: silent for every kind (text, postback, image, referral).
  if (T && ctx.activeTicket) return { state, replies: [], action: { type: "touchTicket" } };
  // P0-2: the ticket lookup failed or timed out, so an open ticket cannot be ruled out. No order, no ticket, the draft stays.
  // Quiet if an Admin wrote from the inbox within 12 hours; else one busy message (with the Admin button) per 10 minutes.
  if (T && ctx.ticketUnknown) {
    if (state.adminSeenAt && now - state.adminSeenAt < PAUSE_MS) return { state, replies: [] };
    if (!state.ticketBusyAt || now - state.ticketBusyAt >= 10 * 60 * 1000) return { state: { ...state, ticketBusyAt: now }, replies: busyAdminReplies() };
    return { state, replies: [] };
  }
  if (!T && state.pausedUntil > now) return { state, replies: [] };

  const payload = event.payload || "";
  if (payload) { state.draftMisses = 0; state.misses = 0; } // U4 / G-LIVE-ux F-A2: any button resets both counts
  // Campaign entry (m.me ref / ad): a valid, sellable course opens the buy flow, anything else the menu.
  if (event.ref) {
    const course = refCourse(event.ref, ctx);
    state.pendingAdmin = null;
    if (!course) return { state, replies: T ? mainMenu("") : listReply(ctx, "") };
    return buy(state, ctx, course.slug, { ref: event.ref });
  }
  // U2: drop the draft, keep the orders; never touches the DB.
  if (payload === "CANCEL_DRAFT") {
    return { state: { ...clearDraft(state), ref: null, pendingAdmin: null, misses: 0 }, replies: T ? mainMenu("Đã hủy đăng ký dở. ") : listReply(ctx, "Đã hủy đăng ký dở. "), closeRun: true };
  }
  if (event.kind === "sticker" || event.kind === "unsupported") return attachmentReply(state, event, ctx);
  if (T) {
    const t = ticketStep(state, event, ctx, payload);
    if (t) return t;
  }
  state.pendingAdmin = null;

  if (payload === "HUMAN" || payload === "ADMIN" || (event.kind === "text" && !payload && isHuman(event.text))) {
    state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [text(TICKET_OK_TEXT)] };
  }
  if (payload === "RESTART" || (event.kind === "text" && RESTART.test((event.text || "").trim()))) {
    return { state: { ...clearDraft(state), ref: null }, replies: listReply(ctx, ""), closeRun: true };
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
  // G-MC1-intent: "Đúng" after a typo keeps what the customer asked (read-only; no draft, no Gmail).
  if (T && payload.startsWith("INFO:")) {
    const [, slug, topic] = payload.split(":");
    const course = ctx.courses.find((c) => c.slug === slug);
    return { state, replies: course ? infoReply(course, topic) : listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
  }
  if (T && payload.startsWith("DETAIL:")) {
    const course = ctx.courses.find((c) => c.slug === payload.slice(7));
    return { state, replies: course ? detailReplies(course) : listReply(ctx, "Khóa này hiện chưa mở đăng ký. ") };
  }
  if (payload === "GMAIL_OK" && state.gmail && state.course) return gmailConfirmed(state, ctx, T);
  if (payload === "GMAIL_NO") {
    return { state: { ...state, gmail: null, gmailOk: false, gmailFix: null, gmailPending: null }, replies: [retryGmailAsk(T)] };
  }
  // G-LIVE-ux F-A8: answers to the "did you mean x@gmail.com" question (stale buttons fall through to the current step).
  if ((payload === "GMAIL_FIX" || payload === "GMAIL_KEEP") && state.course && !state.gmail && state.gmailFix) {
    const gmail = payload === "GMAIL_FIX" ? state.gmailFix.fix : state.gmailFix.typed;
    return { state: { ...state, gmail, gmailOk: false, gmailFix: null }, replies: [confirmGmail(gmail, titleOf(ctx, state.course), T)] };
  }
  // G-LIVE-ux A6 step 9: another Gmail at the bill step. Only "Đổi Gmail" moves back to the confirmation.
  if (payload === "GMAIL_CHANGE" && state.course && state.gmailOk && state.gmailPending) {
    return { state: { ...state, gmail: state.gmailPending, gmailOk: false, gmailPending: null }, replies: [confirmGmail(state.gmailPending, titleOf(ctx, state.course), T)] };
  }
  if (payload === "GMAIL_KEEPOLD" && state.course && state.gmailOk) return { state: { ...state, gmailPending: null }, replies: [billAsk(T)] };

  if (event.kind === "text") {
    if (T && state.course) return draftText(state, event, ctx);
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
    if (T) {
      // G-LIVE-ux F-A1: any text in the 30 minutes after an order is a question about it (A6 step 10).
      // A clear wish to buy a named course goes on as usual (greetings and menu words were answered above).
      if (!payload && ctx.postOrderUntil > now && !(courseNamed(ctx, event.text) && buyText(event.text))) return myOrders(state);
      return freeText(state, event, ctx);
    }
    // No draft but past orders: any message reopens Meta's 24-hour window, so answer with this sender's own
    // orders (looked up by the order ids in this conversation, never by a typed Gmail).
    if (!state.course && state.orders.length) return listOrders(state);
    return { state, replies: nextPrompt(state, ctx) };
  }

  if (event.kind === "image") {
    // Gate 1: with orders and no draft the image may be the real bill: the DO checks for a pending order and tells the Admin.
    if (!state.course && state.orders.length) return T ? { state, replies: [], action: { type: "extraImage" } } : listOrders(state);
    // G-LIVE-ux F-A11 (T4): no draft and no order to attach it to: never an order, the customer chooses Admin.
    if (T && !state.course) return { state, replies: [text("Mình chưa biết ảnh này thuộc đơn đăng ký nào. Nếu đây là bill chuyển khoản, bạn bấm Chat với Admin để được kiểm tra nhé.", [["Chat với Admin", "ADMIN"], ["Quay lại menu", "MENU"]])] };
    if (!state.course || !state.gmail || !state.gmailOk) return { state, replies: nextPrompt(state, ctx) };
    return { state: { ...state, gmailPending: null }, replies: [], action: { type: "createOrder", url: event.url } };
  }

  return { state, replies: nextPrompt(state, ctx) };
}

// U6/B7: with tickets on, the receipt carries the "Đơn chờ duyệt" button.
export const orderCreatedReply = (T = true) => text("Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản. Khi được duyệt, mình sẽ nhắn bạn cách vào học.", T ? [PENDING_BTN] : []);
export const orderFailedReply = () => text("Mình chưa ghi nhận được bill (ảnh phải là JPG/PNG/WEBP dưới 5MB). Bạn gửi lại ảnh khác, hoặc nhắn \"gặp người\" để Admin hỗ trợ.");
// Gate 1: failures that are not about the image must not ask for another image.
export const orderSystemFailedReply = () => text("Hệ thống chưa tạo được đơn. Bạn thử gửi lại ảnh bill sau ít phút, hoặc nhắn \"gặp người\" để Admin hỗ trợ.");
export const billRefusedReply = (ticketOpened) => text(`Mình đã nhận ảnh bill, nhưng khóa này hiện chưa nhận đăng ký nên chưa tạo được đơn. ${ticketOpened ? "Mình đã chuyển Admin kiểm tra giúp bạn." : "Bạn nhắn \"gặp người\" để Admin kiểm tra giúp nhé."} Bạn chưa cần chuyển khoản thêm.`);
// C4-2: the order could not be confirmed in time; it may still appear. Never ask for a second payment.
export const billSlowReply = (ticketOpened) => text(`Mình đã nhận ảnh bill nhưng hệ thống đang xử lý chậm nên chưa xác nhận được đơn. ${ticketOpened ? "Mình đã chuyển Admin kiểm tra giúp bạn." : "Bạn nhắn \"gặp người\" để Admin kiểm tra giúp nhé."} Bạn chưa cần chuyển khoản lại.`);
export const extraImageReply = () => text("Mình đã nhận thêm ảnh của bạn và chuyển Admin kiểm tra.");
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

// ---- G-LIVE-ux: T1 (the 30-minute handoff), T7 / T8 (orders of this PSID) ----
export const HANDOFF_TEXT = "Đã hết thời gian đăng ký tự động (30 phút). Mình đã chuyển Admin hỗ trợ bạn tiếp trong cuộc trò chuyện này. Nếu bạn đã chuyển khoản, bạn cứ gửi ảnh bill vào đây để Admin kiểm tra, không cần chuyển khoản lại.";
export const NO_ORDERS_TEXT = "Mình chưa thấy đơn nào của bạn trên Messenger. Nếu bạn đã chuyển khoản hoặc đã mua trước đây, bạn bấm Chat với Admin để được kiểm tra nhé.";
// verified / unverified (R1/R2): [{ title, status, createdAt, email }]. Only the customer's own verified orders show a Gmail.
export function myOrdersReplies(verified, unverified, lmsUrl) {
  const btns = [adminBtn(true), ["Đăng ký khóa khác", "LIST_OTHER"], ["Quay lại menu", "MENU"]];
  if (!verified.length && !unverified.length) return [text(NO_ORDERS_TEXT, [adminBtn(true), ["Quay lại menu", "MENU"]])];
  if (!verified.length) return [text(UNVERIFIED_TEXT, [adminBtn(true), ["Quay lại menu", "MENU"]])];
  const lms = String(lmsUrl || "").replace(/\/$/, "");
  const lines = verified.map((o) => (o.status === "Đã duyệt"
    ? `${o.title} — Đã duyệt: vào ${lms}/my-courses.html, đăng nhập Google bằng ${o.email}`
    // The customer's own order (PSID-scoped), so its Gmail can be shown: they can check what they typed (Owner 14/11).
    : `${o.title} — Chờ duyệt (gửi bill ${dmy(o.createdAt)}${o.email ? `, Gmail ${o.email}` : ""})`));
  const parts = [["Đơn của bạn:"]];
  for (const line of lines) {
    const cur = parts.at(-1);
    if (cur.join("\n").length + line.length > 1700) parts.push([line]); else cur.push(line);
  }
  const texts = parts.map((p) => p.join("\n"));
  if (unverified.length) texts[texts.length - 1] += `\n\n${UNVERIFIED_TEXT}`;
  return texts.map((t, i) => text(t, i === texts.length - 1 ? btns : []));
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

// Main menu as a button template: phones show quick replies as one row to swipe, template buttons stack vertically.
// Meta allows 3 buttons; a 4th and later option stays a quick reply. Postback payloads are handled like quick reply ones.
export function menuMessage(t, options) {
  const buttons = options.slice(0, 3).map(([title, payload]) => ({ type: "postback", title, payload }));
  const msg = { attachment: { type: "template", payload: { template_type: "button", text: cut(t, 640), buttons } } };
  return options.length > 3 ? { ...msg, quick_replies: quickOf(options.slice(3)) } : msg;
}

// view = { pendingMenu: "show" | "hide" | "unknown", pendingSlugs: Set, doOrderIds: [id] }
export function renderReplies(replies, view, ctx) {
  return replies.flatMap((r) => {
    if (r.menu) {
      const { intro, extra = [], ask = true } = r.menu;
      const options = menuButtons(view.pendingMenu, (view.doOrderIds || []).length > 0, extra);
      const t = `${intro}${ask ? "Bạn cần mình giúp gì?" : ""}`;
      // A template text holds 640 characters (a long order summary does not): send the intro as plain text first.
      return t.length <= 640 ? [menuMessage(t, options)] : [text(intro), menuMessage("Bạn cần mình giúp gì?", options)];
    }
    if (r.courses) return courseList(r.courses, view, ctx);
    return [r];
  });
}
export const hasPlaceholder = (replies) => replies.some((r) => r.menu || r.courses);
