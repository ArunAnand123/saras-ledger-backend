const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/bank-accounts - list all accounts (Bank + Cash) with live computed balance
router.get('/', async (req, res) => {
  try {
    const [accounts] = await pool.query(
      'SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY is_cash ASC, id ASC',
      [req.userId]
    );
    const withBalances = await Promise.all(accounts.map(async (acct) => {
      const [txns] = await pool.query(
        `SELECT
           SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
           SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
         FROM transactions WHERE account_id = ? AND ledger_id = ?`,
        [acct.id, req.ledgerId]
      );
      const [transfersOut] = await pool.query(
        'SELECT COALESCE(SUM(amount),0) AS total FROM transfers WHERE from_account_id = ? AND ledger_id = ?',
        [acct.id, req.ledgerId]
      );
      const [transfersIn] = await pool.query(
        'SELECT COALESCE(SUM(amount),0) AS total FROM transfers WHERE to_account_id = ? AND ledger_id = ?',
        [acct.id, req.ledgerId]
      );
      const income = Number(txns[0].income) || 0;
      const expense = Number(txns[0].expense) || 0;
      const currentBalance = income - expense + Number(transfersIn[0].total) - Number(transfersOut[0].total);
      return { ...acct, currentBalance };
    }));
    res.json(withBalances);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load bank accounts.' });
  }
});

// POST /api/bank-accounts - add new account. If opening balance > 0, creates a real linked Income transaction.
router.post('/', async (req, res) => {
  const { name, openingBalance, isCash } = req.body;
  if (!name) return res.status(400).json({ error: 'Bank name is required.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO bank_accounts (user_id, name, is_cash, opening_balance) VALUES (?, ?, ?, ?)',
      [req.userId, name, !!isCash, openingBalance || 0]
    );
    const accountId = result.insertId;

    let linkedTransactionId = null;
    if (openingBalance > 0) {
      const [txnResult] = await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, is_opening_balance)
         VALUES (?, ?, ?, 'income', ?, CURDATE(), TRUE)`,
        [req.ledgerId, accountId, `Opening balance - ${name}`, openingBalance]
      );
      linkedTransactionId = txnResult.insertId;
    }
    await conn.commit();
    res.status(201).json({ id: accountId, linkedTransactionId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not create bank account.' });
  } finally {
    conn.release();
  }
});

// PUT /api/bank-accounts/:id - edit opening balance (name is locked once created, matching the prototype's
// safety decision - too many other computations reference accounts by name)
router.put('/:id', async (req, res) => {
  const { openingBalance } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [accounts] = await conn.query(
      'SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (accounts.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Bank account not found.' });
    }
    const acct = accounts[0];

    // Find existing linked opening-balance transaction, if any
    const [existingTxns] = await conn.query(
      'SELECT id FROM transactions WHERE account_id = ? AND is_opening_balance = TRUE LIMIT 1',
      [acct.id]
    );

    if (existingTxns.length > 0) {
      if (openingBalance > 0) {
        await conn.query('UPDATE transactions SET amount = ? WHERE id = ?', [openingBalance, existingTxns[0].id]);
      } else {
        await conn.query('DELETE FROM transactions WHERE id = ?', [existingTxns[0].id]);
      }
    } else if (openingBalance > 0) {
      await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, is_opening_balance)
         VALUES (?, ?, ?, 'income', ?, CURDATE(), TRUE)`,
        [req.ledgerId, acct.id, `Opening balance - ${acct.name}`, openingBalance]
      );
    }

    await conn.query('UPDATE bank_accounts SET opening_balance = ? WHERE id = ?', [openingBalance || 0, acct.id]);
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not update bank account.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/bank-accounts/:id - blocked if the account has any real usage (matching the prototype's safety check)
router.delete('/:id', async (req, res) => {
  try {
    const [accounts] = await pool.query('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (accounts.length === 0) return res.status(404).json({ error: 'Bank account not found.' });

    const [realTxns] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM transactions WHERE account_id = ? AND is_opening_balance = FALSE',
      [req.params.id]
    );
    const [transferUsage] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM transfers WHERE from_account_id = ? OR to_account_id = ?',
      [req.params.id, req.params.id]
    );
    const [loanUsage] = await pool.query('SELECT COUNT(*) AS cnt FROM loans WHERE account_id = ?', [req.params.id]);

    if (realTxns[0].cnt > 0 || transferUsage[0].cnt > 0 || loanUsage[0].cnt > 0) {
      return res.status(409).json({ error: 'This account has transactions, transfers, or loans linked to it and cannot be deleted.' });
    }

    await pool.query('DELETE FROM transactions WHERE account_id = ? AND is_opening_balance = TRUE', [req.params.id]);
    await pool.query('DELETE FROM bank_accounts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete bank account.' });
  }
});

module.exports = router;
