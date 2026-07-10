const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/loans?from=&to= - list loans with computed pending amount, carry forward across ledgers (tied to user_id)
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  try {
    let sql = 'SELECT * FROM loans WHERE user_id = ?';
    const params = [req.userId];
    if (from) { sql += ' AND txn_date >= ?'; params.push(from); }
    if (to) { sql += ' AND txn_date <= ?'; params.push(to); }
    sql += ' ORDER BY txn_date DESC';
    const [loans] = await pool.query(sql, params);

    const withPending = await Promise.all(loans.map(async (loan) => {
      const [repayments] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM loan_repayments WHERE loan_id = ?', [loan.id]);
      const totalReturned = Number(repayments[0].total);
      return { ...loan, totalReturned, pending: Number(loan.amount) - totalReturned };
    }));
    res.json(withPending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load loans.' });
  }
});

// GET /api/loans/:id - single loan with its repayment history
router.get('/:id', async (req, res) => {
  try {
    const [loans] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (loans.length === 0) return res.status(404).json({ error: 'Loan not found.' });
    const [repayments] = await pool.query('SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY repayment_date ASC', [req.params.id]);
    res.json({ ...loans[0], repayments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load loan.' });
  }
});

// POST /api/loans - mirrors saveNewLoan() create path, borrow amount becomes a real Income transaction
router.post('/', async (req, res) => {
  const { borrowedFrom, amount, date, notes, accountId } = req.body;
  if (!borrowedFrom || !amount || amount <= 0 || !date || !accountId) {
    return res.status(400).json({ error: 'Please enter who you borrowed from, a valid amount, the date, and an account.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [loanResult] = await conn.query(
      'INSERT INTO loans (ledger_id, user_id, borrowed_from, amount, txn_date, notes, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.ledgerId, req.userId, borrowedFrom, amount, date, notes || null, accountId]
    );
    const loanId = loanResult.insertId;

    const [txnResult] = await conn.query(
      `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, linked_loan_id)
       VALUES (?, ?, ?, 'income', ?, ?, ?)`,
      [req.ledgerId, accountId, `Loan borrowed from ${borrowedFrom}`, amount, date, loanId]
    );
    await conn.query('UPDATE loans SET linked_transaction_id = ? WHERE id = ?', [txnResult.insertId, loanId]);

    await conn.commit();
    res.status(201).json({ id: loanId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not save loan.' });
  } finally {
    conn.release();
  }
});

// PUT /api/loans/:id - mirrors editLoanRecord() + saveNewLoan() edit path
router.put('/:id', async (req, res) => {
  const { borrowedFrom, amount, date, notes, accountId } = req.body;
  if (!borrowedFrom || !amount || amount <= 0 || !date || !accountId) {
    return res.status(400).json({ error: 'Please enter who you borrowed from, a valid amount, the date, and an account.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [loans] = await conn.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (loans.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Loan not found.' });
    }
    const loan = loans[0];

    await conn.query(
      'UPDATE loans SET borrowed_from=?, amount=?, txn_date=?, notes=?, account_id=? WHERE id=?',
      [borrowedFrom, amount, date, notes || null, accountId, loan.id]
    );
    if (loan.linked_transaction_id) {
      await conn.query(
        'UPDATE transactions SET category=?, amount=?, txn_date=?, account_id=? WHERE id=?',
        [`Loan borrowed from ${borrowedFrom}`, amount, date, accountId, loan.linked_transaction_id]
      );
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not update loan.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/loans/:id - mirrors deleteLoanRecord(), cascades repayments + all linked transactions
router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [loans] = await conn.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (loans.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Loan not found.' });
    }
    const [repayments] = await conn.query('SELECT linked_transaction_id FROM loan_repayments WHERE loan_id = ?', [req.params.id]);
    const linkedIds = repayments.map(r => r.linked_transaction_id).filter(Boolean);
    if (loans[0].linked_transaction_id) linkedIds.push(loans[0].linked_transaction_id);
    if (linkedIds.length > 0) {
      await conn.query(`DELETE FROM transactions WHERE id IN (${linkedIds.map(() => '?').join(',')})`, linkedIds);
    }
    await conn.query('DELETE FROM loans WHERE id = ?', [req.params.id]); // cascades loan_repayments via FK
    await conn.commit();
    res.json({ success: true, repaymentsRemoved: repayments.length });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not delete loan.' });
  } finally {
    conn.release();
  }
});

// POST /api/loans/:id/repayments - mirrors addLoanRepayment(), repayment becomes a real Expense transaction
router.post('/:id/repayments', async (req, res) => {
  const { date, amount, accountId } = req.body;
  if (!date || !amount || amount <= 0 || !accountId) {
    return res.status(400).json({ error: 'Please enter a valid date, amount, and account.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [loans] = await conn.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (loans.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Loan not found.' });
    }
    const loan = loans[0];
    const [existing] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM loan_repayments WHERE loan_id = ?', [loan.id]);
    const alreadyReturned = Number(existing[0].total);
    if (alreadyReturned + Number(amount) > Number(loan.amount)) {
      await conn.rollback();
      return res.status(400).json({ error: `This would exceed the borrowed amount (₹${loan.amount}). Pending is ₹${loan.amount - alreadyReturned}.` });
    }

    const [txnResult] = await conn.query(
      `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, linked_loan_repayment_id)
       VALUES (?, ?, ?, 'expense', ?, ?, NULL)`,
      [req.ledgerId, accountId, `Loan repayment to ${loan.borrowed_from}`, amount, date]
    );
    const [repaymentResult] = await conn.query(
      'INSERT INTO loan_repayments (loan_id, repayment_date, amount, account_id, linked_transaction_id) VALUES (?, ?, ?, ?, ?)',
      [loan.id, date, amount, accountId, txnResult.insertId]
    );
    await conn.query('UPDATE transactions SET linked_loan_repayment_id = ? WHERE id = ?', [repaymentResult.insertId, txnResult.insertId]);

    await conn.commit();
    res.status(201).json({ id: repaymentResult.insertId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not save repayment.' });
  } finally {
    conn.release();
  }
});

// DELETE /api/loans/:loanId/repayments/:repaymentId - mirrors removeLoanRepayment()
router.delete('/:loanId/repayments/:repaymentId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [repayments] = await conn.query(
      'SELECT * FROM loan_repayments WHERE id = ? AND loan_id = ?',
      [req.params.repaymentId, req.params.loanId]
    );
    if (repayments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Repayment not found.' });
    }
    if (repayments[0].linked_transaction_id) {
      await conn.query('DELETE FROM transactions WHERE id = ?', [repayments[0].linked_transaction_id]);
    }
    await conn.query('DELETE FROM loan_repayments WHERE id = ?', [req.params.repaymentId]);
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not delete repayment.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
