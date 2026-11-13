// The privacy page Meta needs before the App can be published: one static page, true to what the code collects.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPublic } from "../scripts/build-vercel-public.mjs";

const root = path.resolve(import.meta.dirname, "..");
const html = readFileSync(path.join(root, "chinh-sach.html"), "utf8");

test("PRIV-1 the page is published with the other root pages", () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "priv-")), "public");
  assert.ok(buildPublic(root, out).includes("chinh-sach.html"));
});

test("PRIV-2 static only: no script, no form, no external resource, no placeholder left", () => {
  assert.doesNotMatch(html, /<script|<form|<iframe|<img|<link\b/i);
  assert.doesNotMatch(html, /\b(src|href)=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /\{\{|\}\}|TODO|CHƯA/);
});

test("PRIV-3 it says what is collected, why, for how long, and how to ask for deletion", () => {
  for (const id of ["du-lieu", "muc-dich", "ben-xu-ly", "thoi-gian-luu", "xoa-du-lieu"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /mã định danh Messenger/);
  assert.match(html, /địa chỉ Gmail bạn dùng để học và ảnh chứng từ chuyển khoản/);
  assert.match(html, /Ảnh chứng từ có thể chứa họ tên và số tài khoản của người chuyển/);
  for (const processor of ["Meta", "Cloudflare", "Supabase", "Cloudinary", "Google"]) assert.ok(html.includes(processor), processor);
  assert.match(html, /12 tháng sau đó/);
  assert.match(html, /“xoá dữ liệu”[\s\S]*72 giờ/);
});

test("PRIV-4 it claims nothing the system does not do, and publishes no personal contact detail", () => {
  assert.doesNotMatch(html, /trợ lý tự động|trí tuệ nhân tạo|\bAI\b/i, "AI is off at launch: add the paragraph back when it is turned on");
  assert.doesNotMatch(html, /không thu số tài khoản/);
  assert.doesNotMatch(html, /@[a-z0-9-]+\.[a-z]/i, "no e-mail address");
  assert.doesNotMatch(html, /(\+?84|0)\d{8,10}/, "no phone number");
  assert.doesNotMatch(html, /hoàn tiền/i, "refunds are not a privacy matter and are not promised here");
});
