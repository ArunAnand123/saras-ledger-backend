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
// dateStrings: true is essential here - without it, mysql2 wraps every date/datetime/timestamp
// value in a JS Date object, which gets serialized with a "Z" (UTC) suffix regardless of what
// timezone was actually intended. The frontend sends a naive "local time, no timezone" string
// (e.g. the exact moment shown on the user's own device) - without this setting, that value
// gets silently reinterpreted as UTC somewhere in the round trip, shifting the displayed time
// by the user's UTC offset (e.g. off by 5:30 for users in India). With dateStrings:true, the
// exact string round-trips unchanged, and the frontend's new Date(...) then correctly parses
// it as local time again, matching what was originally entered.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: getSslConfig(),
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
