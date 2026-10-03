import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const script = fs.readFileSync(new URL('../agency-storefront.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function sharedBrowser({ locks = true, deferredBroadcasts = false } = {}) {
  const tabs = [], channels = [], posts = [], writes = [], notifications = [], stored = new Map();
  let cookie = '', lockQueue = Promise.resolve(), deleteFailure = false;
  class BC {
    constructor(name) { this.name = name; channels.push(this); }
    addEventListener(type, fn) { this.listener = fn; }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) { const send = () => channel.listener?.({ data }); if (deferredBroadcasts) notifications.push(send); else send(); } }
  }
  const lockManager = { request(name, fn) { const result = lockQueue.then(fn, fn); lockQueue = result.catch(() => {}); return result; } };
  async function tab() {
    const nodes = new Map(), clients = [];
    let sessionGate = null;
    const get = id => {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, { textContent: '', innerHTML: '', disabled: false, isConnected: true, dataset: {}, listeners: new Map(), classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v) }, addEventListener(type, fn) { this.listeners.set(type, fn); }, removeAttribute(key) { delete this[key]; }, scrollIntoView() {} });
      }
      return nodes.get(id);
    };
    const google = { accounts: { oauth2: { initTokenClient(options) { const client = { options, requestAccessToken() {} }; clients.push(client); return client; } } } };
    const context = vm.createContext({
      document: { getElementById: get, querySelectorAll: () => [] },
      localStorage: { get length() { return stored.size; }, key: i => [...stored.keys()][i], getItem: k => stored.get(k) || null, setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
      window: { BroadcastChannel: BC, google, navigator: locks ? { locks: lockManager } : {} }, BroadcastChannel: BC, google, crypto, URL, URLSearchParams, setTimeout, clearTimeout, console,
      fetch: async (url, options = {}) => {
        if (url.includes('runtime=1')) return response({ success: true, agency: { id: 'agency-fixture', name: 'Fixture' }, googleClientId: 'public-fixture-client', offerings: [] });
        if (options.method === 'POST') {
          writes.push('POST');
          const token = JSON.parse(options.body).accessToken;
          return new Promise(resolve => posts.push({
            token,
            finish() {
              cookie = token;
              resolve(response({
                success: true,
                membershipId: token,
                userId: 'user-' + token
              }));
            }
          }));
        }
        if (options.method === 'DELETE') {
          writes.push('DELETE');
          if (deleteFailure) throw new Error('synthetic_delete_network_failure');
          cookie = ''; return response({ success: true });
        }
        const observed = cookie ? response({
          success: true,
          member: { id: cookie, userId: 'user-' + cookie, displayName: cookie }
        }) : response({ success: false }, 401);
        if (sessionGate) { const gate = sessionGate; sessionGate = null; await gate; }
        return observed;
      }
    });
    vm.runInContext(script, context); await settle();
    const h = { get, clients, state: code => vm.runInContext(code, context), click: id => get(id).listeners.get('click')(), start() { this.click('googleLogin'); return clients.at(-1); }, blockNextSessionGet() { let resolve; sessionGate = new Promise(r => { resolve = r; }); return resolve; } };
    tabs.push(h); return h;
  }
  return { tab, posts, writes, get cookie() { return cookie; }, failDelete: value => { deleteFailure = value; }, flushBroadcasts: () => { for (const notify of notifications.splice(0)) notify(); } };
}

test('Google sign-in disables overlap and accepts only one callback for the active attempt', async () => {
  const browser = sharedBrowser(), h = await browser.tab();
  const client = h.start();
  const login = client.options.callback({ access_token: 'member-A' }); await settle();
  assert.equal(h.get('googleLogin').disabled, true);
  h.click('googleLogin');
  await client.options.callback({ access_token: 'member-B' }); await settle();
  assert.equal(browser.posts.length, 1);
  browser.posts[0].finish(); await login;
  assert.equal(browser.cookie, 'member-A');
  assert.equal(h.state('currentMembershipId'), 'member-A');
});

test('Logout during a pending Google POST completes DELETE after late Set-Cookie', async () => {
  const browser = sharedBrowser(), h = await browser.tab();
  const login = h.start().options.callback({ access_token: 'member-A' }); await settle();
  const logout = h.click('logout'); await settle();
  assert.equal(h.state('currentMembershipId'), '');
  browser.posts[0].finish(); await Promise.all([login, logout]);
  assert.equal(browser.cookie, '');
  assert.equal(h.state('currentMembershipId'), '');
  assert.equal(h.get('memberCard').classList.contains('hidden'), true);
  assert.equal(browser.writes.at(-1), 'DELETE');
});

test('Canceled OAuth callback cannot issue POST after a newer attempt succeeds', async () => {
  const browser = sharedBrowser(), h = await browser.tab();
  const oldClient = h.start();
  await h.click('logout');
  const current = h.start().options.callback({ access_token: 'member-B' }); await settle();
  browser.posts[0].finish(); await current;
  const late = oldClient.options.callback({ access_token: 'member-A' }); await settle();
  assert.equal(browser.posts.length, 1);
  await late;
  assert.equal(browser.cookie, 'member-B');
  assert.equal(h.state('currentMembershipId'), 'member-B');
});

