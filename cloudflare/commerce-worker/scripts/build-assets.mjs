// Build the Worker's static assets with the same allowlist as the Vercel build (root *.html + favicon/robots only).
import path from "node:path";
import { buildPublic } from "../../../scripts/build-vercel-public.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const files = buildPublic(root, path.resolve(import.meta.dirname, "../public"));
console.log(`commerce-worker public/: ${files.length} files`);
