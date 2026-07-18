'use strict';
/*
 * app.js — renderer logic for Paperweight.
 *
 * Source of truth is `currentBytes` (a Uint8Array of the whole PDF). pdf.js
 * renders it; PdfOps (pdf-lib) mutates it. Every edit is baked into the bytes
 * immediately, so what you see is exactly what saves, and Undo is just a stack
 * of byte snapshots.
 *
 * Screen<->PDF mapping is delegated to pdf.js: viewport.convertToPdfPoint(x,y)
 * turns a point on the rendered page into PDF user space (bottom-left origin),
 * correct across zoom and page rotation. We never hand-roll that math.
 */

const PDFLib = window.PDFLib;
const ops = window.PdfOps;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.min.js';

// ---- State ----------------------------------------------------------------
const state = {
  bytes: null,         // Uint8Array — current document
  name: 'document.pdf',
  pdfDoc: null,        // pdf.js document
  pageIndex: 0,
  pageCount: 0,
  scale: 1,
  viewport: null,      // active page viewport (for coordinate mapping)
  tool: 'hand',
  undo: [],            // Uint8Array snapshots
  // tool options
  highlightColor: '#ffd54a',
  penColor: '#d62828',
  penWidth: 2.5,
  textColor: '#111111',
  textSize: 14,
  // signature
  pendingSigPng: null, // Uint8Array
  pendingSigAspect: 1, // width/height
  // inserted picture
  pendingImage: null,  // { bytes, aspect, name }
  images: [],          // live, editable image objects on the page (baked on save)
  selectedImageId: null,
  texts: [],           // live, editable text objects on the page (baked on save)
  selectedTextId: null,
  highlights: [],      // live highlight rects (baked on save)
  inks: [],            // live pen strokes (baked on save)
  manualMarks: [],     // live Inbar manual-op marks (baked on save; deletable/undoable)
  selectedAnnId: null,
  selectedPages: new Set(), // multi-selected page indices (Ctrl/Shift+click in the rail)
  thumbAnchor: 0,           // anchor index for Shift+click range selection
};

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  open: $('btnOpen'), open2: $('btnOpen2'), save: $('btnSave'),
  merge: $('btnMerge'), split: $('btnSplit'), undo: $('btnUndo'),
  zoomIn: $('btnZoomIn'), zoomOut: $('btnZoomOut'), zoomInput: $('zoomInput'),
  toolOptions: $('toolOptions'),
  rail: $('rail'), thumbs: $('thumbs'), pageCount: $('pageCount'),
  selBar: $('selBar'), selCount: $('selCount'), selMove: $('selMove'),
  selMoveInput: $('selMoveInput'), selDelete: $('selDelete'), selClear: $('selClear'),
  emptyState: $('emptyState'), stage: $('stage'), pageWrap: $('pageWrap'),
  pageCanvas: $('pageCanvas'), overlay: $('overlayCanvas'),
  imgLayer: $('imgLayer'), txtLayer: $('txtLayer'), annLayer: $('annLayer'),
  canvasArea: $('canvasArea'),
  docName: $('docName'), gotoPage: $('gotoPage'), pageTotal: $('pageTotal'), toolStatus: $('toolStatus'),
  formEmpty: $('formEmpty'), formFields: $('formFields'),
  formActions: $('formActions'), flattenChk: $('flattenChk'), applyForm: $('btnApplyForm'),
  sigModal: $('sigModal'), sigPad: $('sigPad'), sigClear: $('sigClear'),
  sigCancel: $('sigCancel'), sigUse: $('sigUse'),
  rangeModal: $('rangeModal'), rangeInput: $('rangeInput'),
  rangeCancel: $('rangeCancel'), rangeGo: $('rangeGo'),
  insertModal: $('insertModal'), insertAfter: $('insertAfter'),
  insertCancel: $('insertCancel'), insertGo: $('insertGo'),
  manualOp: $('btnManualOp'), manualModal: $('manualModal'), manualPoints: $('manualPoints'),
  manualComp: $('manualComp'),
  manualCancel: $('manualCancel'), manualGo: $('manualGo'), manualAuto: $('manualAuto'), manualClear: $('manualClear'),
  toast: $('toast'), busy: $('busy'), busyMsg: $('busyMsg'),
  dropHint: $('dropHint'),
  appVersion: $('appVersion'),
  textSel: $('textLayer'),
  copyText: $('btnCopyText'), saveText: $('btnSaveText'), saveWord: $('btnSaveWord'),
  scanImgs: $('btnScanImgs'), extractImgs: $('extractImgs'),
};

// ---- Small helpers --------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (isErr ? ' err' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}
function showBusy(msg) { els.busyMsg.textContent = msg || 'Working…'; els.busy.hidden = false; }
function hideBusy() { els.busy.hidden = true; }
const copyBytes = (u8) => u8.slice(); // pdf.js detaches buffers; always hand it a copy

function setDocActionsEnabled(on) {
  [els.save, els.merge, els.split, els.manualOp, els.zoomIn, els.zoomOut, els.gotoPage, els.zoomInput].forEach((b) => { b.disabled = !on; });
  document.querySelectorAll('.tool').forEach((b) => { b.disabled = !on; });
}

// ---- Undo -----------------------------------------------------------------
function cloneImg(o) { return { id: o.id, page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, bytes: o.bytes, aspect: o.aspect, _url: o._url }; }
function cloneText(o) { return { id: o.id, page: o.page, x: o.x, yTop: o.yTop, text: o.text, size: o.size, color: o.color }; }
function cloneHl(o) { return { id: o.id, page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, color: o.color, opacity: o.opacity }; }
function cloneInk(o) { return { id: o.id, page: o.page, ox: o.ox, oy: o.oy, w: o.w, h: o.h, color: o.color, width: o.width, points: o.points.map((p) => ({ dx: p.dx, dy: p.dy })) }; }
function cloneMark(o) { return { id: o.id, page: o.page, x: o.x, y: o.y, kind: o.kind }; }
function pushUndo() {
  state.undo.push({
    bytes: state.bytes,
    images: state.images.map(cloneImg),
    texts: state.texts.map(cloneText),
    highlights: state.highlights.map(cloneHl),
    inks: state.inks.map(cloneInk),
    manualMarks: state.manualMarks.map(cloneMark),
  });
  if (state.undo.length > 20) state.undo.shift();
  els.undo.disabled = state.undo.length === 0;
}
async function undo() {
  if (!state.undo.length) return;
  const snap = state.undo.pop();
  state.bytes = snap.bytes;
  state.images = snap.images;
  state.texts = snap.texts || [];
  state.highlights = snap.highlights || [];
  state.inks = snap.inks || [];
  state.manualMarks = snap.manualMarks || [];
  state.selectedImageId = null;
  state.selectedTextId = null;
  state.selectedAnnId = null;
  state.selectedPages.clear(); // page indices may no longer match after revert
  els.undo.disabled = state.undo.length === 0;
  await reloadAfterEdit({ rebuildForm: true });
  toast('Reverted last change');
}

// ---- Opening / loading ----------------------------------------------------
async function openPdf() {
  const res = await window.api.openPdf();
  if (!res) return;
  showBusy('Opening…');
  try {
    state.bytes = new Uint8Array(res.data);
    state.name = res.name || 'document.pdf';
    state.undo = [];
    state.images = [];
    state.selectedImageId = null;
    state.texts = [];
    state.selectedTextId = null;
    state.highlights = [];
    state.inks = [];
    state.manualMarks = [];
    state.selectedAnnId = null;
    state.selectedPages.clear();
    state.thumbAnchor = 0;
    els.undo.disabled = true;
    state.pageIndex = 0;
    state.scale = 0; // signal: compute fit on first render
    await loadDoc({ rebuildForm: true, fit: true });
    els.emptyState.hidden = true;
    els.stage.hidden = false;
    setDocActionsEnabled(true);
    els.docName.textContent = state.name;
    selectTool('hand');
    toast('Opened ' + state.name);
  } catch (e) {
    console.error(e);
    toast('Could not open this PDF: ' + e.message, true);
  } finally { hideBusy(); }
}

async function loadDoc({ rebuildForm, fit } = {}) {
  if (state.pdfDoc) { try { await state.pdfDoc.destroy(); } catch (e) {} state.pdfDoc = null; }
  const task = pdfjsLib.getDocument({ data: copyBytes(state.bytes) });
  state.pdfDoc = await task.promise;
  state.pageCount = state.pdfDoc.numPages;
  if (state.pageIndex >= state.pageCount) state.pageIndex = state.pageCount - 1;
  if (state.pageIndex < 0) state.pageIndex = 0;
  if (fit) state.scale = await computeFitScale();
  await renderThumbs();
  await renderPage();
  if (rebuildForm) await buildForm();
  els.pageCount.textContent = state.pageCount + (state.pageCount === 1 ? ' page' : ' pages');
}

// Reload after a byte-level edit (keeps zoom; optionally rebuild the form panel)
async function reloadAfterEdit({ rebuildForm } = {}) {
  await loadDoc({ rebuildForm, fit: false });
}

async function computeFitScale() {
  const page = await state.pdfDoc.getPage(state.pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const avail = els.canvasArea.clientWidth - 60;
  let s = avail / base.width;
  s = Math.max(0.4, Math.min(1.6, s));
  return Math.round(s * 100) / 100;
}

// ---- Page render ----------------------------------------------------------
// pdf.js cannot run two render() calls on the same canvas at once — overlapping
// renders (e.g. from fast Ctrl+wheel zooming) draw the page garbled or
// seemingly rotated. So only ONE render runs at a time: a request that arrives
// mid-render is remembered and coalesced into a single trailing re-render with
// the latest zoom/page, once the current one finishes.
let rendering = false;
let pendingRender = false;
async function renderPage() {
  if (!state.pdfDoc) return;
  if (rendering) { pendingRender = true; return; } // fold into the in-flight render
  rendering = true;
  try {
    do {
      pendingRender = false;
      await drawPage();
    } while (pendingRender && state.pdfDoc);
  } catch (e) {
    console.error('render', e);
  } finally {
    rendering = false;
  }
}
async function drawPage() {
  const page = await state.pdfDoc.getPage(state.pageIndex + 1);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: state.scale });
  state.viewport = viewport;

  const cw = Math.floor(viewport.width);
  const ch = Math.floor(viewport.height);
  els.pageWrap.style.width = cw + 'px';
  els.pageWrap.style.height = ch + 'px';

  // main page canvas (crisp via dpr backing store)
  const c = els.pageCanvas;
  c.width = Math.floor(viewport.width * dpr);
  c.height = Math.floor(viewport.height * dpr);
  c.style.width = cw + 'px';
  c.style.height = ch + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Only one render at a time (guarded by `rendering`), so nothing else is
  // drawing to this canvas while this render runs.
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;

  // overlay canvas (logical px; transient previews only)
  const o = els.overlay;
  o.width = cw; o.height = ch;
  o.style.width = cw + 'px'; o.style.height = ch + 'px';
  clearOverlay();

  // selectable text layer (best-effort; failure must never block the page)
  els.textSel.style.width = cw + 'px';
  els.textSel.style.height = ch + 'px';
  renderTextSelectLayer(page, viewport).catch(() => {});

  els.zoomInput.value = String(Math.round(state.scale * 100));
  els.gotoPage.value = String(state.pageIndex + 1);
  els.pageTotal.textContent = '/ ' + state.pageCount;
  markCurrentThumb();
  renderImageObjects();
  renderTextObjects();
  renderAnnObjects();
}

function clearOverlay() {
  const o = els.overlay; o.getContext('2d').clearRect(0, 0, o.width, o.height);
}

// ---- Thumbnails -----------------------------------------------------------
async function renderThumbs() {
  els.thumbs.innerHTML = '';
  const THUMB_W = 150;
  for (let i = 0; i < state.pageCount; i++) {
    const page = await state.pdfDoc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = THUMB_W / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const wrap = document.createElement('div');
    wrap.className = 'thumb' + (i === state.pageIndex ? ' current' : '') +
      (state.selectedPages.has(i) ? ' picked' : '');
    wrap.dataset.index = String(i);
    wrap.draggable = true;
    wrap.appendChild(canvas);

    const no = document.createElement('span');
    no.className = 'thumb-no'; no.textContent = String(i + 1);
    wrap.appendChild(no);

    const acts = document.createElement('div');
    acts.className = 'thumb-actions';
    acts.innerHTML =
      `<button class="thumb-act move" title="Move to page…">⇅</button>` +
      `<button class="thumb-act rot" title="Rotate 90°">⟳</button>` +
      `<button class="thumb-act del" title="Delete page">✕</button>`;
    wrap.appendChild(acts);

    wrap.addEventListener('click', (e) => {
      if (e.target.closest('.thumb-act') || e.target.closest('.move-input')) return;
      // Ctrl/Cmd+click toggles a page in the multi-selection; Shift+click
      // selects the range from the last anchor. Plain click just navigates
      // (and clears any multi-selection).
      if (e.ctrlKey || e.metaKey) {
        if (state.selectedPages.has(i)) state.selectedPages.delete(i);
        else state.selectedPages.add(i);
        state.thumbAnchor = i;
        refreshPickedThumbs();
        return;
      }
      if (e.shiftKey) {
        const a = Math.min(state.thumbAnchor, i), b = Math.max(state.thumbAnchor, i);
        state.selectedPages.clear();
        for (let k = a; k <= b; k++) state.selectedPages.add(k);
        refreshPickedThumbs();
        return;
      }
      state.thumbAnchor = i;
      if (state.selectedPages.size) { state.selectedPages.clear(); refreshPickedThumbs(); }
      state.pageIndex = i; renderPage();
    });
    acts.querySelector('.move').addEventListener('click', (e) => { e.stopPropagation(); promptMovePage(i); });
    acts.querySelector('.rot').addEventListener('click', (e) => { e.stopPropagation(); rotatePage(i); });
    acts.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePage(i); });

    attachThumbDnD(wrap);
    els.thumbs.appendChild(wrap);
  }
  updateSelBar();
}
function markCurrentThumb() {
  els.thumbs.querySelectorAll('.thumb').forEach((t) => {
    const isCur = Number(t.dataset.index) === state.pageIndex;
    t.classList.toggle('current', isCur);
    if (isCur) t.scrollIntoView({ block: 'nearest' });
  });
}

// ---- Multi-page selection ---------------------------------------------------
function refreshPickedThumbs() {
  els.thumbs.querySelectorAll('.thumb').forEach((t) => {
    t.classList.toggle('picked', state.selectedPages.has(Number(t.dataset.index)));
  });
  updateSelBar();
}
function clearPageSelection() {
  if (!state.selectedPages.size) return;
  state.selectedPages.clear();
  refreshPickedThumbs();
}
function updateSelBar() {
  const n = state.selectedPages.size;
  els.selBar.hidden = n === 0;
  if (n) els.selCount.textContent = n + ' selected';
  if (els.selMoveInput && !els.selMoveInput.hidden && !n) els.selMoveInput.hidden = true;
}
function selectedSorted() { return Array.from(state.selectedPages).sort((a, b) => a - b); }

