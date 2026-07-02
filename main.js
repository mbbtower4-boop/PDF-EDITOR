'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#1e2228',
    title: 'Paperweight — PDF Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu(); // clean tool chrome; shortcuts handled in-app
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // This is a single-page app: never navigate away (e.g. if a dropped file's
  // default action slips past the renderer's preventDefault).
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: file open / save -------------------------------------------------
// The renderer never touches the filesystem directly; it asks main to do it.

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('open-pdf', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const buf = await fs.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(buf) };
});

ipcMain.handle('open-pdfs', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose PDFs to append',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const out = [];
  for (const fp of res.filePaths) {
    const buf = await fs.readFile(fp);
    out.push({ name: path.basename(fp), data: new Uint8Array(buf) });
  }
  return out;
});

ipcMain.handle('open-image', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const fp = res.filePaths[0];
  const buf = await fs.readFile(fp);
  return { name: path.basename(fp), data: new Uint8Array(buf) };
});

ipcMain.handle('save-file', async (_evt, { data, suggestedName, filterName, extensions }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save',
    defaultPath: suggestedName || 'file',
    filters: [{ name: filterName || 'File', extensions: extensions || ['*'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('save-pdf', async (_evt, { data, suggestedName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF',
    defaultPath: suggestedName || 'edited.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});
