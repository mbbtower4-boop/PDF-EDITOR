# Paperweight — Changelog

## v1.13.1 — 2026-07-07
- **Signal plan: "🗑 מחק סימונים בגליון" now clears only the current page.** The clear-all button previously removed the app's manual-op marks on *every* page; it now deletes only the marks on the page you're viewing, leaving other pages untouched. (Single-mark ✕/Delete and re-marking were already page-scoped.)

## v1.13.0 — 2026-07-07
- **Signal plan: manual-op marks are now editable and erasable until you save.** The stamped red '+'/'‡' symbols are live objects (like highlights and pen strokes): with the Hand tool, click a mark to select it, then **✕** or **Delete** to remove it, arrow keys to nudge. Re-running the calculation **replaces** the page's marks. New **"🗑 מחק סימונים"** button in the Signal-plan dialog clears all app-added marks at once, and **Ctrl+Z** undoes any of it. The marks bake into the PDF only on Save. (Marks in a file that was already saved and reopened are page content and can't be lifted out — re-mark a fresh copy to change those.)

## v1.12.1 — 2026-07-07
- **Signal plan: the manual-operation stop now marks the END of each picture.** Previously the automatic tool placed the עצירה (stop) ~2s after the זינוק (start); per the design intent it now spans the whole picture — start at the picture's first fully-green second and stop at its last, so each תמונה is bracketed at its beginning and its end.

## v1.12.0 — 2026-07-06
- **Signal plan: one-click automation (⚡ חשב אוטומטית מהתוכנית).** The tool now reads the Inbar phase diagram itself — reconstructs every phase's green intervals from the second-markers printed above the bars (using the in-bar duration numbers to disambiguate bars that wrap past the cycle end), derives each picture's all-green window, and proposes manual-operation points per the design rules (start = the second the picture is fully formed; stop ≈ 2s later, inside the window). The computed points fill the input for engineer review before stamping.

## v1.11.0 — 2026-07-06
- **New "Signal plan" tool (סימון תפעול ידני):** marks manual-operation start/stop points on Israeli **Inbar 16** traffic-signal timing-plan PDFs, using Inbar's own symbols (red '+' for start, red '‡' for stop — geometry vector-extracted from genuine Inbar output). Enter per-picture points like `A:87/90, B:11/13`; the tool auto-detects the diagram's time axis (linear fit over the axis numbers via pdf.js text positions) and the ידני.ת row (from its label), with a fallback to Inbar's standard A4 layout. Marks are applied to the current page and participate in Undo/Save like any other edit.
- Engine: new `PdfOps.stampManualOps()` (UMD, covered by `npm test`).

## v1.10.0 — 2026-07-03
- **Select several pages at once** in the thumbnail rail: **Ctrl+click** toggles a page, **Shift+click** selects a range. A selection bar appears with the count and actions — **Move…** (type a target page number) and **Delete** (also the Delete key). Dragging any selected thumbnail moves the **whole selection as a block**, keeping its order. Plain click still just navigates.
- **Import several PDFs at once:** the Insert dialog already accepts multi-select (Ctrl+click in the file picker) — now the modal says so — and you can also **drop one or many PDF files straight onto the window**: with a document open they are appended at the end; with none open, the first opens and the rest are appended.
- Drop-hint and guide texts updated accordingly.

## v1.9.1 — 2026-07-03
- **Docs:** added `PROJECT.md`, a project reference (architecture, the two builds, run/deploy steps, sync discipline, and gotchas). No app changes.

## v1.9.0 — 2026-07-02
- **Real hand cursor + drag-to-pan.** The Hand tool now shows an open-hand cursor that closes while you drag the page to move the view. You can also pan with the **right mouse button under any tool** (the context menu over the document is suppressed), so you can move around mid-annotation.
- **Fixed Ctrl+wheel zoom garbling/"rotating" the page.** Fast zooming started overlapping pdf.js render() calls on the same canvas — their competing transforms drew the page skewed or seemingly rotated. The active render is now cancelled before a new one starts.
- Right/middle mouse buttons can no longer accidentally start a pen stroke, highlight, or text box.

## v1.8.0 — 2026-07-02
- **Paperweight now runs in the browser.** A full web build lives in `docs/` and is published via GitHub Pages, so anyone can use the editor from a URL — no install. Every PDF is opened, edited, and saved entirely in the browser; nothing is uploaded. File open uses a normal picker; save uses the File System Access API (Chrome/Edge, save-in-place) with a plain download fallback (Safari/Firefox). The desktop Electron build still shares the same engine and UI.
- **Refreshed, more professional UI** across both builds: icon-labelled tool ribbon, cleaner toolbar with primary Open/Save, a document canvas that makes the page pop, polished panels, tabs, modals, empty state, and a privacy note.
- **Fixed form-field detection in the packaged app.** Field types were resolved via `constructor.name`, which the minified/vendored pdf-lib mangles — so every field read as "unknown" and the Form panel stayed empty (this only affected the shipped app; the Node tests use the unminified module and passed). Detection now uses minification-proof `instanceof` checks, with the name check kept as a fallback.