async function deleteSelectedPages() {
  const sel = selectedSorted();
  if (!sel.length) return;
  if (sel.length >= state.pageCount) { toast('A PDF needs at least one page', true); return; }
  showBusy('Deleting ' + sel.length + (sel.length === 1 ? ' page…' : ' pages…'));
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.deletePages(PDFLib, state.bytes, sel);
    state.bytes = nb;
    // land on the page that took the place of the first deleted one
    const before = sel.filter((i) => i < state.pageIndex).length;
    state.pageIndex = Math.max(0, Math.min(state.pageIndex - before, state.pageCount - sel.length - 1));
    state.selectedPages.clear();
    await reloadAfterEdit({});
    toast(sel.length === 1 ? 'Page deleted' : sel.length + ' pages deleted');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// Move the selected pages (as a block, keeping their order) so the block
// starts at target position `t` (0-based, expressed in the FINAL document).
async function moveSelectedPagesTo(t) {
  const sel = selectedSorted();
  if (!sel.length) return;
  const others = [];
  for (let i = 0; i < state.pageCount; i++) if (!state.selectedPages.has(i)) others.push(i);
  const at = Math.max(0, Math.min(t, others.length));
  const order = others.slice(0, at).concat(sel, others.slice(at));
  showBusy('Moving ' + sel.length + (sel.length === 1 ? ' page…' : ' pages…'));
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.reorderPages(PDFLib, state.bytes, order);
    state.bytes = nb;
    state.pageIndex = at;
    state.selectedPages.clear();
    await reloadAfterEdit({});
    toast(sel.length === 1 ? 'Page moved' : sel.length + ' pages moved');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Thumbnail drag-to-reorder -------------------------------------------
let dragFrom = null;
function attachThumbDnD(el) {
  el.addEventListener('dragstart', (e) => {
    dragFrom = Number(el.dataset.index);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    els.thumbs.querySelectorAll('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = Number(el.dataset.index);
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    el.classList.remove('drop-before', 'drop-after');
    if (dragFrom == null) return;
    // Dragging a thumb that is part of the multi-selection moves the whole
    // selection as a block (keeping its order) to the drop point.
    if (state.selectedPages.size > 1 && state.selectedPages.has(dragFrom)) {
      const insertion = to + (after ? 1 : 0); // in current page coords
      let at = 0; // block start position among the non-selected pages
      for (let i = 0; i < insertion; i++) if (!state.selectedPages.has(i)) at++;
      moveSelectedPagesTo(at);
      return;
    }
    if (dragFrom === to) return;
    clearPageSelection();
    reorderPages(dragFrom, to, after);
  });
}

async function reorderPages(from, to, after) {
  const order = [];
  for (let i = 0; i < state.pageCount; i++) order.push(i);
  const [moved] = order.splice(from, 1);
  let insertAt = order.indexOf(to);
  if (after) insertAt += 1;
  order.splice(insertAt, 0, moved);
  showBusy('Reordering…');
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.reorderPages(PDFLib, state.bytes, order);
    state.bytes = nb;
    state.pageIndex = order.indexOf(state.pageIndex) >= 0 ? insertAt : state.pageIndex;
    await reloadAfterEdit({});
    toast('Pages reordered');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

async function deletePage(i) {
  if (state.pageCount <= 1) { toast('A PDF needs at least one page', true); return; }
  showBusy('Deleting page…');
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.deletePages(PDFLib, state.bytes, [i]);
    state.bytes = nb;
    if (state.pageIndex >= i && state.pageIndex > 0) state.pageIndex -= 1;
    await reloadAfterEdit({});
    toast('Page ' + (i + 1) + ' deleted');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

async function rotatePage(i) {
  showBusy('Rotating…');
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.rotatePage(PDFLib, state.bytes, i, 90);
    state.bytes = nb;
    await reloadAfterEdit({});
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Insert PDFs at a chosen position -------------------------------------
function openInsertModal() {
  els.insertAfter.value = String(state.pageIndex + 1);
  const afterRadio = els.insertModal.querySelector('input[value="after"]');
  if (afterRadio) afterRadio.checked = true;
  els.insertModal.hidden = false;
}
async function doInsert() {
  const sel = els.insertModal.querySelector('input[name="insertPos"]:checked');
  const posType = sel ? sel.value : 'end';
  let position;
  if (posType === 'start') position = 0;
  else if (posType === 'end') position = state.pageCount;
  else {
    const after = parseInt(els.insertAfter.value, 10);
    if (!Number.isInteger(after) || after < 1 || after > state.pageCount) {
      toast('Enter a page between 1 and ' + state.pageCount, true); return;
    }
    position = after; // insert *after* page `after` => start index `after`
  }
  els.insertModal.hidden = true;
  const list = await window.api.openPdfs();
  if (!list || !list.length) return;
  showBusy('Inserting…');
  try {
    pushUndo(); await bakeAll();
    const others = list.map((f) => new Uint8Array(f.data));
    const nb = await ops.insertPdfsAt(PDFLib, state.bytes, others, position);
    state.bytes = nb;
    state.pageIndex = position; // jump to the first inserted page
    await reloadAfterEdit({ rebuildForm: true });
    toast('Inserted ' + list.length + (list.length === 1 ? ' file' : ' files'));
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Move a page to a typed position (easier than dragging in long docs) ---
function promptMovePage(i) {
  const wrap = els.thumbs.querySelector(`.thumb[data-index="${i}"]`);
  if (!wrap || wrap.querySelector('.move-input')) return;
  const inp = document.createElement('input');
  inp.className = 'move-input text-input';
  inp.type = 'text'; inp.inputMode = 'numeric'; inp.value = String(i + 1);
  wrap.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const go = async () => {
    if (done) return; done = true;
    const t = parseInt(inp.value, 10); inp.remove();
    if (!Number.isInteger(t) || t < 1 || t > state.pageCount || t - 1 === i) return;
    await movePageTo(i, t - 1);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
    else if (e.key === 'Escape') { done = true; inp.remove(); }
  });
  inp.addEventListener('blur', go);
}
async function movePageTo(from, to) {
  showBusy('Moving page…');
  try {
    pushUndo(); await bakeAll();
    const nb = await ops.movePage(PDFLib, state.bytes, from, to);
    state.bytes = nb; state.pageIndex = to;
    await reloadAfterEdit({});
    toast('Moved page ' + (from + 1) + ' → ' + (to + 1));
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Extract range (split, exports a new file) ----------------------------
function openRangeModal() { els.rangeInput.value = ''; els.rangeModal.hidden = false; els.rangeInput.focus(); }
function parseRange(str, max) {
  const out = [];
  const parts = String(str).split(',');
  for (let raw of parts) {
    raw = raw.trim(); if (!raw) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(raw);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p++) out.push(p);
    } else if (/^\d+$/.test(raw)) {
      out.push(parseInt(raw, 10));
    } else {
      throw new Error('Could not understand "' + raw + '"');
    }
  }
  const idx = out.map((p) => p - 1);
  for (const i of idx) if (i < 0 || i >= max) throw new Error('Page ' + (i + 1) + ' is out of range (1–' + max + ')');
  if (!idx.length) throw new Error('No pages specified');
  return idx;
}
async function doExtract() {
  let idx;
  try { idx = parseRange(els.rangeInput.value, state.pageCount); }
  catch (e) { toast(e.message, true); return; }
  els.rangeModal.hidden = true;
  showBusy('Extracting…');
  try {
    const src = await applyOverlays(state.bytes);
    const nb = await ops.splitPdf(PDFLib, src, idx);
    const suggested = state.name.replace(/\.pdf$/i, '') + '-extract.pdf';
    const saved = await window.api.savePdf(nb, suggested);
    if (saved) toast('Saved ' + saved.split(/[\\/]/).pop());
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Manual-operation marks (Inbar traffic-signal timing plans) ------------
// Parses the official picture composition, e.g. "A: 1,b,c,e,g | B: 3,a,c,f,g"
// -> [{ pic, members }]. Pictures split on | ; or newlines; members are the
// phase labels as printed on the diagram rows (digits = vehicle, a-z = peds).
// Returns null for empty input (composition is optional).
function parseComposition(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const out = [];
  for (const raw of s.split(/[;|\n]+/)) {
    const t = raw.trim(); if (!t) continue;
    const m = /^([A-Za-z])\s*[:=]\s*(.+)$/.exec(t);
    if (!m) throw new Error('הרכב תמונות: לא הובן "' + t + '" — צפוי למשל A: 1,b,c,e,g');
    const members = m[2].split(/[,\s]+/).filter(Boolean)
      .map((w) => (/^\d{1,2}$/.test(w) ? w : w.toLowerCase()));
    if (!members.length || members.some((w) => !/^(\d{1,2}|[a-z])$/.test(w)))
      throw new Error('הרכב תמונות: תווית מופע לא חוקית בתמונה ' + m[1].toUpperCase());
    out.push({ pic: m[1].toUpperCase(), members });
  }
  return out.length ? out : null;
}

// Parses "A:87/90, B:11/13" -> [{ pic, start, stop }]
function parseManualPoints(str) {
  const out = [];
  for (let raw of String(str || '').split(',')) {
    raw = raw.trim(); if (!raw) continue;
    const m = /^(.+?):\s*([\d.]+)\s*\/\s*([\d.]+)$/.exec(raw);
    if (!m) throw new Error('Could not understand "' + raw + '" — expected e.g. A:87/90');
    out.push({ pic: m[1].trim(), start: parseFloat(m[2]), stop: parseFloat(m[3]) });
  }
  if (!out.length) throw new Error('No points given');
  return out;
}

// Auto-calibration from the page itself, via pdf.js text positions:
//  - the time axis: Inbar prints the SAME 0..cycle scale twice — a top band
//    (above the phase bars) and a bottom band (below the pictures row). We take
//    every y-band that reads like an axis (≥5 numbers spanning 0..≥20) and fit
//    number -> x over their combined points (both share one scale), giving a
//    robust (x0, scale) in PDF user space, plus the top/bottom band y's.
//  - the ידני.ת row = the "ידני" label baseline. Inbar prints it on both margins;
//    we keep only hits that sit between the two axes (guards against a stray
//    match in the header/footer) and average them.
// The row FLOATS with the number of phase rows, so there is no fixed geometric
// offset — the label is the only reliable anchor. When it can't be read we fall
// back to a fixed offset above the detected bottom axis (layout-relative), and
// only as a last resort to Inbar's standard A4 row height (see doManualOps).
async function calibrateInbarPlan() {
  const page = await state.pdfDoc.getPage(state.pageIndex + 1);
  const tc = await page.getTextContent();
  const nums = [];
  const manualYs = [];
  for (const it of tc.items) {
    const s = (it.str || '').trim();
    if (!s) continue;
    const x = it.transform[4], y = it.transform[5];
    if (/^\d{1,3}$/.test(s)) nums.push({ v: parseInt(s, 10), x: x + (it.width || 0) / 2, y });
    if (s.indexOf('ידני') !== -1) manualYs.push(y);
  }
  const bands = new Map();
  for (const n of nums) {
    const b = Math.round(n.y / 4) * 4;
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(n);
  }
  // Bands that look like a time axis: many numbers, reaching up to the cycle.
  const axisBands = [...bands.values()]
    .filter((arr) => arr.length >= 5 && Math.max.apply(null, arr.map((n) => n.v)) >= 20)
    .sort((a, b) => b.length - a.length);
  let cal = null, topAxisY = null, botAxisY = null;
  if (axisBands.length) {
    // Combine the densest axis band(s) — top+bottom share one horizontal scale,
    // so fitting them together just adds points and steadies the regression.
    const best = axisBands[0].length;
    const use = axisBands.filter((arr) => arr.length >= best - 2);
    const a = [].concat.apply([], use).filter((n) => n.v <= 200);
    const N = a.length;
    const sv = a.reduce((s, n) => s + n.v, 0), sx = a.reduce((s, n) => s + n.x, 0);
    const svv = a.reduce((s, n) => s + n.v * n.v, 0), svx = a.reduce((s, n) => s + n.v * n.x, 0);
    const denom = N * svv - sv * sv;
    if (N >= 3 && denom !== 0) {
      const scale = (N * svx - sv * sx) / denom;
      const x0 = (sx - scale * sv) / N;
      if (scale > 0.5 && scale < 20) cal = { x0, scale };
    }
    const ys = use.map((arr) => arr.reduce((s, n) => s + n.y, 0) / arr.length);
    topAxisY = Math.max.apply(null, ys); // larger pdf-y = higher on page
    botAxisY = Math.min.apply(null, ys);
  }
  // ידני.ת label baseline, restricted to the band between the two axes.
  let manualY = null;
  const valid = manualYs.filter((y) =>
    (topAxisY == null || y < topAxisY) && (botAxisY == null || y > botAxisY));
  if (valid.length) manualY = valid.reduce((s, y) => s + y, 0) / valid.length;
  return { cal, manualY, botAxisY };
}

// Full automatic analysis of an Inbar phase diagram, from its printed text:
// reconstructs each phase's green intervals from the start/end second markers
// Inbar prints above the bars (disambiguating wrapped bars via the duration
// numbers printed inside them), finds each picture's all-green window, and
// derives manual-operation points per the design rules:
//   start (zinuk) = the second the picture is fully formed (window start),
//   stop  (atsira) = the last second the picture is still whole (window end).
// PRIMARY: Inbar itself draws a dotted blue vertical line at every picture
// start/stop (its own +/‡ marks sit exactly on these lines) — when those lines
// are found in the page's vector content, the points are read straight off
// them, which reproduces Inbar's output 1:1. Fallbacks, in order: the official
// picture composition (`comp`, exact intersection of member greens), then
// inference from the letter positions (approximate: a leftover green
// overlapping the letter can shrink the window).

// Detects Inbar's dotted blue picture-boundary lines in the page's operator
// list and returns their x positions (PDF pts). The lines are drawn as
// thousands of tiny outlined dots in Inbar's boundary blue; a boundary column
// collects ~2,300 micro-segments vs ~40 for the faint second-grid / letter
// guides, so a per-column count threshold separates them cleanly.
async function extractInbarBoundaries(page) {
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const fnA = opList.fnArray, argA = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  const ap = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
  let fill = null, strk = null, pend = [];
  const xs = [];
  const isBlue = (c) => c && c[2] > 150 && c[2] - c[0] > 60 && c[2] - c[1] > 60;
  const flush = (col) => { if (isBlue(col)) for (const v of pend) xs.push(v); pend = []; };
  for (let i = 0; i < fnA.length; i++) {
    const fn = fnA[i], a = argA[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm: ctm.slice(), fill, strk }); break;
      case OPS.restore: { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; strk = s.strk; } break; }
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.setFillRGBColor: fill = [a[0], a[1], a[2]]; break;
      case OPS.setStrokeRGBColor: strk = [a[0], a[1], a[2]]; break;
      case OPS.constructPath: {
        const ops = a[0], co = a[1];
        let k = 0, cx = 0, cy = 0;
        for (const op of ops) {
          if (op === OPS.moveTo) { cx = co[k++]; cy = co[k++]; }
          else if (op === OPS.lineTo) {
            const nx = co[k++], ny = co[k++];
            const p1 = ap(ctm, cx, cy), p2 = ap(ctm, nx, ny);
            pend.push((p1[0] + p2[0]) / 2);
            cx = nx; cy = ny;
          }
          else if (op === OPS.rectangle) { k += 4; }
          else if (op === OPS.curveTo) { k += 6; cx = co[k - 2]; cy = co[k - 1]; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 4; cx = co[k - 2]; cy = co[k - 1]; }
        }
        break;
      }
      case OPS.stroke: case OPS.closeStroke: flush(strk); break;
      case OPS.fill: case OPS.eoFill: flush(fill); break;
      case OPS.fillStroke: case OPS.eoFillStroke: flush(strk || fill); break;
      case OPS.endPath: pend = []; break;
    }
  }
  // histogram over 1pt x-cells; cluster adjacent hot cells (a boundary line's
  // dots zigzag ~1.6pt wide), weighted center per cluster.
  const cells = new Map();
  for (const x of xs) {
    const c = Math.round(x);
    const e = cells.get(c) || { n: 0, wx: 0 };
    e.n++; e.wx += x; cells.set(c, e);
  }
  const hot = [...cells.entries()].filter(([, e]) => e.n >= 200).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [c, e] of hot) {
    const m = merged.length && c - merged[merged.length - 1].c <= 2 ? merged[merged.length - 1] : null;
    if (m) { m.n += e.n; m.wx += e.wx; m.c = c; }
    else merged.push({ c, n: e.n, wx: e.wx });
  }
  return merged.map((m) => m.wx / m.n);
}

async function analyzeInbarPlan(comp) {
  const page = await state.pdfDoc.getPage(state.pageIndex + 1);
  const tc = await page.getTextContent();
  const items = tc.items
    .map((it) => ({ s: (it.str || '').trim(), x: it.transform[4] + (it.width || 0) / 2, y: it.transform[5] }))
    .filter((it) => it.s);

  // -- time axis + cycle length ----------------------------------------------
  const nums = items.filter((it) => /^\d{1,3}$/.test(it.s)).map((it) => ({ v: parseInt(it.s, 10), x: it.x, y: it.y }));
  const bands = new Map();
  for (const n of nums) { const b = Math.round(n.y / 4) * 4; if (!bands.has(b)) bands.set(b, []); bands.get(b).push(n); }
  let axis = null;
  for (const arr of bands.values()) if (arr.length >= 4 && (!axis || arr.length > axis.length)) axis = arr;
  if (!axis) throw new Error('לא זוהה ציר זמן בעמוד — ודא שזו דיאגרמת פאזות של ענבר');
  const N = axis.length;
  const sv = axis.reduce((s, n) => s + n.v, 0), sx = axis.reduce((s, n) => s + n.x, 0);
  const svv = axis.reduce((s, n) => s + n.v * n.v, 0), svx = axis.reduce((s, n) => s + n.v * n.x, 0);
  const scale = (N * svx - sv * sx) / (N * svv - sv * sv);
  const x0 = (sx - scale * sv) / N;
  const T = (x) => (x - x0) / scale; // x -> seconds
  const cycle = Math.max.apply(null, axis.map((n) => n.v));
  if (!(cycle >= 20 && cycle <= 200)) throw new Error('אורך מחזור לא סביר: ' + cycle);
  const mod = (t) => ((t % cycle) + cycle) % cycle;
  const xEnd = x0 + scale * cycle;

  // -- picture letters row + intersection number -------------------------------
  const letters = items.filter((it) => /^[A-Z]$/.test(it.s) && it.x > x0 - 6 && it.x < xEnd + 6).map((it) => ({ pic: it.s, t: mod(T(it.x)) }));
  const interM = /צומת\s+מספר\s*:?\s*(\d+)/.exec(items.map((it) => it.s).join(' '));
  const intersection = interM ? interM[1] : null;

  // -- phase rows (vehicle digits / pedestrian a–z on the left margin) --------
  // Parsed up-front (tolerantly) because the primary lines path also needs the
  // green-bar edges, to tell picture intervals apart from intergreen ones.
  function parsePhaseSegs() {
    const rows = items
      .filter((it) => (/^\d{1,2}$/.test(it.s) || /^[a-z]$/.test(it.s)) && it.x < x0 - 6)
      .map((it) => ({ label: it.s, y: it.y }));
    if (rows.length < 2) throw new Error('לא זוהו שורות מופעים');

    // Inbar's layout (measured): start/end second-markers print ~10pt above the
    // row label's baseline; duration numbers print ~1.3pt above it (inside the bar).
    const phases = [];
    for (const row of rows) {
      const inRow = nums.filter((n) => n.x >= x0 - 6 && n.x <= xEnd + 6 && n.v <= cycle + 1);
      const markers = inRow
        .filter((n) => n.y - row.y > 6 && n.y - row.y < 15 && Math.abs(T(n.x) - n.v) < 3.5)
        .sort((a, b) => a.v - b.v);
      const durations = inRow
        .filter((n) => n.y - row.y > -4 && n.y - row.y < 5)
        .map((n) => ({ v: n.v, t: mod(T(n.x)) }));
      if (markers.length < 2 || markers.length % 2 !== 0) continue;
      const vals = markers.map((m) => m.v);
      // Two possible pairings of the sorted markers (plain vs. one bar wrapping the
      // cycle end). Score each: +1 when a pair's length matches a printed duration,
      // +1 more when that duration number is physically printed INSIDE the pair's
      // bar — the decisive hint when a bar is exactly half a cycle long.
      const pairingA = [], pairingB = [];
      for (let i = 0; i + 1 < vals.length; i += 2) pairingA.push([vals[i], vals[i + 1]]);
      pairingB.push([vals[vals.length - 1], vals[0]]); // wrapped bar
      for (let i = 1; i + 1 < vals.length; i += 2) pairingB.push([vals[i], vals[i + 1]]);
      const insidePair = (t, p) => mod(t - p[0]) < mod(p[1] - p[0] || cycle);
      const score = (pairs) => pairs.reduce((s, p) => {
        const len = mod(p[1] - p[0]);
        let best = 0;
        for (const d of durations) {
          if (Math.abs(d.v - len) <= 1) best = Math.max(best, insidePair(d.t, p) ? 2 : 1);
        }
        return s + best;
      }, 0);
      const segs = (durations.length && score(pairingB) > score(pairingA)) ? pairingB : pairingA;
      phases.push({ label: row.label, segs });
    }
    if (!phases.length) throw new Error('לא נמצאו פסי ירוק במופעים');
    return phases;
  }
  let phasesEarly = null;
  try { phasesEarly = parsePhaseSegs(); } catch (e) { phasesEarly = null; }

  // -- PRIMARY path: Inbar's own blue picture-boundary lines --------------------
  // The interval between two consecutive lines that holds a picture letter IS
  // that picture: left line = zinuk (+), right line = atsira (‡). Intervals
  // without a letter are the intergreen transitions. A picture wrapping the
  // cycle frame line at t=0 is printed with its letter in both fragments —
  // those merge into one window. Verified to reproduce Inbar's own marks 1:1
  // (צומת 66) and the official picture windows and K-transitions (צומת 64).
  //
  // Letter-overflow correction (צומת 72): a picture can be as short as 1s —
  // narrower than its printed letter — so Inbar prints the letter NEXT TO the
  // window, inside the adjacent intergreen interval. Green-bar edges tell the
  // two apart: a picture interval never has a green start/end strictly inside
  // it (any state change opens a new picture), an intergreen interval nearly
  // always does. A letter that landed in a non-clean interval snaps to the
  // nearest clean one (the letter glyph is only ~2s wide).
  try {
    const bxs = await extractInbarBoundaries(page);
    let bts = bxs.map((x) => Math.round(T(x))).filter((t) => t >= 0 && t <= cycle);
    bts = [...new Set(bts.map((t) => t % cycle))].sort((a, b) => a - b);
    if (bts.length >= 3 && letters.length >= 2) {
      const edges = phasesEarly
        ? [...new Set([].concat.apply([], phasesEarly.map((p) => [].concat.apply([], p.segs))).map((v) => mod(v)))]
        : null;
      const EPS = 0.35;
      const isClean = (a, len) =>
        !edges || !edges.some((e) => { const d = mod(e - a); return d > EPS && d < len - EPS; });
      const ivs = bts.map((t, i) => {
        const b = bts[(i + 1) % bts.length];
        const len = mod(b - t) || cycle;
        return { a: t, b, len, clean: isClean(t, len) };
      });
      const byPic = {};
      for (const L of letters) {
        let iv = ivs.find((v) => mod(L.t - v.a) < v.len) || null;
        if (iv && !iv.clean) {
          // letter printed beside a too-narrow window — snap to nearest clean interval
          let best = null, bestD = Infinity;
          for (const v of ivs) {
            if (!v.clean) continue;
            const d = Math.min(mod(L.t - v.b), mod(v.a - L.t));
            if (d < bestD) { bestD = d; best = v; }
          }
          if (best && bestD <= 3) iv = best;
        }
        if (!iv) continue;
        if (!byPic[L.pic]) byPic[L.pic] = [];
        if (!byPic[L.pic].some((q) => q.a === iv.a)) byPic[L.pic].push({ a: iv.a, b: iv.b });
      }
      const points = [];
      for (const pic of Object.keys(byPic).sort()) {
        let ivs2 = byPic[pic];
        if (ivs2.length === 2) { // two fragments split by the frame line at t=0
          const [p, q] = ivs2;
          if (p.b === q.a) ivs2 = [{ a: p.a, b: q.b }];
          else if (q.b === p.a) ivs2 = [{ a: q.a, b: p.b }];
        }
        ivs2.sort((u, v) => (mod(v.b - v.a) || cycle) - (mod(u.b - u.a) || cycle));
        points.push({ pic, start: ivs2[0].a, stop: ivs2[0].b, window: mod(ivs2[0].b - ivs2[0].a) || cycle });
      }
      if (points.length >= 2 && points.every((p) => p.window > 0)) {
        return { cycle, points, method: 'lines', intersection, skipped: [] };
      }
    }
  } catch (e) { console.warn('Inbar boundary-line detection failed — falling back', e); }

  const phases = phasesEarly || parsePhaseSegs();

  // -- FALLBACK 1: official picture composition given ---------------------------
  // The picture's window = the interval where ALL its member phases are green
  // (intersection of the members' green segments on the cycle circle). This is
  // Inbar's own definition — verified to reproduce Inbar's original +/‡ marks
  // exactly on a genuine plan. Phases listed in the composition but absent from
  // this diagram (e.g. a crossing Inbar chose not to draw) are skipped and
  // reported. The letter row is only used to pick between runs when a member
  // set happens to produce more than one all-green interval.
  if (comp) {
    const phaseMap = {};
    for (const ph of phases) phaseMap[ph.label] = ph.segs;
    const covers = (segs, t) => segs.some((sg) => mod(t - sg[0]) < (mod(sg[1] - sg[0]) || cycle));
    const points = [], skipped = [];
    for (const entry of comp) {
      const present = entry.members.filter((mL) => phaseMap[mL]);
      const missing = entry.members.filter((mL) => !phaseMap[mL]);
      if (missing.length) skipped.push(entry.pic + ':' + missing.join(','));
      if (!present.length) throw new Error('תמונה ' + entry.pic + ': אף מופע מההרכב לא נמצא בדיאגרמה (זמינים: ' + phases.map((p) => p.label).join(',') + ')');
      // sample the middle of every second: covered iff all present members green
      const ok = new Array(cycle);
      for (let t = 0; t < cycle; t++) ok[t] = present.every((mL) => covers(phaseMap[mL], t + 0.5));
      if (ok.every(Boolean)) throw new Error('תמונה ' + entry.pic + ': המופעים ירוקים כל המחזור — בדוק את ההרכב');
      // maximal circular runs of covered seconds
      const anchor = ok.findIndex((v) => !v);
      const runs = []; let run = null;
      for (let k = 1; k <= cycle; k++) {
        const idx = (anchor + k) % cycle;
        if (ok[idx]) { if (!run) run = { s: idx, n: 0 }; run.n++; }
        else if (run) { runs.push(run); run = null; }
      }
      if (run) runs.push(run);
      if (!runs.length) throw new Error('לתמונה ' + entry.pic + ' אין חלון שבו כל מופעיה ירוקים יחד — בדוק את ההרכב');
      // prefer the run holding this picture's printed letter; otherwise the longest
      const lts = letters.filter((L) => L.pic === entry.pic).map((L) => L.t);
      const holds = (r) => lts.some((t) => mod(t - r.s) < r.n);
      runs.sort((a, b) => (holds(b) - holds(a)) || (b.n - a.n));
      const w = runs[0];
      points.push({ pic: entry.pic, start: w.s % cycle, stop: (w.s + w.n) % cycle, window: w.n, members: present.length });
    }
    return { cycle, points, method: 'comp', intersection, skipped };
  }

  // -- FALLBACK 2 (heuristic): infer members from the letter position ----------
  // Approximate: a leftover green from the previous picture that overlaps the
  // letter's moment is mistaken for a member and can shrink the window. The
  // official composition (above) is the accurate route.
  if (!letters.length) throw new Error('לא זוהתה שורת התמונות');
  const inSeg = (t, seg) => mod(t - seg[0]) < mod(seg[1] - seg[0] || cycle);
  const windows = {};
  for (const L of letters) {
    let back = Infinity, fwd = Infinity, members = 0;
    for (const ph of phases) {
      const seg = ph.segs.find((sg) => inSeg(L.t, sg));
      if (!seg) continue;
      members++;
      back = Math.min(back, mod(L.t - seg[0]));
      fwd = Math.min(fwd, mod(seg[1] - L.t));
    }
    if (members < 1 || !isFinite(back)) continue;
    const start = mod(L.t - back), len = back + fwd;
    if (!windows[L.pic] || len > windows[L.pic].len) windows[L.pic] = { start, end: mod(start + len), len, members };
  }
  const pics = Object.keys(windows).sort();
  if (!pics.length) throw new Error('לא חושבו חלונות לתמונות');

  // -- manual-operation points per the design rules ----------------------------
  const points = pics.map((p) => {
    const w = windows[p];
    const s = mod(w.start);
    const start = Math.round(mod(Math.ceil(s)));       // window start (zinuk)
    const stop = Math.round(mod(Math.floor(s + w.len))); // window end   (atsira)
    return { pic: p, start, stop, window: Math.round(w.len * 10) / 10, members: w.members };
  });
  return { cycle, points, method: 'letters', intersection, skipped: [] };
}

async function autoManualPoints() {
  let comp = null;
  try { comp = parseComposition(els.manualComp.value); }
  catch (e) { toast(e.message, true); return; }
  showBusy('מנתח את התוכנית…');
  try {
    const res = await analyzeInbarPlan(comp);
    els.manualPoints.value = res.points.map((p) => p.pic + ':' + p.start + '/' + p.stop).join(', ');
    // remember this intersection's composition for next time
    if (comp && res.intersection) {
      try { localStorage.setItem('pw.inbarComp.' + res.intersection, els.manualComp.value.trim()); } catch (e) {}
    }
    const windows = res.points.map((p) => p.pic + '=' + p.window + 's').join(', ');
    if (res.method === 'lines') {
      toast('מחזור ' + res.cycle + ' שנ׳ — נקרא מקווי גבולות התמונות של ענבר (חלונות: ' + windows + '). בדוק ולחץ "סמן".');
    } else if (res.method === 'comp') {
      toast('מחזור ' + res.cycle + ' שנ׳ — קווי הגבולות לא זוהו; חושב לפי הרכב התמונות (חלונות: ' + windows + ')' +
        (res.skipped.length ? '. מופעים שאינם בדיאגרמה דולגו: ' + res.skipped.join(' ') : '') + '. בדוק ולחץ "סמן".');
    } else {
      toast('מחזור ' + res.cycle + ' שנ׳ — קווי הגבולות לא זוהו; חישוב משוער לפי מיקום האותיות (חלונות: ' + windows +
        '). מומלץ לבדוק מול התוכנית. בדוק ולחץ "סמן".', true);
    }
  } catch (e) { console.error(e); toast(e.message, true); }
  finally { hideBusy(); }
}

function openManualModal() {
  els.manualPoints.value = '';
  els.manualModal.hidden = false;
  els.manualPoints.focus();
  // Prefill the saved picture composition for this intersection (best-effort).
  els.manualComp.value = '';
  (async () => {
    try {
      const page = await state.pdfDoc.getPage(state.pageIndex + 1);
      const tc = await page.getTextContent();
      const m = /צומת\s+מספר\s*:?\s*(\d+)/.exec(tc.items.map((i) => (i.str || '').trim()).filter(Boolean).join(' '));
      if (m) {
        const saved = localStorage.getItem('pw.inbarComp.' + m[1]);
        if (saved && !els.manualComp.value) els.manualComp.value = saved;
      }
    } catch (e) {}
  })();
}

async function doManualOps() {
  let pts;
  try { pts = parseManualPoints(els.manualPoints.value); }
  catch (e) { toast(e.message, true); return; }
  els.manualModal.hidden = true;
  showBusy('Marking manual-operation points…');
  try {
    const { cal, manualY, botAxisY } = await calibrateInbarPlan();
    const sizes = await ops.getPageSizes(PDFLib, state.bytes);
    const H = sizes[state.pageIndex].height;
    // Inbar A4 defaults, measured from Inbar 16 output:
    const x0 = cal ? cal.x0 : 79.32;
    const scale = cal ? cal.scale : 3.0609;
    // Vertical placement of the symbols' centre on the ידני.ת row. Best: the
    // label baseline + 2.5pt — Inbar's own +/‡ vector geometry puts the symbol
    // centre 2.47pt above the label baseline (extracted from genuine Inbar 16
    // output). The row floats with the phase count, so when the label can't be
    // read we anchor 86pt above the detected bottom time-axis (holds across
    // layouts to ~±4pt), and only if there is no axis either do we fall back to
    // Inbar's standard A4 row height.
    let y, yApprox = false;
    if (manualY != null) y = manualY + 2.5;
    else if (botAxisY != null) { y = botAxisY + 86; yApprox = true; }
    else { y = H - 575.6; yApprox = true; }
    const mk = (kind, t) => ({
      id: 'man' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      page: state.pageIndex, x: x0 + scale * t, y, kind,
    });
    pushUndo();
    // Re-marking replaces this page's existing app marks (so "change" is clean).
    state.manualMarks = state.manualMarks.filter((m) => m.page !== state.pageIndex);
    for (const p of pts) { state.manualMarks.push(mk('start', p.start), mk('stop', p.stop)); }
    state.selectedAnnId = null;
    renderAnnObjects();
    els.undo.disabled = state.undo.length === 0;
    // Tell the engineer exactly how each axis was resolved, so approximate
    // placements (fallbacks) get a manual check before the plan is saved.
    const xNote = cal ? 'ציר זמן זוהה' : 'ציר לא זוהה — פריסת ברירת מחדל';
    const yNote = manualY != null ? 'שורת ידני.ת זוהתה'
      : botAxisY != null ? 'שורת ידני.ת משוערת (יחסית לציר) — בדוק'
      : 'שורת ידני.ת לא זוהתה — בדוק';
    toast('סומנו ' + pts.length + ' תמונות (' + xNote + '; ' + yNote + ') — ניתן למחוק עד לשמירה',
      (!cal || yApprox));
  } catch (e) { console.error(e); toast(e.message, true); }
  finally { hideBusy(); }
}

// Remove the manual-op marks the app added on THIS page (not yet baked into the
// file). Only the current page is touched — marks on other pages stay put.
// Marks already saved into a PDF and reopened are page content and can't be
// lifted out here — re-marking on a fresh copy is the way to change those.
function clearManualMarks() {
  const n = state.manualMarks.filter((m) => m.page === state.pageIndex).length;
  if (!n) { toast('אין סימוני תפעול שנוספו בגליון הנוכחי (סימונים שכבר נשמרו בקובץ אינם ניתנים למחיקה כאן)'); return; }
  pushUndo();
  state.manualMarks = state.manualMarks.filter((m) => m.page !== state.pageIndex);
  state.selectedAnnId = null;
  renderAnnObjects();
  els.undo.disabled = state.undo.length === 0;
  els.manualModal.hidden = true;
  toast('נמחקו ' + n + ' סימוני תפעול בגליון הנוכחי');
}

// ---- Forms ----------------------------------------------------------------
let formGetters = [];
async function buildForm() {
  formGetters = [];
  els.formFields.innerHTML = '';
  let fields = [];
  try { fields = await ops.getFormFields(PDFLib, state.bytes); } catch (e) { fields = []; }
  const usable = fields.filter((f) => ['text', 'checkbox', 'dropdown', 'optionlist', 'radio'].includes(f.type));
  if (!usable.length) {
    els.formEmpty.hidden = false; els.formActions.hidden = true; return;
  }
  els.formEmpty.hidden = true; els.formActions.hidden = false;

  for (const f of usable) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.name;
    field.appendChild(label);

    if (f.type === 'checkbox') {
      const wrap = document.createElement('label'); wrap.className = 'chk';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!f.value;
      wrap.appendChild(cb); wrap.appendChild(document.createTextNode(' Checked'));
      field.appendChild(wrap);
      formGetters.push(() => [f.name, cb.checked]);
    } else if (f.type === 'dropdown' || f.type === 'optionlist' || f.type === 'radio') {
      const sel = document.createElement('select');
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = '— choose —';
      sel.appendChild(blank);
      (f.options || []).forEach((opt) => {
        const o = document.createElement('option'); o.value = opt; o.textContent = opt;
        if (opt === f.value) o.selected = true;
        sel.appendChild(o);
      });
      field.appendChild(sel);
      formGetters.push(() => [f.name, sel.value]);
    } else {
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'text-input';
      inp.value = f.value || '';
      field.appendChild(inp);
      formGetters.push(() => [f.name, inp.value]);
    }
    els.formFields.appendChild(field);
  }
}
async function applyForm() {
  const values = {};
  for (const get of formGetters) {
    const [name, val] = get();
    if (val === '' || val == null) continue; // don't overwrite with blanks
    values[name] = val;
  }
  const flatten = els.flattenChk.checked;
  showBusy('Applying form values…');
  try {
    const nb = await ops.fillForm(PDFLib, state.bytes, values, flatten);
    pushUndo(); state.bytes = nb;
    await reloadAfterEdit({ rebuildForm: true });
    toast(flatten ? 'Form values applied and flattened' : 'Form values applied');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Tools ----------------------------------------------------------------
const TOOL_OPTIONS = {
  highlight: () => optColorRow('Highlight', ['#ffd54a', '#aef0a1', '#9fd0ff', '#ffb3c1', '#ffa94d', '#d0bfff', '#63e6be', '#ff8787'], 'highlightColor'),
  pen: () => optColorRow('Pen', ['#111111', '#d62828', '#1d3557', '#2a9d8f', '#e8590c', '#6741d9', '#2f9e44', '#1971c2', '#f08c00', '#e64980'], 'penColor')
        + optSlider('Width', 'penWidth', 1, 8, 0.5),
  text: () => optColorRow('Text', ['#111111', '#d62828', '#1d3557', '#2a9d8f', '#e8590c', '#6741d9', '#2f9e44', '#1971c2', '#ffffff'], 'textColor')
        + `<span class="opt-label">Size</span><input class="size-input" id="optTextSize" type="number" min="6" max="96" value="${state.textSize}">`,
  image: () => (state.pendingImage
        ? `<span class="opt-label">"${(state.pendingImage.name || 'image').replace(/</g, '&lt;')}" — drag a box on the page to place it.</span><button class="tbtn" id="optPickImg">Choose another…</button>`
        : `<span class="opt-label">No image loaded yet.</span><button class="tbtn" id="optPickImg">Choose image…</button>`),
  sign: () => `<span class="opt-label">Click the page to place your signature. </span><button class="tbtn" id="optRedraw">Draw new signature</button>`,
  hand: () => '',
};
function optColorRow(label, colors, key) {
  const cur = String(state[key] || '').toLowerCase();
  const sw = colors.map((c) => `<span class="swatch${cur === c.toLowerCase() ? ' active' : ''}" data-key="${key}" data-color="${c}" style="background:${c}"></span>`).join('');
  const isCustom = !colors.some((c) => c.toLowerCase() === cur);
  // A native color picker for any color the swatches don't cover.
  const custom = `<label class="swatch swatch-custom${isCustom ? ' active' : ''}" title="Pick a custom color" style="${isCustom ? 'background:' + state[key] : ''}">`
    + `<input type="color" class="color-input" data-key="${key}" value="${cur || '#000000'}"></label>`;
  return `<span class="opt-label">${label}</span><div class="swatches">${sw}${custom}</div>`;
}
function optSlider(label, key, min, max, step) {
  return `<div class="slider"><span class="opt-label">${label}</span><input type="range" id="opt_${key}" min="${min}" max="${max}" step="${step}" value="${state[key]}"></div>`;
}
// Editable properties for the currently-selected text object (color + size),
// shown in the options strip when the Hand tool has a text selected. This is
// how you recolour/resize text AFTER placing it.
let tpSizeSnapped = false;
function selectedText() { return state.texts.find((x) => x.id === state.selectedTextId) || null; }
function setSelectedTextColor(c) {
  const t = selectedText(); if (!t) return;
  pushUndo(); t.color = c; state.textColor = c;
  renderTextObjects(); renderToolOptions();
}
function renderTextPropsBar() {
  const t = selectedText();
  if (!t) { renderToolOptions(); return; }
  const colors = ['#111111', '#d62828', '#1d3557', '#2a9d8f', '#e8590c', '#6741d9', '#2f9e44', '#1971c2', '#ffffff'];
  const cur = String(t.color || '').toLowerCase();
  const sw = colors.map((c) => `<span class="swatch${cur === c.toLowerCase() ? ' active' : ''}" data-color="${c}" style="background:${c}"></span>`).join('');
  const isCustom = !colors.some((c) => c.toLowerCase() === cur);
  const custom = `<label class="swatch swatch-custom${isCustom ? ' active' : ''}" title="Custom color" style="${isCustom ? 'background:' + t.color : ''}"><input type="color" class="tp-color" value="${cur || '#000000'}"></label>`;
  els.toolOptions.innerHTML =
    '<span class="opt-label">Text color</span><div class="swatches">' + sw + custom + '</div>' +
    '<span class="opt-label">Size</span><input class="size-input" id="tpSize" type="number" min="6" max="200" value="' + Math.round(t.size) + '">' +
    '<button class="tbtn" id="tpEdit">Edit words…</button>' +
    '<button class="tbtn danger" id="tpDel">Delete</button>';
  els.toolOptions.hidden = false;
  els.toolOptions.querySelectorAll('.swatch[data-color]').forEach((s) => {
    s.addEventListener('click', () => setSelectedTextColor(s.dataset.color));
  });
  const ci = els.toolOptions.querySelector('.tp-color');
  if (ci) ci.addEventListener('change', () => setSelectedTextColor(ci.value));
  tpSizeSnapped = false;
  const sz = $('tpSize');
  if (sz) {
    sz.addEventListener('input', () => {
      const cur2 = selectedText(); if (!cur2) return;
      const v = Math.max(4, Math.min(200, parseInt(sz.value || '14', 10) || 14));
      if (!tpSizeSnapped) { pushUndo(); tpSizeSnapped = true; }
      cur2.size = v; state.textSize = v; renderTextObjects();
    });
    sz.addEventListener('change', () => { tpSizeSnapped = false; });
    sz.addEventListener('keydown', (e) => e.stopPropagation());
  }
  const ed = $('tpEdit');
  if (ed) ed.addEventListener('click', () => {
    const box = els.txtLayer.querySelector('.txt-obj[data-id="' + t.id + '"]');
    if (box) editTextObject(t, box);
  });
  const dl = $('tpDel');
  if (dl) dl.addEventListener('click', () => deleteText(t));
}
function renderToolOptions() {
  // A selected text object (Hand tool) gets its own editable properties strip.
  if (state.tool === 'hand' && state.selectedTextId && selectedText()) { renderTextPropsBar(); return; }
  const html = (TOOL_OPTIONS[state.tool] || (() => ''))();
  els.toolOptions.innerHTML = html;
  els.toolOptions.hidden = !html;
  els.toolOptions.querySelectorAll('.swatch[data-color]').forEach((s) => {
    s.addEventListener('click', () => {
      const key = s.dataset.key;
      state[key] = s.dataset.color;
      els.toolOptions.querySelectorAll(`.swatch[data-key="${key}"]`).forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
      const box = els.toolOptions.querySelector(`.swatch-custom input[data-key="${key}"]`);
      if (box) box.parentElement.style.background = '';
    });
  });
  els.toolOptions.querySelectorAll('.color-input').forEach((inp) => {
    const apply = () => {
      const key = inp.dataset.key;
      state[key] = inp.value;
      els.toolOptions.querySelectorAll(`.swatch[data-key="${key}"]`).forEach((x) => x.classList.remove('active'));
      inp.parentElement.classList.add('active');
      inp.parentElement.style.background = inp.value;
    };
    inp.addEventListener('input', apply);
    inp.addEventListener('change', apply);
  });
  const pw = $('opt_penWidth'); if (pw) pw.addEventListener('input', () => { state.penWidth = parseFloat(pw.value); });
  const ts = $('optTextSize'); if (ts) ts.addEventListener('input', () => { state.textSize = Math.max(6, parseInt(ts.value || '14', 10)); });
  const rd = $('optRedraw'); if (rd) rd.addEventListener('click', openSigModal);
  const pi = $('optPickImg'); if (pi) pi.addEventListener('click', pickImage);
}
function selectTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.className = 'tool-' + tool;
  els.toolStatus.textContent = tool === 'hand' ? '' : ('Tool: ' + tool);
  renderToolOptions();
  if (tool === 'sign' && !state.pendingSigPng) openSigModal();
  renderImageObjects();
  renderTextObjects();
  renderAnnObjects();
}

// ---- Overlay interactions (drawing / placing) -----------------------------
let drawing = false;
let startPt = null;     // {x,y} viewport px
let penPts = [];        // viewport px points

function overlayXY(e) {
  const r = els.overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function octx() { return els.overlay.getContext('2d'); }

// Drag-to-pan: scroll the canvas area while the pointer is held down.
// Used by the Hand tool (left button) and by the right mouse button on any tool.
function startPan(e) {
  const area = els.canvasArea;
  const sx = e.clientX, sy = e.clientY;
  const sl = area.scrollLeft, st = area.scrollTop;
  document.body.classList.add('panning');
  const onMove = (ev) => {
    area.scrollLeft = sl - (ev.clientX - sx);
    area.scrollTop  = st - (ev.clientY - sy);
  };
  const onUp = () => {
    document.body.classList.remove('panning');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

els.overlay.addEventListener('pointerdown', (e) => {
  if (!state.pdfDoc) return;
  if (e.button !== 0) return; // right/middle button pans (see canvas-area handler), never draws
  const p = overlayXY(e);
  if (state.tool === 'hand') {
    if (state.selectedImageId || state.selectedTextId || state.selectedAnnId) deselectAll();
    startPan(e); // grab the page and drag to move the view
    return;
  }
  if (state.tool === 'highlight') { drawing = true; startPt = p; els.overlay.setPointerCapture(e.pointerId); }
  else if (state.tool === 'pen') { drawing = true; penPts = [p]; els.overlay.setPointerCapture(e.pointerId); }
  else if (state.tool === 'image') { if (!state.pendingImage) { pickImage(); return; } drawing = true; startPt = p; els.overlay.setPointerCapture(e.pointerId); }
  else if (state.tool === 'text') { placeTextInput(p); }
  else if (state.tool === 'sign') { placeSignature(p); }
});
els.overlay.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = overlayXY(e);
  const ctx = octx();
  if (state.tool === 'highlight') {
    clearOverlay();
    ctx.fillStyle = hexToRgba(state.highlightColor, 0.4);
    ctx.fillRect(Math.min(startPt.x, p.x), Math.min(startPt.y, p.y), Math.abs(p.x - startPt.x), Math.abs(p.y - startPt.y));
  } else if (state.tool === 'pen') {
    // Capture the browser's buffered "coalesced" points too: a single pointermove
    // can hide several intermediate positions on a fast stroke. Using them keeps
    // the recorded path faithful to what the hand actually drew.
    const raw = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [];
    const moves = raw.length ? raw.map(overlayXY) : [p];
    ctx.strokeStyle = state.penColor; ctx.lineWidth = state.penWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const q of moves) {
      const prev = penPts[penPts.length - 1];
      penPts.push(q);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(q.x, q.y); ctx.stroke();
    }
  } else if (state.tool === 'image') {
    clearOverlay();
    ctx.strokeStyle = '#d98a3d'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.min(startPt.x, p.x), Math.min(startPt.y, p.y), Math.abs(p.x - startPt.x), Math.abs(p.y - startPt.y));
    ctx.setLineDash([]);
  }
});
els.overlay.addEventListener('pointerup', async (e) => {
  if (!drawing) return;
  drawing = false;
  const p = overlayXY(e);
  if (state.tool === 'highlight') await commitHighlight(startPt, p);
  else if (state.tool === 'pen') await commitPen(penPts);
  else if (state.tool === 'image') await commitImage(startPt, p);
});

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

async function commitHighlight(a, b) {
  const vp = state.viewport;
  const [x1, y1] = vp.convertToPdfPoint(a.x, a.y);
  const [x2, y2] = vp.convertToPdfPoint(b.x, b.y);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  clearOverlay();
  if (w < 2 || h < 2) return;
  pushUndo();
  state.highlights.push({
    id: 'hl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    page: state.pageIndex,
    x: Math.min(x1, x2), y: Math.min(y1, y2), w, h,
    color: state.highlightColor, opacity: 0.4,
  });
  renderAnnObjects();
}

async function commitPen(points) {
  clearOverlay();
  if (points.length < 2) return;
  const vp = state.viewport;
  const abs = points.map((p) => { const [x, y] = vp.convertToPdfPoint(p.x, p.y); return { x, y }; });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of abs) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(maxX - minX, 0.5), h = Math.max(maxY - minY, 0.5);
  pushUndo();
  state.inks.push({
    id: 'ink' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    page: state.pageIndex,
    ox: minX, oy: minY, w, h,
    points: abs.map((p) => ({ dx: p.x - minX, dy: p.y - minY })), // origin-relative: moving = shifting origin
    color: state.penColor, width: state.penWidth / state.scale,
  });
  renderAnnObjects();
}

// Floating text input committed on Enter / blur
function placeTextInput(p) {
  const existing = els.pageWrap.querySelector('.float-input');
  if (existing) existing.remove();
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'float-input'; inp.dir = 'auto';
  const sizePx = state.textSize * state.scale;
  inp.style.left = p.x + 'px';
  inp.style.top = p.y + 'px';
  inp.style.fontSize = sizePx + 'px';
  inp.style.color = state.textColor;
  inp.style.minWidth = '20px';
  els.pageWrap.appendChild(inp);

  const baselineY = p.y + sizePx; // (kept for reference; baking derives baseline from size)
  let done = false;
  let ready = false; // blocks the spurious blur that fires during initial focus
  const commit = async () => {
    if (done || !ready) return;
    done = true;
    const text = inp.value; inp.remove();
    if (!text.trim()) return;
    const vp = state.viewport;
    const [xLeft, yTop] = vp.convertToPdfPoint(p.x, p.y); // top-left of the box in PDF space
    pushUndo();
    const obj = {
      id: 'txt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      page: state.pageIndex, x: xLeft, yTop, text, size: state.textSize, color: state.textColor,
    };
    state.texts.push(obj);
    state.selectedTextId = obj.id; state.selectedImageId = null;
    selectTool('hand'); // switch to Hand so it can be dragged/resized right away
    toast('Text added — drag it, or its corners to resize');
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must not trigger app shortcuts (h, arrows, …)
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { done = true; inp.remove(); }
  });
  inp.addEventListener('blur', commit);
  // Focus on the next tick: doing it synchronously here lets the click that
  // created the field immediately hand focus back to the page, which blurred
  // and removed the field before anything could be typed.
  setTimeout(() => { inp.focus(); ready = true; }, 0);
}

async function placeSignature(p) {
  if (!state.pendingSigPng) { openSigModal(); return; }
  const vp = state.viewport;
  const widthPt = 180;
  const heightPt = widthPt / (state.pendingSigAspect || 3);
  const [px, pyTop] = vp.convertToPdfPoint(p.x, p.y); // treat click as top-left
  const rect = { page: state.pageIndex, x: px, y: pyTop - heightPt, width: widthPt, height: heightPt, pngBytes: state.pendingSigPng };
  showBusy('Placing signature…');
  try {
    const nb = await ops.stampImages(PDFLib, state.bytes, [rect]);
    pushUndo(); state.bytes = nb; await reloadAfterEdit({});
    toast('Signature placed');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Insert a picture (JPG/PNG) -------------------------------------------
async function pickImage() {
  const res = await window.api.openImage();
  if (!res) return;
  const bytes = new Uint8Array(res.data);
  let size;
  try { size = await ops.imageSize(PDFLib, bytes); }
  catch (e) { toast('That image could not be read (PNG or JPG only)', true); return; }
  state.pendingImage = { bytes, aspect: (size.width / size.height) || 1, name: res.name };
  selectTool('image');
  toast('Drag a box on the page to place "' + res.name + '"');
}

async function commitImage(a, b) {
  if (!state.pendingImage) { clearOverlay(); return; }
  const vp = state.viewport;
  const [x1, y1] = vp.convertToPdfPoint(a.x, a.y);
  const [x2, y2] = vp.convertToPdfPoint(b.x, b.y);
  const left = Math.min(x1, x2), right = Math.max(x1, x2);
  const top = Math.max(y1, y2), bottom = Math.min(y1, y2);
  const ar = state.pendingImage.aspect || 1;
  const rectW = right - left, rectH = top - bottom;
  let drawW, drawH;
  const tinyDrag = Math.abs(b.x - a.x) < 8 || Math.abs(b.y - a.y) < 8;
  if (tinyDrag) { drawW = 200; drawH = 200 / ar; }        // a click => default size
  else if (rectW / rectH > ar) { drawH = rectH; drawW = rectH * ar; } // fit within box
  else { drawW = rectW; drawH = rectW / ar; }
  const x = left, y = top - drawH;
  pushUndo();
  const obj = {
    id: 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    page: state.pageIndex, x, y, w: drawW, h: drawH,
    bytes: state.pendingImage.bytes, aspect: ar,
  };
  state.images.push(obj);
  state.selectedImageId = obj.id;
  clearOverlay();
  selectTool('hand'); // switch to Hand so the picture can be dragged/resized right away
  toast('Image added — drag it, or its corners, to adjust');
}

// ---- Editable image objects (live until saved) ----------------------------
function objUrl(obj) {
  if (obj._url) return obj._url;
  const type = obj.bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
  obj._url = URL.createObjectURL(new Blob([obj.bytes], { type }));
  return obj._url;
}
function imgObjRect(obj, vp) {
  const [ax, ay] = vp.convertToViewportPoint(obj.x, obj.y);                 // bottom-left
  const [bx, by] = vp.convertToViewportPoint(obj.x + obj.w, obj.y + obj.h); // top-right
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}
function renderImageObjects() {
  const layer = els.imgLayer; if (!layer) return;
  layer.innerHTML = '';
  if (!state.viewport) return;
  const vp = state.viewport;
  const editable = state.tool === 'hand';
  for (const obj of state.images) {
    if (obj.page !== state.pageIndex) continue;
    const r = imgObjRect(obj, vp);
    const box = document.createElement('div');
    box.className = 'img-obj' + (obj.id === state.selectedImageId ? ' selected' : '');
    box.dataset.id = obj.id;
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    box.style.pointerEvents = editable ? 'auto' : 'none';
    const img = document.createElement('img'); img.src = objUrl(obj); img.draggable = false;
    box.appendChild(img);
    ['nw', 'ne', 'sw', 'se'].forEach((c) => {
      const h = document.createElement('div'); h.className = 'img-handle ' + c;
      h.addEventListener('pointerdown', (e) => startResize(e, obj, box, c));
      box.appendChild(h);
    });
    const del = document.createElement('button'); del.className = 'img-del'; del.textContent = '✕';
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteImage(obj); });
    box.appendChild(del);
    box.addEventListener('pointerdown', (e) => startMove(e, obj, box));
    layer.appendChild(box);
  }
}
function selectImage(id) {
  state.selectedImageId = id;
  state.selectedTextId = null;
  state.selectedAnnId = null;
  els.imgLayer.querySelectorAll('.img-obj').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  if (els.txtLayer) els.txtLayer.querySelectorAll('.txt-obj').forEach((el) => el.classList.remove('selected'));
  if (els.annLayer) els.annLayer.querySelectorAll('.ann-obj').forEach((el) => el.classList.remove('selected'));
  renderToolOptions();
}
function startMove(e, obj, box) {
  if (state.tool !== 'hand') return;
  e.stopPropagation();
  selectImage(obj.id);
  const vp = state.viewport;
  const rect0 = imgObjRect(obj, vp);
  const startX = e.clientX, startY = e.clientY;
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; } // one undo step per drag
    const nl = rect0.left + (ev.clientX - startX);
    const nt = rect0.top + (ev.clientY - startY);
    box.style.left = nl + 'px'; box.style.top = nt + 'px';
    const [px1, py1] = vp.convertToPdfPoint(nl, nt);
    const [px2, py2] = vp.convertToPdfPoint(nl + rect0.width, nt + rect0.height);
    obj.x = Math.min(px1, px2); obj.y = Math.min(py1, py2); obj.w = Math.abs(px2 - px1); obj.h = Math.abs(py2 - py1);
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function startResize(e, obj, box, corner) {
  if (state.tool !== 'hand') return;
  e.stopPropagation(); e.preventDefault();
  selectImage(obj.id);
  const vp = state.viewport;
  const rect0 = imgObjRect(obj, vp);
  const cssAspect = rect0.width / rect0.height || 1;
  const wrapRect = els.pageWrap.getBoundingClientRect();
  const fixed = {
    x: corner.includes('e') ? rect0.left : rect0.left + rect0.width,
    y: corner.includes('s') ? rect0.top : rect0.top + rect0.height,
  };
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; }
    const cx = ev.clientX - wrapRect.left, cy = ev.clientY - wrapRect.top;
    let w = Math.abs(cx - fixed.x), h = Math.abs(cy - fixed.y);
    if (w / h > cssAspect) h = w / cssAspect; else w = h * cssAspect; // keep aspect ratio
    if (w < 14 || h < 14) return;
    const left = cx < fixed.x ? fixed.x - w : fixed.x;
    const top = cy < fixed.y ? fixed.y - h : fixed.y;
    box.style.left = left + 'px'; box.style.top = top + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    const [px1, py1] = vp.convertToPdfPoint(left, top);
    const [px2, py2] = vp.convertToPdfPoint(left + w, top + h);
    obj.x = Math.min(px1, px2); obj.y = Math.min(py1, py2); obj.w = Math.abs(px2 - px1); obj.h = Math.abs(py2 - py1);
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function deleteImage(obj) {
  pushUndo();
  state.images = state.images.filter((o) => o.id !== obj.id);
  state.selectedImageId = null;
  renderImageObjects();
  toast('Image removed');
}
// Bake live images into a byte copy (used on save and before page ops).
async function applyImages(bytes, images) {
  if (!images.length) return bytes;
  return ops.stampImages(PDFLib, bytes, images.map((o) => (
    { page: o.page, x: o.x, y: o.y, width: o.w, height: o.h, bytes: o.bytes }
  )));
}
async function bakeImages() {
  if (!state.images.length) return;
  state.bytes = await applyImages(state.bytes, state.images);
  state.images = []; state.selectedImageId = null;
}

// ---- Editable text objects (live until saved) -----------------------------
function renderTextObjects() {
  const layer = els.txtLayer; if (!layer) return;
  layer.innerHTML = '';
  if (!state.viewport) return;
  const vp = state.viewport;
  const editable = state.tool === 'hand';   // move / resize / dbl-click to edit
  const textTool = state.tool === 'text';    // single click on existing text re-edits it
  for (const t of state.texts) {
    if (t.page !== state.pageIndex) continue;
    const [lx, ty] = vp.convertToViewportPoint(t.x, t.yTop);
    const box = document.createElement('div');
    box.className = 'txt-obj' + (t.id === state.selectedTextId ? ' selected' : '');
    box.dataset.id = t.id;
    box.style.left = lx + 'px'; box.style.top = ty + 'px';
    box.style.fontSize = (t.size * state.scale) + 'px';
    box.style.color = t.color;
    box.style.pointerEvents = (editable || textTool) ? 'auto' : 'none';
    box.dir = 'auto'; // Hebrew/RTL renders right-to-left like the baked PDF
    box.appendChild(document.createTextNode(t.text));
    if (editable) {
      ['nw', 'ne', 'sw', 'se'].forEach((c) => {
        const h = document.createElement('div'); h.className = 'img-handle ' + c;
        h.addEventListener('pointerdown', (e) => startTextResize(e, t, box, c));
        box.appendChild(h);
      });
      const del = document.createElement('button'); del.className = 'img-del'; del.textContent = '✕';
      del.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteText(t); });
      box.appendChild(del);
      box.addEventListener('pointerdown', (e) => startTextMove(e, t, box));
      box.addEventListener('dblclick', (e) => { e.stopPropagation(); editTextObject(t, box); });
    } else if (textTool) {
      box.style.cursor = 'text';
      // On the Text tool, clicking existing words re-edits them instead of
      // dropping a fresh box on top (the click never reaches the canvas).
      box.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      box.addEventListener('click', (e) => { e.stopPropagation(); selectText(t.id); editTextObject(t, box); });
    }
    layer.appendChild(box);
  }
}
function selectText(id) {
  state.selectedTextId = id;
  state.selectedImageId = null;
  state.selectedAnnId = null;
  els.txtLayer.querySelectorAll('.txt-obj').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  els.imgLayer.querySelectorAll('.img-obj').forEach((el) => el.classList.remove('selected'));
  if (els.annLayer) els.annLayer.querySelectorAll('.ann-obj').forEach((el) => el.classList.remove('selected'));
  renderToolOptions(); // show the selected text's color/size controls
}
function deselectAll() {
  state.selectedImageId = null; state.selectedTextId = null; state.selectedAnnId = null;
  renderImageObjects(); renderTextObjects(); renderAnnObjects();
  renderToolOptions();
}
function startTextMove(e, t, box) {
  if (state.tool !== 'hand') return;
  e.stopPropagation();
  selectText(t.id);
  const vp = state.viewport;
  const rect0 = { left: box.offsetLeft, top: box.offsetTop };
  const startX = e.clientX, startY = e.clientY;
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; }
    const nl = rect0.left + (ev.clientX - startX);
    const nt = rect0.top + (ev.clientY - startY);
    box.style.left = nl + 'px'; box.style.top = nt + 'px';
    const [px, py] = vp.convertToPdfPoint(nl, nt);
    t.x = px; t.yTop = py;
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function startTextResize(e, t, box, corner) {
  if (state.tool !== 'hand') return;
  e.stopPropagation(); e.preventDefault();
  selectText(t.id);
  const vp = state.viewport;
  const wrapRect = els.pageWrap.getBoundingClientRect();
  const rect0 = { left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight };
  const cssAspect = rect0.width / rect0.height || 1;
  const origSize = t.size;
  const fixed = {
    x: corner.includes('e') ? rect0.left : rect0.left + rect0.width,
    y: corner.includes('s') ? rect0.top : rect0.top + rect0.height,
  };
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; }
    const cx = ev.clientX - wrapRect.left, cy = ev.clientY - wrapRect.top;
    let w = Math.abs(cx - fixed.x), h = Math.abs(cy - fixed.y);
    if (w / h > cssAspect) h = w / cssAspect; else w = h * cssAspect; // font scales uniformly
    if (h < 8) return;
    const left = cx < fixed.x ? fixed.x - w : fixed.x;
    const top = cy < fixed.y ? fixed.y - h : fixed.y;
    t.size = Math.max(4, origSize * (h / rect0.height));
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.style.fontSize = (t.size * state.scale) + 'px';
    const [px, py] = vp.convertToPdfPoint(left, top);
    t.x = px; t.yTop = py;
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function editTextObject(t, box) {
  if (state.tool !== 'hand' && state.tool !== 'text') return;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'float-input'; inp.dir = 'auto';
  inp.value = t.text;
  inp.style.left = box.style.left; inp.style.top = box.style.top;
  inp.style.fontSize = box.style.fontSize; inp.style.color = t.color;
  els.pageWrap.appendChild(inp);
  let done = false;
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  const finish = () => {
    if (done) return; done = true;
    const v = inp.value; inp.remove();
    if (v.trim() && v !== t.text) { pushUndo(); t.text = v; }
    renderTextObjects();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') { done = true; inp.remove(); }
  });
  inp.addEventListener('blur', finish);
}
function deleteText(t) {
  pushUndo();
  state.texts = state.texts.filter((o) => o.id !== t.id);
  state.selectedTextId = null;
  renderTextObjects();
  renderToolOptions();
  toast('Text removed');
}
// Bundled Unicode font (Rubik — Hebrew + Latin), decoded once from the base64
// script in vendor/fonts/rubik-font.js. Needed because Helvetica (WinAnsi)
// cannot encode Hebrew; see pdfOps.stampText.
let _hebFontBytes = null;
function hebFontBytes() {
  if (_hebFontBytes) return _hebFontBytes;
  if (!window.PW_FONT_RUBIK) return null;
  const bin = atob(window.PW_FONT_RUBIK);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  _hebFontBytes = arr;
  return arr;
}
async function applyTexts(bytes, texts) {
  if (!texts.length) return bytes;
  const needUni = texts.some((t) => ops.needsUnicodeFont(String(t.text || '')));
  const opts = needUni ? { fontkit: window.fontkit, fontBytes: hebFontBytes() } : undefined;
  if (needUni && (!opts.fontkit || !opts.fontBytes)) {
    throw new Error('Hebrew text support files failed to load (fontkit / bundled font)');
  }
  return ops.stampText(PDFLib, bytes, texts.map((t) => (
    { page: t.page, x: t.x, y: t.yTop - t.size, text: t.text, size: t.size, color: t.color }
  )), opts);
}
// Bake every live overlay (highlights + ink + text + images) into a byte copy.
async function applyOverlays(bytes) {
  let b = bytes;
  if (state.highlights.length) {
    b = await ops.stampHighlights(PDFLib, b, state.highlights.map((h) => (
      { page: h.page, x: h.x, y: h.y, width: h.w, height: h.h, color: h.color, opacity: h.opacity }
    )));
  }
  if (state.inks.length) {
    b = await ops.stampInk(PDFLib, b, state.inks.map((k) => (
      { page: k.page, points: k.points.map((p) => ({ x: k.ox + p.dx, y: k.oy + p.dy })), color: k.color, width: k.width }
    )));
  }
  if (state.manualMarks.length) {
    b = await ops.stampManualOps(PDFLib, b, state.manualMarks.map((m) => (
      { page: m.page, x: m.x, y: m.y, kind: m.kind }
    )));
  }
  b = await applyImages(b, state.images);
  b = await applyTexts(b, state.texts);
  return b;
}
async function bakeAll() {
  if (!state.images.length && !state.texts.length && !state.highlights.length && !state.inks.length && !state.manualMarks.length) return;
  state.bytes = await applyOverlays(state.bytes);
  state.images = []; state.texts = []; state.highlights = []; state.inks = []; state.manualMarks = [];
  state.selectedImageId = null; state.selectedTextId = null; state.selectedAnnId = null;
}

