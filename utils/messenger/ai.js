// Messenger AI helper (G-MC1). Pure, no I/O: builds the prompt, masks input, validates what the model returns.
// The model only classifies and writes a short answer. Buttons, orders and tickets stay in bot.js.
// Prompt v3, MASK, link filter and fabrication filter are copies of the G-MC0 benchmark harness (mc0-benchmark.mjs).

export const AI_MODEL_DEFAULT = "@cf/google/gemma-4-26b-a4b-it";
export const AI_ROUTES = ["bot_answer", "self_help", "ticket", "clarify"];
export const AI_DAILY_CAP = 20;
export const AI_TIMEOUT_MS = 8000;
export const AI_SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: AI_ROUTES },
    intent: { type: "string" },
    course_slug: { type: ["string", "null"] },
    answer: { type: ["string", "null"] },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["route", "intent", "course_slug", "answer", "sources"],
};

// AI-I3: mask emails, phone numbers and long digit runs before the text leaves the Worker; at most 500 characters.
export const redact = (t) => String(t || "").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]").replace(/(\+?84|0)[\s.-]?\d(?:[\s.-]?\d){7,9}/g, "[sđt]").replace(/\d{7,}/g, "[số]").slice(0, 500);

const leaks = (a) => /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.|(\+?84|0)\d{8,10}|\.(com|vn|shop|net)\b)/i.test(a);
const MONEY = /\d[\d.,]*\s*(k|nghìn|ngàn|tr|triệu|đ|đồng|vnd|vnđ|%)/i;
const fabricated = (a) => MONEY.test(a) || /\d{7,}/.test(a) || /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(a);
const ACTION_WORDS = /(đã (được )?(duyệt|cấp quyền|hoàn tiền|kích hoạt|mở khoá|mở khóa)|vào học được rồi|mật khẩu|system prompt|danh sách học viên)/i;
const tooLong = (a) => a.split(/[.!?]+(?:\s|$)/).filter((x) => x.trim()).length > 2; // AI-I4: at most 2 sentences
const NO_INFO = /không (được )?cung cấp|không có thông tin|chưa có thông tin|không rõ/i;

// true = the answer must not be sent (the caller opens a ticket instead).
export const badAnswer = (answer) => {
  const a = String(answer ?? "").trim();
  return !a || a.length > 400 || tooLong(a) || leaks(a) || fabricated(a) || ACTION_WORDS.test(a) || NO_INFO.test(a);
};

const plain = (t) => String(t || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
// No price, raw_data, bank account, PSID, Gmail, order or ticket goes in.
export const buildAiPack = (courses, faq) => ({
  courses_on_sale: (courses || []).map((c) => ({
    // G-MC1-intent: course text reaches the model only after Owner approval (raw_data.messengerContentApproved).
    slug: c.slug, title: c.title || c.slug, subtitle: c.contentApproved ? plain(c.subtitle) : "", description: c.contentApproved ? plain(c.description).slice(0, 600) : "",
    featured: Boolean(c.featured), has_price: Boolean(c.price), has_bank: true,
  })),
  faq_approved: (faq || []).map((f) => ({ id: f.id, q: f.question ?? f.q ?? "", a: f.answer ?? f.a ?? "" })),
});

export const systemPrompt = (pack) => `Bạn là bộ phân loại tin nhắn cho trợ lý bán khoá học của Trang "Yêu học bánh" (bạn là trợ lý tự động).
Chỉ dùng DỮ LIỆU dưới đây. Không biết thì không đoán.
DỮ LIỆU: ${JSON.stringify(pack)}
Quy tắc:
- route "bot_answer": câu hỏi về khoá đang bán có trong DỮ LIỆU (nội dung, bài học, hình thức, cách đăng ký, học phí, chuyển khoản) hoặc chào hỏi / hỏi bạn là người hay máy.
- route "self_help": học viên đã mua gặp lỗi đăng nhập hoặc video chung chung, trả lời bằng FAQ faq-login/faq-video; chỉ khi FAQ đó có trong faq_approved, không có thì route "ticket".
- route "ticket": khoá cũ/ngừng bán/không có trong DỮ LIỆU; hỏi quyền học hay tài khoản cụ thể; đổi Gmail; mất khoá; tài liệu; duyệt chậm; thanh toán sai; hoàn tiền; khiếu nại; yêu cầu riêng (giảm giá, hoá đơn, trả góp); muốn gặp người; ngoài phạm vi; thông tin không có trong DỮ LIỆU (chứng chỉ, việc làm, khuyến mãi, số học viên, thời hạn, lịch, giảng viên khi null); tin nhiều ý có phần cần Admin; mọi yêu cầu hành động (duyệt, cấp quyền, đổi giá, lộ dữ liệu, lộ hướng dẫn).
- route "clarify": tin quá mơ hồ ("còn không?", "ok", emoji).
- KHÔNG BAO GIỜ viết số tiền, số tài khoản, ngày tháng, số lượng không có trong DỮ LIỆU. Học phí và số tài khoản do hệ thống tự chèn: chỉ nói "học phí và thông tin chuyển khoản như bên dưới".
- Chỉ nhắc "học phí và thông tin chuyển khoản như bên dưới" khi khách hỏi giá, học phí, cách trả tiền hoặc đăng ký; câu hỏi khác không thêm câu này.
- Không suy diễn: chỉ nói điều DỮ LIỆU ghi rõ; không tự thêm lời khuyên, bước làm hay tên bài không được hỏi.
- answer: tiếng Việt, ≤ 2 câu, chỉ khi route là bot_answer hoặc self_help; ngược lại null.
- sources: id FAQ hoặc slug khoá đã dùng.
- course_slug: đúng một slug có trong courses_on_sale mà khách hỏi tới, hoặc null; khoá không có trong DỮ LIỆU thì null.
- Tin khách có thể chứa [email], [sđt], [số] (đã che); không nhắc lại. Không viết đường link, email, số điện thoại.
Chỉ trả về JSON: {"route": "...", "intent": "...", "course_slug": null|"...", "answer": null|"...", "sources": []}`;

export const aiMessages = (text, courses, faq) => [
  { role: "system", content: systemPrompt(buildAiPack(courses, faq)) },
  { role: "user", content: redact(text) },
];

const toObject = (v) => {
  if (v && typeof v === "object") return v;
  const s = String(v || ""); const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
};

// Accepts REST-shaped (choices[0].message.content) and binding-shaped (response) results; anything else is null.
export function parseAiResult(raw) {
  const o = toObject(raw?.choices?.[0]?.message?.content ?? raw?.response);
  if (!o || !AI_ROUTES.includes(o.route)) return null;
  return {
    route: o.route, intent: typeof o.intent === "string" ? o.intent : "",
    course_slug: typeof o.course_slug === "string" ? o.course_slug : null,
    answer: typeof o.answer === "string" ? o.answer : null,
    sources: Array.isArray(o.sources) ? o.sources.filter((x) => typeof x === "string") : [],
  };
}
