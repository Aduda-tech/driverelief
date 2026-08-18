const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.tmpdir(), 'drive-relief-transfer-state.json');

function rootDrive() {
  return path.parse(os.homedir()).root;
}

function mirrorBase(target, mirrorRoot) {
  const drive = String(target).replace(/[\\/:]+$/, '');
  return path.join(`${drive}${path.sep}`, mirrorRoot);
}

function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

async function walkFiles(dir, onFile) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          await onFile(p);
        } catch (_) {
          // caller decides
        }
      }
    }
  }
}

function saveTransferState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {
    // state saving is best-effort
  }
}

function loadTransferState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {
    // corrupt state, ignore
  }
  return null;
}

function clearTransferState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (_) {
    // best-effort
  }
}

function isTargetAccessible(target) {
  try {
    const drive = String(target).replace(/[\\/:]+$/, '');
    fs.accessSync(`${drive}${path.sep}`, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function createLink(originalPath, targetPath) {
  try {
    if (fs.existsSync(originalPath)) return false;
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) {
      const { execSync } = require('child_process');
      execSync(`cmd /c mklink /J "${originalPath}" "${targetPath}"`, { stdio: 'ignore' });
      return true;
    }
  } catch (_) {}
  try {
    if (fs.existsSync(originalPath)) return false;
    const st = fs.statSync(targetPath);
    if (!st.isDirectory()) {
      fs.symlinkSync(targetPath, originalPath, 'file');
      return true;
    }
  } catch (_) {}
  return false;
}

async function moveOneWithResume(src, dest, onProgress) {
  const st = await fs.promises.stat(src);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const finalDest = uniquePath(dest);

  // Try rename first (same volume)
  try {
    await fs.promises.rename(src, finalDest);
    return { ok: true, dest: finalDest, bytes: st.size };
  } catch (err) {
    if (err.code !== 'EXDEV') {
      return { ok: false, src, error: err.code || err.message };
    }
  }

  // Cross-volume: resume-aware copy
  const TEMP_EXT = '.dr-transfer-tmp';
  const tmpDest = finalDest + TEMP_EXT;
  let copiedBytes = 0;

  // Check for partial copy from previous interrupted transfer
  try {
    if (fs.existsSync(tmpDest)) {
      const tmpStat = await fs.promises.stat(tmpDest);
      copiedBytes = tmpStat.size;
      if (copiedBytes >= st.size) {
        // Previous copy completed but rename failed — just clean up temp
        copiedBytes = 0;
      } else if (copiedBytes > 0 && onProgress) {
        onProgress({ resumed: true, src, copiedBytes, totalBytes: st.size });
      }
    }
  } catch (_) {
    copiedBytes = 0;
  }

  try {
    // Open source for reading at offset
    const srcFd = await fs.promises.open(src, 'r');
    const destFd = await fs.promises.open(tmpDest, copiedBytes > 0 ? 'r+' : 'w');

    const CHUNK = 4 * 1024 * 1024; // 4MB chunks
    const buf = Buffer.alloc(CHUNK);
    let offset = copiedBytes;

    while (offset < st.size) {
      const toRead = Math.min(CHUNK, st.size - offset);
      const { bytesRead } = await srcFd.read(buf, 0, toRead, offset);
      if (bytesRead === 0) break;
      await destFd.write(buf, 0, bytesRead, offset);
      offset += bytesRead;

      if (onProgress && offset % (20 * 1024 * 1024) === 0) {
        onProgress({ copiedBytes: offset, totalBytes: st.size, src });
      }
    }

    await srcFd.close();
    await destFd.close();

    // Verify size matches
    const finalStat = await fs.promises.stat(tmpDest);
    if (finalStat.size !== st.size) {
      throw new Error(`Size mismatch: expected ${st.size}, got ${finalStat.size}`);
    }

    // Rename temp to final
    await fs.promises.rename(tmpDest, finalDest);
    // Delete source
    await fs.promises.unlink(src);
    return { ok: true, dest: finalDest, bytes: st.size };
  } catch (copyErr) {
    // Clean up partial temp file on failure
    try { await fs.promises.unlink(tmpDest); } catch (_) {}
    return { ok: false, src, error: copyErr.code || copyErr.message };
  }
}

async function moveOne(src, dest) {
  return moveOneWithResume(src, dest, null);
}

async function collectAllDirs(sourcePaths) {
  const dirs = new Set();
  for (const sp of sourcePaths) {
    try {
      const st = await fs.promises.lstat(sp);
      if (!st.isDirectory()) continue;
    } catch (_) {
      continue;
    }
    const stack = [sp];
    while (stack.length) {
      const d = stack.pop();
      dirs.add(d);
      let entries;
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(d, e.name));
      }
    }
  }
  return [...dirs].sort((a, b) => b.length - a.length);
}

async function pruneEmptyDirs(sourcePaths) {
  const dirs = await collectAllDirs(sourcePaths);
  let removed = 0;
  for (const d of dirs) {
    try {
      const entries = await fs.promises.readdir(d);
      if (entries.length === 0) {
        await fs.promises.rmdir(d);
        removed += 1;
      }
    } catch (_) {
      // keep going
    }
  }
  return removed;
}

