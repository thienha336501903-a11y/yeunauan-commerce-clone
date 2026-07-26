import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT || 4173);
const salesSite = process.env.SALES_SITE === "yeunauan" ? "yeunauan" : "yeubep";
const adminPassword = process.env.ADMIN_PASSWORD || "local-admin";
const hosts = { yeunauan: "yeubep.shop", yeubep: "shop.yeunauan.live" };
const courses = [
  { id: "canonical-1", slug: "thitxiennuongchaungoc", courseName: "Thịt xiên nướng Châu Ngọc", title: "Thịt xiên nướng Châu Ngọc", price: "299.000đ", sales_site: "yeunauan", active: true, sort_order: 0, learning_lesson_count: 4 },
  { id: "alias-1", slug: "thitxiennuongchaungoc-yeubep", courseName: "Thịt xiên nướng Châu Ngọc", title: "Thịt xiên nướng Châu Ngọc", price: "299.000đ", sales_site: "yeubep", active: true, sort_order: 2, learning_course_slug: "thitxiennuongchaungoc", learning_lesson_count: 4 },
  { id: "legacy-1", slug: "legacy-demo", courseName: "Legacy Yeunauan", title: "Legacy Yeunauan", price: "199.000đ", sales_site: "yeunauan", active: true, sort_order: 1 },
  { id: "yeubep-1", slug: "yeubep-demo", courseName: "Yeubep Preview", title: "Yeubep Preview", price: "299.000đ", sales_site: "yeubep", active: true, sort_order: 1 }
];
const orders = [];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function adminOk(req) {
  return req.headers["x-admin-password"] === adminPassword;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/config") {
    const slug = url.searchParams.get("course") || "yeubep-demo";
    const course = courses.find((item) => item.slug === slug && item.active && item.sales_site === salesSite);
    return course
      ? json(res, 200, { course: course.slug, courseName: course.title, price: course.price, imageUrl: "", bankName: "STUB", bankAccount: "000000", bankOwner: "LOCAL ONLY", transferNote: "STUB", qrImageUrl: "" })
      : json(res, 404, { error: "Không tìm thấy khóa học" });
  }
  if (url.pathname === "/api/courses") {
    if (!adminOk(req)) return json(res, 401, { error: "Unauthorized" });
    if (req.method === "GET") return json(res, 200, courses.map((course) => ({ ...course, sales_url: `https://${hosts[course.sales_site]}/?course=${course.slug}` })));
    const input = await body(req);
    if (!["yeunauan", "yeubep"].includes(input.sales_site)) return json(res, 400, { error: "sales_site không hợp lệ" });
    const existing = courses.find((course) => course.id === input.id);
    const row = { ...(existing || {}), ...input, id: existing?.id || randomUUID(), title: input.courseName };
    if (existing) Object.assign(existing, row); else courses.push(row);
    return json(res, existing ? 200 : 201, { success: true, data: row });
  }
  if (url.pathname === "/api/orders") {
    if (!adminOk(req)) return json(res, 401, { error: "Unauthorized" });
    if (req.method === "GET") return json(res, 200, orders);
    const input = await body(req);
    const order = orders.find((item) => item.id === input.id);
    if (!order) return json(res, 404, { error: "Không tìm thấy đơn" });
    Object.assign(order, input);
    return json(res, 200, { success: true, data: order });
  }
  if (url.pathname === "/api/register" && req.method === "POST") {
    const input = await body(req);
    const key = req.headers["idempotency-key"];
    const course = courses.find((item) => item.slug === input.course && item.active && item.sales_site === salesSite);
    if (!course) return json(res, 404, { error: "Không tìm thấy khóa học thuộc website này" });
    const duplicate = orders.find((item) => item.idempotency_key === key && item.sales_site === salesSite);
    if (duplicate) return json(res, 200, { success: true, duplicate: true, orderId: duplicate.id });
    const order = {
      id: randomUUID(), course: course.slug, courseName: course.title, gmail: input.gmail,
      course_slug: course.slug, course_title: course.title, customer_email: input.gmail,
      learning_course_slug: course.learning_course_slug || course.slug,
      status: "Chờ duyệt", sales_site: salesSite, sales_host: hosts[salesSite],
      price_snapshot: course.price, idempotency_key: key, created_at: new Date().toISOString()
    };
    orders.push(order);
    return json(res, 200, { success: true, orderId: order.id, course: course.slug, courseName: course.title, dryRun: true });
  }
  if (url.pathname === "/api/approve-all" && req.method === "POST") {
    if (!adminOk(req)) return json(res, 401, { error: "Unauthorized" });
    const input = await body(req);
    const selected = orders.filter((item) => item.course === input.course && item.sales_site === input.sales_site && item.status === "Chờ duyệt");
    selected.forEach((item) => {
      item.status = "Đã duyệt";
      item.dry_run_sync = { action: "syncEnrollment", email: item.gmail.trim().toLowerCase(), courseSlug: item.learning_course_slug || item.course };
    });
    return json(res, 200, { success: true, count: selected.length, gmails: selected.map((item) => item.gmail), dryRun: true });
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = normalize(join(root, requested));
  if (!file.startsWith(normalize(root))) return json(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(file);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(content);
  } catch {
    json(res, 404, { error: "Not found" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local tenant stub: http://127.0.0.1:${port} (SALES_SITE=${salesSite}, admin=${adminPassword})`);
});
