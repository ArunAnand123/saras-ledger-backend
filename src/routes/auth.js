const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

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

    const token = jwt.sign({ userId, ledgerId: ledgerResult.insertId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId, ledgerId: ledgerResult.insertId });
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

module.exports = router;
