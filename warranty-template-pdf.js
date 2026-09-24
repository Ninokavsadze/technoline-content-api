/**
 * Fills a staff-uploaded warranty card PDF template with a single record's
 * data, at the field positions chosen in the admin panel's drag-and-drop
 * editor (content/warranty-template doc: { pdf, fields }).
 *
 * Position convention: each field's xPct/yPct is a percentage of the PDF
 * page's width/height, measured from the TOP-LEFT corner — this matches
 * how the admin panel measures a drag position over the rendered page
 * image in the browser (top-left origin), so no conversion is needed on
 * that side. pdf-lib's own coordinate system has its origin at the
 * BOTTOM-left, so drawMixed() below converts yPct once, here.
 *
 * Same mixed Georgian/Latin script-splitting approach as warranty-pdf.js
 * (see that file for why: the Georgian-script subset of Noto Sans Georgian
 * has no Latin letters/digits, so a line mixing "TL-227719-GE" with
 * Georgian text needs a font switch per run of same-script characters).
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATHS = {
  geo: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Regular.ttf'),
  lat: path.join(__dirname, 'fonts', 'NotoSansGeorgian-Latin-Regular.ttf')
};

const INK = rgb(0.043, 0.106, 0.169); // #0B1B2B

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

// Field keys the admin panel's drag editor positions, in the order the
// customer table columns were requested: name+surname, serial, model,
// purchase date, warranty end date.
const FIELD_KEYS = ['customerName', 'serial', 'model', 'purchase', 'warrantyEnd'];

/**
 * template: { pdf: 'data:application/pdf;base64,AAAA...', fields: {
 *   customerName: {xPct, yPct, size}, serial: {...}, model: {...},
 *   purchase: {...}, warrantyEnd: {...}
 * } }
 * data: { customerName, serial, model, purchase, warrantyEnd } — plain
 * strings, already formatted for display.
 * Returns Promise<Buffer> with the filled PDF (first page only is used —
 * a multi-page template's later pages are kept as-is, unfilled).
 */
async function fillWarrantyTemplate(template, data) {
  const base64 = String((template && template.pdf) || '').split(',').pop();
  const bytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(bytes);
  pdfDoc.registerFontkit(fontkit);
  const geoFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.geo), { subset: true });
  const latFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.lat), { subset: true });
  const page = pdfDoc.getPages()[0];
  const { width, height } = page.getSize();

  function drawMixed(text, xPct, yPct, size) {
    const x0 = (Number(xPct) || 0) / 100 * width;
    const yTop = (Number(yPct) || 0) / 100 * height;
    const y = height - yTop - size * 0.82; // baseline sits slightly below the chip's drawn top
    let cx = x0;
    splitRuns(text).forEach(function (r) {
      if (!r.t) return;
      const font = r.geo ? geoFont : latFont;
      page.drawText(r.t, { x: cx, y: y, size: size, font: font, color: INK });
      cx += font.widthOfTextAtSize(r.t, size);
    });
  }

  const fields = (template && template.fields) || {};
  FIELD_KEYS.forEach(function (key) {
    const f = fields[key];
    if (!f) return;
    const size = Number(f.size) || 12;
    drawMixed(data[key] != null ? String(data[key]) : '', f.xPct, f.yPct, size);
  });

  return Buffer.from(await pdfDoc.save());
}

module.exports = { fillWarrantyTemplate, FIELD_KEYS };
