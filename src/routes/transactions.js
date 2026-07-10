const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/transactions - list all transactions for the current ledger
// Mirrors renderTransactionsScreen() / Transaction Search's filtering
router.get('/', async (req, res) => {
  const { from, to, method, keyword } = req.query;
  let sql = `
    SELECT t.*, a.name AS account_name
    FROM transactions t
    JOIN bank_accounts a ON t.account_id = a.id
    WHERE t.ledger_id = ?
  `;
  const params = [req.ledgerId];

  if (from) { sql += ' AND t.txn_date >= ?'; params.push(from); }
  if (to) { sql += ' AND t.txn_date <= ?'; params.push(to); }
  if (method === 'bank') { sql += ' AND a.is_cash = FALSE'; }
  if (method === 'cash') { sql += ' AND a.is_cash = TRUE'; }
  if (keyword) { sql += ' AND t.category LIKE ?'; params.push(`%${keyword}%`); }

  sql += ' ORDER BY t.txn_date DESC';

  try {
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load transactions.' });
  }
});

// POST /api/transactions - create a new income/expense entry
// Mirrors validateAndSave(kind) for kind='income'/'expense'
router.post('/', async (req, res) => {
  const { accountId, category, subcategory, type, amount, date, forMonth, notes } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Amount is required and must be greater than zero.' });
  }
  if (!accountId || !category || !type || !date) {
    return res.status(400).json({ error: 'Account, category, type, and date are all required.' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.ledgerId, accountId, category, subcategory || null, type, amount, date, forMonth || null, notes || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save transaction.' });
  }
});

// PUT /api/transactions/:id - edit an existing entry
// Mirrors editIncomeExpense() + the edit-mode branch of validateAndSave()
router.put('/:id', async (req, res) => {
  const { accountId, category, subcategory, amount, date, forMonth, notes } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Amount is required and must be greater than zero.' });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM transactions WHERE id = ? AND ledger_id = ?',
      [req.params.id, req.ledgerId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    await pool.query(
      `UPDATE transactions SET account_id=?, category=?, subcategory=?, amount=?, txn_date=?, for_month=?, notes=?
       WHERE id = ? AND ledger_id = ?`,
      [accountId, category, subcategory || null, amount, date, forMonth || null, notes || null, req.params.id, req.ledgerId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update transaction.' });
  }
});

// DELETE /api/transactions/:id
// Mirrors deleteIncomeExpense()
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM transactions WHERE id = ? AND ledger_id = ?',
      [req.params.id, req.ledgerId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete transaction.' });
  }
});

module.exports = router;
