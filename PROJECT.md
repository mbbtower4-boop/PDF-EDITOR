# Paperweight — Project Reference

A local, privacy-first PDF editor: **view, annotate, add text, fill forms, sign,
and reshape pages**. No accounts, no uploads — every PDF is opened, edited, and
saved on the user's own device.

It ships as **two builds from one codebase**:

| Build | Entry | File I/O | Where it runs |
|-------|-------|----------|---------------|
| **Desktop** (Electron) | `src/index.html` | native dialogs via `preload.js` | offline app on the user's machine |
| **Web** (static site) | `docs/index.html` | browser APIs via `docs/web-api.js` | GitHub Pages (any modern browser) |

- **Live web app:** https://mbbtower4-boop.github.io/PDF-EDITOR/
- **Repo:** https://github.com/mbbtower4-boop/PDF-EDITOR (branch `main`)
- **Local path:** `D:\Work\AI\PDF-EDITOR`

---

## Directory layout

```
PDF-EDITOR/
├── package.json          name, version (CANONICAL version), scripts, deps
├── main.js               Electron main process (window + open/save dialogs + IPC)
├── preload.js            Desktop IPC bridge — exposes window.api to the page
├── Paperweight.bat/.vbs  Windows launchers (desktop). .vbs = silent start
├── assets/paperweight.ico   app icon (also used by the desktop shortcut)
│
├── src/                  DESKTOP renderer (Electron loads src/index.html)
│   ├── index.html        desktop layout (scripts use ../vendor, no web-api)
│   ├── styles.css        UI theme  ── kept identical to docs/styles.css
│   ├── app.js            renderer: rendering, tools, page ops, forms, save
│   └── pdfOps.js         PDF engine (UMD; pure logic; tested in Node)
│
├── docs/                 WEB build — GitHub Pages serves THIS folder
│   ├── index.html        web layout (scripts use vendor/, includes web-api.js)
│   ├── styles.css        copy of src/styles.css
│   ├── app.js            copy of src/app.js (pdf.js worker path de-dented)
│   ├── pdfOps.js         copy of src/pdfOps.js
│   ├── web-api.js        browser implementation of window.api (open/save)
│   ├── vendor/           bundled pdf.js + pdf-lib
│   ├── assets/paperweight.ico
│   └── .nojekyll         tells GitHub Pages to skip Jekyll (serve as-is)
│
├── vendor/               bundled pdf.js + pdf-lib (for the desktop build)
├── test/ops.test.js      31 headless engine tests (node test/ops.test.js)
├── CHANGELOG.md
└── PROJECT.md            (this file)
```

---

## Architecture

**Single source of truth = the whole-PDF bytes.** `state.bytes` (a `Uint8Array`)
holds the entire document. Two libraries act on it:

- **pdf.js** renders bytes → canvas (viewing, thumbnails, text layer, image extraction).
- **pdf-lib** (wrapped by `pdfOps.js`) mutates bytes → new bytes (merge, split,
  reorder, rotate, delete, form fill, and stamping text/highlight/ink/image).

Every edit is **baked into the bytes**, so what you see is what saves, and **Undo
is just a stack of byte snapshots**. Live, still-movable overlays (text boxes,
images, highlights, pen strokes) are held in `state.texts/images/highlights/inks`
and baked in via `applyOverlays()` / `bakeAll()` on save or before any page op.

**Screen ↔ PDF coordinate mapping is delegated to pdf.js** —
`viewport.convertToPdfPoint(x,y)` and `convertToViewportPoint(x,y)` — never
hand-rolled. This stays correct across zoom and page rotation.

### The `window.api` abstraction (how one codebase serves both builds)

`app.js` never touches the filesystem directly. It calls `window.api.*`:

```
openPdf() openPdfs() openImage() savePdf(bytes, name) saveFile(bytes, name, filterName, exts) getVersion()
```

- **Desktop:** `preload.js` provides `window.api` backed by Electron native
  dialogs (IPC to `main.js`).
- **Web:** `docs/web-api.js` provides the same interface using a hidden
  `<input type=file>` for open and the **File System Access API** for save
  (Chrome/Edge save-in-place), falling back to a normal **download**
  (Safari/Firefox). It early-returns if `window.api` already exists, so it's a
  no-op under Electron.

### Rendering is single-flight (important)

pdf.js **cannot run two `render()` calls on the same canvas at once** —
overlapping renders draw the page garbled/rotated and can wedge the renderer.
So `renderPage()` allows only **one render at a time** (`rendering` flag); a
request that arrives mid-render sets `pendingRender` and is coalesced into a
single trailing re-render. This is what makes fast Ctrl+wheel zoom safe.

---

## Run & build

### Desktop
```bash
npm install     # one-time: fetches Electron (~hundreds of MB)
npm start       # launches the app
```
Or double-click `Paperweight.vbs` (silent) / the desktop shortcut. **Do not run
as administrator** — Windows then blocks Explorer drag-and-drop and hides mapped
network drives.

