# System Monitor — Developer Notes

The technical details that used to live in the README: how it works, why it's built the way it is,
and how to build and test it. The [README](../README.md) is for people who just want to use the app.

Windows tray app showing live system stats. Click the tray icon and you get a 400×800 popup with
CPU / memory / disk / network cards, each with a 60-second graph, plus disk usage per drive and the
top 5 processes. Click the X (or the tray icon again) and it goes away.

Electron + React + TypeScript + Tailwind.

## Status

v1.0.0.

## Install

Grab `System.Monitor.Setup.1.0.0.exe` from the [Releases](../../releases) page and run it. It's a
one-click NSIS installer: ~25 s, no wizard pages, auto-closes a running instance, and launches when
it's done. Per-user, so no admin prompt.

Uninstall through Settings → Apps, or the Start Menu entry. It removes everything it created —
see [Installer](#installer) below for exactly what that covers.

### "Windows protected your PC"

You will get a SmartScreen warning on first run. **This is expected.** The installer isn't
code-signed, and Windows shows that warning for any unsigned application it hasn't seen before.

To continue: click **More info**, then **Run anyway**.

If you'd rather not, the alternative is to build it yourself — see
[Development](#development). The result is the same installer.

Code signing isn't just a switch that can be flipped: it needs a certificate purchased from a
certificate authority, and since June 2023 the private key has to live on a hardware token or a
cloud signing service. Worth doing if this ever picks up real users; overkill for a free tray app
right now.

### Verifying your download

Signing proves *who* built something. A checksum only proves the file wasn't altered in transit —
less useful, but free, so here it is. For the v1.0.0 installer:

```
SHA-256  bb573a46ff62f5fd3c99f0418772af9a2ddc0a67fc4c90c8c2f4606079361ece
```

Check it in PowerShell:

```powershell
Get-FileHash "System.Monitor.Setup.1.0.0.exe" -Algorithm SHA256
```

(GitHub replaces spaces with dots in release asset names, so the downloaded file is
`System.Monitor.Setup.1.0.0.exe` even though the build produces it with spaces.)

That hash covers the exact binary attached to the v1.0.0 release. A build you produce yourself will
not match it — Electron builds embed timestamps and aren't byte-reproducible.

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
on Windows means never. (Verified: `out/main/index.js` is ~22 kB with `import("systeminformation")`
left external.)

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
- **`settings.ts`** — typed `electron-store` wrapper for the `autoLaunch` boolean.

### Preload (`src/preload/`)

- **`index.ts`** — narrow `window.monitor` API via `contextBridge`; `ipcRenderer` is never leaked.
  Exposed: `onStats`, `onReset`, `getSettings`, `setAutoLaunch`, `hide`, `quit`, `openTaskManager`.
  The two `on*` subscribers return an unsubscribe function.

### Renderer (`src/renderer/`)

- **`index.html`** — strict CSP (verbatim from spec), no external anything.
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

## Installer

`electron-builder.yml` plus `build/installer.nsh` (electron-builder auto-includes that path).

One-click NSIS, per-user, Start Menu shortcut only. `compression: store` trades installer size for
install speed — though it didn't visibly change the size, and that was never chased down.

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
  orphaned another ~78 MB.

The last two are skipped when `${isUpdated}`, since during an upgrade this uninstaller runs as a
step of the new install: `$INSTDIR` is about to be reused, and the cached installer may be the very
file driving the upgrade.

Verified by clean install → uninstall → audit cycles checking nine things: install dir, `%APPDATA%`
profile, updater cache, running processes, Run value, uninstall registry entry, `HKCU\Software\`
app key, Start Menu shortcut, desktop shortcut.

**Note:** `autoLaunch` defaults to `false`, so a fresh install writes no Run value at all. If you're
re-testing that cleanup path, turn the setting on first or you'll get a false pass.

## Optimizations

- Nothing runs while the popup is hidden: timers cleared, `typeperf` and the PowerShell worker
  killed, tray tooltip static. Measured **0.00% CPU closed, 0.33% open**.
- The 1 s tick makes no async system calls on Windows — it reads an already-parsed snapshot.
- `systeminformation` is lazy-loaded, so its ~200 files never load on Windows. Loading it eagerly
  was pure startup cost at login.
- **Every card starts on the same tick.** `typeperf` needs ~3 s before its first sample, because
  rate counters need two readings to produce one value. There was briefly a seeding path that
  served memory from `os.freemem()` and CPU from an `os.cpus()` delta to fill that gap — but disk
  and network are pure rates with no native equivalent, so only two of the four cards could be
  seeded, and they ended up ~3 samples ahead with visibly offset graph lines. Now nothing is sent
  until the first complete snapshot exists and all four start together (~3.1 s of "—" on open). The
  worker's process list and drive usage arrive ~0.3 s earlier and are parked so they don't beat the
  cards to the screen. Uptime still flows during the wait — it isn't a rolling counter.
- The header rides IPC once and stays referentially stable so the renderer's memo holds; uptime
  rides each tick as a plain number instead.
- All React components memoized. `App.tsx` uses `useMemo` for derived strings and a `useRef` mirror
  of the buffers to avoid a state-update race.

## Verification

1. `npm install` — OK.
2. `npm run typecheck` — clean.
3. `npm run build` — `out/main` 22.0 kB, `out/preload` 0.8 kB, `out/renderer` index.html + 16.5 kB
   CSS + 229.1 kB JS.
4. `npm run dist` — `release/System Monitor Setup 1.0.0.exe` (~78 MB).
5. `npm audit --omit=dev` — 2 high, 1 moderate. See below.
6. Grep of `src/` for `fetch(` / `XMLHttpRequest` / `net.request` / `https.request` / `axios` — zero
   hits.
7. Reboot test — auto-launch at login, no black screen, no console flashes.
8. Install → uninstall → audit cycle — no files, registry entries, or shortcuts left behind.

## Known audit findings

`npm audit --omit=dev` reports three, none of them our code:

- **`electron` (high)** — Electron 32 has a long list of published CVEs: ASAR integrity bypass,
  various use-after-free in permission callbacks, unquoted path in `setLoginItemSettings`, header
  injection in custom protocol handlers, and so on. Our hardening removes most of the attack
  surface: no remote content, no `webview`, no file drop, no custom protocol handlers, sandbox +
  contextIsolation, and `connect-src 'none'` in the CSP. The `setLoginItemSettings` one is worth
  naming specifically since we do call it — but with `openAtLogin: bool` and a fixed `['--hidden']`
  args array, so there's no user-controlled path to inject into.
- **`menubar` (moderate)** — transitive, it's just the `electron` finding again.
- **`fast-uri` (high)** — host confusion via backslash authority delimiter. Reached through
  `electron-store` → `conf` → `ajv`, which we use to validate a two-line local config file
  (`{ autoLaunch: boolean }`). The vulnerable path is URI parsing; we never hand it a URI, let alone
  an untrusted one.

For a stricter posture, upgrade to `electron@^37` (breaking) and retest. Deferred as a follow-up.

## Deviations from the spec (per the spec's flag-it rule)

1. **`electron-store` pinned to `^8.2.0`** rather than latest. v10 is ESM-only and fights Electron
   main's CJS resolution — v8 is the safe pin.
2. **Installer "Launch on login" checkbox** — deferred. The `setLoginItemSettings` API is fully
   wired and callable at runtime via the settings gear; adding an installer-time checkbox means more
   NSIS work in `build/installer.nsh`. The runtime feature works end to end.

## Windows-specific build workaround

On non-admin Windows without Developer Mode, `electron-builder`'s 7-Zip extraction of the
`winCodeSign` archive fails on two macOS symlinks (`libcrypto.dylib`, `libssl.dylib`) that a
Windows-only build never needs. To make `npm run dist` work here,
`node_modules/7zip-bin/win/x64/7za.exe` is replaced by a small C# wrapper that:

1. Forwards all args to the real `_7za-real.exe` (kept alongside).
2. If the exit code is 2 **and** stderr contains "Cannot create symbolic link" plus
   "darwin"/".dylib", exits 0 instead.
3. Otherwise passes the real exit code through untouched.

Source is at `scripts/sza-wrapper.cs` (checked in for reproducibility) — build with:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:x64 /out:node_modules\7zip-bin\win\x64\7za.exe scripts\sza-wrapper.cs
```

Do this once after every fresh `npm install`.

Long-term fix options: enable Windows Developer Mode (grants `SeCreateSymbolicLinkPrivilege` to the
user) or run the build as admin.

## Development

```
npm run dev        # electron-vite dev server
npm run typecheck  # tsc --noEmit, both configs
npm run build      # bundle to out/
npm run dist       # build + package the NSIS installer
```

Two things that will waste your time otherwise:

- **Single-instance lock.** Kill the running "System Monitor" process before launching a dev or diag
  copy, or the new one exits silently with code 0 and you'll wonder why nothing happened.
- **Diag mode.** `SM_DIAG=1` logs every IPC payload's fields, the rendered UI text, and FIT/DRAG
  probes to `%TEMP%\sm-stats.log`, and auto-opens the popup a few seconds after launch. All the UI
  verification was done through this.

Note that `setLoginItem()` deliberately no-ops unless `app.isPackaged`. Without that guard every dev
run rewrote the OS login entry to point at `node_modules\electron\dist\electron.exe --hidden`,
hijacking login to launch the dev copy and leaving a dangling Run value aimed into the project
folder.