## v1.7.3 — 2026-07-02
- **App icon added** (`assets/paperweight.ico`) — an on-brand multi-resolution Windows icon (orange square, dog-eared page, highlighter stroke). Used by the desktop shortcut launcher. Note: a plain `.bat` file can't carry a custom icon in Windows; a `.lnk` shortcut is used for that.

## v1.7.2 — 2026-07-02
- **Pen strokes keep their full width.** Each stroke's SVG was clipping at its bounding box, so the outer half of the line got cut off wherever the stroke reached the box edge — making the line look like it thinned or "shrank" in places. The stroke now renders past the box, so width is uniform end to end.

## v1.7.1 — 2026-07-02
- **Pen follows your stroke faithfully.** Freehand now captures the browser's buffered ("coalesced") in-between points, so fast strokes no longer cut corners or space unevenly — the recorded line tracks what your hand actually drew.
- **More colors, plus any custom color.** Highlight, Pen, and Text each got a wider preset palette and a rainbow chip that opens a full color picker for any color you want.
- **Re-edit text with the Text tool.** Clicking existing words with the Text tool now re-opens them for editing instead of dropping a new box on top. (Double-click with the Hand tool still works too.)

## v1.7.0 — 2026-07-02
- **Highlights and pen strokes are now erasable** (and movable): they stay live objects until you save. With the Hand tool, click one to select — drag to move, ✕ or Delete key to erase, corner handles resize highlights. Undo (Ctrl+Z) covers all of it. Text already worked this way. Note: annotations already baked into previously saved files are permanent page content and cannot be lifted out.
- **Type-in zoom**: the zoom percentage in the toolbar is now an input — type a number (30–300) and press Enter.

## v1.6.1 — 2026-07-02
- Selecting the **Image tool no longer auto-opens the file dialog**. The tool strip now shows the state ("No image loaded yet" / the loaded file's name) with a "Choose image…" button. Dragging a box with no image loaded still opens the picker at that moment, since that's an explicit request to place something.

## v1.6.0 — 2026-07-02
- **Select & copy text on the page** (Hand tool): the page now has a selectable text layer — drag over text and Ctrl+C, like in a browser.
- **Extract tab** in the right panel:
  - **Copy this page's text** to the clipboard, or **save all text** of the document to a `.txt` file.
  - **Scan this page for images**: lists every embedded image with its dimensions; each can be **placed back on the page** as a movable/resizable object ("Use") or **saved as a PNG** ("Save…").
- Notes: scanned PDFs have no text layer (they're pictures of text — OCR is a possible future feature); vector drawings are not embedded images and can't be extracted this way; Hebrew/RTL text extraction order depends on how the PDF was produced and may occasionally need manual fixing.

## v1.5.0 — 2026-07-02
- **One-click launchers**: `Paperweight.vbs` (silent, recommended) and `Paperweight.bat` — no more terminal. Both run the app as a normal (non-elevated) user.
- **Version number** shown in the status bar; this changelog added.
- **Arrow-key nudge**: move a selected picture/text 2pt with the arrow keys (10pt with Shift).
- **Ctrl + mouse wheel** zooms the document.
- Documented (README): the app must NOT be run as administrator — elevation makes Windows block drag-and-drop from Explorer and hides mapped network drives from file dialogs. The drag-and-drop "red circle" and the missing network drives were both caused by launching from an elevated terminal.

## v1.4.1 — 2026-07-02
- Drag-and-drop hardening: listeners moved to document capture phase so the scrollable canvas can't swallow drag events; 'copy' effect claimed only for real file drags so thumbnail reordering is unaffected.

## v1.4.0 — 2026-07-01
- Drag image files (JPG/PNG) from Windows Explorer straight onto the page; drop point becomes the picture position. Multiple files supported.
- Navigation guard in the main process (a stray drop can never navigate the app away).

## v1.3.0 — 2026-07-01
- Text boxes are now live objects: move by dragging, resize (font size) by corner handles, double-click to re-edit the words, ✕ or Delete to remove. Baked into the PDF on save.

## v1.2.0 — 2026-07-01
- Pictures are now live objects: move by dragging, resize by corner handles, ✕ or Delete to remove. Baked into the PDF on save and before page operations.
- Keyboard shortcuts fixed for non-Latin layouts (Hebrew): Ctrl+Z/O/S now match the physical key.
- Undo covers adding/moving/resizing/deleting pictures and text.

## v1.1.1 — 2026-06-30
- Text tool fix: the input no longer loses focus (and vanishes) immediately after clicking; typing no longer triggers app shortcuts.

## v1.1.0 — 2026-06-30
- Insert JPG/PNG pictures via the Image tool (drag a box to size and place).
- "Insert PDF…" replaces "Append": insert other PDFs at the beginning, end, or after a chosen page.
- Long-document navigation: editable page box in the status bar, ⇅ move-to-page on each thumbnail, rail auto-scrolls to the current page.
- Fixed image embedding for JPEGs delivered in pooled buffers (offset normalization).

## v1.0.1 — 2026-06-25
- Fixed all overlays (signature, extract, busy) showing at startup: `[hidden]` now always wins over class display values.

## v1.0.0 — 2026-06-25
- First release: view/zoom/thumbnails, highlight, pen, add-text, draw-and-place signature, AcroForm fill + flatten, page reorder/rotate/delete, append, extract range, undo, keyboard shortcuts. Engine covered by automated tests.
