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
const nodemailer = require('nodemailer');
const { buildWarrantyCardPdf } = require('./warranty-pdf');
const { fillWarrantyTemplate } = require('./warranty-template-pdf');

const PORT = process.env.PORT || 4001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'technoline2026';
const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
// 25mb: content/parts can now carry several admin-uploaded part photos
// (each resized client-side, but many of them together add up)
app.use(express.json({ limit: '25mb' }));

// --- static site + admin panel ---------------------------------------
// Served from this same server (not a claude.ai Artifact) so the pages
// can call the /api/* routes below with a plain relative fetch — no CSP
// or cross-origin restriction, since it's all one origin now.
// index.html / admin.html change on every content/feature update, so they
// must never be cached by the browser or by any proxy in between (Render's
// default express.static Cache-Control was "public, max-age=0" with no
// no-store/must-revalidate — some browsers, and especially mobile ones on
// a plain reload, can still reuse a stored copy of that response instead
// of revalidating, which is why a fresh upload could still show old
// content/markup on reload). Force a real no-store on the HTML shell.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  }
}));
app.get('/admin', function (req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// --- storage ------------------------------------------------------------
// Render's free web-service disk is EPHEMERAL: it resets to empty on every
// redeploy and on every spin-down/spin-up after idle time, which is why
// admin-saved content was disappearing. When UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set (Upstash's free Redis — console.upstash.com,
// "REST API" section of the database) each top-level doc is stored there
// instead, which persists across restarts/redeploys. With neither var set,
// this falls back to the old local data.json file (fine for local testing,
// NOT durable on Render's free tier).
const DEFAULT_DB = {
  'content/site': {},
  'theme/site': {},
  'content/parts': {},
  'content/branches': {},
  'content/warranty': {
    'TL-227719-GE': { customerName: 'ნინო კავსაძე', device: 'iPhone 13 Pro', cat: 'სმარტფონი — ეკრანის შეცვლა', purchase: '2026-04-15', end: '2026-10-15' },
    'TL-118820-GE': { customerName: 'გიორგი მელაძე', device: 'MacBook Air M1', cat: 'ლეპტოპი — ბატარეის შეცვლა', purchase: '2023-11-04', end: '2024-05-04' },
    'TL-330045-GE': { customerName: 'თამარ ბერიძე', device: 'Samsung Galaxy S23', cat: 'სმარტფონი — ეკრანის შეცვლა (გაფართოებული)', purchase: '2026-08-01', end: '2027-02-01' },
    'TL-550012-GE': { customerName: 'დავით ლომიძე', device: 'Redmi Note 12', cat: 'სმარტფონი — ბატარეის შეცვლა', purchase: '2026-03-25', end: '2026-09-25' }
  },
  'content/warranty-template': {},
  bookings: []
};
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const DB_KEYS = Object.keys(DEFAULT_DB);

async function upstashGet(key) {
  const res = await fetch(UPSTASH_URL + '/get/technoline:' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
  });
  const data = await res.json();
  return data && data.result != null ? JSON.parse(data.result) : null;
}
async function upstashSet(key, value) {
  await fetch(UPSTASH_URL + '/set/technoline:' + encodeURIComponent(key), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
    body: JSON.stringify(value)
  });
}

