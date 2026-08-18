const fs = require('fs');
const path = require('path');
const os = require('os');

const scanner = require('./scanner');
const junk = require('./junk');
const programs = require('./programs');

const CONCURRENCY = 24;
const MAX_ENTRIES = 2000;
const MIN_FILE_THRESHOLD = 20 * 1024 * 1024;
const MIN_AGG_THRESHOLD = 50 * 1024 * 1024;

const ROOT_PROTECTED_DIRS_L = new Set([...scanner.ROOT_PROTECTED_DIRS].map((s) => s.toLowerCase()));
const ROOT_PROTECTED_FILES_L = new Set([...scanner.ROOT_PROTECTED_FILES].map((s) => s.toLowerCase()));
const PROFILE_PROTECTED_L = new Set([...scanner.PROFILE_PROTECTED].map((s) => s.toLowerCase()));

function rootDrive() {
  return path.parse(os.homedir()).root;
}

function pathMatch(itemPath, rootPath) {
  const a = itemPath.toLowerCase();
  const b = rootPath.toLowerCase();
  return a === b || (a.startsWith(b) && (a[b.length] === '\\' || a[b.length] === '/'));
}

// Full-disk roots: moveable sources (actionable), junk roots (actionable),
// then every protected OS / app-data location as view-only "system" roots so
// the totals account for the whole drive. First push wins on duplicates.
async function collectRoots(rootDir) {
  const seen = new Set();
  const roots = [];
  const push = (p, system, junkFlag) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path: path.resolve(p), system, junk: junkFlag });
  };

  const { sources } = await scanner.collectSourcePaths(rootDir);
  for (const s of sources) push(s, false, false);

  for (const j of junk.getJunkRoots()) push(j.dir, false, true);

  const rootEntries = await scanner.listEntries(rootDir);
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isFile()) {
      const system =
        scanner.ROOT_PROTECTED_FILES.has(entry.name) ||
        /^ntuser\./i.test(entry.name) ||
        entry.name.toLowerCase() === 'desktop.ini';
      push(full, system, false);
    } else if (scanner.ROOT_PROTECTED_DIRS.has(entry.name)) {
      push(full, true, false);
    }
  }

  const users = rootEntries.find((e) => e.name.toLowerCase() === 'users');
  if (users) {
    const profiles = await scanner.listEntries(path.join(rootDir, 'Users'));
    for (const profile of profiles) {
      if (profile.isSymbolicLink() || !scanner.isRealDir(profile)) continue;
      const profilePath = path.join(rootDir, 'Users', profile.name);
      const entries = await scanner.listEntries(profilePath);
      for (const pe of entries) {
        if (pe.isSymbolicLink()) continue;
        const full = path.join(profilePath, pe.name);
        if (pe.isFile()) {
          if (/^ntuser\./i.test(pe.name)) push(full, true, false);
          continue;
        }
        if (
          scanner.PROFILE_PROTECTED.has(pe.name) ||
          /^\./.test(pe.name) ||
          pe.name.toLowerCase() === 'desktop.ini'
        ) {
          push(full, true, false);
        }
      }
    }
  }

  return roots;
}

