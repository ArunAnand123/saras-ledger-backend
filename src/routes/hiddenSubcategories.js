const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/hidden-subcategories?type=income - list names this user has hidden, for the picker
// to filter out. Subcategories aren't a persisted entity themselves (they're derived from past
// transactions), so this is purely an exclusion list, not a source of truth.
router.get('/', async (req, res) => {
  const { type } = req.query;
  try {
    let sql = 'SELECT name, type FROM hidden_subcategories WHERE user_id = ?';
    const params = [req.userId];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load hidden subcategories.' });
  }
});

// POST /api/hidden-subcategories - hide a subcategory name from the picker (does not touch
// any past transactions that used this name - they keep their data exactly as recorded).
router.post('/', async (req, res) => {
  const { type, name } = req.body;
  if (!type || !name || !name.trim()) return res.status(400).json({ error: 'Type and name are required.' });
  try {
    await pool.query(
      'INSERT IGNORE INTO hidden_subcategories (user_id, type, name) VALUES (?, ?, ?)',
      [req.userId, type, name.trim()]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not hide subcategory.' });
  }
});

module.exports = router;
