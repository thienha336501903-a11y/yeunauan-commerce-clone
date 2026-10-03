import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const script = fs.readFileSync(new URL("../agency-storefront.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1];

const settle = async (rounds = 100) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function response(data, status = 200, bodyGate = null) {
  return {
    ok: status < 400,
    status,
    json: async () => {
      if (bodyGate) await bodyGate.promise;
      return data;
    }
  };
}

function browserHarness({ deferredBroadcasts = true } = {}) {
  const stored = new Map();
  const channels = [];
  const pendingBroadcasts = [];
  const sessionPosts = [];
  const sessionGets = [];
  const orderRequests = [];
  let cookie = "";
  let lockQueue = Promise.resolve();
  let nextSessionGetBodyGate = null;

  class BC {
    constructor(name) {
      this.name = name;
      channels.push(this);
    }
    addEventListener(type, fn) {
      if (type === "message") this.listener = fn;
    }
    postMessage(data) {
      for (const channel of channels) {
        if (channel === this || channel.name !== this.name) continue;
        const deliver = () => channel.listener?.({ data });
        if (deferredBroadcasts) pendingBroadcasts.push(deliver);
        else deliver();
      }
    }
    close() {}
  }

  const locks = {
    request(_name, fn) {
      const result = lockQueue.then(fn, fn);
      lockQueue = result.catch(() => {});
      return result;
    }
  };

  const localStorage = {
    get length() { return stored.size; },
    key(i) { return [...stored.keys()][i] ?? null; },
    getItem(k) { return stored.has(k) ? stored.get(k) : null; },
    setItem(k, v) { stored.set(k, String(v)); },
    removeItem(k) { stored.delete(k); }
  };

  async function tab() {
    const nodes = new Map();
    const clients = [];

    const get = id => {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, {
          textContent: "",
          innerHTML: "",
          disabled: false,
          isConnected: true,
          dataset: {},
          src: "",
          listeners: new Map(),
          classList: {
            add(v) { classes.add(v); },
            remove(v) { classes.delete(v); },
            contains(v) { return classes.has(v); }
          },
          addEventListener(type, fn) { this.listeners.set(type, fn); },
          removeAttribute(key) { delete this[key]; },
          scrollIntoView() {}
        });
      }
      return nodes.get(id);
    };

    const google = {
      accounts: {
        oauth2: {
          initTokenClient(options) {
            const client = { options, requestAccessToken() {} };
            clients.push(client);
            return client;
          }
        }
      }
    };

    const fetch = async (url, options = {}) => {
      const textUrl = String(url);
      const method = options.method || "GET";

      if (textUrl.includes("runtime=1")) {
        return response({
          success: true,
          agency: { id: "fixture", name: "Fixture" },
          googleClientId: "client",
          offerings: [],
          lmsPublicUrl: "https://lms.example.test"
        });
      }

      if (textUrl.includes("agencySession=1") && method === "POST") {
        const token = JSON.parse(options.body).accessToken;
        const body = gate();
        let releaseHeaders;
        const headers = new Promise(resolve => { releaseHeaders = resolve; });
        sessionPosts.push({
          token,
          releaseHeaders(cookieValue = token) {
            cookie = cookieValue;
            releaseHeaders(response({
              success: true,
              membershipId: token,
              userId: "user-" + token
            }, 200, body));
          },
          releaseBody() { body.resolve(); }
        });
        return headers;
      }

      if (textUrl.includes("agencySession=1") && method === "DELETE") {
        cookie = "";
        return response({ success: true });
      }

      if (textUrl.includes("agencySession=1")) {
        const observedMember = cookie;
        const bodyGate = nextSessionGetBodyGate;
        nextSessionGetBodyGate = null;
        sessionGets.push({ observedMember, bodyGate });
        return observedMember
          ? response({
              success: true,
              member: {
                id: observedMember,
                userId: "user-" + observedMember,
                displayName: observedMember,
                role: "agency_owner"
              }
            }, 200, bodyGate)
          : response({ success: false }, 401, bodyGate);
      }

      if (textUrl.includes("/api/register")) {
        const observedCookie = cookie;
        orderRequests.push({ observedCookie });
        return response({
          success: true,
          order: {
            orderId: "order-for-" + observedCookie,
            status: "pending",
            amountVnd: 1000
          }
        });
      }

      if (textUrl.includes("/api/orders")) {
        return response({
          success: true,
          order: { id: "order", status: "approved-" + cookie }
        });
      }

      throw new Error("unexpected fetch " + textUrl);
    };

    const context = vm.createContext({
      document: { getElementById: get, querySelectorAll: () => [] },
      localStorage,
      window: { BroadcastChannel: BC, google, navigator: { locks } },
      BroadcastChannel: BC,
      google,
      crypto,
      URL,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      console,
      fetch
    });

    vm.runInContext(script, context);
    await settle();

    return {
      get,
      clients,
      state(code) { return vm.runInContext(code, context); },
      click(id) { return get(id).listeners.get("click")?.(); },
      start() {
        this.click("googleLogin");
        return clients.at(-1);
      },
      login(token) {
        const client = this.start();
        assert.ok(client, "expected Google client");
        return client.options.callback({ access_token: token });
      }
    };
  }

  return {
    tab,
    stored,
    sessionPosts,
    sessionGets,
    orderRequests,
    get cookie() { return cookie; },
    blockNextSessionGetBody() {
      const body = gate();
      nextSessionGetBodyGate = body;
      return body;
    },
    flushBroadcasts() {
      for (const deliver of pendingBroadcasts.splice(0)) deliver();
    }
  };
}

