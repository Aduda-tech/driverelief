const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const config = require('./lib/config');
const scanner = require('./lib/scanner');
const junk = require('./lib/junk');
const mover = require('./lib/mover');
const drives = require('./lib/drives');
const audit = require('./lib/audit');
const programs = require('./lib/programs');

let win = null;
let tray = null;
let reminderTimer = null;
let driveWatcherTimer = null;
let lastKnownNewFiles = [];
let lastPrograms = [];
let quitting = false;
let autoMoving = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  main();
}

function main() {
  config.init(app.getPath('userData'));
  app.setAppUserModelId('com.driverelief.app');

  app.whenReady().then(() => {
    createWindow();
    createTray();
    startReminder();
    startDriveWatcher();
    checkInterruptedTransfer();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (reminderTimer) clearInterval(reminderTimer);
    if (driveWatcherTimer) clearInterval(driveWatcherTimer);
  });

  app.on('window-all-closed', (e) => {
    if (quitting) app.quit();
  });

  // --- IPC Handlers ---

  ipcMain.handle('drives:list', () => drives.listRemovableDrives());

  ipcMain.handle('scan:start', async () => {
    const result = await scanner.scan({
      onProgress: (p) => send('scan:progress', p)
    });
    return result;
  });

  ipcMain.handle('junk:scan', (e) =>
    junk.computeJunk((p) => send('junk:progress', p))
  );

  ipcMain.handle('junk:delete', async (e, ids) => {
    const results = await junk.deleteJunk(Array.isArray(ids) ? ids : []);
    const fresh = await junk.computeJunk();
    return { results, junk: fresh };
  });

  ipcMain.handle('audit:start', async (e) => {
    const res = await audit.auditScan({ onProgress: (p) => send('audit:progress', p) });
    lastPrograms = res.programs || [];
    return res;
  });

  ipcMain.handle('audit:move', async (e, payload) => {
    if (!payload || !Array.isArray(payload.sourcePaths) || !payload.sourcePaths.length) {
      throw new Error('Nothing selected to move');
    }
    const bad = payload.sourcePaths.filter((p) => !audit.isActionablePath(p, scanner.root()));
    if (bad.length) {
      throw new Error(`Refusing to move protected location(s): ${bad.join(', ')}`);
    }
    return mover.moveFiles({
      target: payload.target,
      mirrorRoot: payload.mirrorRoot,
      sourcePaths: payload.sourcePaths,
      onProgress: (p) => send('move:progress', p),
      keepIcons: config.get().keepIcons
    });
  });

  ipcMain.handle('audit:delete', async (e, items) => {
    const list = Array.isArray(items) ? items : [];
    const clean = list
      .map((it) => ({ path: it && it.path, size: Number(it && it.size) || 0 }))
      .filter((it) => typeof it.path === 'string' && it.path.length > 0);
    if (!clean.length) return { deleted: 0, freed: 0, failed: [] };
    const bad = clean.filter((it) => !audit.isActionablePath(it.path, scanner.root()));
    if (bad.length) {
      throw new Error(`Refusing to delete protected location(s): ${bad.map((b) => b.path).join(', ')}`);
    }
    return audit.deleteItems(clean);
  });

  ipcMain.handle('program:uninstall', async (e, id) => {
    const str = String(id || '');
    let prog = (lastPrograms || []).find((p) => p.id === str);
    if (!prog) {
      const fresh = await programs.buildProgramList({});
      prog = fresh.programs.find((p) => p.id === str);
    }
    if (!prog) return { error: 'Program not found — re-run the audit first.' };
    return programs.uninstallProgram(prog);
  });

  ipcMain.handle('move:start', async (e, payload) => {
    const res = await mover.moveFiles({
      target: payload.target,
      mirrorRoot: payload.mirrorRoot,
      sourcePaths: payload.sourcePaths,
      onProgress: (p) => send('move:progress', p),
      keepIcons: config.get().keepIcons
    });
    return res;
  });

  ipcMain.handle('newfiles:list', async () => {
    const cfg = config.get();
    const target = await pickTargetDrive();
    if (!target) return { target: null, files: [] };
    const watchDirs = resolveWatchDirs(cfg);
    const files = await mover.findNewUnmirrored({
      target,
      mirrorRoot: cfg.mirrorRoot,
      watchDirs
    });
    lastKnownNewFiles = files;
    return { target, mirrorRoot: cfg.mirrorRoot, files };
  });

  ipcMain.handle('newfiles:move', async (e, payload) => {
    const cfg = config.get();
    const target = (payload && payload.target) || (await pickTargetDrive());
    if (!target) throw new Error('No external drive selected');
    const res = await mover.moveNewFiles({
      target,
      mirrorRoot: cfg.mirrorRoot,
      watchDirs: resolveWatchDirs(cfg),
      onProgress: (p) => send('move:progress', p),
      keepIcons: cfg.keepIcons
    });
    return res;
  });

  ipcMain.handle('settings:get', () => config.get());
  ipcMain.handle('settings:set', (e, patch) => {
    const prev = config.get().reminderIntervalMin;
    const next = config.set(patch);
    if (Number(prev) !== Number(next.reminderIntervalMin)) startReminder();
    return next;
  });

  ipcMain.handle('transfer:state', () => {
    const state = mover.getTransferState();
    if (state && !state.cancelled) {
      return { interrupted: true, state };
    }
    return { interrupted: false };
  });

  ipcMain.handle('drives:listall', () => drives.listRemovableDrives());

  ipcMain.handle('reminder:dismiss', () => {
    config.set({ lastDismissedAt: Date.now() });
    return { ok: true };
  });
}

