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
const http = require('http');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const { buildWarrantyCardPdf } = require('./warranty-pdf');
const { fillWarrantyTemplate, extractTemplatePage } = require('./warranty-template-pdf');

const PORT = process.env.PORT || 4001;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'technoline2026';
// when set, admin login also needs an SMS code sent to this number (2FA)
const ADMIN_PHONE = String(process.env.ADMIN_PHONE || '').replace(/[^\d+]/g, '');
const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
// wraps app so the live-chat WebSocket servers (near the bottom of this
// file) can attach to the same HTTP server/port Express already listens on
const server = http.createServer(app);
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
// Soft launch: until ALLOW_INDEXING=true is set in Render's environment, the
// whole public site carries a noindex header too, so Google doesn't pick it
// up before the official launch. Remove it by adding ALLOW_INDEXING=true
// (no code change). The admin panel and /api are ALWAYS noindex, regardless.
const NOINDEX_VALUE = 'noindex, nofollow, noarchive, nosnippet';
app.use(function (req, res, next) {
  if (String(process.env.ALLOW_INDEXING || '').toLowerCase() !== 'true') {
    res.setHeader('X-Robots-Tag', NOINDEX_VALUE);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
    // the staff-only admin panel has no business showing up in search
    // results (see the robots.txt + /api noindex block below)
    if (filePath.endsWith('admin.html')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    }
  }
}));
app.get('/admin', function (req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- keep search engines out of the API + admin panel -------------------
// /api/* responses carry customer PII (warranty PDFs with names/serials,
// phone numbers, personal ID numbers, booking details) with a guessable
// URL (e.g. /api/warranty/:serial/card) and no login on several routes —
// there's no reason any of that should ever be crawled, cached or shown in
// Google (or any other) search results. robots.txt asks crawlers not to
// fetch these paths at all; X-Robots-Tag stops indexing even if a URL still
// gets fetched anyway (a shared link opened by a crawler-driven preview,
// for example). The public storefront pages (index.html, catalog, etc.)
// are deliberately left untouched so normal SEO keeps working there.
app.get('/robots.txt', function (req, res) {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Disallow: /api/\n' +
    'Disallow: /admin.html\n' +
    'Disallow: /admin\n'
  );
});
app.use('/api', function (req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
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
  // English text per the same data-ck keys as content/site — a key missing
  // or empty here just means that field hasn't been translated yet, and the
  // storefront falls back to the Georgian text rather than showing blank.
  // Seeded once below (seedEnglishContent) with a starting machine
  // translation of every field's default Georgian copy, which staff can
  // then edit from the admin panel exactly like the Georgian text today.
  'content/site-en': {},
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
  'content/chat-settings': {
    hoursEnabled: false,
    timezone: 'Asia/Tbilisi',
    schedule: {
      mon: { closed: false, open: '10:00', close: '20:00' },
      tue: { closed: false, open: '10:00', close: '20:00' },
      wed: { closed: false, open: '10:00', close: '20:00' },
      thu: { closed: false, open: '10:00', close: '20:00' },
      fri: { closed: false, open: '10:00', close: '20:00' },
      sat: { closed: false, open: '11:00', close: '18:00' },
      sun: { closed: true, open: '11:00', close: '18:00' }
    },
    // AI chat-agent settings live on this same doc (one PUT saves both the
    // hours form and these fields — see the admin panel's chat-ai-save handler).
    aiEnabled: false,
    aiName: '',
    aiRole: '',
    aiAvatar: '',
    // Sent automatically as the AI agent's first message the moment a brand
    // new chat is created (see the 'join' handler in /ws/chat) — admin can
    // change this text any time from the panel without touching code.
    aiGreeting: '',
    // Real operators' own working schedule — separate from hoursEnabled/
    // schedule above (that pair only drives the widget's cosmetic online/
    // offline label). This one is enforced server-side: see
    // isWithinOperatorHours() and its use in the 'message' WS handler —
    // outside these hours the AI never actually hands a chat off to a human.
    operatorHoursEnabled: false,
    operatorSchedule: {
      mon: { closed: false, open: '10:00', close: '20:00' },
      tue: { closed: false, open: '10:00', close: '20:00' },
      wed: { closed: false, open: '10:00', close: '20:00' },
      thu: { closed: false, open: '10:00', close: '20:00' },
      fri: { closed: false, open: '10:00', close: '20:00' },
      sat: { closed: false, open: '11:00', close: '18:00' },
      sun: { closed: true, open: '11:00', close: '18:00' }
    },
    // Shown to the customer (as the AI's own message, chat stays active)
    // instead of actually escalating, whenever the model wanted to hand off
    // but operators are currently off the clock per operatorSchedule above.
    operatorOfflineMessage: 'ამ ეტაპზე ოპერატორების სამუშაო დრო დასრულებულია. გთხოვთ, ხვალ მოგვმართოთ სამუშაო საათებში ან დაგვიკავშირდეთ ცხელ ხაზზე.'
  },
  // Knowledge base the AI agent answers customers from — object-wrapped
  // (not a bare array) because PUT /api/site/:doc rejects array bodies.
  'content/chat-kb': { entries: [] },
  // Pushed periodically by the local qlogic-bridge.js (the only thing that can
  // reach Q-Logic's localhost) via GET /api/integrations/availability — shape:
  // { [siteBranchId]: { [date 'YYYY-MM-DD']: [appt_time, ...] } }. Merged into
  // GET /api/bookings/busy so the site also blocks slots booked directly in
  // Q-Logic (admin panel/kiosk), not just ones made through the site itself.
  'content/qlogic-availability': {},
  bookings: [],
  users: {},
  feedback: [],
  chats: []
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
      DB_KEYS.forEach(function (k, i) { db[k] = values[i] != null ? values[i] : ((k === 'bookings' || k === 'feedback' || k === 'chats') ? [] : {}); });
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

// --- i18n seed content ------------------------------------------------
// One-time default English translation for every content/site data-ck key,
// used to populate content/site-en the first time this server runs against
// a database that doesn't have it yet (see seedEnglishContentIfNeeded below).
// Staff can then edit any of these fields from the admin panel exactly like
// the Georgian text today. A key missing here or left blank by staff simply
// falls back to the Georgian default on the storefront — nothing goes blank.
const SEED_EN_CONTENT = {
  "about.band.cta": "View Branches",
  "about.band.desc": "Over 60 certified engineers, our own quality-control lab, and 12 years of experience in the digital device market.",
  "about.band.title": "A Team You Can Trust",
  "about.head.lede": "Since 2013 we have served Georgia's market with digital device repair &mdash; transparent, fast, and with original parts.",
  "about.head.title": "About Technoline",
  "about.history.eyebrow": "Our Story",
  "about.history.p1": "Technoline started in Tbilisi as a small smartphone repair workshop. Today we are one of the largest independent service-center networks in Georgia &mdash; with 9 branches across three cities, over 60 certified engineers, and our own parts lab.",
  "about.history.p2": "Our goal is to make device repair as simple and transparent as buying one &mdash; with clear pricing, real-time status tracking, and a warranty on every job.",
  "about.history.title": "Started with one workshop, grew nationwide",
  "about.p1.desc": "We work only with certified suppliers and back every part with a 6-month warranty.",
  "about.p1.title": "Original Parts",
  "about.p2.desc": "80% of standard repairs are completed the same or the next business day.",
  "about.p2.title": "Fast Turnaround",
  "about.p3.desc": "Your personal data is protected &mdash; we sign a confidentiality agreement before any work begins.",
  "about.p3.title": "Data Security",
  "about.p4.desc": "Our team undergoes regular training on manufacturers' latest standards.",
  "about.p4.title": "Experienced Engineers",
  "about.p5.desc": "We confirm pricing after diagnostics &mdash; no hidden fees.",
  "about.p5.title": "Transparent Pricing",
  "about.p6.desc": "In Tbilisi, Batumi, and Kutaisi &mdash; your device is always close by.",
  "about.p6.title": "9 Branches",
  "about.principles.eyebrow": "Our Principles",
  "about.principles.title": "Why We're Chosen",
  "about.stat1Label": "Year Founded",
  "about.stat1Num": "2013",
  "about.stat2Label": "Branches",
  "about.stat2Num": "9",
  "about.stat3Label": "Certified Engineers",
  "about.stat3Num": "60+",
  "about.stat4Label": "Devices Repaired",
  "about.stat4Num": "45,000+",
  "booking.head.lede": "Choose a branch, service, and a time that works for you &mdash; 4 simple steps.",
  "booking.head.title": "Book a Visit to the Service Center",
  "catalog.head.lede": "Original and certified spare parts &mdash; with a 6-month warranty.",
  "catalog.head.title": "Parts Catalog",
  "chatWidget.aiBadgeLabel": "You're chatting with an AI agent &mdash; please double-check important information.",
  "chatWidget.gateIntro": "Before we start, please enter your name and phone number so we can send you a reply.",
  "chatWidget.gateNamePlaceholder": "Name",
  "chatWidget.inputPlaceholder": "Type a message…",
  "chatWidget.offlineNotice": "We're currently outside business hours &mdash; leave a message and we'll reply as soon as we're back.",
  "chatWidget.onlineLabel": "Online",
  "chatWidget.title": "Ask Us a Question",
  "common.bookCta": "Book a Visit",
  "common.brandName": "Technoline",
  "common.catalogCta": "View Catalog",
  "common.cookieAcceptBtn": "Accept All",
  "common.cookieBannerText": "The site uses essential technical cookies required for proper functioning (e.g. remembering your sign-in). For statistics and site improvement, you decide whether to allow additional analytics cookies &mdash; details in our <a href=\"#privacy\" data-route=\"privacy\">Privacy Policy</a>.",
  "common.cookieDeclineBtn": "Essential Only",
  "common.email": "info@technoline.ge",
  "common.megaSvcTypeBattery": "Battery Replacement",
  "common.megaSvcTypeBoard": "Motherboard Diagnostics",
  "common.megaSvcTypeData": "Data Recovery",
  "common.megaSvcTypeScreen": "Screen Replacement",
  "common.megaSvcTypeWater": "Water Damage",
  "common.navAbout": "About<br>Us",
  "common.navCatalog": "Parts<br>Catalog",
  "common.navContact": "Contact",
  "common.navServices": "Services",
  "common.navWarrantyCheck": "Warranty<br>Check",
  "common.navWarrantyService": "Warranty Service",
  "common.phone": "+995 322 12 34 56",
  "common.tagline": "TECHNOLINE SERVICE",
  "common.warrantyCheckCta": "Check Warranty",
  "contact.branches.eyebrow": "Branches",
  "contact.branches.title": "9 Branches, 3 Cities",
  "contact.center.email": "info@technoline.ge",
  "contact.center.phone": "+995 322 12 34 56 (Daily, 09:00–21:00)",
  "contact.center.title": "Contact Center",
  "contact.corp.email": "business@technoline.ge",
  "contact.corp.phone": "+995 322 12 34 57",
  "contact.corp.title": "Corporate Clients",
  "contact.head.lede": "Reach out with any question, or visit us at your nearest branch.",
  "contact.head.title": "Contact Information",
  "footer.address": "71 Vazha-Pshavela Ave.,<br>Tbilisi",
  "footer.blurb": "A network of digital device service centers in Georgia &mdash; since 2013, with original parts and transparent service.",
  "footer.colCompanyTitle": "Company",
  "footer.colContactTitle": "Contact",
  "footer.colServicesTitle": "Services",
  "footer.colToolsTitle": "Tools",
  "footer.copyright": "© 2026 Technoline LLC. All rights reserved.",
  "footer.privacyLink": "Privacy Policy",
  "footer.refundLink": "Refund Policy",
  "footer.servicesLink1": "Smartphones",
  "footer.servicesLink2": "Laptops",
  "footer.servicesLink3": "Tablets",
  "footer.servicesLink4": "Smartwatches",
  "footer.termsLink": "Terms and Conditions",
  "home.band.desc": "Enter your serial number or IMEI to find out whether your warranty covers the current issue.",
  "home.band.title": "Check your device's warranty status in 10 seconds",
  "home.craft.eyebrow": "Our Engineers at Work",
  "home.craft.lede": "From motherboard micro-soldering to safe battery replacement &mdash; every repair goes through the same quality control, regardless of device brand.",
  "home.craft.title": "Precision built over years of experience",
  "home.hero.badge1": "Original<br>Parts",
  "home.hero.badge2Label": "Average<br>Repair Time",
  "home.hero.badge2Num": "48h",
  "home.hero.badge3Label": "Years<br>Experience",
  "home.hero.badge3Num": "12",
  "home.hero.eyebrow": "<span class=\"dot\">",
  "home.hero.lede": "Technoline restores smartphones, laptops, tablets, and other digital devices &mdash; with original parts, transparent pricing, and an average turnaround of 48 hours.",
  "home.hero.title": "Your tech, in <em>trusted</em> hands",
  "home.reviews.eyebrow": "Customer Feedback",
  "home.reviews.quote1": "„They replaced my iPhone screen in an hour — the quality feels like a brand-new device.“",
  "home.reviews.quote2": "„My laptop got soaked in water and I thought the data was gone — they fully restored it, data and all, in 3 days.“",
  "home.reviews.quote3": "„I booked my visit online, skipped the line, and knew the price in advance — the most convenient service I've used.“",
  "home.reviews.title": "What Our Customers Say",
  "home.services.card2.desc": "Motherboard diagnostics, keyboard and screen replacement, system recovery.",
  "home.services.card2.tag": "Computers",
  "home.services.card2.title": "Laptops & Computers",
  "home.services.card3.desc": "Screen, battery, and port repairs for iPad and Android tablets.",
  "home.services.card3.tag": "Tablets",
  "home.services.card3.title": "Tablets",
  "home.services.card4.desc": "Screen, button, and charging module repair for all major brands.",
  "home.services.card4.tag": "Smartwatches",
  "home.services.card4.title": "Smartwatches",
  "home.services.card5.desc": "Cleaning, overheating, and HDMI issues for PlayStation, Xbox, and Nintendo consoles.",
  "home.services.card5.tag": "Gaming Consoles",
  "home.services.card5.title": "Gaming Consoles",
  "home.services.eyebrow": "Services",
  "home.services.lead.desc": "Screen, battery, camera, water damage &mdash; with original parts, usually the same day.",
  "home.services.lead.tag": "Smartphones",
  "home.services.lead.title": "Smartphone Repair",
  "home.services.lede": "From diagnostics to repair &mdash; our engineers work with every major brand and device type.",
  "home.services.title": "One center, every device",
  "home.stat1Label": "Devices Repaired",
  "home.stat1Num": "45,000+",
  "home.stat2Label": "Service Centers in Georgia",
  "home.stat2Num": "9",
  "home.stat3Label": "Customer Rating",
  "home.stat3Num": "4.8/5",
  "home.stat4Label": "Warranty on Every Repair",
  "home.stat4Num": "6 months",
  "home.steps.eyebrow": "How It Works",
  "home.steps.step1.desc": "Choose a branch and time online, or bring your device directly to a service center.",
  "home.steps.step1.title": "Booking",
  "home.steps.step2.desc": "An engineer diagnoses the issue and sends you an exact quote within 30 minutes.",
  "home.steps.step2.title": "Free Diagnostics",
  "home.steps.step3.desc": "Once approved, we begin the repair with original or certified parts.",
  "home.steps.step3.title": "Repair",
  "home.steps.step4.desc": "You get your device back with a 6-month warranty and an SMS notification.",
  "home.steps.step4.title": "Pickup & Warranty",
  "home.steps.title": "From diagnostics to pickup — 4 steps",
  "orders.head.lede": "Track the status of your current and completed repairs.",
  "orders.head.title": "My Orders",
  "privacy.head.date": "Last updated: October 1, 2026",
  "privacy.head.title": "Privacy Policy",
  "privacy.s1.body": "When you register, sign in, use live chat, or recover a warranty card on the site, we collect your name, phone number (verified by SMS code), and, if you choose, your email address. Booking a visit adds your device type, the service needed, and your selected branch/time. Live chat stores the text of your conversation and any photo/audio attachments you send. For warranty service, we collect the device's serial number and warranty dates.",
  "privacy.s1.title": "1. What Information We Collect",
  "privacy.s2.body": "We use your data only to provide our service: to verify your identity by SMS code, to notify you of your booking/repair status, to respond in chat (with the AI agent or an operator), and to look up or issue your warranty card. Your data is never used for direct marketing without your additional consent.",
  "privacy.s2.title": "2. How We Use Your Data",
  "privacy.s3.body": "The site uses browser local storage (localStorage) to keep you signed in when you return and to avoid asking for your name/phone again in chat. For statistics and site improvement we may use anonymous, aggregated analytics cookies from Google Analytics/Google Tag Manager &mdash; in that case, Google's own privacy terms apply. You can disable or delete cookies at any time in your browser settings.",
  "privacy.s3.title": "3. Cookies and Analytics",
  "privacy.s4.body": "We do not sell your data or share it with third parties for advertising purposes. We use a trusted SMS provider to send verification codes and notifications, and the Smart Q-Logic system to manage visit bookings. These partners receive your data only to the extent required to perform their specific function (delivering an SMS, processing a booking).",
  "privacy.s4.title": "4. Sharing Data with Third Parties",
  "privacy.s5.body": "Data is stored on company servers for as long as needed to provide our service and fulfill warranty obligations, or as required by law. Access is limited to personnel who need it to perform their job duties.",
  "privacy.s5.title": "5. Storage and Security",
  "privacy.s6.body": "You have the right to request a copy, correction, or deletion of your personal data. To do so, contact us via the channels listed on our <a href=\"#contact\" data-route=\"contact\" style=\"color:var(--blue);font-weight:700\">Contact page</a>. This policy may be updated periodically &mdash; the revision date is shown at the top of the page.",
  "privacy.s6.title": "6. Your Rights and Contact",
  "profile.head.lede": "Manage your personal details and added devices.",
  "profile.head.title": "My Profile",
  "services.head.lede": "Indicative prices &mdash; the final cost is confirmed after a free diagnostic.",
  "services.head.title": "Services & Pricing",
  "services.row1.desc": "Screen, battery, camera, charging port, water damage",
  "services.row1.price": "From ₾85",
  "services.row1.title": "Smartphones",
  "services.row2.desc": "Motherboard diagnostics, keyboard, overheating, SSD/RAM upgrade",
  "services.row2.price": "From ₾120",
  "services.row2.title": "Laptops & Computers",
  "services.row3.desc": "Screen, battery, charging port — iPad and Android",
  "services.row3.price": "From ₾95",
  "services.row3.title": "Tablets",
  "services.row4.desc": "Screen, buttons, charging module",
  "services.row4.price": "From ₾70",
  "services.row4.title": "Smartwatches",
  "services.row5.desc": "Cleaning, overheating, HDMI/controller issues",
  "services.row5.price": "From ₾90",
  "services.row5.title": "Gaming Consoles",
  "services.row6.desc": "Diagnostics and repair for small home appliances",
  "services.row6.price": "From ₾60",
  "services.row6.title": "Home Appliances",
  "terms.head.date": "Last updated: September 1, 2026",
  "terms.head.title": "Terms & Conditions",
  "terms.s1.body": "This document governs the relationship between Technoline LLC (the “Company”) and customers who use the Company's website or service center services. By using the website, the customer agrees to the terms set out below.",
  "terms.s1.title": "1. General Provisions",
  "terms.s2.body": "Diagnostics are free for every device. The final repair cost is confirmed to the customer in writing (by SMS or email) after diagnostics are complete, before work begins.",
  "terms.s2.list": "<li>A receipt with a unique number is issued when the device is received</li> <li>Standard repair time is 1–3 business days; complex cases take 5–7 days</li> <li>If the customer declines the repair after diagnostics, the diagnostic fee is not charged</li>",
  "terms.s2.title": "2. Terms of Service",
  "terms.s3.body": "Payment is made in cash or by card when the device is picked up. Corporate clients may pay in installments under a separate agreement.",
  "terms.s3.title": "3. Payment",
  "terms.s4.body": "The Company protects the customer's personal data and the information stored on the device in accordance with Georgian law. Access to device data is limited to personnel required for diagnostics and repair. We recommend customers back up their device's data before repair.",
  "terms.s4.title": "4. Data Protection",
  "terms.s5.body": "The Company is responsible for the quality of completed work for the duration of the warranty period. The Company is not liable for data loss if the customer did not back up their data and the damage was not caused by the work performed.",
  "terms.s5.title": "5. Liability",
  "terms.s6.body": "A booked visit can be canceled or rescheduled free of charge up to at least 2 hours before the appointment. A purchased part may be returned within 14 days of purchase if it has not been installed and remains in sellable condition.",
  "terms.s6.title": "6. Cancellation and Returns",
  "terms.s7.body": "For questions about these terms, contact us via the channels listed on our <a href=\"#contact\" data-route=\"contact\" style=\"color:var(--blue);font-weight:700\">Contact page</a>.",
  "terms.s7.title": "7. Contact",
  "warranty-check.head.lede": "Enter your device's serial number or IMEI and get its warranty status instantly.",
  "warranty-check.head.title": "Check Warranty Period",
  "warranty-check.side.desc": "Every repaired device and sold part comes with a 6-month warranty against defects.",
  "warranty-check.side.item1": "The warranty covers the replaced part and the work performed",
  "warranty-check.side.item2": "The serial number can be found in the device settings or on the box",
  "warranty-check.side.item3": "Warranty repair is free unless the damage is mechanical",
  "warranty-check.side.title": "How the Warranty Works",
  "wservice.band.bookCta": "Book",
  "wservice.band.checkCta": "Check",
  "wservice.band.desc": "Check your serial number online or book a visit for a free diagnostic.",
  "wservice.band.title": "Want to know if your warranty covers your case?",
  "wservice.head.lede": "What the warranty covers, how to use it, and how long warranty repairs take.",
  "wservice.head.title": "Warranty Service",
  "wservice.s1.desc": "Every job performed and every spare part sold by Technoline comes with a standard 6-month warranty. The warranty covers:",
  "wservice.s1.list": "<li>A factory defect in the replaced part (screen, battery, camera, charging port, etc.)</li> <li>The quality of the work performed — if the same problem recurs after repair</li> <li>Damage caused during installation</li>",
  "wservice.s1.title": "What the Warranty Covers",
  "wservice.s2.desc": "The warranty does not apply in the following cases:",
  "wservice.s2.list": "<li>New mechanical damage during the warranty period (drops, impacts, crushing)</li> <li>New exposure to water or liquid, if the original issue was unrelated</li> <li>Intervention by another service center after the repair</li> <li>Software issues unrelated to the work performed</li>",
  "wservice.s2.title": "What the Warranty Does Not Cover",
  "wservice.s3.desc": "To file a warranty claim:",
  "wservice.s3.list": "<li>Check your warranty status on the <a href=\"#warranty-check\" data-route=\"warranty-check\" style=\"color:var(--blue);font-weight:700\">warranty check page</a></li> <li>Book a visit at any branch — mention that it concerns a warranty case</li> <li>Bring a valid ID and, if possible, your original receipt</li>",
  "wservice.s3.title": "How to Use the Warranty",
  "wservice.s4.desc": "Most warranty cases are resolved within <strong>1–3 business days</strong>. If a part needs to be specially ordered, this may extend to 5–7 days — you will be notified in advance.",
  "wservice.s4.title": "Turnaround Time",
  "wservice.s5.desc": "When your repair is complete, you can purchase an extended, 12-month warranty package, which also includes one free diagnostic in the following year.",
  "wservice.s5.title": "Extended Warranty"
};

async function seedEnglishContentIfNeeded() {
  try {
    const db = await readDb();
    const existing = db['content/site-en'] || {};
    // Add only the keys that are missing — never overwrite anything the admin
    // already edited (or deliberately left empty) in the English content.
    const merged = Object.assign({}, existing);
    let added = 0;
    Object.keys(SEED_EN_CONTENT).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(merged, k)) {
        merged[k] = SEED_EN_CONTENT[k];
        added++;
      }
    });
    if (!added) return;
    db['content/site-en'] = merged;
    await writeDb(db);
    console.log('content/site-en: added ' + added + ' missing default English translation(s).');
  } catch (e) {
    console.error('English content seed failed:', e.message);
  }
}
seedEnglishContentIfNeeded();

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

