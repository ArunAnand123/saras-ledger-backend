const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function monthIndex(year, month) { return year * 12 + month; } // month is 0-indexed

// POST /api/employees/:id/salary - mirrors computeSalary() + recordSalaryHistory() combined,
// re-validated fully server-side since this is real money math, never trust the client alone.
router.post('/:id/salary', async (req, res) => {
  const { amount, forMonth, lopDays: lopDaysInput, lopDates, advances, payMethod, accountId, txnDate, notes, employeeBankName } = req.body;
  const employeeId = req.params.id;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount is required and must be greater than zero.' });
  if (!forMonth) return res.status(400).json({ error: 'For month is required.' });
  if (!accountId) return res.status(400).json({ error: 'Payment account is required.' });

  try {
    const [employees] = await pool.query('SELECT * FROM employees WHERE id = ? AND user_id = ?', [employeeId, req.userId]);
    if (employees.length === 0) return res.status(404).json({ error: 'Employee not found.' });
    const emp = employees[0];

    const [targetYear, targetMonthNum] = forMonth.split('-').map(Number);
    const targetIdx = monthIndex(targetYear, targetMonthNum - 1);

    const doj = new Date(emp.date_of_joining);
    const dojIdx = monthIndex(doj.getFullYear(), doj.getMonth());
    const dor = emp.date_of_relieving ? new Date(emp.date_of_relieving) : null;
    const dorIdx = dor ? monthIndex(dor.getFullYear(), dor.getMonth()) : null;

    if (targetIdx < dojIdx) {
      return res.status(400).json({ error: 'This month is before the joining date — no salary applies here.' });
    }
    if (dorIdx !== null && targetIdx > dorIdx) {
      return res.status(400).json({ error: 'This month is after the relieving date — no salary applies here.' });
    }

    const dojInMonth = dojIdx === targetIdx;
    const dorInMonth = dorIdx === targetIdx;
    let startDay = dojInMonth ? doj.getDate() : 1;
    let endDay = dorInMonth ? dor.getDate() : 30;
    if (startDay > 30) startDay = 30;
    if (endDay > 30) endDay = 30;
    let daysWorked = endDay - startDay + 1;
    if (daysWorked < 0) daysWorked = 0;
    if (daysWorked > 30) daysWorked = 30;

    // Prefer a direct LOP day count if given (simpler input); fall back to counting a list
    // of specific dates for backward compatibility with the older absence-picker approach.
    // uniqueLopDates only gets populated in the fallback path - stays empty (and the later
    // salary_lop_dates insert loop correctly no-ops) when using the simpler direct count.
    let lopDays;
    let uniqueLopDates = new Set();
    if (lopDaysInput !== undefined && lopDaysInput !== null && lopDaysInput !== '') {
      lopDays = parseInt(lopDaysInput, 10);
      if (isNaN(lopDays) || lopDays < 0) lopDays = 0;
    } else {
      const lopList = Array.isArray(lopDates) ? lopDates : [];
      for (const d of lopList) {
        const dt = new Date(d);
        if (monthIndex(dt.getFullYear(), dt.getMonth()) !== targetIdx) {
          return res.status(400).json({ error: `Absence date ${d} is outside the selected "For month".` });
        }
        uniqueLopDates.add(d);
      }
      lopDays = uniqueLopDates.size;
    }

    if (lopDays > daysWorked) {
      return res.status(400).json({ error: `LOP (${lopDays} days) cannot exceed the ${daysWorked} day(s) worked this month.` });
    }

    const effectiveDays = daysWorked - lopDays;
    const prorated = Math.round((amount / 30) * effectiveDays);

    // Validate advances: each must fall within forMonth
    const advanceList = Array.isArray(advances) ? advances : [];
    for (const a of advanceList) {
      const dt = new Date(a.date);
      if (monthIndex(dt.getFullYear(), dt.getMonth()) !== targetIdx) {
        return res.status(400).json({ error: `Advance date ${a.date} is outside the selected "For month".` });
      }
    }
    const totalAdvance = advanceList.reduce((sum, a) => sum + Number(a.amount), 0);

    if (totalAdvance > prorated) {
      return res.status(400).json({ error: `Advance (₹${totalAdvance}) cannot exceed this month's prorated salary (₹${prorated}).` });
    }

    const netPayable = prorated - totalAdvance;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [txnResult] = await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, notes, linked_salary_history_id)
         VALUES (?, ?, ?, 'expense', ?, ?, ?, NULL)`,
        [req.ledgerId, accountId, `Salary - ${emp.name}`, netPayable, txnDate || `${forMonth}-05`, notes || null]
      );
      const linkedTransactionId = txnResult.insertId;

      const [historyResult] = await conn.query(
        `INSERT INTO salary_history (employee_id, ledger_id, for_month, prorated_amount, lop_days, total_advance, net_payable, linked_transaction_id, employee_bank_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, req.ledgerId, `${forMonth}-01`, prorated, lopDays, totalAdvance, netPayable, linkedTransactionId, payMethod==='bank' ? (employeeBankName||null) : null]
      );
      const historyId = historyResult.insertId;

      await conn.query('UPDATE transactions SET linked_salary_history_id = ? WHERE id = ?', [historyId, linkedTransactionId]);

      for (const d of uniqueLopDates) {
        await conn.query('INSERT INTO salary_lop_dates (salary_history_id, absence_date) VALUES (?, ?)', [historyId, d]);
      }
      for (const a of advanceList) {
        await conn.query('INSERT INTO salary_advances (salary_history_id, advance_date, amount) VALUES (?, ?, ?)', [historyId, a.date, a.amount]);
      }

      await conn.commit();
      res.status(201).json({ historyId, prorated, lopDays, totalAdvance, netPayable });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record salary payment.' });
  }
});


