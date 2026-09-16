// One accounting policy for dashboard, reports, budgets and transaction history.
// New cash transactions carry an immutable kind in their text ID (existing DB schema).
// Legacy rows use their debt link or system category; notes are never parsed as metadata.
export const FINANCE_LABELS = {
  borrow: 'Tiền vay vào', repay: 'Trả nợ gốc', lend: 'Tiền cho vay',
  collect: 'Thu hồi gốc', opening: 'Số dư ban đầu', income: 'Doanh thu / thu nhập', expense: 'Chi phí',
};

export function transactionKind(state, txn) {
  const tagged = /^txn_(?:private_)?(borrow|repay|lend|collect|opening)_/.exec(txn.id || '');
  if (tagged) return tagged[1];
  const debt = state.debtEntries.find(e => e.shared && e.transactionId === txn.id);
  if (debt) return debt.kind === 'charge' ? 'borrow' : 'repay';
  const receivable = state.receivableEntries.find(e => e.shared && e.transactionId === txn.id);
  if (receivable) return receivable.kind === 'lend' ? 'lend' : 'collect';
  const special = state.categories.find(c => c.id === txn.categoryId)?.special;
  return ['borrow', 'repay'].includes(special) ? special : txn.type;
}

export function isBookTransaction(state, txn) {
  if (/^txn_private_/.test(txn.id || '')) return false;
  // Existing transactions belong to the shared book; only explicitly tagged private
  // entries are excluded. This keeps legacy totals identical for different accounts.
  return true;
}

export function summarizeTransactions(state, transactions) {
  const totals = { income: 0, expense: 0, borrow: 0, repay: 0, lend: 0, collect: 0, opening: 0, cashIn: 0, cashOut: 0 };
  for (const txn of transactions) {
    if (!isBookTransaction(state, txn)) continue;
    const amount = Number(txn.amount) || 0;
    const kind = transactionKind(state, txn);
    totals[kind] += kind === 'opening' && txn.type === 'expense' ? -amount : amount;
    totals[txn.type === 'income' ? 'cashIn' : 'cashOut'] += amount;
  }
  return { ...totals, balance: totals.income - totals.expense, cashChange: totals.cashIn - totals.cashOut };
}

export function outstandingAt(state, to, shared = true) {
  const sum = (people, entries, key, increase) => people
    .filter(p => !!p.shared === shared)
    .reduce((total, p) => total + Math.max(0, entries
      .filter(e => e[key] === p.id && e.date <= to)
      .reduce((n, e) => n + (e.kind === increase ? e.amount : -e.amount), 0)), 0);
  return {
    payable: sum(state.creditors, state.debtEntries, 'creditorId', 'charge'),
    receivable: sum(state.debtors, state.receivableEntries, 'debtorId', 'lend'),
  };
}

export function financePeriod(state, from, to) {
  const before = summarizeTransactions(state, state.transactions.filter(t => t.date < from));
  const period = summarizeTransactions(state, state.transactions.filter(t => t.date >= from && t.date <= to));
  return { ...period, openingBalance: before.cashChange,
    closingBalance: before.cashChange + period.cashChange, ...outstandingAt(state, to) };
}