// ---- Live annotation objects (highlights + ink), erasable until saved ------
function addAnnDelete(box, fn) {
  const del = document.createElement('button'); del.className = 'img-del'; del.textContent = '✕';
  del.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  del.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  box.appendChild(del);
}
function renderAnnObjects() {
  const layer = els.annLayer; if (!layer) return;
  layer.innerHTML = '';
  if (!state.viewport) return;
  const vp = state.viewport;
  const editable = state.tool === 'hand';

  for (const h of state.highlights) {
    if (h.page !== state.pageIndex) continue;
    const [ax, ay] = vp.convertToViewportPoint(h.x, h.y);
    const [bx, by] = vp.convertToViewportPoint(h.x + h.w, h.y + h.h);
    const box = document.createElement('div');
    box.className = 'ann-obj ann-hl' + (h.id === state.selectedAnnId ? ' selected' : '');
    box.dataset.id = h.id;
    box.style.left = Math.min(ax, bx) + 'px'; box.style.top = Math.min(ay, by) + 'px';
    box.style.width = Math.abs(bx - ax) + 'px'; box.style.height = Math.abs(by - ay) + 'px';
    box.style.background = hexToRgba(h.color || '#ffd54a', h.opacity == null ? 0.4 : h.opacity);
    box.style.pointerEvents = editable ? 'auto' : 'none';
    ['nw', 'ne', 'sw', 'se'].forEach((c) => {
      const hd = document.createElement('div'); hd.className = 'img-handle ' + c;
      hd.addEventListener('pointerdown', (e) => startAnnResize(e, h, box, c));
      box.appendChild(hd);
    });
    addAnnDelete(box, () => deleteAnn(h.id));
    box.addEventListener('pointerdown', (e) => startAnnMove(e, h, box, 'hl'));
    layer.appendChild(box);
  }

  for (const k of state.inks) {
    if (k.page !== state.pageIndex) continue;
    const [ax, ay] = vp.convertToViewportPoint(k.ox, k.oy);
    const [bx, by] = vp.convertToViewportPoint(k.ox + k.w, k.oy + k.h);
    const left = Math.min(ax, bx), top = Math.min(ay, by);
    const wpx = Math.max(Math.abs(bx - ax), 2), hpx = Math.max(Math.abs(by - ay), 2);
    const box = document.createElement('div');
    box.className = 'ann-obj ann-ink' + (k.id === state.selectedAnnId ? ' selected' : '');
    box.dataset.id = k.id;
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.style.width = wpx + 'px'; box.style.height = hpx + 'px';
    box.style.pointerEvents = editable ? 'auto' : 'none';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', '0 0 ' + wpx + ' ' + hpx);
    // The stroke centerline reaches the box edges, so half its width sits outside
    // the SVG viewport. Without this it gets clipped and the line looks thinner
    // (or missing) along the edges of the stroke.
    svg.style.display = 'block'; svg.style.pointerEvents = 'none'; svg.style.overflow = 'visible';
    const sx = wpx / (k.w || 1), sy = hpx / (k.h || 1);
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', k.points.map((p) => (p.dx * sx).toFixed(1) + ',' + ((k.h - p.dy) * sy).toFixed(1)).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', k.color || '#d62828');
    pl.setAttribute('stroke-width', String(Math.max(1, (k.width || 2) * state.scale)));
    pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pl);
    box.appendChild(svg);
    addAnnDelete(box, () => deleteAnn(k.id));
    box.addEventListener('pointerdown', (e) => startAnnMove(e, k, box, 'ink'));
    layer.appendChild(box);
  }

  // Inbar manual-op marks: red '+' (start) / '‡' (stop), drawn to Inbar's own
  // geometry. Live and deletable until saved (then baked via stampManualOps).
  const sc = state.scale || 1;
  const W = 1.32 * sc, V = 3.06 * sc, H = 2.28 * sc, VS = 1.2 * sc, HS = 1.8 * sc;
  for (const m of state.manualMarks) {
    if (m.page !== state.pageIndex) continue;
    const [cx, cy] = vp.convertToViewportPoint(m.x, m.y);
    const halfW = Math.max(H, VS) + 9, halfH = V + 9; // padding makes it clickable
    const bw = 2 * halfW, bh = 2 * halfH;
    const box = document.createElement('div');
    box.className = 'ann-obj ann-mark' + (m.id === state.selectedAnnId ? ' selected' : '');
    box.dataset.id = m.id;
    box.style.left = (cx - halfW) + 'px'; box.style.top = (cy - halfH) + 'px';
    box.style.width = bw + 'px'; box.style.height = bh + 'px';
    box.style.pointerEvents = editable ? 'auto' : 'none';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', '0 0 ' + bw + ' ' + bh);
    svg.style.display = 'block'; svg.style.pointerEvents = 'none'; svg.style.overflow = 'visible';
    const RED = '#e10600', SW = String(Math.max(1, W));
    const seg = (x1, y1, x2, y2) => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1.toFixed(1)); l.setAttribute('y1', y1.toFixed(1));
      l.setAttribute('x2', x2.toFixed(1)); l.setAttribute('y2', y2.toFixed(1));
      l.setAttribute('stroke', RED); l.setAttribute('stroke-width', SW); l.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(l);
    };
    if (m.kind === 'start') {
      seg(halfW, halfH - V, halfW, halfH + V);
      seg(halfW - H, halfH, halfW + H, halfH);
    } else {
      seg(halfW - VS, halfH - V, halfW - VS, halfH + V);
      seg(halfW + VS, halfH - V, halfW + VS, halfH + V);
      seg(halfW - H, halfH - HS, halfW + H, halfH - HS);
      seg(halfW - H, halfH + HS, halfW + H, halfH + HS);
    }
    box.appendChild(svg);
    addAnnDelete(box, () => deleteAnn(m.id));
    box.addEventListener('pointerdown', (e) => { if (state.tool === 'hand') { e.stopPropagation(); selectAnn(m.id); } });
    layer.appendChild(box);
  }
}
function selectAnn(id) {
  state.selectedAnnId = id;
  state.selectedImageId = null; state.selectedTextId = null;
  els.annLayer.querySelectorAll('.ann-obj').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  els.imgLayer.querySelectorAll('.img-obj').forEach((el) => el.classList.remove('selected'));
  els.txtLayer.querySelectorAll('.txt-obj').forEach((el) => el.classList.remove('selected'));
  renderToolOptions();
}
function deleteAnn(id) {
  pushUndo();
  state.highlights = state.highlights.filter((o) => o.id !== id);
  state.inks = state.inks.filter((o) => o.id !== id);
  state.manualMarks = state.manualMarks.filter((o) => o.id !== id);
  state.selectedAnnId = null;
  renderAnnObjects();
  toast('Annotation removed');
}
function startAnnMove(e, obj, box, kind) {
  if (state.tool !== 'hand') return;
  e.stopPropagation();
  selectAnn(obj.id);
  const vp = state.viewport;
  const start = { left: box.offsetLeft, top: box.offsetTop, x: e.clientX, y: e.clientY, w: box.offsetWidth, h: box.offsetHeight };
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; }
    const nl = start.left + (ev.clientX - start.x);
    const nt = start.top + (ev.clientY - start.y);
    box.style.left = nl + 'px'; box.style.top = nt + 'px';
    const [px1, py1] = vp.convertToPdfPoint(nl, nt);
    const [px2, py2] = vp.convertToPdfPoint(nl + start.w, nt + start.h);
    const x = Math.min(px1, px2), y = Math.min(py1, py2);
    if (kind === 'hl') { obj.x = x; obj.y = y; }
    else { obj.ox = x; obj.oy = y; }
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
function startAnnResize(e, h, box, corner) { // highlights only; free aspect
  if (state.tool !== 'hand') return;
  e.stopPropagation(); e.preventDefault();
  selectAnn(h.id);
  const vp = state.viewport;
  const wrapRect = els.pageWrap.getBoundingClientRect();
  const r0 = { left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight };
  const fixed = {
    x: corner.includes('e') ? r0.left : r0.left + r0.width,
    y: corner.includes('s') ? r0.top : r0.top + r0.height,
  };
  let snapped = false;
  const onMove = (ev) => {
    if (!snapped) { pushUndo(); snapped = true; }
    const cx = ev.clientX - wrapRect.left, cy = ev.clientY - wrapRect.top;
    const w = Math.max(6, Math.abs(cx - fixed.x)), hh = Math.max(6, Math.abs(cy - fixed.y));
    const left = cx < fixed.x ? fixed.x - w : fixed.x;
    const top = cy < fixed.y ? fixed.y - hh : fixed.y;
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.style.width = w + 'px'; box.style.height = hh + 'px';
    const [px1, py1] = vp.convertToPdfPoint(left, top);
    const [px2, py2] = vp.convertToPdfPoint(left + w, top + hh);
    h.x = Math.min(px1, px2); h.y = Math.min(py1, py2);
    h.w = Math.abs(px2 - px1); h.h = Math.abs(py2 - py1);
  };
  const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// ---- Signature capture modal ---------------------------------------------
let sigDrawing = false, sigHasInk = false, sigCtx = null;
let sigBounds = null;
function initSigPad() {
  sigCtx = els.sigPad.getContext('2d');
  sigCtx.clearRect(0, 0, els.sigPad.width, els.sigPad.height);
  sigCtx.strokeStyle = '#101418'; sigCtx.lineWidth = 2.4; sigCtx.lineJoin = 'round'; sigCtx.lineCap = 'round';
  sigHasInk = false; sigBounds = null;
}
function sigXY(e) {
  const r = els.sigPad.getBoundingClientRect();
  const sx = els.sigPad.width / r.width, sy = els.sigPad.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}
function noteBounds(p) {
  if (!sigBounds) sigBounds = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
  else {
    sigBounds.minX = Math.min(sigBounds.minX, p.x); sigBounds.minY = Math.min(sigBounds.minY, p.y);
    sigBounds.maxX = Math.max(sigBounds.maxX, p.x); sigBounds.maxY = Math.max(sigBounds.maxY, p.y);
  }
}
function openSigModal() { els.sigModal.hidden = false; initSigPad(); }
els.sigPad.addEventListener('pointerdown', (e) => { sigDrawing = true; const p = sigXY(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); noteBounds(p); els.sigPad.setPointerCapture(e.pointerId); });
els.sigPad.addEventListener('pointermove', (e) => { if (!sigDrawing) return; const p = sigXY(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); sigHasInk = true; noteBounds(p); });
els.sigPad.addEventListener('pointerup', () => { sigDrawing = false; });
els.sigClear.addEventListener('click', initSigPad);
els.sigCancel.addEventListener('click', () => { els.sigModal.hidden = true; });
els.sigUse.addEventListener('click', () => {
  if (!sigHasInk) { toast('Draw your signature first', true); return; }
  // Trim to ink bounds (with padding) so placement isn't mostly empty space.
  const pad = 8;
  const b = sigBounds;
  const sx = Math.max(0, Math.floor(b.minX - pad));
  const sy = Math.max(0, Math.floor(b.minY - pad));
  const sw = Math.min(els.sigPad.width - sx, Math.ceil(b.maxX - b.minX + pad * 2));
  const sh = Math.min(els.sigPad.height - sy, Math.ceil(b.maxY - b.minY + pad * 2));
  const out = document.createElement('canvas'); out.width = sw; out.height = sh;
  out.getContext('2d').drawImage(els.sigPad, sx, sy, sw, sh, 0, 0, sw, sh);
  const dataUrl = out.toDataURL('image/png');
  state.pendingSigPng = dataUrlToBytes(dataUrl);
  state.pendingSigAspect = sw / sh;
  els.sigModal.hidden = true;
  selectTool('sign');
  toast('Signature ready — click the page to place it');
});
function dataUrlToBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ---- Save -----------------------------------------------------------------
async function savePdf() {
  if (!state.bytes) return;
  const suggested = state.name.replace(/\.pdf$/i, '') + '-edited.pdf';
  showBusy('Saving…');
  try {
    const out = await applyOverlays(state.bytes);
    const saved = await window.api.savePdf(out, suggested);
    if (saved) toast('Saved ' + saved.split(/[\\/]/).pop());
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Zoom -----------------------------------------------------------------
function zoom(delta) {
  state.scale = Math.max(0.3, Math.min(3, Math.round((state.scale + delta) * 100) / 100));
  renderPage();
}

// ---- Wiring ---------------------------------------------------------------
els.open.addEventListener('click', openPdf);
els.open2.addEventListener('click', openPdf);
els.save.addEventListener('click', savePdf);
els.merge.addEventListener('click', openInsertModal);
els.split.addEventListener('click', openRangeModal);
els.undo.addEventListener('click', undo);
els.zoomIn.addEventListener('click', () => zoom(0.15));
els.zoomOut.addEventListener('click', () => zoom(-0.15));
els.applyForm.addEventListener('click', applyForm);
els.rangeCancel.addEventListener('click', () => { els.rangeModal.hidden = true; });
els.rangeGo.addEventListener('click', doExtract);
els.rangeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doExtract(); });
els.insertCancel.addEventListener('click', () => { els.insertModal.hidden = true; });
els.insertGo.addEventListener('click', doInsert);
els.manualOp.addEventListener('click', openManualModal);
els.manualCancel.addEventListener('click', () => { els.manualModal.hidden = true; });
els.manualGo.addEventListener('click', doManualOps);
els.manualAuto.addEventListener('click', autoManualPoints);
els.manualClear.addEventListener('click', clearManualMarks);
els.manualPoints.addEventListener('keydown', (e) => { if (e.key === 'Enter') doManualOps(); });
els.insertAfter.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInsert(); });
els.gotoPage.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(els.gotoPage.value, 10);
  if (n >= 1 && n <= state.pageCount) { state.pageIndex = n - 1; renderPage(); }
  else els.gotoPage.value = String(state.pageIndex + 1);
});
els.gotoPage.addEventListener('blur', () => { if (state.pdfDoc) els.gotoPage.value = String(state.pageIndex + 1); });
els.zoomInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(String(els.zoomInput.value).replace('%', '').trim(), 10);
  if (Number.isInteger(n) && n >= 30 && n <= 300) { state.scale = n / 100; renderPage(); }
  else { toast('Zoom must be between 30 and 300', true); els.zoomInput.value = String(Math.round(state.scale * 100)); }
});
els.zoomInput.addEventListener('blur', () => { if (state.pdfDoc) els.zoomInput.value = String(Math.round(state.scale * 100)); });

