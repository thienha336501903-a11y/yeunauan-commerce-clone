import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../agency-storefront.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";

function extractFunction(name) {
  const start = script.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === "{") {
      depth += 1;
      opened = true;
    } else if (script[i] === "}") {
      depth -= 1;
      if (opened && depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function storage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

test("Captured actor becomes stale after account change and retains only its own namespace", () => {
  const helperSource = [
    "let config=null,currentMembershipId=''; let actorEpoch=0,accountSessionBroadcast=null;",
    "const ACCOUNT_SESSION_CHANNEL='system-b-agency-commerce-session-v1';",
    "const $=id=>({textContent:'',classList:{add(){},remove(){}},removeAttribute(){},src:''});",
    extractFunction("actorSnapshot"),
    extractFunction("actorIsCurrent"),
    extractFunction("storagePrefix"),
    extractFunction("lastOrderKey"),
    extractFunction("checkoutIntentKey"),
    extractFunction("clearCurrentAccountStorage"),
    extractFunction("clearPaymentState"),
    extractFunction("showLoggedOutState"),
    extractFunction("accountSessionChannel"),
    extractFunction("activateActor"),
    `
    globalThis.__actorTest = {
      setConfig: v => { config = v; },
      setMember: v => { currentMembershipId = v; },
      snapshot: () => actorSnapshot(),
      current: a => actorIsCurrent(a),
      activate: v => activateActor(v),
      lastKey: a => lastOrderKey(a),
      intentKey: (o,a) => checkoutIntentKey(o,a)
    };
    `
  ].join("\n");

  class BroadcastChannelStub {
    addEventListener() {}
    postMessage() {}
  }

  const context = vm.createContext({
    localStorage: storage(),
    BroadcastChannel: BroadcastChannelStub,
    window: {},
    console
  });
  vm.runInContext(helperSource, context);

  const h = context.__actorTest;
  h.setConfig({ agency: { id: "agency-1" } });
  h.setMember("member-A");
  const actorA = h.snapshot();

  assert.equal(h.current(actorA), true);
  assert.equal(h.lastKey(actorA), "agency:agency-1:member-A:last_order");
  assert.equal(h.intentKey("offer-1", actorA), "agency:agency-1:member-A:checkout:offer-1");

  h.activate("member-B");

  assert.equal(h.current(actorA), false);
  assert.equal(h.lastKey(actorA), "agency:agency-1:member-A:last_order");
  assert.equal(h.intentKey("offer-1", actorA), "agency:agency-1:member-A:checkout:offer-1");
});
