const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/categories?type=income|expense
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

module.exports = router;
