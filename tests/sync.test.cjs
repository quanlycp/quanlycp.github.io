const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const clone = (x) => JSON.parse(JSON.stringify(x));
const token = (id) => 'header.' + Buffer.from(JSON.stringify({ row_id: id, exp: 4102444800 })).toString('base64url') + '.signature';
const txn = (id, user = 'alice', amount = 50000) => ({ id, type: 'expense', amount, category_id: 'food',
  note: id, txn_date: '2026-09-15', user_id: user, recurring_id: null, created_at: '2026-09-15T00:00:00.000Z' });
const input = { type: 'expense', amount: 50000, categoryId: 'food', note: 'offline lunch', date: '2026-09-15' };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test('cash balance includes loan principal, monthly results exclude it, and debt rolls over across years', async () => {
  const backend = new Backend();
  const a = await createDevice(backend);
  await a.state.refresh();
  a.navigator.onLine = false;
  await a.state.addTransaction({ type: 'income', amount: 5000000, date: '2026-12-01' });
  await a.state.addTransaction({ ...input, amount: 3000000, date: '2026-12-02' });
  const loan = await a.state.addDebtCharge({ creditorName: 'Anh A', shared: true, amount: 10000000, date: '2026-12-03', addToTransactions: true });
  await a.state.addDebtPayment(loan.creditorId, { amount: 2000000, date: '2026-12-04', addToTransactions: true });
  const dec = a.state.financialMonth(2026, 12);
  assert.equal(dec.income, 5000000);
  assert.equal(dec.expense, 3000000);
  assert.equal(dec.balance, 2000000);
  assert.equal(dec.closingBalance, 10000000);
  assert.equal(dec.payable, 8000000);
  assert.equal(a.state.expenseByCategoryForMonth(2026, 12).get('food'), 3000000);
  const jan = a.state.financialMonth(2027, 1);
  assert.equal(jan.income, 0);
  assert.equal(jan.expense, 0);
  assert.equal(jan.openingBalance, 10000000);
  assert.equal(jan.closingBalance, 10000000);
  assert.equal(jan.payable, 8000000);
  const restarted = await createDevice(backend, { storage: a.storage, online: false });
  assert.equal(restarted.state.financialMonth(2026, 12).closingBalance, 10000000);
  restarted.navigator.onLine = true;
  await restarted.state.refresh();
  const b = await createDevice(backend, { id: 'bob' });
  await b.state.refresh();
  assert.deepEqual(clone(b.state.financialMonth(2026, 12)), clone(dec));
  assert.equal(restarted.state.pendingSyncCount(), 0);
});

test('offline shared lending and collection survive reload, edit and deletion without operating income', async () => {
  const backend = new Backend();
  const a = await createDevice(backend);
  await a.state.refresh();
  a.navigator.onLine = false;
  await a.state.addTransaction({ type: 'income', amount: 10000000, date: '2026-08-31', cashKind: 'opening' });
  const lend = await a.state.addReceivableLend({ debtorName: 'Anh B', shared: true, amount: 4000000, date: '2026-09-02', addToTransactions: true });
  await a.state.addReceivableCollect(lend.debtorId, { amount: 1000000, date: '2026-09-03', addToTransactions: true });
  assert.equal(a.state.financialMonth(2026, 9).receivable, 3000000);
  assert.equal(a.state.financialMonth(2026, 9).closingBalance, 7000000);
  assert.equal(a.state.financialMonth(2026, 9).income, 0);
  assert.equal(a.state.financialMonth(2026, 9).expense, 0);
  await assert.rejects(a.state.addReceivableCollect(lend.debtorId, { amount: 4000000, date: '2026-09-04', addToTransactions: true }), /vượt/);
  const collection = a.state.listReceivableEntries(lend.debtorId).find(e => e.kind === 'collect');
  await a.state.updateReceivableEntry(collection.id, { amount: 2000000, date: collection.date, addToTransactions: true });
  const restarted = await createDevice(backend, { storage: a.storage, online: false });
  assert.equal(restarted.state.financialMonth(2026, 9).receivable, 2000000);
  assert.equal(restarted.state.financialMonth(2026, 9).closingBalance, 8000000);
  await restarted.state.deleteReceivableEntry(collection.id);
  assert.equal(restarted.state.financialMonth(2026, 9).closingBalance, 6000000);
  restarted.navigator.onLine = true;
  await restarted.state.refresh();
  const b = await createDevice(backend, { id: 'bob' });
  await b.state.refresh();
  assert.equal(b.state.financialMonth(2026, 9).receivable, 4000000);
  assert.equal(b.state.financialMonth(2026, 9).closingBalance, 6000000);
  assert.equal(b.state.financialMonth(2026, 8).income, 0);
  assert.equal(b.state.financialMonth(2026, 10).openingBalance, 6000000);
  assert.equal(restarted.state.pendingSyncCount(), 0);
});

