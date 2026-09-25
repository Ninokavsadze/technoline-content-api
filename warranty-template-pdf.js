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

// A bare number/date placed on the template doesn't say what it is, so these
// three fields get a short Georgian label printed right before the value.
// customerName and warrantyEnd are left as-is (not requested).
const FIELD_LABELS = {
  serial: 'სერიული ნომერი: ',
  model: 'მოდელი: ',
  purchase: 'გაყიდვის თარიღი: '
};

// Same labels, used as the left column of the table layout (see drawTable) —
// matches the wording the admin panel already shows for these fields.
const TABLE_ROW_LABELS = {
  customerName: 'მომხმარებლის სახელი',
  serial: 'სერიული ნომერი',
  model: 'მოდელი',
  purchase: 'შეძენის თარიღი',
  warrantyEnd: 'გარანტიის ვადა'
};

function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  const n = parseInt(h, 16);
  if (!h || isNaN(n)) return rgb(0.043, 0.106, 0.169);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * template: { pdf: 'data:application/pdf;base64,AAAA...', page: 2, fields: {
 *   customerName: {xPct, yPct, size}, serial: {...}, model: {...},
 *   purchase: {...}, warrantyEnd: {...}
 * } }
 * `page` is the 1-based page number the fields are positioned on (chosen in
 * the admin panel's page-navigation preview); defaults to 1 for older saved
 * templates that predate multi-page support.
 * data: { customerName, serial, model, purchase, warrantyEnd } — plain
 * strings, already formatted for display.
 * Returns Promise<Buffer> with the filled PDF (only the chosen page is
 * filled — the template's other pages are kept as-is, unfilled).
 */
async function fillWarrantyTemplate(template, data) {
  const base64 = String((template && template.pdf) || '').split(',').pop();
  const bytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(bytes);
  pdfDoc.registerFontkit(fontkit);
  const geoFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.geo), { subset: true });
  const latFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATHS.lat), { subset: true });
  const pages = pdfDoc.getPages();
  const pageIndex = Math.min(Math.max((Number(template && template.page) || 1) - 1, 0), pages.length - 1);
  const page = pages[pageIndex];
  const { width, height } = page.getSize();

  function drawMixedAtPx(text, xPx, yTopPx, size, color) {
    const y = height - yTopPx - size * 0.82; // baseline sits slightly below the chip's drawn top
    let cx = xPx;
    splitRuns(text).forEach(function (r) {
      if (!r.t) return;
      const font = r.geo ? geoFont : latFont;
      page.drawText(r.t, { x: cx, y: y, size: size, font: font, color: color || INK });
      cx += font.widthOfTextAtSize(r.t, size);
    });
  }
  function drawMixed(text, xPct, yPct, size) {
    drawMixedAtPx(text, (Number(xPct) || 0) / 100 * width, (Number(yPct) || 0) / 100 * height, size);
  }
  function measureMixed(text, size) {
    let w = 0;
    splitRuns(text).forEach(function (r) {
      if (!r.t) return;
      w += (r.geo ? geoFont : latFont).widthOfTextAtSize(r.t, size);
    });
    return w;
  }

  // Table layout: a single positioned block with a colored header bar and
  // one label/value row per field — replaces dragging five separate chips
  // around the page, which staff found made the printed result look
  // cluttered/unaligned. Takes over whenever a template has a `table`
  // block saved; older templates (or one with `table` cleared) keep using
  // the per-field `fields` positions below for backward compatibility.
  function drawTable(table) {
    const x0 = (Number(table.xPct) || 0) / 100 * width;
    const yTop0 = (Number(table.yPct) || 0) / 100 * height;
    const tw = (Number(table.widthPct) || 55) / 100 * width;
    const fontSize = Number(table.fontSize) || 11;
    const headerH = fontSize * 2.3;
    const rowH = fontSize * 2.1;
    const headerColor = hexToRgb(table.headerColor || '#0E4F8E');
    const headerTextColor = hexToRgb(table.headerTextColor || '#FFFFFF');
    const lineColor = rgb(0.82, 0.85, 0.88);
    const zebraColor = rgb(0.96, 0.97, 0.98);
    const rows = FIELD_KEYS.map(function (key) {
      return [TABLE_ROW_LABELS[key], data[key] != null ? String(data[key]) : ''];
    });
    const bodyH = rows.length * rowH;
    const totalH = headerH + bodyH;

    // Size the label column to the longest label actually being printed,
    // rather than a fixed split — a fixed ratio either clips long labels
    // ("მომხმარებლის სახელი") or wastes space when they're short.
    const longestLabel = Math.max.apply(null, rows.map(function (r) { return measureMixed(r[0], fontSize); }));
    const labelColW = Math.min(Math.max(longestLabel + 16, tw * 0.28), tw * 0.62);

    let headerSize = fontSize + 1;
    const headerTextW = measureMixed(table.title || 'საგარანტიო ინფორმაცია', headerSize);
    if (headerTextW > tw - 16) headerSize = Math.max(7, headerSize * (tw - 16) / headerTextW);
    // Solid white body background FIRST, under everything else — the template
    // page underneath (QR codes, other printed text) must not show through
    // any row, not just the odd/zebra ones, or the table reads as see-through.
    page.drawRectangle({ x: x0, y: height - yTop0 - totalH, width: tw, height: bodyH, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: x0, y: height - yTop0 - headerH, width: tw, height: headerH, color: headerColor });
    drawMixedAtPx(table.title || 'საგარანტიო ინფორმაცია', x0 + 8, yTop0 + (headerH - headerSize) / 2, headerSize, headerTextColor);

    const valueAvailW = tw - labelColW - 16;
    rows.forEach(function (row, i) {
      const rowTop = yTop0 + headerH + i * rowH;
      if (i % 2 === 1) page.drawRectangle({ x: x0, y: height - rowTop - rowH, width: tw, height: rowH, color: zebraColor });
      drawMixedAtPx(row[0], x0 + 8, rowTop + (rowH - fontSize) / 2, fontSize, INK);
      let valueSize = fontSize;
      const valueW = measureMixed(row[1], valueSize);
      if (valueW > valueAvailW && valueW > 0) valueSize = Math.max(7, fontSize * valueAvailW / valueW);
      drawMixedAtPx(row[1], x0 + labelColW + 8, rowTop + (rowH - valueSize) / 2, valueSize, INK);
      if (i < rows.length - 1) {
        page.drawLine({ start: { x: x0, y: height - rowTop - rowH }, end: { x: x0 + tw, y: height - rowTop - rowH }, thickness: 0.75, color: lineColor });
      }
    });

    page.drawLine({ start: { x: x0 + labelColW, y: height - yTop0 - headerH }, end: { x: x0 + labelColW, y: height - yTop0 - totalH }, thickness: 0.75, color: lineColor });
    page.drawRectangle({ x: x0, y: height - yTop0 - totalH, width: tw, height: totalH, borderColor: lineColor, borderWidth: 1 });
  }

  if (template && template.table) {
    drawTable(template.table);
  } else {
    const fields = (template && template.fields) || {};
    FIELD_KEYS.forEach(function (key) {
      const f = fields[key];
      if (!f) return;
      const size = Number(f.size) || 12;
      const label = FIELD_LABELS[key] || '';
      const value = data[key] != null ? String(data[key]) : '';
      drawMixed(label + value, f.xPct, f.yPct, size);
    });
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Used by the admin panel's field-position editor: returns page count plus
 * a standalone single-page PDF (as a data URL) for just the requested page,
 * so the editor can show exactly one page — at its real dimensions — with
 * no other pages to scroll into, and place field chips against it with an
 * unambiguous percent-of-THIS-page meaning (matching how fillWarrantyTemplate
 * above reads xPct/yPct once a template is saved).
 * pdfDataUrl: 'data:application/pdf;base64,...'; pageNum: 1-based.
 */
async function extractTemplatePage(pdfDataUrl, pageNum) {
  const base64 = String(pdfDataUrl || '').split(',').pop();
  const bytes = Buffer.from(base64, 'base64');
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageCount();
  const index = Math.min(Math.max((Number(pageNum) || 1) - 1, 0), pageCount - 1);
  const outDoc = await PDFDocument.create();
  const [copied] = await outDoc.copyPages(srcDoc, [index]);
  outDoc.addPage(copied);
  const { width, height } = copied.getSize();
  const outBytes = await outDoc.save();
  return {
    pageCount: pageCount,
    page: index + 1,
    width: width,
    height: height,
    pdf: 'data:application/pdf;base64,' + Buffer.from(outBytes).toString('base64')
  };
}

module.exports = { fillWarrantyTemplate, FIELD_KEYS, extractTemplatePage };
