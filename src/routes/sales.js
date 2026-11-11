const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

// SALES
// A sale is what a customer bought (customer, date, amount sold, optionally a list of items). It is NOT income by itself.
// Income is added only when money is received: every payment becomes a real Income entry (category "Sales", notes = the customer)
// in the Bank or Cash that was chosen, so Transactions, balances and reports all pick it up. A payment is linked to its
// Income entry (sale_payments.txn_id), and the amount, date and account are always read from that entry. So an Income entry
// edited or deleted on the Transactions screen can never leave a customer's balance out of step.
// What a customer still owes = everything sold to them - everything received from them (names are compared ignoring case).

const router = express.Router();
router.use(requireAuth);

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS sales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ledger_id INT NOT NULL,
        user_id INT NOT NULL,
        customer VARCHAR(150) NOT NULL,
        sale_date DATE NOT NULL,
        notes TEXT NULL,
        amount DECIMAL(12,2) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_sales_ledger (ledger_id, customer),
        CONSTRAINT fk_sales_ledger FOREIGN KEY (ledger_id) REFERENCES ledgers(id) ON DELETE CASCADE,
        CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sale_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sale_id INT NOT NULL,
        item_date DATE NOT NULL,
        material VARCHAR(150) NOT NULL,
        pond VARCHAR(60) NULL,
        item_count DECIMAL(14,3) NULL,
        quantity DECIMAL(14,3) NOT NULL,
        rate DECIMAL(14,2) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        KEY idx_items_sale (sale_id),
        CONSTRAINT fk_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sale_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ledger_id INT NOT NULL,
        user_id INT NOT NULL,
        customer VARCHAR(150) NOT NULL,
        sale_id INT NULL,
        txn_id INT NOT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payment_txn (txn_id),
        KEY idx_payments_ledger (ledger_id, customer),
        CONSTRAINT fk_payments_ledger FOREIGN KEY (ledger_id) REFERENCES ledgers(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
        CONSTRAINT fk_payments_txn FOREIGN KEY (txn_id) REFERENCES transactions(id) ON DELETE CASCADE
      )`);
    })().catch((err) => { readyPromise = null; throw err; });
  }
  return readyPromise;
}
router.use(async (req, res, next) => {
  try { await ready(); next(); } catch (err) { console.error('Sales tables:', err.message); res.status(500).json({ error: 'Sales is not ready on the server yet.' }); }
});

// ---------- small helpers ----------
class Bad extends Error {}
const bad = (msg) => new Bad(msg);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function money(v, label, { allowZero = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw bad(label + ' must be a number.');
  if (n < 0 || (!allowZero && n === 0)) throw bad(label + ' must be more than zero.');
  if (n > 99999999.99) throw bad(label + ' is too large.');
  return r2(n);
}
function dateOk(v, label) {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(label + ' must be a date.');
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(label + ' is not a real date.');
  return s;
}
function text(v, max, label, required) {
  const s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  if (required && !s) throw bad(label + ' is required.');
  if (s.length > max) throw bad(label + ' is too long.');
  return s;
}
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  if (items.length > 200) throw bad('Too many items on one sale (200 at most).');
  return items.map((it, i) => {
    const n = 'Item ' + (i + 1);
    const quantity = Number(it.quantity), rate = Number(it.rate);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99999999) throw bad(n + ': Quantity must be more than zero.');
    if (!Number.isFinite(rate) || rate < 0 || rate > 99999999.99) throw bad(n + ': Rate must be a number.');
    let count = null;
    if (it.count !== undefined && it.count !== null && it.count !== '') { count = Number(it.count); if (!Number.isFinite(count) || count < 0 || count > 99999999) throw bad(n + ': Count must be a number.'); }
    const amount = r2(quantity * rate);
    if (!(amount > 0)) throw bad(n + ': the amount (Quantity x Rate) must be more than zero.');
    if (amount > 99999999.99) throw bad(n + ': the amount is too large.');
    return { date: dateOk(it.date, n + ': Date'), material: text(it.material, 150, n + ': Material', true), pond: text(it.pond, 60, n + ': Pond', false), count, quantity, rate: r2(rate), amount };
  });
}
async function ownAccount(conn, req, accountId) {
  const [rows] = await conn.query('SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?', [accountId, req.userId]);
  if (!rows.length) throw bad('That payment method was not found.');
}
async function totals(conn, req, customer) {
  const [[s]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS v FROM sales WHERE ledger_id = ? AND user_id = ? AND LOWER(customer) = LOWER(?)', [req.ledgerId, req.userId, customer]);
  const [[p]] = await conn.query(
    `SELECT COALESCE(SUM(t.amount),0) AS v FROM sale_payments sp JOIN transactions t ON t.id = sp.txn_id
     WHERE sp.ledger_id = ? AND sp.user_id = ? AND LOWER(sp.customer) = LOWER(?)`, [req.ledgerId, req.userId, customer]);
  return { sold: r2(s.v), received: r2(p.v) };
}
// A customer typed with different capital letters is the SAME customer: always use the spelling already stored.
async function canonical(conn, req, name) {
  const [rows] = await conn.query('SELECT customer FROM sales WHERE ledger_id = ? AND user_id = ? AND LOWER(customer) = LOWER(?) ORDER BY id LIMIT 1', [req.ledgerId, req.userId, name]);
  return rows.length ? rows[0].customer : name;
}
const noteFor = (customer, note) => (note ? customer + ' - ' + note : customer);
async function addPayment(conn, req, { customer, saleId, amount, date, accountId, notes }) {
  await ownAccount(conn, req, accountId);
  const [t] = await conn.query(
    `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, notes) VALUES (?, ?, 'Sales', 'income', ?, ?, ?)`,
    [req.ledgerId, accountId, amount, date, noteFor(customer, notes)]);
  const [p] = await conn.query('INSERT INTO sale_payments (ledger_id, user_id, customer, sale_id, txn_id, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [req.ledgerId, req.userId, customer, saleId || null, t.insertId, notes || null]);
  return p.insertId;
}
async function run(res, work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await work(conn);
    await conn.commit();
    res.json(out);
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* ignore */ }
    if (err instanceof Bad) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not save. Nothing was changed.' });
  } finally { conn.release(); }
}
const inr = (n) => '\u20B9' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- GET /api/sales : every sale (with its items) and every payment of the current ledger ----------
router.get('/', async (req, res) => {
  try {
    const [sales] = await pool.query(
      `SELECT id, customer, DATE_FORMAT(sale_date,'%Y-%m-%d') AS date, notes, amount FROM sales
       WHERE ledger_id = ? AND user_id = ? ORDER BY sale_date DESC, id DESC`, [req.ledgerId, req.userId]);
    const [items] = await pool.query(
      `SELECT i.id, i.sale_id, DATE_FORMAT(i.item_date,'%Y-%m-%d') AS date, i.material, i.pond, i.item_count AS count, i.quantity, i.rate, i.amount
       FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.ledger_id = ? AND s.user_id = ? ORDER BY i.item_date, i.id`, [req.ledgerId, req.userId]);
    const [payments] = await pool.query(
      `SELECT sp.id, sp.customer, sp.sale_id, sp.notes, sp.txn_id, t.amount, DATE_FORMAT(t.txn_date,'%Y-%m-%d') AS date, t.account_id, a.name AS account
       FROM sale_payments sp JOIN transactions t ON t.id = sp.txn_id LEFT JOIN bank_accounts a ON a.id = t.account_id
       WHERE sp.ledger_id = ? AND sp.user_id = ? ORDER BY t.txn_date, sp.id`, [req.ledgerId, req.userId]);
    const byId = {};
    sales.forEach((s) => { s.amount = Number(s.amount); s.items = []; byId[s.id] = s; });
    items.forEach((i) => { if (byId[i.sale_id]) byId[i.sale_id].items.push({ id: i.id, date: i.date, material: i.material, pond: i.pond || '', count: i.count === null ? null : Number(i.count), quantity: Number(i.quantity), rate: Number(i.rate), amount: Number(i.amount) }); });
    res.json({ sales, payments: payments.map((p) => ({ id: p.id, customer: p.customer, saleId: p.sale_id, notes: p.notes || '', txnId: p.txn_id, amount: Number(p.amount), date: p.date, accountId: p.account_id, account: p.account || '' })) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load sales.' }); }
});

// ---------- POST /api/sales : a new sale, with what was received now (optional) ----------
router.post('/', (req, res) => run(res, async (conn) => {
  const b = req.body || {};
  const customer = await canonical(conn, req, text(b.customer, 150, 'Customer name', true));
  const items = cleanItems(b.items);
  const notes = text(b.notes, 2000, 'Notes', false);
  let amount, date;
  if (items.length) { amount = r2(items.reduce((s, i) => s + i.amount, 0)); date = items.map((i) => i.date).sort()[0]; if (amount > 99999999.99) throw bad('The total is too large.'); }
  else { amount = money(b.amount, 'Amount sold'); date = dateOk(b.date, 'Date'); }
  const rec = b.received && Number(b.received.amount) > 0 ? b.received : null;
  let recAmt = 0, recDate = null;
  if (rec) {
    recAmt = money(rec.amount, 'Amount received'); recDate = dateOk(rec.date || date, 'Date received');
    if (recAmt > amount) throw bad('Amount received (' + inr(recAmt) + ') is more than the amount sold (' + inr(amount) + ').');
    if (!rec.accountId) throw bad('Choose where the money was received (Bank or Cash).');
  }
  const [s] = await conn.query('INSERT INTO sales (ledger_id, user_id, customer, sale_date, notes, amount) VALUES (?, ?, ?, ?, ?, ?)', [req.ledgerId, req.userId, customer, date, notes || null, amount]);
  for (const i of items) await conn.query('INSERT INTO sale_items (sale_id, item_date, material, pond, item_count, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [s.insertId, i.date, i.material, i.pond || null, i.count, i.quantity, i.rate, i.amount]);
  let paymentId = null;
  if (rec) paymentId = await addPayment(conn, req, { customer, saleId: s.insertId, amount: recAmt, date: recDate, accountId: rec.accountId, notes: text(rec.notes, 2000, 'Notes', false) });
  const t = await totals(conn, req, customer);
  return { id: s.insertId, paymentId, amount, date, toReceive: r2(t.sold - t.received) };
}));

// ---------- PUT /api/sales/:id : change a sale (its items are replaced) ----------
router.put('/:id', (req, res) => run(res, async (conn) => {
  const b = req.body || {};
  const [[sale]] = await conn.query('SELECT * FROM sales WHERE id = ? AND ledger_id = ? AND user_id = ?', [req.params.id, req.ledgerId, req.userId]);
  if (!sale) throw bad('Sale not found.');
  const customer = text(b.customer === undefined ? sale.customer : b.customer, 150, 'Customer name', true);
  const notes = text(b.notes === undefined ? sale.notes : b.notes, 2000, 'Notes', false);
  const items = cleanItems(b.items);
  let amount, date;
  if (items.length) { amount = r2(items.reduce((s, i) => s + i.amount, 0)); date = items.map((i) => i.date).sort()[0]; }
  else { amount = money(b.amount === undefined ? sale.amount : b.amount, 'Amount sold'); date = dateOk(b.date === undefined ? sale.sale_date : b.date, 'Date'); }
  if (amount > 99999999.99) throw bad('The total is too large.');
  const oldName = sale.customer;
  await conn.query('UPDATE sales SET sale_date = ?, notes = ?, amount = ? WHERE id = ?', [date, notes || null, amount, sale.id]);
  await conn.query('DELETE FROM sale_items WHERE sale_id = ?', [sale.id]);
  for (const i of items) await conn.query('INSERT INTO sale_items (sale_id, item_date, material, pond, item_count, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [sale.id, i.date, i.material, i.pond || null, i.count, i.quantity, i.rate, i.amount]);
  if (customer !== oldName) {   // a new spelling applies to ALL of this customer's sales and payments (and the Income entries they made)
    await conn.query('UPDATE sales SET customer = ? WHERE ledger_id = ? AND user_id = ? AND LOWER(customer) = LOWER(?)', [customer, req.ledgerId, req.userId, oldName]);
    await conn.query('UPDATE sale_payments SET customer = ? WHERE ledger_id = ? AND user_id = ? AND LOWER(customer) = LOWER(?)', [customer, req.ledgerId, req.userId, oldName]);
    await conn.query(`UPDATE transactions t JOIN sale_payments sp ON sp.txn_id = t.id
                      SET t.notes = CONCAT(?, IF(sp.notes IS NULL OR sp.notes = '', '', CONCAT(' - ', sp.notes)))
                      WHERE sp.ledger_id = ? AND sp.user_id = ? AND LOWER(sp.customer) = LOWER(?)`, [customer, req.ledgerId, req.userId, customer]);
  }
  const t = await totals(conn, req, customer);
  if (t.sold < t.received) throw bad('Amount sold cannot be less than what this customer has already paid (' + inr(t.received) + ').');
  return { id: sale.id, amount, date, toReceive: r2(t.sold - t.received) };
}));

// ---------- DELETE /api/sales/:id : the sale, and the payments that were received with it (and their Income) ----------
router.delete('/:id', (req, res) => run(res, async (conn) => {
  const [[sale]] = await conn.query('SELECT * FROM sales WHERE id = ? AND ledger_id = ? AND user_id = ?', [req.params.id, req.ledgerId, req.userId]);
  if (!sale) throw bad('Sale not found.');
  await conn.query(`DELETE FROM transactions WHERE id IN (SELECT txn_id FROM sale_payments WHERE sale_id = ? AND ledger_id = ?)`, [sale.id, req.ledgerId]);
  await conn.query('DELETE FROM sales WHERE id = ?', [sale.id]);
  const t = await totals(conn, req, sale.customer);
  if (t.sold < t.received) throw bad('This customer has paid ' + inr(t.received) + ' in other payments, more than their remaining sales. Delete those payments first.');
  return { deleted: true, toReceive: r2(t.sold - t.received) };
}));

// ---------- payments ----------
router.post('/payments', (req, res) => run(res, async (conn) => {
  const b = req.body || {};
  const customer = await canonical(conn, req, text(b.customer, 150, 'Customer name', true));
  const t = await totals(conn, req, customer);
  if (!(t.sold > 0)) throw bad('There is no sale for ' + customer + '.');
  const amount = money(b.amount, 'Amount received'), date = dateOk(b.date, 'Date received');
  const left = r2(t.sold - t.received);
  if (amount > left) throw bad('Amount received (' + inr(amount) + ') is more than ' + customer + ' still owes (' + inr(left) + ').');
  if (!b.accountId) throw bad('Choose where the money was received (Bank or Cash).');
  const id = await addPayment(conn, req, { customer, saleId: null, amount, date, accountId: b.accountId, notes: text(b.notes, 2000, 'Notes', false) });
  return { id, toReceive: r2(left - amount) };
}));

router.put('/payments/:id', (req, res) => run(res, async (conn) => {
  const b = req.body || {};
  const [[p]] = await conn.query(
    `SELECT sp.*, t.amount AS t_amount FROM sale_payments sp JOIN transactions t ON t.id = sp.txn_id WHERE sp.id = ? AND sp.ledger_id = ? AND sp.user_id = ?`, [req.params.id, req.ledgerId, req.userId]);
  if (!p) throw bad('Payment not found.');
  const amount = money(b.amount === undefined ? p.t_amount : b.amount, 'Amount received');
  const date = dateOk(b.date, 'Date received');
  const notes = text(b.notes === undefined ? p.notes : b.notes, 2000, 'Notes', false);
  const accountId = b.accountId;
  if (!accountId) throw bad('Choose where the money was received (Bank or Cash).');
  await ownAccount(conn, req, accountId);
  const t = await totals(conn, req, p.customer);
  const room = r2(t.sold - (t.received - Number(p.t_amount)));
  if (amount > room) throw bad('Amount received (' + inr(amount) + ') is more than ' + p.customer + ' owes (' + inr(room) + ').');
  await conn.query('UPDATE transactions SET amount = ?, txn_date = ?, account_id = ?, notes = ? WHERE id = ?', [amount, date, accountId, noteFor(p.customer, notes), p.txn_id]);
  await conn.query('UPDATE sale_payments SET notes = ? WHERE id = ?', [notes || null, p.id]);
  return { id: p.id, toReceive: r2(room - amount) };
}));

router.delete('/payments/:id', (req, res) => run(res, async (conn) => {
  const [[p]] = await conn.query('SELECT * FROM sale_payments WHERE id = ? AND ledger_id = ? AND user_id = ?', [req.params.id, req.ledgerId, req.userId]);
  if (!p) throw bad('Payment not found.');
  await conn.query('DELETE FROM transactions WHERE id = ?', [p.txn_id]);   // the payment row goes with it
  const t = await totals(conn, req, p.customer);
  return { deleted: true, toReceive: r2(t.sold - t.received) };
}));

module.exports = router;
