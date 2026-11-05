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
// new ledger. The file may also carry a ledgerName (the new ledger's name), and payments to employees:
// a transaction (income or expense) with an "employee" name is saved as a payment to that employee (so it counts in their
// balance), and an employee's "trackFrom" sets where counting their salary starts. Bank accounts, categories, and employees are matched by name and reused if they
// already exist (since those already carry across ledgers) - only transactions, transfers, salary
// history, and loans land fresh in the new ledger. The current active ledger is never touched.
router.post('/full', async (req, res) => {
  const { bankAccounts, categories, transactions, transfers, employees, loans, ledgerName } = req.body;
  if (!Array.isArray(bankAccounts) || !Array.isArray(transactions)) {
    return res.status(400).json({ error: 'This does not look like a valid full backup file.' });
  }
  // "intoCurrentLedger": true in the file = fill the ledger you are in now instead of making a new one.
  const intoCurrent = req.body.intoCurrentLedger === true;

  const customName = (typeof ledgerName === 'string') ? ledgerName.trim().slice(0, 100) : '';

  const conn = await pool.getConnection();
  try {
    let currentLedgerName = null;
    if (intoCurrent) {
      // Only an EMPTY ledger can be filled: adding to a ledger that already has data would double it.
      const [cur] = await conn.query('SELECT id, name FROM ledgers WHERE id = ? AND user_id = ?', [req.ledgerId, req.userId]);
      if (cur.length === 0) {
        return res.status(409).json({ error: 'There is no current ledger to import into. Please log out and log in again.' });
      }
      const [[used]] = await conn.query(
        'SELECT (SELECT COUNT(*) FROM transactions WHERE ledger_id = ?) AS t, (SELECT COUNT(*) FROM transfers WHERE ledger_id = ?) AS tr, (SELECT COUNT(*) FROM loans WHERE ledger_id = ?) AS l',
        [cur[0].id, cur[0].id, cur[0].id]
      );
      if (Number(used.t) + Number(used.tr) + Number(used.l) > 0) {
        return res.status(409).json({ error: `Your current ledger "${cur[0].name}" already has data (${used.t} transactions, ${used.l} loans). This file fills an EMPTY ledger, so nothing was imported. Switch to an empty ledger, or remove "intoCurrentLedger" from the file to import into a new ledger.` });
      }
      currentLedgerName = cur[0].name;
    }
    // A named import can only be done once: importing the same file twice would double every payment.
    if (customName && !intoCurrent) {
      const [same] = await conn.query('SELECT id FROM ledgers WHERE user_id = ? AND LOWER(name) = LOWER(?)', [req.userId, customName]);
      if (same.length > 0) {
        return res.status(409).json({ error: `A ledger named "${customName}" already exists, so this file looks like it has already been imported. Delete that ledger first if you want to import it again.` });
      }
    }
    await conn.beginTransaction();

    let importName, newLedgerId;
    if (intoCurrent) {
      importName = currentLedgerName;
      newLedgerId = req.ledgerId;
      await conn.query('UPDATE ledgers SET is_active = (id = ?) WHERE user_id = ?', [newLedgerId, req.userId]);
    } else {
      await conn.query('UPDATE ledgers SET is_active = FALSE WHERE user_id = ? AND is_active = TRUE', [req.userId]);
      importName = customName || ('Imported backup - ' + new Date().toISOString().slice(0, 10));
      const [newLedgerResult] = await conn.query('INSERT INTO ledgers (user_id, name, is_active) VALUES (?, ?, TRUE)', [req.userId, importName]);
      newLedgerId = newLedgerResult.insertId;
    }

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

    const [existingEmployees] = await conn.query('SELECT * FROM employees WHERE user_id = ?', [req.userId]);
    const employeeMap = {};
    existingEmployees.forEach(e => { employeeMap[e.name.toLowerCase()] = e.id; });
    let employeeCount = 0, salaryCount = 0;
    const trackRows = [];
    for (const emp of (employees || [])) {
      if (!emp.name || !emp.dateOfJoining) continue;
      const key = emp.name.trim().toLowerCase();
      let empId = employeeMap[key];
      let createdNow = false;
      if (!empId) {
        const [result] = await conn.query(
          'INSERT INTO employees (user_id, name, date_of_joining, date_of_relieving, fixed_salary) VALUES (?, ?, ?, ?, ?)',
          [req.userId, emp.name, emp.dateOfJoining, emp.dateOfRelieving || null, emp.fixedSalary || null]
        );
        empId = result.insertId;
        employeeMap[key] = empId;
        employeeCount++;
        createdNow = true;
      }
      // where counting this employee's salary starts - only set for employees created by this import
      if (createdNow && emp.trackFrom) trackRows.push([empId, normalizeDate(emp.trackFrom)]);
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

    if (trackRows.length > 0) {
      await conn.query('INSERT IGNORE INTO employee_track_start (employee_id, track_from) VALUES ?', [trackRows]);
    }

    let txnCount = 0, skippedTxn = 0, paymentCount = 0, unlinkedPayments = 0;
    const txnRows = [];
    const paymentTxns = [];
    // An account's opening balance entry (isOpeningBalance: true) is stored the way the app stores its own:
    // flagged as an opening balance. The app only adds an account's stored opening balance when the ledger has
    // NO flagged entry for it - so a plain income entry for the same money would be counted twice.
    const openingRows = [];
    const openingByAccount = {};
    for (const t of transactions) {
      const accountId = accountMap[(t.account || '').trim().toLowerCase()];
      if (!accountId || !t.date || !t.category || !t.type || !t.amount) { skippedTxn++; continue; }
      const row = [
        newLedgerId, accountId, t.category, t.subcategory || null, t.type, t.amount,
        normalizeDate(t.date), t.forMonth ? normalizeDate(t.forMonth).slice(0, 7) + '-01' : null, t.notes || null
      ];
      const payEmpId = t.employee ? employeeMap[String(t.employee).trim().toLowerCase()] : null;
      if (t.isOpeningBalance === true && !payEmpId && t.type === 'income' && openingByAccount[accountId] === undefined) {
        openingByAccount[accountId] = Number(t.amount);   // one per account, as the app itself keeps it
        openingRows.push(row);
      } else if (payEmpId) {   // income or expense: in some exports the employee's own account row is an income entry
        paymentTxns.push({ empId: payEmpId, row, bank: t.employeeBankName || null });
      } else {
        txnRows.push(row);
        if (t.employee) unlinkedPayments++;   // named an employee we don't have: kept as an ordinary expense
      }
      txnCount++;
    }
    if (txnRows.length > 0) {
      await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes) VALUES ?`,
        [txnRows]
      );
    }
    if (openingRows.length > 0) {
      await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes, is_opening_balance) VALUES ?`,
        [openingRows.map(r => r.concat([true]))]
      );
      // Filling the ledger you are in: the account's stored opening balance is made to agree with its opening entry,
      // the same as when the app creates an account with an opening balance (saving the account never loses the entry).
      if (intoCurrent) {
        for (const [accId, amt] of Object.entries(openingByAccount)) {
          await conn.query('UPDATE bank_accounts SET opening_balance = ? WHERE id = ? AND user_id = ?', [amt, accId, req.userId]);
        }
      }
    }
    if (paymentTxns.length > 0) {
      // One bulk insert for the expenses, then one for the links to the employees. The expenses are the
      // last rows added to this brand-new ledger, and a single INSERT numbers its rows in order, so
      // reading their ids back in order lines each one up with its payment.
      const [bulk] = await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes) VALUES ?`,
        [paymentTxns.map(p => p.row)]
      );
      const [idRows] = await conn.query('SELECT id FROM transactions WHERE ledger_id = ? AND id >= ? ORDER BY id', [newLedgerId, bulk.insertId]);
      if (idRows.length !== paymentTxns.length) throw new Error('Could not match the imported payments to their expenses.');
      await conn.query(
        'INSERT INTO employee_payments (employee_id, ledger_id, linked_transaction_id, employee_bank_name) VALUES ?',
        [paymentTxns.map((p, i) => [p.empId, newLedgerId, idRows[i].id, p.bank])]
      );
      paymentCount = paymentTxns.length;
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

    let loanCount = 0, repaymentCount = 0;
    for (const loan of (loans || [])) {
      if (!loan.borrowedFrom || !loan.amount || !loan.date) continue;
      // Loan's own account may not exist as a bank account (e.g. was "Cash") - ensure it, defaulting to the first known account if genuinely unresolvable.
      let loanAccountId = accountMap[(loan.account || '').trim().toLowerCase()];
      if (!loanAccountId) loanAccountId = Object.values(accountMap)[0] || null;
      if (!loanAccountId) continue;
      const loanDate = normalizeDate(loan.date);
      // A backup file already carries the loan's income/expense entries as ordinary transactions, so only the loan
      // records are restored. A loan marked createTransactions is created the way the Loans tab creates it: with its
      // own "Loan borrowed from ..." income entry and a "Loan repayment to ..." expense entry for each repayment,
      // linked to the loan, so it shows the Loan tag and stays out of the income/expense totals.
      const linked = loan.createTransactions === true;
      // direction 'lent' = money the business lent out (a hand loan): it leaves the account when the loan is made and
      // comes back as the "repayments". Everything else is a loan taken (money in first, repayments out).
      const lent = loan.direction === 'lent';
      if (linked) {
        const repaid = (loan.repayments || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
        if (repaid > Number(loan.amount) + 0.005) throw new Error(`The repayments for the loan from ${loan.borrowedFrom} add up to more than the loan.`);
      }
      const [result] = lent
        ? await conn.query(
            "INSERT INTO loans (ledger_id, user_id, borrowed_from, amount, txn_date, notes, account_id, direction) VALUES (?, ?, ?, ?, ?, ?, ?, 'lent')",
            [newLedgerId, req.userId, loan.borrowedFrom, loan.amount, loanDate, loan.notes || null, loanAccountId])
        : await conn.query(
            'INSERT INTO loans (ledger_id, user_id, borrowed_from, amount, txn_date, notes, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [newLedgerId, req.userId, loan.borrowedFrom, loan.amount, loanDate, loan.notes || null, loanAccountId]);
      const loanId = result.insertId;
      loanCount++;
      if (linked) {
        const [tx] = await conn.query(
          `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, notes, linked_loan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [newLedgerId, loanAccountId, lent ? `Loan given to ${loan.borrowedFrom}` : `Loan borrowed from ${loan.borrowedFrom}`, lent ? 'expense' : 'income', loan.amount, loanDate, loan.notes || null, loanId]
        );
        await conn.query('UPDATE loans SET linked_transaction_id = ? WHERE id = ?', [tx.insertId, loanId]);
      }
      for (const rep of (loan.repayments || [])) {
        if (!rep.date || !rep.amount) continue;
        let repAccountId = accountMap[(rep.account || '').trim().toLowerCase()] || loanAccountId;
        const repDate = normalizeDate(rep.date);
        if (linked) {
          const [rtx] = await conn.query(
            `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, notes, linked_loan_repayment_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
            [newLedgerId, repAccountId, lent ? `Loan returned by ${loan.borrowedFrom}` : `Loan repayment to ${loan.borrowedFrom}`, lent ? 'income' : 'expense', rep.amount, repDate, rep.notes || null]
          );
          const [rr] = await conn.query(
            'INSERT INTO loan_repayments (loan_id, repayment_date, amount, account_id, linked_transaction_id) VALUES (?, ?, ?, ?, ?)',
            [loanId, repDate, rep.amount, repAccountId, rtx.insertId]
          );
          await conn.query('UPDATE transactions SET linked_loan_repayment_id = ? WHERE id = ?', [rr.insertId, rtx.insertId]);
        } else {
          await conn.query(
            'INSERT INTO loan_repayments (loan_id, repayment_date, amount, account_id) VALUES (?, ?, ?, ?)',
            [loanId, repDate, rep.amount, repAccountId]
          );
        }
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
        employeePayments: paymentCount, unlinkedPayments: unlinkedPayments, ledgerName: importName,
        loans: loanCount, repayments: repaymentCount, intoCurrentLedger: intoCurrent, openingBalances: openingRows.length
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