// ---------- Window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 520,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    title: 'Drive Relief',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!quitting) win.show();
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Tray ----------

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('Drive Relief — click to open');
  tray.on('click', () => showWindow());
  updateTrayMenu();
}

function updateTrayMenu(pendingCount) {
  if (!tray) return;
  const cfg = config.get();
  const autoLabel = cfg.autoMoveEnabled ? 'Pause auto-move' : 'Resume auto-move';
  const pending = pendingCount || lastKnownNewFiles.length;

  if (pending > 0) {
    tray.setToolTip(`Drive Relief — ${pending} file${pending === 1 ? '' : 's'} pending`);
  } else {
    tray.setToolTip('Drive Relief — click to open');
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Open Drive Relief', click: () => showWindow() },
    { type: 'separator' },
    {
      label: autoLabel,
      click: () => {
        const c = config.get();
        config.set({ autoMoveEnabled: !c.autoMoveEnabled });
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---------- Drive watcher ----------

function startDriveWatcher() {
  if (driveWatcherTimer) clearInterval(driveWatcherTimer);
  driveWatcherTimer = setInterval(pollDriveAndAutoMove, 30 * 1000);
  setTimeout(pollDriveAndAutoMove, 5000);
}

async function pollDriveAndAutoMove() {
  if (autoMoving) return;
  const cfg = config.get();
  if (!cfg.autoMoveEnabled) return;

  const target = await pickTargetDrive();
  if (!target) {
    updateTrayMenu(0);
    return;
  }

  const watchDirs = resolveWatchDirs(cfg);
  const files = await mover.findNewUnmirrored({
    target,
    mirrorRoot: cfg.mirrorRoot,
    watchDirs
  });

  lastKnownNewFiles = files;
  updateTrayMenu(files.length);

  if (files.length > 0) {
    await autoMoveNewFiles(target, cfg, files);
  }
}

async function autoMoveNewFiles(target, cfg, files) {
  if (autoMoving) return;
  autoMoving = true;
  try {
    const count = files ? files.length : 0;
    if (count > 0) {
      send('app:toast', { type: 'ok', text: `Auto-moving ${count} file${count === 1 ? '' : 's'} to ${target}…` });
    }
    const res = await mover.moveNewFiles({
      target,
      mirrorRoot: cfg.mirrorRoot,
      watchDirs: resolveWatchDirs(cfg),
      onProgress: (p) => send('move:progress', p),
      keepIcons: cfg.keepIcons,
      files: files || null
    });
    if (res.cancelled) {
      send('app:toast', { type: 'error', text: 'Auto-move paused — drive disconnected. Will resume when reconnected.' });
    } else if (res.moved > 0) {
      send('app:toast', { type: 'ok', text: `Auto-moved ${res.moved} file${res.moved === 1 ? '' : 's'} to ${target}` });
      send('app:newfiles-moved', res);
    }
    lastKnownNewFiles = [];
    updateTrayMenu(0);
  } catch (err) {
    send('app:toast', { type: 'error', text: `Auto-move failed: ${err.message}` });
  } finally {
    autoMoving = false;
  }
}

// ---------- Reminders (non-nagging) ----------

function resolveWatchDirs(cfg) {
  const home = os.homedir();
  return cfg.watchFolders
    .map((f) => path.join(home, f))
    .filter((p) => fs.existsSync(p));
}

async function pickTargetDrive() {
  const list = await drives.listRemovableDrives();
  if (list.length === 0) return null;
  const cfg = config.get();
  const saved = cfg.targetDrive;
  const authName = cfg.authorizedDriveName;

  if (saved) {
    const found = list.find((d) => `${d.letter}:` === saved);
    if (found && drives.isDriveAuthorized(found, authName)) return saved;
  }

  for (const d of list) {
    if (drives.isDriveAuthorized(d, authName)) return `${d.letter}:`;
  }
  return null;
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function startReminder() {
  if (reminderTimer) clearInterval(reminderTimer);
  const cfg = config.get();
  const intervalMin = Math.max(1, Number(cfg.reminderIntervalMin) || 15);
  reminderTimer = setInterval(checkNewFiles, intervalMin * 60 * 1000);
  setTimeout(checkNewFiles, 8000);
}

function getReminderBackoff(cfg) {
  const now = Date.now();
  const dismissed = cfg.lastDismissedAt || 0;
  if (!dismissed) return 0;
  const elapsed = now - dismissed;
  const base = (cfg.reminderIntervalMin || 15) * 60 * 1000;
  if (elapsed < base) return base - elapsed;
  if (elapsed < base * 3) return base;
  if (elapsed < base * 6) return base * 2;
  if (elapsed < base * 12) return base * 4;
  return base * 8;
}

async function checkNewFiles() {
  const cfg = config.get();
  const target = await pickTargetDrive();

  if (!target) {
    updateTrayMenu(0);
    return;
  }

  const watchDirs = resolveWatchDirs(cfg);
  const files = await mover.findNewUnmirrored({
    target,
    mirrorRoot: cfg.mirrorRoot,
    watchDirs
  });

  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const total = files.length;
  lastKnownNewFiles = files;
  updateTrayMenu(total);

  if (total === 0) return;

  if (cfg.autoMoveEnabled) {
    await autoMoveNewFiles(target, cfg, files);
    return;
  }

  const backoff = getReminderBackoff(cfg);
  if (backoff > 0) return;

  send('reminder:newfiles', { count: total, bytes: totalBytes });

  const windowVisible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (!windowVisible && Notification.isSupported()) {
    const n = new Notification({
      title: 'Files ready to move',
      body: `${total} file${total === 1 ? '' : 's'} (${scanner.formatBytes(totalBytes)}) can be moved to ${target}.`
    });
    n.on('click', () => showWindow());
    n.show();
  }

  cfg.lastReminderRun = Date.now();
  config.set(cfg);
}

// ---------- Actions ----------

async function handleNewFileAction() {
  showWindow();
  try {
    const cfg = config.get();
    const target = await pickTargetDrive();
    if (!target) {
      send('app:toast', { type: 'error', text: 'No authorized drive found. Connect the correct external drive first.' });
      return;
    }
    const res = await mover.moveNewFiles({
      target,
      mirrorRoot: cfg.mirrorRoot,
      watchDirs: resolveWatchDirs(cfg),
      keepIcons: cfg.keepIcons
    });
    if (res.cancelled) {
      send('app:toast', { type: 'error', text: 'Transfer paused — drive disconnected. Resume when reconnected.' });
    } else {
      send('app:toast', { type: 'ok', text: `Moved ${res.moved} file${res.moved === 1 ? '' : 's'} to ${res.base}` });
      send('app:newfiles-moved', res);
    }
  } catch (err) {
    send('app:toast', { type: 'error', text: `Move failed: ${err.message}` });
  }
}

async function checkInterruptedTransfer() {
  const state = mover.getTransferState();
  if (!state || state.cancelled) return;

  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:transfer-interrupted', state);
    }
  }, 3000);
}
