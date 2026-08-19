/*
 * pdfOps.js — all PDF read/write logic, isolated from any UI.
 *
 * Every function takes `PDFLib` as its first argument (dependency injection)
 * so the exact same code runs in two places:
 *   - the Electron renderer, where PDFLib is a global from pdf-lib.min.js
 *   - Node (the test harness), where PDFLib = require('pdf-lib')
 *
 * Coordinate convention for stamping (text/highlight/image):
 * coordinates are in PDF user space — origin bottom-left, y grows upward,
 * units are points (1/72"). The renderer converts screen -> PDF space before
 * calling these. Keeping the conversion out of here makes this file testable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfOps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toBytes(input) {
    // Accept Uint8Array, ArrayBuffer, or Node Buffer; return Uint8Array.
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return new Uint8Array(input);
    throw new Error('Unsupported byte input type');
  }

  async function load(PDFLib, bytes) {
    return PDFLib.PDFDocument.load(toBytes(bytes), { ignoreEncryption: true });
  }

  // ---- Page sizes (for the renderer to lay out overlays) --------------------
  async function getPageSizes(PDFLib, bytes) {
    const doc = await load(PDFLib, bytes);
    return doc.getPages().map((p, i) => {
      const { width, height } = p.getSize();
      return { index: i, width, height, rotation: p.getRotation().angle };
    });
  }

  // ---- Merge: concatenate several PDFs in the given order --------------------
  async function mergePdfs(PDFLib, listOfBytes) {
    const out = await PDFLib.PDFDocument.create();
    for (const bytes of listOfBytes) {
      const src = await load(PDFLib, await normalizeToPdf(PDFLib, bytes));
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    return out.save();
  }

  // ---- Images as pages -------------------------------------------------------
  // Merge/insert accept PNG/JPG files alongside PDFs: an image becomes one A4
  // page (landscape if the image is wider than tall), fitted and centred.
  function sniffKind(bytes) {
    const b = toBytes(bytes);
    if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    return 'unknown';
  }
  async function wrapImageAsPdf(PDFLib, bytes) {
    const doc = await PDFLib.PDFDocument.create();
    const img = await embedImage(doc, bytes);
    const A4 = [595.28, 841.89];
    const landscape = img.width > img.height;
    const pw = landscape ? A4[1] : A4[0], ph = landscape ? A4[0] : A4[1];
    const margin = 24;
    const k = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
    const w = img.width * k, h = img.height * k;
    doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    return doc.save();
  }
  // Anything merge/insert receives goes through here. Unknown kinds fall
  // through to the PDF parser untouched — some real PDFs hide %PDF behind a few
  // junk bytes, and pdf-lib copes with that where a strict sniff would not.
  async function normalizeToPdf(PDFLib, bytes) {
    const kind = sniffKind(bytes);
    if (kind === 'png' || kind === 'jpg') return wrapImageAsPdf(PDFLib, bytes);
    return toBytes(bytes);
  }

  // ---- Build a new document from an explicit ordered list of page indices ----
  // Powers split (subset), reorder (permutation), and delete (omission).
  async function buildFromOrder(PDFLib, bytes, orderIndices) {
    const src = await load(PDFLib, bytes);
    const total = src.getPageCount();
    for (const i of orderIndices) {
      if (!Number.isInteger(i) || i < 0 || i >= total) {
        throw new Error(`Page index out of range: ${i} (document has ${total} pages)`);
      }
    }
    const out = await PDFLib.PDFDocument.create();
    const copied = await out.copyPages(src, orderIndices);
    copied.forEach((p) => out.addPage(p));
    return out.save();
  }

  function splitPdf(PDFLib, bytes, pageIndices) {
    return buildFromOrder(PDFLib, bytes, pageIndices);
  }
  function reorderPages(PDFLib, bytes, newOrder) {
    return buildFromOrder(PDFLib, bytes, newOrder);
  }
  async function deletePages(PDFLib, bytes, removeSet) {
    const remove = new Set(removeSet);
    const doc = await load(PDFLib, bytes);
    const keep = [];
    for (let i = 0; i < doc.getPageCount(); i++) if (!remove.has(i)) keep.push(i);
    if (keep.length === 0) throw new Error('Refusing to delete every page');
    return buildFromOrder(PDFLib, bytes, keep);
  }

  // ---- Rotate pages by a multiple of 90 degrees -----------------------------
  // The delta is signed and relative to whatever rotation the page already
  // carries, so repeated quarter-turns accumulate the way a reader expects.
  async function rotatePages(PDFLib, bytes, pageIndices, deltaDegrees) {
    const doc = await load(PDFLib, bytes);
    const total = doc.getPageCount();
    const seen = new Set();
    for (const i of pageIndices) {
      if (!Number.isInteger(i) || i < 0 || i >= total) {
        throw new Error(`Page index out of range: ${i} (document has ${total} pages)`);
      }
      if (seen.has(i)) continue; // a repeated index must not turn twice
      seen.add(i);
      const page = doc.getPage(i);
      let next = (page.getRotation().angle + deltaDegrees) % 360;
      if (next < 0) next += 360;
      page.setRotation(PDFLib.degrees(next));
    }
    return doc.save();
  }
  function rotatePage(PDFLib, bytes, pageIndex, deltaDegrees) {
    return rotatePages(PDFLib, bytes, [pageIndex], deltaDegrees);
  }

  // ---- Forms ----------------------------------------------------------------
  function fieldType(PDFLib, field) {
    // Prefer instanceof: it survives minification, whereas constructor.name is
    // mangled in the bundled (vendored) pdf-lib build — which would otherwise
    // make every field read as 'unknown' in the packaged app.
    if (PDFLib) {
      if (PDFLib.PDFTextField && field instanceof PDFLib.PDFTextField) return 'text';
      if (PDFLib.PDFCheckBox && field instanceof PDFLib.PDFCheckBox) return 'checkbox';
      if (PDFLib.PDFDropdown && field instanceof PDFLib.PDFDropdown) return 'dropdown';
      if (PDFLib.PDFOptionList && field instanceof PDFLib.PDFOptionList) return 'optionlist';
      if (PDFLib.PDFRadioGroup && field instanceof PDFLib.PDFRadioGroup) return 'radio';
      if (PDFLib.PDFButton && field instanceof PDFLib.PDFButton) return 'button';
      if (PDFLib.PDFSignature && field instanceof PDFLib.PDFSignature) return 'signature';
    }
    // Fallback for the unminified module (e.g. the Node test environment).
    const n = field.constructor && field.constructor.name;
    switch (n) {
      case 'PDFTextField': return 'text';
      case 'PDFCheckBox': return 'checkbox';
      case 'PDFDropdown': return 'dropdown';
      case 'PDFOptionList': return 'optionlist';
      case 'PDFRadioGroup': return 'radio';
      case 'PDFButton': return 'button';
      case 'PDFSignature': return 'signature';
      default: return 'unknown';
    }
  }

  async function getFormFields(PDFLib, bytes) {
    const doc = await load(PDFLib, bytes);
    let form;
    try { form = doc.getForm(); } catch (e) { return []; }
    return form.getFields().map((f) => {
      const type = fieldType(PDFLib, f);
      const info = { name: f.getName(), type };
      try {
        if (type === 'text') info.value = f.getText() || '';
        else if (type === 'checkbox') info.value = f.isChecked();
        else if (type === 'dropdown' || type === 'optionlist') {
          info.options = f.getOptions();
          const sel = f.getSelected();
          info.value = sel && sel.length ? sel[0] : '';
        } else if (type === 'radio') {
          info.options = f.getOptions();
          info.value = f.getSelected() || '';
        }
      } catch (e) { /* some fields refuse to report; leave value undefined */ }
      return info;
    });
  }

  // values: { fieldName: stringOrBool }
  async function fillForm(PDFLib, bytes, values, flatten) {
    const doc = await load(PDFLib, bytes);
    const form = doc.getForm();
    for (const [name, val] of Object.entries(values)) {
      let field;
      try { field = form.getField(name); } catch (e) { continue; }
      const type = fieldType(PDFLib, field);
      try {
        if (type === 'text') field.setText(String(val ?? ''));
        else if (type === 'checkbox') (val ? field.check() : field.uncheck());
        else if (type === 'dropdown') field.select(String(val));
        else if (type === 'optionlist') field.select(String(val));
        else if (type === 'radio') field.select(String(val));
      } catch (e) { /* skip a field that won't accept the value */ }
    }
    if (flatten) form.flatten();
    return doc.save();
  }

  // ---- Stamping: text, highlights, images (signatures) ----------------------
  // All three take items already expressed in PDF user space.

  function rgb(PDFLib, hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
    const n = m ? parseInt(m[1], 16) : 0;
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  // ---- Unicode / RTL text helpers -------------------------------------------
  // Helvetica (a PDF base-14 font) only encodes WinAnsi (Latin-1-ish) — Hebrew
  // and other scripts throw "WinAnsi cannot encode". Such text needs a bundled
  // Unicode font embedded via fontkit (opts below).
  const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFB4F\uFE70-\uFEFF]/;
  // Line breaks and tabs are structure, not glyphs — they never force a font
  // swap, so strip them before deciding whether the text is beyond WinAnsi.
  function needsUnicodeFont(s) { return /[^\u0020-\u00FF]/.test(String(s == null ? '' : s).replace(/[\r\n\t]/g, '')); }

  // Bidi for drawing RTL text. Key fact: pdf-lib + fontkit already lay a single
  // Hebrew/Arabic run out right-to-left correctly on their own. So we must NOT
  // pre-reverse the characters (that double-reverses and the text comes out
  // backwards). Instead we split the LOGICAL string into maximal same-direction
  // runs, lay the runs out right-to-left (first logical run = rightmost), and
  // draw each run separately in logical order \u2014 letting fontkit shape each run.
  // Numbers/Latin runs then stay readable (e.g. "40", "09/07/2026", "1,500")
  // and brackets are mirrored inside RTL runs.
  const BIDI_MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
  function charDir(ch) {
    const p = ch.codePointAt(0);
    if ((p >= 0x0590 && p <= 0x05FF) || (p >= 0x0600 && p <= 0x06FF) ||
        (p >= 0xFB1D && p <= 0xFB4F) || (p >= 0xFE70 && p <= 0xFEFF)) return 'R';
    if ((p >= 0x30 && p <= 0x39) || (p >= 0x41 && p <= 0x5A) ||
        (p >= 0x61 && p <= 0x7A) || p === 0x20AA) return 'L';
    return 'N'; // neutral: resolves to its neighbours, else the base direction
  }
  // Returns runs [{ dir: 'R'|'L', s }] in LOGICAL order; base direction RTL.
  function bidiRuns(text) {
    const chars = Array.from(text);
    const cls = chars.map(charDir);
    for (let i = 0; i < cls.length; i++) {
      if (cls[i] !== 'N') continue;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) if (cls[j] !== 'N') { prev = cls[j]; break; }
      for (let j = i + 1; j < cls.length; j++) if (cls[j] !== 'N') { next = cls[j]; break; }
      cls[i] = (prev && next && prev === next) ? prev : 'R';
    }
    const out = []; let cur = null;
    chars.forEach((ch, i) => {
      if (!cur || cur.dir !== cls[i]) { cur = { dir: cls[i], s: '' }; out.push(cur); }
      cur.s += ch;
    });
    return out;
  }
  // A page's own /Rotate, as a counter-clockwise angle in user space. Stamping
  // code adds this so overlays face the reader rather than the raw page axes.
  function pageSpin(page) {
    let r = page.getRotation().angle % 360;
    if (r < 0) r += 360;
    return r;
  }

  // ---- Text blocks ----------------------------------------------------------
  // A text item is a BLOCK, not a single line. Its anchor is the block's
  // top-left corner, at (x, y + size) — chosen so that a single unrotated line
  // still puts its baseline exactly on `y`, which is the original contract.
  // Everything else (extra lines, alignment, rotation) is measured from there.
  const DEFAULT_LINE_HEIGHT = 1.25;
  // Synthetic oblique, for faces with no italic cut of their own. It is pdf-lib's
  // ySkew that shears the glyphs while leaving the baseline flat — xSkew tilts
  // the baseline itself, which reads as a crooked line rather than as italic.
  const ITALIC_SKEW = 12;         // degrees
  const FAUX_BOLD = 0.03;         // pen offset as a fraction of the font size
  const FAUX_BOLD_PASSES = [[0, 0], [1, 0], [0.5, 0.45]];

  function splitLines(s) { return String(s ?? '').replace(/\r\n?/g, '\n').split('\n'); }
  function measure(font, s, size) {
    // A glyph the face cannot encode throws; a zero advance beats losing the draw.
    try { return font.widthOfTextAtSize(s, size); } catch (e) { return 0; }
  }
  // Horizontal offset of one line inside the block. 'auto' follows the script.
  function alignShift(align, blockWidth, lineWidth, rtl) {
    const a = (!align || align === 'auto') ? (rtl ? 'right' : 'left') : align;
    if (a === 'center') return (blockWidth - lineWidth) / 2;
    if (a === 'right') return blockWidth - lineWidth;
    return 0;
  }
  // Split one line into the pieces to draw, left to right. RTL lines are laid
  // out run-by-run (see bidiRuns); everything else is a single piece.
  function linePieces(line, rtl) {
    if (!rtl) return [line];
    return bidiRuns(line).reverse().map((r) => (r.dir === 'R'
      ? Array.from(r.s).map((ch) => BIDI_MIRROR[ch] || ch).join('')
      : r.s));
  }
  // Draw one text block. `faux` asks for synthetic bold/italic, needed only when
  // the face has no real bold/italic cut of its own (the bundled Hebrew font).
  // Rotation and the non-uniform stretch (scaleX / scaleY, from the mid-edge
  // handles) are applied as one transformation matrix about the block's
  // top-left anchor, so glyphs genuinely widen or tallen rather than reflow.
  function drawTextBlock(PDFLib, page, it, size, font, color, faux) {
    const raw = String(it.text ?? '');
    const rtl = RTL_RE.test(raw);
    const rot = Number(it.rot) || 0;
    const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const sx = Number(it.scaleX) || 1, sy = Number(it.scaleY) || 1;
    const lh = (Number(it.lineHeight) || DEFAULT_LINE_HEIGHT) * size;
    const opacity = it.opacity == null ? 1 : Math.max(0, Math.min(1, Number(it.opacity)));
    const skew = (faux && faux.italic) ? ITALIC_SKEW : 0;
    const boldPen = (faux && faux.bold) ? size * FAUX_BOLD : 0;
    const lines = splitLines(raw);
    const widths = lines.map((l) => measure(font, l, size));
    const blockWidth = widths.reduce((m, w) => Math.max(m, w), 0);
    const ax = it.x, ay = it.y + size; // block top-left = the transform's pivot
    // (ox, oy) is an offset inside the block's own upright frame, y growing up.
    const useMatrix = rot !== 0 || sx !== 1 || sy !== 1;
    let emit;
    if (useMatrix) {
      // cm = T(anchor) · R(rot) · S(sx, sy): local offsets in, page space out.
      page.pushOperators(
        PDFLib.pushGraphicsState(),
        PDFLib.concatTransformationMatrix(cos * sx, sin * sx, -sin * sy, cos * sy, ax, ay)
      );
      emit = (s, ox, oy) => page.drawText(s, { x: ox, y: oy, size, font, color, opacity, ySkew: PDFLib.degrees(skew) });
    } else {
      emit = (s, ox, oy) => page.drawText(s, { x: ax + ox, y: ay + oy, size, font, color, opacity, ySkew: PDFLib.degrees(skew) });
    }
    lines.forEach((line, i) => {
      let ox = alignShift(it.align, blockWidth, widths[i], rtl);
      const oy = -(size + i * lh);
      for (const piece of linePieces(line, rtl)) {
        if (piece) {
          if (boldPen) for (const [bx, by] of FAUX_BOLD_PASSES) emit(piece, ox + bx * boldPen, oy - by * boldPen);
          else emit(piece, ox, oy);
        }
        ox += measure(font, piece, size);
      }
    });
    if (useMatrix) page.pushOperators(PDFLib.popGraphicsState());
  }

  // items: [{ page, x, y, text, size, color, rot, align, lineHeight, opacity,
  //           bold, italic, scaleX, scaleY }] — PDF space, y is the first
  // line's baseline; scaleX/scaleY stretch the glyphs about the anchor.
  // `text` may contain newlines. rot is degrees counter-clockwise about the
  // block's top-left corner. align is 'auto' | 'left' | 'center' | 'right'.
  // opts (optional): { fontkit, fontBytes } — a fontkit instance plus TTF bytes
  // for a Unicode font; required when any item contains non-WinAnsi characters.
  async function stampText(PDFLib, bytes, items, opts) {
    const doc = await load(PDFLib, bytes);
    let uniFont = null;
    const std = {};
    const standard = async (name) => {
      if (!std[name]) std[name] = await doc.embedFont(PDFLib.StandardFonts[name]);
      return std[name];
    };
    const wantsUnicode = items.some((it) => needsUnicodeFont(String(it.text ?? '')));
    if (wantsUnicode) {
      if (!opts || !opts.fontkit || !opts.fontBytes) {
        throw new Error('This text needs the bundled Unicode font (Hebrew or other non-Latin characters), but it was not provided');
      }
      doc.registerFontkit(opts.fontkit);
      uniFont = await doc.embedFont(opts.fontBytes, { subset: true });
    }
    for (const it of items) {
      const page = doc.getPage(it.page);
      const size = it.size || 14;
      const color = rgb(PDFLib, it.color || '#111111');
      let font, faux;
      if (needsUnicodeFont(String(it.text ?? ''))) {
        // We bundle a single Rubik cut, so bold/italic have to be synthesised.
        font = uniFont;
        faux = { bold: !!it.bold, italic: !!it.italic };
      } else {
        // Latin gets the real Helvetica cuts — far cleaner than faking them.
        font = await standard(it.bold && it.italic ? 'HelveticaBoldOblique'
          : it.bold ? 'HelveticaBold'
            : it.italic ? 'HelveticaOblique' : 'Helvetica');
        faux = null;
      }
      // A page carrying a /Rotate is shown turned, and anything drawn in its
      // user space turns with it. Adding that angle back in keeps stamped text
      // upright for the reader — where the on-screen editor put it.
      const spun = pageSpin(page) ? Object.assign({}, it, { rot: (Number(it.rot) || 0) + pageSpin(page) }) : it;
      drawTextBlock(PDFLib, page, spun, size, font, color, faux);
    }
    return doc.save();
  }

  // rects: [{ page, x, y, width, height, color, opacity }]
  async function stampHighlights(PDFLib, bytes, rects) {
    const doc = await load(PDFLib, bytes);
    for (const r of rects) {
      const page = doc.getPage(r.page);
      page.drawRectangle({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        color: rgb(PDFLib, r.color || '#ffd54a'),
        opacity: r.opacity == null ? 0.4 : r.opacity,
      });
    }
    return doc.save();
  }

  // pens: [{ page, points:[{x,y}...], color, width }]  freehand / ink
  async function stampInk(PDFLib, bytes, pens) {
    const doc = await load(PDFLib, bytes);
    for (const pen of pens) {
      const page = doc.getPage(pen.page);
      const pts = pen.points || [];
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: pts[i - 1].x, y: pts[i - 1].y },
          end: { x: pts[i].x, y: pts[i].y },
          thickness: pen.width || 2,
          color: rgb(PDFLib, pen.color || '#d62828'),
        });
      }
    }
    return doc.save();
  }

  // Embed a PNG or JPG, detecting the format from its magic bytes.
  async function embedImage(doc, bytes) {
    let b = toBytes(bytes);
    // pdf-lib's JPEG parser reads `imageData.buffer` from offset 0. A Uint8Array
    // that is a view into a larger buffer (e.g. a pooled Node Buffer, or a
    // subarray) has a non-zero byteOffset and would be misread. Force a tight,
    // offset-0 copy when needed. NOTE: Node's Buffer.slice() returns a *view*,
    // not a copy, so we use `new Uint8Array(b)` which always copies to offset 0.
    if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) b = new Uint8Array(b);
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (isPng) return doc.embedPng(b);
    if (isJpg) return doc.embedJpg(b);
    // Unknown header — try PNG, then JPG, before giving up.
    try { return await doc.embedPng(b); }
    catch (e) { return doc.embedJpg(b); }
  }

  // images: [{ page, x, y, width, height, bytes | pngBytes }]
  // Used for both drawn signatures (PNG) and inserted JPG/PNG pictures.
  async function stampImages(PDFLib, bytes, images) {
    const doc = await load(PDFLib, bytes);
    for (const im of images) {
      const img = await embedImage(doc, im.bytes || im.pngBytes);
      const page = doc.getPage(im.page);
      const spin = pageSpin(page);
      if (!spin) {
        page.drawImage(img, { x: im.x, y: im.y, width: im.width, height: im.height });
        continue;
      }
      // Turn the picture about the centre of its rectangle so it faces the
      // reader. At a quarter turn the drawn width and height swap, since the
      // rectangle is expressed in the page's own (unturned) axes.
      const rad = spin * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad);
      const cx = im.x + im.width / 2, cy = im.y + im.height / 2;
      const quarter = spin === 90 || spin === 270;
      const dw = quarter ? im.height : im.width;
      const dh = quarter ? im.width : im.height;
      page.pushOperators(
        PDFLib.pushGraphicsState(),
        PDFLib.concatTransformationMatrix(c, sn, -sn, c, cx - (cx * c - cy * sn), cy - (cx * sn + cy * c))
      );
      page.drawImage(img, { x: cx - dw / 2, y: cy - dh / 2, width: dw, height: dh });
      page.pushOperators(PDFLib.popGraphicsState());
    }
    return doc.save();
  }

  // Read a PNG/JPG's pixel dimensions without touching a PDF (for aspect ratio).
  async function imageSize(PDFLib, imgBytes) {
    const doc = await PDFLib.PDFDocument.create();
    const img = await embedImage(doc, imgBytes);
    return { width: img.width, height: img.height };
  }

  // Insert every page of each file in `listOfBytes` into `baseBytes` starting
  // at `position` (0 = before page 1, pageCount = after the last page). Items
  // may be PDFs or PNG/JPG images — an image becomes one full page.
  async function insertPdfsAt(PDFLib, baseBytes, listOfBytes, position) {
    const base = await load(PDFLib, baseBytes);
    const total = base.getPageCount();
    let pos = Number.isFinite(position) ? position : total;
    pos = Math.max(0, Math.min(total, pos));
    const baseIdx = base.getPageIndices();
    const before = baseIdx.slice(0, pos);
    const after = baseIdx.slice(pos);

    const out = await PDFLib.PDFDocument.create();
    (await out.copyPages(base, before)).forEach((p) => out.addPage(p));
    for (const bytes of listOfBytes) {
      const src = await load(PDFLib, await normalizeToPdf(PDFLib, bytes));
      (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
    }
    (await out.copyPages(base, after)).forEach((p) => out.addPage(p));
    return out.save();
  }

  // Move one page from index `from` to index `to` (both 0-based).
  async function movePage(PDFLib, bytes, from, to) {
    const doc = await load(PDFLib, bytes);
    const n = doc.getPageCount();
    if (from < 0 || from >= n) throw new Error(`Bad source page ${from}`);
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    const [moved] = order.splice(from, 1);
    const t = Math.max(0, Math.min(n - 1, to));
    order.splice(t, 0, moved);
    return buildFromOrder(PDFLib, bytes, order);
  }

  // ---- Manual-operation marks for Israeli "Inbar" traffic-signal plans ------
  // Draws the exact symbols Inbar 16 prints on the ידני.ת row of a phase
  // diagram (geometry vector-extracted from Inbar's own PDF output):
  //   start ("zinuk")  = red '+'  — vertical ±3.06pt, horizontal ±2.28pt
  //   stop  ("atsira") = red '‡'  — verticals at ±1.2pt, horizontals ±2.28pt at ±1.8pt
  // items: [{ page, x, y, kind: 'start' | 'stop' }] in PDF user space
  // (x = time-axis position of the second, y = center of the ידני.ת row).
  async function stampManualOps(PDFLib, bytes, items) {
    const doc = await load(PDFLib, bytes);
    const RED = PDFLib.rgb(1, 0, 0);
    const W = 1.32, V = 3.06, H = 2.28, VS = 1.2, HS = 1.8;
    for (const it of items) {
      const page = doc.getPage(it.page);
      const line = (x1, y1, x2, y2) =>
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: W, color: RED });
      if (it.kind === 'start') {
        line(it.x, it.y - V, it.x, it.y + V);
        line(it.x - H, it.y, it.x + H, it.y);
      } else {
        line(it.x - VS, it.y - V, it.x - VS, it.y + V);
        line(it.x + VS, it.y - V, it.x + VS, it.y + V);
        line(it.x - H, it.y - HS, it.x + H, it.y - HS);
        line(it.x - H, it.y + HS, it.x + H, it.y + HS);
      }
    }
    return doc.save();
  }

  // ---- DOCX (Word) export ---------------------------------------------------
  // Build a minimal, valid .docx entirely in-memory: a .docx is just a ZIP of
  // XML parts. This produces an editable Word document from extracted text —
  // paragraph structure and right-to-left direction are preserved; pixel-exact
  // layout (tables/positions/images) is not, which no client-only converter can
  // do reliably. No dependencies: a tiny CRC32 + a STORE-method (uncompressed)
  // ZIP writer, which Word opens fine.
  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) { // files: [{ name, data: Uint8Array }]
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = new Uint8Array([].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameB.length), u16(0)
      ));
      chunks.push(local, nameB, f.data);
      const cen = new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameB.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)
      ));
      central.push({ cen, nameB });
      offset += local.length + nameB.length + size;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { chunks.push(c.cen, c.nameB); cdSize += c.cen.length + c.nameB.length; }
    const eocd = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdSize), u32(cdStart), u16(0)
    ));
    chunks.push(eocd);
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  // paragraphs: [{ text, rtl } | { pageBreak: true }]
  function buildDocx(paragraphs) {
    const enc = new TextEncoder();
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // strip characters that are illegal in XML 1.0 (control chars except tab/newlines)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const body = (paragraphs || []).map((p) => {
      if (p && p.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      const t = esc(p && p.text != null ? p.text : '');
      const pPr = (p && p.rtl) ? '<w:pPr><w:bidi/></w:pPr>' : '';
      const rPr = (p && p.rtl) ? '<w:rPr><w:rtl/></w:rPr>' : '';
      if (!t) return '<w:p>' + pPr + '</w:p>';
      return '<w:p>' + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>';
    }).join('');
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + body
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
      + '</w:body></w:document>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'word/document.xml', data: enc.encode(documentXml) },
    ]);
  }

  // Apply a whole batch of edits in one save (renderer uses this on export).
  async function applyEdits(PDFLib, bytes, edits) {
    let b = toBytes(bytes);
    if (edits.highlights && edits.highlights.length) b = await stampHighlights(PDFLib, b, edits.highlights);
    if (edits.ink && edits.ink.length) b = await stampInk(PDFLib, b, edits.ink);
    if (edits.texts && edits.texts.length) b = await stampText(PDFLib, b, edits.texts);
    if (edits.images && edits.images.length) b = await stampImages(PDFLib, b, edits.images);
    if (edits.formValues && Object.keys(edits.formValues).length)
      b = await fillForm(PDFLib, b, edits.formValues, !!edits.flattenForm);
    return b;
  }

  return {
    getPageSizes,
    mergePdfs,
    insertPdfsAt,
    movePage,
    splitPdf,
    reorderPages,
    deletePages,
    rotatePage,
    rotatePages,
    getFormFields,
    fillForm,
    stampText,
    stampHighlights,
    stampInk,
    stampImages,
    stampManualOps,
    imageSize,
    sniffKind,
    wrapImageAsPdf,
    applyEdits,
    // text helpers (exported mainly for tests)
    needsUnicodeFont,
    bidiRuns,
    DEFAULT_LINE_HEIGHT,
    buildDocx,
  };
});
