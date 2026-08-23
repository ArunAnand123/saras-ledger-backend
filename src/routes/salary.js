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

module.exports = router;
