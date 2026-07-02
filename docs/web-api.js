'use strict';
/*
 * web-api.js — browser implementation of the `window.api` bridge.
 *
 * In the desktop (Electron) build, preload.js exposes `window.api` backed by
 * native file dialogs. On the web there is no preload, so this shim provides
 * the exact same interface using standard browser APIs:
 *   - Open  : a hidden <input type="file"> picker.
 *   - Save  : the File System Access API (Chrome/Edge) when available, so you
 *             can save the file where you want; otherwise a normal download.
 *
 * Crucially, nothing here uploads anything. Every byte stays in this browser
 * tab — the PDF is read locally and written back locally. The site only ever
 * served you the app's code.
 */
(function () {
  if (window.api) return; // Electron already provided the real bridge.

  const versionMeta = document.querySelector('meta[name="app-version"]');
  const APP_VERSION = (versionMeta && versionMeta.content) || 'web';

  // ---- Open: hidden file input, resolves to an array of File objects --------
  function pickFiles(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      if (multiple) input.multiple = true;
      input.style.position = 'fixed';
      input.style.left = '-10000px';
      input.style.opacity = '0';
      document.body.appendChild(input);

      let settled = false;
      const finish = (files) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onFocus, true);
        setTimeout(() => input.remove(), 1000);
        resolve(files);
      };
      // The file dialog is modal; when it closes (pick OR cancel) the window
      // regains focus. If no `change` fired shortly after, treat it as cancel.
      const onFocus = () => {
        setTimeout(() => { if (!settled) finish([]); }, 500);
      };
      input.addEventListener('change', () => finish(Array.from(input.files || [])));
      window.addEventListener('focus', onFocus, true);
      input.click();
    });
  }

  async function fileToRecord(file) {
    const buf = await file.arrayBuffer();
    return { name: file.name, data: new Uint8Array(buf) };
  }

  // ---- Save: File System Access API, falling back to a download -------------
  async function saveBytes(data, suggestedName, mime, ext, typeDesc) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob([u8], { type: mime });

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: typeDesc, accept: { [mime]: ['.' + ext] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return handle.name || suggestedName;
      } catch (err) {
        // User cancelled the picker -> report nothing saved.
        if (err && (err.name === 'AbortError')) return null;
        // Any other issue (e.g. gesture expired, unsupported) -> fall through
        // to a plain download so saving always works.
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
    return suggestedName;
  }

  function mimeForExt(ext) {
    switch ((ext || '').toLowerCase()) {
      case 'pdf': return 'application/pdf';
      case 'txt': return 'text/plain';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      default: return 'application/octet-stream';
    }
  }

  window.api = {
    getVersion: async () => APP_VERSION,

    openPdf: async () => {
      const files = await pickFiles('application/pdf,.pdf', false);
      if (!files.length) return null;
      return fileToRecord(files[0]);
    },

    openPdfs: async () => {
      const files = await pickFiles('application/pdf,.pdf', true);
      if (!files.length) return null;
      return Promise.all(files.map(fileToRecord));
    },

    openImage: async () => {
      const files = await pickFiles('image/png,image/jpeg,.png,.jpg,.jpeg', false);
      if (!files.length) return null;
      return fileToRecord(files[0]);
    },

    savePdf: (data, suggestedName) =>
      saveBytes(data, suggestedName || 'edited.pdf', 'application/pdf', 'pdf', 'PDF document'),

    saveFile: (data, suggestedName, filterName, extensions) => {
      const ext = (extensions && extensions[0]) || 'bin';
      return saveBytes(data, suggestedName || ('file.' + ext), mimeForExt(ext), ext, filterName || 'File');
    },
  };
})();
