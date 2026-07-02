# Paperweight — a local PDF editor

A fully offline desktop app (Electron) to **view, annotate, add text, fill forms,
sign, and reshape pages** of PDFs. No accounts, no network — your files never
leave your machine.

---

## Run it

You need [Node.js](https://nodejs.org) (which includes npm) installed.

```bash
cd paperweight-pdf-editor
npm install      # installs Electron (≈ one-time, a few hundred MB)
npm start        # launches the app
```

### One-click start (Windows)
After the one-time `npm install`, just **double-click `Paperweight.vbs`** in the
app folder — it opens the app silently, with no terminal. (`Paperweight.bat` is a
fallback that flashes a console briefly.) For a desktop icon: right-click
`Paperweight.vbs` → **Send to → Desktop (create shortcut)**.

### ⚠️ Do NOT run as administrator
Launch the app (and any terminal you start it from) as a **normal user**. An
elevated (administrator) app on Windows:
- **cannot receive drag-and-drop from Explorer** (Windows UIPI blocks it — you
  get the red "no entry" cursor), and
- **does not see your mapped network drives** (drive letters are per-session;
  the elevated session doesn't have your mappings), so they vanish from the
  Open/Save dialogs. UNC paths like `\\server\share` still work if needed.

The `Paperweight.vbs` launcher runs the app non-elevated, which fixes both.

> The PDF libraries (`pdf-lib`, `pdf.js`) are already bundled in `vendor/`, so the
> app itself runs offline. `npm install` is only needed to fetch **Electron**, the
> desktop runtime.

Run the engine tests at any time:

```bash
npm test         # 22 checks on the core PDF operations
```

---

## What it does

| Area | Capability |
|------|-----------|
| **View** | Page-by-page rendering, zoom, thumbnail rail, keyboard navigation |
| **Annotate** | Region **highlight** (4 colors) and freehand **pen** (color + width) |
| **Text** | Drop a **text box**, type, Enter. Then move it, resize by the corners, or double-click to re-edit the words (Hand tool); baked into the PDF on save |
| **Image** | **Drag an image file straight onto the page**, or use the Image tool + drag a box. Move it or resize by the corners (Hand tool); aspect preserved; baked into the PDF on save |
| **Sign** | Draw a signature once, click to place it anywhere; auto-trimmed to the ink |
| **Forms** | Detects AcroForm fields (text / checkbox / dropdown / list / radio), fills them, optional **flatten** |
| **Pages** | **Drag** thumbnails to reorder · type a page number on a thumbnail (**⇅**) to move it anywhere · **rotate** 90° · **delete** |
| **Assemble** | **Insert** other PDFs at the start, end, or after a chosen page · **extract** a page range to a new file |
| **Navigate** | Editable page box in the status bar (type a number, Enter) · rail auto-scrolls to the current page |
| **Extract** | Select & copy text on the page · copy/save page or whole-document text (.txt) · pull embedded images out (reuse on the page, or save as PNG) |
| **Safety** | Undo (Ctrl+Z, 20 levels) · refuses to delete the last page · validates page ranges |

### Shortcuts
`Ctrl/Cmd+O` open · `Ctrl/Cmd+S` save a copy · `Ctrl/Cmd+Z` undo ·
`Ctrl/Cmd +/−` zoom · `←/→` or `PageUp/PageDown` change page · `Delete` remove a selected picture · `H` hand tool.
(Shortcuts match the physical key, so they work on non-Latin keyboard layouts too.)

---

## Honest limits (please read)

These are deliberate scope decisions, not bugs:

1. **Add-text, not reflow-edit.** The Text tool *overlays* new text on the page.
   It does **not** rewrite text already baked into the PDF (no open library does
   that reliably — PDFs don't store editable paragraphs). To change existing
   words you'd cover/redact and retype.
2. **Visible signature, not cryptographic.** "Sign" stamps a signature *image*.
   It is **not** a PKI/digital signature with a certificate. If you need legally
   binding cryptographic signing, that's a separate, larger feature.
3. **Edits bake immediately.** Each highlight/stroke/text/signature is written
   into the PDF the moment you finish it (which is why the page briefly re-renders
   and why Undo works as byte snapshots). Once committed, an annotation is page
   content — reordering a page carries its annotations with it, as you'd expect.
4. **One page in the main view at a time** (with a full thumbnail rail). A
   continuous-scroll multi-page canvas would be a nice future addition.
5. **Highlights are semi-transparent rectangles**, not text-aware highlights that
   snap to glyph runs. Region highlighting is reliable across all PDFs; glyph-snap
   highlighting depends on the text layer and isn't always present.

---

## Verification status — what I actually tested

Being precise about this:

- ✅ **Core PDF engine (`src/pdfOps.js`)** — merge, split, reorder, delete (incl.
  guard rails), rotate, form discovery/fill/flatten, and text/highlight/ink/image
  stamping are covered by **31 automated tests in `test/ops.test.js`, all passing**
  against a generated multi-page form PDF.
- ✅ **All source files pass `node --check`** (no syntax errors).
- ⚠️ **The Electron GUI itself was not executed in my build environment** (it needs
  a display, which the build sandbox doesn't have). The rendering, tool overlays,
  drag-to-reorder, and dialogs are written against documented, stable APIs
  (`viewport.convertToPdfPoint` for screen↔PDF mapping, pdf-lib for writes), but
  **you will be the first to run the UI end-to-end.** If anything misbehaves on
  first launch, tell me what you see and I'll fix it.

---

## Project layout

```
paperweight-pdf-editor/
├── package.json
├── main.js               Electron main process (window + open/save dialogs)
├── preload.js            Minimal secure bridge (open / openMany / save only)
├── src/
│   ├── index.html        Workspace layout
│   ├── styles.css        Slate workroom theme
│   ├── app.js            Renderer: rendering, tools, page ops, forms, save
│   └── pdfOps.js         All PDF read/write logic (UMD; tested in Node)
├── vendor/               Bundled pdf.js + pdf-lib (offline)
└── test/ops.test.js      Headless engine tests
```

Security posture: `contextIsolation: true`, `nodeIntegration: false`, a strict
CSP, and a tiny IPC surface — the page can only ask the main process to open or
save a file the user picked in a native dialog.
```