// Walk every root collecting files ({path,size,junk,system}). Junk roots are
// walked first so files living under both a junk root and a system root are
// attributed to junk (and never double-counted).
async function collectFiles(rootDir, roots, onProgress) {
  const files = [];
  const seenFiles = new Set();
  let processed = 0;
  const emit = (filePath) => {
    if (onProgress && processed % 250 === 0) onProgress({ current: filePath, files: files.length });
  };
  const ordered = roots.slice().sort((a, b) => {
    const rank = (r) => (r.junk ? 0 : r.system ? 2 : 1);
    return rank(a) - rank(b);
  });

  const collect = (p, size, root) => {
    const key = p.toLowerCase();
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    files.push({ path: p, size, junk: root.junk, system: root.system });
    processed += 1;
    emit(p);
  };

  for (const root of ordered) {
    let st;
    try {
      st = await fs.promises.lstat(root.path);
    } catch (_) {
      continue;
    }
    if (st.isFile()) {
      collect(root.path, st.size, root);
      continue;
    }

    const stack = [root.path];
    let inFlight = 0;
    await new Promise((resolve) => {
      function kick() {
        while (inFlight < CONCURRENCY && stack.length > 0) {
          const dir = stack.pop();
          inFlight += 1;
          processDir(dir)
            .catch(() => {})
            .finally(() => {
              inFlight -= 1;
              kick();
            });
        }
        if (inFlight === 0 && stack.length === 0) resolve();
      }

      async function processDir(dir) {
        let entries;
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (_) {
          return;
        }
        const statsJobs = [];
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(p);
          } else if (entry.isFile()) {
            statsJobs.push(p);
          }
        }
        for (const file of statsJobs) {
          try {
            const st = await fs.promises.lstat(file);
            if (!st.isFile()) continue;
            collect(file, st.size, root);
          } catch (_) {
            // locked or vanished
          }
        }
      }

      kick();
    });
  }

  return files;
}

// Per-directory aggregation: total size, largest direct file, direct file list,
// and parent->child adjacency for pruning.
function aggregate(files, rootDir) {
  const dirInfo = new Map();
  const directFiles = new Map();
  const children = new Map();
  const rootKey = rootDir.toLowerCase().replace(/[\\/]+$/, '');

  for (const f of files) {
    let dir = path.dirname(f.path);
    if (!directFiles.has(dir)) directFiles.set(dir, []);
    directFiles.get(dir).push(f);

    let guard = 0;
    while (dir && guard < 64) {
      guard += 1;
      let info = dirInfo.get(dir);
      if (!info) {
        info = { size: 0, maxFile: 0, fileCount: 0 };
        dirInfo.set(dir, info);
      }
      info.size += f.size;
      info.fileCount += 1;
      if (f.size > info.maxFile) info.maxFile = f.size;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(dir);

      if (parent.toLowerCase().replace(/[\\/]+$/, '') === rootKey) break;
      dir = parent;
    }
  }

  return { dirInfo, directFiles, children };
}

function prune(dir, ctx, rootSystem) {
  const info = ctx.dirInfo.get(dir);
  if (!info || info.size < ctx.aggTh) return;

  const junkFlag = ctx.junkRoots.some((r) => pathMatch(dir, r));

  if (info.maxFile < ctx.fileTh) {
    if (!ctx.seen.has(dir)) {
      ctx.seen.add(dir);
      ctx.items.push({
        type: 'folder',
        path: dir,
        size: info.size,
        fileCount: info.fileCount,
        junk: junkFlag,
        system: rootSystem && !junkFlag,
        manySmall: true
      });
    }
    return;
  }

  const kids = [...(ctx.children.get(dir) || [])].sort(
    (a, b) => (ctx.dirInfo.get(b)?.size || 0) - (ctx.dirInfo.get(a)?.size || 0)
  );
  for (const k of kids) prune(k, ctx, rootSystem);

  const df = (ctx.directFiles.get(dir) || []).slice().sort((a, b) => b.size - a.size);
  for (const f of df) {
    if (f.size >= ctx.fileTh && !ctx.seen.has(f.path)) {
      ctx.seen.add(f.path);
      ctx.items.push({
        type: 'file',
        path: f.path,
        size: f.size,
        junk: f.junk,
        system: rootSystem && !f.junk
      });
    }
  }
}

