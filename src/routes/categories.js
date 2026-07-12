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
    // Top-up: insert only the default categories the account doesn't already have by name.
    // Covers both a brand-new account (has none of them) and an older account that already
    // has some defaults but predates a later addition to the default list (like this batch).
    const [existingRows] = await pool.query('SELECT name FROM categories WHERE user_id = ?', [req.userId]);
    const existingNames = new Set(existingRows.map(r => r.name));
    const missing = DEFAULT_CATEGORIES.filter(([name]) => !existingNames.has(name));
    if (missing.length > 0) {
      const values = missing.map(([name, catType, icon]) => [req.userId, name, catType, icon]);
      await pool.query('INSERT INTO categories (user_id, name, type, icon) VALUES ?', [values]);
    }

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

module.exports = router;