async function finishLogin(browser, promise, index = browser.sessionPosts.length - 1) {
  const post = browser.sessionPosts[index];
  assert.ok(post, "expected pending login POST");
  post.releaseHeaders();
  await settle();
  post.releaseBody();
  await promise;
  await settle();
}

async function establishA(browser, tab) {
  const loginA = tab.login("member-A");
  await settle();
  await finishLogin(browser, loginA, 0);
  browser.flushBroadcasts();
  assert.equal(tab.state("currentMembershipId"), "member-A");
}

test("FG1-04-B7: fresh bootstrap cannot bind cookie A to B pending intent while B POST holds the lock", async () => {
  const browser = browserHarness();
  const a = await browser.tab();
  await establishA(browser, a);

  const b = await browser.tab();
  assert.equal(b.state("currentMembershipId"), "member-A");

  const loginB = b.login("member-B");
  await settle();
  assert.equal(browser.sessionPosts.length, 2);

  const getsBefore = browser.sessionGets.length;
  const fresh = await browser.tab();
  await settle();

  assert.equal(browser.sessionGets.length, getsBefore, "pending transition must suppress bootstrap GET");
  assert.equal(fresh.state("currentMembershipId"), "");
  assert.equal(fresh.get("memberCard").classList.contains("hidden"), true);

  await finishLogin(browser, loginB, 1);
  assert.equal(browser.cookie, "member-B");

  const ordersBefore = browser.orderRequests.length;
  await fresh.state("checkout('offer-1',{disabled:false,isConnected:true})");
  await settle();

  assert.equal(browser.orderRequests.length, ordersBefore);
  assert.equal(browser.stored.has("agency:fixture:member-A:last_order"), false);
});

test("FG1-04-B8: bootstrap GET body captured under A is discarded after B session commits", async () => {
  const browser = browserHarness();
  const a = await browser.tab();
  await establishA(browser, a);

  const b = await browser.tab();
  assert.equal(b.state("currentMembershipId"), "member-A");

  const staleBody = browser.blockNextSessionGetBody();
  const freshPromise = browser.tab();
  await settle();

  const lastGet = browser.sessionGets.at(-1);
  assert.equal(lastGet.observedMember, "member-A");

  const loginB = b.login("member-B");
  await settle();
  await finishLogin(browser, loginB, 1);
  assert.equal(browser.cookie, "member-B");

  staleBody.resolve();
  const fresh = await freshPromise;
  await settle();

  assert.equal(fresh.state("currentMembershipId"), "");
  assert.equal(fresh.state("currentActorIntent"), "");
  assert.equal(browser.stored.has("agency:fixture:member-A:last_order"), false);
});

test("FG1-04-B9: bootstrap cannot adopt B intent while OAuth is pending before B POST is queued", async () => {
  const browser = browserHarness();
  const a = await browser.tab();
  await establishA(browser, a);

  const b = await browser.tab();
  const clientB = b.start();
  assert.ok(clientB, "expected pending B OAuth client");
  await settle();
  assert.equal(browser.sessionPosts.length, 1, "B callback has not queued POST yet");

  const getsBefore = browser.sessionGets.length;
  const fresh = await browser.tab();
  await settle();

  assert.equal(browser.sessionGets.length, getsBefore, "pending OAuth intent must suppress bootstrap GET");
  assert.equal(fresh.state("currentMembershipId"), "");

  const loginB = clientB.options.callback({ access_token: "member-B" });
  await settle();
  assert.equal(browser.sessionPosts.length, 2);
  await finishLogin(browser, loginB, 1);
  assert.equal(browser.cookie, "member-B");

  const ordersBefore = browser.orderRequests.length;
  await fresh.state("checkout('offer-1',{disabled:false,isConnected:true})");
  await settle();

  assert.equal(browser.orderRequests.length, ordersBefore);
  assert.equal(browser.stored.has("agency:fixture:member-A:last_order"), false);
});