test('Cross-tab logout invalidates a pending sign-in and its final cookie with Web Locks', async () => {
  const browser = sharedBrowser({ locks: true }), a = await browser.tab(), b = await browser.tab();
  const login = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const logout = b.click('logout'); await settle();
  browser.posts[0].finish(); await Promise.all([login, logout]);
  assert.equal(browser.cookie, '');
  assert.equal(a.state('currentMembershipId'), ''); assert.equal(b.state('currentMembershipId'), '');
});

test('Without Web Locks Google login and authenticated UI fail closed', async () => {
  const browser = sharedBrowser({ locks: false }), h = await browser.tab();
  h.click('googleLogin');
  await settle();
  assert.equal(browser.posts.length, 0);
  assert.equal(h.state('currentMembershipId'), '');
  assert.equal(h.get('memberCard').classList.contains('hidden'), true);
  assert.match(h.get('googleLogin').textContent, /phiên an toàn/i);
});

test('Same-origin Web Locks serialize reverse cross-tab sign-ins and retain the newer account', async () => {
  const browser = sharedBrowser({ locks: true }), a = await browser.tab(), b = await browser.tab();
  const oldLogin = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const newLogin = b.start().options.callback({ access_token: 'member-B' }); await settle();
  assert.equal(browser.posts.length, 1);
  browser.posts[0].finish(); await oldLogin; await settle();
  assert.equal(browser.posts.length, 2);
  browser.posts[1].finish(); await newLogin;
  assert.equal(browser.cookie, 'member-B');
  assert.equal(a.state('currentMembershipId'), ''); assert.equal(b.state('currentMembershipId'), 'member-B');
});

test('Failed DELETE keeps the UI logged out and blocks a stale session GET until reconciliation', async () => {
  const browser = sharedBrowser(), h = await browser.tab();
  const login = h.start().options.callback({ access_token: 'member-A' }); await settle();
  browser.posts[0].finish(); await login;
  browser.failDelete(true); await h.click('logout');
  await h.state('session()');
  assert.equal(h.state('currentMembershipId'), '');
  browser.failDelete(false);
  const next = h.start().options.callback({ access_token: 'member-B' }); await settle();
  browser.posts[1].finish(); await next;
  assert.equal(browser.cookie, 'member-B');
  assert.equal(h.state('currentMembershipId'), 'member-B');
});

test('Queued logout cannot erase a newer cross-tab sign-in after its earlier POST releases the Web Lock', async () => {
  const browser = sharedBrowser({ locks: true }), a = await browser.tab(), b = await browser.tab();
  const oldLogin = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const logout = a.click('logout'); await settle();
  const newLogin = b.start().options.callback({ access_token: 'member-B' }); await settle();
  browser.posts[0].finish(); await oldLogin; await settle();
  assert.equal(browser.posts.length, 2);
  browser.posts[1].finish(); await Promise.all([logout, newLogin]);
  assert.equal(browser.cookie, 'member-B');
  assert.equal(a.state('currentMembershipId'), ''); assert.equal(b.state('currentMembershipId'), 'member-B');
});

test('Another tab opening and canceling Google OAuth does not suppress a queued logout', async () => {
  const browser = sharedBrowser({ locks: true }), a = await browser.tab(), b = await browser.tab();
  const login = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const logout = a.click('logout'); await settle();
  b.start().options.error_callback();
  browser.posts[0].finish(); await Promise.all([login, logout]);
  assert.equal(browser.cookie, '');
  assert.equal(a.state('currentMembershipId'), ''); assert.equal(b.state('currentMembershipId'), '');
});

test('Delayed cross-tab notifications cannot cancel the newer serialized login or revive the older POST', async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true }), a = await browser.tab(), b = await browser.tab();
  const oldLogin = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const newLogin = b.start().options.callback({ access_token: 'member-B' }); await settle();
  browser.posts[0].finish(); await oldLogin; await settle();
  browser.flushBroadcasts();
  browser.posts[1].finish(); await newLogin; browser.flushBroadcasts();
  assert.equal(browser.cookie, 'member-B');
  assert.equal(a.state('currentMembershipId'), ''); assert.equal(b.state('currentMembershipId'), 'member-B');
});

test('Delayed cross-tab CLEAR still denies an obsolete POST before the logout cookie is final', async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true }), a = await browser.tab(), b = await browser.tab();
  const login = a.start().options.callback({ access_token: 'member-A' }); await settle();
  const logout = b.click('logout'); await settle();
  browser.posts[0].finish(); await Promise.all([login, logout]); browser.flushBroadcasts();
  assert.equal(browser.cookie, ''); assert.equal(a.state('currentMembershipId'), '');
});

test('A delayed session GET cannot repaint the prior account while its cross-tab CLEAR is still queued', async () => {
  const browser = sharedBrowser({ locks: true, deferredBroadcasts: true }), a = await browser.tab(), b = await browser.tab();
  const first = a.start().options.callback({ access_token: 'member-A' }); await settle();
  browser.posts[0].finish(); await first; browser.flushBroadcasts();
  const release = b.blockNextSessionGet(), staleGet = b.state('session()'); await settle();
  const second = a.start().options.callback({ access_token: 'member-B' }); await settle();
  release(); assert.equal(await staleGet, false);
  assert.equal(b.state('currentMembershipId'), '');
  browser.posts[1].finish(); await second; browser.flushBroadcasts();
  assert.equal(browser.cookie, 'member-B'); assert.equal(a.state('currentMembershipId'), 'member-B');
});
