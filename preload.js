'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the (untrusted) page and the OS. Deliberately tiny:
// open a PDF, open several PDFs to append, save bytes to disk. Nothing else.
contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('open-pdf'),
  openPdfs: () => ipcRenderer.invoke('open-pdfs'),
  openImage: () => ipcRenderer.invoke('open-image'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  savePdf: (data, suggestedName) => ipcRenderer.invoke('save-pdf', { data, suggestedName }),
  saveFile: (data, suggestedName, filterName, extensions) =>
    ipcRenderer.invoke('save-file', { data, suggestedName, filterName, extensions }),
});
