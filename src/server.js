const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const webauthnRoutes = require('./routes/webauthn');
const transactionRoutes = require('./routes/transactions');
const bankAccountRoutes = require('./routes/bankAccounts');
const categoryRoutes = require('./routes/categories');
const transferRoutes = require('./routes/transfers');
const employeeRoutes = require('./routes/employees');
const salaryRoutes = require('./routes/salary');
const loanRoutes = require('./routes/loans');
const ledgerRoutes = require('./routes/ledgers');
const importRoutes = require('./routes/import');
const dbUsageRoutes = require('./routes/dbUsage');
const hiddenSubcategoryRoutes = require('./routes/hiddenSubcategories');
const backupRoutes = require('./routes/backups');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/auth/webauthn', webauthnRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/employees', salaryRoutes); // adds POST /:id/salary onto the same /employees path
app.use('/api/loans', loanRoutes);
app.use('/api/ledgers', ledgerRoutes);
app.use('/api/import', importRoutes);
app.use('/api/db-usage', dbUsageRoutes);
app.use('/api/hidden-subcategories', hiddenSubcategoryRoutes);
app.use('/api/backups', backupRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`BKS's Ledger backend running on port ${PORT}`);
});

// Nightly backup at 11:59 PM IST. Rather than relying on a cron library's internal timezone
// handling - which proved unreliable on at least one real machine: it fired consistently at
// exactly 18:29 instead of 23:59, a gap that exactly matches the IST-UTC offset, suggesting a
// double-applied conversion when the underlying system clock is already in IST rather than
// UTC - this checks the current IST time directly every 20 seconds using JavaScript's own
// Intl API. This doesn't depend on any library correctly reconciling two timezones; it just
// asks "what time is it in Asia/Kolkata right now?", the same reliable approach used
// throughout the rest of the app.
var lastNightlyBackupRunDate = null;
setInterval(() => {
  var istParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  var partsObj = {};
  istParts.forEach(p => { partsObj[p.type] = p.value; });
  var istDateStr = partsObj.year + '-' + partsObj.month + '-' + partsObj.day;
  var istTimeStr = partsObj.hour + ':' + partsObj.minute;

  if (istTimeStr === '23:59' && lastNightlyBackupRunDate !== istDateStr) {
    lastNightlyBackupRunDate = istDateStr;
    console.log('Running nightly backup for all users... (IST time: ' + istDateStr + ' ' + istTimeStr + ')');
    backupRoutes.runNightlyBackupForAllUsers()
      .then(() => console.log('Nightly backup complete.'))
      .catch(err => console.error('Nightly backup run failed:', err));
  }
}, 20 * 1000);
