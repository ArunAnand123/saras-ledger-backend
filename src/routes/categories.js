const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/categories?type=income|expense
const DEFAULT_CATEGORIES = [
  ['Salary', 'income', 'ti-briefcase'],
  ['Business', 'income', 'ti-building-store'],
  ['Investment', 'income', 'ti-trending-up'],
  ['Freelance', 'income', 'ti-wallet'],
  ['Rental Income', 'income', 'ti-home'],
  ['Gift/Refund', 'income', 'ti-gift'],
  ['Other Income', 'income', 'ti-dots'],
  ['Groceries', 'expense', 'ti-shopping-cart'],
  ['Rent', 'expense', 'ti-home'],
  ['Fuel', 'expense', 'ti-car'],
  ['Utilities', 'expense', 'ti-bolt'],
  ['Medical', 'expense', 'ti-heart-rate-monitor'],
  ['Shopping', 'expense', 'ti-shopping-bag'],
  ['Dining', 'expense', 'ti-tools-kitchen-2'],
  ['EMI/Loan Payment', 'expense', 'ti-credit-card'],
  ['Insurance', 'expense', 'ti-shield'],
  ['Education', 'expense', 'ti-book'],
  ['Entertainment', 'expense', 'ti-device-tv'],
  ['Mobile & Internet', 'expense', 'ti-device-mobile'],
  ['Personal Care', 'expense', 'ti-scissors']
];

router.get('/', async (req, res) => {
  const { type } = req.query;
  try {
    let sql = 'SELECT * FROM categories WHERE user_id = ?';
    const params = [req.userId];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    sql += ' ORDER BY name ASC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load categories.' });
  }
});

// POST /api/categories - add a new category (mirrors "+ Add new" in the category picker)
router.post('/', async (req, res) => {
  const { name, type, icon } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Name and type are required.' });
  try {
    const [result] = await pool.query(
      'INSERT INTO categories (user_id, name, type, icon) VALUES (?, ?, ?, ?)',
      [req.userId, name, type, icon || 'ti-dots']
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create category.' });
  }
});

// PUT /api/categories/:id - rename a category. Note: transactions store the category name as
// a plain text snapshot at the time they were created, not a live reference, so renaming here
// does not retroactively change past transactions - only future selections from the picker.
router.put('/:id', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  try {
    const [existing] = await pool.query('SELECT id FROM categories WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (existing.length === 0) return res.status(404).json({ error: 'Category not found.' });
    await pool.query('UPDATE categories SET name = ? WHERE id = ? AND user_id = ?', [name.trim(), req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not rename category.' });
  }
});

// DELETE /api/categories/:id - removes it from the picker going forward. Past transactions
// keep their category name as-is (stored as text, not a reference), so this is always safe.
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT id FROM categories WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (existing.length === 0) return res.status(404).json({ error: 'Category not found.' });
    await pool.query('DELETE FROM categories WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete category.' });
  }
});

// POST /api/categories/restore-defaults - explicitly re-adds any of the standard default
// categories that are currently missing (for either type), without touching or duplicating
// anything the user already has. Useful if defaults are missing for any reason.
router.post('/restore-defaults', async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT name, type FROM categories WHERE user_id = ?', [req.userId]);
    const existingKeys = new Set(existing.map(c => c.name.toLowerCase() + '|' + c.type));
    const missing = DEFAULT_CATEGORIES.filter(([name, type]) => !existingKeys.has(name.toLowerCase() + '|' + type));
    if (missing.length > 0) {
      const values = missing.map(([name, type, icon]) => [req.userId, name, type, icon]);
      await pool.query('INSERT INTO categories (user_id, name, type, icon) VALUES ?', [values]);
    }
    res.json({ restoredCount: missing.length, restored: missing.map(m => m[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not restore default categories.' });
  }
});

module.exports = router;