// --- admin login: username + password (+ SMS code when ADMIN_PHONE is set) ---
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// brute-force guard: 8 failed attempts per IP -> 15 min lock
const loginFails = new Map(); // ip -> { n, until }
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLocked(ip) {
  const r = loginFails.get(ip);
  return !!(r && r.until && r.until > Date.now());
}
function loginFailed(ip) {
  const r = loginFails.get(ip) || { n: 0, until: 0 };
  if (r.until && r.until <= Date.now()) { r.n = 0; r.until = 0; }
  r.n++;
  if (r.n >= LOGIN_MAX_FAILS) { r.until = Date.now() + LOGIN_LOCK_MS; r.n = 0; }
  loginFails.set(ip, r);
}
const adminChallenges = new Map(); // id -> { code, expiresAt, attempts, lastSentAt, ip }
const ADMIN_OTP_TTL_MS = 5 * 60 * 1000;
const ADMIN_OTP_COOLDOWN_MS = 30 * 1000;
const ADMIN_OTP_MAX_ATTEMPTS = 5;
function maskPhone(p) {
  return p.length > 5 ? p.slice(0, 4) + '•••' + p.slice(-2) : '•••';
}
async function sendAdminCode(ch) {
  ch.code = String(crypto.randomInt(100000, 1000000));
  ch.expiresAt = Date.now() + ADMIN_OTP_TTL_MS;
  ch.attempts = 0;
  ch.lastSentAt = Date.now();
  await sendWifisherSms(ADMIN_PHONE, 'ტექნოლაინის ადმინის შესვლის კოდია: ' + ch.code);
}
setInterval(function () {
  const now = Date.now();
  adminChallenges.forEach(function (c, id) { if (c.expiresAt < now) adminChallenges.delete(id); });
  loginFails.forEach(function (r, ip) { if (!r.until || r.until < now) { if (!r.n) loginFails.delete(ip); } });
}, 60 * 1000).unref();

