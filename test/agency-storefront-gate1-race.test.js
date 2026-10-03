import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const script = fs.readFileSync(new URL("../agency-storefront.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1];

const settle = async (rounds = 80) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

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

function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function sharedBrowser({ locks = true, deferredBroadcasts = false, initialCookie = "" } = {}) {
  const channels = [];
  const pendingBroadcasts = [];
  const stored = new Map();
  const sessionPosts = [];
  const orderRequests = [];
  const refreshRequests = [];
  let cookie = initialCookie;
  let sessionMemberOverride = "";
  let lockQueue = Promise.resolve();

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

  const lockManager = {
    request(_name, fn) {
      const result = lockQueue.then(fn, fn);
      lockQueue = result.catch(() => {});
      return result;
    }
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

    const localStorage = {
      get length() { return stored.size; },
      key(i) { return [...stored.keys()][i] ?? null; },
      getItem(k) { return stored.has(k) ? stored.get(k) : null; },
      setItem(k, v) { stored.set(k, String(v)); },
      removeItem(k) { stored.delete(k); }
    };

    const fetch = async (url, options = {}) => {
      const method = options.method || "GET";

      if (String(url).includes("runtime=1")) {
        return response({
          success: true,
          agency: { id: "fixture", name: "Fixture" },
          googleClientId: "client",
          offerings: [{ id: "offer-1", slug: "offer-1", display_title: "Offer", price_vnd: 1000 }],
          lmsPublicUrl: "https://lms.example.test"
        });
      }

      if (String(url).includes("agencySession=1") && method === "POST") {
        const token = JSON.parse(options.body).accessToken;
        const body = gate();
        let resolveHeaders;
        const headersPromise = new Promise(resolve => { resolveHeaders = resolve; });
        sessionPosts.push({
          token,
          releaseHeaders(cookieValue = token) {
            cookie = cookieValue;
            resolveHeaders(response({
              success: true,
              membershipId: token,
              userId: "user-" + token
            }, 200, body));
          },
          releaseBody() { body.resolve(); }
        });
        return headersPromise;
      }

      if (String(url).includes("agencySession=1") && method === "DELETE") {
        cookie = "";
        return response({ success: true });
      }

      if (String(url).includes("agencySession=1")) {
        const member = sessionMemberOverride || cookie;
        return member
          ? response({
              success: true,
              member: {
                id: member,
                userId: "user-" + member,
                displayName: member,
                role: "agency_owner"
              }
            })
          : response({ success: false }, 401);
      }

      if (String(url).includes("/api/register")) {
        const body = gate();
        const cookieAtDispatch = cookie;
        let resolveHeaders;
        const headersPromise = new Promise(resolve => { resolveHeaders = resolve; });
        orderRequests.push({
          cookieAtDispatch,
          finish(orderId = "order-for-" + cookieAtDispatch) {
            resolveHeaders(response({
              success: true,
              order: {
                orderId,
                status: "pending",
                amountVnd: 1000
              }
            }, 200, body));
            body.resolve();
          }
        });
        return headersPromise;
      }

      if (String(url).includes("/api/orders")) {
        const body = gate();
        const cookieAtDispatch = cookie;
        let resolveHeaders;
        const headersPromise = new Promise(resolve => { resolveHeaders = resolve; });
        refreshRequests.push({
          cookieAtDispatch,
          finish(status = "approved-" + cookieAtDispatch) {
            resolveHeaders(response({
              success: true,
              order: { id: "order", status }
            }, 200, body));
            body.resolve();
          }
        });
        return headersPromise;
      }

      throw new Error("unexpected fetch " + url);
    };

    const context = vm.createContext({
      document: { getElementById: get, querySelectorAll: () => [] },
      localStorage,
      window: {
        BroadcastChannel: BC,
        google,
        navigator: locks ? { locks: lockManager } : {}
      },
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
        if (!client) return null;
        return client.options.callback({ access_token: token });
      }
    };
  }

  return {
    tab,
    sessionPosts,
    orderRequests,
    refreshRequests,
    stored,
    get cookie() { return cookie; },
    setSessionMemberOverride(value) { sessionMemberOverride = value; },
    flushBroadcasts() {
      for (const deliver of pendingBroadcasts.splice(0)) deliver();
    }
  };
}

async function finishLogin(browser, promise, index = browser.sessionPosts.length - 1, cookieValue) {
  const post = browser.sessionPosts[index];
  assert.ok(post, "expected pending session POST");
  post.releaseHeaders(cookieValue);
  await settle();
  post.releaseBody();
  await promise;
  await settle();
}

test("FG1-04-A: browsers without Web Locks cannot start Google login or render an existing authenticated cookie", async () => {
  const browser = sharedBrowser({ locks: false, initialCookie: "member-A" });
  const h = await browser.tab();

  h.click("googleLogin");
  await settle();

  assert.equal(browser.sessionPosts.length, 0);
  assert.equal(h.state("currentMembershipId"), "");
  assert.equal(h.get("memberCard").classList.contains("hidden"), true);
  assert.match(h.get("googleLogin").textContent, /phiên an toàn/i);
});

test("FG1-04-A: POST principal binding rejects a GET for a different membership before actor activation", async () => {
  const browser = sharedBrowser({ locks: true });
  const h = await browser.tab();
  const login = h.login("member-B");
  await settle();

  browser.setSessionMemberOverride("member-A");
  await finishLogin(browser, login, 0, "member-B");

  assert.equal(h.state("currentMembershipId"), "");
  assert.equal(browser.cookie, "");
  assert.equal(h.get("memberCard").classList.contains("hidden"), true);
  assert.match(h.get("notice").textContent, /không khớp/i);
});

test("FG1-04-B: delayed CLEAR cannot authorize a new checkout under an obsolete actor namespace", async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true });
  const a = await browser.tab();
  const b = await browser.tab();

  const loginA = a.login("member-A");
  await settle();
  await finishLogin(browser, loginA, 0, "member-A");
  browser.flushBroadcasts();
  assert.equal(a.state("currentMembershipId"), "member-A");

  b.start(); // changes shared intent immediately; CLEAR delivery stays delayed
  await settle();

  const checkout = a.state("checkout('offer-1',{disabled:false,isConnected:true})");
  await checkout;
  await settle();

  assert.equal(browser.orderRequests.length, 0);
  assert.equal(browser.stored.has("agency:fixture:member-A:last_order"), false);
  assert.equal(a.get("payment").classList.contains("hidden"), true);
});

