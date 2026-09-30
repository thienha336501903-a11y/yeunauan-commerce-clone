// test/m0e-inventory-consistency.test.js
// Pre-M0C Remediation V3 — FIX 14: M0E Retirement Inventory Consistency Test
// Asserts consistency against:
//   1. Actual DB writers (order_items is KEEP because agency writes it)
//   2. Current route behavior (api/register.js and api/orders.js block agency)
//   3. Actual file existence (all listed files exist, zero wildcards)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, "..");
const COMMERCE_ROOT = path.resolve(WORKSPACE_ROOT, "yeunauan-commerce-clone");
const LMS_ROOT = path.resolve(WORKSPACE_ROOT, "yeunauan-lms-clone");

test("M0E Inventory Consistency: Zero wildcards in candidate asset inventory", () => {
  const inventoryPath = path.join(REPO_ROOT, "docs/SYSTEM_B_M0E_RETIREMENT_INVENTORY.md");
  assert.ok(fs.existsSync(inventoryPath), "Inventory markdown must exist");
  const content = fs.readFileSync(inventoryPath, "utf8");

  // Verify no wildcards in table column 1 (Object / File names)
  const tableRows = content.split("\n").filter(l => l.startsWith("| `"));
  for (const row of tableRows) {
    const assetName = row.split("|")[1].trim().replace(/`/g, "");
    assert.ok(
      !assetName.includes("*"),
      `Asset name '${assetName}' must be concrete and must not contain wildcards (*)`
    );
  }
});

test("M0E Inventory Consistency: Actual DB writers (public.order_items is KEEP)", () => {
  const inventoryPath = path.join(REPO_ROOT, "docs/SYSTEM_B_M0E_RETIREMENT_INVENTORY.md");
  const content = fs.readFileSync(inventoryPath, "utf8");

  // Check that public.order_items is classified as KEEP
  const orderItemsRow = content.split("\n").find(l => l.includes("`public.order_items`"));
  assert.ok(orderItemsRow, "public.order_items must be listed in inventory");
  assert.ok(orderItemsRow.includes("`KEEP`"), "public.order_items must be classified as KEEP");
  assert.ok(
    !orderItemsRow.includes("SAFE_TO_REMOVE"),
    "public.order_items must NOT be classified as SAFE_TO_REMOVE"
  );

  // Check B5 atomic checkout migration actively writes to order_items
  const migrationPath = path.join(
    LMS_ROOT,
    "supabase/migrations/20260927000000_multi_agency_b5_materialized_offering_items_atomic_checkout.sql"
  );
  assert.ok(fs.existsSync(migrationPath), "B5 atomic checkout migration must exist");
  const migrationSrc = fs.readFileSync(migrationPath, "utf8");
  assert.ok(
    migrationSrc.includes("INSERT INTO public.order_items"),
    "B5 atomic checkout RPC must show active DB write (INSERT INTO public.order_items)"
  );
});

test("M0E Inventory Consistency: Current Commerce routes dispatch Agency to Main-only paths", () => {
  const inventoryPath = path.join(REPO_ROOT, "docs/SYSTEM_B_M0E_RETIREMENT_INVENTORY.md");
  const content = fs.readFileSync(inventoryPath, "utf8");

  const registerRow = content.split("\n").find(l => l.includes("`api/register.js`"));
  assert.ok(registerRow, "api/register.js must be listed in inventory");
  assert.ok(registerRow.toLowerCase().includes("checkoutoffering") || registerRow.toLowerCase().includes("dispatch"), "register inventory must describe Agency dispatch");

  const ordersRow = content.split("\n").find(l => l.includes("`api/orders.js`"));
  assert.ok(ordersRow, "api/orders.js must be listed in inventory");
  assert.ok(ordersRow.toLowerCase().includes("main") || ordersRow.toLowerCase().includes("agency"), "orders inventory must describe Main/Agency behavior");

  const registerSrc = fs.readFileSync(path.join(COMMERCE_ROOT, "api/register.js"), "utf8");
  assert.ok(registerSrc.includes("routeDecision.route === \"AGENCY\""), "api/register.js must explicitly dispatch Agency route");
  assert.ok(registerSrc.includes("checkoutOffering"), "api/register.js Agency path must use checkoutOffering");

  const ordersSrc = fs.readFileSync(path.join(COMMERCE_ROOT, "api/orders.js"), "utf8");
  assert.ok(ordersSrc.includes("routeDecision.route === \"AGENCY\""), "api/orders.js must explicitly dispatch Agency route");
  assert.ok(ordersSrc.includes("getAgencyOrder"), "api/orders.js Agency read path must use getAgencyOrder");
  assert.ok(ordersSrc.includes("agency_order_mutation_use_admin"), "api/orders.js Agency mutations must stay role-gated");
});

test("M0E Inventory Consistency: Actual file existence for all cataloged files", () => {
  const inventoryPath = path.join(REPO_ROOT, "docs/SYSTEM_B_M0E_RETIREMENT_INVENTORY.md");
  const content = fs.readFileSync(inventoryPath, "utf8");

  const lines = content.split("\n");
  const checkedFiles = [];

  for (const line of lines) {
    // Match rows with file extensions .js
    const m = line.match(/^\|\s*`([^`]+\.js)`\s*\|\s*([^|]+)\s*\|/);
    if (m) {
      const filePath = m[1].trim();
      const repo = m[2].trim();

      if (repo === "LMS") {
        const fullPath = path.join(LMS_ROOT, filePath);
        assert.ok(fs.existsSync(fullPath), `LMS file must exist: ${filePath} (${fullPath})`);
        checkedFiles.push({ repo: "LMS", filePath });
      } else if (repo === "Commerce") {
        const fullPath = path.join(COMMERCE_ROOT, filePath);
        assert.ok(fs.existsSync(fullPath), `Commerce file must exist: ${filePath} (${fullPath})`);
        checkedFiles.push({ repo: "Commerce", filePath });
      } else if (repo === "Both") {
        const lmsPath = path.join(LMS_ROOT, filePath);
        const commPath = path.join(COMMERCE_ROOT, filePath);
        assert.ok(fs.existsSync(lmsPath), `File must exist in LMS: ${filePath}`);
        assert.ok(fs.existsSync(commPath), `File must exist in Commerce: ${filePath}`);
        checkedFiles.push({ repo: "Both", filePath });
      }
    }
  }

  assert.ok(checkedFiles.length >= 15, `Expected at least 15 cataloged files, checked ${checkedFiles.length}`);
});
