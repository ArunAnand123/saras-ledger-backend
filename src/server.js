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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Sara's Ledger backend running on port ${PORT}`);
});
