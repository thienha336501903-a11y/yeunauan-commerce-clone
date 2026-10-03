import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../agency-storefront.html",import.meta.url),"utf8");

test("Agency checkout persists a stable logical idempotency key",()=>{
  assert.match(html,/logicalCheckoutKey\(offeringId,actor\)/);
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
  assert.match(html,/clearCurrentAccountStorage\(actor\)/);
  assert.match(html,/currentMembershipId=''/);
});


test("Agency storefront binds async order mutations to captured actor epoch",()=>{
  assert.match(html,/function actorSnapshot\(\)/);
  assert.match(html,/function actorIsCurrent\(actor\)/);
  assert.match(html,/if\(!actorIsCurrent\(actor\)\)return;/);
  assert.match(html,/showOrder\(d\.order,actor\)/);
  assert.match(html,/clearCheckoutIntent\(offeringId,actor\)/);
  assert.match(html,/clearPaymentState\(\)/);
  assert.match(html,/system-b-agency-commerce-session-v1/);
});


test("FG1-04 actor state is bound to accepted session intent and protected requests share the session lock",()=>{
  assert.match(html,/intent:String\(currentActorIntent/);
  assert.match(html,/actor\.intent===currentActorIntent/);
  assert.match(html,/sharedSessionIntent\(\)/);
  assert.match(html,/withProtectedSessionLock\(actor/);
  assert.match(html,/navigator\.locks\.request\(ACCOUNT_SESSION_CHANNEL\+':writes'/);
  assert.match(html,/membershipId:String\(d\.membershipId/);
  assert.match(html,/nextMember!==expectedMember/);
  assert.match(html,/sessionSerializationAvailable\(\)/);
});
