// SYSTEM B commerce on Cloudflare Workers (H1, 03/11/2026): same handlers as Vercel, no rewrite.
// Routing, redirect and security headers are read from the repo's vercel.json so the two hosts cannot drift.
// Static pages come from the ASSETS binding (built by scripts/build-assets.mjs with the Vercel build step).
// Lives apart from index.js because a Worker entry module may export only handlers.

import vercelConfig from "../../../vercel.json" with { type: "json" };
import { runCompatHandler } from "./http-compat.js";
import approveAll from "../../../api/approve-all.js";
import checkAuth from "../../../api/check-auth.js";
import config from "../../../api/config.js";
import courses from "../../../api/courses.js";
import health from "../../../api/health.js";
import hero from "../../../api/hero.js";
import orders from "../../../api/orders.js";
import register from "../../../api/register.js";
import telegramConnect from "../../../api/telegram-connect.js";
import telegramSetup from "../../../api/telegram-setup.js";
import telegramWebhook from "../../../api/telegram-webhook.js";
import upload from "../../../api/upload.js";

export const API_HANDLERS = {
  "approve-all": approveAll,
  "check-auth": checkAuth,
  config,
  courses,
  health,
  hero,
  orders,
  register,
  "telegram-connect": telegramConnect,
  "telegram-setup": telegramSetup,
  "telegram-webhook": telegramWebhook,
  upload
};

// Vercel Functions reject request bodies over 4.5 MB; keep the same ceiling.
export const MAX_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);

const SECURITY_HEADERS = vercelConfig.headers.find((h) => h.source === "/(.*)").headers;

// vercel.json: "/" with a non-empty ?course → 307 /course-gate.html. Live Vercel keeps the whole query string
// (checked 03/11: "/?course=abc&x=1" → "/course-gate.html?course=abc&x=1"), so pass it through unchanged.
const COURSE_RULE = vercelConfig.redirects.find((r) => r.source === "/" && r.has?.[0]?.key === "course");
function courseRedirect(url) {
  if (!COURSE_RULE || url.pathname !== "/" || !url.searchParams.get("course")) return null;
  const location = COURSE_RULE.destination.split("?")[0] + url.search;
  return new Response(null, { status: COURSE_RULE.permanent ? 308 : 307, headers: { Location: location } });
}

function withSecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const { key, value } of SECURITY_HEADERS) out.headers.set(key, value);
  return out;
}

function notFound() {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function route(request, env) {
  const url = new URL(request.url);
  const api = /^\/api\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (api) {
    const handler = Object.hasOwn(API_HANDLERS, api[1]) ? API_HANDLERS[api[1]] : null;
    return handler ? runCompatHandler(handler, request, { maxBodyBytes: MAX_BODY_BYTES }) : notFound();
  }
  if (url.pathname.startsWith("/api/")) return notFound();
  const redirect = courseRedirect(url);
  if (redirect) return redirect;
  // html_handling = "none" (wrangler.toml) keeps Vercel's exact URLs; only "/" maps to index.html.
  if (url.pathname === "/") return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  return env.ASSETS.fetch(request);
}

export async function handleRequest(request, env) {
  return withSecurityHeaders(await route(request, env));
}
