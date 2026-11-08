// Messenger sales bot conversation (H4). Pure: (state, event, ctx) -> { state, replies, action }.
// The bot only collects course + Gmail + bill and creates a "Chờ duyệt" order; payment is checked by a human
// in Admin, and access is granted only by the existing approval path (approveV5Order -> /api/v5-sync).
// It never reports order or enrollment status for a typed Gmail, so typing someone else's Gmail reveals nothing.

export const PAUSE_MS = 12 * 60 * 60 * 1000;
// Owner text (06/11). Says it is an automated assistant, as Meta policy requires.
const GREETING = "Chào bạn! 👋 Mình là trợ lý tự động của Yêu Bếp. Mình sẽ giúp bạn chọn khóa học, xem học phí và hướng dẫn đăng ký. Sau khi bạn gửi ảnh chuyển khoản, Admin sẽ kiểm tra và xác nhận để cấp quyền học.\n\n";
const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/i;
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[^\x00-\x7F]/.test(email); // = website
const HUMAN = /(gặp|nói chuyện|chat).{0,12}(người|admin|nhân viên)|tư vấn viên/i;
const RESTART = /^(khóa|khoá) khác$|^bắt đầu lại$/i;
// "menu" only shows the menu: it keeps the conversation (course, Gmail, orderId), unlike RESTART.
// MENU and GREET are matched against clean(text): no accents, punctuation or emoji.
const MENU = /^menu( a)?$/;
// Greetings: "Hi!", "Chào shop", "xin chào ạ", "shop ơi", "dạ chào bạn ơi".
const GREET = /^(da )?((hi+|hello|helo|hey|alo+|xin chao|chao)( (ban|shop|ad|admin|em|anh|chi))?|shop|ad|admin)( oi)?( a)?$/;

// Ticket replies (Owner text D, 07/11). Used by the DO after it knows whether the ticket was written.
export const TICKET_OK_TEXT = "Mình đã chuyển câu hỏi của bạn tới Admin. Admin sẽ trả lời bạn trực tiếp trong cuộc trò chuyện này.";
export const TICKET_FAIL_TEXT = "Hệ thống chưa ghi nhận được yêu cầu. Admin vẫn đọc được tin nhắn này trong Hộp thư của Trang và sẽ trả lời bạn.";
export const ticketReply = (ok) => ({ text: ok ? TICKET_OK_TEXT : TICKET_FAIL_TEXT });

export const emptyState = () => ({ course: null, gmail: null, gmailOk: false, orderId: null, pausedUntil: 0, greeted: false });

const text = (t, quick = []) => (quick.length
  ? { text: t, quick_replies: quick.map(([title, payload]) => ({ content_type: "text", title: title.slice(0, 20), payload })) }
  : { text: t });

function menu(ctx, intro) {
  if (!ctx.courses.length) return [text(`${intro}Hiện chưa có khoá nào mở đăng ký qua Messenger. Bạn nhắn "gặp người" để Admin hỗ trợ nhé.`)];
  const quick = ctx.courses.slice(0, 12).map((c) => [c.title || c.slug, `COURSE:${c.slug}`]);
  quick.push(["Gặp người thật", "HUMAN"]);
  return [text(`${intro}Bạn muốn đăng ký khoá nào?`, quick)];
}

