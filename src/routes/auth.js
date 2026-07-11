const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register  - mirrors the prototype's "Create your ledger" setup screen
router.post('/register', async (req, res) => {
  const { name, email, pin } = req.body;
  if (!name || !email || !pin) {
    return res.status(400).json({ error: 'Name, email, and PIN are all required.' });
  }
  try {
    const pinHash = await bcrypt.hash(pin, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, pin_hash) VALUES (?, ?, ?)',
      [name, email, pinHash]
    );
    const userId = result.insertId;

    // Every new user starts with their first ledger, matching the prototype's default
    const [ledgerResult] = await pool.query(
      'INSERT INTO ledgers (user_id, name, is_active) VALUES (?, ?, TRUE)',
      [userId, 'Ledger 2026']
    );

    // Seed the two default accounts (HDFC Bank + Cash), matching the prototype
    await pool.query(
      'INSERT INTO bank_accounts (user_id, name, is_cash, opening_balance) VALUES (?, ?, FALSE, 0), (?, ?, TRUE, 0)',
      [userId, 'HDFC Bank', userId, 'Cash']
    );

    // Seed 12 commonly-used categories, so the picker is never empty for a new user.
    // Users can still add their own via "+ Add new" in the category picker.
    const defaultCategories = [
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
    const categoryValues = defaultCategories.map(([name, type, icon]) => [userId, name, type, icon]);
    await pool.query(
      'INSERT INTO categories (user_id, name, type, icon) VALUES ?',
      [categoryValues]
    );

    const token = jwt.sign({ userId, ledgerId: ledgerResult.insertId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId, ledgerId: ledgerResult.insertId, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// POST /api/auth/login - mirrors the prototype's PIN-entry welcome screen
router.post('/login', async (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) {
    return res.status(400).json({ error: 'Email and PIN are required.' });
  }
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or PIN.' });
    }
    const user = users[0];
    const match = await bcrypt.compare(pin, user.pin_hash);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect email or PIN.' });
    }
    const [ledgers] = await pool.query(
      'SELECT id FROM ledgers WHERE user_id = ? AND is_active = TRUE LIMIT 1',
      [user.id]
    );
    const ledgerId = ledgers.length > 0 ? ledgers[0].id : null;
    const token = jwt.sign({ userId: user.id, ledgerId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user.id, ledgerId, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// PUT /api/auth/change-pin - requires the current PIN to verify identity before changing it
router.put('/change-pin', requireAuth, async (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) {
    return res.status(400).json({ error: 'Current PIN and new PIN are both required.' });
  }
  if (!/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
  }
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(currentPin, users[0].pin_hash);
    if (!match) return res.status(401).json({ error: 'Current PIN is incorrect.' });

    const newHash = await bcrypt.hash(newPin, 10);
    await pool.query('UPDATE users SET pin_hash = ? WHERE id = ?', [newHash, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update PIN.' });
  }
});

module.exports = router;
