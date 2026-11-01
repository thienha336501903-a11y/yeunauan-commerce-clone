// Vercel build step (vercel.json buildCommand): copy ONLY the public frontend into public/ (vercel.json outputDirectory).
// Without it Vercel served the whole uploaded tree as static files (98 of 109 source, test and migration files on 01/11).
// Functions in api/ are still built from the repo root and bundle what they import; nothing else is served.
// The pages load nothing same-origin but other root pages and /api/*, so root *.html is the whole frontend.
// shortcut: an untracked root *.html in a dirty CLI deploy is still published; deploy from a clean checkout.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_ASSETS = ["favicon.ico", "robots.txt"];

export function buildPublic(src, out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = readdirSync(src)
    .filter((n) => /^[A-Za-z0-9._-]+\.html$/.test(n) || ROOT_ASSETS.includes(n))
    .filter((n) => statSync(path.join(src, n)).isFile());
  for (const rel of files) cpSync(path.join(src, rel), path.join(out, rel));
  return files.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(import.meta.dirname, "..");
  const files = buildPublic(root, path.join(root, "public"));
  for (const page of ["index.html", "orders.html", "admin.html", "course-gate.html", "agency-storefront.html"]) {
    if (!files.includes(page)) throw new Error(`public build is missing ${page}`);
  }
  console.log(`public/: ${files.length} files`);
}
