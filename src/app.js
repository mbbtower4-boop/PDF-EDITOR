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
  selectedAnnId: null,
};

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  open: $('btnOpen'), open2: $('btnOpen2'), save: $('btnSave'),
  merge: $('btnMerge'), split: $('btnSplit'), undo: $('btnUndo'),
  zoomIn: $('btnZoomIn'), zoomOut: $('btnZoomOut'), zoomInput: $('zoomInput'),
  toolOptions: $('toolOptions'),
  rail: $('rail'), thumbs: $('thumbs'), pageCount: $('pageCount'),
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
  toast: $('toast'), busy: $('busy'), busyMsg: $('busyMsg'),
  dropHint: $('dropHint'),
  appVersion: $('appVersion'),
  textSel: $('textLayer'),
  copyText: $('btnCopyText'), saveText: $('btnSaveText'),
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
  [els.save, els.merge, els.split, els.zoomIn, els.zoomOut, els.gotoPage, els.zoomInput].forEach((b) => { b.disabled = !on; });
  document.querySelectorAll('.tool').forEach((b) => { b.disabled = !on; });
}

// ---- Undo -----------------------------------------------------------------
function cloneImg(o) { return { id: o.id, page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, bytes: o.bytes, aspect: o.aspect, _url: o._url }; }
function cloneText(o) { return { id: o.id, page: o.page, x: o.x, yTop: o.yTop, text: o.text, size: o.size, color: o.color }; }
function cloneHl(o) { return { id: o.id, page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, color: o.color, opacity: o.opacity }; }
function cloneInk(o) { return { id: o.id, page: o.page, ox: o.ox, oy: o.oy, w: o.w, h: o.h, color: o.color, width: o.width, points: o.points.map((p) => ({ dx: p.dx, dy: p.dy })) }; }
function pushUndo() {
  state.undo.push({
    bytes: state.bytes,
    images: state.images.map(cloneImg),
    texts: state.texts.map(cloneText),
    highlights: state.highlights.map(cloneHl),
    inks: state.inks.map(cloneInk),
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
  state.selectedImageId = null;
  state.selectedTextId = null;
  state.selectedAnnId = null;
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
    state.selectedAnnId = null;
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
async function renderPage() {
  if (!state.pdfDoc) return;
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
    wrap.className = 'thumb' + (i === state.pageIndex ? ' current' : '');
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
      state.pageIndex = i; renderPage();
    });
    acts.querySelector('.move').addEventListener('click', (e) => { e.stopPropagation(); promptMovePage(i); });
    acts.querySelector('.rot').addEventListener('click', (e) => { e.stopPropagation(); rotatePage(i); });
    acts.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePage(i); });

    attachThumbDnD(wrap);
    els.thumbs.appendChild(wrap);
  }
}
function markCurrentThumb() {
  els.thumbs.querySelectorAll('.thumb').forEach((t) => {
    const isCur = Number(t.dataset.index) === state.pageIndex;
    t.classList.toggle('current', isCur);
    if (isCur) t.scrollIntoView({ block: 'nearest' });
  });
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
    if (dragFrom == null || dragFrom === to) return;
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
  highlight: () => optColorRow('Highlight', ['#ffd54a', '#aef0a1', '#9fd0ff', '#ffb3c1'], 'highlightColor'),
  pen: () => optColorRow('Pen', ['#d62828', '#1d3557', '#2a9d8f', '#111111'], 'penColor')
        + optSlider('Width', 'penWidth', 1, 8, 0.5),
  text: () => optColorRow('Text', ['#111111', '#d62828', '#1d3557', '#ffffff'], 'textColor')
        + `<span class="opt-label">Size</span><input class="size-input" id="optTextSize" type="number" min="6" max="96" value="${state.textSize}">`,
  image: () => (state.pendingImage
        ? `<span class="opt-label">"${(state.pendingImage.name || 'image').replace(/</g, '&lt;')}" — drag a box on the page to place it.</span><button class="tbtn" id="optPickImg">Choose another…</button>`
        : `<span class="opt-label">No image loaded yet.</span><button class="tbtn" id="optPickImg">Choose image…</button>`),
  sign: () => `<span class="opt-label">Click the page to place your signature. </span><button class="tbtn" id="optRedraw">Draw new signature</button>`,
  hand: () => '',
};
function optColorRow(label, colors, key) {
  const sw = colors.map((c) => `<span class="swatch${state[key] === c ? ' active' : ''}" data-key="${key}" data-color="${c}" style="background:${c}"></span>`).join('');
  return `<span class="opt-label">${label}</span><div class="swatches">${sw}</div>`;
}
function optSlider(label, key, min, max, step) {
  return `<div class="slider"><span class="opt-label">${label}</span><input type="range" id="opt_${key}" min="${min}" max="${max}" step="${step}" value="${state[key]}"></div>`;
}
function renderToolOptions() {
  const html = (TOOL_OPTIONS[state.tool] || (() => ''))();
  els.toolOptions.innerHTML = html;
  els.toolOptions.hidden = !html;
  els.toolOptions.querySelectorAll('.swatch').forEach((s) => {
    s.addEventListener('click', () => {
      state[s.dataset.key] = s.dataset.color;
      els.toolOptions.querySelectorAll(`.swatch[data-key="${s.dataset.key}"]`).forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    });
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

els.overlay.addEventListener('pointerdown', (e) => {
  if (!state.pdfDoc) return;
  const p = overlayXY(e);
  if (state.tool === 'hand') { if (state.selectedImageId || state.selectedTextId || state.selectedAnnId) deselectAll(); return; }
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
    penPts.push(p);
    ctx.strokeStyle = state.penColor; ctx.lineWidth = state.penWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(penPts[penPts.length - 2].x, penPts[penPts.length - 2].y);
    ctx.lineTo(p.x, p.y); ctx.stroke();
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
  inp.type = 'text'; inp.className = 'float-input';
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
  const editable = state.tool === 'hand';
  for (const t of state.texts) {
    if (t.page !== state.pageIndex) continue;
    const [lx, ty] = vp.convertToViewportPoint(t.x, t.yTop);
    const box = document.createElement('div');
    box.className = 'txt-obj' + (t.id === state.selectedTextId ? ' selected' : '');
    box.dataset.id = t.id;
    box.style.left = lx + 'px'; box.style.top = ty + 'px';
    box.style.fontSize = (t.size * state.scale) + 'px';
    box.style.color = t.color;
    box.style.pointerEvents = editable ? 'auto' : 'none';
    box.appendChild(document.createTextNode(t.text));
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
}
function deselectAll() {
  state.selectedImageId = null; state.selectedTextId = null; state.selectedAnnId = null;
  renderImageObjects(); renderTextObjects(); renderAnnObjects();
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
  if (state.tool !== 'hand') return;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'float-input';
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
  toast('Text removed');
}
async function applyTexts(bytes, texts) {
  if (!texts.length) return bytes;
  return ops.stampText(PDFLib, bytes, texts.map((t) => (
    { page: t.page, x: t.x, y: t.yTop - t.size, text: t.text, size: t.size, color: t.color }
  )));
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
  b = await applyImages(b, state.images);
  b = await applyTexts(b, state.texts);
  return b;
}
async function bakeAll() {
  if (!state.images.length && !state.texts.length && !state.highlights.length && !state.inks.length) return;
  state.bytes = await applyOverlays(state.bytes);
  state.images = []; state.texts = []; state.highlights = []; state.inks = [];
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
    svg.style.display = 'block'; svg.style.pointerEvents = 'none';
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
}
function selectAnn(id) {
  state.selectedAnnId = id;
  state.selectedImageId = null; state.selectedTextId = null;
  els.annLayer.querySelectorAll('.ann-obj').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  els.imgLayer.querySelectorAll('.img-obj').forEach((el) => el.classList.remove('selected'));
  els.txtLayer.querySelectorAll('.txt-obj').forEach((el) => el.classList.remove('selected'));
}
function deleteAnn(id) {
  pushUndo();
  state.highlights = state.highlights.filter((o) => o.id !== id);
  state.inks = state.inks.filter((o) => o.id !== id);
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
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearTimeout(dropHintTimer); els.dropHint.hidden = true;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(isImageFile);
  if (!files.length) return; // internal (thumbnail) drop, or no images — let it be
  if (!state.pdfDoc) { toast('Open a PDF first, then drop the image', true); return; }
  await dropImages(files, e.clientX, e.clientY);
}, true);

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
    if (h) { h.x += dx; h.y += dy; }
    else if (k) { k.ox += dx; k.oy += dy; }
    renderAnnObjects();
  }
}

// Ctrl + mouse wheel zoom over the document.
els.canvasArea.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pdfDoc) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

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
els.scanImgs.addEventListener('click', scanPageImages);

// Show the app version in the status bar.
(async () => {
  try { els.appVersion.textContent = 'v' + (await window.api.getVersion()); }
  catch (e) { /* older preload without getVersion — leave blank */ }
})();

selectTool('hand');
