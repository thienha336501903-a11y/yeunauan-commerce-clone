import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../agency-storefront.html",import.meta.url),"utf8");

test("Agency checkout persists a stable logical idempotency key",()=>{
  assert.match(html,/logicalCheckoutKey\(offeringId\)/);
  assert.match(html,/idempotencyOrderCode/);
  assert.match(html,/crypto\.randomUUID\(\)/);
});

test("Agency browser state is scoped by Agency and membership",()=>{
  assert.match(html,/agency:\$\{agencyId\}:\$\{member\}:/);
  assert.doesNotMatch(html,/agency_last_order_id/);
});

test("Agency storefront navigates to tenant-specific LMS config",()=>{
  assert.match(html,/config\?\.lmsPublicUrl/);
  assert.match(html,/new URL\('\/my-courses\.html',config\.lmsPublicUrl\)/);
});

test("Agency logout clears current account scoped browser state",()=>{
  assert.match(html,/clearCurrentAccountStorage\(\)/);
  assert.match(html,/currentMembershipId=''/);
});