app.post('/api/auth/login', async function (req, res) {
  try {
    const ip = clientIp(req);
    if (loginLocked(ip)) return res.status(429).json({ error: 'locked' });
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    // evaluate both so timing doesn't reveal which one was wrong
    const okUser = safeEq(username.toLowerCase(), ADMIN_USERNAME.toLowerCase());
    const okPass = safeEq(password, ADMIN_PASSWORD);
    if (!(okUser && okPass)) {
      loginFailed(ip);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (!ADMIN_PHONE) return res.json({ token: issueToken() });
    if (!SMS_CONFIGURED) return res.status(503).json({ error: 'sms_not_configured' });
    const id = crypto.randomBytes(16).toString('hex');
    const ch = { ip: ip };
    await sendAdminCode(ch);
    adminChallenges.set(id, ch);
    res.json({ step: 'otp', challenge: id, phone: maskPhone(ADMIN_PHONE) });
  } catch (e) {
    console.error('admin login failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/verify', function (req, res) {
  const ip = clientIp(req);
  if (loginLocked(ip)) return res.status(429).json({ error: 'locked' });
  const id = String((req.body && req.body.challenge) || '');
  const code = String((req.body && req.body.code) || '').trim();
  const ch = adminChallenges.get(id);
  if (!ch) return res.status(400).json({ error: 'expired' });
  if (Date.now() > ch.expiresAt) { adminChallenges.delete(id); return res.status(400).json({ error: 'expired' }); }
  if (ch.attempts >= ADMIN_OTP_MAX_ATTEMPTS) { adminChallenges.delete(id); return res.status(429).json({ error: 'too_many_attempts' }); }
  if (!safeEq(code, ch.code)) {
    ch.attempts++;
    loginFailed(ip);
    return res.status(401).json({ error: 'invalid_code' });
  }
  adminChallenges.delete(id);
  res.json({ token: issueToken() });
});

app.post('/api/auth/resend', async function (req, res) {
  try {
    const ch = adminChallenges.get(String((req.body && req.body.challenge) || ''));
    if (!ch) return res.status(400).json({ error: 'expired' });
    if (Date.now() - ch.lastSentAt < ADMIN_OTP_COOLDOWN_MS) return res.status(429).json({ error: 'too_soon' });
    await sendAdminCode(ch);
    res.json({ ok: true });
  } catch (e) {
    console.error('admin resend failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
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
  'content-site-en': 'content/site-en',
  'theme-site': 'theme/site',
  'content-parts': 'content/parts',
  'content-branches': 'content/branches',
  'warranty': 'content/warranty',
  'warranty-template': 'content/warranty-template',
  'chatSettings': 'content/chat-settings',
  'chatKb': 'content/chat-kb',
  'bookingOptions': 'content/booking-options',
  'qlogicAvailability': 'content/qlogic-availability'
};

app.get('/api/site/:doc', async function (req, res) {
  const key = SITE_DOC_KEYS[req.params.doc];
  if (!key) return res.status(404).json({ error: 'unknown_doc' });
  try {
    const db = await readDb();
    res.json(req.params.doc === 'bookingOptions' ? effectiveBookingOptions(db) : (db[key] || {}));
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
      contentEn: db['content/site-en'] || {},
      theme: db['theme/site'] || {},
      parts: db['content/parts'] || {},
      branches: db['content/branches'] || {},
      chatSettings: db['content/chat-settings'] || {},
      bookingOptions: effectiveBookingOptions(db)
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

// --- booking constants shared with the chat AI agent's booking action ---
// Kept in sync by hand with technoline.html's own BRANCHES array and
// admin-panel.html's BRANCHES_DEFAULTS (same ids/fields) and with the
// <select id="bk-device">/<select id="bk-issue"> option lists and
// TIME_SLOTS in technoline.html's booking wizard — this is the server's own
// copy of "what a booking is allowed to look like", used so the AI chat
// agent (which never sees the storefront's DOM) can be told the real
// branch names/ids and offer the same device/issue/time choices a human
// filling in the booking page would see.
const BRANCHES_DEFAULTS = [
  { id: 'b1', name: 'ვაჟა-ფშაველას ფილიალი', addr: 'ვაჟა-ფშაველას გამზ. 71', hours: 'ორშ–შაბ, 10:00–20:00' },
  { id: 'b2', name: 'პეკინის გამზირის ფილიალი', addr: 'პეკინის გამზ. 14', hours: 'ორშ–კვ, 10:00–21:00' },
  { id: 'b3', name: 'რუსთაველის ფილიალი', addr: 'რუსთაველის ქ. 22', hours: 'ორშ–შაბ, 10:00–19:00' },
  { id: 'b4', name: 'ცენტრალური ფილიალი', addr: 'თამარ მეფის ქ. 8', hours: 'ორშ–შაბ, 10:00–19:00' }
];
// Device types and their issue lists are admin-managed (content/booking-options,
// edited in the admin "ჯავშნის პარამეტრები" tab); these are only the defaults
// used until the admin saves their own. Every device starts with the same issues.
const BOOKING_DEFAULT_DEVICES = [['სმარტფონი', 'Smartphone'], ['ლეპტოპი / კომპიუტერი', 'Laptop / computer'], ['პლანშეტი', 'Tablet'], ['სმარტ-საათი', 'Smartwatch'], ['სათამაშო კონსოლი', 'Game console'], ['საყოფაცხოვრებო ტექნიკა', 'Home appliance']];
const BOOKING_DEFAULT_ISSUES = [['ეკრანის დაზიანება', 'Screen damage'], ['ბატარეა ვერ იტენება', "Battery won't charge"], ['წყლის დაზიანება', 'Water damage'], ['არ ირთვება', "Won't turn on"], ['სხვა', 'Other']];
function defaultBookingOptions() {
  return {
    devices: BOOKING_DEFAULT_DEVICES.map(function (d, i) {
      return {
        id: 'd' + (i + 1), name: d[0], nameEn: d[1], enabled: true,
        issues: BOOKING_DEFAULT_ISSUES.map(function (x, j) { return { id: 'i' + (j + 1), name: x[0], nameEn: x[1], enabled: true }; })
      };
    })
  };
}
function effectiveBookingOptions(db) {
  const o = db && db['content/booking-options'];
  return (o && Array.isArray(o.devices)) ? o : defaultBookingOptions();
}
// {deviceName: [issueName, ...]} for the devices/issues that are switched on
function enabledBookingMap(db) {
  const out = {};
  effectiveBookingOptions(db).devices.forEach(function (d) {
    if (d.enabled === false || !d.name) return;
    out[d.name] = (d.issues || []).filter(function (x) { return x.enabled !== false && x.name; }).map(function (x) { return x.name; });
  });
  return out;
}
const BOOKING_TIME_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

// db['content/branches'] only holds per-branch OVERRIDES saved from the
// admin panel (same shape technoline.html/admin-panel.html merge client
// side) — merge them onto BRANCHES_DEFAULTS so the AI agent always sees a
// branch's current real name/address, not the stale factory default.
function effectiveBranches(db) {
  const overrides = (db && db['content/branches']) || {};
  return BRANCHES_DEFAULTS.map(function (def) {
    const o = overrides[def.id] || {};
    return {
      id: def.id,
      name: o.name != null ? o.name : def.name,
      addr: o.addr != null ? o.addr : def.addr,
      hours: o.hours != null ? o.hours : def.hours
    };
  });
}

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
      // surfaced on the booking record (qlogicError) so a rotated API key
      // (401), an IP-allowlist/geo-block (spec §162 §7), or a rate limit
      // (429) is visible in the admin panel instead of only in server logs.
      return { ok: false, error: 'http_' + res.status + (data && data.error ? ': ' + data.error : '') };
    }
    return { ok: true, booking: data.booking, space: data.space }; // { ok, booking:{ id, verify_code, ... }, space }
  } catch (e) {
    console.error('Smart Q-Logic request error:', e.message);
    return { ok: false, error: 'network_error: ' + e.message };
  } finally {
    clearTimeout(timeout);
  }
}

// Shared by the public POST /api/bookings route below AND the chat AI
// agent's "book_visit" action (see askChatAi / the chat action handler
// further down) — one place that creates a booking record, pushes it to
// Q-Logic, and keeps the saved record's qlogic* fields in sync, so a future
// change to that logic never needs to be made in two places.
// dbToUse: pass the SAME db object a caller is already holding (and will
// writeDb itself afterward) when that caller mutates other parts of the
// same db in the same turn — e.g. the chat AI action handler, which also
// appends chat messages to its own db2 and writes it once at the end. Doing
// our own independent readDb()+writeDb() in that case would read a snapshot
// taken before the booking existed and then overwrite the just-saved
// booking on disk with that stale snapshot (a lost-update race) the moment
// the caller's own writeDb() runs afterward — exactly the bug where a chat
// booking showed a confirmation message but the booking record itself (and
// its Q-Logic sync) silently vanished. Without dbToUse (the plain HTTP
// POST /api/bookings route) this reads/writes its own db as before.
async function createBookingRecord(b, dbToUse) {
  const owns = !dbToUse;
  const db = dbToUse || await readDb();
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
    notes: b.notes || null,
    qlogicId: null,
    qlogicVerifyCode: null,
    qlogicSpace: null,
    qlogicError: null
  };
  db.bookings = db.bookings || [];
  db.bookings.push(booking);
  if (owns) await writeDb(db);

  // fire the Q-Logic sync in the background; update the saved record either
  // way, so a failure (bad/rotated API key, IP not allowlisted, rate limit,
  // etc.) is recorded and visible in the admin panel, not just silently dropped
  sendToQLogic(booking).then(async function (result) {
    if (!result) return; // integration not configured on this deploy — nothing to record
    const db2 = await readDb();
    const idx = db2.bookings.findIndex(function (x) { return x.id === booking.id; });
    if (idx === -1) return;
    if (result.ok && result.booking) {
      db2.bookings[idx].qlogicId = result.booking.id;
      db2.bookings[idx].qlogicVerifyCode = result.booking.verify_code || null;
      db2.bookings[idx].qlogicSpace = result.space ? result.space.name : null;
      db2.bookings[idx].qlogicError = null;
    } else {
      db2.bookings[idx].qlogicError = (result && result.error) || 'unknown_error';
    }
    await writeDb(db2);
  }).catch(function (e) { console.error('post-booking qlogic sync error:', e.message); });

  return booking;
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
    booking = await createBookingRecord(b);
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
  res.status(201).json(booking); // respond right away — the site shouldn't wait on Q-Logic
});

// Which time slots are already taken for a branch+date (site bookings +
// whatever's pushed from Q-Logic directly) — shared by the public
// GET /api/bookings/busy route below and the chat AI agent's "book_visit"
// action, so both always see the exact same availability.
function computeBusySlots(db, branchId, date) {
  const siteSlots = (db.bookings || [])
    .filter(function (b) { return b.branchId === branchId && b.date === date; })
    .map(function (b) { return b.timeSlot; });
  // merge in slots booked directly inside Q-Logic (admin panel/kiosk) —
  // pushed periodically by the local qlogic-bridge.js, see DEFAULT_DB above
  const qlogicAvail = db['content/qlogic-availability'] || {};
  const qlogicSlots = (qlogicAvail[branchId] && qlogicAvail[branchId][date]) || [];
  return Array.from(new Set(siteSlots.concat(qlogicSlots)));
}

// Public — no personal data, just which time slots are already taken for a
// branch+date, so the booking page can grey them out before the customer
// picks one. Registered BEFORE /api/bookings/:id so it isn't swallowed by
// that param route (Express matches route order, and :id would otherwise
// match the literal word "busy" too).
app.get('/api/bookings/busy', async function (req, res) {
  try {
    const branchId = String(req.query.branchId || '');
    const date = String(req.query.date || '');
    if (!branchId || !date) return res.status(400).json({ error: 'missing_params' });
    const db = await readDb();
    res.json({ slots: computeBusySlots(db, branchId, date) });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// "ვიზიტის ჯავშნები" (site account cabinet) — same trust model as
// /api/warranty/by-customer above: the account is already phone-verified
// via /api/otp/verify at login, so this just filters by that phone.
// Registered before /api/bookings/:id for the same route-order reason as
// /api/bookings/busy above.
app.get('/api/bookings/mine', async function (req, res) {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'missing_params' });
    const db = await readDb();
    const mine = (db.bookings || [])
      .filter(function (b) { return normalizePhone(b.phone) === phone; })
      .sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    res.json(mine);
  } catch (e) {
    console.error('bookings mine lookup failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
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
    res.json(db.bookings.slice(-2000).reverse());
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

// --- Smart Q-Logic feedback webhook (opposite direction: Smart Q-Logic --
// pushes each customer rating INTO this endpoint — see
// smart-qlogic-feedback-webhook-spec.md for the full contract). Configure
// the shared secret shown on Smart Q-Logic's own admin panel (ინტეგრაციები
// -> "მომხმარებელთა უკუკავშირის გადაგზავნა საიტზე") as QLOGIC_FEEDBACK_SECRET
// on Render; until it's set this endpoint always answers 503, so nothing
// is ever accepted without a real secret to check against.
const QLOGIC_FEEDBACK_SECRET = process.env.QLOGIC_FEEDBACK_SECRET || '';

// Constant-time secret comparison (spec §3, explicit requirement). Hashing
// both sides to a fixed-length digest first means crypto.timingSafeEqual
// never sees two differently-sized buffers (it throws on a length
// mismatch) — so a wrong-length guess can't be told apart from a
// wrong-content one by response timing either.
function safeSecretEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

app.post('/api/qlogic-feedback', async function (req, res) {
  if (!QLOGIC_FEEDBACK_SECRET) return res.status(503).json({ error: 'not_configured' });
  const provided = req.headers['x-qlogic-webhook-secret'] || '';
  if (!provided || !safeSecretEqual(provided, QLOGIC_FEEDBACK_SECRET)) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  const b = req.body || {};
  if (b.event !== 'rating.created' && b.event !== 'rating.test') {
    return res.status(400).json({ error: 'invalid_event' });
  }
  // Store first, answer fast — Smart Q-Logic times out at 8s and never
  // retries a failed/slow delivery (spec §7), so there's no later chance
  // to pick this rating back up if we're not quick about it.
  try {
    const db = await readDb();
    db.feedback = db.feedback || [];
    db.feedback.push({
      id: 'fb_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      event: b.event,
      isTest: b.event === 'rating.test', // rating.test is Smart Q-Logic's own "send test message" button — kept, but flagged so the admin view can tell it apart from a real customer rating
      ratingId: b.rating_id != null ? b.rating_id : 0,
      branchId: b.branch_id != null ? b.branch_id : null,
      score: b.score != null ? b.score : null,
      criteria: Array.isArray(b.criteria) ? b.criteria : [],
      comment: b.comment || '',
      orderCode: b.order_code != null ? b.order_code : null, // links back to our own booking's confirmationCode when set from our booking-API's external_ref; null for walk-ins
      createdAt: b.created_at != null ? b.created_at : Date.now(),
      receivedAt: new Date().toISOString(),
      featured: false // staff picks which real reviews show on the public homepage — see /api/feedback/:id/feature
    });
    await writeDb(db);
    res.json({ ok: true });
  } catch (e) {
    console.error('qlogic feedback store failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// staff-only listing, for the admin panel's customer-feedback tab
app.get('/api/feedback', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    res.json((db.feedback || []).slice(-500).reverse());
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// staff-only: mark/unmark one real review to show on the public homepage
// "რას ამბობენ ჩვენზე?" section — deliberately staff-curated rather than
// auto-published, since a real customer comment goes public here.
app.put('/api/feedback/:id/feature', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    db.feedback = db.feedback || [];
    const idx = db.feedback.findIndex(function (x) { return x.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'not_found' });
    db.feedback[idx].featured = !!(req.body && req.body.featured);
    await writeDb(db);
    res.json({ ok: true, feedback: db.feedback[idx] });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// public, unauthenticated: the staff-featured real reviews, for the site's
// own homepage "რას ამბობენ ჩვენზე?" section. Sanitized on purpose — no
// customer name/phone ever existed on this record to begin with (Smart
// Q-Logic never sends one), and rating.test entries never qualify.
app.get('/api/feedback/public', async function (req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  try {
    const db = await readDb();
    const list = (db.feedback || [])
      .filter(function (f) { return f.featured && !f.isTest; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
      .slice(0, 12)
      .map(function (f) {
        return { score: f.score, comment: f.comment || '', criteria: f.criteria || [], createdAt: f.createdAt };
      });
    res.json(list);
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
// SMS goes through Wifisher (sms-api.wifisher.com) — set WIFISHER_API_KEY
// (your account's API key) and WIFISHER_SENDER (your approved sender
// name, e.g. "TECHNOLINE" — must be pre-approved on your Wifisher
// account, otherwise sends fail with an "invalid sender" error) as Render
// env vars to turn it on; until both are set /send with method:'sms' and
// /api/otp/send both reply 503 { error:'not_configured' }.
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

// Used to build an absolute link back to this API (e.g. the warranty card
// URL texted to customers) — Render sets RENDER_EXTERNAL_URL automatically
// in production, so this fallback only matters for local/manual runs.
const PUBLIC_API_BASE_URL = 'https://technoline-content-api.onrender.com';
const WIFISHER_API_URL = process.env.WIFISHER_API_URL || 'https://sms-api.wifisher.com/api/v2/send';
const WIFISHER_API_KEY = process.env.WIFISHER_API_KEY || '';
const WIFISHER_SENDER = process.env.WIFISHER_SENDER || '';
const SMS_CONFIGURED = !!(WIFISHER_API_KEY && WIFISHER_SENDER);
async function sendWifisherSms(destination, text) {
  const form = new FormData();
  form.set('from', WIFISHER_SENDER);
  form.set('to', destination);
  form.set('content', text);
  const res = await fetch(WIFISHER_API_URL, {
    method: 'POST',
    headers: { 'api-key': WIFISHER_API_KEY },
    body: form
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok) throw new Error('wifisher_failed_' + res.status + (data ? ' ' + JSON.stringify(data) : ''));
  return data;
}

// --- SMS OTP login verification (personal-cabinet sign-in) --------------
// In-memory only (fine for a single Render instance — codes are short-lived
// and this mirrors the existing `tokens` admin-session pattern above).
const otpStore = new Map(); // normalized phone -> { code, expiresAt, attempts, lastSentAt }
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d+]/g, '');
}
function genOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.post('/api/otp/send', async function (req, res) {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!/^\+?\d{9,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
    if (!SMS_CONFIGURED) return res.status(503).json({ error: 'not_configured' });
    const existing = otpStore.get(phone);
    if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'too_soon' });
    }
    const code = genOtpCode();
    otpStore.set(phone, { code: code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
    await sendWifisherSms(phone, 'თქვენი ტექნოლაინის ვერიფიკაციის კოდია: ' + code);
    res.json({ ok: true });
  } catch (e) {
    console.error('otp send failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/otp/verify', async function (req, res) {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const code = String((req.body && req.body.code) || '').trim();
    const entry = otpStore.get(phone);
    if (!entry) return res.status(400).json({ error: 'no_pending_code' });
    if (Date.now() > entry.expiresAt) { otpStore.delete(phone); return res.status(400).json({ error: 'expired' }); }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(phone); return res.status(429).json({ error: 'too_many_attempts' }); }
    if (code !== entry.code) {
      entry.attempts++;
      return res.status(400).json({ error: 'invalid_code' });
    }
    otpStore.delete(phone);

    const db = await readDb();
    db.users = db.users || {};
    const now = new Date().toISOString();
    const name = (req.body && req.body.name) || '';
    const email = (req.body && req.body.email) || '';
    const record = db.users[phone] || { phone: phone, registeredAt: now };
    record.lastLoginAt = now;
    if (name) record.name = name;
    if (email) record.email = email;
    db.users[phone] = record;
    await writeDb(db);

    res.json({ ok: true, user: record });
  } catch (e) {
    console.error('otp verify failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// staff-only CRM listing: registered users, registration + last-login dates
app.get('/api/users', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    const users = Object.values(db.users || {}).sort(function (a, b) {
      return (b.lastLoginAt || '').localeCompare(a.lastLoginAt || '');
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

function warrantyStatus(rec) {
  const today = new Date();
  const end = new Date(rec.end + 'T00:00:00');
  const remaining = Math.round((end - today) / 86400000);
  const active = remaining >= 0;
  return {
    active: active,
    // remainingDays: a signed day count the client can localize itself
    // (positive = days left, negative = days since expiry). remainingLabel
    // is kept Georgian-only for old clients/back-compat; the site's
    // language toggle is client-side only, so the server has no language
    // to render this string in.
    remainingDays: remaining,
    remainingLabel: active ? (remaining + ' დღე') : (Math.abs(remaining) + ' დღის წინ')
  };
}

// "ჩემი საგარანტიო ბარათები" (site account cabinet) — pulls every warranty
// record belonging to this customer. The account's phone is already
// SMS-verified via /api/otp/verify at login (same unified identity used
// site-wide), so a record whose own phone matches it is proven to be this
// customer's on that basis alone — this doesn't re-run its own OTP step,
// it trusts the already-logged-in phone, same as the other account
// cabinet tabs (devices, orders). personalId is now only a FALLBACK match
// for older/demo records that have a personal ID on file but no phone —
// requiring both used to mean a record with a phone but no personalId (the
// common case when staff only fill in the phone) could never show up here
// at all, even though the phone match alone is just as trustworthy.
// Registered BEFORE /api/warranty/:serial so it isn't swallowed by that
// param route (Express matches route order, and :serial would otherwise
// match the literal word "by-customer" too — same fix as /api/bookings/busy).
app.get('/api/warranty/by-customer', async function (req, res) {
  try {
    const phone = normalizePhone(req.query.phone);
    const personalId = String(req.query.personalId || '').trim();
    if (!phone) return res.status(400).json({ error: 'missing_params' });
    const db = await readDb();
    const all = db['content/warranty'] || {};
    const cards = Object.keys(all)
      .filter(function (serial) {
        const rec = all[serial];
        if (!rec) return false;
        if (rec.phone && normalizePhone(rec.phone) === phone) return true;
        if (!rec.phone && personalId && rec.personalId && String(rec.personalId).trim() === personalId) return true;
        return false;
      })
      .map(function (serial) {
        const rec = all[serial];
        return Object.assign({ serial: serial }, rec, warrantyStatus(rec));
      });
    res.json({ cards: cards });
  } catch (e) {
    console.error('warranty by-customer lookup failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// A record only requires phone verification once staff have put a phone
// number on it from the admin panel — older/demo records with no phone on
// file keep working exactly as before (instant lookup, no SMS step), so
// this only changes behavior for records staff have opted into it for.
app.get('/api/warranty/:serial', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.phone) return res.status(401).json({ error: 'phone_verification_required' });
    res.json(Object.assign({ serial: serial }, rec, warrantyStatus(rec)));
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Phone-verified warranty check (public warranty-check page) --------
// A record with a phone on file (added from the admin panel's warranty
// records table) can only be looked up by someone who can prove they
// control that same phone number, via the existing SMS-OTP mechanism.
// Both steps answer identically whether the serial is unknown or the phone
// doesn't match, so a wrong guess can't be used to probe which is off.
app.post('/api/warranty/:serial/otp/send', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const phone = normalizePhone(req.body && req.body.phone);
    if (!/^\+?\d{9,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
    if (!SMS_CONFIGURED) return res.status(503).json({ error: 'not_configured' });

    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec || !rec.phone || normalizePhone(rec.phone) !== phone) {
      return res.status(404).json({ error: 'not_found' });
    }

    const key = 'warranty:' + phone;
    const existing = otpStore.get(key);
    if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'too_soon' });
    }
    const code = genOtpCode();
    otpStore.set(key, { code: code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
    await sendWifisherSms(phone, 'თქვენი გარანტიის შემოწმების კოდია: ' + code);
    res.json({ ok: true });
  } catch (e) {
    console.error('warranty otp send failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/warranty/:serial/otp/verify', async function (req, res) {
  try {
    const serial = String(req.params.serial || '').trim().toUpperCase();
    const phone = normalizePhone(req.body && req.body.phone);
    const code = String((req.body && req.body.code) || '').trim();
    const key = 'warranty:' + phone;
    const entry = otpStore.get(key);
    if (!entry) return res.status(400).json({ error: 'no_pending_code' });
    if (Date.now() > entry.expiresAt) { otpStore.delete(key); return res.status(400).json({ error: 'expired' }); }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(key); return res.status(429).json({ error: 'too_many_attempts' }); }
    if (code !== entry.code) {
      entry.attempts++;
      return res.status(400).json({ error: 'invalid_code' });
    }
    otpStore.delete(key);

    const db = await readDb();
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec || !rec.phone || normalizePhone(rec.phone) !== phone) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json(Object.assign({ serial: serial }, rec, warrantyStatus(rec)));
  } catch (e) {
    console.error('warranty otp verify failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Uses the staff-uploaded template (content/warranty-template) + its field
// positions when one has been saved from the admin panel's drag editor;
// otherwise falls back to the built-in generic card design (warranty-pdf.js)
// so the feature keeps working exactly as before for anyone who hasn't
// uploaded a template yet. If the template-based fill throws for any reason
// (a malformed saved template, a font/embedding error, etc.) we log the full
// error and fall back to the generic design too, rather than failing the
// customer's download/email/SMS-link outright.
async function generateWarrantyCardPdf(db, serial, rec, status) {
  const template = db['content/warranty-template'] || {};
  if (template.pdf) {
    try {
      return await fillWarrantyTemplate(template, {
        customerName: rec.customerName || '',
        serial: serial,
        model: rec.device || '',
        purchase: rec.purchase || '',
        warrantyEnd: rec.end || ''
      });
    } catch (e) {
      console.error('template-based warranty card failed, falling back to generic design:', e.stack || e.message);
    }
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
    // inline (not attachment) so the SMS/email-shared link opens the PDF
    // directly in the phone's browser instead of forcing a file download.
    res.setHeader('Content-Disposition', 'inline; filename="warranty-' + serial + '.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('warranty card generation failed:', e.stack || e.message);
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

// Admin-only: single-page extract of the uploaded template, used by the
// field-position editor's page picker (see extractTemplatePage's own
// comment for why — avoids the multi-page-scroll/percent-ambiguity problem
// entirely by only ever showing the editor one real page at a time).
app.post('/api/warranty-template/page', requireAuth, async function (req, res) {
  try {
    const b = req.body || {};
    if (!b.pdf) return res.status(400).json({ error: 'no_pdf' });
    const result = await extractTemplatePage(b.pdf, b.page);
    res.json(result);
  } catch (e) {
    console.error('warranty template page extract failed:', e.message);
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

    // method === 'sms' — SMS can't carry an attachment, so the card itself
    // is a link to the same public, unauthenticated /card endpoint the
    // customer's own "PDF download" button already uses.
    if (!SMS_CONFIGURED) return res.status(503).json({ error: 'not_configured', channel: 'sms' });
    const publicBase = process.env.RENDER_EXTERNAL_URL || PUBLIC_API_BASE_URL;
    const cardLink = publicBase + '/api/warranty/' + encodeURIComponent(serial) + '/card';
    await sendWifisherSms(destination, 'ტექნოლაინი — თქვენი გარანტია (' + serial + ') ' +
      (status.active ? 'აქტიურია' : 'ამოწურულია') + ', ვადა: ' + rec.end + '. ბარათი: ' + cardLink);
    res.json({ ok: true });
  } catch (e) {
    console.error('warranty send failed:', e.stack || e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- AI-assisted catalog search ------------------------------------------
// The catalog's live item list (name/brand/category/device/price) is
// assembled client-side in technoline.html from the static demo parts plus
// whatever the admin panel has saved — there's no separate copy of it here.
// So the frontend sends its current item list along with the typed query,
// and this just asks Claude which of those items match; nothing catalog-
// related is stored or duplicated on this server.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const AI_SEARCH_CONFIGURED = !!ANTHROPIC_API_KEY;

app.post('/api/catalog/search-ai', async function (req, res) {
  if (!AI_SEARCH_CONFIGURED) return res.status(503).json({ error: 'ai_not_configured' });
  const query = String((req.body && req.body.query) || '').trim().slice(0, 200);
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 300) : [];
  if (!query || !items.length) return res.json({ ids: [] });

  const catalogLines = items.map(function (it) {
    return String(it.id || '') + ' | ' + String(it.name || '') + ' | ბრენდი: ' + String(it.brand || '')
      + ' | ტიპი: ' + String(it.cat || '') + ' | მოწყობილობა: ' + String(it.device || '')
      + ' | თავსებადობა: ' + String(it.compat || '');
  }).join('\n');

  const prompt = 'მომხმარებლის საძიებო მოთხოვნა ონლაინ-მაღაზიის სათადარიგო ნაწილების კატალოგში: "' + query + '"\n\n'
    + 'კატალოგი (id | დასახელება | ბრენდი | ტიპი | მოწყობილობა | თავსებადობა):\n' + catalogLines + '\n\n'
    + 'გაიგე მომხმარებლის განზრახვა თუნდაც პირდაპირ არ ემთხვეოდეს სიტყვები (მაგ. "დამემტვრა ეკრანი" ან "screen" უნდა დაემთხვეს "ეკრანები" ტიპის ნაწილებს), და დააბრუნე მხოლოდ JSON მასივი შესატყვისი ნაწილების id-ებით, საუკეთესო შესატყვისობით დალაგებული — მაგ: ["p1","p5"]. თუ ვერაფერი ემთხვევა, დააბრუნე []. აბსოლუტურად არაფერი სხვა არ დაწერო, მხოლოდ JSON მასივი.';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 8000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await r.json().catch(function () { return null; });
    if (!r.ok) { console.error('AI search upstream error:', r.status, data); return res.status(502).json({ error: 'ai_upstream_error' }); }
    const text = (data && data.content && data.content[0] && data.content[0].text) || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    let ids = [];
    try { ids = JSON.parse(match ? match[0] : text); } catch (e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    res.json({ ids: ids.filter(function (id) { return typeof id === 'string'; }) });
  } catch (e) {
    console.error('AI search failed:', e.message);
    res.status(504).json({ error: 'ai_search_timeout' });
  }
});

// Operators' own working schedule (content/chat-settings.operatorHoursEnabled
// / .operatorSchedule / .timezone — admin panel's "ოპერატორების სამუშაო
// გრაფიკი" card) — separate from chatSettings.hoursEnabled/.schedule, which
// only drives the widget's cosmetic online/offline label and never blocks
// anything. This one is enforced server-side: see its use in the 'message'
// WS handler below, which refuses to actually hand a chat off to a human
// outside these hours. Same Intl-based weekday/time check as the client's
// isWithinChatHours() in technoline.html — kept in sync by hand since one
// runs in the browser and the other in Node.
const OPERATOR_DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function isWithinOperatorHours(settings) {
  if (!settings || !settings.operatorHoursEnabled) return true;
  const sched = settings.operatorSchedule || {};
  const tz = settings.timezone || 'Asia/Tbilisi';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const map = {};
    parts.forEach(function (p) { map[p.type] = p.value; });
    const dowShort = (map.weekday || '').slice(0, 3).toLowerCase();
    const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(dowShort);
    const key = idx > -1 ? OPERATOR_DOW_KEYS[idx] : null;
    const day = key ? sched[key] : null;
    if (!day || day.closed) return false;
    const nowMinutes = (parseInt(map.hour, 10) || 0) * 60 + (parseInt(map.minute, 10) || 0);
    const toMinutes = function (s) {
      const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
      return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
    };
    const openM = toMinutes(day.open), closeM = toMinutes(day.close);
    if (openM == null || closeM == null) return true;
    return nowMinutes >= openM && nowMinutes < closeM;
  } catch (e) { return true; /* bad timezone/schedule data — never block hand-off on a data error */ }
}

// --- AI chat agent (live chat, Google Gemini) ----------------------------
// Answers customers from the admin-authored knowledge base (content/chat-kb)
// and hands off to a real operator (sets chat.aiPaused, see the WS handlers
// below) whenever it can't answer from the KB or the customer asks for a
// human — one Gemini call per customer message returns both decisions at
// once as structured JSON, so there's no separate "detect a human request"
// step to keep in sync.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const CHAT_AI_CONFIGURED = !!GEMINI_API_KEY;

// Turns a saved chat attachment ({name,type,dataUrl}, already validated by
// chatAttachmentFromMsg) into a Gemini inlineData part when it's an image —
// lets the AI agent actually look at photos customers send (read any text/
// serial numbers on them, recognize the device/part shown), not just see
// that a file arrived. Non-image attachments (e.g. a PDF) aren't sent as
// vision input; buildGeminiUserParts below falls back to a text note instead.
function attachmentToGeminiPart(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const type = String(attachment.type || '');
  if (!/^image\//.test(type)) return null;
  const dataUrl = String(attachment.dataUrl || '');
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const b64 = dataUrl.slice(comma + 1);
  if (!b64) return null;
  return { inlineData: { mimeType: type, data: b64 } };
}
// Builds one Gemini "user" turn's parts from a chat message's text + optional
// attachment — shared by the conversation history and the newest message, so
// both get the same image-aware treatment.
function buildGeminiUserParts(text, attachment) {
  const parts = [];
  if (text) parts.push({ text: String(text).slice(0, 2000) });
  const imgPart = attachmentToGeminiPart(attachment);
  if (imgPart) {
    parts.push(imgPart);
  } else if (attachment && !parts.length) {
    // non-image attachment with no caption text — Gemini can't see it, but
    // the turn still needs at least one part, and the model should know
    // some file came through even though it can't read it.
    parts.push({ text: '[მომხმარებელმა გამოგზავნა ფაილი: ' + String(attachment.name || 'ფაილი').slice(0, 100) + ']' });
  }
  return parts;
}

function chatKbToPromptText(kb) {
  const allEntries = (kb && Array.isArray(kb.entries)) ? kb.entries : [];
  const folders = (kb && Array.isArray(kb.folders)) ? kb.folders : [];
  const folderById = {};
  folders.forEach(function (f) { folderById[f.id] = f; });
  // an entry (or its whole folder) switched off in the admin is simply not
  // part of what Tato knows
  const entries = allEntries.filter(function (e) {
    if (e.enabled === false) return false;
    const f = e.folderId ? folderById[e.folderId] : null;
    return !(f && f.enabled === false);
  });
  if (!entries.length) return '(ცოდნის ბაზა ჯერ ცარიელია)';
  const fmt = function (e) { return '### ' + String(e.title || '').trim() + '\n' + String(e.body || '').trim(); };
  const out = [];
  folders.forEach(function (f) {
    const inF = entries.filter(function (e) { return e.folderId === f.id; });
    if (inF.length) out.push('## თემა: ' + String(f.name || '').trim() + '\n\n' + inF.map(fmt).join('\n\n'));
  });
  const loose = entries.filter(function (e) { return !e.folderId || !folderById[e.folderId]; });
  if (loose.length) out.unshift((folders.length ? '## თემა: ზოგადი\n\n' : '') + loose.map(fmt).join('\n\n'));
  return out.join('\n\n');
}

// history: chat.messages BEFORE the new customer message, already filtered
// to only 'customer'/'ai' turns by the caller (admin messages never appear —
// once a human replies, chat.aiPaused is set and the AI is never called again).
// branches: effectiveBranches(db) — the real, current branch list (admin
// overrides already merged in), so the model names/picks real branches
// instead of the factory defaults once staff rename or move one.
async function askChatAi(kb, history, userText, agentName, branches, attachment, bookingMap) {
  if (!CHAT_AI_CONFIGURED) return null;
  const nameLine = agentName ? ('შენი სახელია „' + agentName + '" — თუ მომხმარებელი სახელს გკითხავს, ასე გააცანი თავი.\n\n') : '';
  const todayStr = new Date().toISOString().slice(0, 10);
  // Tato's built-in chat actions can be switched off one by one in the admin
  // panel (content/chat-kb .abilities); anything not explicitly false is on.
  const abil = (kb && kb.abilities) || {};
  const warrantyOn = abil.warrantyCard !== false;
  const bookingOn = abil.bookVisit !== false;
  const branchesLines = (branches || []).map(function (b) {
    return b.id + ' — ' + b.name + ' (' + b.addr + '), სამუშაო საათები: ' + b.hours;
  }).join('\n');
  const systemInstruction = {
    parts: [{
      text: 'შენ ხარ technoline.ge-ის საიტის ლაივ ჩატის დამხმარე AI აგენტი. უპასუხე მომხმარებელს მხოლოდ ქვემოთ მოცემული ცოდნის ბაზის მიხედვით, თავაზიანად და მოკლედ.\n\n'
        + 'ენა: უპასუხე ყოველთვის იმავე ენაზე, რომელზეც მომხმარებელი მოგმართავს (მაგ. თუ ინგლისურად წერს — ინგლისურად უპასუხე, თუ რუსულად — რუსულად, თუ ქართულად — ქართულად). არასდროს გადართო სხვა ენაზე თვითონ.\n\n'
        + nameLine
        + 'ცოდნის ბაზა:\n' + chatKbToPromptText(kb) + '\n\n'
        + 'წესები:\n'
        + '- უპასუხე მხოლოდ იმაზე, რაც ცოდნის ბაზაშია. არასდროს გამოიგონო ინფორმაცია.\n'
        + '- თუ პასუხი ცოდნის ბაზაში არ მოიძებნება, ან მომხმარებელი პირდაპირ ითხოვს რეალურ ოპერატორთან საუბარს, დააბრუნე escalate:true და reply-ში თავაზიანად აცნობე, რომ გადასცემ საუბარს ოპერატორს.\n'
        + '- თუ მომხმარებელი გეკითხება ტექნოლაინთან ან მის სერვისებთან სრულიად დაუკავშირებელ, გვერდით საკითხს (ეს არ არის ინფორმაციის ნაკლებობა ცოდნის ბაზაში — უბრალოდ თემა სხვაა), ეს არ ითვლება ოპერატორთან გადაცემის მიზეზად: escalate:false, თავაზიანად აუხსენი, რომ მხოლოდ ტექნოლაინის საკითხებში ეხმარები, და reply-ს ბოლოში სიტყვასიტყვით დაამატე: „სხვა საკითხში თუ შევძლებ თქვენს დახმარებას, სიამოვნებით გიპასუხებთ.“ (არასდროს დასვა „რით შემიძლია დაგეხმაროთ დღეს?" ან სხვა მსგავსი ფრაზა ამის ნაცვლად).\n'
        + '- თუ მომხმარებელი უბრალოდ თბილ სიტყვას, კომპლიმენტს, მადლობას ან დამშვიდობებას წერს და კონკრეტულ კითხვას არ სვამს (ანუ წინა შეტყობინება უკვე ამომწურავად პასუხობდა მის საკითხს) — ეს არც ინფორმაციის ნაკლებობაა და არც ახალი გვერდითი საკითხი, ამიტომ არასდროს დაამატო „სხვა საკითხში თუ შევძლებ...“-ის მსგავსი ფრაზა ხელახლა: უბრალოდ თბილად და მოკლედ უპასუხე მადლობით (escalate:false), და თუ აშკარაა, რომ საუბარი სრულდება და დამატებითი დახმარება აღარ სჭირდება, თავაზიანად დაემშვიდობე, დახმარების შეთავაზების გამეორების გარეშე.\n'
        + '- არასდროს გაიმეორო სიტყვასიტყვით (ან თითქმის სიტყვასიტყვით) წინადადება, რომელიც ამ საუბარში უკვე დაწერე — თუნდაც იგივე ტიპის სიტუაცია განმეორდეს, თითოეული პასუხი ბუნებრივად და ახლებურად ჩამოაყალიბე.\n'
        + '- მომხმარებელს შეუძლია ჩატში სურათის გამოგზავნაც (მაგ. დაზიანებული მოწყობილობის ფოტო, საგარანტიო ბარათი, სერიული ნომრის ან მოდელის ეტიკეტი). თუ შეტყობინებას სურათი ახლავს, ყურადღებით დააკვირდი მას — წაიკითხე მასზე არსებული ნებისმიერი ტექსტი თუ ციფრები (მაგ. სერიული ნომერი, მოდელის სახელი) და ამოიცანი რა საგანია/დაზიანებაა გამოსახული, და ეს დანახული ინფორმაცია გამოიყენე პასუხის გასაცემად.\n'
        + '- მოწყობილობის ყუთის ფოტოდან სერიული ნომრის ამოკითხვისას იხელმძღვანელე ამ წესით: თუ ეტიკეტზე ერთდროულად წერია S/N, IMEI1 და IMEI2 — საძიებო/საგარანტიო სერიულ ნომრად აუცილებლად გამოიყენე მხოლოდ IMEI1-ის გასწვრივ მითითებული კოდი (არა S/N და არა IMEI2). თუ ეტიკეტზე მხოლოდ S/N წერია (IMEI ველების გარეშე) — მაშინ S/N-ის გასწვრივ მითითებული კოდი გამოიყენე. ეს წესი მოქმედებს ნებისმიერ შემთხვევაში, როცა ყუთის ფოტოდან სერიული ნომერი გჭირდება — მათ შორის საგარანტიო ბარათის ძებნისას (იხ. ქვემოთ, send_warranty_card).\n'
        + '- თუ პასუხი რამდენიმე პუნქტს შეიცავს (მაგ. რამდენიმე ფილიალი, რამდენიმე ნაბიჯი, რამდენიმე ვარიანტი) — არასდროს ჩაყარო ყველაფერი ერთ წინადადებაში მძიმით/წერტილ-მძიმით გამოყოფილი. სამაგიეროდ დაწერე ცალკე ხაზზე, ხაზის დასაწყისში „- “ (დეფისი და space) ნიშნით, თითოეული პუნქტი ცალკე ხაზზე. ფილიალის მისამართი ყოველთვის ზუსტად ისე ჩაწერე, როგორც ცოდნის ბაზაშია — სიტყვასიტყვით, შემოკლების ან გადაკეთების გარეშე.\n'
        + '- ყველა სხვა შემთხვევაში დააბრუნე escalate:false და დასვი პასუხი reply ველში.\n\n'
        + ((warrantyOn || bookingOn) ? 'დამატებითი შესაძლებლობები — საგარანტიო ბარათის გამოგზავნა და ვიზიტის დაჯავშნა ჩატშივე (action ველი):\n' : '')
        + (bookingOn ? 'დღევანდელი თარიღი: ' + todayStr + ' (YYYY-MM-DD).\n' : '')
        + (bookingOn ? 'ფილიალები (id — დასახელება (მისამართი), სამუშაო საათები):\n' + branchesLines + '\n' : '')
        + (bookingOn ? 'მოწყობილობის ტიპები და თითოეული მათგანის პრობლემის ტიპები ვიზიტისთვის (დასახელებები ზუსტად ისე ჩაწერე, როგორც აქაა; პრობლემა უნდა ეკუთვნოდეს არჩეულ მოწყობილობას):\n' + Object.keys(bookingMap || {}).map(function (dn) { return '- ' + dn + ': ' + (bookingMap[dn] || []).join(', '); }).join('\n') + '\n' : '')
        + (bookingOn ? 'საათების სლოტები: ' + BOOKING_TIME_SLOTS.join(', ') + '.\n\n' : '')
        + (warrantyOn ? '1) საგარანტიო ბარათის გამოგზავნა (action.type = "send_warranty_card"): თუ მომხმარებელი სურს თავისი საგარანტიო ბარათის მიღება ჩატში, სთხოვე მოწყობილობის სერიული ნომერი (თუ ჯერ არ დაწერა და ყუთის ფოტოც არ გამოუგზავნია). თუ მომხმარებელმა ტექსტის მაგივრად ყუთის ფოტო გამოაგზავნა, სერიული ნომერი ამოიღე ზემოთ აღწერილი წესით (IMEI1, ან მხოლოდ S/N რომ იყოს — S/N) და ცალკე აღარ ჰკითხო. როგორც კი სერიული ნომერი გაქვს, დააბრუნე action.type="send_warranty_card" და action.serial ველში ზუსტად ის სერიული ნომერი — ნუ დაელოდები დამატებით დადასტურებას, რადგან ბარათის ძებნა/გაგზავნა თავისთავად უსაფრთხოა (ან იპოვება და გაეგზავნება, ან არა). reply-ში დაწერე მხოლოდ მოკლე გარდამავალი ფრაზა ზუსტად ამ ფორმით: „გთხოვთ, დამელოდოთ, გადავამოწმებ საგარანტიო ნომერს.“ — არასდროს დაწერო, რომ ბარათი უკვე გამოგზავნილია ან ვერ მოიძებნა, რადგან ამას რეალური შედეგის მიხედვით ცალკე შეტყობინება დაადასტურებს.\n' : '')
        + (bookingOn ? '2) ვიზიტის დაჯავშნა (action.type = "book_visit"): საჭირო ოთხივე დეტალი შეაგროვე საუბრის განმავლობაში — ფილიალი (ზემოთ ჩამოთვლილთაგან), მოწყობილობის ტიპი, პრობლემის ტიპი და სასურველი თარიღი+საათი (ზემოთ ჩამოთვლილი სლოტებიდან). სახელი და ტელეფონი არ გჭირდება კითხვა — სისტემამ უკვე იცის ვინ ესაუბრება. სანამ ეს ოთხივე არ გაქვს, action.type="none" და reply-ში ჰკითხე ნაკლული დეტალი. როცა ოთხივე გაქვს, reply-ში ჩამოუთვალე მომხმარებელს არჩეული დეტალები და ამის შემდეგ სიტყვასიტყვით დაამატე: „გთხოვთ, გადახედოთ ჯავშნის მონაცემებს და დამიდასტუროთ სისწორე, რათა შევძლო ვიზიტის დაგეგმვა.“ (მაგ. „[ფილიალი], [თარიღი] [საათი], [მოწყობილობა] — [პრობლემა]. გთხოვთ, გადახედოთ ჯავშნის მონაცემებს და დამიდასტუროთ სისწორე, რათა შევძლო ვიზიტის დაგეგმვა.“) — არასდროს დასვა კითხვა „ასე გავაგებინო...?“-ის მსგავსი ფორმით. და მხოლოდ იმ ერთ შემდეგ შეტყობინებაში, როცა მომხმარებელი ამაზე პირდაპირ თანხმობას (კი/დიახ/დამიჯავშნე და მისთ.) დაწერს, დააბრუნე action.type="book_visit" შესაბამისი action.branchId (მხოლოდ id, მაგ. "b1"), action.deviceType, action.issue, action.date (YYYY-MM-DD) და action.timeSlot (HH:MM) ველებით — ოთხივე ერთად, ზუსტად ისე როგორც თანხმობის წინ დაწერე. reply-ში ამ დასტურის შეტყობინებაში დაწერე მხოლოდ მოკლე გარდამავალი ფრაზა (მაგ. „ვაგზავნი ჯავშანს...“) — არასდროს დაწერო, რომ ჯავშანი უკვე დადასტურებულია ან სლოტი დაკავებულია, რადგან ამას რეალური შედეგის მიხედვით ცალკე შეტყობინება დაადასტურებს.\n' : '')
        + ((warrantyOn || bookingOn) ? '- ორივე ქმედებისთვის: action-ის გამოყენება (type !== "none") არასდროს ჩაითვალოს ოპერატორთან გადაცემის მიზეზად — დატოვე escalate:false.\n' : '')
        + '- action ველი ყოველთვის დააბრუნე — როცა არც ერთი ზემოთხსენებული ქმედება არ გჭირდება, დააბრუნე {"type":"none"}.\n\n'
        + (!warrantyOn ? '- საგარანტიო ბარათის ჩატში გამოგზავნის ფუნქცია ამჟამად გამორთულია: არასდროს დააბრუნო send_warranty_card. თუ მომხმარებელი ბარათს ითხოვს, ცოდნის ბაზით უპასუხე, ხოლო თუ იქ პასუხი არ არის — escalate:true.\n' : '')
        + (!bookingOn ? '- ჩატში ვიზიტის დაჯავშნის ფუნქცია ამჟამად გამორთულია: არასდროს დააბრუნო book_visit. თუ მომხმარებელი ჯავშანს ითხოვს, ცოდნის ბაზით უპასუხე, ხოლო თუ იქ პასუხი არ არის — escalate:true.\n' : '')
        + 'უპასუხე მხოლოდ JSON ობიექტით, მითითებული სქემის მიხედვით — არაფერი სხვა.'
    }]
  };
  const contents = [];
  (history || []).forEach(function (m) {
    if (m.from === 'customer' && (m.text || m.attachment)) contents.push({ role: 'user', parts: buildGeminiUserParts(m.text, m.attachment) });
    else if (m.from === 'ai' && m.text) contents.push({ role: 'model', parts: [{ text: String(m.text).slice(0, 2000) }] });
  });
  contents.push({ role: 'user', parts: buildGeminiUserParts(userText, attachment) });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 12000);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              escalate: { type: 'boolean' },
              reply: { type: 'string' },
              action: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['none', 'send_warranty_card', 'book_visit'] },
                  serial: { type: 'string' },
                  branchId: { type: 'string' },
                  deviceType: { type: 'string' },
                  issue: { type: 'string' },
                  date: { type: 'string' },
                  timeSlot: { type: 'string' }
                },
                required: ['type']
              }
            },
            required: ['escalate', 'reply', 'action']
          }
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await r.json().catch(function () { return null; });
    if (!r.ok || !data) { console.error('Gemini chat-ai upstream error:', r.status, data); return null; }
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
    if (!text) { console.error('Gemini chat-ai: no candidate text', data.promptFeedback || data); return null; }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return null; }
    const rawAction = (parsed.action && typeof parsed.action === 'object') ? parsed.action : {};
    let actionType = ['send_warranty_card', 'book_visit'].indexOf(rawAction.type) !== -1 ? rawAction.type : 'none';
    if ((actionType === 'send_warranty_card' && !warrantyOn) || (actionType === 'book_visit' && !bookingOn)) actionType = 'none';
    return {
      escalate: !!parsed.escalate,
      reply: String(parsed.reply || '').trim().slice(0, 2000),
      action: {
        type: actionType,
        serial: String(rawAction.serial || '').trim().slice(0, 40),
        branchId: String(rawAction.branchId || '').trim().slice(0, 20),
        deviceType: String(rawAction.deviceType || '').trim().slice(0, 60),
        issue: String(rawAction.issue || '').trim().slice(0, 60),
        date: String(rawAction.date || '').trim().slice(0, 10),
        timeSlot: String(rawAction.timeSlot || '').trim().slice(0, 10)
      }
    };
  } catch (e) {
    console.error('Gemini chat-ai failed:', e.message);
    return null;
  }
}

// Executes the AI chat agent's proposed action (see the action instructions
// inside askChatAi above) against the real warranty/booking systems and
// returns the single deterministic follow-up chat message to append — never
// trusts the model's own wording for the outcome, since it can't know in
// advance whether a serial exists or a time slot is still free (the model
// is told as much, and keeps its own `reply` to a short "checking..."
// line). Returns null for action.type "none".
// chat: the live chat record, which already carries the OTP-verified
// name/phone from the chat gate (see the 'join' handler in /ws/chat below)
// — booking never needs to ask the customer for those again, and a
// warranty-card lookup can trust it as the "this is really you" check
// instead of running a second OTP step inside the chat.
async function performChatAiAction(db, chat, action) {
  if (!action || action.type === 'none') return null;

  if (action.type === 'send_warranty_card') {
    const serial = String(action.serial || '').trim().toUpperCase();
    if (!serial) {
      return { from: 'ai', text: 'სერიული ნომერი ვერ ამოვიცანი — გთხოვთ, დამისახელოთ ზუსტად.', at: Date.now() };
    }
    const rec = (db['content/warranty'] || {})[serial];
    if (!rec) {
      return { from: 'ai', text: 'სერიული ნომრით „' + serial + '" საგარანტიო ბარათი ვერ მოიძებნა — გთხოვთ, გადაამოწმოთ ნომერი.', at: Date.now() };
    }
    if (rec.phone && normalizePhone(rec.phone) !== normalizePhone(chat.phone)) {
      return {
        from: 'ai',
        text: 'უსაფრთხოების მიზნით ამ სერიული ნომრის ბარათს ვერ გამოგიგზავნით ამ საუბრიდან — ეს ჩანაწერი დარეგისტრირებულია სხვა ტელეფონის ნომერზე. გთხოვთ, ბარათი გადაამოწმოთ საიტის „საგარანტიოს აღდგენა" გვერდზე თქვენი საკუთარი ნომრით.',
        at: Date.now()
      };
    }
    try {
      const status = warrantyStatus(rec);
      const pdf = await generateWarrantyCardPdf(db, serial, rec, status);
      return {
        from: 'ai',
        text: 'გიგზავნით საგარანტიო ბარათს (' + serial + '):',
        attachment: { name: 'warranty-' + serial + '.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64') },
        at: Date.now()
      };
    } catch (e) {
      console.error('chat action: warranty card generation failed:', e.stack || e.message);
      return { from: 'ai', text: 'ბარათის მომზადებისას შეცდომა მოხდა — სცადეთ ცოტა ხანში, ან მოითხოვეთ ოპერატორის დახმარება.', at: Date.now() };
    }
  }

  if (action.type === 'book_visit') {
    const branches = effectiveBranches(db);
    const bookingMap = enabledBookingMap(db);
    const branch = branches.find(function (b) { return b.id === action.branchId; });
    const validShape = branch
      && Object.prototype.hasOwnProperty.call(bookingMap, action.deviceType)
      && bookingMap[action.deviceType].indexOf(action.issue) !== -1
      && /^\d{4}-\d{2}-\d{2}$/.test(action.date)
      && BOOKING_TIME_SLOTS.indexOf(action.timeSlot) !== -1;
    if (!validShape) {
      return { from: 'ai', text: 'ვერ შევძელი ჯავშნის დეტალების ამოცნობა — გთხოვთ, კიდევ ერთხელ დამისახელოთ ფილიალი, მოწყობილობის ტიპი, პრობლემა და სასურველი თარიღი/საათი.', at: Date.now() };
    }
    if (action.date < new Date().toISOString().slice(0, 10)) {
      return { from: 'ai', text: 'ეს თარიღი უკვე გავიდა — გთხოვთ, აირჩიოთ მომავალი თარიღი.', at: Date.now() };
    }
    const busy = computeBusySlots(db, action.branchId, action.date);
    if (busy.indexOf(action.timeSlot) !== -1) {
      return { from: 'ai', text: branch.name + '-ში ' + action.date + ' ' + action.timeSlot + ' საათზე ადგილი უკვე დაკავებულია — გთხოვთ, აირჩიოთ სხვა საათი.', at: Date.now() };
    }
    try {
      // Pass this same db through so the booking is merged into the exact
      // object the caller (the chat message handler) will writeDb() itself
      // right after — see createBookingRecord's dbToUse comment for why.
      const booking = await createBookingRecord({
        branchId: action.branchId, serviceType: action.issue, date: action.date, timeSlot: action.timeSlot,
        name: chat.name, phone: chat.phone, deviceType: action.deviceType, issue: action.issue, notes: null
      }, db);
      return {
        from: 'ai',
        text: 'ჯავშანი დადასტურებულია ✅\n- ფილიალი: ' + branch.name + ' (' + branch.addr + ')\n- თარიღი/საათი: ' + booking.date + ', ' + booking.timeSlot
          + '\n- მოწყობილობა: ' + booking.deviceType + ' — ' + booking.issue + '\n- დადასტურების კოდი: ' + booking.confirmationCode,
        at: Date.now()
      };
    } catch (e) {
      console.error('chat action: booking creation failed:', e.stack || e.message);
      return { from: 'ai', text: 'ჯავშნის გაფორმებისას შეცდომა მოხდა — სცადეთ ცოტა ხანში, ან მოითხოვეთ ოპერატორის დახმარება.', at: Date.now() };
    }
  }

  return null;
}

// Admin panel: paste one document, get it back auto-split into KB entries
// for staging (not saved here — the admin panel saves via PUT /api/site/chatKb
// once the staff member reviews/edits the split result, same as everywhere
// else in the panel).
app.post('/api/chat-kb/parse-document', requireAuth, async function (req, res) {
  if (!CHAT_AI_CONFIGURED) return res.status(503).json({ error: 'ai_not_configured' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 20000);
  if (!text) return res.status(400).json({ error: 'missing_text' });

  const systemInstruction = {
    parts: [{
      text: 'დაეხმარე ადმინისტრატორს ტექსტური დოკუმენტის საკითხებად (თემებად) დაყოფაში, რომელიც შემდეგ AI ჩატის აგენტის ცოდნის ბაზად იქნება გამოყენებული. დაყავი ტექსტი ლოგიკურ საკითხებად, თითოეულს მიეცი მოკლე სათაური და დეტალური ტექსტი (body). არაფერი გამოიგონო — მხოლოდ მოცემული ტექსტიდან. უპასუხე მხოლოდ JSON ობიექტით, მითითებული სქემის მიხედვით.'
    }]
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 20000);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: text }] }],
        systemInstruction: systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { title: { type: 'string' }, body: { type: 'string' } },
                  required: ['title', 'body']
                }
              }
            },
            required: ['entries']
          }
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await r.json().catch(function () { return null; });
    if (!r.ok || !data) { console.error('chat-kb parse upstream error:', r.status, data); return res.status(502).json({ error: 'ai_upstream_error' }); }
    const cand = data.candidates && data.candidates[0];
    const outText = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
    if (!outText) return res.status(502).json({ error: 'ai_upstream_error' });
    let parsed;
    try { parsed = JSON.parse(outText); } catch (e) { return res.status(502).json({ error: 'ai_bad_response' }); }
    const entries = Array.isArray(parsed.entries) ? parsed.entries.map(function (e) {
      return { title: String(e.title || '').trim().slice(0, 200), body: String(e.body || '').trim().slice(0, 4000) };
    }).filter(function (e) { return e.title || e.body; }) : [];
    res.json({ entries: entries });
  } catch (e) {
    console.error('chat-kb parse failed:', e.message);
    res.status(504).json({ error: 'ai_search_timeout' });
  }
});

// --- Live chat (WebSocket) ------------------------------------------------
// Two upgrade paths on the same HTTP server: /ws/chat for site visitors,
// /ws/admin-chat for staff in the admin panel. A browser WebSocket can't
// send custom headers on the handshake, so the admin side authenticates via
// a ?token= query param instead of the usual Authorization header.
const chatCustomerSockets = new Map(); // chatId -> ws
const chatAdminSockets = new Set();

function chatBroadcastToAdmins(payload, exceptWs) {
  const data = JSON.stringify(payload);
  chatAdminSockets.forEach(function (s) {
    if (s !== exceptWs && s.readyState === WebSocket.OPEN) s.send(data);
  });
}

// Customer-side file/image attachments (widget upload button + Ctrl+V paste)
// arrive as a base64 data URL over the same text-frame channel. Capped well
// under maxPayload below so one oversized attachment can't bloat the DB file.
const CHAT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
function chatAttachmentFromMsg(msg) {
  if (!msg.attachment || typeof msg.attachment !== 'object') return null;
  const dataUrl = String(msg.attachment.dataUrl || '');
  // A recorded voice message's real MIME type (MediaRecorder.mimeType, e.g.
  // "audio/webm;codecs=opus") carries a codec parameter before ";base64,",
  // which this regex used to reject outright — the attachment was silently
  // dropped, so a voice note never made it to the other side. Allow any
  // number of ";key=value" parameters between the type and the payload.
  if (!/^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,/.test(dataUrl)) return null;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (b64.length * 0.75 > CHAT_MAX_ATTACHMENT_BYTES) return null;
  return {
    name: String(msg.attachment.name || 'ფაილი').trim().slice(0, 200),
    type: String(msg.attachment.type || '').slice(0, 100),
    dataUrl: dataUrl
  };
}

// noServer + a manual 'upgrade' router below (rather than each server's own
// {server, path} option) — the query string on /ws/admin-chat?token=... was
// tripping up path matching when attached directly.
const wssChat = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024 * 1024 });
wssChat.on('connection', function (ws) {
  ws.chatId = null;
  ws.on('message', async function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 80);
      const phone = String(msg.phone || '').trim().slice(0, 30);
      if (!name || !phone) { ws.send(JSON.stringify({ type: 'error', error: 'name_phone_required' })); return; }
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        let chat = msg.chatId ? db.chats.find(function (c) { return c.id === msg.chatId; }) : null;
        if (!chat) {
          chat = {
            id: 'ch_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
            name: name, phone: phone, messages: [], status: 'open',
            createdAt: Date.now(), lastAt: Date.now()
          };
          // Admin-configured greeting (content/chat-settings.aiGreeting) goes
          // in as the AI agent's first message on every brand-new chat, so it
          // is visible to the customer immediately and also saved into the
          // chat's own history (admin panel, reloads, reconnects all see it
          // the same way as any other message) — only when the AI agent is
          // actually on and admin bothered to write a greeting.
          const chatSettings = db['content/chat-settings'] || {};
          const greeting = String(chatSettings.aiGreeting || '').trim();
          if (chatSettings.aiEnabled && greeting) {
            chat.messages.push({ from: 'ai', text: greeting, at: Date.now() });
          }
          db.chats.push(chat);
          await writeDb(db);
          chatBroadcastToAdmins({ type: 'chat_new', chat: chat });
        } else {
          chat.name = name; // keep current in case they retyped it on a return visit
          chat.phone = phone;
        }
        ws.chatId = chat.id;
        chatCustomerSockets.set(chat.id, ws);
        ws.send(JSON.stringify({ type: 'joined', chatId: chat.id, messages: chat.messages, status: chat.status, aiPaused: !!chat.aiPaused }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: 'server_error' }));
      }
      return;
    }

    if (msg.type === 'message' && ws.chatId) {
      const text = String(msg.text || '').trim().slice(0, 2000);
      const attachment = chatAttachmentFromMsg(msg);
      if (!text && !attachment) return;
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === ws.chatId; });
        if (!chat) return;
        const m = { from: 'customer', text: text, at: Date.now() };
        if (attachment) m.attachment = attachment;
        chat.messages.push(m);
        chat.lastAt = m.at;
        chat.status = 'open';
        await writeDb(db);
        chatBroadcastToAdmins({
          type: 'message', chatId: chat.id, message: m,
          chatSummary: { id: chat.id, name: chat.name, phone: chat.phone, status: chat.status, lastAt: chat.lastAt }
        });

        // AI-agent auto-reply — only while no human has taken over this chat
        // (chat.aiPaused) and the admin panel's AI toggle is on. Runs after
        // the customer's own message is already saved/broadcast, so a slow
        // or failed Gemini call never delays or breaks message delivery.
        if (!chat.aiPaused) {
          const settings = db['content/chat-settings'] || {};
          if (settings.aiEnabled) {
            // let the widget show a "thinking" indicator for as long as the
            // Gemini call takes — ai_typing_stop always fires (finally), even
            // on failure, so the indicator never gets stuck on the customer's screen
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_typing', chatId: ws.chatId }));
            try {
              const kb = db['content/chat-kb'] || { entries: [] };
              const history = chat.messages.slice(0, -1);
              const aiResult = await askChatAi(kb, history, text, settings.aiName, effectiveBranches(db), attachment, enabledBookingMap(db));
              if (aiResult && aiResult.reply) {
                const db2 = await readDb();
                db2.chats = db2.chats || [];
                const chat2 = db2.chats.find(function (c) { return c.id === ws.chatId; });
                // re-check aiPaused: a human admin may have jumped in while
                // the Gemini call was in flight — the AI must never talk over them
                if (chat2 && !chat2.aiPaused) {
                  const outbox = [];
                  const chatSettings2 = db2['content/chat-settings'] || {};
                  if (aiResult.escalate && !isWithinOperatorHours(chatSettings2)) {
                    // Operators are off the clock right now — never actually
                    // hand off (no one would be there to pick it up) and skip
                    // the model's own reply text, since it was phrased assuming
                    // a live operator is coming. The AI stays in charge of the
                    // chat (aiPaused untouched) and tells the customer plainly
                    // when to come back instead.
                    const offlineText = String(chatSettings2.operatorOfflineMessage || '').trim()
                      || 'ამ ეტაპზე ოპერატორების სამუშაო დრო დასრულებულია. გთხოვთ, ხვალ მოგვმართოთ სამუშაო საათებში ან დაგვიკავშირდეთ ცხელ ხაზზე.';
                    const offlineMsg = { from: 'ai', text: offlineText, at: Date.now() };
                    chat2.messages.push(offlineMsg);
                    chat2.lastAt = offlineMsg.at;
                    outbox.push(offlineMsg);
                  } else {
                    const aiMsg = { from: 'ai', text: aiResult.reply, at: Date.now() };
                    chat2.messages.push(aiMsg);
                    chat2.lastAt = aiMsg.at;
                    outbox.push(aiMsg);
                    if (aiResult.escalate) {
                      chat2.aiPaused = true;
                      // guaranteed, deterministic hand-off notice — never relies on
                      // the model itself having phrased this correctly in aiMsg.text
                      const escMsg = { from: 'system', text: 'გადაგამისამართებთ ოპერატორესთან — გთხოვთ, მოითმინოთ.', at: Date.now() };
                      chat2.messages.push(escMsg);
                      outbox.push(escMsg);
                    }
                  }
                  // Warranty-card / booking action, if the model proposed one —
                  // performChatAiAction actually hits the warranty/booking data
                  // and returns the one deterministic follow-up message to show,
                  // so aiMsg.text above never has to be trusted for the outcome.
                  try {
                    const actionMsg = await performChatAiAction(db2, chat2, aiResult.action);
                    if (actionMsg) {
                      chat2.messages.push(actionMsg);
                      chat2.lastAt = actionMsg.at;
                      outbox.push(actionMsg);
                    }
                  } catch (e) {
                    console.error('chat AI action failed:', e.message);
                  }
                  await writeDb(db2);
                  const custWs = chatCustomerSockets.get(chat2.id);
                  outbox.forEach(function (om) {
                    if (custWs && custWs.readyState === WebSocket.OPEN) custWs.send(JSON.stringify({ type: 'message', message: om, aiPaused: chat2.aiPaused }));
                    chatBroadcastToAdmins({
                      type: 'message', chatId: chat2.id, message: om,
                      chatSummary: { id: chat2.id, name: chat2.name, phone: chat2.phone, status: chat2.status, lastAt: chat2.lastAt, aiPaused: chat2.aiPaused }
                    });
                  });
                }
              }
            } catch (e) {
              console.error('chat AI auto-reply failed:', e.message);
            } finally {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ai_typing_stop', chatId: ws.chatId }));
            }
          }
        }
      } catch (e) { /* drop silently — customer keeps typing, no hard failure surfaced to them */ }
    }

    // customer closed/cleared their side of the conversation (the widget's
    // "clear history" action) — without this, the chat sat untouched in the
    // admin panel looking perfectly normal/open forever, with no sign the
    // customer had actually left it; now it's marked closed, same as when
    // an admin closes it, so the existing "დახურულია" UI picks it up
    if (msg.type === 'customer_close' && ws.chatId) {
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === ws.chatId; });
        if (!chat || chat.status === 'closed') return;
        chat.status = 'closed';
        const sysMsg = { from: 'system', text: 'მომხმარებელმა დახურა საუბარი.', at: Date.now() };
        chat.messages.push(sysMsg);
        chat.lastAt = sysMsg.at;
        await writeDb(db);
        chatBroadcastToAdmins({
          type: 'message', chatId: chat.id, message: sysMsg,
          chatSummary: { id: chat.id, name: chat.name, phone: chat.phone, status: chat.status, lastAt: chat.lastAt, aiPaused: chat.aiPaused, operatorJoined: chat.operatorJoined, assignedOperator: chat.assignedOperator }
        });
      } catch (e) { /* ignore */ }
      return;
    }

    // customer-initiated "return to AI" — lets them leave a human hand-off
    // and go back to the AI agent themselves, without waiting for an admin
    if (msg.type === 'return_to_ai' && ws.chatId) {
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === ws.chatId; });
        if (!chat || !chat.aiPaused) return; // already with the AI, or chat missing — nothing to do
        chat.aiPaused = false;
        chat.operatorJoined = false;
        const sysMsg = { from: 'system', text: 'დაბრუნდით AI აგენტთან.', at: Date.now() };
        chat.messages.push(sysMsg);
        chat.lastAt = sysMsg.at;
        await writeDb(db);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'message', message: sysMsg, aiPaused: false }));
        chatBroadcastToAdmins({
          type: 'message', chatId: chat.id, message: sysMsg,
          chatSummary: { id: chat.id, name: chat.name, phone: chat.phone, status: chat.status, lastAt: chat.lastAt, aiPaused: false, operatorJoined: false, assignedOperator: chat.assignedOperator }
        });
      } catch (e) { /* ignore */ }
    }
  });
  ws.on('close', function () {
    if (ws.chatId && chatCustomerSockets.get(ws.chatId) === ws) chatCustomerSockets.delete(ws.chatId);
  });
});

// Shared by the explicit "Join Conversation" action and by a reply sent
// without joining first (some admins will just type straight away) — marks
// the hand-off exactly once and returns the deterministic system notice to
// broadcast, or null if this chat already has an operator attached.
function markOperatorJoined(chat, operatorName) {
  if (chat.operatorJoined) return null;
  const name = String(operatorName || '').trim().slice(0, 60);
  chat.operatorJoined = true;
  chat.assignedOperator = name || 'ოპერატორი';
  return {
    from: 'system',
    text: (name ? name : 'ოპერატორი') + ' შემოუერთდა საუბარს.',
    at: Date.now()
  };
}

const wssAdminChat = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024 * 1024 });
wssAdminChat.on('connection', function (ws, req) {
  const url = new URL(req.url, 'http://internal');
  const token = url.searchParams.get('token') || '';
  const expiry = tokens.get(token);
  if (!expiry || expiry < Date.now()) { ws.close(4001, 'unauthorized'); return; }
  chatAdminSockets.add(ws);

  ws.on('message', async function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join_chat' && msg.chatId) {
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === msg.chatId; });
        if (!chat) return;
        const sysMsg = markOperatorJoined(chat, msg.operatorName);
        if (!sysMsg) return; // someone already joined — nothing new to announce
        chat.aiPaused = true; // joining always takes the chat off AI auto-reply
        chat.messages.push(sysMsg);
        chat.lastAt = sysMsg.at;
        await writeDb(db);
        const custWs = chatCustomerSockets.get(chat.id);
        if (custWs && custWs.readyState === WebSocket.OPEN) custWs.send(JSON.stringify({ type: 'message', message: sysMsg, aiPaused: chat.aiPaused }));
        const payload = {
          type: 'message', chatId: chat.id, message: sysMsg,
          chatSummary: { id: chat.id, name: chat.name, phone: chat.phone, status: chat.status, lastAt: chat.lastAt, aiPaused: chat.aiPaused, operatorJoined: chat.operatorJoined, assignedOperator: chat.assignedOperator }
        };
        // the joining admin's own tab renders this optimistically (see the
        // "join" button handler client-side), so exclude only that socket
        chatBroadcastToAdmins(payload, ws);
      } catch (e) { /* ignore */ }
      return;
    }

    if (msg.type === 'reply' && msg.chatId) {
      const text = String(msg.text || '').trim().slice(0, 2000);
      const attachment = chatAttachmentFromMsg(msg);
      if (!text && !attachment) return;
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === msg.chatId; });
        if (!chat) return;
        const custWs = chatCustomerSockets.get(chat.id);
        const outbox = [];
        // one-time "operator joined" notice — fires the first time ANY admin
        // replies in this chat without having clicked "Join" first
        const sysMsg = markOperatorJoined(chat, msg.operatorName);
        if (sysMsg) outbox.push(sysMsg);
        const m = { from: 'admin', text: text, at: Date.now() };
        if (attachment) m.attachment = attachment;
        outbox.push(m);
        outbox.forEach(function (om) { chat.messages.push(om); });
        chat.lastAt = m.at;
        chat.aiPaused = true; // a human took over — the AI must never talk over them again in this chat
        await writeDb(db);
        outbox.forEach(function (om) {
          if (custWs && custWs.readyState === WebSocket.OPEN) custWs.send(JSON.stringify({ type: 'message', message: om, aiPaused: chat.aiPaused }));
          const payload = {
            type: 'message', chatId: chat.id, message: om,
            chatSummary: { id: chat.id, name: chat.name, phone: chat.phone, status: chat.status, lastAt: chat.lastAt, aiPaused: chat.aiPaused, operatorJoined: chat.operatorJoined, assignedOperator: chat.assignedOperator }
          };
          // the sending admin's own tab already rendered their own reply
          // optimistically (see sendReply() client-side), so exclude them only
          // for that message — but the "operator joined" system notice was
          // never rendered locally by anyone, so every admin (sender included)
          // must receive it over the socket or their own thread misses it
          chatBroadcastToAdmins(payload, om.from === 'admin' ? ws : null);
        });
      } catch (e) { /* ignore */ }
      return;
    }

    if (msg.type === 'close_chat' && msg.chatId) {
      try {
        const db = await readDb();
        db.chats = db.chats || [];
        const chat = db.chats.find(function (c) { return c.id === msg.chatId; });
        if (!chat) return;
        chat.status = 'closed';
        await writeDb(db);
        chatBroadcastToAdmins({ type: 'chat_status', chatId: chat.id, status: 'closed' }, ws);
      } catch (e) { /* ignore */ }
    }
  });
  ws.on('close', function () { chatAdminSockets.delete(ws); });
});

server.on('upgrade', function (req, socket, head) {
  const pathname = new URL(req.url, 'http://internal').pathname;
  if (pathname === '/ws/chat') {
    wssChat.handleUpgrade(req, socket, head, function (ws) { wssChat.emit('connection', ws, req); });
  } else if (pathname === '/ws/admin-chat') {
    wssAdminChat.handleUpgrade(req, socket, head, function (ws) { wssAdminChat.emit('connection', ws, req); });
  } else {
    socket.destroy();
  }
});

app.get('/api/chats', requireAuth, async function (req, res) {
  try {
    const db = await readDb();
    res.json((db.chats || []).slice().sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); }));
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/health', function (req, res) {
  res.json({ ok: true, time: new Date().toISOString() });
});

server.listen(PORT, function () {
  console.log('technoline.ge content+booking test API running on http://localhost:' + PORT);
  console.log('Admin login: username "' + ADMIN_USERNAME + '", 2FA by SMS ' + (ADMIN_PHONE ? 'ON (' + maskPhone(ADMIN_PHONE) + ')' : 'OFF (set ADMIN_PHONE to enable)'));
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — using the insecure default. Set it in the environment.');
});
