const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

// CA certificate can come from a local file (DB_SSL_CA_PATH, used when running on your own
// machine) or from the certificate's contents pasted directly into an environment variable
// (DB_SSL_CA_CONTENT, used on Render, where you can't just place a file next to the code).
function getSslConfig() {
  if (process.env.DB_SSL_CA_CONTENT) {
    return { ca: process.env.DB_SSL_CA_CONTENT };
  }
  if (process.env.DB_SSL_CA_PATH && fs.existsSync(process.env.DB_SSL_CA_PATH)) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH) };
  }
  return undefined;
}

// Connection pool - reused across every request, matches how Aiven expects
// managed connections to be handled (not opening/closing per-request).
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: getSslConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