test('legacy debt links and categories are reclassified without creating cash or counting personal mirrors', async () => {
  const backend = new Backend();
  backend.rows.transactions = [
    { ...txn('old-borrow'), type: 'income', category_id: 'borrow', amount: 1000 },
    { ...txn('old-repay'), category_id: 'repay', amount: 200 },
    { ...txn('old-lend'), amount: 300 },
  ];
  backend.rows.creditors = [{ id: 'c', shared: true }];
  backend.rows.debt_entries = [{ id: 'd', creditor_id: 'c', kind: 'charge', amount: 1000, entry_date: '2026-09-15', shared: true, transaction_id: 'old-borrow' }];
  backend.rows.debt_entries.push({ id: 'payment', creditor_id: 'c', kind: 'payment', amount: 200, entry_date: '2026-09-15', shared: true, transaction_id: 'old-repay' });
  backend.rows.debtors = [{ id: 'r', shared: true }, { id: 'mirror', user_id: 'alice', shared: false }];
  backend.rows.receivable_entries = [
    { id: 'l', debtor_id: 'r', kind: 'lend', amount: 300, entry_date: '2026-09-15', shared: true, transaction_id: 'old-lend' },
    { id: 'm', debtor_id: 'mirror', kind: 'lend', amount: 1000, entry_date: '2026-09-15', user_id: 'alice', shared: false },
  ];
  for (const id of ['alice', 'bob']) {
    const d = await createDevice(backend, { id });
    await d.state.refresh();
    const position = d.state.financialMonth(2026, 9);
    assert.equal(position.income, 0);
    assert.equal(position.expense, 0);
    assert.equal(position.closingBalance, 500);
    assert.equal(position.receivable, 300);
    assert.equal(position.payable, 800);
  }
  assert.equal(backend.rows.transactions.length, 3);
});

test('offline member borrow and repayment both retain mirror jobs before the first sync', async () => {
  const a = await createDevice(new Backend());
  await a.state.refresh();
  a.navigator.onLine = false;
  const loan = await a.state.addDebtCharge({ memberUserId: 'bob', shared: true, amount: 1000, date: '2026-09-01', addToTransactions: true });
  await a.state.addDebtPayment(loan.creditorId, { amount: 200, date: '2026-09-02', addToTransactions: true });
  assert.equal(a.state.getState().pendingMirrors.length, 2);
  assert.deepEqual(clone(a.state.getState().pendingMirrors.map(j => j.debtKind)), ['charge', 'payment']);
  assert.equal(a.state.financialMonth(2026, 9).payable, 800);
});

test('editing or deleting principal cannot leave repayments greater than the loan', async () => {
  const a = await createDevice(new Backend(), { online: false });
  const loan = await a.state.addReceivableLend({ debtorName: 'Borrower', shared: true, amount: 1000, date: '2026-09-01', addToTransactions: true });
  await a.state.addReceivableCollect(loan.debtorId, { amount: 500, date: '2026-09-02', addToTransactions: true });
  const entry = a.state.listReceivableEntries(loan.debtorId).find(e => e.kind === 'lend');
  await assert.rejects(a.state.updateReceivableEntry(entry.id, { amount: 100, date: entry.date, addToTransactions: true }), /thấp hơn/);
  await assert.rejects(a.state.deleteReceivableEntry(entry.id), /xử lý/);
  await assert.rejects(a.state.deleteTransaction(loan.transactionId), /xử lý/);
  await assert.rejects(a.state.updateTransaction(loan.transactionId, { amount: 100, date: entry.date, type: 'income' }), /thấp hơn/);
  assert.equal(a.state.financialMonth(2026, 9).receivable, 500);
  assert.equal(a.state.financialMonth(2026, 9).closingBalance, -500);
});

