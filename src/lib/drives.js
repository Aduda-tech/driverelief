const { execFile } = require('child_process');
const os = require('os');

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$volumes = Get-CimInstance Win32_LogicalDisk
foreach ($v in $volumes) {
  $t = [int]$v.DriveType
  $usb = $false
  if ($t -eq 3) {
    $part = Get-CimAssociatedInstance -InputObject $v -Association Win32_LogicalDiskToPartition | Select-Object -First 1
    if ($part) {
      $phys = Get-CimAssociatedInstance -InputObject $part -Association Win32_DiskDriveToDiskPartition | Select-Object -First 1
      if ($phys) {
        if ($phys.InterfaceType -match 'USB|IEEE1394|Thunderbolt' -or $phys.PNPDeviceID -match 'USBSTOR') { $usb = $true }
      }
    }
  }
  if ($t -eq 2 -or $usb -or $t -eq 3) {
    $out += [PSCustomObject]@{
      DeviceID   = $v.DeviceID
      DriveType  = $t
      VolumeName = $v.VolumeName
      Size       = $v.Size
      FreeSpace  = $v.FreeSpace
      Usb        = $usb
    }
  }
}
ConvertTo-Json -Compress -InputObject @{ Drives = @($out) }
`;

async function listRemovableDrives() {
  if (os.platform() !== 'win32') return [];
  const json = await runPowerShell(SCRIPT);
  const disks = json && Array.isArray(json.Drives) ? json.Drives : [];
  return disks
    .map((d) => ({
      letter: String(d.DeviceID || '').replace(':', ''),
      label: (d.VolumeName || (d.Usb ? 'USB Drive' : 'Removable Drive')).trim(),
      size: Number(d.Size) || 0,
      free: Number(d.FreeSpace) || 0,
      kind: d.Usb ? 'USB disk' : d.DriveType === 3 ? 'Fixed' : 'Removable',
      volumeName: (d.VolumeName || '').trim()
    }))
    .filter((d) => d.letter);
}

function isDriveAuthorized(drive, authorizedName) {
  if (!authorizedName || authorizedName.trim() === '') return true;
  return drive.volumeName.toLowerCase() === authorizedName.trim().toLowerCase();
}

module.exports = { listRemovableDrives, isDriveAuthorized };
