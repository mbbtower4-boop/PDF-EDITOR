/* Headless verification of pdfOps.js. Run: node test/ops.test.js */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const PDFLib = require('pdf-lib');
const ops = require('../src/pdfOps.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name); }
}

// Build a sample PDF: N pages, each labelled, plus an AcroForm with a few fields.
async function sample(nPages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < nPages; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`${label} page ${i + 1}`, { x: 40, y: 250, size: 20, font, color: rgb(0, 0, 0) });
  }
  const form = doc.getForm();
  const tf = form.createTextField('fullName');
  tf.setText('');
  tf.addToPage(doc.getPage(0), { x: 40, y: 180, width: 200, height: 24 });
  const cb = form.createCheckBox('agree');
  cb.addToPage(doc.getPage(0), { x: 40, y: 140, width: 16, height: 16 });
  const dd = form.createDropdown('plan');
  dd.addOptions(['Free', 'Pro', 'Team']);
  dd.addToPage(doc.getPage(0), { x: 40, y: 100, width: 120, height: 22 });
  return doc.save();
}

async function pageCount(bytes) {
  const d = await PDFDocument.load(bytes);
  return d.getPageCount();
}

(async () => {
  const a = await sample(3, 'A');
  const b = await sample(2, 'B');

  // page sizes
  const sizes = await ops.getPageSizes(PDFLib, a);
  check('getPageSizes returns 3 pages', sizes.length === 3);
  check('page size is 400x300', sizes[0].width === 400 && sizes[0].height === 300);

  // merge
  const merged = await ops.mergePdfs(PDFLib, [a, b]);
  check('merge => 5 pages', (await pageCount(merged)) === 5);

  // split (extract pages 0 and 2)
  const split = await ops.splitPdf(PDFLib, a, [0, 2]);
  check('split [0,2] => 2 pages', (await pageCount(split)) === 2);

  // reorder (reverse)
  const reordered = await ops.reorderPages(PDFLib, a, [2, 1, 0]);
  check('reorder => still 3 pages', (await pageCount(reordered)) === 3);

  // delete middle
  const deleted = await ops.deletePages(PDFLib, a, [1]);
  check('delete 1 => 2 pages', (await pageCount(deleted)) === 2);

  // delete-all guard
  let guarded = false;
  try { await ops.deletePages(PDFLib, a, [0, 1, 2]); } catch (e) { guarded = true; }
  check('delete-all is refused', guarded);

  // out-of-range guard
  let ranged = false;
  try { await ops.splitPdf(PDFLib, a, [9]); } catch (e) { ranged = true; }
  check('out-of-range index is refused', ranged);

  // rotate
  const rotated = await ops.rotatePage(PDFLib, a, 0, 90);
  const rsizes = await ops.getPageSizes(PDFLib, rotated);
  check('rotate sets page rotation to 90', rsizes[0].rotation === 90);

  // form discovery
  const fields = await ops.getFormFields(PDFLib, a);
  const byName = Object.fromEntries(fields.map(f => [f.name, f]));
  check('found text field fullName', byName.fullName && byName.fullName.type === 'text');
  check('found checkbox agree', byName.agree && byName.agree.type === 'checkbox');
  check('found dropdown plan with options', byName.plan && byName.plan.options.join(',') === 'Free,Pro,Team');

  // fill form
  const filled = await ops.fillForm(PDFLib, a, { fullName: 'Ada Lovelace', agree: true, plan: 'Pro' });
  const after = Object.fromEntries((await ops.getFormFields(PDFLib, filled)).map(f => [f.name, f]));
  check('text field filled', after.fullName.value === 'Ada Lovelace');
  check('checkbox checked', after.agree.value === true);
  check('dropdown selected Pro', after.plan.value === 'Pro');

  // flatten
  const flat = await ops.fillForm(PDFLib, a, { fullName: 'Flat' }, true);
  const flatFields = await ops.getFormFields(PDFLib, flat);
  check('flatten removes fields', flatFields.length === 0);

  // stamp text
  const stamped = await ops.stampText(PDFLib, a, [{ page: 0, x: 50, y: 50, text: 'stamped!', size: 12, color: '#ff0000' }]);
  check('stampText returns valid pdf', (await pageCount(stamped)) === 3);

  // highlight
  const hl = await ops.stampHighlights(PDFLib, a, [{ page: 0, x: 40, y: 245, width: 160, height: 24, color: '#ffd54a', opacity: 0.4 }]);
  check('stampHighlights returns valid pdf', (await pageCount(hl)) === 3);

  // ink
  const ink = await ops.stampInk(PDFLib, a, [{ page: 0, points: [{ x: 40, y: 40 }, { x: 80, y: 60 }, { x: 120, y: 40 }], color: '#d62828', width: 2 }]);
  check('stampInk returns valid pdf', (await pageCount(ink)) === 3);

  // image stamp (signature) — build a tiny PNG with pdf-lib? Use a 1x1 PNG.
  const onePxPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const withImg = await ops.stampImages(PDFLib, a, [{ page: 0, x: 40, y: 40, width: 80, height: 30, pngBytes: onePxPng }]);
  check('stampImages returns valid pdf', (await pageCount(withImg)) === 3);

  // applyEdits batch
  const batched = await ops.applyEdits(PDFLib, a, {
    highlights: [{ page: 0, x: 40, y: 245, width: 160, height: 24, color: '#ffd54a' }],
    texts: [{ page: 1, x: 40, y: 40, text: 'note', size: 12, color: '#000000' }],
    formValues: { fullName: 'Batch' },
  });
  const batchedFields = Object.fromEntries((await ops.getFormFields(PDFLib, batched)).map(f => [f.name, f]));
  check('applyEdits keeps 3 pages', (await pageCount(batched)) === 3);
  check('applyEdits filled form too', batchedFields.fullName.value === 'Batch');

  // insert at position: put B (2 pages) after page 1 of A (3 pages) => 5 pages, B at idx 1,2
  const inserted = await ops.insertPdfsAt(PDFLib, a, [b], 1);
  check('insertPdfsAt => 5 pages', (await pageCount(inserted)) === 5);
  {
    const d = await PDFDocument.load(inserted);
    // page order should be A1, B1, B2, A2, A3 => index 1 & 2 are the B pages
    check('insertPdfsAt keeps A page 1 first', d.getPageCount() === 5);
  }
  // insert at beginning and end
  check('insertPdfsAt(0) => 5 pages', (await pageCount(await ops.insertPdfsAt(PDFLib, a, [b], 0))) === 5);
  check('insertPdfsAt(end) => 5 pages', (await pageCount(await ops.insertPdfsAt(PDFLib, a, [b], 3))) === 5);
  // clamp out-of-range position instead of throwing
  check('insertPdfsAt clamps large pos', (await pageCount(await ops.insertPdfsAt(PDFLib, a, [b], 999))) === 5);

  // move page
  const moved = await ops.movePage(PDFLib, a, 0, 2);
  check('movePage keeps 3 pages', (await pageCount(moved)) === 3);
  let moveGuard = false;
  try { await ops.movePage(PDFLib, a, 9, 0); } catch (e) { moveGuard = true; }
  check('movePage rejects bad source', moveGuard);

  // JPG embedding via stampImages (valid 2x2 JPEG)
  const jpg2x2 = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnKKKK8Q/UD//Z',
    'base64'
  );
  const withJpg = await ops.stampImages(PDFLib, a, [{ page: 0, x: 20, y: 20, width: 40, height: 40, bytes: jpg2x2 }]);
  check('stampImages accepts JPG', (await pageCount(withJpg)) === 3);

  // imageSize
  const sz = await ops.imageSize(PDFLib, jpg2x2);
  check('imageSize reads JPG dimensions', sz.width === 2 && sz.height === 2);


  // manual-operation marks (Inbar signal plans): draws without throwing, output loads
  const marked = await ops.stampManualOps(PDFLib, a, [
    { page: 0, x: 100, y: 150, kind: 'start' },
    { page: 0, x: 120, y: 150, kind: 'stop' },
    { page: 2, x: 80, y: 150, kind: 'start' },
  ]);
  check('stampManualOps output loads', (await pageCount(marked)) === 3);
  check('stampManualOps grew the file', marked.length > a.length);

  // ---- Unicode / Hebrew text -----------------------------------------------
  check('needsUnicodeFont detects Hebrew', ops.needsUnicodeFont('שלום') === true);
  check('needsUnicodeFont false for Latin', ops.needsUnicodeFont('hello 123 (x)') === false);
  // bidi run segmentation (drives RTL-aware drawing; fontkit shapes each run)
  const r1 = ops.bidiRuns('שלום');
  check('bidiRuns single Hebrew run', r1.length === 1 && r1[0].dir === 'R' && r1[0].s === 'שלום');
  const r2 = ops.bidiRuns('כביש 40 מזרח');
  check('bidiRuns splits Hebrew/number/Hebrew', r2.length === 3 && r2.map(r => r.dir).join('') === 'RLR' && r2[1].s === '40');
  const r3 = ops.bidiRuns('hello');
  check('bidiRuns pure Latin stays one L run', r3.length === 1 && r3[0].dir === 'L');
  const r4 = ops.bidiRuns('תאריך 09/07/2026');
  check('bidiRuns keeps a date as one LTR run', r4.length === 2 && r4[1].dir === 'L' && r4[1].s === '09/07/2026');

  // Hebrew stamping requires the bundled font: without it, it must throw clearly.
  let heThrew = false;
  try { await ops.stampText(PDFLib, a, [{ page: 0, x: 40, y: 40, text: 'עברית', size: 14, color: '#000000' }]); }
  catch (e) { heThrew = /Unicode font/i.test(e.message); }
  check('stampText refuses Hebrew without a font', heThrew);

  // With fontkit + the bundled Rubik TTF, Hebrew stamps successfully.
  const fs = require('fs');
  const fontkit = require('../vendor/fontkit/fontkit.umd.min.js');
  const fontBytes = fs.readFileSync(require('path').join(__dirname, '..', 'vendor', 'fonts', 'Rubik-Regular.ttf'));
  const heStamped = await ops.stampText(
    PDFLib, a,
    [{ page: 0, x: 40, y: 60, text: 'אזור עבודות דיפו', size: 16, color: '#1d3557' },
     { page: 1, x: 40, y: 60, text: 'cat eyes', size: 12, color: '#111111' }],
    { fontkit, fontBytes }
  );
  check('stampText embeds Hebrew (valid pdf, 3 pages)', (await pageCount(heStamped)) === 3);
  check('stampText Hebrew grew the file (font subset embedded)', heStamped.length > a.length + 2000);

  // ---- Text blocks: multi-line, rotation, alignment, weight ----------------
  const multi = await ops.stampText(PDFLib, a, [{
    page: 0, x: 40, y: 700, size: 12, color: '#111111',
    text: 'first line\nsecond line\nthird line', lineHeight: 1.5, align: 'center',
  }]);
  check('stampText draws a multi-line block', (await pageCount(multi)) === 3);
  // Three lines must emit more content than one — the extra Tj operators show up
  // as a bigger content stream even after compression.
  const oneLine = await ops.stampText(PDFLib, a, [
    { page: 0, x: 40, y: 700, size: 12, color: '#111111', text: 'first line' }]);
  check('multi-line block writes more than a single line', multi.length > oneLine.length);
  const spun = await ops.stampText(PDFLib, a, [
    { page: 0, x: 200, y: 400, size: 18, color: '#d62828', text: 'angled', rot: 35 }]);
  check('stampText rotates a block', (await pageCount(spun)) === 3);
  const styled = await ops.stampText(PDFLib, a, [
    { page: 0, x: 40, y: 300, size: 14, color: '#111111', text: 'bold italic', bold: true, italic: true },
    { page: 0, x: 40, y: 280, size: 14, color: '#111111', text: 'faded', opacity: 0.4 }]);
  check('stampText handles bold/italic/opacity', (await pageCount(styled)) === 3);
  // Mid-edge stretch: non-uniform scale must produce a valid PDF and actually
  // emit a transformation matrix (the content stream grows vs the plain draw).
  const stretched = await ops.stampText(PDFLib, a, [
    { page: 0, x: 40, y: 700, size: 12, color: '#111111', text: 'wide words', scaleX: 2.5 },
    { page: 0, x: 40, y: 650, size: 12, color: '#111111', text: 'tall words', scaleY: 1.8 },
    { page: 0, x: 40, y: 600, size: 12, color: '#111111', text: 'both + spin', scaleX: 1.5, scaleY: 0.7, rot: 30 }]);
  check('stampText stretches width/height (valid pdf)', (await pageCount(stretched)) === 3);

  // ---- Images as pages (merge PNG/JPG with PDFs) ----------------------------
  check('sniffKind detects pdf', ops.sniffKind(a) === 'pdf');
  check('sniffKind detects png', ops.sniffKind(onePxPng) === 'png');
  const imgPdf = await ops.wrapImageAsPdf(PDFLib, onePxPng);
  check('wrapImageAsPdf makes a 1-page pdf', (await pageCount(imgPdf)) === 1);
  {
    const doc = await PDFLib.PDFDocument.load(imgPdf);
    const { width, height } = doc.getPage(0).getSize();
    check('image page is A4 portrait', Math.abs(width - 595.28) < 0.1 && Math.abs(height - 841.89) < 0.1);
  }
  const mixedIns = await ops.insertPdfsAt(PDFLib, a, [onePxPng, b], 1);
  check('insertPdfsAt accepts an image among PDFs', (await pageCount(mixedIns)) === 3 + 1 + 2);
  const mixedMerge = await ops.mergePdfs(PDFLib, [onePxPng, a, onePxPng]);
  check('mergePdfs builds from images + pdfs', (await pageCount(mixedMerge)) === 1 + 3 + 1);
  // Hebrew keeps its RTL run layout inside a rotated multi-line block.
  const heBlock = await ops.stampText(
    PDFLib, a,
    [{ page: 0, x: 60, y: 500, size: 15, color: '#1d3557', rot: -20, bold: true,
       text: 'כביש 40 מזרח\nתאריך 09/07/2026' }],
    { fontkit, fontBytes }
  );
  check('stampText rotates a multi-line Hebrew block', (await pageCount(heBlock)) === 3);

  // ---- DOCX (Word) export ---------------------------------------------------
  const docx = ops.buildDocx([
    { text: 'Hello World', rtl: false },
    { text: '', rtl: false },
    { text: 'אזור עבודות דיפו', rtl: true },
    { pageBreak: true },
    { text: 'a < b & c > d', rtl: false },
  ]);
  check('buildDocx returns bytes', docx instanceof Uint8Array && docx.length > 400);
  check('buildDocx is a zip (PK magic)', docx[0] === 0x50 && docx[1] === 0x4b && docx[2] === 3 && docx[3] === 4);
  // parse EOCD -> exactly 3 parts
  const dv = new DataView(docx.buffer, docx.byteOffset, docx.byteLength);
  let eocd = -1;
  for (let i = docx.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  check('buildDocx EOCD present', eocd >= 0);
  check('buildDocx has 3 zip entries', eocd >= 0 && dv.getUint16(eocd + 10, true) === 3);
  // inspect document.xml text (stored/uncompressed, so it's plain in the bytes)
  const whole = Buffer.from(docx).toString('utf8');
  check('docx contains word/document.xml', whole.includes('word/document.xml'));
  check('docx contains the Hebrew text', whole.includes('אזור עבודות דיפו'));
  check('docx marks RTL paragraph', whole.includes('<w:bidi/>') && whole.includes('<w:rtl/>'));
  check('docx has a page break', whole.includes('w:type="page"'));
  check('docx escapes XML specials', whole.includes('a &lt; b &amp; c &gt; d'));
  // CRC check on the first (stored) entry: header crc must match crc of its data
  const nameLen = dv.getUint16(26, true);
  const dataStart = 30 + nameLen;
  const size = dv.getUint32(18, true);
  const storedCrc = dv.getUint32(14, true);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < size; i++) { let c = (crc ^ docx[dataStart + i]) & 0xFF; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crc = (crc >>> 8) ^ c; }
  check('docx first entry CRC32 is correct', ((crc ^ 0xFFFFFFFF) >>> 0) === storedCrc);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