test('negative opening balance and non-cash old debt carry forward without revenue or duplicate cash', async () => {
  const a = await createDevice(new Backend(), { online: false });
  await a.state.addTransaction({ type: 'expense', cashKind: 'opening', amount: 2000, date: '2025-12-31' });
  await a.state.addDebtCharge({ creditorName: 'Old debt', shared: true, amount: 4000, date: '2025-12-31', addToTransactions: false });
  const jan = a.state.financialMonth(2026, 1);
  assert.equal(jan.openingBalance, -2000);
  assert.equal(jan.closingBalance, -2000);
  assert.equal(jan.payable, 4000);
  assert.equal(jan.expense, 0);
  assert.equal(a.state.financialMonth(2025, 12).expense, 0);
  await assert.rejects(a.state.addTransaction({ type: 'income', cashKind: 'opening', amount: 1, date: '2025-12-31' }), /Đã có/);
});

class Backend {
  constructor() {
    this.rows = {
      user_profiles: [{ id: 'alice', name: 'Alice', role: 'owner' }, { id: 'bob', name: 'Bob', role: 'member' }],
      categories: [{ id: 'food', name: 'Ăn uống', type: 'expense' },
        { id: 'borrow', name: 'Mượn nợ', special: 'borrow', type: 'income' },
        { id: 'repay', name: 'Trả nợ', special: 'repay', type: 'expense' }],
      app_settings: [{ id: 'main', household_name: 'Sổ chung' }], transactions: [],
    };
    this.calls = [];
    this.hook = null;
  }
  client(jwt, device) {
    const userId = jwt ? JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).row_id : null;
    return { from: (table) => {
      const request = { table, method: 'select', filters: [], userId };
      const query = {
        select: () => query,
        insert: (payload) => { request.method = 'insert'; request.payload = clone(payload); return query; },
        update: (payload) => { request.method = 'update'; request.payload = clone(payload); return query; },
        delete: () => { request.method = 'delete'; return query; },
        eq: (column, value) => { request.filters.push({ column, value }); return query; },
        order: (column) => { request.order = column; return query; },
        range: (from, to) => { request.range = [from, to]; return query; },
        maybeSingle: () => { request.single = true; return query; },
        then: (resolve, reject) => this.execute(request, device).then(resolve, reject),
      };
      return query;
    } };
  }
  async execute(request, device) {
    this.calls.push(clone(request));
    if (!device.navigator.onLine) return { data: null, error: { message: 'Failed to fetch' } };
    if (this.hook) {
      const intercepted = await this.hook(request);
      if (intercepted !== undefined) return intercepted;
    }
    return this.respond(request);
  }
  respond(request) {
    const rows = this.rows[request.table] ||= [];
    const matches = (row) => request.filters.every(({ column, value }) => row[column] === value);
    let data;
    if (request.method === 'insert') {
      const inserted = Array.isArray(request.payload) ? request.payload : [request.payload];
      if (inserted.some((row) => rows.some((r) => row.id === r.id))) return { data: null, error: { code: '23505', message: 'duplicate primary key' } };
      rows.push(...clone(inserted));
      data = inserted.map((row) => ({ id: row.id }));
    } else if (request.method === 'update') {
      data = rows.filter(matches).map((row) => { Object.assign(row, request.payload); return { id: row.id }; });
    } else if (request.method === 'delete') {
      data = rows.filter(matches).map((row) => ({ id: row.id }));
      this.rows[request.table] = rows.filter((row) => !matches(row));
    } else {
      data = rows.filter(matches);
      if (['creditors', 'debt_entries', 'debtors', 'receivable_entries'].includes(request.table)) {
        data = data.filter((row) => row.shared || row.user_id === request.userId);
      }
      if (request.order) data = data.slice().sort((a, b) => String(a[request.order]).localeCompare(String(b[request.order])));
      if (request.range) data = data.slice(request.range[0], request.range[1] + 1);
    }
    return { data: clone(request.single ? data[0] || null : data), error: null };
  }
}

