# Drive Relief

Free up space on your C: drive by moving files to external storage, cleaning junk, and auditing installed programs.

## Features

- **Scan & Move** — Scan your C: drive for moveable files and folders, then transfer them to an external drive while preserving the folder structure.
- **Clean Junk** — Find and delete cache, temp, installer, and browser files organized by category (safe to delete vs. review).
- **Audit Drive** — Full-disk overview of the biggest files and folders, plus a list of installed programs sorted by size with one-click uninstall.
- **Auto-Move** — Automatically moves new files from watched folders (Downloads, Desktop, Documents, etc.) to the target drive when it's connected.
- **Keep Icons** — After moving, creates junction points (folders) or symlinks (files) at the original location so shortcuts and file associations still work.

## Requirements

- Windows 10/11
- Node.js 18+
- An external USB or removable drive for file transfers

## Build from Source

```bash
npm install
npm run dist
```

The installer will be created in the `dist/` folder.

## Development

```bash
npm install
npm start
```

## Project Structure

```
src/
  main.js              — Electron main process (window, tray, IPC, auto-move)
  preload.js           — Context bridge for renderer IPC
  lib/
    config.js          — Persistent user settings
    scanner.js         — C: drive file scanner
    mover.js           — Resume-aware file mover with link creation
    junk.js            — Categorized junk file detection and deletion
    audit.js           — Full-disk audit with program listing
    drives.js          — Removable/USB drive detection
    programs.js        — Windows registry program enumeration
  renderer/
    index.html         — App layout (sidebar + views)
    renderer.js        — UI logic (scan, junk, audit, settings)
    styles.css         — Dark theme
```

## License

MIT
