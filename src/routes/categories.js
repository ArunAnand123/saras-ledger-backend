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
  ['Other Income', 'income', 'ti-dots'],
  ['Groceries', 'expense', 'ti-shopping-cart'],
  ['Rent', 'expense', 'ti-home'],
  ['Fuel', 'expense', 'ti-car'],
  ['Utilities', 'expense', 'ti-bolt'],
  ['Medical', 'expense', 'ti-heart-rate-monitor'],
  ['Shopping', 'expense', 'ti-shopping-bag'],
  ['Dining', 'expense', 'ti-tools-kitchen-2']
];

router.get('/', async (req, res) => {
  const { type } = req.query;
  try {
    const [countRows] = await pool.query('SELECT COUNT(*) AS cnt FROM categories WHERE user_id = ?', [req.userId]);
    if (countRows[0].cnt === 0) {
      // This account predates the default-category seeding fix - seed it now, one time only,
      // so existing accounts self-heal instead of staying permanently empty.
      const values = DEFAULT_CATEGORIES.map(([name, catType, icon]) => [req.userId, name, catType, icon]);
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