// Multi-page selection bar (in the thumbnail rail)
els.selDelete.addEventListener('click', deleteSelectedPages);
els.selClear.addEventListener('click', clearPageSelection);
els.selMove.addEventListener('click', () => {
  els.selMoveInput.hidden = !els.selMoveInput.hidden;
  if (!els.selMoveInput.hidden) { els.selMoveInput.value = ''; els.selMoveInput.focus(); }
});
els.selMoveInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { els.selMoveInput.hidden = true; return; }
  if (e.key !== 'Enter') return;
  const n = parseInt(els.selMoveInput.value, 10);
  if (!Number.isInteger(n) || n < 1 || n > state.pageCount) {
    toast('Enter a page between 1 and ' + state.pageCount, true); return;
  }
  els.selMoveInput.hidden = true;
  moveSelectedPagesTo(n - 1);
});

document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) selectTool(b.dataset.tool); }));
document.querySelectorAll('.ptab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.ptab-pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.ptab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
  });
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing && !mod) return; // let the field handle its own keys
  // Match on e.code (the physical key) so shortcuts fire on non-Latin keyboard
  // layouts too — on a Hebrew layout e.key for the Z key is 'ז', not 'z'.
  if (mod && e.code === 'KeyO') { e.preventDefault(); openPdf(); }
  else if (mod && e.code === 'KeyS') { e.preventDefault(); savePdf(); }
  else if (mod && e.code === 'KeyZ') { e.preventDefault(); undo(); }
  else if (!state.pdfDoc) return;
  else if (mod && (e.code === 'Equal' || e.key === '+')) { e.preventDefault(); zoom(0.15); }
  else if (mod && e.code === 'Minus') { e.preventDefault(); zoom(-0.15); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && (state.selectedImageId || state.selectedTextId || state.selectedAnnId)) { e.preventDefault(); nudgeSelected(e); }
  else if (e.key === 'PageDown' || e.key === 'ArrowRight') { if (state.pageIndex < state.pageCount - 1) { state.pageIndex++; renderPage(); } }
  else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { if (state.pageIndex > 0) { state.pageIndex--; renderPage(); } }
  else if (e.key === 'Delete' && (state.selectedImageId || state.selectedTextId || state.selectedAnnId)) {
    if (state.selectedImageId) { const o = state.images.find((x) => x.id === state.selectedImageId); if (o) deleteImage(o); }
    else if (state.selectedTextId) { const o = state.texts.find((x) => x.id === state.selectedTextId); if (o) deleteText(o); }
    else deleteAnn(state.selectedAnnId);
  }
  else if (e.key === 'Delete' && state.selectedPages.size) deleteSelectedPages();
  else if (e.code === 'KeyH') selectTool('hand');
});