async function createDevice(backend, { id = 'alice', storage = new Map(), online = true, signedIn = true } = {}) {
  const navigator = { onLine: online };
  const device = { navigator, storage, failStorage: false };
  const context = vm.createContext({ navigator, crypto: webcrypto, Date, URL, URLSearchParams, atob,
    console: { warn() {}, error() {}, log() {} }, setTimeout, clearTimeout,
    localStorage: {
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index] ?? null,
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { if (device.failStorage) throw Error('QuotaExceededError'); storage.set(key, value); },
      removeItem: (key) => storage.delete(key),
    },
  });
  const modules = new Map();
  const synthetic = (exports, identifier) => new vm.SyntheticModule(Object.keys(exports), function() {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context, identifier });
  const api = synthetic({
    getSupabaseClient: (jwt) => backend.client(jwt, device),
    callLoginFunction: async ({ identifier }) => ({ ok: true, id: identifier, role: 'member', token: token(identifier) }),
    callAccountFunction: async (jwt, body) => backend.accountFunction ? backend.accountFunction(jwt, body) : ({ ok: true }),
  }, 'api');
  const push = synthetic({ subscribeThisDevice() {}, unsubscribeThisDevice() {}, getCurrentEndpoint() {} }, 'push');
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = new vm.SourceTextModule(await fs.readFile(file, 'utf8'), { context, identifier: file });
    modules.set(file, module);
    await module.link((specifier, importer) => {
      if (specifier.endsWith('lib/supabaseClient.js')) return api;
      if (specifier.endsWith('lib/push.js')) return push;
      return load(path.resolve(path.dirname(importer.identifier), specifier));
    });
    return module;
  }
  const module = await load(path.join(ROOT, 'js/state.js'));
  await module.evaluate();
  device.state = module.namespace;
  await device.state.init();
  if (signedIn) device.state.setSession({ id, role: id === 'alice' ? 'owner' : 'member', sbToken: token(id) });
  device.saved = () => JSON.parse(storage.get('chitieu_v1'));
  return device;
}

test('two separate devices share an offline transaction only after server sync', async () => {
  const backend = new Backend();
  const a = await createDevice(backend, { online: false });
  const b = await createDevice(backend, { id: 'bob' });
  await a.state.addTransaction(input);
  assert.equal(a.state.pendingSyncCount(), 1);
  assert.equal(a.saved().outbox.length, 1);
  await b.state.refresh();
  assert.equal(b.state.listTransactions().length, 0);
  a.navigator.onLine = true;
  await a.state.refresh();
  await b.state.refresh();
  assert.equal(a.state.pendingSyncCount(), 0);
  assert.equal(b.state.listTransactions().length, 1);
  assert.equal(b.state.listTransactions()[0].userId, 'alice');
  assert.equal(b.state.listTransactions()[0].createdAt, a.state.listTransactions()[0].createdAt);
});

test('online write is durable before response; reload safely retries a committed insert', async () => {
  const backend = new Backend();
  const storage = new Map();
  const a = await createDevice(backend, { storage });
  const sent = deferred(), response = deferred();
  backend.hook = (request) => {
    if (request.method === 'insert' && request.table === 'transactions') {
      const result = backend.respond(request);
      sent.resolve();
      return response.promise.then(() => result);
    }
  };
  const firstWrite = a.state.addTransaction(input);
  await sent.promise;
  assert.equal(a.saved().outbox.length, 1);
  assert.equal(a.saved().transactions.length, 1);
  backend.hook = null;
  const rebooted = await createDevice(backend, { storage });
  await rebooted.state.refresh();
  assert.equal(backend.rows.transactions.length, 1);
  assert.equal(rebooted.state.pendingSyncCount(), 0);
  assert.equal(rebooted.state.listTransactions().length, 1);
  response.resolve();
  await firstWrite;
});

test('pending INSERT then online UPDATE and DELETE preserve server order', async () => {
  const backend = new Backend();
  const a = await createDevice(backend, { online: false });
  await a.state.addTransaction(input);
  const id = a.state.listTransactions()[0].id;
  a.navigator.onLine = true;
  await a.state.updateTransaction(id, { ...input, amount: 90000 });
  assert.equal(backend.rows.transactions[0].amount, 90000);
  a.navigator.onLine = false;
  await a.state.deleteTransaction(id);
  assert.equal(a.state.listTransactions().length, 0);
  a.navigator.onLine = true;
  await a.state.refresh();
  assert.equal(backend.rows.transactions.length, 0);
  assert.deepEqual(backend.calls.filter((r) => r.table === 'transactions' && r.method !== 'select').map((r) => r.method), ['insert', 'update', 'delete']);
});

