const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Dates coming from a backup JSON may be full ISO datetime strings (e.g. from a re-serialized
// API response) rather than plain YYYY-MM-DD - MySQL's DATE columns reject the former.
function normalizeDate(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}

// Shared helper: ensure a bank account exists for this user (matched by name, case-insensitive).
// Returns its id. If it already exists, its opening_balance is left untouched unless updateOpening
// is provided - imports should only override balances for a FULL backup, not a single month's data.
// For a genuinely NEW account with a positive opening balance, also creates the linked
// is_opening_balance transaction (matching how the normal Add Bank Account screen does it) -
// without this, the account has a starting number but no real transaction backing it, so
// features like the opening-balance date have nothing to read.
async function ensureAccount(conn, userId, accountMap, name, isCash, openingBalance, updateOpening, ledgerId, openingBalanceDate) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (accountMap[key]) {
    if (updateOpening) {
      await conn.query('UPDATE bank_accounts SET opening_balance = ? WHERE id = ?', [openingBalance || 0, accountMap[key]]);
    }
    return accountMap[key];
  }
  const [result] = await conn.query(
    'INSERT INTO bank_accounts (user_id, name, is_cash, opening_balance) VALUES (?, ?, ?, ?)',
    [userId, name, !!isCash, openingBalance || 0]
  );
  accountMap[key] = result.insertId;
  if (ledgerId) {
    await conn.query(
      'INSERT INTO ledger_account_openings (ledger_id, account_id, opening_balance) VALUES (?, ?, ?)',
      [ledgerId, result.insertId, openingBalance || 0]
    );
  }
  if (openingBalance > 0 && ledgerId) {
    await conn.query(
      `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, is_opening_balance)
       VALUES (?, ?, ?, 'income', ?, ?, TRUE)`,
      [ledgerId, result.insertId, `Opening balance - ${name}`, openingBalance, openingBalanceDate || new Date().toISOString().slice(0, 10)]
    );
  }
  return result.insertId;
}

async function ensureCategory(conn, userId, categorySet, name, type) {
  if (!name) return;
  const key = name.trim().toLowerCase() + '|' + type;
  if (categorySet.has(key)) return;
  await conn.query('INSERT INTO categories (user_id, name, type, icon) VALUES (?, ?, ?, ?)', [userId, name, type, 'ti-dots']);
  categorySet.add(key);
}
// Bulk version used only by /full, which already has its whole category list upfront (unlike
// /month, which discovers categories one at a time as it processes each transaction).
async function bulkEnsureCategories(conn, userId, categorySet, categories) {
  const toInsert = [];
  for (const cat of categories) {
    if (!cat.name) continue;
    const key = cat.name.trim().toLowerCase() + '|' + cat.type;
    if (categorySet.has(key)) continue;
    categorySet.add(key);
    toInsert.push([userId, cat.name, cat.type, 'ti-dots']);
  }
  if (toInsert.length > 0) {
    await conn.query('INSERT INTO categories (user_id, name, type, icon) VALUES ?', [toInsert]);
  }
}