// Lists the biggest files and folders on the drive, sorted by size, covering
// the entire disk. Large files appear individually; folders holding only many
// small files appear once (as the folder) when their total is substantial.
// Items under protected OS / app-data locations are flagged "system" and are
// view-only (never moveable/deletable here).
async function auditScan({ onProgress, rootDir, roots, skipPrograms } = {}) {
  rootDir = rootDir || rootDrive();
  roots = roots || (await collectRoots(rootDir));

  const files = await collectFiles(rootDir, roots, onProgress);
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  const maxFileSize = files.reduce((a, f) => Math.max(a, f.size), 0);

  let fileTh = Math.max(MIN_FILE_THRESHOLD, Math.round(totalSize / 2000));
  let bigCount = files.filter((f) => f.size >= fileTh).length;
  let bumpGuard = 0;
  while (bigCount > 1500 && fileTh < maxFileSize && bumpGuard < 12) {
    fileTh = Math.round(fileTh * 1.5);
    bigCount = files.filter((f) => f.size >= fileTh).length;
    bumpGuard += 1;
  }
  const aggTh = Math.max(MIN_AGG_THRESHOLD, Math.round(totalSize / 400));

  const { dirInfo, directFiles, children } = aggregate(files, rootDir);
  const ctx = {
    dirInfo,
    directFiles,
    children,
    fileTh,
    aggTh,
    junkRoots: roots.filter((r) => r.junk).map((r) => r.path),
    items: [],
    seen: new Set()
  };

  for (const root of roots) {
    let st;
    try {
      st = await fs.promises.lstat(root.path);
    } catch (_) {
      continue;
    }
    if (st.isFile()) {
      if (st.size >= fileTh && !ctx.seen.has(root.path)) {
        ctx.seen.add(root.path);
        ctx.items.push({
          type: 'file',
          path: root.path,
          size: st.size,
          junk: root.junk,
          system: root.system && !root.junk
        });
      }
      continue;
    }
    prune(root.path, ctx, root.system);
  }

  ctx.items.sort((a, b) => b.size - a.size);
  const items = ctx.items.slice(0, MAX_ENTRIES);

  const sizeLookup = new Map();
  for (const [dir, info] of dirInfo) sizeLookup.set(dir.toLowerCase(), info.size);
  for (const f of files) {
    const key = f.path.toLowerCase();
    if (!sizeLookup.has(key)) sizeLookup.set(key, f.size);
  }
  const prog = skipPrograms
    ? { programs: [], disk: null }
    : await programs.buildProgramList({ sizeLookup });

  return {
    items,
    totalSize,
    fileCount: files.length,
    thresholds: { fileTh, aggTh },
    programs: prog.programs,
    disk: prog.disk,
    error: prog.error || null
  };
}

async function deleteItems(items) {
  let deleted = 0;
  let freed = 0;
  const failed = [];
  for (const it of items) {
    if (!it || typeof it.path !== 'string') continue;
    try {
      const st = await fs.promises.lstat(it.path);
      const size = Number(it.size) > 0 ? it.size : st.size;
      await fs.promises.rm(it.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      deleted += 1;
      freed += size;
    } catch (err) {
      failed.push({ path: it.path, error: err.code || err.message });
    }
  }
  return { deleted, freed, failed };
}

// Whether a path may be moved/deleted by the audit. Junk roots are allowed
// even though they live inside protected locations; everything else under an
// OS / app-data / system location is refused.
function isActionablePath(p, rootDir, junkRoots) {
  if (typeof p !== 'string' || !p) return false;
  const rp = path.resolve(p);
  const lower = rp.toLowerCase();
  const rootL = path.resolve(rootDir).toLowerCase();
  if (lower !== rootL && !lower.startsWith(rootL + '\\')) return false;

  junkRoots = junkRoots || junk.getJunkRoots().map((j) => j.dir);
  if (junkRoots.some((r) => pathMatch(rp, r))) return true;

  const rel = lower.slice(rootL.length).replace(/^\\/, '');
  if (!rel) return false;
  const parts = rel.split('\\');
  const head = parts[0];

  if (ROOT_PROTECTED_DIRS_L.has(head)) return false;
  if (parts.length === 1) {
    if (ROOT_PROTECTED_FILES_L.has(head)) return false;
    if (/^ntuser\./i.test(head) || head.toLowerCase() === 'desktop.ini') return false;
  }
  if (head.toLowerCase() === 'users' && parts.length >= 3) {
    const child = parts[2];
    if (PROFILE_PROTECTED_L.has(child) || /^\./.test(child) || child.toLowerCase() === 'desktop.ini') {
      return false;
    }
  }
  return true;
}

module.exports = { auditScan, deleteItems, collectRoots, aggregate, prune, isActionablePath };