test('optional missing table does not block remote transactions', async () => {
  const backend = new Backend();
  backend.rows.transactions.push(txn('remote', 'bob'));
  backend.hook = (r) => r.table === 'notifications' ? { data: null, error: { code: '42P01', message: 'missing table' } } : undefined;
  const a = await createDevice(backend);
  await a.state.refresh();
  assert.equal(a.state.listTransactions()[0].id, 'remote');
});

test('failed pending writes remain counted and merge with other users remote rows', async () => {
  const backend = new Backend();
  const a = await createDevice(backend, { online: false });
  await a.state.addTransaction(input);
  a.state.getState().outbox[0].stuck = true; // cache migrated from previous app
  backend.rows.transactions.push(txn('remote', 'bob'));
  backend.hook = (r) => r.method === 'insert' ? { data: null, error: { code: '42501', message: 'RLS denied' } } : undefined;
  a.navigator.onLine = true;
  await a.state.refresh();
  assert.equal(a.state.pendingSyncCount(), 1);
  assert.equal(a.state.listTransactions().length, 2);
  assert.match(a.state.getSyncIssue().message, /RLS denied/);
  backend.hook = null;
  await a.state.refresh();
  assert.equal(a.state.pendingSyncCount(), 0);
  assert.equal(backend.rows.transactions.length, 2);
});

test('read failure preserves cache and reports a problem; core failure blocks false empty login', async () => {
  const backend = new Backend();
  backend.rows.transactions.push(txn('saved'));
  const a = await createDevice(backend);
  await a.state.refresh();
  backend.hook = (r) => r.table === 'transactions' && r.method === 'select' ? { data: null, error: { code: '42501', message: 'denied' } } : undefined;
  await a.state.refresh();
  assert.equal(a.state.listTransactions().length, 1);
  assert.match(a.state.getSyncIssue().message, /denied/);
  const b = await createDevice(backend, { signedIn: false });
  const login = await b.state.login('bob', 'test');
  assert.equal(login.ok, false);
});

test('loads more than the default 1000-row API limit with pagination', async () => {
  const backend = new Backend();
  backend.rows.transactions = Array.from({ length: 1201 }, (_, i) => txn('t' + i));
  const a = await createDevice(backend);
  await a.state.refresh();
  assert.equal(a.state.listTransactions().length, 1201);
  assert.equal(backend.calls.filter((r) => r.table === 'transactions').length, 3);
});

test('stale pull cannot overwrite a transaction written while it was in flight', async () => {
  const backend = new Backend();
  const a = await createDevice(backend);
  const started = deferred(), resume = deferred();
  backend.hook = (r) => {
    if (r.table === 'transactions' && r.method === 'select') {
      const snapshot = backend.respond(r);
      started.resolve();
      return resume.promise.then(() => snapshot);
    }
  };
  const pull = a.state.refresh();
  await started.promise;
  await a.state.addTransaction(input);
  resume.resolve();
  await pull;
  assert.equal(a.state.listTransactions().length, 1);
  assert.equal(a.state.pendingSyncCount(), 0);
});

test('concurrent refresh callers share one pull; logout discards old response', async () => {
  const backend = new Backend();
  backend.rows.transactions.push(txn('private-session-result'));
  const a = await createDevice(backend);
  const started = deferred(), resume = deferred();
  backend.hook = (r) => {
    if (r.table === 'transactions' && r.method === 'select') { started.resolve(); return resume.promise.then(() => backend.respond(r)); }
  };
  const first = a.state.refresh(), second = a.state.refresh();
  assert.equal(first, second);
  await started.promise;
  a.state.logout();
  resume.resolve();
  await first;
  assert.equal(a.state.getSession(), null);
  assert.equal(a.state.listTransactions().length, 0);
  assert.equal(backend.calls.filter((r) => r.table === 'transactions').length, 1);
});

test('changing account preserves outbox and requires its author to sync', async () => {
  const backend = new Backend();
  const a = await createDevice(backend, { online: false });
  await a.state.addTransaction(input);
  a.state.logout();
  a.navigator.onLine = true;
  const login = await a.state.login('bob', 'test');
  a.state.setSession({ id: login.userId, role: login.role, sbToken: login.sbToken });
  assert.equal(a.state.listTransactions().length, 1);
  await a.state.refresh();
  assert.equal(a.state.pendingSyncCount(), 1);
  assert.equal(backend.rows.transactions.length, 0);
  a.state.setSession({ id: 'alice', role: 'owner', sbToken: token('alice') });
  await a.state.refresh();
  assert.equal(a.state.pendingSyncCount(), 0);
  assert.equal(backend.rows.transactions[0].user_id, 'alice');
});

