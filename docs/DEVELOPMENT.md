# System Monitor — Developer Notes

Everything that used to live in the README: how it works, why it's built the way it is, and how
to build and test it. The [README](../README.md) is for people who just want to use the thing.

Electron 44 + React + TypeScript + Tailwind. 400×800 frameless popup anchored to the tray via
`menubar`.

## Building

```
npm install
npm run dev        # electron-vite dev server
npm run typecheck  # tsc --noEmit, both configs
npm run build      # bundle to out/
npm run dist       # build + package the NSIS installer into release/
```

Electron 44 no longer downloads its binary in a postinstall script — it fetches it on first use
(verified against the `checksums.json` shipped in the package). So the first `npm run dev` or
`npm run dist` after a fresh install pauses for a download. `npx install-electron` does it up front.

`allowScripts` in `package.json` is npm 11's install-script allowlist. Only `esbuild` needs its
script. `electron-winstaller` (pulled in by electron-builder for Squirrel targets we don't build)
is deliberately left unapproved.

Two things that will waste your time otherwise:

- **Single-instance lock.** Kill the running "System Monitor" process before launching a dev or diag
  copy, or the new one hands off to the running copy (which opens its popup) and exits.
- **Diag mode.** `SM_DIAG=1` logs every IPC payload's fields, the rendered UI text, and FIT/DRAG
  probes to `%TEMP%\sm-stats.log`, auto-opens the popup 3 s after launch and hides it at 24 s.
  All the UI verification was done through this.

`setLoginItem()` deliberately no-ops unless `app.isPackaged`. Without that guard every dev run
rewrote the OS login entry to point at `node_modules\electron\dist\electron.exe --hidden`,
hijacking login to launch the dev copy and leaving a dangling Run value aimed into the project
folder.

## The short version of how it works

The whole design goal is **zero cost when you're not looking at it.** While the popup is closed
there are no timers, no child processes, and no polling — the tray tooltip is a static string.
Everything spins up on `after-show` and is torn down on `after-hide`.

On Windows the data comes from two helper children that only live while the popup is open:

- **`typeperf`** streams the same performance counters Task Manager reads — CPU, available memory,
  disk active %, disk read/write bytes/sec, network in/out — all sampled at the same instant, once a
  second. The 1 s render tick just reads the latest snapshot, so it makes no system calls at all.
- **A looping PowerShell worker** emits one JSON line every ~2.8 s with the top processes and
  per-drive usage.

Both are spawned with `windowsHide: true`. That matters: earlier versions shelled out through
`systeminformation`, which spawns without hiding, and that's what flashed console windows across the
screen during login.

`systeminformation` is still a dependency for macOS/Linux, but it's lazy-loaded on first use — which
on Windows means never.

## What's in the box

### Main process (`src/main/`)

- **`index.ts`** — menubar wiring, single-instance lock, `--hidden` CLI flag, navigation lockdown
  (`will-navigate` denied, `setWindowOpenHandler` denied), whitelisted IPC handlers, login-item sync,
  hardened `webPreferences` (contextIsolation + sandbox + no nodeIntegration, spellcheck off,
  DevTools off when packaged). Also:
  - `app.disableHardwareAcceleration()` — GPU-accelerated window creation during logon hung
    DWM/explorer on the target machine (full black screen at boot). The UI is static cards and tiny
    SVG paths, so software rendering looks identical.
  - `preloadWindow: !startHidden` — at login the renderer window isn't created at all; the logon
    session is still settling and window creation was the thing blacking out the screen. The first
    tray click pays ~1 s instead.
  - `alwaysOnTop: true` — also disables menubar's hide-on-blur, so the popup stays put until you
    close it. `maximizable: false` because double-clicking a drag region maximizes a frameless
    window by default, which used to fling the popup into the top-left corner.
  - `second-instance` opens the popup. Launching from the Start Menu while it's already running
    used to do nothing visible at all.
- **`stats.ts`** — the polling engine. 1 s fast tick; a 5 s slow tick that only runs off-Windows
  (on Windows that data is pushed by the worker instead). Re-entrancy guards so ticks can't overlap.
  Collects the header once and caches it, with `prime()` warming it in the background before the
  first open — and at login it waits 15 s first, since WMI is contended during the logon rush.
  Header is native `os` module plus one hidden PowerShell call for the GPU name (4 s timeout so a
  stuck WMI query can't hang it).
- **`counters-win.ts`** — the `typeperf` stream. Parses the PDH-CSV header row to map counter paths
  to column indices, since wildcard counters (network) expand to one column per adapter. Caps
  `% Processor Utility` at 100 the way Task Manager does (it exceeds 100 under turbo boost) and
  converts disk `% Idle Time` into active %. Counter paths are English-locale; on localized Windows
  `typeperf` exits nonzero and the cards just show "—".
- **`worker-win.ts`** — the PowerShell worker. Replaces `si.processes()`, which permanently hangs on
  systeminformation's shared persistent shell under Electron, and `si.fsSize()`. Normalizes
  `PercentProcessorTime` by core count to match Task Manager's percentages, and strips the `#2`
  suffix perf instance names use to disambiguate duplicates.
- **`taskmgr-win.ts`** — launches Task Manager centred and at a usable size. Worth knowing why it
  works the way it does: you *cannot* move Task Manager's window with `SetWindowPos`, because
  `Taskmgr.exe` ships with `uiAccess="true"` in its manifest, which puts it above normal
  applications for UIPI purposes — a medium-integrity process gets `ERROR_ACCESS_DENIED`, on
  admin and non-admin accounts alike. Instead its saved placement is edited before launch. Windows
  11 keeps that as plain JSON in `%LOCALAPPDATA%\Microsoft\Windows\TaskManager\settings.json` (the
  old `HKCU\...\CurrentVersion\TaskManager\Preferences` key no longer exists), and Task Manager
  reads it during startup. Sized to 55% × 65% of the work area with 900×600 floors, centred on
  whichever display the cursor is on. The format is undocumented, so it's strictly best-effort: the
  file is never created, and it's only rewritten when it exists, parses, already contains a
  well-formed `FullPosition`, and the pattern matches exactly once — otherwise Task Manager just
  opens where it always did. A targeted replacement is used rather than a parse-and-restringify so
  the rest of the blob (column widths, sort order, a 77-entry deny list) survives byte-for-byte.
  **Limitation:** if Task Manager is already running, launching it only focuses the existing
  window, which still can't be moved.
- **`settings.ts`** — the `autoLaunch` boolean, read from and written to
  `%APPDATA%\system-monitor\config.json` with plain `fs`. Same file `electron-store` used in
  v1.0.0, so upgrades keep the setting. Anything missing or malformed falls back to the default;
  writes go to a temp file and are renamed over the real one so a crash can't truncate it.
  (`electron-store` was dropped in v1.1.0 — a whole library plus `ajv`/`fast-uri` for one boolean,
  and its newer versions are ESM-only.)

### Preload (`src/preload/`)

- **`index.ts`** — narrow `window.monitor` API via `contextBridge`; `ipcRenderer` is never leaked.
  Exposed: `onStats`, `onReset`, `getSettings`, `setAutoLaunch`, `hide`, `quit`, `openTaskManager`.
  The two `on*` subscribers return an unsubscribe function.

### Renderer (`src/renderer/`)

- **`index.html`** — strict CSP, no external anything (`connect-src 'none'`).
- **`src/App.tsx`** — subscribes to `onStats`, maintains rolling 60-sample buffers, wires settings.
  On `onReset` it wipes the buffers *and* the live readings, so reopening the popup is a genuinely
  fresh quick glance rather than showing stale numbers from minutes ago. Header and drive usage
  survive the reset — they aren't rolling counters.
- **`src/components/Sparkline.tsx`** — inline SVG line + area fill over a **fixed 60-slot window**.
  The newest sample is pinned to the right edge and history grows leftward, like Task Manager,
  rather than stretching a handful of points across the full width. Hovering shows a crosshair,
  marker dot, and a tooltip with the value and age ("28% · 7s ago"). Single `<path>` per layer with
  `vectorEffect="non-scaling-stroke"` for crisp lines at any width.
- **`src/components/MetricCard.tsx`** — reusable card (label + value + detail + sparkline), passing
  `max`, `window` and a `format` callback down to the graph. Memoized.
- **`src/components/Header.tsx`** — hostname, OS, CPU model, RAM, GPU (loaded once at startup).
  **Doubles as the window's drag handle** (`.app-drag` is what makes a frameless window movable) and
  hosts the close button as a no-drag child. The X used to be a `position: fixed` overlay, which
  didn't reliably punch a clickable hole in the drag region and left the button dead.
- **`src/components/ProcessList.tsx`** — top-5 CPU-consuming processes.
- **`src/components/Footer.tsx`** — uptime, a **Task Manager** button, and a settings-gear dropdown
  (auto-launch toggle, quit). Closes on outside click.
- **`src/format.ts`** — byte / bytes-per-sec / uptime formatters.
- **`src/types.ts`** — shared `Stats` / `HeaderInfo` / `MonitorAPI` types, imported by main and
  preload too so the IPC payload has one definition.

### Resources

- **`resources/tray.ico`** — 16/24/32/48 px multi-res, blue rounded square with 3-bar chart glyph.
- **`resources/icon.ico`** — 16/24/32/48/64/128/256 px multi-res, same look.
- Generated by **`scripts/make-icons.mjs`** (zero-dep, pure Node zlib + CRC32 + PNG + ICO). Re-run to
  regenerate.
- **`docs/screenshot.png`** — the README image, cropped from a live diag run.

## Installer

`electron-builder.yml` plus `build/installer.nsh` (electron-builder auto-includes that path).

One-click NSIS, per-user, Start Menu shortcut only. No wizard pages, so there's nowhere for a
"Launch on login" checkbox — that's set from the gear menu instead.

`compression: store` barely matters: it was measured at 108.1 MB vs 107.6 MB with `normal`,
because electron-builder compresses the app payload itself regardless. Left as-is.

**Uninstall leaves nothing behind.** That took three fixes, two of them working around gaps in
electron-builder's own NSIS template:

- `deleteAppDataOnUninstall: true` clears `%APPDATA%\system-monitor` — the settings file *and* the
  whole Chromium profile (Cache / GPUCache / Local Storage / Network).
- `customUnInstall` deletes the HKCU `...\Run` value. Electron writes that at runtime via
  `setLoginItemSettings`, so NSIS has no way to know it exists. The value is named after the appId;
  both that and the product-name spelling are cleared, via electron-builder's own `${APP_ID}` and
  `${PRODUCT_NAME}` defines so they can't drift from `electron-builder.yml`.
- `customUnInstall` also steps the working directory out to `$TEMP` before removing `$INSTDIR`.
  electron-builder's `un.onInit` does `SetOutPath $INSTDIR`, making the install folder the
  uninstaller's own CWD — and Windows won't delete a directory a live process is sitting in, so its
  `RMDir /r $INSTDIR` emptied the folder but left the shell behind permanently.
- Finally it removes `$LOCALAPPDATA\<pkg>-updater\`, where the installer caches a copy of itself for
  future updates. Nothing in electron-builder's uninstaller cleans that up, so every install
  orphaned another copy of the installer.

The last two are skipped when `${isUpdated}`, since during an upgrade this uninstaller runs as a
step of the new install: `$INSTDIR` is about to be reused, and the cached installer may be the very
file driving the upgrade.

**Note:** `autoLaunch` defaults to `false`, so a fresh install writes no Run value at all. If you're
re-testing that cleanup path, turn the setting on first or you'll get a false pass. (Easiest:
drop `{"autoLaunch":true}` into `%APPDATA%\system-monitor\config.json` before launching.)

The old 7-Zip wrapper hack for building without Developer Mode is gone — electron-builder 26 no
longer trips over the macOS symlinks in `winCodeSign`, so `npm run dist` works on a plain non-admin
account.

## Optimizations

- Nothing runs while the popup is hidden: timers cleared, `typeperf` and the PowerShell worker
  killed, tray tooltip static.
- The 1 s tick makes no async system calls on Windows — it reads an already-parsed snapshot.
- `systeminformation` is lazy-loaded, so its ~200 files never load on Windows.
- **Every card starts on the same tick.** `typeperf` needs ~3 s before its first sample, because
  rate counters need two readings to produce one value. There was briefly a seeding path that
  served memory from `os.freemem()` and CPU from an `os.cpus()` delta to fill that gap — but disk
  and network are pure rates with no native equivalent, so only two of the four cards could be
  seeded, and they ended up ~3 samples ahead with visibly offset graph lines. Now nothing is sent
  until the first complete snapshot exists and all four start together (~3 s of "—" on open). The
  worker's process list and drive usage arrive slightly earlier and are parked so they don't beat
  the cards to the screen. Uptime still flows during the wait — it isn't a rolling counter.
- The header rides IPC once and stays referentially stable so the renderer's memo holds; uptime
  rides each tick as a plain number instead.
- All React components memoized. `App.tsx` uses `useMemo` for derived strings and a `useRef` mirror
  of the buffers to avoid a state-update race.

## Verification (v1.1.0)

Run on the Windows 11 build VM (26200):

1. `npm install` — OK. `npm run typecheck` — clean.
2. `npm run dist` — `release/System Monitor Setup 1.1.0.exe` (~108 MB; v1.0.0 on Electron 32 was
   ~78 MB — newer Electron is simply bigger).
3. `npm audit --omit=dev` (what actually ships) — **0 vulnerabilities**, down from 3.
4. Grep of `src/` for `fetch(` / `XMLHttpRequest` / `net.request` / `https.request` / `axios` — zero
   hits.
5. Upgrade path — seeded a v1.0.0-style `config.json` with `autoLaunch: true`, installed, launched:
   setting read and the Run value written.
6. Diag run — header, all four graphs, drive usage and top processes populate; popup fits 800/800
   with no scroll; drag region and close button correct; reset on hide.
7. Second launch while running — opens the popup, no duplicate process.
8. Idle cost with popup closed — no child processes, ~0% CPU, ~51 MB memory. Popup open: ~91 MB,
   `typeperf` + `powershell` running.
9. Install → uninstall → audit — all nine clean: install dir, `%APPDATA%` profile, updater cache,
   running processes, Run value, uninstall registry entry, `HKCU\Software\` app key, Start Menu
   shortcut, desktop shortcut.

**Not verified in the VM:** reboot → auto-launch at login (no black screen, no console flashes).
Needs a real machine.

## Known issues and ideas

- **Slow process list on a cold/busy machine.** The very first `Win32_PerfFormattedData_PerfProc_Process`
  query after boot makes WMI rebuild its perf-class cache. Normally 0.3 s; measured at **67 s** once
  on the VM while Windows Update and Defender were hammering it. Until then "Top processes" sits on
  "Waiting…" and the drive bars don't appear. Not a regression — just worth knowing. A fix would be
  splitting drive usage (instant) from the process query so at least that shows up right away.
- **Network may double-count on Hyper-V hosts.** `\Network Interface(*)` is summed across every
  adapter. With an external Hyper-V virtual switch, host traffic can show on both the physical NIC
  and the `vEthernet` adapter. Couldn't reproduce on the build VM (no vSwitch) — check on a real
  Hyper-V machine before changing anything.
- **Non-English Windows** shows "—" on all four cards, since `typeperf` counter paths are localized.
  Fixable by resolving counter names by index (PDH's English-name APIs) instead of hard-coded paths.
- **Code signing.** The SmartScreen warning goes away only with a code-signing certificate, which
  since June 2023 has to live on a hardware token or cloud signing service. Overkill for a free
  tray app right now.
- **Size.** Electron bundles a whole Chromium, so the install is ~375 MB on disk for a 400×800
  window. A native C#/WPF rewrite would be a few MB and ~30–40 MB of memory — a candidate for a
  future v2.

## Release checksums

Each GitHub release lists the SHA-256 of its installer. Check a download with:

```powershell
Get-FileHash "System.Monitor.Setup.1.1.0.exe" -Algorithm SHA256
```

GitHub replaces spaces with dots in release asset names, so the downloaded file is
`System.Monitor.Setup.1.1.0.exe` even though the build produces `System Monitor Setup 1.1.0.exe`.
A build you produce yourself won't match the published hash — Electron builds embed timestamps and
aren't byte-reproducible.

v1.0.0: `bb573a46ff62f5fd3c99f0418772af9a2ddc0a67fc4c90c8c2f4606079361ece`
