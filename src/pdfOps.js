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
      const src = await load(PDFLib, bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    return out.save();
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

  // ---- Rotate a page by a multiple of 90 degrees ----------------------------
  async function rotatePage(PDFLib, bytes, pageIndex, deltaDegrees) {
    const doc = await load(PDFLib, bytes);
    const page = doc.getPage(pageIndex);
    const current = page.getRotation().angle;
    let next = (current + deltaDegrees) % 360;
    if (next < 0) next += 360;
    page.setRotation(PDFLib.degrees(next));
    return doc.save();
  }

  // ---- Forms ----------------------------------------------------------------
  function fieldType(field) {
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
      const type = fieldType(f);
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
      const type = fieldType(field);
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

  // items: [{ page, x, y, text, size, color }]  (y is baseline, bottom-left origin)
  async function stampText(PDFLib, bytes, items) {
    const doc = await load(PDFLib, bytes);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    for (const it of items) {
      const page = doc.getPage(it.page);
      page.drawText(String(it.text ?? ''), {
        x: it.x,
        y: it.y,
        size: it.size || 14,
        font,
        color: rgb(PDFLib, it.color || '#111111'),
      });
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
      page.drawImage(img, { x: im.x, y: im.y, width: im.width, height: im.height });
    }
    return doc.save();
  }

  // Read a PNG/JPG's pixel dimensions without touching a PDF (for aspect ratio).
  async function imageSize(PDFLib, imgBytes) {
    const doc = await PDFLib.PDFDocument.create();
    const img = await embedImage(doc, imgBytes);
    return { width: img.width, height: img.height };
  }

  // Insert every page of each PDF in `listOfBytes` into `baseBytes` starting at
  // `position` (0 = before page 1, pageCount = after the last page).
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
      const src = await load(PDFLib, bytes);
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
    getFormFields,
    fillForm,
    stampText,
    stampHighlights,
    stampInk,
    stampImages,
    imageSize,
    applyEdits,
  };
});
