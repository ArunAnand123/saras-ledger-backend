const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

const router = express.Router();

// These must match the real domain in production - set via Render environment variables.
// Locally, they default to plain localhost for testing.
const RP_NAME = "Sara's Ledger";
const RP_ID = process.env.RP_ID || 'localhost';
const RP_ORIGIN = process.env.RP_ORIGIN || 'http://localhost:8080';

// POST /api/auth/webauthn/register-options - begins registering a fingerprint on this device.
// Requires the user to already be logged in via PIN (fingerprint is a convenience layer added
// on top of an existing account, never a replacement for it).
router.post('/register-options', requireAuth, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });
    const user = users[0];

    const [existingCreds] = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?', [user.id]);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(String(user.id)),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform'
      },
      excludeCredentials: existingCreds.map(c => ({ id: c.credential_id }))
    });

    await pool.query('UPDATE users SET webauthn_challenge = ? WHERE id = ?', [options.challenge, user.id]);
    res.json(options);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start fingerprint registration.' });
  }
});

// POST /api/auth/webauthn/register-verify - completes fingerprint registration for this device.
router.post('/register-verify', requireAuth, async (req, res) => {
  const { response, deviceName } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });
    const user = users[0];
    if (!user.webauthn_challenge) return res.status(400).json({ error: 'No registration in progress. Please try again.' });

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: user.webauthn_challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Fingerprint registration could not be verified.' });
    }

    const { credential } = verification.registrationInfo;
    await pool.query(
      'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name) VALUES (?, ?, ?, ?, ?)',
      [user.id, credential.id, isoBase64URL.fromBuffer(credential.publicKey), credential.counter, deviceName || null]
    );
    await pool.query('UPDATE users SET webauthn_challenge = NULL WHERE id = ?', [user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not complete fingerprint registration.' });
  }
});

// POST /api/auth/webauthn/login-options - begins a fingerprint login. Public (no auth yet),
// since the user isn't logged in - identifies the account purely by email.
router.post('/login-options', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) return res.status(404).json({ error: 'No account found for this email.' });
    const user = users[0];

    const [creds] = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?', [user.id]);
    if (creds.length === 0) return res.status(404).json({ error: 'No fingerprint set up for this account on this device.' });

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: creds.map(c => ({ id: c.credential_id }))
    });

    await pool.query('UPDATE users SET webauthn_challenge = ? WHERE id = ?', [options.challenge, user.id]);
    res.json(options);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start fingerprint login.' });
  }
});

// POST /api/auth/webauthn/login-verify - completes a fingerprint login, issuing a real JWT
// exactly like a normal PIN login would.
router.post('/login-verify', async (req, res) => {
  const { email, response } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) return res.status(404).json({ error: 'No account found for this email.' });
    const user = users[0];
    if (!user.webauthn_challenge) return res.status(400).json({ error: 'No login in progress. Please try again.' });

    const [creds] = await pool.query('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?', [response.id, user.id]);
    if (creds.length === 0) return res.status(404).json({ error: 'This fingerprint is not registered to this account.' });
    const cred = creds[0];

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: user.webauthn_challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credential_id,
        publicKey: isoBase64URL.toBuffer(cred.public_key),
        counter: Number(cred.counter)
      }
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Fingerprint could not be verified.' });
    }

    await pool.query('UPDATE webauthn_credentials SET counter = ? WHERE id = ?', [verification.authenticationInfo.newCounter, cred.id]);
    await pool.query('UPDATE users SET webauthn_challenge = NULL WHERE id = ?', [user.id]);

    const [ledgers] = await pool.query('SELECT id FROM ledgers WHERE user_id = ? AND is_active = TRUE LIMIT 1', [user.id]);
    const ledgerId = ledgers.length > 0 ? ledgers[0].id : null;
    const token = jwt.sign({ userId: user.id, ledgerId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user.id, ledgerId, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not complete fingerprint login.' });
  }
});

// GET /api/auth/webauthn/status - does this account have a fingerprint set up on any device?
router.get('/status', requireAuth, async (req, res) => {
  try {
    const [creds] = await pool.query('SELECT id, device_name, created_at FROM webauthn_credentials WHERE user_id = ?', [req.userId]);
    res.json({ registered: creds.length > 0, devices: creds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check fingerprint status.' });
  }
});

module.exports = router;