// Re-fit on window resize when a doc is open and scale was auto.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(), 150);
});

// ---- Drag & drop image files from the OS (Explorer / Finder) --------------
function isImageFile(f) {
  if (!f) return false;
  if (f.type === 'image/png' || f.type === 'image/jpeg') return true;
  return /\.(png|jpe?g)$/i.test(f.name || '');
}
function isFileDrag(e) {
  const t = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
  return t.includes('Files');
}
// Registered on `document` in the CAPTURE phase so preventDefault runs *first*,
// before the scrollable canvas area (or any element) can swallow the event —
// that swallowing is what made the OS show a "no-drop" cursor. We only claim a
// 'copy' effect for real file drags, so internal thumbnail re-ordering (which
// uses a 'move' effect) keeps working untouched.
let dropHintTimer = null;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (isFileDrag(e)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (state.pdfDoc) {
      els.dropHint.hidden = false;
      clearTimeout(dropHintTimer);
      dropHintTimer = setTimeout(() => { els.dropHint.hidden = true; }, 160); // hides once the drag stops/leaves
    }
  }
}, true);
document.addEventListener('dragenter', (e) => { e.preventDefault(); }, true);
function isPdfFile(f) {
  if (!f) return false;
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
}
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearTimeout(dropHintTimer); els.dropHint.hidden = true;
  const all = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const pdfs = all.filter(isPdfFile);
  const images = all.filter(isImageFile);
  if (pdfs.length) { await dropPdfs(pdfs); return; }
  if (!images.length) return; // internal (thumbnail) drop, or nothing usable — let it be
  if (!state.pdfDoc) { toast('Open a PDF first, then drop the image', true); return; }
  await dropImages(images, e.clientX, e.clientY);
}, true);