async function readDb() {
  if (USE_UPSTASH) {
    try {
      const values = await Promise.all(DB_KEYS.map(upstashGet));
      const db = {};
      DB_KEYS.forEach(function (k, i) { db[k] = values[i] != null ? values[i] : (k === 'bookings' ? [] : {}); });
      return db;
    } catch (e) {
      console.error('Upstash read failed:', e.message);
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}
async function writeDb(db) {
  if (USE_UPSTASH) {
    await Promise.all(DB_KEYS.map(function (k) { return upstashSet(k, db[k]); }));
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}
if (!USE_UPSTASH && !fs.existsSync(DATA_FILE)) writeDb(DEFAULT_DB);

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

// never let a browser or intermediate cache serve a stale API response —
// this is what makes admin-saved content show up immediately on the site
app.use('/api', function (req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// --- site content: content/site, theme/site, content/parts, content/branches
const SITE_DOC_KEYS = {
  'content-site': 'content/site',
  'theme-site': 'theme/site',
  'content-parts': 'content/parts',
  'content-branches': 'content/branches',
  'warranty': 'content/warranty',
  'warranty-template': 'content/warranty-template'
};

app.get('/api/site/:doc', async function (req, res) {
  const key = SITE_DOC_KEYS[req.params.doc];
  if (!key) return res.status(404).json({ error: 'unknown_doc' });
  try {
    const db = await readDb();
    res.json(db[key] || {});
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// One call to fetch all four documents at once (what the storefront
// needs on page load).
app.get('/api/site', async function (req, res) {
  // Always fetch the current saved content fresh — never let a browser,
  // Render's edge network, or any proxy in between reuse an older answer
  // (this is what caused visitors/admins to briefly see stale text after
  // an edit was saved).
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const db = await readDb();
    res.json({
      content: db['content/site'] || {},
      theme: db['theme/site'] || {},
      parts: db['content/parts'] || {},
      branches: db['content/branches'] || {}
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/site/:doc', requireAuth, async function (req, res) {
  const key = SITE_DOC_KEYS[req.params.doc];
  if (!key) return res.status(404).json({ error: 'unknown_doc' });
  if (typeof req.body !== 'object' || Array.isArray(req.body) || req.body === null) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  try {
    const db = await readDb();
    db[key] = req.body; // full replace, mirrors the old db.doc(path).set(body)
    await writeDb(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// --- bookings -----------------------------------------------------------
function genConfirmationCode() {
  return 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// --- Smart Q-Logic integration (optional — only fires once both env vars
// below are set on Render; until then bookings just save locally as before) ---
// QLOGIC_API_BASE: Smart Q-Logic's own server address (its admin panel ->
//   "ინტეგრაციები" -> "საიტის ჯავშნების API" page, "Endpoint URL" field) —
//   just the domain, e.g. https://smart-qlogic.example, no trailing path.
// QLOGIC_API_KEY: the key shown on that same admin page (👁 button).
const QLOGIC_API_BASE = process.env.QLOGIC_API_BASE || '';
const QLOGIC_API_KEY = process.env.QLOGIC_API_KEY || '';

// our local branch id -> Smart Q-Logic's numeric branch_id. Q-Logic
// currently has only ONE branch configured there (id 1), so every local
// branch maps to it for now — update this if Q-Logic adds more branches.
const QLOGIC_BRANCH_MAP = { b1: 1, b2: 1, b3: 1, b4: 1 };

async function sendToQLogic(booking) {
  if (!QLOGIC_API_BASE || !QLOGIC_API_KEY) return null; // not configured yet
  const branch_id = QLOGIC_BRANCH_MAP[booking.branchId] || 1;
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 8000);
  try {
    const res = await fetch(QLOGIC_API_BASE.replace(/\/$/, '') + '/api/integrations/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': QLOGIC_API_KEY },
      signal: controller.signal,
      body: JSON.stringify({
        branch_id: branch_id,
        phone: booking.phone,
        appt_date: booking.date,
        appt_time: booking.timeSlot,
        customer_name: booking.name || undefined,
        service_type: booking.serviceType || undefined,
        note: [booking.deviceType, booking.issue, booking.notes].filter(Boolean).join(' / ') || undefined,
        external_ref: booking.id
      })
    });
    const data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      console.error('Smart Q-Logic booking failed:', res.status, data);
      return null;
    }
    return data; // { ok, booking:{ id, verify_code, ... }, space }
  } catch (e) {
    console.error('Smart Q-Logic request error:', e.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/bookings', async function (req, res) {
  const b = req.body || {};
  const required = ['branchId', 'serviceType', 'date', 'timeSlot', 'name', 'phone'];
  const missing = required.filter(function (f) { return !b[f]; });
  if (missing.length) {
    return res.status(400).json({ error: 'missing_fields', fields: missing });
  }
  let booking;
  try {
    const db = await readDb();
    booking = {
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
      notes: b.notes || null,
      qlogicId: null,
      qlogicVerifyCode: null,
      qlogicSpace: null
    };
    db.bookings.push(booking);
    await writeDb(db);
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
  res.status(201).json(booking); // respond right away — the site shouldn't wait on Q-Logic

  // fire the Q-Logic sync after responding; update the saved record if it succeeds
  sendToQLogic(booking).then(async function (result) {
    if (!result || !result.booking) return;
    const db2 = await readDb();
    const idx = db2.bookings.findIndex(function (x) { return x.id === booking.id; });
    if (idx === -1) return;
    db2.bookings[idx].qlogicId = result.booking.id;
    db2.bookings[idx].qlogicVerifyCode = result.booking.verify_code || null;
    db2.bookings[idx].qlogicSpace = result.space ? result.space.name : null;
    await writeDb(db2);
  }).catch(function (e) { console.error('post-booking qlogic sync error:', e.message); });
});

app.get('/api/bookings/:id', async function (req, res) {
  try {
    const db = await readDb();
    const booking = db.bookings.find(function (x) { return x.id === req.params.id; });
    if (!booking) return res.status(404).json({ error: 'not_found' });
    res.json(booking);
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// staff-only listing, for when the admin panel wants to show recent bookings
app.get('/api/bookings', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    res.json(db.bookings.slice(-200).reverse());
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Called by the local Smart Q-Logic bridge script (runs on the same machine
// as Q-Logic, since Q-Logic itself isn't reachable from this server) once it
// has successfully pushed a booking into Q-Logic — records the result here
// so the bridge (and the admin panel) knows this booking is already synced.
app.put('/api/bookings/:id/qlogic', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    const idx = db.bookings.findIndex(function (x) { return x.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    db.bookings[idx].qlogicId = b.qlogicId != null ? b.qlogicId : db.bookings[idx].qlogicId;
    db.bookings[idx].qlogicVerifyCode = b.qlogicVerifyCode || db.bookings[idx].qlogicVerifyCode;
    db.bookings[idx].qlogicSpace = b.qlogicSpace || db.bookings[idx].qlogicSpace;
    await writeDb(db);
    res.json({ ok: true, booking: db.bookings[idx] });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Warranty card: lookup, PDF download, email/SMS send -----------------
// Card visual is generated here (server-side, via warranty-pdf.js) from the
// 'content/warranty' collection in the DB — same read/write path as the
// site's other content, so records can later be managed from the admin
// panel the same way branches/parts are.
//
// Email uses SMTP (nodemailer) — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS
// (and optionally SMTP_SECURE=true, SMTP_FROM) as Render env vars to turn it
// on; until then the endpoint replies 503 { error:'not_configured' }.
// SMS is meant to go through Wifisher, but its API details aren't known
// yet — WIFISHER_API_URL/WIFISHER_API_KEY are unset for now, so /send with
// method:'sms' also replies 503 until those are filled in and
// sendWifisherSms() below is adjusted to Wifisher's real request format.
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const EMAIL_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
let mailTransport = null;
function getMailTransport() {
  if (!EMAIL_CONFIGURED) return null;
  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }
  return mailTransport;
}

const WIFISHER_API_URL = process.env.WIFISHER_API_URL || '';
const WIFISHER_API_KEY = process.env.WIFISHER_API_KEY || '';
const SMS_CONFIGURED = !!(WIFISHER_API_URL && WIFISHER_API_KEY);
async function sendWifisherSms(destination, text) {
  // TODO: placeholder request shape — adjust to Wifisher's real API once
  // its documentation/endpoint is available (same as the Smart Q-Logic
  // integration earlier: build against the real contract once we have it).
  const res = await fetch(WIFISHER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WIFISHER_API_KEY },
    body: JSON.stringify({ to: destination, text: text })
  });
  if (!res.ok) throw new Error('wifisher_failed_' + res.status);
}

function warrantyStatus(rec) {
  const today = new Date();
  const end = new Date(rec.end + 'T00:00:00');
  const remaining = Math.round((end - today) / 86400000);
  const active = remaining >= 0;
  return {
    active: active,
    remainingLabel: active ? (remaining + ' დღე') : (Math.abs(remaining) + ' დღის წინ')
  };
}

app.get('/api/warranty/:serial', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json(Object.assign({ serial: serial }, rec, warrantyStatus(rec)));
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Uses the staff-uploaded template (content/warranty-template) + its field
// positions when one has been saved from the admin panel's drag editor;
// otherwise falls back to the built-in generic card design (warranty-pdf.js)
// so the feature keeps working exactly as before for anyone who hasn't
// uploaded a template yet.
async function generateWarrantyCardPdf(db, serial, rec, status) {
  const template = db['content/warranty-template'] || {};
  if (template.pdf) {
    return fillWarrantyTemplate(template, {
      customerName: rec.customerName || '',
      serial: serial,
      model: rec.device || '',
      purchase: rec.purchase || '',
      warrantyEnd: rec.end || ''
    });
  }
  return buildWarrantyCardPdf({
    device: rec.device, cat: rec.cat, serial: serial, purchase: rec.purchase, end: rec.end,
    active: status.active, remainingLabel: status.remainingLabel,
    generatedAt: new Date().toISOString().slice(0, 10)
  });
}

app.get('/api/warranty/:serial/card', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const status = warrantyStatus(rec);
    const pdf = await generateWarrantyCardPdf(db, serial, rec, status);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="warranty-' + serial + '.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('warranty card generation failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Admin-only: generate a filled preview from the currently-saved template +
// sample data, without needing a real warranty record — used by the "test"
// button in the admin panel's drag-position editor.
app.post('/api/warranty-template/preview', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    const template = db['content/warranty-template'] || {};
    if (!template.pdf) return res.status(400).json({ error: 'no_template' });
    const b = req.body || {};
    const pdf = await fillWarrantyTemplate(template, {
      customerName: b.customerName || 'ტესტ მომხმარებელი',
      serial: b.serial || 'TL-TEST-0001',
      model: b.model || 'iPhone 13 Pro',
      purchase: b.purchase || '2026-01-01',
      warrantyEnd: b.warrantyEnd || '2026-07-01'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="warranty-template-preview.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('warranty template preview failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/warranty/:serial/send', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const method = (req.body && req.body.method) || '';
    const destination = String((req.body && req.body.destination) || '').trim();
    if (method !== 'email' && method !== 'sms') return res.status(400).json({ error: 'invalid_method' });
    if (!destination) return res.status(400).json({ error: 'missing_destination' });

    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const status = warrantyStatus(rec);

    if (method === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) return res.status(400).json({ error: 'invalid_email' });
      const transport = getMailTransport();
      if (!transport) return res.status(503).json({ error: 'not_configured', channel: 'email' });
      const pdf = await generateWarrantyCardPdf(db, serial, rec, status);
      await transport.sendMail({
        from: SMTP_FROM,
        to: destination,
        subject: 'თქვენი საგარანტიო ბარათი — ტექნოლაინი',
        text: 'თანდართულია თქვენი საგარანტიო ბარათი (' + serial + ').\n\ntechnoline.ge',
        attachments: [{ filename: 'warranty-' + serial + '.pdf', content: pdf }]
      });
      return res.json({ ok: true });
    }

    // method === 'sms'
    if (!SMS_CONFIGURED) return res.status(503).json({ error: 'not_configured', channel: 'sms' });
    await sendWifisherSms(destination, 'ტექნოლაინი — თქვენი გარანტია (' + serial + ') ' +
      (status.active ? 'აქტიურია' : 'ამოწურულია') + ', ვადა: ' + rec.end);
    res.json({ ok: true });
  } catch (e) {
    console.error('warranty send failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/health', function (req, res) {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, function () {
  console.log('technoline.ge content+booking test API running on http://localhost:' + PORT);
  console.log('Admin password: ' + ADMIN_PASSWORD + ' (set ADMIN_PASSWORD env var to change it)');
});
