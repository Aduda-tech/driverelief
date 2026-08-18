const bridge = window.api;

const els = {
  status: document.getElementById('status'),
  btnScan: document.getElementById('btn-scan'),
  driveSelect: document.getElementById('drive-select'),
  driveInfo: document.getElementById('drive-info'),
  btnRefreshDrives: document.getElementById('btn-refresh-drives'),
  mirrorRoot: document.getElementById('mirror-root'),
  mirrorPreview: document.getElementById('mirror-preview'),
  scanTotals: document.getElementById('scan-totals'),
  btnCheckAll: document.getElementById('btn-check-all'),
  btnMove: document.getElementById('btn-move'),
  scanProgress: document.getElementById('scan-progress'),
  moveProgress: document.getElementById('move-progress'),
  tree: document.getElementById('tree'),
  excluded: document.getElementById('excluded'),
  btnCheckNew: document.getElementById('btn-check-new'),
  btnMoveNew: document.getElementById('btn-move-new'),
  newFiles: document.getElementById('new-files'),
  junkTotal: document.getElementById('junk-total'),
  btnScanJunk: document.getElementById('btn-scan-junk'),
  btnDeleteJunk: document.getElementById('btn-delete-junk'),
  junkList: document.getElementById('junk-list'),
  auditTotals: document.getElementById('audit-totals'),
  btnAudit: document.getElementById('btn-audit'),
  btnAuditSelectAll: document.getElementById('btn-audit-select-all'),
  btnAuditClear: document.getElementById('btn-audit-clear'),
  btnAuditMove: document.getElementById('btn-audit-move'),
  btnAuditDelete: document.getElementById('btn-audit-delete'),
  auditProgress: document.getElementById('audit-progress'),
  auditNote: document.getElementById('audit-note'),
  auditList: document.getElementById('audit-list'),
  programNote: document.getElementById('program-note'),
  programList: document.getElementById('program-list'),
  reminderInterval: document.getElementById('reminder-interval'),
  watchFolders: document.getElementById('watch-folders'),
  authorizedDriveName: document.getElementById('authorized-drive-name'),
  autoMoveEnabled: document.getElementById('auto-move-enabled'),
  autoMoveOnConnect: document.getElementById('auto-move-on-connect'),
  keepIcons: document.getElementById('keep-icons'),
  autoStart: document.getElementById('auto-start'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  settingsSaved: document.getElementById('settings-saved'),
  toast: document.getElementById('toast'),
  transferBanner: document.getElementById('transfer-banner'),
  transferBannerText: document.getElementById('transfer-banner-text'),
  btnResumeTransfer: document.getElementById('btn-resume-transfer'),
  btnDismissTransfer: document.getElementById('btn-dismiss-transfer')
};

// ---------- View switching ----------

let activeView = 'scan';

function switchView(name) {
  activeView = name;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.toolbar-row').forEach((r) => r.classList.toggle('hidden', r.dataset.toolbar !== name));
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function ensureView(name) {
  if (activeView !== name) switchView(name);
}

let scanData = null;
let drives = [];
let selectedDrive = null;
let junkData = null;
let newFiles = [];
let auditData = null;
const auditSelected = new Set();

const WATCH_FOLDER_OPTIONS = ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music'];

function fmt(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

function setStatus(text, busy) {
  els.status.textContent = text;
  if (busy) els.status.style.color = 'var(--accent)';
  else els.status.style.color = '';
}

function toast(type, text) {
  els.toast.textContent = text;
  els.toast.className = `toast ${type}`;
  setTimeout(() => {
    els.toast.className = 'toast hidden';
  }, 5000);
}

function isSource(item) {
  return item.scanned && !item.protected && item.type !== 'profile';
}

// ---------- Drives ----------

async function refreshDrives() {
  drives = await bridge.listDrives();
  els.driveSelect.innerHTML = '';
  if (drives.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No external drive found — connect one';
    els.driveSelect.appendChild(opt);
    selectedDrive = null;
    els.driveInfo.textContent = '';
    setStatus('No external drive detected. Connect one and press Refresh.', true);
    return;
  }
  for (const d of drives) {
    const opt = document.createElement('option');
    opt.value = `${d.letter}:`;
    opt.textContent = `${d.letter}: ${d.label} (${d.kind || 'drive'}) — ${fmt(d.free)} free`;
    els.driveSelect.appendChild(opt);
  }
  const saved = (await bridge.getSettings()).targetDrive;
  const pref = saved && drives.some((d) => `${d.letter}:` === saved) ? saved : `${drives[0].letter}:`;
  els.driveSelect.value = pref;
  selectedDrive = pref;
  const d = drives.find((x) => `${x.letter}:` === pref);
  els.driveInfo.textContent = d ? `${fmt(d.size)} total, ${fmt(d.free)} free` : '';
  setStatus('Ready');
}

els.btnRefreshDrives.addEventListener('click', () => {
  refreshDrives();
  if (newFiles.length === 0) {
    checkNewFiles();
  }
});

els.driveSelect.addEventListener('change', () => {
  selectedDrive = els.driveSelect.value;
  bridge.setSettings({ targetDrive: selectedDrive });
  const d = drives.find((x) => `${x.letter}:` === selectedDrive);
  els.driveInfo.textContent = d ? `${fmt(d.size)} total, ${fmt(d.free)} free` : '';
});

// ---------- Mirror root ----------

els.mirrorRoot.addEventListener('input', () => {
  els.mirrorPreview.textContent = els.mirrorRoot.value.trim() || 'C-drive-mirror';
});

// ---------- Scan ----------

function renderExcluded(excluded) {
  els.excluded.classList.remove('hidden');
  els.excluded.innerHTML = '<h3>Protected / system locations (skipped)</h3>';
  for (const e of excluded.slice(0, 200)) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span>${escapeHtml(e.name)}</span><span>— ${escapeHtml(e.reason)}</span>`;
    els.excluded.appendChild(div);
  }
  if (excluded.length > 200) {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = `…and ${excluded.length - 200} more`;
    els.excluded.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTree(data) {
  els.tree.innerHTML = '';
  els.tree.insertAdjacentHTML('afterbegin', '<div class="col-head"><span class="col-check"></span><span class="col-name">Name</span><span class="col-size">Size</span><span class="col-count">Files</span></div>');
  for (const item of data.roots) {
    if (item.type === 'profile') {
      const row = document.createElement('div');
      row.className = 'node bold';
      row.innerHTML = `<span class="col-check"></span><span class="col-name"><span class="path-text">📁 ${escapeHtml(item.name)}</span></span><span class="col-size">${fmt(item.size)}</span><span class="col-count">${item.fileCount.toLocaleString()}</span>`;
      els.tree.appendChild(row);
      for (const child of item.children) {
        els.tree.appendChild(makeNode(child, true));
      }
    } else {
      els.tree.appendChild(makeNode(item, false));
    }
  }
  updateScanTotals();
}

function makeNode(item, indent) {
  const row = document.createElement('div');
  row.className = `node${indent ? ' indent' : ''}`;
  const isSrc = isSource(item);
  const icon = item.type === 'file' ? '📄' : '📁';
  row.innerHTML = `
    <span class="col-check"><input type="checkbox" ${isSrc ? '' : 'disabled'} ${isSrc ? 'checked' : ''} data-path="${escapeHtml(item.path)}" /></span>
    <span class="col-name"><span class="path-text">${icon} ${escapeHtml(item.name)}</span></span>
    <span class="col-size">${fmt(item.size)}</span>
    <span class="col-count">${item.fileCount.toLocaleString()}</span>`;
  if (!isSrc) row.classList.add('protected');
  row.querySelector('input').addEventListener('change', updateMoveButton);
  return row;
}

function selectedSources() {
  if (!scanData) return [];
  const paths = [];
  for (const input of els.tree.querySelectorAll('input[type="checkbox"]')) {
    if (input.checked && input.dataset.path) paths.push(input.dataset.path);
  }
  return paths;
}

function updateScanTotals() {
  if (!scanData) return;
  els.scanTotals.textContent = `Moveable: ${fmt(scanData.totalSize)} across ${scanData.totalFiles.toLocaleString()} files`;
  updateMoveButton();
}

function updateMoveButton() {
  const sources = selectedSources();
  els.btnMove.disabled = sources.length === 0 || !selectedDrive;
}

function showProgress(container, text) {
  container.classList.remove('hidden');
  container.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
}

function setProgressText(container, text) {
  const span = container.querySelector('span');
  if (span) span.textContent = text;
}

function hideProgress(container) {
  container.classList.add('hidden');
  container.innerHTML = '';
}

async function runScan() {
  ensureView('scan');
  setStatus('Scanning drive…', true);
  showProgress(els.scanProgress, 'Scanning…');
  els.btnScan.disabled = true;
  els.tree.innerHTML = '<div class="empty-state small"><span class="empty-sub">Scanning…</span></div>';
  try {
    scanData = await bridge.scan();
    renderTree(scanData);
    renderExcluded(scanData.excluded);
    setStatus('Scan complete', false);
  } catch (err) {
    setStatus('Scan failed', false);
    toast('error', `Scan failed: ${err.message}`);
  } finally {
    hideProgress(els.scanProgress);
    els.btnScan.disabled = false;
  }
}

els.btnScan.addEventListener('click', runScan);
els.btnCheckAll.addEventListener('click', () => {
  for (const input of els.tree.querySelectorAll('input[type="checkbox"]:not(:disabled)')) {
    input.checked = true;
  }
  updateMoveButton();
});

els.btnMove.addEventListener('click', async () => {
  const sources = selectedSources();
  if (!sources.length || !selectedDrive) return;
  const bytes = sources.reduce(
    (a, p) => a + (findNode(scanData.roots, p)?.size || 0),
    0
  );
  const ok = confirm(`Move ${sources.length} source folder(s) (${fmt(bytes)}) to ${selectedDrive}\\${els.mirrorRoot.value.trim() || 'C-drive-mirror'}?\n\n${sources.map((s) => '• ' + s).join('\n')}\n\nThe folder structure on your C: drive is preserved on the external drive.`);
  if (!ok) return;
  els.btnMove.disabled = true;
  setStatus('Moving files…', true);
  showProgress(els.moveProgress, 'Moving…');
  try {
    const res = await bridge.move({
      target: selectedDrive,
      mirrorRoot: els.mirrorRoot.value.trim() || 'C-drive-mirror',
      sourcePaths: sources
    });
    hideProgress(els.moveProgress);
    setStatus('Move complete', false);
    toast(
      'ok',
      `Moved ${res.moved.toLocaleString()} files (${fmt(res.bytesMoved)}) to ${res.base}`
    );
    if (res.failed.length) {
      toast('error', `${res.failed.length} file(s) could not be moved (in use or locked).`);
    }
    if (res.emptyDirsRemoved) toast('ok', `Removed ${res.emptyDirsRemoved} empty folder(s).`);
    runScan();
  } catch (err) {
    hideProgress(els.moveProgress);
    setStatus('Move failed', false);
    toast('error', `Move failed: ${err.message}`);
  } finally {
    updateMoveButton();
  }
});

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children && n.children.length) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- Junk ----------

const SAFE_CATEGORY = ['System Temp', 'Windows Update', 'Browser Cache', 'Thumbnail Cache', 'Package Caches', 'Installer Temp', 'App Cache', 'Recycle Bin'];

function renderJunk(data) {
  els.junkList.innerHTML = '';
  const { categories, totalSize } = data;

  const head = document.createElement('div');
  head.className = 'empty-state small';
  head.textContent = `${fmt(totalSize)} reclaimable across ${data.targets.length} items in ${categories.length} categories.`;
  els.junkList.appendChild(head);

  // Safe total
  let safeTotal = 0;
  for (const cat of categories) {
    if (SAFE_CATEGORY.includes(cat.name)) safeTotal += cat.totalSize;
  }

  // Clean All Safe button
  if (safeTotal > 0) {
    const safeRow = document.createElement('div');
    safeRow.className = 'node junk-safe-header';
    safeRow.innerHTML = `
      <button class="primary small btn-clean-all-safe">Clean all safe (${fmt(safeTotal)})</button>
      <span class="muted">Temp, caches, installer files — safe to delete</span>`;
    els.junkList.appendChild(safeRow);
    safeRow.querySelector('.btn-clean-all-safe').addEventListener('click', () => {
      const safeIds = data.targets
        .filter((t) => SAFE_CATEGORY.includes(t.category))
        .map((t) => t.id);
      if (safeIds.length) deleteJunkWithIds(safeIds, safeTotal);
    });
  }

  // Render categories
  for (const cat of categories) {
    const catDiv = document.createElement('div');
    catDiv.className = 'junk-category';
    const isSafe = SAFE_CATEGORY.includes(cat.name);
    const safeTag = isSafe ? '<span class="tag junk">safe</span>' : '<span class="tag system">review</span>';
    catDiv.innerHTML = `
      <div class="junk-cat-header" data-cat="${escapeHtml(cat.name)}">
        <span class="junk-cat-toggle">▶</span>
        <span class="name">${escapeHtml(cat.name)} ${safeTag}</span>
        <span class="size">${fmt(cat.totalSize)}</span>
        <span class="count">${cat.items.length} item(s)</span>
      </div>
      <div class="junk-cat-items hidden"></div>`;
    els.junkList.appendChild(catDiv);

    const itemsDiv = catDiv.querySelector('.junk-cat-items');
    const headerDiv = catDiv.querySelector('.junk-cat-header');

    headerDiv.addEventListener('click', () => {
      const expanded = itemsDiv.classList.toggle('hidden');
      headerDiv.querySelector('.junk-cat-toggle').textContent = expanded ? '▶' : '▼';
    });

    for (const item of cat.items) {
      const row = document.createElement('div');
      row.className = 'node indent';
      row.innerHTML = `
        <span class="col-check"><input type="checkbox" checked data-id="${item.id}" /></span>
        <span class="col-name"><span class="path-text">🗑 ${escapeHtml(item.label)}</span></span>
        <span class="col-size">${fmt(item.size)}</span>
        <span class="col-count">${item.fileCount.toLocaleString()}</span>`;
      row.querySelector('input').addEventListener('change', updateDeleteButton);
      itemsDiv.appendChild(row);
    }
  }
  updateDeleteButton();
}

function selectedJunkIds() {
  const ids = [];
  for (const input of els.junkList.querySelectorAll('input[type="checkbox"]')) {
    if (input.checked) ids.push(input.dataset.id);
  }
  return ids;
}

function updateDeleteButton() {
  els.btnDeleteJunk.disabled = selectedJunkIds().length === 0;
}

async function deleteJunkWithIds(ids, bytes) {
  if (!ids.length) return;
  const ok = confirm(`Delete selected items (${fmt(bytes)})?\n\nThis permanently removes cache, temp and download cache files. It is safe for your documents.`);
  if (!ok) return;
  els.btnDeleteJunk.disabled = true;
  setStatus('Deleting…', true);
  try {
    const cachedTargets = junkData ? junkData.targets : null;
    const res = await bridge.deleteJunk(ids, cachedTargets);
    const freed = res.results.reduce((a, r) => a + (r.ok ? r.freed : 0), 0);
    junkData = res.junk;
    renderJunk(junkData);
    els.junkTotal.textContent = `${fmt(junkData.totalSize)} reclaimable`;
    setStatus('Cleanup complete', false);
    toast('ok', `Freed ${fmt(freed)}`);
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length) toast('error', `${failed.length} item(s) could not be deleted (files in use).`);
  } catch (err) {
    setStatus('Cleanup failed', false);
    toast('error', `Cleanup failed: ${err.message}`);
  } finally {
    updateDeleteButton();
  }
}

els.btnScanJunk.addEventListener('click', async () => {
  ensureView('junk');
  setStatus('Scanning junk…', true);
  showProgress(els.scanProgress, 'Scanning junk…');
  try {
    junkData = await bridge.scanJunk();
    renderJunk(junkData);
    els.junkTotal.textContent = `${fmt(junkData.totalSize)} reclaimable`;
    setStatus('Junk scan complete', false);
  } catch (err) {
    setStatus('Junk scan failed', false);
    toast('error', `Junk scan failed: ${err.message}`);
  } finally {
    hideProgress(els.scanProgress);
  }
});

bridge.onJunkProgress((p) => {
  if (els.scanProgress.classList.contains('hidden')) return;
  const done = p.index > 0;
  const scanned = p.sizeSoFar ? ` — ${fmt(p.sizeSoFar)} so far` : '';
  setProgressText(els.scanProgress, `Scanning junk (${p.index}/${p.total}): ${p.current}${scanned}`);
  if (done) els.junkTotal.textContent = `Found ${fmt(p.sizeSoFar)} so far…`;
});

els.btnDeleteJunk.addEventListener('click', async () => {
  const ids = selectedJunkIds();
  if (!ids.length) return;
  const bytes = junkData.targets.filter((t) => ids.includes(t.id)).reduce((a, t) => a + t.size, 0);
  deleteJunkWithIds(ids, bytes);
});

// ---------- Audit ----------

function renderAudit(data) {
  auditData = data;
  els.auditList.innerHTML = '';
  els.auditList.insertAdjacentHTML('afterbegin', '<div class="col-head"><span class="col-check"></span><span class="col-name">Path</span><span class="col-size">Size</span></div>');
  for (const item of data.items) {
    const row = document.createElement('div');
    const canAct = !item.system;
    row.className = `node${canAct ? '' : ' system'}`;
    const icon = item.type === 'folder' ? '📁' : '📄';
    const tags = [];
    if (item.system) tags.push('<span class="tag system">system</span>');
    if (item.type === 'folder' && item.manySmall) tags.push('<span class="tag">many small files</span>');
    if (item.junk && !item.system) tags.push('<span class="tag junk">junk</span>');
    row.innerHTML = `
      <span class="col-check"><input type="checkbox" ${canAct ? '' : 'disabled'} ${auditSelected.has(item.path) && canAct ? 'checked' : ''} data-path="${escapeHtml(item.path)}" data-size="${item.size}" /></span>
      <span class="col-name" title="${escapeHtml(item.path)}"><span class="path-text">${icon} ${escapeHtml(item.path)}</span>${tags.join('')}</span>
      <span class="col-size">${fmt(item.size)}</span>`;
    row.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) auditSelected.add(item.path);
      else auditSelected.delete(item.path);
      updateAuditButtons();
    });
    els.auditList.appendChild(row);
  }
  const th = data.thresholds;
  els.auditNote.textContent =
    `Full-disk scan: files ≥ ${fmt(th.fileTh)} listed individually; folders of many small files (≥ ${fmt(th.aggTh)}) as one entry. ` +
    `"system" items (Windows, Program Files, AppData…) are view-only and can't be moved or deleted here.` +
    (data.items.length >= 2000 ? ' List capped at 2000 entries.' : '');
  updateAuditButtons();
}

function renderPrograms(list) {
  els.programList.innerHTML = '';
  els.programList.insertAdjacentHTML('afterbegin', '<div class="col-head"><span class="col-check"></span><span class="col-name">Program</span><span class="col-size">Size</span><span class="col-count"></span></div>');
  const shown = (list || []).slice(0, 25);
  if (shown.length === 0) {
    els.programList.innerHTML = '<div class="empty">No uninstallable programs found.</div>';
    els.programNote.textContent = '';
    return;
  }
  els.programNote.textContent = list.length > 25 ? `Top ${shown.length} of ${list.length}` : `${list.length} found`;
  for (const p of shown) {
    const row = document.createElement('div');
    row.className = 'node';
    const meta = [p.publisher, p.version].filter(Boolean).join(' · ');
    const sizeTag = p.estimated ? '<span class="tag">estimated</span>' : '';
    row.innerHTML = `
      <span class="col-check"></span>
      <span class="col-name" title="${escapeHtml([p.name, p.installPath].filter(Boolean).join(' — '))}"><span class="path-text">🧩 ${escapeHtml(p.name)}</span>${meta ? `<span class="muted"> — ${escapeHtml(meta)}</span>` : ''} ${sizeTag}</span>
      <span class="col-size">${fmt(p.size)}</span>
      <span class="col-count"><button class="ghost small btn-uninstall">Uninstall</button></span>`;
    row.querySelector('.btn-uninstall').addEventListener('click', () => uninstallProgramClick(p));
    els.programList.appendChild(row);
  }
}

async function uninstallProgramClick(p) {
  const ok = confirm(
    `Uninstall "${p.name}" (${fmt(p.size)})?\n\n` +
    `Drive Relief will launch the program's own uninstaller with admin rights. A UAC prompt may appear. ` +
    `When the uninstall finishes, re-run "Audit drive" to refresh.\n\n` +
    `Folder: ${p.installPath || '(unknown)'}`
  );
  if (!ok) return;
  setStatus(`Launching uninstaller for ${p.name}…`, true);
  try {
    const res = await bridge.uninstallProgram(p.id);
    if (res.error) {
      setStatus('Uninstall not started', false);
      toast('error', res.error);
      return;
    }
    setStatus(`Uninstaller launched for ${res.name} — re-run audit when done`, false);
    toast('ok', `Uninstaller launched for ${res.name}. Finish it, then re-run Audit.`);
  } catch (err) {
    setStatus('Uninstall launch failed', false);
    toast('error', `Uninstall launch failed: ${err.message}`);
  }
}

function selectedAuditItems() {
  if (!auditData) return [];
  return auditData.items.filter((it) => auditSelected.has(it.path) && !it.system);
}

function updateAuditButtons() {
  const items = selectedAuditItems();
  const n = items.length;
  const bytes = items.reduce((a, it) => a + (it.size || 0), 0);
  els.btnAuditMove.disabled = n === 0 || !selectedDrive;
  els.btnAuditDelete.disabled = n === 0;
  els.auditTotals.textContent =
    n > 0
      ? `${n} selected (${fmt(bytes)})`
      : auditData
        ? `Accounted ${fmt(auditData.totalSize)}${auditData.disk ? ` · ${fmt(auditData.disk.size)} capacity, ${fmt(auditData.disk.free)} free` : ''}`
        : '';
}

async function runAudit() {
  ensureView('audit');
  setStatus('Auditing drive…', true);
  showProgress(els.auditProgress, 'Auditing…');
  els.btnAudit.disabled = true;
  auditSelected.clear();
  els.auditList.innerHTML = '<div class="empty-state small"><span class="empty-sub">Auditing…</span></div>';
  try {
    const data = await bridge.audit();
    renderAudit(data);
    renderPrograms(data.programs);
    setStatus(`Audit complete — ${data.items.length} biggest entries`, false);
    toast('ok', `Audit found ${fmt(data.totalSize)} of moveable files (${data.fileCount.toLocaleString()} files).`);
  } catch (err) {
    setStatus('Audit failed', false);
    toast('error', `Audit failed: ${err.message}`);
  } finally {
    hideProgress(els.auditProgress);
    els.btnAudit.disabled = false;
  }
}

els.btnAudit.addEventListener('click', runAudit);

els.btnAuditSelectAll.addEventListener('click', () => {
  if (!auditData) return;
  for (const item of auditData.items) if (!item.system) auditSelected.add(item.path);
  for (const input of els.auditList.querySelectorAll('input[type="checkbox"]:not(:disabled)')) input.checked = true;
  updateAuditButtons();
});

els.btnAuditClear.addEventListener('click', () => {
  auditSelected.clear();
  for (const input of els.auditList.querySelectorAll('input[type="checkbox"]')) input.checked = false;
  updateAuditButtons();
});

els.btnAuditMove.addEventListener('click', async () => {
  const items = selectedAuditItems();
  if (!items.length || !selectedDrive) return;
  const bytes = items.reduce((a, it) => a + (it.size || 0), 0);
  const ok = confirm(`Move ${items.length} item(s) (${fmt(bytes)}) to ${selectedDrive}\\${els.mirrorRoot.value.trim() || 'C-drive-mirror'}?\n\n${items.map((s) => '• ' + s.path).join('\n')}\n\nThe folder structure on your C: drive is preserved on the external drive.`);
  if (!ok) return;
  els.btnAuditMove.disabled = true;
  setStatus('Moving audit items…', true);
  showProgress(els.moveProgress, 'Moving…');
  try {
    const res = await bridge.auditMove({
      target: selectedDrive,
      mirrorRoot: els.mirrorRoot.value.trim() || 'C-drive-mirror',
      sourcePaths: items.map((it) => it.path)
    });
    hideProgress(els.moveProgress);
    setStatus('Move complete', false);
    toast('ok', `Moved ${res.moved.toLocaleString()} files (${fmt(res.bytesMoved)}) to ${res.base}`);
    if (res.failed.length) toast('error', `${res.failed.length} file(s) could not be moved (in use or locked).`);
    runAudit();
  } catch (err) {
    hideProgress(els.moveProgress);
    setStatus('Move failed', false);
    toast('error', `Move failed: ${err.message}`);
  } finally {
    updateAuditButtons();
  }
});

els.btnAuditDelete.addEventListener('click', async () => {
  const items = selectedAuditItems();
  if (!items.length) return;
  const bytes = items.reduce((a, it) => a + (it.size || 0), 0);
  const ok = confirm(`Delete ${items.length} item(s) (${fmt(bytes)})?\n\n${items.map((s) => '• ' + s.path).join('\n')}\n\nThis permanently removes these items. They will NOT go to the Recycle Bin.`);
  if (!ok) return;
  els.btnAuditDelete.disabled = true;
  setStatus('Deleting…', true);
  try {
    const res = await bridge.auditDelete(items.map((it) => ({ path: it.path, size: it.size })));
    setStatus('Delete complete', false);
    toast('ok', `Deleted ${res.deleted} item(s), freed ${fmt(res.freed)}`);
    if (res.failed.length) toast('error', `${res.failed.length} item(s) could not be deleted (in use or locked).`);
    runAudit();
  } catch (err) {
    setStatus('Delete failed', false);
    toast('error', `Delete failed: ${err.message}`);
  } finally {
    updateAuditButtons();
  }
});

bridge.onAuditProgress((p) => {
  if (els.auditProgress.classList.contains('hidden')) return;
  setProgressText(els.auditProgress, `Auditing… ${p.files.toLocaleString()} files, ${p.current}`);
});

// ---------- New files ----------

function renderNewFiles() {
  els.newFiles.innerHTML = '';
  if (newFiles.length === 0) {
    els.newFiles.innerHTML = '<div class="empty-state small"><span class="empty-sub">No new files to move. Download something new and press "Check now".</span></div>';
    els.btnMoveNew.disabled = true;
    return;
  }
  els.newFiles.insertAdjacentHTML('afterbegin', '<div class="col-head"><span class="col-check"></span><span class="col-name">File</span><span class="col-size">Size</span><span class="col-count">Date</span></div>');
  const show = newFiles.slice(0, 200);
  const totalBytes = newFiles.reduce((a, f) => a + f.size, 0);
  const head = document.createElement('div');
  head.className = 'empty-state small';
  head.textContent = `${newFiles.length} file(s) (${fmt(totalBytes)}) not yet on the external drive.`;
  els.newFiles.appendChild(head);
  for (const f of show) {
    const row = document.createElement('div');
    row.className = 'node';
    const when = new Date(f.mtimeMs).toLocaleString();
    row.innerHTML = `<span class="col-check"></span><span class="col-name" title="${escapeHtml(f.path)}"><span class="path-text">📄 ${escapeHtml(f.name || f.path)}</span></span><span class="col-size">${fmt(f.size)}</span><span class="col-count">${escapeHtml(when)}</span>`;
    els.newFiles.appendChild(row);
  }
  if (newFiles.length > 200) {
    const row = document.createElement('div');
    row.className = 'empty-state small';
    row.textContent = `…and ${newFiles.length - 200} more`;
    els.newFiles.appendChild(row);
  }
  els.btnMoveNew.disabled = !selectedDrive;
}

async function checkNewFiles() {
  setStatus('Checking for new files…', true);
  try {
    const res = await bridge.listNewFiles();
    if (!res.target) {
      setStatus('No removable drive detected', true);
      toast('error', 'Connect the external drive first.');
      return;
    }
    selectedDrive = res.target;
    newFiles = res.files;
    renderNewFiles();
    setStatus(res.files.length ? `${res.files.length} new file(s) awaiting move` : 'Up to date', false);
  } catch (err) {
    setStatus('Check failed', false);
    toast('error', `Check failed: ${err.message}`);
  }
}

els.btnCheckNew.addEventListener('click', checkNewFiles);

els.btnMoveNew.addEventListener('click', async () => {
  if (!selectedDrive) return;
  const ok = confirm(`Move ${newFiles.length} new file(s) (${fmt(newFiles.reduce((a, f) => a + f.size, 0))}) to the external drive?`);
  if (!ok) return;
  els.btnMoveNew.disabled = true;
  setStatus('Moving new files…', true);
  showProgress(els.moveProgress, 'Moving new files…');
  try {
    const res = await bridge.moveNewFiles({ target: selectedDrive });
    hideProgress(els.moveProgress);
    setStatus('Done', false);
    toast('ok', `Moved ${res.moved.toLocaleString()} file(s) (${fmt(res.bytesMoved)})`);
    if (res.failed.length) toast('error', `${res.failed.length} file(s) could not be moved (in use or locked).`);
    checkNewFiles();
  } catch (err) {
    hideProgress(els.moveProgress);
    setStatus('Move failed', false);
    toast('error', `Move failed: ${err.message}`);
  } finally {
    updateMoveButton();
  }
});

// ---------- Settings ----------

function renderWatchChips(cfg) {
  els.watchFolders.innerHTML = '';
  for (const name of WATCH_FOLDER_OPTIONS) {
    const label = document.createElement('label');
    label.className = `chip${cfg.watchFolders.includes(name) ? ' checked' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = cfg.watchFolders.includes(name);
    input.addEventListener('change', () => {
      label.classList.toggle('checked', input.checked);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(name));
    els.watchFolders.appendChild(label);
  }
}

async function loadSettings() {
  const cfg = await bridge.getSettings();
  els.reminderInterval.value = cfg.reminderIntervalMin;
  els.mirrorRoot.value = cfg.mirrorRoot;
  els.mirrorPreview.textContent = cfg.mirrorRoot;
  els.authorizedDriveName.value = cfg.authorizedDriveName || '';
  els.autoMoveEnabled.checked = cfg.autoMoveEnabled !== false;
  els.autoMoveOnConnect.checked = cfg.autoMoveOnConnect !== false;
  els.keepIcons.checked = cfg.keepIcons === true;
  els.autoStart.checked = cfg.autoStart !== false;
  renderWatchChips(cfg);
}

els.btnSaveSettings.addEventListener('click', async () => {
  const interval = Math.max(1, Number(els.reminderInterval.value) || 15);
  const watchFolders = [];
  for (const chip of els.watchFolders.querySelectorAll('.chip')) {
    if (chip.querySelector('input').checked) watchFolders.push(chip.textContent.trim());
  }
  await bridge.setSettings({
    reminderIntervalMin: interval,
    watchFolders,
    mirrorRoot: els.mirrorRoot.value.trim() || 'C-drive-mirror',
    targetDrive: selectedDrive || undefined,
    authorizedDriveName: els.authorizedDriveName.value.trim(),
    autoMoveEnabled: els.autoMoveEnabled.checked,
    autoMoveOnConnect: els.autoMoveOnConnect.checked,
    keepIcons: els.keepIcons.checked,
    autoStart: els.autoStart.checked
  });
  els.mirrorPreview.textContent = els.mirrorRoot.value.trim() || 'C-drive-mirror';
  els.settingsSaved.textContent = 'Saved';
  setTimeout(() => { els.settingsSaved.textContent = ''; }, 2000);
  toast('ok', 'Settings saved');
});

// ---------- IPC events ----------

bridge.onScanProgress((p) => {
  if (p.phase === 'scan') setProgressText(els.scanProgress, `Scanning… ${p.current}`);
});

bridge.onMoveProgress((p) => {
  if (p.bytesMoved !== undefined) {
    setProgressText(els.moveProgress, `Moving… ${p.moved.toLocaleString()} files, ${fmt(p.bytesMoved)}`);
  }
});

bridge.onReminder((p) => {
  toast('ok', `${p.count} new file${p.count === 1 ? '' : 's'} (${fmt(p.bytes)}) ready to move`);
});

bridge.onToast((p) => toast(p.type, p.text));

bridge.onNewFilesMoved(() => {
  checkNewFiles();
});

bridge.onTransferInterrupted((state) => {
  if (!els.transferBanner) return;
  const ago = state.startedAt ? ` (started ${new Date(state.startedAt).toLocaleString()})` : '';
  els.transferBannerText.textContent = `A file transfer was interrupted${ago}. ${state.processed || 0} files processed.`;
  els.transferBanner.classList.remove('hidden');
  els.btnResumeTransfer.addEventListener('click', async () => {
    els.transferBanner.classList.add('hidden');
    setStatus('Resuming transfer…', true);
    try {
      const cfg = await bridge.getSettings();
      const target = state.target || selectedDrive;
      if (!target) {
        toast('error', 'Connect the authorized drive first.');
        return;
      }
      toast('ok', 'Resuming transfer. Files already copied will be skipped.');
    } catch (err) {
      toast('error', `Resume failed: ${err.message}`);
    }
  });
  els.btnDismissTransfer.addEventListener('click', () => {
    els.transferBanner.classList.add('hidden');
  });
});

// ---------- Boot ----------

async function boot() {
  await loadSettings();
  await refreshDrives();
}

boot();