// Drop one or many PDFs onto the window: with no document open, the first one
// opens and the rest are appended; with a document open, all are appended.
async function dropPdfs(files) {
  showBusy(files.length === 1 ? 'Opening…' : 'Adding ' + files.length + ' PDFs…');
  try {
    const list = [];
    for (const f of files) {
      try { list.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }); }
      catch (err) { toast('Could not read ' + f.name, true); }
    }
    if (!list.length) return;
    if (!state.pdfDoc) {
      state.bytes = list[0].data;
      state.name = list[0].name || 'document.pdf';
      state.undo = [];
      state.images = []; state.texts = []; state.highlights = []; state.inks = []; state.manualMarks = [];
      state.selectedImageId = null; state.selectedTextId = null; state.selectedAnnId = null;
      state.selectedPages.clear();
      els.undo.disabled = true;
      state.pageIndex = 0;
      state.scale = 0;
      if (list.length > 1) {
        state.bytes = await ops.insertPdfsAt(PDFLib, state.bytes, list.slice(1).map((x) => x.data), Infinity);
      }
      await loadDoc({ rebuildForm: true, fit: true });
      els.emptyState.hidden = true;
      els.stage.hidden = false;
      setDocActionsEnabled(true);
      els.docName.textContent = state.name;
      selectTool('hand');
      toast(list.length === 1 ? ('Opened ' + state.name)
        : ('Opened ' + state.name + ' + ' + (list.length - 1) + ' more appended'));
    } else {
      pushUndo(); await bakeAll();
      const firstNew = state.pageCount;
      state.bytes = await ops.insertPdfsAt(PDFLib, state.bytes, list.map((x) => x.data), state.pageCount);
      state.pageIndex = firstNew; // jump to the first appended page
      await reloadAfterEdit({ rebuildForm: true });
      toast(list.length === 1 ? 'PDF appended at the end' : list.length + ' PDFs appended at the end');
    }
  } catch (err) { toast(err.message, true); } finally { hideBusy(); }
}

