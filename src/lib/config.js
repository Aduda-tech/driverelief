const fs = require('fs');
const path = require('path');

let userDataDir = null;

const DEFAULTS = {
  mirrorRoot: 'C-drive-mirror',
  reminderIntervalMin: 15,
  watchFolders: ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music'],
  lastReminderRun: 0,
  targetDrive: 'D:',
  authorizedDriveName: '',
  transferStateFile: '',
  autoMoveEnabled: true,
  lastDismissedAt: 0,
  autoMoveOnConnect: true,
  keepIcons: false,
  autoStart: true
};

function init(userData) {
  userDataDir = userData;
  const cfgPath = path.join(userDataDir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      Object.assign(DEFAULTS, loaded);
    } catch (_) {
      // corrupt config, fall back to defaults
    }
  }
}

function get() {
  return { ...DEFAULTS };
}

function set(patch) {
  Object.assign(DEFAULTS, patch);
  if (userDataDir) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(DEFAULTS, null, 2));
    } catch (_) {
      // settings are not critical
    }
  }
  return get();
}

module.exports = { init, get, set };
