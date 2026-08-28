const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/ledgers/current - the active ledger
router.get('/current', async (req, res) => {
  try {
    const [ledgers] = await pool.query('SELECT * FROM ledgers WHERE id = ? AND user_id = ?', [req.ledgerId, req.userId]);
    if (ledgers.length === 0) return res.status(404).json({ error: 'No active ledger found.' });
    res.json(ledgers[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load current ledger.' });
  }
});

// GET /api/ledgers - past ledgers archive (mirrors renderPastLedgers()), including each
// ledger's still-pending loan count/total, so the user can decide which ones to sweep in.
router.get('/', async (req, res) => {
  try {
    const [ledgers] = await pool.query(
      'SELECT * FROM ledgers WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );
    const withPending = await Promise.all(ledgers.map(async (led) => {
      const [loans] = await pool.query('SELECT * FROM loans WHERE ledger_id = ?', [led.id]);
      let pendingCount = 0, pendingTotal = 0;
      for (const loan of loans) {
        const [repayments] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM loan_repayments WHERE loan_id = ?', [loan.id]);
        const pending = Number(loan.amount) - Number(repayments[0].total);
        if (pending > 0) { pendingCount++; pendingTotal += pending; }
      }
      return { ...led, pending_loan_count: pendingCount, pending_loan_total: pendingTotal };
    }));
    res.json(withPending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load ledgers.' });
  }
});

// Helper: compute current closing balance for one account, within one ledger
async function computeAccountClosingBalance(conn, accountId, ledgerId) {
  const [txns] = await conn.query(
    `SELECT
       SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
       SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
     FROM transactions WHERE account_id = ? AND ledger_id = ?`,
    [accountId, ledgerId]
  );
  const [transfersOut] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM transfers WHERE from_account_id = ? AND ledger_id = ?', [accountId, ledgerId]);
  const [transfersIn] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM transfers WHERE to_account_id = ? AND ledger_id = ?', [accountId, ledgerId]);

  // opening_balance is only added if there's no "opening balance" transaction already representing it
  // within THIS ledger - otherwise it would be double-counted (once as the raw column, once as income).
  // A fresh manually-entered opening balance always creates such a transaction; a carried-forward
  // balance from a previous ledger does not, so it needs to be added directly here instead.
  const [openingTxn] = await conn.query(
    'SELECT id FROM transactions WHERE account_id = ? AND ledger_id = ? AND is_opening_balance = TRUE LIMIT 1',
    [accountId, ledgerId]
  );
  let opening = 0;
  if (openingTxn.length === 0) {
    // Use THIS ledger's own opening balance record if one exists, since the shared column on
    // bank_accounts only ever correctly reflects one ledger at a time - falls back to it only
    // for ledgers that pre-date this per-ledger tracking.
    const [ledgerOpening] = await conn.query(
      'SELECT opening_balance FROM ledger_account_openings WHERE ledger_id = ? AND account_id = ?',
      [ledgerId, accountId]
    );
    if (ledgerOpening.length > 0) {
      opening = Number(ledgerOpening[0].opening_balance) || 0;
    } else {
      const [account] = await conn.query('SELECT opening_balance FROM bank_accounts WHERE id = ?', [accountId]);
      opening = Number(account[0].opening_balance) || 0;
    }
  }
  const income = Number(txns[0].income) || 0;
  const expense = Number(txns[0].expense) || 0;
  return opening + income - expense + Number(transfersIn[0].total) - Number(transfersOut[0].total);
}

// POST /api/ledgers - create a new ledger, carrying forward per the confirmed table:
//   Bank/Cash closing balances -> new opening balances     : YES
//   Employees (record itself)                              : YES (untouched, tied to user_id)
//   Categories                                              : YES (untouched, tied to user_id)
//   Bank accounts (the accounts themselves)                 : YES (untouched, tied to user_id)
//   Pending loans (from the ledger being closed)            : YES (moved to new ledger_id, automatic)
//   Pending loans from OTHER, older past ledgers            : only if explicitly selected via sourceLedgerIds
//   Settled loans, Transactions, Transfers, Salary history  : NO  (archived, new ledger starts clean)
router.post('/', async (req, res) => {
  const { name, sourceLedgerIds } = req.body;
  if (!name) return res.status(400).json({ error: 'Please name your new ledger.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [oldLedgers] = await conn.query('SELECT * FROM ledgers WHERE id = ? AND user_id = ?', [req.ledgerId, req.userId]);
    if (oldLedgers.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Current ledger not found.' });
    }
    const oldLedger = oldLedgers[0];

    const [accounts] = await conn.query('SELECT * FROM bank_accounts WHERE user_id = ?', [req.userId]);

    // Compute closing balance per account for the ledger being closed
    const closingBalances = {};
    for (const acct of accounts) {
      closingBalances[acct.id] = await computeAccountClosingBalance(conn, acct.id, oldLedger.id);
    }
    const closingBank = accounts.filter(a => !a.is_cash).reduce((s, a) => s + closingBalances[a.id], 0);
    const closingCash = accounts.filter(a => a.is_cash).reduce((s, a) => s + closingBalances[a.id], 0);

    // Archive the old ledger with its final closing balances
    await conn.query(
      'UPDATE ledgers SET is_active = FALSE, closing_bank_balance = ?, closing_cash_balance = ?, closed_at = NOW() WHERE id = ?',
      [closingBank, closingCash, oldLedger.id]
    );

    // Create the new ledger
    const [newLedgerResult] = await conn.query(
      'INSERT INTO ledgers (user_id, name, is_active) VALUES (?, ?, TRUE)',
      [req.userId, name]
    );
    const newLedgerId = newLedgerResult.insertId;

    // Carry forward: each account's opening balance for the NEW ledger becomes its computed
    // closing balance from the ledger being closed - recorded per-ledger, so the OLD ledger's
    // own opening balance (and every other past ledger's) stays untouched and independently
    // correct if the user ever switches back into it.
    for (const acct of accounts) {
      await conn.query(
        `INSERT INTO ledger_account_openings (ledger_id, account_id, opening_balance) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE opening_balance = VALUES(opening_balance)`,
        [newLedgerId, acct.id, closingBalances[acct.id]]
      );
    }

    // Carry forward: only pending loans move to the new ledger; settled ones stay archived in the old one
    let sweptLoanCount = 0;
    async function sweepPendingLoans(fromLedgerId) {
      const [loans] = await conn.query('SELECT * FROM loans WHERE user_id = ? AND ledger_id = ?', [req.userId, fromLedgerId]);
      for (const loan of loans) {
        const [repayments] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM loan_repayments WHERE loan_id = ?', [loan.id]);
        const pending = Number(loan.amount) - Number(repayments[0].total);
        if (pending > 0) {
          await conn.query('UPDATE loans SET ledger_id = ? WHERE id = ?', [newLedgerId, loan.id]);
          sweptLoanCount++;
        }
      }
    }
    await sweepPendingLoans(oldLedger.id);

    // Additionally, sweep in pending loans from any explicitly-selected OLDER past ledgers -
    // these wouldn't move automatically otherwise, since only the ledger being closed does.
    if (Array.isArray(sourceLedgerIds)) {
      for (const srcId of sourceLedgerIds) {
        if (Number(srcId) === oldLedger.id) continue; // already handled above
        const [ownedCheck] = await conn.query('SELECT id FROM ledgers WHERE id = ? AND user_id = ?', [srcId, req.userId]);
        if (ownedCheck.length === 0) continue; // ignore anything not actually owned by this user
        await sweepPendingLoans(srcId);
      }
    }

    // Employees, Categories, Bank accounts themselves: already carry forward automatically,
    // since none of them are scoped by ledger_id in the schema - nothing to do here.

    await conn.commit();
    const token = jwt.sign({ userId: req.userId, ledgerId: newLedgerId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      newLedgerId,
      token,
      sweptLoanCount,
      closedLedger: { id: oldLedger.id, name: oldLedger.name, closingBank, closingCash }
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not create new ledger.' });
  } finally {
    conn.release();
  }
});

// POST /api/ledgers/:id/switch - make a different ledger (past or current) the active one.
// Unlike creating a new ledger, this does NOT close/archive anything, compute closing balances,
// or move any data - it only changes which ledger is active for future reads/writes, and can be
// switched back and forth freely between any of the user's own ledgers at any time.
router.post('/:id/switch', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [target] = await conn.query('SELECT * FROM ledgers WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (target.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Ledger not found.' });
    }
    await conn.query('UPDATE ledgers SET is_active = FALSE WHERE user_id = ?', [req.userId]);
    await conn.query('UPDATE ledgers SET is_active = TRUE WHERE id = ?', [req.params.id]);
    await conn.commit();
    const token = jwt.sign({ userId: req.userId, ledgerId: Number(req.params.id) }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, ledgerId: Number(req.params.id), name: target[0].name });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not switch ledger.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