async function dropImages(files, clientX, clientY) {
  const vp = state.viewport;
  const wrapRect = els.pageWrap.getBoundingClientRect();
  const overPage = clientX >= wrapRect.left && clientX <= wrapRect.right &&
                   clientY >= wrapRect.top && clientY <= wrapRect.bottom;
  showBusy(files.length > 1 ? 'Adding images…' : 'Adding image…');
  try {
    pushUndo();
    let added = 0, i = 0;
    for (const file of files) {
      let bytes;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (err) { continue; }
      let size;
      try { size = await ops.imageSize(PDFLib, bytes); }
      catch (err) { toast('Skipped a file that is not a valid PNG/JPG', true); continue; }
      const ar = (size.width / size.height) || 1;
      const widthPt = 200, heightPt = widthPt / ar;
      let vx, vy; // drop point in page-relative pixels
      if (overPage) {
        vx = clientX - wrapRect.left + i * 16;
        vy = clientY - wrapRect.top + i * 16;
      } else { // dropped off the page -> centre of the current page
        vx = wrapRect.width / 2 - (widthPt * state.scale) / 2 + i * 16;
        vy = wrapRect.height / 2 - (heightPt * state.scale) / 2 + i * 16;
      }
      const [px, pyTop] = vp.convertToPdfPoint(vx, vy); // treat as top-left
      const obj = {
        id: 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        page: state.pageIndex, x: px, y: pyTop - heightPt, w: widthPt, h: heightPt, bytes, aspect: ar,
      };
      state.images.push(obj);
      state.selectedImageId = obj.id; state.selectedTextId = null;
      added++; i++;
    }
    if (!added) { state.undo.pop(); els.undo.disabled = state.undo.length === 0; } // drop had nothing usable
    selectTool('hand');
    renderImageObjects();
    if (added) toast(added > 1 ? (added + ' images added') : 'Image added — drag it, or its corners, to adjust');
  } catch (err) { toast(err.message, true); } finally { hideBusy(); }
}

