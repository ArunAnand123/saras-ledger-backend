const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/transfers - list all transfers for the current ledger
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.*, fa.name AS from_name, ta.name AS to_name
       FROM transfers t
       JOIN bank_accounts fa ON t.from_account_id = fa.id
       JOIN bank_accounts ta ON t.to_account_id = ta.id
       WHERE t.ledger_id = ? ORDER BY t.txn_date DESC`,
      [req.ledgerId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load transfers.' });
  }
});

// POST /api/transfers - mirrors validateAndSaveTransfer() create path
router.post('/', async (req, res) => {
  const { fromAccountId, toAccountId, amount, date, notes } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount is required and must be greater than zero.' });
  if (!fromAccountId || !toAccountId || !date) return res.status(400).json({ error: 'From account, To account, and date are all required.' });

  try {
    const [result] = await pool.query(
      'INSERT INTO transfers (ledger_id, from_account_id, to_account_id, amount, txn_date, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [req.ledgerId, fromAccountId, toAccountId, amount, date, notes || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save transfer.' });
  }
});

// PUT /api/transfers/:id - mirrors editTransfer() + validateAndSaveTransfer() edit path
router.put('/:id', async (req, res) => {
  const { fromAccountId, toAccountId, amount, date, notes } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount is required and must be greater than zero.' });

  try {
    const [existing] = await pool.query('SELECT id FROM transfers WHERE id = ? AND ledger_id = ?', [req.params.id, req.ledgerId]);
    if (existing.length === 0) return res.status(404).json({ error: 'Transfer not found.' });

    await pool.query(
      'UPDATE transfers SET from_account_id=?, to_account_id=?, amount=?, txn_date=?, notes=? WHERE id=? AND ledger_id=?',
      [fromAccountId, toAccountId, amount, date, notes || null, req.params.id, req.ledgerId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update transfer.' });
  }
});

// DELETE /api/transfers/:id - mirrors deleteTransfer()
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM transfers WHERE id = ? AND ledger_id = ?', [req.params.id, req.ledgerId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Transfer not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete transfer.' });
  }
});

module.exports = router;
