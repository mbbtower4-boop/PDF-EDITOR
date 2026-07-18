# Paperweight — Changelog

## v1.16.1 — 2026-07-14
- **Clearer message when Word conversion finds no text.** If the pages are raster images (a scan or a flattened export — e.g. review PDFs where each page is one picture), the toast now says exactly that and that OCR would be required, instead of the generic "no text" line.

## v1.16.0 — 2026-07-14
- **Convert a PDF to Word (.docx).** New button in the **Extract** panel: "Convert to Word (.docx)…". It extracts the PDF's text into an editable Word document — paragraph structure and **right-to-left (Hebrew)** direction are preserved. It is a text conversion, not a pixel-exact layout clone (no client-only tool can reproduce tables/positions/images reliably), and scanned PDFs with no text layer have nothing to convert. Built entirely in-browser (a tiny CRC32 + STORE-method ZIP writer assembles the .docx); nothing is uploaded. Verified end-to-end (Word/LibreOffice opens the output; Hebrew, RTL runs, page breaks and XML-escaping all correct) and covered by 10 new engine tests.

## v1.15.1 — 2026-07-13
- **Signal plan (צומת 72): letter-overflow fix — every picture now gets its exact start/stop, including 1-second pictures.** On the 72 plans, picture D's window is a single second (e.g. 37→38): the printed letter is wider than its own window, so Inbar prints it just outside, inside the neighbouring intergreen interval — and the letter-to-interval pairing picked that wrong interval (D came out as 38/0, or swallowed the whole transition). The analyzer now parses the phase green-bars up front and classifies each between-lines interval as *picture* (no green edge strictly inside it) or *intergreen* (has one); a letter that landed in an intergreen interval snaps to the nearest picture interval. Verified on all nine צומת-72 plans (תוכניות 0–8: shefel/peak/clearance, cycles 47–120, including wrapped rest-windows like A:74/6 and long rests like C:24/103) and regression-checked 1:1 against Inbar's own printed marks on צומת 66.

## v1.15.0 — 2026-07-13
- **Signal plan: ⚡ now reads the points straight off Inbar's own blue picture-boundary lines — fully automatic and exact.** Inbar draws a dotted blue vertical line at every picture start/stop (its own +/‡ marks sit on those lines). The auto-compute now detects those lines in the page's vector content (they are thousands of tiny dots in Inbar's boundary blue — a density histogram separates them cleanly from the faint second-grid), converts them to seconds via the time-axis fit, and pairs them using the picture letters: an interval between two consecutive lines that holds a letter is that picture — left line = zinuk '+', right line = atsira '‡'; letter-less intervals are the intergreen transitions; a picture wrapping the cycle end (letter printed in both fragments) is merged. **Verified**: reproduces Inbar's own printed marks 1:1 (צומת 66: 91/3, 11/27, 34/66, 76/84), the official picture windows on צומת 64 (70/6, 16/22, 29/59), and the exact 10/7/11 s transition structure (K=28) on its 40/120 s plans.
- Previously the ⚡ inferred picture membership from "who is green at the letter position"; leftover greens from the previous picture shrank windows (on צומת 72 the D stop landed seconds off / two marks collapsed onto each other). That heuristic remains only as a last-resort fallback and is flagged as approximate.
- **New fallback between the two:** the dialog accepts the official **picture composition** from Inbar's picture list (e.g. `A: 1,b,c,e,g | B: 3,a,c,f,g | …`) — used when the boundary lines can't be read (e.g. scanned pages); windows are then computed exactly as the intersection of the members' greens. The composition is **remembered per intersection** (parsed from the page's "צומת מספר") and prefilled next time.
- Fine-tune: mark centre restored to label baseline + 2.5pt (Inbar's exact vector geometry; v1.14.1 had 2.9pt from a pixel measurement — 0.4pt low).

## v1.14.1 — 2026-07-13
- **Signal plan: manual-op marks now land exactly on Inbar's own ידני.ת row, in every plan.** The marks used to drift on plans whose layout differs from the one the tool was tuned on: the vertical position fell back to a fixed row height (correct only for a 12-row A4 diagram), so on plans with fewer/more phase rows the '+'/'‡' symbols sat ~2 cm off the ידני.ת row. Fixes:
  - The row is now anchored to the **ידני.ת label's own baseline** (the only landmark that moves with the layout), + 2.9 pt to the symbols' centre — calibrated so the marks **coincide with Inbar's original red +/‡ marks** (verified pixel-exact against genuine Inbar 16 output on cycle-90/120 plans). The label is picked only from between the two time axes, and the left+right copies are averaged, so a stray "ידני" in the header/footer can't hijack it.
  - The **time-axis fit** now combines Inbar's top and bottom axis bands (they share one scale) for a steadier `x0`/`scale`.
  - When the ידני.ת label genuinely can't be read, placement falls back to a **layout-relative** offset above the detected bottom axis (holds to ~±4 pt across plans) instead of a fixed A4 height, and the toast now states how each axis was resolved (**red** when a fallback was used) so an approximate placement gets a manual check before saving.

## v1.14.0 — 2026-07-08
- **Hebrew (and other non-Latin) text is now supported.** The Text tool used to throw `WinAnsi cannot encode "…"` on Hebrew because it stamped with Helvetica, which only covers Latin. It now embeds a bundled Unicode font (Rubik, OFL) via fontkit whenever the text needs it, and lays RTL text out visually so it reads correctly right-to-left; the on-screen box and the floating editor auto-detect direction (`dir="auto"`). Latin text still uses Helvetica. Everything stays offline — the font is bundled, nothing is fetched.
- **Edit placed text: recolor & resize.** Select a text box with the **Hand** tool and a properties bar appears at the top — pick a new **color** (presets + custom), change the **size**, re-edit the words, or delete it. Previously there was no way to change a text's colour after dropping it.

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