// Menu with tickets on (M-A). "Gặp Admin" is always one tap away.
const MENU4 = [["Xem khoá đang bán", "MENU_COURSES"], ["Tôi đã mua khoá", "MENU_BOUGHT"], ["Câu hỏi thường gặp", "MENU_FAQ"], ["Gặp Admin", "HUMAN"]];
const mainMenu = (intro) => [text(`${intro}Bạn cần mình giúp gì?`, MENU4)];
const norm = (t) => String(t || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
const clean = (t) => norm(t).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ticket = (state, reason) => ({ state: { ...state, misses: 0 }, replies: [], action: { type: "openTicket", reason } });
const faqAnswer = (f) => text(f.answer, [["Gặp Admin", "HUMAN"]]);
// Only FAQ the Owner approved are ever sent (faq.json entries start as "draft").
const approvedFaq = (ctx) => (ctx.faq || []).filter((f) => f.status === "approved");

// Tickets on: payload/keyword handling that replaces the H4 pause. Returns null when the event is not ours.
function ticketStep(state, event, ctx, payload) {
  const isText = event.kind === "text";
  const base = { ...state, misses: 0 };
  const faq = approvedFaq(ctx);
  if (payload === "HUMAN" || (isText && HUMAN.test(event.text || ""))) return ticket(state, "human");
  if (payload === "RESTART" || (isText && RESTART.test((event.text || "").trim()))) {
    return { state: { ...emptyState(), greeted: state.greeted }, replies: mainMenu("") };
  }
  if (isText && MENU.test(clean(event.text))) return { state: base, replies: mainMenu("") };
  if (payload === "GET_STARTED") return { state: base, replies: mainMenu(GREETING) };
  if (payload === "MENU_COURSES") return { state: base, replies: menu(ctx, "") };
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

// Tickets on, free text while no course is chosen: FAQ keyword or course name, else ask once more, then ticket.
function freeText(state, event, ctx) {
  const q = norm(event.text);
  // A greeting is not a miss: show the menu and keep the counter at 0.
  if (GREET.test(clean(event.text))) return { state: { ...state, misses: 0 }, replies: mainMenu("") };
  const hit = approvedFaq(ctx).find((f) => (f.keywords || []).some((k) => k && q.includes(k)));
  if (hit) return hit.answer ? { state: { ...state, misses: 0 }, replies: [faqAnswer(hit)] } : ticket(state, "unclear");
  const course = ctx.courses.find((c) => (norm(c.title).length >= 4 && q.includes(norm(c.title))) || q.includes(String(c.slug).toLowerCase()));
  if (course) return { state: { ...state, course: course.slug, gmail: null, gmailOk: false, misses: 0 }, replies: courseInfo(course) };
  if ((state.misses || 0) >= 1) return ticket(state, "unclear");
  return { state: { ...state, misses: 1 }, replies: mainMenu("Mình chưa hiểu ý bạn. ") };
}

function courseInfo(c) {
  const lines = [`Khoá: ${c.title || c.slug}`];
  if (c.price) lines.push(`Học phí: ${c.price}`);
  if (c.bankAccount) lines.push(`Chuyển khoản: ${[c.bankName, c.bankAccount, c.bankOwner && `(${c.bankOwner})`].filter(Boolean).join(" ")}`);
  if (c.transferNote) lines.push(`Nội dung chuyển khoản: ${c.transferNote}`);
  const out = [text(lines.join("\n"))];
  if (c.qrImageUrl) out.push({ attachment: { type: "image", payload: { url: c.qrImageUrl, is_reusable: true } } });
  out.push(text("Bạn gửi giúp mình Gmail dùng để học (đăng nhập Google trên trang học)."));
  return out;
}

function nextPrompt(state, ctx) {
  if (!state.course) return menu(ctx, "");
  if (!state.gmail) return [text("Bạn gửi giúp mình Gmail dùng để học nhé.")];
  if (!state.gmailOk) return [confirmGmail(state.gmail)];
  if (!state.orderId) return [text("Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé.")];
  return [text(`Đơn của bạn đang chờ Admin xác nhận${ctx.approveSla ? ` (thường trong ${ctx.approveSla})` : ""}. Muốn đăng ký khoá khác, bấm "Khoá khác".`, [["Khoá khác", "RESTART"]])];
}

const confirmGmail = (gmail) => text(`Gmail học của bạn là: ${gmail}\nĐúng không?`, [["Đúng", "GMAIL_OK"], ["Sai, nhập lại", "GMAIL_NO"]]);

// event: { kind: "text", text, payload? } | { kind: "postback", payload } | { kind: "image", url } | { kind: "echo", fromThisApp }
// The first reply in a conversation always carries the greeting, which says the bot is automated.
export function step(prev, event, ctx) {
  const out = stepInner(prev, event, ctx);
  // A customer ticket gets its reply from the DO after the insert; the greeting must still come first.
  const answersLater = out.action?.type === "openTicket" && out.action.reason !== "admin_reply";
  if (prev?.greeted || (!out.replies.length && !answersLater)) return out;
  const first = out.replies[0];
  const replies = first?.text?.startsWith(GREETING) ? out.replies : [text(GREETING.trim()), ...out.replies];
  return { ...out, state: { ...out.state, greeted: true }, replies };
}

function stepInner(prev, event, ctx) {
  const state = { ...emptyState(), ...prev };
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
  if (T && ctx.activeTicket) return { state, replies: [], action: { type: "touchTicket" } };
  if (!T && state.pausedUntil > now) return { state, replies: [] };

  const payload = event.payload || "";
  if (T) {
    const t = ticketStep(state, event, ctx, payload);
    if (t) return t;
  }
  if (payload === "HUMAN" || (event.kind === "text" && HUMAN.test(event.text || ""))) {
    state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [text("Mình đã chuyển cho Admin. Admin sẽ trả lời bạn ngay khi có thể.")] };
  }
  if (payload === "RESTART" || (event.kind === "text" && RESTART.test((event.text || "").trim()))) {
    return { state: { ...emptyState(), greeted: state.greeted }, replies: menu(ctx, "") };
  }
  if (event.kind === "text" && MENU.test(clean(event.text))) return { state, replies: menu(ctx, "") };
  if (payload === "GET_STARTED") {
    return { state, replies: menu(ctx, GREETING) };
  }
  if (payload.startsWith("COURSE:")) {
    if (state.orderId) return { state, replies: nextPrompt(state, ctx) };
    const course = ctx.courses.find((c) => c.slug === payload.slice(7));
    if (!course) return { state, replies: menu(ctx, "Khoá này hiện không mở đăng ký. ") };
    return { state: { ...state, course: course.slug, gmail: null, gmailOk: false }, replies: courseInfo(course) };
  }
  if (payload === "GMAIL_OK" && state.gmail) {
    state.gmailOk = true;
    return { state, replies: [text("Cảm ơn bạn! Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé.")] };
  }
  if (payload === "GMAIL_NO") {
    return { state: { ...state, gmail: null, gmailOk: false }, replies: [text("Bạn gửi lại Gmail dùng để học nhé.")] };
  }

  if (event.kind === "text") {
    // After an order, any message reopens Meta's 24-hour window: answer with this sender's own order status
    // (looked up by the order id in this conversation, never by a typed Gmail).
    if (state.orderId) return { state, replies: [], action: { type: "orderStatus", orderId: state.orderId } };
    const match = EMAIL.exec(event.text || "");
    if (match && state.course && !state.orderId) {
      const gmail = match[0].toLowerCase();
      if (!isValidEmail(gmail)) return { state, replies: [text("Địa chỉ email chưa đúng. Bạn kiểm tra và gửi lại nhé.")] };
      const replies = [];
      if (!gmail.endsWith("@gmail.com")) replies.push(text("Lưu ý: trang học đăng nhập bằng Google. Nếu đây không phải tài khoản Google, bạn hãy gửi Gmail khác."));
      replies.push(confirmGmail(gmail));
      return { state: { ...state, gmail, gmailOk: false }, replies };
    }
    if (T && !state.course) return freeText(state, event, ctx);
    return { state, replies: nextPrompt(state, ctx) };
  }

  if (event.kind === "image") {
    if (!state.course || !state.gmail || !state.gmailOk || state.orderId) return { state, replies: nextPrompt(state, ctx) };
    return { state, replies: [], action: { type: "createOrder", url: event.url } };
  }

  return { state, replies: nextPrompt(state, ctx) };
}

export const orderCreatedReply = (ctx) => text(`Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản${ctx.approveSla ? ` (thường trong ${ctx.approveSla})` : ""}. Khi được duyệt, mình sẽ nhắn bạn cách vào học.`);
export const orderFailedReply = () => text("Mình chưa ghi nhận được bill (ảnh phải là JPG/PNG/WEBP dưới 5MB). Bạn gửi lại ảnh khác, hoặc nhắn \"gặp người\" để Admin hỗ trợ.");
export const approvedMessage = ({ courseTitle, gmail, lmsUrl }) =>
  `Đơn khoá "${courseTitle}" đã được duyệt. Bạn vào ${lmsUrl.replace(/\/$/, "")}/my-courses.html, đăng nhập Google bằng ${gmail} để học nhé.`;

export function orderStatusReplies(order, ctx) {
  if (order?.status === "Đã duyệt") {
    return [text(approvedMessage({ courseTitle: order.course_title || order.course_slug, gmail: order.customer_email, lmsUrl: ctx.lmsUrl }), [["Khoá khác", "RESTART"]])];
  }
  if (order?.status === "Chờ duyệt") {
    return [text(`Đơn của bạn đang chờ Admin xác nhận${ctx.approveSla ? ` (trong vòng ${ctx.approveSla} kể từ khi gửi bill)` : ""}. Muốn đăng ký khoá khác, bấm "Khoá khác".`, [["Khoá khác", "RESTART"], ["Gặp người thật", "HUMAN"]])];
  }
  return [text("Đơn của bạn chưa được duyệt. Bạn bấm \"Gặp người thật\" để Admin hỗ trợ nhé.", [["Gặp người thật", "HUMAN"], ["Khoá khác", "RESTART"]])];
}
