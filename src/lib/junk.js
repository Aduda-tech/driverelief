const fs = require('fs');
const path = require('path');
const os = require('os');

const CONCURRENCY = 24;

async function walkSize(dir) {
  let size = 0;
  let fileCount = 0;
  const stack = [dir];
  let inFlight = 0;

  await new Promise((resolve) => {
    function kick() {
      while (inFlight < CONCURRENCY && stack.length > 0) {
        const d = stack.pop();
        inFlight += 1;
        processDir(d)
          .catch(() => {})
          .finally(() => {
            inFlight -= 1;
            kick();
          });
      }
      if (inFlight === 0 && stack.length === 0) resolve();
    }

    async function processDir(d) {
      let entries;
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          try {
            const st = await fs.promises.stat(p);
            size += st.size;
            fileCount += 1;
          } catch (_) {
            // locked or vanished
          }
        }
      }
    }

    kick();
  });

  return { size, fileCount };
}

async function dirTarget(id, label, dir, category) {
  const present = fs.existsSync(dir);
  if (!present) return { id, label, dir, category, present: false, size: 0, fileCount: 0 };
  const { size, fileCount } = await walkSize(dir);
  return { id, label, dir, category, present: true, size, fileCount };
}

async function fileSetTarget(id, label, dir, matcher, category) {
  const present = fs.existsSync(dir);
  if (!present) return { id, label, dir, category, present: false, size: 0, fileCount: 0 };
  let size = 0;
  let fileCount = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return { id, label, dir, category, present: true, size: 0, fileCount: 0 };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!matcher(e.name)) continue;
    try {
      const st = await fs.promises.stat(path.join(dir, e.name));
      size += st.size;
      fileCount += 1;
    } catch (_) {
      // skip
    }
  }
  return { id, label, dir, category, present: true, size, fileCount };
}

function buildDescriptors() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const rootDrive = path.parse(os.homedir()).root;
  const homeDir = os.homedir();
  const d = [];

  // ── CATEGORY: System Temp ──
  d.push({ id: 'usertemp', label: 'User temp files (AppData\\Local\\Temp)', dir: os.tmpdir(), category: 'System Temp' });
  d.push({ id: 'wintemp', label: 'Windows Temp', dir: path.join(winDir, 'Temp'), category: 'System Temp' });
  d.push({ id: 'prefetch', label: 'Prefetch cache', dir: path.join(winDir, 'Prefetch'), category: 'System Temp' });
  d.push({ id: 'crashdump', label: 'Crash dumps', dir: path.join(local, 'CrashDumps'), category: 'System Temp' });
  d.push({ id: 'minidump', label: 'Minidumps', dir: path.join(winDir, 'Minidump'), category: 'System Temp' });

  // ── CATEGORY: Windows Update ──
  d.push({ id: 'wuupdate', label: 'Windows Update download cache', dir: path.join(winDir, 'SoftwareDistribution', 'Download'), category: 'Windows Update' });

  // ── CATEGORY: Browser Cache ──
  d.push({ id: 'chromecache', label: 'Chrome cache (Default)', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), category: 'Browser Cache' });
  d.push({ id: 'chromecode', label: 'Chrome code cache (Default)', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'), category: 'Browser Cache' });
  d.push({ id: 'chromegpu', label: 'Chrome GPU cache (Default)', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'GPUCache'), category: 'Browser Cache' });
  d.push({ id: 'chromeshader', label: 'Chrome shader cache', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'ShaderCache'), category: 'Browser Cache' });
  d.push({ id: 'chromegr', label: 'Chrome GrShaderCache', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'GrShaderCache'), category: 'Browser Cache' });
  d.push({ id: 'chromemetrics', label: 'Chrome BrowserMetrics', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'BrowserMetrics'), category: 'Browser Cache' });

  // Chrome additional profiles
  const chromeUserData = path.join(local, 'Google', 'Chrome', 'User Data');
  if (fs.existsSync(chromeUserData)) {
    try {
      const profiles = fs.readdirSync(chromeUserData, { withFileTypes: true });
      for (const p of profiles) {
        if (!p.isDirectory()) continue;
        if (p.name === 'Default' || p.name.startsWith('Profile ') === false) continue;
        const profileCache = path.join(chromeUserData, p.name, 'Cache');
        const profileCodeCache = path.join(chromeUserData, p.name, 'Code Cache');
        d.push({ id: `chrome_${p.name}_cache`, label: `Chrome cache (${p.name})`, dir: profileCache, category: 'Browser Cache' });
        d.push({ id: `chrome_${p.name}_code`, label: `Chrome code cache (${p.name})`, dir: profileCodeCache, category: 'Browser Cache' });
      }
    } catch (_) {}
  }

  d.push({ id: 'edgecache', label: 'Edge cache', dir: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), category: 'Browser Cache' });
  d.push({ id: 'edgecode', label: 'Edge code cache', dir: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'), category: 'Browser Cache' });

  // Firefox profiles
  const firefoxProfiles = path.join(appData, 'Mozilla', 'Firefox', 'Profiles');
  if (fs.existsSync(firefoxProfiles)) {
    let fxFolders = [];
    try {
      fxFolders = fs.readdirSync(firefoxProfiles, { withFileTypes: true });
    } catch (_) {
      fxFolders = [];
    }
    for (const dir of fxFolders) {
      if (!dir.isDirectory()) continue;
      const profile = path.join(firefoxProfiles, dir.name);
      const short = dir.name.length > 8 ? dir.name.slice(0, 8) + '…' : dir.name;
      d.push({ id: `firefox_${dir.name}_cache2`, label: `Firefox cache (${short})`, dir: path.join(profile, 'cache2'), category: 'Browser Cache' });
      d.push({ id: `firefox_${dir.name}_startup`, label: `Firefox startup cache (${short})`, dir: path.join(profile, 'startupCache'), category: 'Browser Cache' });
      d.push({ id: `firefox_${dir.name}_offline`, label: `Firefox offline cache (${short})`, dir: path.join(profile, 'OfflineCache'), category: 'Browser Cache' });
    }
  }

  // ── CATEGORY: Thumbnail / Icon Cache ──
  d.push({
    id: 'thumbs',
    label: 'Thumbnail / icon cache',
    dir: path.join(local, 'Microsoft', 'Windows', 'Explorer'),
    fileSet: true,
    matcher: (n) => /^(thumbcache_|iconcache_).*\.db$/i.test(n),
    category: 'Thumbnail Cache'
  });

  // ── CATEGORY: Package Caches ──
  d.push({ id: 'uv', label: 'uv cache (Python packages)', dir: path.join(local, 'uv'), category: 'Package Caches' });
  d.push({ id: 'npmcache', label: 'npm cache', dir: path.join(local, 'npm-cache'), category: 'Package Caches' });
  d.push({ id: 'yarn', label: 'Yarn cache', dir: path.join(local, 'Yarn'), category: 'Package Caches' });
  d.push({ id: 'electronbuilder', label: 'electron-builder cache', dir: path.join(local, 'electron-builder'), category: 'Package Caches' });

  // ── CATEGORY: Installer / Updater Temp ──
  d.push({ id: 'squirreltemp', label: 'SquirrelTemp (installer temp)', dir: path.join(local, 'SquirrelTemp'), category: 'Installer Temp' });
  d.push({ id: 'downloadedinstall', label: 'Downloaded Installations', dir: path.join(local, 'Downloaded Installations'), category: 'Installer Temp' });
  d.push({ id: 'electron', label: 'Electron cache', dir: path.join(local, 'electron'), category: 'Installer Temp' });

  // Updater caches (common patterns)
  const updaterDirs = [
    'anythingllm-desktop-updater',
    '@opencode-aidesktop-updater',
    'scratch-desktop-updater',
    'agent-canvas-updater',
    'react-example-updater',
    'form-filler-app-updater'
  ];
  for (const name of updaterDirs) {
    d.push({
      id: `updater_${name}`,
      label: `${name.replace(/-updater$/, '').replace(/-/g, ' ')}`,
      dir: path.join(local, name),
      category: 'Installer Temp'
    });
  }

  // ── CATEGORY: App Cache ──
  d.push({ id: 'idmcache', label: 'IDM download cache', dir: path.join(appData, 'IDM', 'DwnlData'), category: 'App Cache' });
  d.push({ id: 'anythingllm_storage', label: 'AnythingLLM models/engines', dir: path.join(appData, 'anythingllm-desktop', 'storage'), category: 'App Cache' });
  d.push({ id: 'githubdesktop', label: 'GitHub Desktop old versions', dir: path.join(local, 'GitHubDesktop'), category: 'App Cache', special: true });

  // ── CATEGORY: Recycle Bin ──
  d.push({ id: 'recycle', label: 'Recycle Bin', dir: path.join(rootDrive, '$Recycle.Bin'), special: true, category: 'Recycle Bin' });

  return d;
}

async function computeJunk(onProgress) {
  const descriptors = buildDescriptors();
  const targets = [];
  const matcherMap = {};
  let sizeSoFar = 0;
  const total = descriptors.length;

  for (let i = 0; i < descriptors.length; i++) {
    const desc = descriptors[i];
    if (onProgress) onProgress({ current: desc.label, index: i, total, sizeSoFar });
    let t;
    if (desc.special) {
      t = await dirTarget(desc.id, desc.label, desc.dir, desc.category);
    } else if (desc.fileSet) {
      t = await fileSetTarget(desc.id, desc.label, desc.dir, desc.matcher, desc.category);
      matcherMap[desc.id] = desc.matcher;
    } else {
      t = await dirTarget(desc.id, desc.label, desc.dir, desc.category);
    }
    sizeSoFar += t.size;
    if (onProgress) onProgress({ current: desc.label, index: i + 1, total, sizeSoFar });
    if (t.present && t.size > 0) targets.push(t);
  }

  const present = targets.sort((a, b) => b.size - a.size);
  const totalSize = present.reduce((a, t) => a + t.size, 0);

  const categories = {};
  for (const t of present) {
    const cat = t.category || 'Other';
    if (!categories[cat]) categories[cat] = { name: cat, items: [], totalSize: 0 };
    categories[cat].items.push(t);
    categories[cat].totalSize += t.size;
  }

  const categoryList = Object.values(categories).sort((a, b) => b.totalSize - a.totalSize);

  const result = { targets: present, totalSize, categories: categoryList };
  Object.defineProperty(result, '_matchers', { value: matcherMap, enumerable: false });
  return result;
}

async function deleteJunk(ids) {
  const { targets, _matchers } = await computeJunk();
  const results = [];
  for (const id of ids) {
    const t = targets.find((x) => x.id === id);
    if (!t) continue;
    const matcher = _matchers[id];
    let ok = false;
    let freed = 0;
    try {
      if (t.dir && fs.existsSync(t.dir)) {
        if (matcher) {
          // For file sets, delete matching files only
          const entries = await fs.promises.readdir(t.dir, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile()) continue;
            if (!matcher(e.name)) continue;
            try {
              const fp = path.join(t.dir, e.name);
              const st = await fs.promises.stat(fp);
              await fs.promises.unlink(fp);
              freed += st.size;
            } catch (_) {}
          }
          ok = freed > 0;
        } else {
          await fs.promises.rm(t.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
          freed = t.size;
          ok = true;
        }
      }
    } catch (_) {
      ok = false;
    }
    results.push({ id, ok, freed });
  }
  return results;
}

// Absolute paths of folder-based junk targets (recycle bin and file-only sets
// excluded) that still exist. Used by the audit to surface junk locations.
function getJunkRoots() {
  return buildDescriptors()
    .filter((d) => !d.special && !d.fileSet && fs.existsSync(d.dir))
    .map((d) => ({ dir: d.dir, label: d.label }));
}

module.exports = { computeJunk, deleteJunk, getJunkRoots };