// ---- Nudge a selected object with the arrow keys ---------------------------
let nudgeSnapped = false, nudgeTimer = null;
function nudgeSelected(e) {
  const step = e.shiftKey ? 10 : 2; // PDF points
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = step;      // PDF y grows upward
  else if (e.key === 'ArrowDown') dy = -step;
  if (!nudgeSnapped) { pushUndo(); nudgeSnapped = true; } // one undo per burst
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { nudgeSnapped = false; }, 900);
  if (state.selectedImageId) {
    const o = state.images.find((x) => x.id === state.selectedImageId);
    if (o) { o.x += dx; o.y += dy; renderImageObjects(); }
  } else if (state.selectedTextId) {
    const t = state.texts.find((x) => x.id === state.selectedTextId);
    if (t) { t.x += dx; t.yTop += dy; renderTextObjects(); }
  } else if (state.selectedAnnId) {
    const h = state.highlights.find((x) => x.id === state.selectedAnnId);
    const k = state.inks.find((x) => x.id === state.selectedAnnId);
    const m = state.manualMarks.find((x) => x.id === state.selectedAnnId);
    if (h) { h.x += dx; h.y += dy; }
    else if (k) { k.ox += dx; k.oy += dy; }
    else if (m) { m.x += dx; m.y += dy; }
    renderAnnObjects();
  }
}

// Ctrl + mouse wheel zoom over the document.
els.canvasArea.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pdfDoc) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

// Hold the right mouse button to pan the view — works with every tool, so you
// can move around mid-annotation without switching to the Hand tool.
els.canvasArea.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || !state.pdfDoc) return;
  e.preventDefault();
  startPan(e);
});
els.canvasArea.addEventListener('contextmenu', (e) => {
  if (state.pdfDoc) e.preventDefault(); // right button is the pan gesture here
});

// ---- Extraction: selectable text layer -------------------------------------
let textLayerTask = null;
async function renderTextSelectLayer(page, viewport) {
  const layer = els.textSel;
  layer.innerHTML = '';
  layer.style.setProperty('--scale-factor', viewport.scale); // pdf.js 3.x sizing var
  if (textLayerTask) { try { textLayerTask.cancel(); } catch (e) {} textLayerTask = null; }
  const textContent = await page.getTextContent();
  textLayerTask = pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: layer,
    viewport,
    textDivs: [],
  });
  await textLayerTask.promise;
}

// ---- Extraction: text -------------------------------------------------------
function textFromContent(tc) {
  return tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
}
async function copyPageText() {
  if (!state.pdfDoc) { toast('Open a PDF first', true); return; }
  showBusy('Reading text…');
  try {
    const page = await state.pdfDoc.getPage(state.pageIndex + 1);
    const text = textFromContent(await page.getTextContent());
    if (!text.trim()) { toast('No selectable text on this page (it may be a scan)', true); return; }
    await navigator.clipboard.writeText(text);
    toast('Page text copied to clipboard');
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}
async function saveAllText() {
  if (!state.pdfDoc) { toast('Open a PDF first', true); return; }
  showBusy('Reading all pages…');
  try {
    const parts = [];
    for (let i = 1; i <= state.pageCount; i++) {
      const page = await state.pdfDoc.getPage(i);
      parts.push(textFromContent(await page.getTextContent()));
    }
    const all = parts.join('\n\n');
    if (!all.trim()) { toast('No selectable text in this document (it may be a scan)', true); return; }
    const bytes = new TextEncoder().encode(all);
    const suggested = state.name.replace(/\.pdf$/i, '') + '-text.txt';
    const saved = await window.api.saveFile(bytes, suggested, 'Text', ['txt']);
    if (saved) toast('Saved ' + saved.split(/[\\/]/).pop());
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// ---- Convert to Word (.docx) ----------------------------------------------
// Extracts the PDF's text into an editable Word document. Paragraph structure
// and right-to-left direction (Hebrew) are preserved; exact layout is not (no
// client-only converter can reliably reproduce tables/positions/images). For
// scanned/flattened PDFs with no text layer, bundled OCR (Tesseract, Hebrew +
// English) reads the text out of the page images — entirely offline.
const HEB_AR = /[֐-׿؀-ۿ]/;

// Resolve the vendor/ base the same way the other bundled libs are loaded, so
// this works both on the desktop build (../vendor/) and the web build (vendor/).
const VENDOR_BASE = (() => {
  const s = document.querySelector('script[src*="vendor/pdf-lib"], script[src*="vendor/pdfjs"]');
  const src = s ? s.getAttribute('src') : 'vendor/pdf-lib/pdf-lib.min.js';
  const rel = src.replace(/vendor\/.*$/, 'vendor/');
  // Must be ABSOLUTE: tesseract spawns a blob worker, and relative URLs are
  // invalid inside it (works for both http on the web and file:// in Electron).
  return new URL(rel, location.href).href;
})();
let _ocrWorker = null;
async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker;
  if (!window.Tesseract) throw new Error('OCR engine is not loaded');
  _ocrWorker = await Tesseract.createWorker('heb+eng', 1, {
    workerPath: VENDOR_BASE + 'tesseract/worker.min.js',
    corePath: VENDOR_BASE + 'tesseract',
    langPath: VENDOR_BASE + 'tesseract/lang',
    gzip: true,
  });
  await _ocrWorker.setParameters({
    tessedit_pageseg_mode: '3',      // fully automatic page segmentation
    preserve_interword_spaces: '1',  // keep spacing between words
  });
  return _ocrWorker;
}
// Render a page to a high-resolution, grayscale, contrast-boosted canvas — this
// roughly doubles OCR accuracy on scanned documents versus a plain screen-res
// render (verified: "משה" read correctly instead of "awn").
function renderPageForOcr(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(2, 2000 / base.width)); // ~2000px wide
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  return page.render({ canvasContext: ctx, viewport: vp }).promise.then(() => {
    const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      v = (v - 128) * 1.4 + 128;               // boost contrast
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(im, 0, 0);
    return c;
  });
}
// OCR every page into docx paragraphs (renders each page to its own canvas,
// so it never collides with the main viewer canvas).
async function ocrDocumentToParas() {
  const paras = [];
  els.busyMsg.textContent = 'טוען מנוע OCR…';
  const worker = await getOcrWorker();
  for (let i = 1; i <= state.pageCount; i++) {
    if (i > 1) paras.push({ pageBreak: true });
    els.busyMsg.textContent = 'OCR — עמוד ' + i + ' מתוך ' + state.pageCount + '…';
    const page = await state.pdfDoc.getPage(i);
    const c = await renderPageForOcr(page);
    const res = await worker.recognize(c);
    const text = (res && res.data && res.data.text) ? res.data.text : '';
    for (const raw of text.split('\n')) {
      // collapse the huge runs of spaces that flattened table columns produce
      const line = raw.replace(/\s+$/, '').replace(/ {3,}/g, '  ');
      paras.push({ text: line, rtl: HEB_AR.test(line) });
    }
  }
  return paras;
}
async function exportToWord() {
  if (!state.pdfDoc) { toast('Open a PDF first', true); return; }
  showBusy('Converting to Word…');
  try {
    const paras = [];
    let anyText = false;
    for (let i = 1; i <= state.pageCount; i++) {
      if (i > 1) paras.push({ pageBreak: true });
      const page = await state.pdfDoc.getPage(i);
      const text = textFromContent(await page.getTextContent());
      for (const raw of text.split('\n')) {
        const line = raw.replace(/[ \t]+$/, '');
        if (line.trim()) anyText = true;
        paras.push({ text: line, rtl: HEB_AR.test(line) });
      }
    }
    if (!anyText) {
      // Distinguish the common case for a clearer flow: pages that are just
      // one big raster image (scan / flattened export) vs. genuinely empty.
      let looksScanned = false;
      try {
        const p1 = await state.pdfDoc.getPage(state.pageIndex + 1);
        const opl = await p1.getOperatorList();
        const O = pdfjsLib.OPS;
        let imgs = 0;
        for (const fn of opl.fnArray) if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) imgs++;
        looksScanned = imgs > 0;
      } catch (e) {}
      if (!looksScanned || !window.Tesseract) {
        toast(looksScanned
          ? 'This PDF\'s pages are pictures and the OCR engine failed to load'
          : 'No selectable text found in this PDF', true);
        return;
      }
      // Scanned/flattened PDF -> offer bundled OCR (Hebrew + English, offline).
      const go = window.confirm(
        'אין שכבת טקסט בקובץ — העמודים הם תמונות (סריקה או ייצוא משוטח).\n' +
        'להריץ OCR (זיהוי תווים אופטי, עברית + אנגלית)? הכול מקומי במחשב.\n' +
        'זה עשוי לקחת עד דקה לעמוד, ודיוק הזיהוי תלוי באיכות הסריקה.');
      if (!go) return;
      const ocrParas = await ocrDocumentToParas();
      if (!ocrParas.some((p) => p.text && p.text.trim())) {
        toast('ה-OCR לא זיהה טקסט בקובץ', true);
        return;
      }
      const ob = ops.buildDocx(ocrParas);
      const osug = state.name.replace(/\.pdf$/i, '') + '.docx';
      const osaved = await window.api.saveFile(ob, osug, 'Word document', ['docx']);
      if (osaved) toast('Saved ' + osaved.split(/[\\/]/).pop() + ' (OCR)');
      return;
    }
    const bytes = ops.buildDocx(paras);
    const suggested = state.name.replace(/\.pdf$/i, '') + '.docx';
    const saved = await window.api.saveFile(bytes, suggested, 'Word document', ['docx']);
    if (saved) toast('Saved ' + saved.split(/[\\/]/).pop());
  } catch (e) {
    // tesseract can reject with a plain string / ErrorEvent, not an Error
    toast((e && e.message) || String(e) || 'ההמרה נכשלה', true);
  } finally { hideBusy(); }
}

// ---- Extraction: embedded images -------------------------------------------
// Convert a pdf.js image object ({width,height,data,kind} or {bitmap}) to a canvas.
function pdfjsImageToCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return canvas; }
  if (!img.data) return null;
  const { width, height, data, kind } = img;
  const out = ctx.createImageData(width, height);
  if (kind === 3) {            // RGBA_32BPP
    out.data.set(data);
  } else if (kind === 2) {     // RGB_24BPP
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      out.data[j] = data[i]; out.data[j + 1] = data[i + 1]; out.data[j + 2] = data[i + 2]; out.data[j + 3] = 255;
    }
  } else if (kind === 1) {     // GRAYSCALE_1BPP (rows padded to whole bytes)
    const rowBytes = Math.ceil(width / 8);
    let j = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        out.data[j++] = v; out.data[j++] = v; out.data[j++] = v; out.data[j++] = 255;
      }
    }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return canvas;
}

async function scanPageImages() {
  if (!state.pdfDoc) { toast('Open a PDF first', true); return; }
  showBusy('Scanning page for images…');
  try {
    const page = await state.pdfDoc.getPage(state.pageIndex + 1);
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const seen = new Set();
    const found = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      if (fn === OPS.paintImageXObject) {
        const name = opList.argsArray[i][0];
        if (seen.has(name)) continue;
        seen.add(name);
        let img = null;
        try { img = page.objs.get(name); }
        catch (e) { try { img = page.commonObjs.get(name); } catch (e2) {} }
        if (img) found.push(img);
      } else if (fn === OPS.paintInlineImageXObject) {
        const img = opList.argsArray[i][0];
        if (img && (img.data || img.bitmap)) found.push(img);
      }
    }
    els.extractImgs.innerHTML = '';
    let shown = 0;
    for (const img of found) {
      const canvas = pdfjsImageToCanvas(img);
      if (!canvas) continue;
      if (canvas.width < 8 || canvas.height < 8) continue; // skip specks/masks
      shown++;
      const dataUrl = canvas.toDataURL('image/png');
      const card = document.createElement('div');
      card.className = 'ximg';
      const pv = document.createElement('img'); pv.src = dataUrl; card.appendChild(pv);
      const dim = document.createElement('div'); dim.className = 'xdim';
      dim.textContent = canvas.width + '×' + canvas.height; card.appendChild(dim);
      const row = document.createElement('div'); row.className = 'xrow';
      const useBtn = document.createElement('button'); useBtn.className = 'tbtn'; useBtn.textContent = 'Use';
      useBtn.title = 'Place this image on the page as a movable object';
      useBtn.addEventListener('click', () => {
        addExtractedToPage(dataUrlToBytes(dataUrl), canvas.width, canvas.height);
      });
      const saveBtn = document.createElement('button'); saveBtn.className = 'tbtn'; saveBtn.textContent = 'Save…';
      saveBtn.title = 'Save this image as a PNG file';
      const n = shown;
      saveBtn.addEventListener('click', async () => {
        const base = state.name.replace(/\.pdf$/i, '');
        const saved = await window.api.saveFile(dataUrlToBytes(dataUrl), base + '-image-' + n + '.png', 'PNG image', ['png']);
        if (saved) toast('Saved ' + saved.split(/[\\/]/).pop());
      });
      row.appendChild(useBtn); row.appendChild(saveBtn);
      card.appendChild(row);
      els.extractImgs.appendChild(card);
    }
    if (!shown) {
      els.extractImgs.innerHTML = '<div class="muted small">No embedded images found on this page. (Vector drawings are not images and cannot be extracted this way.)</div>';
    } else {
      toast(shown + (shown === 1 ? ' image found' : ' images found'));
    }
  } catch (e) { toast(e.message, true); } finally { hideBusy(); }
}

// Place an extracted image back on the current page as a live, movable object.
function addExtractedToPage(pngBytes, wPx, hPx) {
  if (!state.viewport) return;
  pushUndo();
  const vp = state.viewport;
  const pagePtW = vp.width / state.scale, pagePtH = vp.height / state.scale;
  let w = Math.min(wPx, pagePtW * 0.6);
  let h = w * (hPx / wPx);
  if (h > pagePtH * 0.6) { h = pagePtH * 0.6; w = h * (wPx / hPx); }
  const obj = {
    id: 'img' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    page: state.pageIndex,
    x: (pagePtW - w) / 2, y: (pagePtH - h) / 2, w, h,
    bytes: pngBytes, aspect: wPx / hPx,
  };
  state.images.push(obj);
  state.selectedImageId = obj.id; state.selectedTextId = null;
  selectTool('hand');
  renderImageObjects();
  toast('Image added — drag it, or its corners, to adjust');
}

els.copyText.addEventListener('click', copyPageText);
els.saveText.addEventListener('click', saveAllText);
if (els.saveWord) els.saveWord.addEventListener('click', exportToWord);
els.scanImgs.addEventListener('click', scanPageImages);

// Show the app version in the status bar.
(async () => {
  try { els.appVersion.textContent = 'v' + (await window.api.getVersion()); }
  catch (e) { /* older preload without getVersion — leave blank */ }
})();

selectTool('hand');
