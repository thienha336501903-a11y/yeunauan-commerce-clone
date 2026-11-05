// Messenger sales bot conversation (H4). Pure: (state, event, ctx) -> { state, replies, action }.
// The bot only collects course + Gmail + bill and creates a "Chờ duyệt" order; payment is checked by a human
// in Admin, and access is granted only by the existing approval path (approveV5Order -> /api/v5-sync).
// It never reports order or enrollment status for a typed Gmail, so typing someone else's Gmail reveals nothing.

export const PAUSE_MS = 12 * 60 * 60 * 1000;
const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/i;
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[^\x00-\x7F]/.test(email); // = website
const HUMAN = /(gặp|nói chuyện|chat).{0,12}(người|admin|nhân viên)|tư vấn viên/i;
const RESTART = /^(khóa|khoá) khác$|^bắt đầu lại$|^menu$/i;

export const emptyState = () => ({ course: null, gmail: null, gmailOk: false, orderId: null, pausedUntil: 0 });

const text = (t, quick = []) => (quick.length
  ? { text: t, quick_replies: quick.map(([title, payload]) => ({ content_type: "text", title: title.slice(0, 20), payload })) }
  : { text: t });

function menu(ctx, intro) {
  if (!ctx.courses.length) return [text(`${intro}Hiện chưa có khoá nào mở đăng ký qua Messenger. Bạn nhắn "gặp người" để Admin hỗ trợ nhé.`)];
  const quick = ctx.courses.slice(0, 12).map((c) => [c.title || c.slug, `COURSE:${c.slug}`]);
  quick.push(["Gặp người thật", "HUMAN"]);
  return [text(`${intro}Bạn muốn đăng ký khoá nào?`, quick)];
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
export function step(prev, event, ctx) {
  const state = { ...emptyState(), ...prev };
  const now = ctx.now;

  if (event.kind === "echo") {
    // A human replied from the Page inbox: stay silent for 12 hours. Our own sends echo back with our app id.
    if (!event.fromThisApp) state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [] };
  }
  if (state.pausedUntil > now) return { state, replies: [] };

  const payload = event.payload || "";
  if (payload === "HUMAN" || (event.kind === "text" && HUMAN.test(event.text || ""))) {
    state.pausedUntil = now + PAUSE_MS;
    return { state, replies: [text("Mình đã chuyển cho Admin. Admin sẽ trả lời bạn ngay khi có thể.")] };
  }
  if (payload === "RESTART" || (event.kind === "text" && RESTART.test((event.text || "").trim()))) {
    return { state: { ...emptyState() }, replies: menu(ctx, "") };
  }
  if (payload === "GET_STARTED") {
    return { state, replies: menu(ctx, "Chào bạn! Mình là trợ lý tự động của trang. ") };
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
    const match = EMAIL.exec(event.text || "");
    if (match && state.course && !state.orderId) {
      const gmail = match[0].toLowerCase();
      if (!isValidEmail(gmail)) return { state, replies: [text("Địa chỉ email chưa đúng. Bạn kiểm tra và gửi lại nhé.")] };
      const replies = [];
      if (!gmail.endsWith("@gmail.com")) replies.push(text("Lưu ý: trang học đăng nhập bằng Google. Nếu đây không phải tài khoản Google, bạn hãy gửi Gmail khác."));
      replies.push(confirmGmail(gmail));
      return { state: { ...state, gmail, gmailOk: false }, replies };
    }
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