test('storage quota failure does not pretend the transaction was saved', async () => {
  const backend = new Backend();
  const a = await createDevice(backend);
  a.failStorage = true;
  await assert.rejects(a.state.addTransaction(input));
  assert.equal(a.state.listTransactions().length, 0);
  assert.equal(backend.rows.transactions.length, 0);
});

test('success response with no inserted row is kept pending', async () => {
  const backend = new Backend();
  backend.hook = (r) => r.method === 'insert' ? { data: [], error: null } : undefined;
  const a = await createDevice(backend);
  await a.state.addTransaction(input);
  assert.equal(a.state.pendingSyncCount(), 1);
  assert.match(a.state.getSyncIssue().message, /RLS/);
});

test('unrelated unique constraint violation is not discarded as a successful insert', async () => {
  const backend = new Backend();
  backend.hook = (r) => r.method === 'insert' ? { data: null, error: { code: '23505', message: 'some_other_unique_constraint' } } : undefined;
  const a = await createDevice(backend);
  await a.state.addTransaction(input);
  assert.equal(a.state.pendingSyncCount(), 1);
  assert.equal(backend.rows.transactions.length, 0);
});

test('legacy local-only transactions are retained for explicit recovery, not silently lost or resurrected', async () => {
  const backend = new Backend();
  const storage = new Map();
  const a = await createDevice(backend, { storage });
  const old = a.saved();
  delete old.syncVersion;
  old.transactions = [{ id: 'legacy', type: 'expense', amount: 20000, categoryId: 'food', date: '2026-09-14',
    userId: 'alice', note: 'old write', recurringId: null, createdAt: '2026-09-14T10:00:00.000Z' }];
  storage.set('chitieu_v1', JSON.stringify(old));
  const migrated = await createDevice(backend, { storage });
  await migrated.state.refresh();
  assert.equal(migrated.state.listRecoverableTransactions().length, 1);
  assert.equal(backend.rows.transactions.length, 0);
  await migrated.state.recoverTransactions(['legacy']);
  assert.equal(backend.rows.transactions[0].id, 'legacy');
  assert.equal(migrated.state.listRecoverableTransactions().length, 0);
  assert.equal(migrated.state.pendingSyncCount(), 0);
});

test('scheduler pulls on timer with an empty outbox and on focus / reconnect', async () => {
  const source = await fs.readFile(path.join(ROOT, 'js/lib/autoSync.js'), 'utf8');
  const module = new vm.SourceTextModule(source, { context: vm.createContext({ console }) });
  await module.link(() => {}); await module.evaluate();
  const win = new EventTarget(), doc = new EventTarget();
  doc.visibilityState = 'visible';
  let tick, calls = 0;
  win.setInterval = (fn, ms) => { tick = fn; assert.equal(ms, 5000); return 1; };
  win.clearInterval = () => {};
  const stop = module.namespace.startAutoSync({ getSession: () => ({}), refresh: async () => { calls++; } }, { window: win, document: doc });
  await tick();
  win.dispatchEvent(new Event('focus'));
  win.dispatchEvent(new Event('online'));
  assert.equal(calls, 3);
  doc.visibilityState = 'hidden';
  await tick();
  assert.equal(calls, 3);
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 4);
  stop();
  win.dispatchEvent(new Event('focus'));
  assert.equal(calls, 4);
});

test('two tabs cannot overwrite each others durable outbox when saving their cache', async () => {
  const backend = new Backend(), storage = new Map();
  const tab1 = await createDevice(backend, { storage, online: false });
  const tab2 = await createDevice(backend, { storage, online: false });
  await tab1.state.addTransaction({ ...input, note: 'first tab' });
  await tab2.state.addTransaction({ ...input, note: 'second tab' });
  tab1.state.setSession({ id: 'alice', sbToken: token('alice') }); // persists older cache
  const rebooted = await createDevice(backend, { storage, online: false });
  assert.equal(rebooted.state.listTransactions().length, 2);
  assert.equal(rebooted.state.pendingSyncCount(), 2);
  rebooted.navigator.onLine = true;
  await rebooted.state.refresh();
  assert.equal(backend.rows.transactions.length, 2);
  tab2.navigator.onLine = true;
  await tab2.state.refresh();
  assert.equal(tab2.state.pendingSyncCount(), 0);
  assert.equal(backend.rows.transactions.length, 2);
});

