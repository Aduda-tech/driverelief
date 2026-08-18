const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function psScript(text) {
  return Buffer.from(text, 'utf16le').toString('base64');
}

function runPs(script, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psScript(script)],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stderr: (stderr || '') + ' ' + (err.message || '') });
        else resolve({ ok: true, stdout });
      }
    );
  });
}

const REGISTRY_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$out = @()
foreach ($p in $paths) {
  Get-ItemProperty -Path $p | ForEach-Object {
    if ($_.DisplayName) {
      $out += [PSCustomObject]@{
        name = [string]$_.DisplayName
        version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        location = [string]$_.InstallLocation
        uninstall = [string]$_.UninstallString
        quiet = [string]$_.QuietUninstallString
        estKb = [int64]$_.EstimatedSize
      }
    }
  }
}
$root = [System.IO.Path]::GetPathRoot([Environment]::GetFolderPath('UserProfile'))
$d = New-Object System.IO.DriveInfo($root)
$payload = [PSCustomObject]@{
  programs = $out
  disk = [PSCustomObject]@{ size = $d.TotalSize; free = $d.AvailableFreeSpace }
}
$payload | ConvertTo-Json -Compress -Depth 3
`;

const UPDATE_RE = /^(update for|security update|hotfix|service pack|kb\d+)/i;

const BAD_LOCATIONS = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'users']);

async function scanRegistry() {
  const res = await runPs(REGISTRY_SCRIPT);
  if (!res.ok) return { programs: [], disk: null, error: res.stderr };
  try {
    const data = JSON.parse(res.stdout);
    const disk =
      data && data.disk && typeof data.disk.size === 'number'
        ? { size: data.disk.size, free: data.disk.free }
        : null;
    const raw = Array.isArray(data && data.programs) ? data.programs : [];
    const programs = raw
      .filter((p) => p && p.name && !UPDATE_RE.test(String(p.name)) && (p.uninstall || p.quiet))
      .map((p) => {
        const installPath = String(p.location || '').trim();
        const uninstallString = String(p.uninstall || '').trim();
        const quietString = String(p.quiet || '').trim();
        return {
          id: encodeURIComponent(`${p.name}|${installPath}|${uninstallString || quietString}`),
          name: String(p.name).trim(),
          version: String(p.version || '').trim(),
          publisher: String(p.publisher || '').trim(),
          installPath,
          uninstallString,
          quietUninstallString: quietString,
          estimatedSizeKb: Number(p.estKb) || 0,
          size: 0,
          estimated: false
        };
      });
    const seen = new Map();
    for (const p of programs) {
      const k = `${p.name.toLowerCase()}|${p.installPath.toLowerCase()}`;
      const existing = seen.get(k);
      if (!existing || p.estimatedSizeKb > existing.estimatedSizeKb) {
        seen.set(k, p);
      }
    }
    const dedup = [...seen.values()];
    return { programs: dedup, disk };
  } catch (err) {
    return { programs: [], disk: null, error: err.message };
  }
}

function isBadLocation(p) {
  if (!p) return true;
  const cleaned = p.replace(/[\\/]+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(cleaned)) return true;
  if (/^[a-z]:\\?$/.test(cleaned)) return true;
  const key = path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const parts = key.split('\\');
  if (parts.length <= 1) return true;
  return BAD_LOCATIONS.has(parts[1]);
}

function resolveSize(installPath, sizeLookup) {
  if (!installPath || !sizeLookup) return 0;
  const key = path.resolve(installPath).replace(/[\\/]+$/, '').toLowerCase();
  const hit = sizeLookup.get(key);
  return typeof hit === 'number' ? hit : 0;
}

async function buildProgramList({ sizeLookup } = {}) {
  const { programs, disk, error } = await scanRegistry();
  const list = programs
    .map((p) => {
      let size = 0;
      let estimated = false;
      if (p.installPath) {
        if (isBadLocation(p.installPath)) return null;
        size = resolveSize(p.installPath, sizeLookup);
      }
      if (!size && p.estimatedSizeKb > 0) {
        size = p.estimatedSizeKb * 1024;
        estimated = true;
      }
      if (!size) return null;
      return { ...p, size, estimated };
    })
    .filter(Boolean)
    .filter((p) => p.size >= 10 * 1024 * 1024)
    .sort((a, b) => b.size - a.size);
  return { programs: list, disk, error };
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function parseCommandLine(cmd) {
  cmd = (cmd || '').trim();
  if (!cmd) return null;
  const q = cmd.match(/^"([^"]+)"\s*(.*)$/);
  if (q) return { exe: q[1], rest: q[2].trim() };
  const sp = cmd.indexOf(' ');
  if (sp === -1) return { exe: cmd, rest: '' };
  return { exe: cmd.slice(0, sp), rest: cmd.slice(sp + 1).trim() };
}

function sq(s) {
  return String(s).replace(/'/g, "''");
}

async function uninstallProgram(entry) {
  if (!entry || !entry.name) return { error: 'Unknown program' };
  const cmd = (entry.quietUninstallString || entry.uninstallString || '').trim();
  if (!cmd) return { error: `No uninstaller available for ${entry.name}` };

  let exe;
  let argParts;
  const parsed = parseCommandLine(cmd);
  if (!parsed || !parsed.exe || !/\.exe$/i.test(parsed.exe)) {
    exe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    argParts = ['/c', cmd];
  } else if (/^msiexec(\.exe)?$/i.test(path.basename(parsed.exe))) {
    exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe');
    const rest = parsed.rest.replace(/^\/I(?=\[?{)/i, '/X');
    argParts = rest ? splitArgs(rest) : [];
  } else {
    exe = parsed.exe;
    argParts = parsed.rest ? splitArgs(parsed.rest) : [];
  }

  const argList =
    argParts && argParts.length ? `-ArgumentList @(${argParts.map((a) => `'${sq(a)}'`).join(',')})` : '';
  const script = `Start-Process -FilePath '${sq(exe)}' ${argList} -Verb RunAs`;
  const res = await runPs(script, 60000);
  if (!res.ok) {
    const msg = (res.stderr || '').trim();
    const cancelled = /cancel|denied|operation was canceled|access is denied/i.test(msg);
    return {
      error: cancelled
        ? 'Uninstall cancelled (UAC prompt declined).'
        : `Failed to launch uninstaller: ${msg || 'unknown error'}`
    };
  }
  return { launched: true, name: entry.name };
}

module.exports = { scanRegistry, buildProgramList, uninstallProgram, parseCommandLine, splitArgs };