test("FG1-04-B: checkout started before account switch cannot repaint or persist after the shared intent changes", async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true });
  const a = await browser.tab();
  const b = await browser.tab();

  const loginA = a.login("member-A");
  await settle();
  await finishLogin(browser, loginA, 0, "member-A");
  browser.flushBroadcasts();

  const checkout = a.state("checkout('offer-1',{disabled:false,isConnected:true})");
  await settle();
  assert.equal(browser.orderRequests.length, 1);
  assert.equal(browser.orderRequests[0].cookieAtDispatch, "member-A");

  const loginB = b.login("member-B");
  await settle();
  assert.equal(browser.sessionPosts.length, 1, "B POST must wait behind protected checkout lock");

  browser.orderRequests[0].finish("order-for-member-A");
  await checkout;
  await settle();

  assert.equal(browser.stored.has("agency:fixture:member-A:last_order"), false);
  assert.equal(a.get("payment").classList.contains("hidden"), true);

  assert.equal(browser.sessionPosts.length, 2);
  await finishLogin(browser, loginB, 1, "member-B");
  assert.equal(browser.cookie, "member-B");
  assert.equal(b.state("currentMembershipId"), "member-B");
});

test("FG1-04-B: refresh started before account switch cannot repaint stale order state", async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true });
  const a = await browser.tab();
  const b = await browser.tab();

  const loginA = a.login("member-A");
  await settle();
  await finishLogin(browser, loginA, 0, "member-A");
  browser.flushBroadcasts();

  a.state("currentOrderId='order-A'");
  const refresh = a.state("refreshOrder()");
  await settle();
  assert.equal(browser.refreshRequests.length, 1);

  const loginB = b.login("member-B");
  await settle();
  assert.equal(browser.sessionPosts.length, 1, "B POST must wait behind refresh lock");

  browser.refreshRequests[0].finish("approved-member-A");
  await refresh;
  await settle();

  assert.notEqual(a.get("orderStatus").textContent, "Trạng thái: approved-member-A");

  assert.equal(browser.sessionPosts.length, 2);
  await finishLogin(browser, loginB, 1, "member-B");
  assert.equal(b.state("currentMembershipId"), "member-B");
});
