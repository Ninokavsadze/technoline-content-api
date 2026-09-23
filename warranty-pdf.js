/**
 * Generates the "საგარანტიო ბარათი" (warranty card) PDF for a single
 * warranty record. Kept in its own file since it needs a small
 * Georgian/Latin mixed-script text helper that would otherwise clutter
 * server.js.
 *
 * Why two font files per weight: the Georgian-script subset of Noto Sans
 * Georgian does not include Latin letters/digits/punctuation (dates,
 * serial numbers, "TL-..."), so mixed lines are rendered by switching
 * fonts per run of same-script characters. Fonts are plain TTF (not
 * WOFF) because pdfkit 0.15's WOFF font-switching had a bug that made
 * the second-used font render as tofu boxes — 0.20+ fixes it, but TTF
 * was already converted and works either way.
 */
const PDFDocument = require('pdfkit');
const path = require('path');

const FONTS = {
  geoRegular: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Regular.ttf'),
  geoBold: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Bold.ttf'),
  latRegular: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Latin-Regular.ttf'),
  latBold: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Latin-Bold.ttf')
};

function isGeorgian(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x10A0 && c <= 0x10FF;
}

function splitRuns(text) {
  const runs = [];
  let cur = '', curGeo = null;
  for (const ch of String(text)) {
    const g = isGeorgian(ch);
    if (curGeo === null) curGeo = g;
    if (g !== curGeo) { runs.push({ t: cur, geo: curGeo }); cur = ''; curGeo = g; }
    cur += ch;
  }
  if (cur) runs.push({ t: cur, geo: curGeo });
  return runs;
}

// Draws one line of possibly-mixed Georgian/Latin text at (x, y), switching
// fonts per run. Returns the x position right after the last character.
function mixedLine(doc, text, x, y, opts) {
  opts = opts || {};
  const bold = !!opts.bold;
  const fontGeo = bold ? 'geo-b' : 'geo-r';
  const fontLat = bold ? 'lat-b' : 'lat-r';
  doc.fillColor(opts.color || '#0B1B2B').fontSize(opts.size || 11);
  let cx = x;
  splitRuns(text).forEach(function (r) {
    doc.font(r.geo ? fontGeo : fontLat);
    doc.text(r.t, cx, y, { lineBreak: false });
    cx += doc.widthOfString(r.t);
  });
  return cx;
}

function registerFonts(doc) {
  doc.registerFont('geo-r', FONTS.geoRegular);
  doc.registerFont('geo-b', FONTS.geoBold);
  doc.registerFont('lat-r', FONTS.latRegular);
  doc.registerFont('lat-b', FONTS.latBold);
}

/**
 * record: { device, cat, purchase, end, serial, active, remainingLabel }
 * Returns a Promise<Buffer> with the finished PDF.
 */
function buildWarrantyCardPdf(record) {
  return new Promise(function (resolve, reject) {
    try {
      const W = 420, H = 595; // ~A5
      const doc = new PDFDocument({ size: [W, H], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
      const chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      doc.on('error', reject);

      registerFonts(doc);

      const BLUE = '#0A3A69', BLUE_DEEP = '#082B4E', GOLD = '#FCBB2D';
      const GREEN = '#237A4C', RED = '#B14526', INK = '#0B1B2B', SOFT = '#4A5A6C';

      // top band
      doc.rect(0, 0, W, 128).fill(BLUE_DEEP);
      doc.rect(0, 0, W, 128).fillOpacity(1);
      // brand mark: simple ring, echoes the site logo without needing SVG import
      doc.save();
      doc.lineWidth(2.6).strokeColor(BLUE.replace(BLUE, '#5FA0DC'));
      doc.circle(46, 46, 20).stroke();
      doc.circle(46, 46, 13).stroke();
      doc.restore();
      doc.save();
      doc.lineWidth(3).strokeColor(GOLD).lineCap('round');
      doc.moveTo(46, 38).lineTo(46, 46).stroke();
      doc.restore();

      mixedLine(doc, 'ტექნოლაინი', 78, 30, { bold: true, size: 16, color: '#ffffff' });
      mixedLine(doc, 'TECHNOLINE SERVICE', 78, 50, { size: 8, color: '#9CB4CC' });
      mixedLine(doc, 'საგარანტიო ბარათი', 30, 84, { bold: true, size: 20, color: GOLD });

      let y = 156;
      mixedLine(doc, record.cat || '', 30, y, { size: 9, color: SOFT });
      y += 16;
      mixedLine(doc, record.device || '', 30, y, { bold: true, size: 16, color: INK });
      y += 34;

      // status pill (drawn as a simple rounded box)
      const active = !!record.active;
      const pillLabel = active ? 'გარანტია აქტიურია' : 'გარანტია ამოწურულია';
      const pillColor = active ? GREEN : RED;
      doc.roundedRect(30, y, 220, 24, 12).fillOpacity(0.12).fill(pillColor).fillOpacity(1);
      mixedLine(doc, pillLabel, 44, y + 6, { bold: true, size: 10, color: pillColor });
      y += 48;

      function row(label, value) {
        mixedLine(doc, label, 30, y, { size: 8.5, color: SOFT });
        mixedLine(doc, value, 30, y + 14, { bold: true, size: 12, color: INK });
        y += 46;
      }
      row('სერიული ნომერი', record.serial || '—');
      row('შეძენის თარიღი', record.purchase || '—');
      row('გარანტიის ვადა', record.end || '—');
      row(active ? 'დარჩენილი დღეები' : 'ვადა გავიდა', record.remainingLabel || '—');

      // divider
      doc.moveTo(30, y + 6).lineTo(W - 30, y + 6).strokeColor('#E1E7EF').lineWidth(1).stroke();
      y += 24;
      mixedLine(doc, 'გარანტია ვრცელდება შეცვლილ ნაწილსა და შესრულებულ სამუშაოზე.', 30, y, { size: 8.5, color: SOFT });
      y += 14;
      mixedLine(doc, 'დაზუსტებისთვის მიმართეთ უახლოეს ფილიალს.', 30, y, { size: 8.5, color: SOFT });

      // footer
      doc.rect(0, H - 46, W, 46).fill('#F4F7FB');
      mixedLine(doc, 'technoline.ge', 30, H - 30, { bold: true, size: 9, color: BLUE });
      const genLabel = 'გენერირებულია: ' + record.generatedAt;
      const genWidth = (function () {
        // rough width estimate using the same mixed-run logic without drawing
        let w = 0;
        splitRuns(genLabel).forEach(function (r) {
          doc.font(r.geo ? 'geo-r' : 'lat-r').fontSize(8);
          w += doc.widthOfString(r.t);
        });
        return w;
      })();
      mixedLine(doc, genLabel, W - 30 - genWidth, H - 30, { size: 8, color: '#7C8CA0' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildWarrantyCardPdf };
