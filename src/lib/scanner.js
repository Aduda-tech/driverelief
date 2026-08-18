const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_PROTECTED_DIRS = new Set([
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  '$Recycle.Bin',
  'System Volume Information',
  'PerfLogs',
  'Recovery',
  'MSOCache',
  'DRIVERS',
  'Config.Msi'
]);

const ROOT_PROTECTED_FILES = new Set([
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'DumpStack.log.tmp',
  'desktop.ini',
  'AUTOEXEC.BAT'
]);

// Legacy junctions / app-data inside a profile that must never be moved.
const PROFILE_PROTECTED = new Set([
  'AppData',
  'Application Data',
  'Cookies',
  'Local Settings',
  'NetHood',
  'PrintHood',
  'Recent',
  'SendTo',
  'Templates',
  'Start Menu',
  'Favorites',
  'My Documents'
]);

const CONCURRENCY = 24;

function root() {
  return path.parse(os.homedir()).root;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

async function listEntries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function isRealDir(dirent) {
  return dirent.isDirectory() && !dirent.isSymbolicLink();
}

async function walkSource(sourcePath, onProgress) {
  let size = 0;
  let fileCount = 0;
  let processed = 0;
  let skipped = 0;

  const onFile = (filePath, fileSize) => {
    size += fileSize;
    fileCount += 1;
    processed += 1;
    if (processed % 250 === 0 && onProgress) {
      onProgress({ current: filePath, size, fileCount });
    }
  };

  try {
    const st = await fs.promises.lstat(sourcePath);
    if (st.isFile()) {
      onFile(sourcePath, st.size);
      return { size, fileCount, skipped };
    }
  } catch (_) {
    return { size: 0, fileCount: 0, skipped: 0 };
  }

  const stack = [sourcePath];
  let inFlight = 0;
  let done = false;

  await new Promise((resolve) => {
    function kick() {
      while (inFlight < CONCURRENCY && stack.length > 0) {
        const dir = stack.pop();
        inFlight += 1;
        processDir(dir)
          .then(() => {
            inFlight -= 1;
            kick();
          })
          .catch(() => {
            inFlight -= 1;
            skipped += 1;
            kick();
          });
      }
      if (inFlight === 0 && stack.length === 0 && !done) {
        done = true;
        resolve();
      }
    }

    async function processDir(dir) {
      const entries = await listEntries(dir);
      const statsJobs = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (isRealDir(entry)) {
          stack.push(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          statsJobs.push(path.join(dir, entry.name));
        }
      }
      for (const file of statsJobs) {
        try {
          const st = await fs.promises.lstat(file);
          if (st.isFile()) onFile(file, st.size);
        } catch (_) {
          skipped += 1;
        }
      }
    }

    kick();
  });

  return { size, fileCount, skipped };
}

// Returns the absolute paths of every folder/file the app is allowed to move
// (mirrors the source discovery rules used by scan()). Used by the audit.
async function collectSourcePaths(rootDir) {
  const sources = [];
  const excluded = [];

  const rootEntries = await listEntries(rootDir);
  const users = rootEntries.find((e) => e.name.toLowerCase() === 'users');
  const topLevel = rootEntries.filter((e) => e.name.toLowerCase() !== 'users');

  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) {
      excluded.push({ name: entry.name, reason: 'System junction (symlink)' });
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile()) {
      if (ROOT_PROTECTED_FILES.has(entry.name)) {
        excluded.push({ name: entry.name, reason: 'OS system file' });
        continue;
      }
      if (/^ntuser\.dat/i.test(entry.name) || /^ntuser\.ini/i.test(entry.name)) {
        excluded.push({ name: entry.name, reason: 'User profile file' });
        continue;
      }
      sources.push(fullPath);
      continue;
    }
    if (ROOT_PROTECTED_DIRS.has(entry.name)) {
      excluded.push({ name: entry.name, reason: 'System / OS folder' });
      continue;
    }
    sources.push(fullPath);
  }

  if (users) {
    const profiles = await listEntries(path.join(rootDir, 'Users'));
    for (const profile of profiles) {
      if (profile.isSymbolicLink() || !isRealDir(profile)) continue;
      const profilePath = path.join(rootDir, 'Users', profile.name);
      const profileEntries = await listEntries(profilePath);
      for (const pe of profileEntries) {
        if (pe.isSymbolicLink()) {
          excluded.push({ name: `Users\\${profile.name}\\${pe.name}`, reason: 'System junction' });
          continue;
        }
        const fullPath = path.join(profilePath, pe.name);
        if (pe.isFile()) {
          if (/^ntuser\./i.test(pe.name)) {
            excluded.push({ name: `Users\\${profile.name}\\${pe.name}`, reason: 'User profile file' });
            continue;
          }
          sources.push(fullPath);
          continue;
        }
        if (PROFILE_PROTECTED.has(pe.name) || /^\./.test(pe.name) || pe.name.toLowerCase() === 'desktop.ini') {
          excluded.push({
            name: `Users\\${profile.name}\\${pe.name}`,
            reason: pe.name.toLowerCase() === 'desktop.ini' || /^\./.test(pe.name) ? 'Hidden app config' : 'App data / settings'
          });
          continue;
        }
        sources.push(fullPath);
      }
    }
  }

  return { sources, excluded };
}

async function scan({ onProgress } = {}) {
  const rootDir = root();
  const roots = [];
  const excluded = [];

  const rootEntries = await listEntries(rootDir);
  const users = rootEntries.find((e) => e.name.toLowerCase() === 'users');
  const topLevel = rootEntries.filter((e) => e.name.toLowerCase() !== 'users');

  const emitProgress = (label) => {
    if (onProgress) onProgress({ current: label, phase: 'scan' });
  };

  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) {
      excluded.push({ name: entry.name, reason: 'System junction (symlink)' });
      continue;
    }
    if (entry.isFile()) {
      if (ROOT_PROTECTED_FILES.has(entry.name)) {
        excluded.push({ name: entry.name, reason: 'OS system file' });
        continue;
      }
      if (/^ntuser\.dat/i.test(entry.name) || /^ntuser\.ini/i.test(entry.name)) {
        excluded.push({ name: entry.name, reason: 'User profile file' });
        continue;
      }
      emitProgress(`Scanning ${rootDir}${entry.name}`);
      const res = await walkSource(path.join(rootDir, entry.name), onProgress);
      roots.push({
        name: entry.name,
        path: path.join(rootDir, entry.name),
        size: res.size,
        fileCount: res.fileCount,
        protected: false,
        scanned: true,
        type: 'file',
        children: []
      });
      continue;
    }
    if (ROOT_PROTECTED_DIRS.has(entry.name)) {
      excluded.push({ name: entry.name, reason: 'System / OS folder' });
      continue;
    }
    emitProgress(`Scanning ${rootDir}${entry.name}`);
    const res = await walkSource(path.join(rootDir, entry.name), onProgress);
    roots.push({
      name: entry.name,
      path: path.join(rootDir, entry.name),
      size: res.size,
      fileCount: res.fileCount,
      protected: false,
      scanned: true,
      type: 'dir',
      children: []
    });
  }

  // Users profile tree
  if (users) {
    const profiles = await listEntries(path.join(rootDir, 'Users'));
    for (const profile of profiles) {
      if (profile.isSymbolicLink() || !isRealDir(profile)) continue;
      const profilePath = path.join(rootDir, 'Users', profile.name);
      const children = [];
      const profileEntries = await listEntries(profilePath);
      for (const pe of profileEntries) {
        if (pe.isSymbolicLink()) {
          excluded.push({ name: `Users\\${profile.name}\\${pe.name}`, reason: 'System junction' });
          continue;
        }
        const fullPath = path.join(profilePath, pe.name);
        if (pe.isFile()) {
          if (/^ntuser\./i.test(pe.name)) {
            excluded.push({ name: `Users\\${profile.name}\\${pe.name}`, reason: 'User profile file' });
            continue;
          }
          emitProgress(`Scanning ${fullPath}`);
          const res = await walkSource(fullPath, onProgress);
          children.push({
            name: pe.name,
            path: fullPath,
            size: res.size,
            fileCount: res.fileCount,
            protected: false,
            scanned: true,
            type: 'file',
            children: []
          });
          continue;
        }
        if (PROFILE_PROTECTED.has(pe.name) || /^\./.test(pe.name) || pe.name.toLowerCase() === 'desktop.ini') {
          excluded.push({
            name: `Users\\${profile.name}\\${pe.name}`,
            reason: pe.name.toLowerCase() === 'desktop.ini' || /^\./.test(pe.name) ? 'Hidden app config' : 'App data / settings'
          });
          continue;
        }
        emitProgress(`Scanning ${fullPath}`);
        const res = await walkSource(fullPath, onProgress);
        children.push({
          name: pe.name,
          path: fullPath,
          size: res.size,
          fileCount: res.fileCount,
          protected: false,
          scanned: true,
          type: 'dir',
          children: []
        });
      }
      roots.push({
        name: profile.name,
        path: profilePath,
        size: children.reduce((a, c) => a + c.size, 0),
        fileCount: children.reduce((a, c) => a + c.fileCount, 0),
        protected: false,
        scanned: false,
        type: 'profile',
        children
      });
    }
  }

  roots.sort((a, b) => b.size - a.size);
  const totalSize = roots.reduce((a, r) => a + r.size, 0);
  const totalFiles = roots.reduce((a, r) => a + r.fileCount, 0);

  return { rootDir, roots, excluded, totalSize, totalFiles };
}

module.exports = {
  scan,
  root,
  formatBytes,
  walkSource,
  collectSourcePaths,
  listEntries,
  isRealDir,
  ROOT_PROTECTED_DIRS,
  ROOT_PROTECTED_FILES,
  PROFILE_PROTECTED
};