// POST /api/import/full - restores a full backup JSON (from "Download everything") into a brand
// new ledger. Bank accounts, categories, and employees are matched by name and reused if they
// already exist (since those already carry across ledgers) - only transactions, transfers, salary
// history, and loans land fresh in the new ledger. The current active ledger is never touched.
router.post('/full', async (req, res) => {
  const { bankAccounts, categories, transactions, transfers, employees, loans } = req.body;
  if (!Array.isArray(bankAccounts) || !Array.isArray(transactions)) {
    return res.status(400).json({ error: 'This does not look like a valid full backup file.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('UPDATE ledgers SET is_active = FALSE WHERE user_id = ? AND is_active = TRUE', [req.userId]);
    const importName = 'Imported backup - ' + new Date().toISOString().slice(0, 10);
    const [newLedgerResult] = await conn.query('INSERT INTO ledgers (user_id, name, is_active) VALUES (?, ?, TRUE)', [req.userId, importName]);
    const newLedgerId = newLedgerResult.insertId;

    const [existingAccounts] = await conn.query('SELECT * FROM bank_accounts WHERE user_id = ?', [req.userId]);
    const accountMap = {};
    existingAccounts.forEach(a => { accountMap[a.name.toLowerCase()] = a.id; });
    for (const acct of bankAccounts) {
      // Never overwrite an EXISTING account's opening balance - accounts are shared across
      // ledgers, so an account matched by name here could be one you've used for weeks with
      // its own real history. Only a genuinely new account (one that doesn't exist yet) gets
      // its opening balance set from the backup.
      await ensureAccount(conn, req.userId, accountMap, acct.name, acct.isCash, acct.openingBalance, false, newLedgerId, acct.openingBalanceDate);
    }

    const [existingCategories] = await conn.query('SELECT * FROM categories WHERE user_id = ?', [req.userId]);
    const categorySet = new Set(existingCategories.map(c => c.name.toLowerCase() + '|' + c.type));
    await bulkEnsureCategories(conn, req.userId, categorySet, categories || []);

    let txnCount = 0, skippedTxn = 0;
    const txnRows = [];
    for (const t of transactions) {
      const accountId = accountMap[(t.account || '').trim().toLowerCase()];
      if (!accountId || !t.date || !t.category || !t.type || !t.amount) { skippedTxn++; continue; }
      txnRows.push([
        newLedgerId, accountId, t.category, t.subcategory || null, t.type, t.amount,
        normalizeDate(t.date), t.forMonth ? normalizeDate(t.forMonth).slice(0, 7) + '-01' : null, t.notes || null
      ]);
      txnCount++;
    }
    if (txnRows.length > 0) {
      await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes) VALUES ?`,
        [txnRows]
      );
    }

    let transferCount = 0, skippedTransfer = 0;
    const transferRows = [];
    for (const tr of (transfers || [])) {
      const fromId = accountMap[(tr.from || '').trim().toLowerCase()];
      const toId = accountMap[(tr.to || '').trim().toLowerCase()];
      if (!fromId || !toId || !tr.date || !tr.amount) { skippedTransfer++; continue; }
      transferRows.push([newLedgerId, fromId, toId, tr.amount, normalizeDate(tr.date), tr.notes || null]);
      transferCount++;
    }
    if (transferRows.length > 0) {
      await conn.query('INSERT INTO transfers (ledger_id, from_account_id, to_account_id, amount, txn_date, notes) VALUES ?', [transferRows]);
    }

    const [existingEmployees] = await conn.query('SELECT * FROM employees WHERE user_id = ?', [req.userId]);
    const employeeMap = {};
    existingEmployees.forEach(e => { employeeMap[e.name.toLowerCase()] = e.id; });
    let employeeCount = 0, salaryCount = 0;
    for (const emp of (employees || [])) {
      if (!emp.name || !emp.dateOfJoining) continue;
      const key = emp.name.trim().toLowerCase();
      let empId = employeeMap[key];
      if (!empId) {
        const [result] = await conn.query(
          'INSERT INTO employees (user_id, name, date_of_joining, date_of_relieving, fixed_salary) VALUES (?, ?, ?, ?, ?)',
          [req.userId, emp.name, emp.dateOfJoining, emp.dateOfRelieving || null, emp.fixedSalary || null]
        );
        empId = result.insertId;
        employeeMap[key] = empId;
        employeeCount++;
      }
      for (const h of (emp.salaryHistory || [])) {
        if (!h.forMonth || h.netPayable === undefined) continue;
        await conn.query(
          `INSERT INTO salary_history (employee_id, ledger_id, for_month, prorated_amount, lop_days, total_advance, net_payable)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [empId, newLedgerId, normalizeDate(h.forMonth), h.proratedAmount || 0, h.lopDays || 0, h.totalAdvance || 0, h.netPayable]
        );
        salaryCount++;
      }
    }

    let loanCount = 0, repaymentCount = 0;
    for (const loan of (loans || [])) {
      if (!loan.borrowedFrom || !loan.amount || !loan.date) continue;
      // Loan's own account may not exist as a bank account (e.g. was "Cash") - ensure it, defaulting to the first known account if genuinely unresolvable.
      let loanAccountId = accountMap[(loan.account || '').trim().toLowerCase()];
      if (!loanAccountId) loanAccountId = Object.values(accountMap)[0] || null;
      if (!loanAccountId) continue;
      const [result] = await conn.query(
        'INSERT INTO loans (ledger_id, user_id, borrowed_from, amount, txn_date, notes, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newLedgerId, req.userId, loan.borrowedFrom, loan.amount, normalizeDate(loan.date), loan.notes || null, loanAccountId]
      );
      const loanId = result.insertId;
      loanCount++;
      for (const rep of (loan.repayments || [])) {
        if (!rep.date || !rep.amount) continue;
        let repAccountId = accountMap[(rep.account || '').trim().toLowerCase()] || loanAccountId;
        await conn.query(
          'INSERT INTO loan_repayments (loan_id, repayment_date, amount, account_id) VALUES (?, ?, ?, ?)',
          [loanId, normalizeDate(rep.date), rep.amount, repAccountId]
        );
        repaymentCount++;
      }
    }

    await conn.commit();
    const token = jwt.sign({ userId: req.userId, ledgerId: newLedgerId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      newLedgerId,
      token,
      summary: {
        transactions: txnCount, skippedTransactions: skippedTxn,
        transfers: transferCount, skippedTransfers: skippedTransfer,
        newEmployees: employeeCount, salaryEntries: salaryCount,
        loans: loanCount, repayments: repaymentCount
      }
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  } finally {
    conn.release();
  }
});

// POST /api/import/month - restores a single month's CSV-derived transactions into a brand new
// ledger. Simpler than the full import: just transactions, no transfers/employees/loans (those
// aren't reliably reconstructable from the flattened monthly CSV format).
router.post('/month', async (req, res) => {
  const { monthLabel, transactions } = req.body;
  if (!Array.isArray(transactions)) {
    return res.status(400).json({ error: 'This does not look like a valid monthly backup file.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('UPDATE ledgers SET is_active = FALSE WHERE user_id = ? AND is_active = TRUE', [req.userId]);
    const importName = 'Imported month' + (monthLabel ? (' - ' + monthLabel) : '');
    const [newLedgerResult] = await conn.query('INSERT INTO ledgers (user_id, name, is_active) VALUES (?, ?, TRUE)', [req.userId, importName]);
    const newLedgerId = newLedgerResult.insertId;

    const [existingAccounts] = await conn.query('SELECT * FROM bank_accounts WHERE user_id = ?', [req.userId]);
    const accountMap = {};
    existingAccounts.forEach(a => { accountMap[a.name.toLowerCase()] = a.id; });

    const [existingCategories] = await conn.query('SELECT * FROM categories WHERE user_id = ?', [req.userId]);
    const categorySet = new Set(existingCategories.map(c => c.name.toLowerCase() + '|' + c.type));

    let txnCount = 0, skipped = 0;
    for (const t of transactions) {
      if (!t.date || !t.category || !t.type || !t.amount || !t.account) { skipped++; continue; }
      const accountId = await ensureAccount(conn, req.userId, accountMap, t.account, /cash/i.test(t.account), 0, false);
      await ensureCategory(conn, req.userId, categorySet, t.category, t.type);
      await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newLedgerId, accountId, t.category, t.subcategory || null, t.type, t.amount, normalizeDate(t.date), t.notes || null]
      );
      txnCount++;
    }

    await conn.commit();
    const token = jwt.sign({ userId: req.userId, ledgerId: newLedgerId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ newLedgerId, token, summary: { transactions: txnCount, skipped } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