### Web — local preview
Serve the `docs/` folder over HTTP (not `file://`, the pdf.js worker needs a real
origin) and open it in a browser. A dev server is wired into `.claude/launch.json`
(gitignored; machine-specific absolute path). **Send `Cache-Control: no-store`**
or the browser will run a stale `app.js` while you iterate.

### Tests
```bash
npm test        # 31 checks on the PDF engine (pdfOps.js) against a generated form PDF
```
Note: tests cover the **engine only** (Node, unminified pdf-lib). They do **not**
exercise `app.js`/DOM/rendering — verify UI changes in a browser.

### Deploy (web)
Push to `main`. GitHub Pages is configured **Deploy from a branch → `main` →
`/docs`** and rebuilds automatically. Requirements/quirks:
- The repo must be **public** (free Pages tier).
- The very first deployment's `deploy` step can fail transiently — re-trigger
  with an empty commit (`git commit --allow-empty`) or "Re-run jobs" in Actions.

---

## Keeping the two builds in sync

`src/` is the working source. `docs/` holds copies:

- `pdfOps.js`, `styles.css` — **identical** copies of the `src/` versions.
- `app.js` — copy of `src/app.js` with the pdf.js worker path changed from
  `'../vendor/pdfjs/pdf.worker.min.js'` → `'vendor/pdfjs/pdf.worker.min.js'`
  (docs/index.html sits one level shallower than src/index.html).
- `index.html` — intentionally **different** per build (script paths, the web-only
  `web-api.js` include, the `web` badge, the `<meta name="app-version">`, CSP).

After editing `src/app.js`, re-copy to `docs/app.js` applying that one path
replacement. After editing `src/styles.css` or `src/pdfOps.js`, copy verbatim.

---

## Versioning rule (standing preference)

**Bump the version on every change.** Update, together:
1. `package.json` `version`
2. `docs/index.html` `<meta name="app-version">` (keep equal to package.json)
3. `CHANGELOG.md` (dated entry at the top)

Semver: patch = fixes/tweaks, minor = features, major = breaking. The desktop app
shows the version via `window.api.getVersion()` (IPC → `app.getVersion()` reads
package.json); the web app reads it from the `app-version` meta tag.

---

## Features (what the app does)

View (page render, zoom, thumbnail rail, keyboard nav) · Highlight · Pen
(freehand, custom colors) · Text (add/move/resize/re-edit overlays) · Image
(drag a file onto the page or draw a box) · Sign (draw once, stamp anywhere) ·
Forms (detect AcroForm fields, fill, optional flatten) · Pages (drag-reorder,
move-to-number, rotate, delete) · Assemble (insert other PDFs, extract a range) ·
Extract (select/copy page text, save all text, pull out embedded images) ·
Hand tool with grab cursor + drag-to-pan (also right-mouse-button pan) · Undo
(20 snapshots).

### Deliberate limits (not bugs)
- **Add-text, not reflow-edit** — text is overlaid; existing PDF text isn't rewritten.
- **Visible signature, not cryptographic** — "Sign" stamps an image, not a PKI signature.
- **Edits bake immediately** into the bytes (which is why Undo is byte snapshots).
- **One page in the main view** at a time (plus the full thumbnail rail).
- **Highlights are region rectangles**, not glyph-snapped text highlights.

---

## Gotchas learned (read before debugging)

1. **Field types via `instanceof`, not `constructor.name`.** The *minified*
   vendored pdf-lib mangles class names, so `constructor.name` made every form
   field read as `"unknown"` in the packaged app (Node tests passed because they
   use the unminified module). `pdfOps.fieldType()` now checks
   `field instanceof PDFLib.PDFTextField` etc., with the name check as fallback.
2. **Never overlap pdf.js renders on one canvas.** Use the single-flight
   `rendering`/`pendingRender` guard in `renderPage()`. Cancel-and-restart
   patterns are fragile and can wedge the renderer.
3. **Pen fidelity** uses `PointerEvent.getCoalescedEvents()` so fast strokes
   capture the in-between points instead of cutting corners.
4. **Ink SVG needs `overflow: visible`** — otherwise the stroke is clipped to
   half-width at the edges of its bounding box (looks like the line "thins out").
5. **Dev server must disable caching** (`Cache-Control: no-store`) during local
   web testing, or the browser serves a stale `app.js`.
6. **GitHub Pages needs a public repo** on the free tier, and the first deploy's
   `deploy` step may need a manual re-trigger.

---

## Version history (high level — see CHANGELOG.md for detail)

- **1.9.0** — Hand-tool + right-button drag-to-pan, grab cursor; fixed Ctrl+wheel
  render overlap (garble/rotate).
- **1.8.0** — Web build + GitHub Pages; pro UI refresh (icon ribbon, cleaner
  chrome) on both builds; fixed minified form-field detection.
- **1.7.x** — Pen fidelity (coalesced events) + full-width strokes; more colors +
  custom picker; Text-tool click-to-re-edit; app icon + desktop launcher.
- **1.7.0 and earlier** — original chat-built editor: erasable annotations,
  type-in zoom, text/image select & extract, page assembly, forms.