test('offline restart reconstructs local transaction from outbox even if cache was not saved', async () => {
  const backend = new Backend(), storage = new Map();
  const a = await createDevice(backend, { storage, online: false });
  const oldCache = storage.get('chitieu_v1');
  await a.state.addTransaction(input);
  const id = a.state.listTransactions()[0].id;
  await a.state.updateTransaction(id, { ...input, amount: 75000 });
  storage.set('chitieu_v1', oldCache); // abrupt close before cache update; op keys survived
  const rebooted = await createDevice(backend, { storage, online: false });
  assert.equal(rebooted.state.listTransactions()[0].amount, 75000);
  assert.equal(rebooted.state.pendingSyncCount(), 2);
});


test('untracked repayments count as expenses; tracked principal stays excluded after sync and reload', async () => {
  const backend = new Backend();
  const a = await createDevice(backend);
  await a.state.refresh();
  a.navigator.onLine = false;
  const loan = await a.state.addDebtCharge({ creditorName: 'Lender', shared: true, amount: 1000, date: '2026-09-01', addToTransactions: true });
  await a.state.addDebtPayment(loan.creditorId, { amount: 200, date: '2026-09-02', categoryId: 'repay', addToTransactions: true });
  await a.state.addTransaction({ type: 'expense', amount: 300, categoryId: 'repay', date: '2026-09-03' });
  const check = state => {
    const result = state.financialMonth(2026, 9);
    assert.equal(result.expense, 300);
    assert.equal(result.repay, 200);
    assert.equal(result.closingBalance, 500);
    assert.equal(result.payable, 800);
    assert.equal(state.expenseByCategoryForMonth(2026, 9).get('repay'), 300);
  };
  check(a.state);
  const restarted = await createDevice(backend, { storage: a.storage, online: false });
  check(restarted.state);
  restarted.navigator.onLine = true;
  await restarted.state.refresh();
  const b = await createDevice(backend, { id: 'bob' });
  await b.state.refresh();
  check(b.state);
});

test('member loans appear only in that members personal receivables; same-name outsiders do not mirror', async () => {
  const backend = new Backend();
  const requests = [];
  backend.accountFunction = async (jwt, body) => {
    requests.push(clone(body));
    assert.equal(body.type, 'debt-mirror-add');
    const debtorId = body.debtorId || 'mirror-bob';
    const entryId = 'mirror-entry-' + requests.length;
    if (!body.debtorId) (backend.rows.debtors ||= []).push({ id: debtorId, name: body.name, user_id: body.memberUserId, shared: false });
    (backend.rows.receivable_entries ||= []).push({ id: entryId, debtor_id: debtorId, kind: body.kind, amount: body.amount, entry_date: body.date, user_id: body.memberUserId, shared: false, created_at: '2026-09-16T00:00:00.000Z' });
    return { ok: true, debtorId, entryId };
  };
  const a = await createDevice(backend);
  await a.state.refresh();
  a.navigator.onLine = false;
  const outside = await a.state.addDebtCharge({ creditorName: 'Bob', shared: true, amount: 3000, date: '2026-09-01', addToTransactions: true });
  const member = await a.state.addDebtCharge({ memberUserId: 'bob', shared: true, amount: 1000, date: '2026-09-02', addToTransactions: true });
  await a.state.addDebtPayment(member.creditorId, { amount: 200, date: '2026-09-03', addToTransactions: true });
  assert.notEqual(outside.creditorId, member.creditorId);
  assert.equal(a.state.getCreditor(outside.creditorId).memberUserId, null);
  assert.equal(a.state.getState().pendingMirrors.length, 2);
  const restarted = await createDevice(backend, { storage: a.storage, online: false });
  restarted.navigator.onLine = true;
  await restarted.state.refresh();
  assert.equal(restarted.state.pendingSyncCount(), 0);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.memberUserId === 'bob'));
  const b = await createDevice(backend, { id: 'bob' });
  await b.state.refresh();
  assert.equal(b.state.totalReceivable(), 800);
  assert.equal(b.state.financialMonth(2026, 9).receivable, 0);
  assert.equal(b.state.financialMonth(2026, 9).payable, 3800);
  assert.equal(restarted.state.totalReceivable(), 0);
});
