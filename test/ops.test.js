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
  check('toVisualRtl reverses Hebrew', ops.toVisualRtl('שלום') === 'םולש');
  check('toVisualRtl keeps embedded digits readable', ops.toVisualRtl('כביש 4') === '4 שיבכ');
  check('toVisualRtl leaves Latin untouched', ops.toVisualRtl('hello') === 'hello');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
