const express = require('express');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/db-usage - reports the current database's actual storage size, scoped to this
// app's own schema only (the Aiven instance is shared across multiple apps as separate
// schemas, so this must not report the whole server's usage). Data+index size is what
// actually counts against a MySQL storage quota; bill photos (stored as base64 text) are
// usually the biggest single driver of growth for this app, so they're broken out separately.
router.get('/', async (req, res) => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name AS tableName,
              table_rows AS approxRows,
              ROUND((data_length + index_length), 0) AS sizeBytes
       FROM information_schema.TABLES
       WHERE table_schema = DATABASE()
       ORDER BY sizeBytes DESC`
    );

    const totalBytes = tables.reduce((sum, t) => sum + Number(t.sizeBytes || 0), 0);

    const [[billPhotoRow]] = await pool.query(
      `SELECT COALESCE(SUM(LENGTH(bill_photo_url)), 0) AS billPhotoBytes,
              COUNT(bill_photo_url) AS billPhotoCount
       FROM transactions WHERE bill_photo_url IS NOT NULL`
    );

    res.json({
      totalBytes,
      tables: tables.map(t => ({ tableName: t.tableName, approxRows: Number(t.approxRows), sizeBytes: Number(t.sizeBytes) })),
      billPhotoBytes: Number(billPhotoRow.billPhotoBytes),
      billPhotoCount: Number(billPhotoRow.billPhotoCount)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read database usage.' });
  }
});

module.exports = router;