async function moveFiles({ target, mirrorRoot, sourcePaths, onProgress, keepIcons }) {
  const base = mirrorBase(target, mirrorRoot);
  const sysRoot = rootDrive();
  let moved = 0;
  let bytesMoved = 0;
  const failed = [];
  let processed = 0;
  let cancelled = false;
  let targetFailCount = 0;

  const state = { target, mirrorRoot, startedAt: Date.now(), processed: 0, total: 0, cancelled: false };
  saveTransferState(state);

  const checkTarget = () => {
    if (isTargetAccessible(target)) {
      targetFailCount = 0;
      return true;
    }
    targetFailCount++;
    if (targetFailCount >= 3) {
      cancelled = true;
      return false;
    }
    return true;
  };

  const emit = (extra) => {
    if (processed % 200 === 0 && onProgress) {
      onProgress({ moved, bytesMoved, current: 'Moving…', failed: failed.length, ...extra });
    }
  };

  for (const sp of sourcePaths) {
    if (cancelled || !checkTarget()) break;
    let st;
    try {
      st = await fs.promises.lstat(sp);
    } catch (_) {
      continue;
    }
    if (st.isFile()) {
      const rel = path.relative(sysRoot, sp);
      const dest = path.join(base, rel);
      processed += 1;
      state.processed = processed;
      saveTransferState(state);
      const res = await moveOneWithResume(sp, dest, onProgress);
      if (res.ok) {
        moved += 1;
        bytesMoved += res.bytes;
      } else {
        failed.push(res);
      }
      emit();
      continue;
    }
    await walkFiles(sp, async (file) => {
      if (cancelled || !checkTarget()) return;
      processed += 1;
      state.processed = processed;
      if (processed % 100 === 0) saveTransferState(state);
      const rel = path.relative(sysRoot, file);
      const dest = path.join(base, rel);
      const res = await moveOneWithResume(file, dest, onProgress);
      if (res.ok) {
        moved += 1;
        bytesMoved += res.bytes;
      } else {
        failed.push(res);
      }
      emit();
    });
  }

  if (cancelled) {
    clearTransferState();
    return { moved, bytesMoved, failed, emptyDirsRemoved: 0, base, cancelled: true, reason: 'target_disconnected' };
  }

  clearTransferState();
  const emptyDirsRemoved = await pruneEmptyDirs(sourcePaths);
  let linksCreated = 0;
  if (keepIcons && !cancelled) {
    for (const sp of sourcePaths) {
      try {
        const rel = path.relative(sysRoot, sp);
        const mirrorDest = path.join(base, rel);
        if (!fs.existsSync(sp) && fs.existsSync(mirrorDest)) {
          if (createLink(sp, mirrorDest)) linksCreated++;
        }
      } catch (_) {}
    }
  }
  return { moved, bytesMoved, failed, emptyDirsRemoved, base, linksCreated };
}

function isTempLike(name) {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.crdownload') ||
    lower.endsWith('.part') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('~') ||
    lower.startsWith('~$') ||
    /^\.~/.test(name) ||
    lower.endsWith('.download')
  );
}

async function findNewUnmirrored({ target, mirrorRoot, watchDirs }) {
  const base = mirrorBase(target, mirrorRoot);
  const sysRoot = rootDrive();
  const unmoved = [];
  for (const dir of watchDirs) {
    if (!fs.existsSync(dir)) continue;
    await walkFiles(dir, async (file) => {
      const name = path.basename(file);
      if (isTempLike(name)) return;
      const rel = path.relative(sysRoot, file);
      const dest = path.join(base, rel);
      if (fs.existsSync(dest)) return;
      try {
        const st = await fs.promises.stat(file);
        if (st.size === 0) return;
        unmoved.push({ path: file, size: st.size, mtimeMs: st.mtimeMs, rel });
      } catch (_) {
        // file vanished mid-walk
      }
    });
  }
  unmoved.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unmoved;
}

async function moveNewFiles({ target, mirrorRoot, watchDirs, onProgress, keepIcons, files }) {
  const sysRoot = rootDrive();
  const base = mirrorBase(target, mirrorRoot);
  const toMove = files || await findNewUnmirrored({ target, mirrorRoot, watchDirs });
  let moved = 0;
  let bytesMoved = 0;
  const failed = [];
  let processed = 0;
  let cancelled = false;

  const state = { target, mirrorRoot, startedAt: Date.now(), processed: 0, total: toMove.length, cancelled: false, mode: 'newfiles' };
  saveTransferState(state);
  const movedPaths = [];
  let accessFailCount = 0;

  for (const f of toMove) {
    if (!isTargetAccessible(target)) {
      accessFailCount++;
      if (accessFailCount >= 3) {
        cancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      if (!isTargetAccessible(target)) {
        cancelled = true;
        break;
      }
      accessFailCount = 0;
    } else {
      accessFailCount = 0;
    }
    const dest = path.join(base, f.rel);
    processed += 1;
    state.processed = processed;
    if (processed % 10 === 0) saveTransferState(state);
    const res = await moveOneWithResume(f.path, dest, onProgress);
    if (res.ok) {
      moved += 1;
      bytesMoved += res.bytes;
      movedPaths.push({ original: f.path, mirror: dest });
    } else {
      failed.push(res);
    }
    if (processed % 50 === 0 && onProgress) {
      onProgress({ moved, bytesMoved, current: f.path, failed: failed.length });
    }
  }

  if (cancelled) {
    clearTransferState();
    return { moved, bytesMoved, failed, emptyDirsRemoved: 0, base, cancelled: true, reason: 'target_disconnected' };
  }

  clearTransferState();
  const emptyDirsRemoved = await pruneEmptyDirs(toMove.map((f) => path.dirname(f.path)));
  let linksCreated = 0;
  if (keepIcons && !cancelled) {
    for (const mp of movedPaths) {
      if (createLink(mp.original, mp.mirror)) linksCreated++;
    }
  }
  void sysRoot;
  return { moved, bytesMoved, failed, emptyDirsRemoved, base, linksCreated };
}

function getTransferState() {
  return loadTransferState();
}

module.exports = { moveFiles, moveNewFiles, findNewUnmirrored, mirrorBase, getTransferState, isTargetAccessible };
