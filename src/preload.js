const { contextBridge, ipcRenderer } = require('electron');

const api = {
  listDrives: () => ipcRenderer.invoke('drives:list'),
  listAllDrives: () => ipcRenderer.invoke('drives:listall'),
  scan: () => ipcRenderer.invoke('scan:start'),
  scanJunk: () => ipcRenderer.invoke('junk:scan'),
  deleteJunk: (ids, cachedTargets) => ipcRenderer.invoke('junk:delete', ids, cachedTargets),
  audit: () => ipcRenderer.invoke('audit:start'),
  auditMove: (payload) => ipcRenderer.invoke('audit:move', payload),
  auditDelete: (items) => ipcRenderer.invoke('audit:delete', items),
  uninstallProgram: (id) => ipcRenderer.invoke('program:uninstall', id),
  move: (payload) => ipcRenderer.invoke('move:start', payload),
  listNewFiles: () => ipcRenderer.invoke('newfiles:list'),
  moveNewFiles: (payload) => ipcRenderer.invoke('newfiles:move', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getTransferState: () => ipcRenderer.invoke('transfer:state'),
  dismissReminder: () => ipcRenderer.invoke('reminder:dismiss'),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onJunkProgress: (cb) => ipcRenderer.on('junk:progress', (_e, p) => cb(p)),
  onAuditProgress: (cb) => ipcRenderer.on('audit:progress', (_e, p) => cb(p)),
  onMoveProgress: (cb) => ipcRenderer.on('move:progress', (_e, p) => cb(p)),
  onReminder: (cb) => ipcRenderer.on('reminder:newfiles', (_e, p) => cb(p)),
  onToast: (cb) => ipcRenderer.on('app:toast', (_e, p) => cb(p)),
  onNewFilesMoved: (cb) => ipcRenderer.on('app:newfiles-moved', (_e, p) => cb(p)),
  onTransferInterrupted: (cb) => ipcRenderer.on('app:transfer-interrupted', (_e, p) => cb(p))
};

contextBridge.exposeInMainWorld('api', api);
