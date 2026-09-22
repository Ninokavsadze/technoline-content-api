/**
 * technoline.ge — Site Content + Booking API (TEST / REFERENCE SERVER)
 * ----------------------------------------------------------------------
 * This is a small, standalone Node.js/Express server you can run locally
 * right now (`node server.js`) so the technoline.ge storefront and the
 * separate admin panel have something real to talk to while Q-Logic's
 * production endpoints are being wired up.
 *
 * MIGRATION PATH: every route below is written to be dropped, as-is or
 * nearly as-is, into the real Q-Logic server.js. When that's ready, the
 * only change needed on the site/admin side is the API_BASE constant
 * (see technoline.html and admin-panel.html) — swap
 *   http://localhost:4001  →  https://eticket.technoline.ge
 * Everything else (routes, payload shapes, auth header) stays the same,
 * AS LONG AS the real server implements the same contract documented in
 * README.md next to this file.
 *
 * Storage: a flat JSON file (data.json) next to this script — good
 * enough for testing, not a production datastore. Swap `readDb`/`writeDb`
 * for Q-Logic's real persistence layer when merging this in for real.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'technoline2026';
const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- permissive CORS for the test server -----------------------------
// The real Q-Logic server should restrict this to the actual site's
// origin(s) once known; for testing, any origin (including a claude.ai
// Artifact preview) is allowed.
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- tiny JSON-file store ---------------------------------------------
const DEFAULT_DB = {
  'content/site': {},
  'theme/site': {},
  'content/parts': {},
  'content/branches': {},
  bookings: []
};

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}
function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}
if (!fs.existsSync(DATA_FILE)) writeDb(DEFAULT_DB);

// --- auth (test only — a single shared admin password) ----------------
// Real Q-Logic already has requireAuth/requireRole; when merging, swap
// this whole block for that and keep the route shapes identical.
const tokens = new Map(); // token -> expiry ms

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + 12 * 60 * 60 * 1000); // 12h
  return token;
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const expiry = token && tokens.get(token);
  if (!expiry || expiry < Date.now()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/auth/login', function (req, res) {
  const password = (req.body && req.body.password) || '';
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  res.json({ token: issueToken() });
});

// --- site content: content/site, theme/site, content/parts, content/branches
const SITE_DOC_KEYS = {
  'content-site': 'content/site',
  'theme-site': 'theme/site',
  'content-parts': 'content/parts',
  'content-branches': 'content/branches'
};

app.get('/api/site/:doc', function (req, res) {
  const key = SITE_DOC_KEYS[req.params.doc];
  if (!key) return res.status(404).json({ error: 'unknown_doc' });
  const db = readDb();
  res.json(db[key] || {});
});

// One call to fetch all four documents at once (what the storefront
// needs on page load).
app.get('/api/site', function (req, res) {
  const db = readDb();
  res.json({
    content: db['content/site'] || {},
    theme: db['theme/site'] || {},
    parts: db['content/parts'] || {},
    branches: db['content/branches'] || {}
  });
});

app.put('/api/site/:doc', requireAuth, function (req, res) {
  const key = SITE_DOC_KEYS[req.params.doc];
  if (!key) return res.status(404).json({ error: 'unknown_doc' });
  if (typeof req.body !== 'object' || Array.isArray(req.body) || req.body === null) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  const db = readDb();
  db[key] = req.body; // full replace, mirrors the old db.doc(path).set(body)
  writeDb(db);
  res.json({ ok: true });
});

// --- bookings -----------------------------------------------------------
function genConfirmationCode() {
  return 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.post('/api/bookings', function (req, res) {
  const b = req.body || {};
  const required = ['branchId', 'serviceType', 'date', 'timeSlot', 'name', 'phone'];
  const missing = required.filter(function (f) { return !b[f]; });
  if (missing.length) {
    return res.status(400).json({ error: 'missing_fields', fields: missing });
  }
  const db = readDb();
  const booking = {
    id: 'bk_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    confirmationCode: genConfirmationCode(),
    status: 'received',
    createdAt: new Date().toISOString(),
    branchId: b.branchId,
    serviceType: b.serviceType,
    date: b.date,
    timeSlot: b.timeSlot,
    name: b.name,
    phone: b.phone,
    deviceType: b.deviceType || null,
    issue: b.issue || null,
    notes: b.notes || null
  };
  db.bookings.push(booking);
  writeDb(db);
  res.status(201).json(booking);
});

app.get('/api/bookings/:id', function (req, res) {
  const db = readDb();
  const booking = db.bookings.find(function (x) { return x.id === req.params.id; });
  if (!booking) return res.status(404).json({ error: 'not_found' });
  res.json(booking);
});

// staff-only listing, for when the admin panel wants to show recent bookings
app.get('/api/bookings', requireAuth, function (req, res) {
  const db = readDb();
  res.json(db.bookings.slice(-200).reverse());
});

app.get('/api/health', function (req, res) {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, function () {
  console.log('technoline.ge content+booking test API running on http://localhost:' + PORT);
  console.log('Admin password: ' + ADMIN_PASSWORD + ' (set ADMIN_PASSWORD env var to change it)');
});
