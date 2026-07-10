const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/employees - list all employees (carry forward across ledgers, so no ledger_id filter)
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM employees WHERE user_id = ? ORDER BY name ASC', [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load employees.' });
  }
});

// GET /api/employees/:id/history - salary history for one employee, current ledger only
router.get('/:id/history', async (req, res) => {
  try {
    const [employee] = await pool.query('SELECT * FROM employees WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (employee.length === 0) return res.status(404).json({ error: 'Employee not found.' });

    const [history] = await pool.query(
      'SELECT * FROM salary_history WHERE employee_id = ? AND ledger_id = ? ORDER BY for_month DESC',
      [req.params.id, req.ledgerId]
    );
    res.json({ employee: employee[0], history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load salary history.' });
  }
});

// POST /api/employees - mirrors saveNewEmployee() create path
router.post('/', async (req, res) => {
  const { name, dateOfJoining, dateOfRelieving } = req.body;
  if (!name || !dateOfJoining) return res.status(400).json({ error: 'Name and Date of joining are both required.' });
  if (dateOfRelieving && new Date(dateOfRelieving) <= new Date(dateOfJoining)) {
    return res.status(400).json({ error: 'Date of relieving must be after Date of joining.' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO employees (user_id, name, date_of_joining, date_of_relieving) VALUES (?, ?, ?, ?)',
      [req.userId, name, dateOfJoining, dateOfRelieving || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create employee.' });
  }
});

// PUT /api/employees/:id - mirrors editEmployee() + saveNewEmployee() edit path
router.put('/:id', async (req, res) => {
  const { name, dateOfJoining, dateOfRelieving } = req.body;
  if (!name || !dateOfJoining) return res.status(400).json({ error: 'Name and Date of joining are both required.' });
  if (dateOfRelieving && new Date(dateOfRelieving) <= new Date(dateOfJoining)) {
    return res.status(400).json({ error: 'Date of relieving must be after Date of joining.' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE employees SET name=?, date_of_joining=?, date_of_relieving=? WHERE id=? AND user_id=?',
      [name, dateOfJoining, dateOfRelieving || null, req.params.id, req.userId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update employee.' });
  }
});

// DELETE /api/employees/:id - mirrors deleteEmployee() including cascading their salary history + linked transactions
router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [employee] = await conn.query('SELECT * FROM employees WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (employee.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const [history] = await conn.query('SELECT linked_transaction_id FROM salary_history WHERE employee_id = ?', [req.params.id]);
    const linkedTxnIds = history.map(h => h.linked_transaction_id).filter(Boolean);
    if (linkedTxnIds.length > 0) {
      await conn.query(`DELETE FROM transactions WHERE id IN (${linkedTxnIds.map(() => '?').join(',')})`, linkedTxnIds);
    }
    await conn.query('DELETE FROM employees WHERE id = ?', [req.params.id]); // cascades salary_history via FK
    await conn.commit();
    res.json({ success: true, historyEntriesRemoved: history.length });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not delete employee.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/employees/:employeeId/history/:historyId - mirrors deleteSalaryHistoryEntry()
router.delete('/:employeeId/history/:historyId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [record] = await conn.query(
      'SELECT * FROM salary_history WHERE id = ? AND employee_id = ?',
      [req.params.historyId, req.params.employeeId]
    );
    if (record.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Salary history entry not found.' });
    }
    if (record[0].linked_transaction_id) {
      await conn.query('DELETE FROM transactions WHERE id = ?', [record[0].linked_transaction_id]);
    }
    await conn.query('DELETE FROM salary_history WHERE id = ?', [req.params.historyId]);
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not delete salary history entry.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
