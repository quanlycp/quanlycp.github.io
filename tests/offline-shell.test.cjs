const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

test('service worker precaches every local JS module and serves shell after network loss', async () => {
  const events = new Map(), cached = new Map(), names = new Set(['unrelated-cache', 'chitieu-shell-v1']);
  let online = true, installed = false;
  const cache = {
    async addAll(paths) {
      for (const relative of paths) {
        const file = relative === './' ? 'index.html' : relative;
        const contents = await fs.readFile(path.join(root, file)); // fails if a precached asset is missing
        cached.set(new URL(relative, 'https://app.test/').href, new Response(contents));
      }
    },
    async put(request, response) { cached.set(request.url, response); },
  };
  const scope = {
    addEventListener: (name, fn) => events.set(name, fn),
    skipWaiting: async () => { installed = true; },
    location: { origin: 'https://app.test' }, clients: { claim: async () => {} },
  };
  const context = vm.createContext({ self: scope, URL, AbortSignal,
    caches: {
      open: async (name) => { names.add(name); return cache; },
      keys: async () => [...names], delete: async (name) => names.delete(name),
      match: async (request) => cached.get(request.url)?.clone(),
    },
    fetch: async () => { if (!online) throw new TypeError('offline'); return new Response('online'); },
  });
  vm.runInContext(await fs.readFile(path.join(root, 'service-worker.js'), 'utf8'), context);
  let completion;
  events.get('install')({ waitUntil: (promise) => { completion = promise; } });
  await completion;
  assert.equal(installed, true);
  const modules = (await fs.readdir(path.join(root, 'js'), { recursive: true })).filter((name) => name.endsWith('.js'));
  for (const module of modules) assert.ok(cached.has('https://app.test/js/' + module.replaceAll('\\', '/')), module);
  events.get('activate')({ waitUntil: (promise) => { completion = promise; } });
  await completion;
  assert.equal(names.has('chitieu-shell-v1'), false);
  assert.equal(names.has('unrelated-cache'), true);
  online = false;
  events.get('fetch')({ request: new Request('https://app.test/'), respondWith: (promise) => { completion = promise; } });
  assert.match(await (await completion).text(), /Quản lý chi tiêu/);
  let intercepted = false;
  events.get('fetch')({ request: new Request('https://project.supabase.co/rest/v1/transactions'), respondWith: () => { intercepted = true; } });
  events.get('fetch')({ request: new Request('https://app.test/transaction', { method: 'POST' }), respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});

test('vendored Supabase SDK sends the custom JWT and requests insert confirmation', async () => {
  const { createClient } = await import(pathToFileURL(path.join(root, 'js/vendor/supabase.js')));
  let seen;
  const sb = createClient('https://project.supabase.co', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer test-user-session' }, fetch: async (url, options) => {
      seen = { url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) };
      return new Response(JSON.stringify([{ id: 'txn_test' }]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const { data, error } = await sb.from('transactions').insert({ id: 'txn_test', amount: 12000 }).select('id');
  assert.equal(error, null);
  assert.equal(data[0].id, 'txn_test');
  assert.equal(seen.headers.get('Authorization'), 'Bearer test-user-session');
  assert.match(seen.headers.get('Prefer'), /return=representation/);
  assert.equal(seen.body.id, 'txn_test');
});