// ---------------------------------------------------------------------------------------------
// Salary as a running balance: payments, LOP days, and "count salary from"
// The balance itself (salary earned - paid) is worked out in the app from these records.
// ---------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function round2(n) { return Math.round(n * 100) / 100; }
function ymd(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function isRealDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
  const dt = new Date(d + 'T00:00:00Z');
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}
// Why a day can't be marked as LOP for this employee (or null if it can)
function lopProblem(d, emp) {
  if (!isRealDate(d)) return `${d} is not a valid date.`;
  if (parseInt(d.slice(8, 10), 10) > 30) return `${d} can't be chosen - salary is worked out on 30-day months, so the 31st is not counted.`;
  if (d < ymd(emp.date_of_joining)) return `${d} is before the joining date.`;
  if (emp.date_of_relieving && d > ymd(emp.date_of_relieving)) return `${d} is after the relieving date.`;
  return null;
}
async function ownEmployee(req, res) {
  const [rows] = await pool.query('SELECT * FROM employees WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (rows.length === 0) { res.status(404).json({ error: 'Employee not found.' }); return null; }
  return rows[0];
}

// GET /api/employees/:id/payments - every payment made to this employee (all ledgers), the days
// marked as LOP, and the optional "count salary from" date.
router.get('/:id/payments', async (req, res) => {
  try {
    const emp = await ownEmployee(req, res); if (!emp) return;
    const [pay] = await pool.query(
      `SELECT p.id, p.ledger_id, p.linked_transaction_id, p.employee_bank_name,
              t.amount, t.txn_date, t.notes
         FROM employee_payments p
         JOIN transactions t ON t.id = p.linked_transaction_id
        WHERE p.employee_id = ?
        ORDER BY t.txn_date, p.id`, [emp.id]);
    const [lop] = await pool.query('SELECT lop_date FROM employee_lop_dates WHERE employee_id = ? ORDER BY lop_date', [emp.id]);
    const [ts] = await pool.query('SELECT track_from FROM employee_track_start WHERE employee_id = ?', [emp.id]);
    // The window of THIS ledger, so each ledger counts only its own salary. A ledger that follows an earlier one starts counting
    // from when it started (its creation date, or its first entry if that is earlier); a closed ledger stops counting where it closed.
    let ledgerStart = null, ledgerEnd = null;
    const [ledRows] = await pool.query('SELECT id, created_at, closed_at FROM ledgers WHERE id = ? AND user_id = ?', [req.ledgerId, req.userId]);
    const led = ledRows[0];
    if (led) {
      const istDay = (v) => { if (!v) return null; const d = (v instanceof Date) ? v : new Date(String(v).replace(' ', 'T') + 'Z'); return isNaN(d) ? null : new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); };
      const [earlierRows] = await pool.query('SELECT COUNT(*) AS n FROM ledgers WHERE user_id = ? AND id < ?', [req.userId, led.id]);
      if (earlierRows[0].n > 0) {
        const [firstRows] = await pool.query('SELECT MIN(txn_date) AS d FROM transactions WHERE ledger_id = ?', [led.id]);
        const c = istDay(led.created_at), f = firstRows[0] && firstRows[0].d ? ymd(firstRows[0].d) : null;
        ledgerStart = (c && f) ? (f < c ? f : c) : (c || f);
      }
      ledgerEnd = istDay(led.closed_at);
    }
    res.json({
      ledgerStart, ledgerEnd,
      payments: pay.map(r => ({
        id: r.id, amount: Number(r.amount), payment_date: ymd(r.txn_date), notes: r.notes,
        employee_bank_name: r.employee_bank_name, linked_transaction_id: r.linked_transaction_id,
        in_current_ledger: r.ledger_id === req.ledgerId
      })),
      lopDates: lop.map(r => ymd(r.lop_date)),
      trackFrom: ts.length ? ymd(ts[0].track_from) : null,
      addedOn: emp.created_at ? ymd(emp.created_at) : null   // when the employee was added to the app
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load payments.' });
  }
});

// POST /api/employees/:id/payments - record a payment (an expense on that date) and/or change the
// employee's LOP days (lopAdd / lopRemove). At least one of the two is required.
router.post('/:id/payments', async (req, res) => {
  const { amount, date, accountId, notes, employeeBankName, lopAdd, lopRemove } = req.body;
  const hasAmount = amount !== undefined && amount !== null && amount !== '';
  const adds = Array.isArray(lopAdd) ? [...new Set(lopAdd)] : [];
  const removes = Array.isArray(lopRemove) ? [...new Set(lopRemove)] : [];
  if (adds.length > 400 || removes.length > 400) return res.status(400).json({ error: 'Too many LOP days in one go.' });
  if (!hasAmount && adds.length === 0 && removes.length === 0) {
    return res.status(400).json({ error: 'Enter the amount paid, or choose LOP days.' });
  }
  let amt = null;
  if (hasAmount) {
    amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    if (amt > 99999999.99) return res.status(400).json({ error: 'That amount is too large.' });
    if (!isRealDate(date)) return res.status(400).json({ error: 'A valid date is required.' });
    if (!accountId) return res.status(400).json({ error: 'Payment account is required.' });
    if (notes && String(notes).length > 255) return res.status(400).json({ error: 'Remarks can be at most 255 characters.' });
  }
  for (const d of removes) if (!isRealDate(d)) return res.status(400).json({ error: `${d} is not a valid date.` });

  let conn;
  try {
    const emp = await ownEmployee(req, res); if (!emp) return;
    for (const d of adds) { const why = lopProblem(d, emp); if (why) return res.status(400).json({ error: why }); }
    if (hasAmount) {
      const [accounts] = await pool.query('SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?', [accountId, req.userId]);
      if (accounts.length === 0) return res.status(400).json({ error: 'Payment account not found.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [emp.id]);
    let paymentId = null;
    if (hasAmount) {
      const [txn] = await conn.query(
        `INSERT INTO transactions (ledger_id, account_id, category, type, amount, txn_date, notes, linked_salary_history_id)
         VALUES (?, ?, ?, 'expense', ?, ?, ?, NULL)`,
        [req.ledgerId, accountId, `Salary - ${emp.name}`, amt, date, notes || null]
      );
      const [p] = await conn.query(
        'INSERT INTO employee_payments (employee_id, ledger_id, linked_transaction_id, employee_bank_name) VALUES (?, ?, ?, ?)',
        [emp.id, req.ledgerId, txn.insertId, employeeBankName || null]
      );
      paymentId = p.insertId;
    }
    for (const d of adds) await conn.query('INSERT IGNORE INTO employee_lop_dates (employee_id, lop_date) VALUES (?, ?)', [emp.id, d]);
    for (const d of removes) await conn.query('DELETE FROM employee_lop_dates WHERE employee_id = ? AND lop_date = ?', [emp.id, d]);
    await conn.commit();
    res.status(201).json({ id: paymentId, amount: amt, lopAdded: adds.length, lopRemoved: removes.length });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Could not save.' });
  } finally {
    if (conn) conn.release();
  }
});

// DELETE /api/employees/:id/payments/:payId - remove a payment (and its expense). Only payments
// made in the current ledger can be removed here.
router.delete('/:id/payments/:payId', async (req, res) => {
  try {
    const emp = await ownEmployee(req, res); if (!emp) return;
    const [rows] = await pool.query('SELECT * FROM employee_payments WHERE id = ? AND employee_id = ?', [req.params.payId, emp.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });
    if (rows[0].ledger_id !== req.ledgerId) {
      return res.status(400).json({ error: 'This payment was made in an earlier ledger and can\'t be deleted here.' });
    }
    // deleting the expense removes the payment record with it
    await pool.query('DELETE FROM transactions WHERE id = ?', [rows[0].linked_transaction_id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the payment.' });
  }
});

// PUT /api/employees/:id/track-from - "count salary from" date for this employee (null clears it)
router.put('/:id/track-from', async (req, res) => {
  const { date } = req.body;
  if (date !== null && date !== undefined && date !== '' && !isRealDate(date)) {
    return res.status(400).json({ error: 'A valid date is required.' });
  }
  try {
    const emp = await ownEmployee(req, res); if (!emp) return;
    if (!date) {
      await pool.query('DELETE FROM employee_track_start WHERE employee_id = ?', [emp.id]);
    } else {
      await pool.query(
        'INSERT INTO employee_track_start (employee_id, track_from) VALUES (?, ?) ON DUPLICATE KEY UPDATE track_from = VALUES(track_from)',
        [emp.id, date]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
