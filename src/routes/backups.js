const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Current wall-clock time in IST as a plain 'YYYY-MM-DD HH:MM:SS' string. The backups table used to rely on the database's own DEFAULT CURRENT_TIMESTAMP,
// but a managed database like Aiven runs its clock in UTC - so a backup taken at 11:59 PM IST
// was stored as 18:29 and shown in the app 5.5 hours early. Writing the IST time from here
// means the stored value is what the user's own clock said, whatever timezone the database
// or this server happens to be in (same reason the app sends its own createdAt for transactions).
function istNowString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  const hour = p.hour === '24' ? '00' : p.hour;
  return p.year + '-' + p.month + '-' + p.day + ' ' + hour + ':' + p.minute + ':' + p.second;
}

// Builds one complete, restorable JSON snapshot of this user's current active ledger -
// matching the exact same shape as the existing "Download everything (full backup)" feature
// and its /api/import/full restore route: human-readable account/category names rather than
// internal database IDs, since that's what makes a backup something the app can actually
// import back in, not just a raw dump of table rows. Loans carry across ledgers (per the
// existing carry-forward design), so they're included in full regardless of ledger; almost
// everything else is scoped to the current active ledger, same as a manual "Download
// everything" would capture.
async function buildBackupData(userId) {
  const [ledgers] = await pool.query('SELECT id FROM ledgers WHERE user_id = ? AND is_active = TRUE', [userId]);
  if (ledgers.length === 0) throw new Error('No active ledger found for this user.');
  const ledgerId = ledgers[0].id;

  const [accounts] = await pool.query('SELECT * FROM bank_accounts WHERE user_id = ?', [userId]);
  const [cats] = await pool.query('SELECT * FROM categories WHERE user_id = ?', [userId]);

  const [txns] = await pool.query(
    `SELECT t.*, a.name AS account_name FROM transactions t
     JOIN bank_accounts a ON t.account_id = a.id WHERE t.ledger_id = ?`,
    [ledgerId]
  );

  const [transfers] = await pool.query(
    `SELECT tr.*, fa.name AS from_name, ta.name AS to_name FROM transfers tr
     JOIN bank_accounts fa ON tr.from_account_id = fa.id
     JOIN bank_accounts ta ON tr.to_account_id = ta.id
     WHERE tr.ledger_id = ?`,
    [ledgerId]
  );

  const [employees] = await pool.query('SELECT * FROM employees WHERE user_id = ?', [userId]);
  const employeesWithHistory = await Promise.all(employees.map(async (emp) => {
    const [history] = await pool.query(
      'SELECT * FROM salary_history WHERE employee_id = ? AND ledger_id = ? ORDER BY for_month DESC',
      [emp.id, ledgerId]
    );
    return {
      name: emp.name,
      dateOfJoining: emp.date_of_joining,
      dateOfRelieving: emp.date_of_relieving,
      salaryHistory: history.map(h => ({
        forMonth: h.for_month, proratedAmount: Number(h.prorated_amount), lopDays: h.lop_days,
        totalAdvance: Number(h.total_advance), netPayable: Number(h.net_payable)
      }))
    };
  }));

  const [loans] = await pool.query(
    `SELECT l.*, a.name AS account_name FROM loans l
     LEFT JOIN bank_accounts a ON a.id = l.account_id WHERE l.user_id = ?`,
    [userId]
  );
  const loansWithRepayments = await Promise.all(loans.map(async (loan) => {
    const [repayments] = await pool.query(
      `SELECT r.*, a.name AS account_name FROM loan_repayments r
       LEFT JOIN bank_accounts a ON a.id = r.account_id WHERE r.loan_id = ? ORDER BY r.repayment_date ASC`,
      [loan.id]
    );
    return {
      borrowedFrom: loan.borrowed_from, amount: Number(loan.amount), date: loan.txn_date, notes: loan.notes,
      account: loan.account_name,
      repayments: repayments.map(r => ({ date: r.repayment_date, amount: Number(r.amount), account: r.account_name }))
    };
  }));

  return {
    generatedAt: new Date().toISOString(),
    bankAccounts: accounts.map(a => ({ name: a.name, isCash: !!a.is_cash, openingBalance: Number(a.opening_balance) })),
    categories: cats.map(c => ({ name: c.name, type: c.type })),
    transactions: txns.map(t => ({
      date: t.txn_date, type: t.type, category: t.category, subcategory: t.subcategory,
      account: t.account_name, amount: Number(t.amount), notes: t.notes, forMonth: t.for_month
    })),
    transfers: transfers.map(tr => ({
      date: tr.txn_date, from: tr.from_name, to: tr.to_name, amount: Number(tr.amount), notes: tr.notes
    })),
    employees: employeesWithHistory,
    loans: loansWithRepayments
  };
}

// Only the most recent backup is kept per user - every earlier one is deleted. This runs only
// AFTER the new backup has been saved successfully, so a failed backup attempt can never leave
// the user with no backup at all. It deletes only backups OLDER than the one just saved (lower
// id), never "everything except mine": if two backups overlap (a nightly run and a manual tap,
// say), each one then only ever removes older rows, so the newest can never be deleted by anyone.
async function pruneOldBackups(userId, newestId) {
  await pool.query('DELETE FROM backups WHERE user_id = ? AND id < ?', [userId, newestId]);
}

// Generates and stores one backup for a single user, replacing their previous one. Shared by
// the nightly job and the manual "Back up now" endpoint below.
async function runBackupForUser(userId) {
  const data = await buildBackupData(userId);
  const [result] = await pool.query(
    'INSERT INTO backups (user_id, data, created_at) VALUES (?, ?, ?)',
    [userId, JSON.stringify(data), istNowString()]
  );
  try {
    await pruneOldBackups(userId, result.insertId);
  } catch (err) {
    // The new backup is already safely saved - failing to tidy up the old one shouldn't make
    // the whole backup look like it failed. The next backup's cleanup will catch it.
    console.error(`Could not remove old backups for user ${userId}:`, err);
  }
}

// Runs the nightly backup for every user in the system. Called by the cron schedule
// in server.js, not exposed as an HTTP route.
async function runNightlyBackupForAllUsers() {
  const [users] = await pool.query('SELECT id FROM users');
  for (const u of users) {
    try {
      await runBackupForUser(u.id);
    } catch (err) {
      console.error(`Nightly backup failed for user ${u.id}:`, err);
      // Continue with the next user rather than letting one failure block everyone else's backup
    }
  }
}

router.use(requireAuth);

// GET /api/backups - list this user's backups, newest first. Deliberately excludes
// the full data payload (which can be large) - just enough to show a dated list.
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, created_at, LENGTH(data) AS size_bytes FROM backups WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load backups.' });
  }
});

// GET /api/backups/:id - full JSON data for one backup, for download.
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT data, created_at FROM backups WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Backup not found.' });
    res.json({ createdAt: rows[0].created_at, data: JSON.parse(rows[0].data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load backup.' });
  }
});

// POST /api/backups - manually trigger a backup right now for the current user.
router.post('/', async (req, res) => {
  try {
    await runBackupForUser(req.userId);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create backup.' });
  }
});

module.exports = router;
module.exports.runNightlyBackupForAllUsers = runNightlyBackupForAllUsers;
