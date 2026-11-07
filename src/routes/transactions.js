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

// Checks one entry before it is saved, so a wrong amount, type, date or somebody else's account can never be stored.
// Returns { error } or { entry } with the amount rounded to whole paise.
async function checkEntry(e, userId, needType) {
  const amount = Number(e && e.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount is required and must be greater than zero.' };
  if (amount > 99999999.99) return { error: 'That amount is too large.' };
  if (!e.accountId || !e.category || (needType && !e.type) || !e.date) return { error: 'Account, category, type, and date are all required.' };
  if (needType && e.type !== 'income' && e.type !== 'expense') return { error: 'Type must be income or expense.' };
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(e.date))) return { error: 'The date is not valid.' };
  const [acct] = await pool.query('SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?', [e.accountId, userId]);
  if (acct.length === 0) return { error: 'That payment method was not found.' };
  return { entry: { ...e, amount: Math.round(amount * 100) / 100 } };
}

// POST /api/transactions - create a new income/expense entry
function normalizeForMonth(forMonth) {
  if (!forMonth) return null;
  // The frontend sends YYYY-MM (from an HTML month input), but the database
  // column is a proper DATE, which requires a full YYYY-MM-DD value.
  return /^\d{4}-\d{2}$/.test(forMonth) ? `${forMonth}-01` : forMonth;
}

// Mirrors validateAndSave(kind) for kind='income'/'expense'
router.post('/', async (req, res) => {
  const { accountId, category, subcategory, type, amount, date, forMonth, notes, billPhoto, createdAt, splitGroupId } = req.body;

  try {
    const chk = await checkEntry(req.body, req.userId, true);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const amount = chk.entry.amount;
    const [result] = await pool.query(
      createdAt
        ? `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes, bill_photo_url, created_at, split_group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes, bill_photo_url, split_group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      createdAt
        ? [req.ledgerId, accountId, category, subcategory || null, type, amount, date, normalizeForMonth(forMonth), notes || null, billPhoto || null, createdAt, splitGroupId || null]
        : [req.ledgerId, accountId, category, subcategory || null, type, amount, date, normalizeForMonth(forMonth), notes || null, billPhoto || null, splitGroupId || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save transaction.' });
  }
});

// POST /api/transactions/batch - save several entries together (the parts of a Split): all of them, or none.
router.post('/batch', async (req, res) => {
  const list = req.body && req.body.entries;
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) return res.status(400).json({ error: 'Send between 1 and 50 entries.' });
  const conn = await pool.getConnection();
  try {
    const clean = [];
    for (let i = 0; i < list.length; i++) {
      const chk = await checkEntry(list[i], req.userId, true);
      if (chk.error) return res.status(400).json({ error: 'Entry ' + (i + 1) + ': ' + chk.error });
      clean.push(chk.entry);
    }
    await conn.beginTransaction();
    const ids = [];
    for (const e of clean) {
      const [r] = await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, subcategory, type, amount, txn_date, for_month, notes, bill_photo_url, created_at, split_group_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`,
        [req.ledgerId, e.accountId, e.category, e.subcategory || null, e.type, e.amount, e.date, normalizeForMonth(e.forMonth), e.notes || null, e.billPhoto || null, e.createdAt || null, e.splitGroupId || null]
      );
      ids.push(r.insertId);
    }
    await conn.commit();
    res.status(201).json({ ids });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not save the entries. Nothing was saved.' });
  } finally {
    conn.release();
  }
});

// PUT /api/transactions/:id - edit an existing entry
// Mirrors editIncomeExpense() + the edit-mode branch of validateAndSave()
router.put('/:id', async (req, res) => {
  const { accountId, category, subcategory, date, forMonth, notes, billPhoto, createdAt } = req.body;

  try {
    const chk = await checkEntry(req.body, req.userId, false);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const amount = chk.entry.amount;
    const [existing] = await pool.query(
      'SELECT id, bill_photo_url, created_at FROM transactions WHERE id = ? AND ledger_id = ?',
      [req.params.id, req.ledgerId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    // If no new photo/time was sent, keep whatever was already saved rather than wiping it out.
    const photoToSave = billPhoto !== undefined ? billPhoto : existing[0].bill_photo_url;
    const createdAtToSave = createdAt || existing[0].created_at;
    await pool.query(
      `UPDATE transactions SET account_id=?, category=?, subcategory=?, amount=?, txn_date=?, for_month=?, notes=?, bill_photo_url=?, created_at=?
       WHERE id = ? AND ledger_id = ?`,
      [accountId, category, subcategory || null, amount, date, normalizeForMonth(forMonth), notes || null, photoToSave, createdAtToSave, req.params.id, req.ledgerId]
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
