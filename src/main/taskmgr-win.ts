import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { screen } from 'electron'

// Task Manager restores its own saved window placement, which tends to be a
// small window pinned near the top-left, so launching it normally gives no
// control over where it lands.
//
// The obvious approach — move the window with SetWindowPos once it appears —
// does not work and cannot be made to work: Taskmgr.exe ships with
// uiAccess="true" in its manifest, which puts it above normal applications for
// UIPI purposes. A medium-integrity process (which this app is, and should
// stay) gets ERROR_ACCESS_DENIED. Elevating ourselves to work around that
// would be a wildly disproportionate amount of privilege for a cosmetic tweak.
//
// So instead the saved placement is edited before launch. Task Manager reads
// it on startup, writes it back on exit, and it lives in the user's own
// LOCALAPPDATA, so no elevation is involved.
//
// Caveat: this only affects a launch that actually starts Task Manager. If it
// is already running, starting it again just focuses the existing window,
// which we still cannot move.

const SETTINGS_PATH = join(
  process.env.LOCALAPPDATA ?? '',
  'Microsoft',
  'Windows',
  'TaskManager',
  'settings.json'
)

// Fraction of the work area to fill, and floors so it stays usable on a small
// display. MARGIN keeps the window off the screen edges.
const WIDTH_FRACTION = 0.55
const HEIGHT_FRACTION = 0.65
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
const MARGIN = 80

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function fit(available: number, fraction: number, minimum: number): number {
  const roomy = available - MARGIN
  if (roomy <= minimum) return Math.max(1, roomy)
  return Math.min(Math.max(Math.round(available * fraction), minimum), roomy)
}

// Centred on whichever display the cursor is on — the user just clicked our
// button, so that's the screen they're looking at.
function targetRect(): Rect {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const width = fit(area.width, WIDTH_FRACTION, MIN_WIDTH)
  const height = fit(area.height, HEIGHT_FRACTION, MIN_HEIGHT)
  const dip = {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  }
  // Electron reports display geometry in DIP; the settings file is in physical
  // pixels. Identical at 100% scaling, different everywhere else.
  return screen.dipToScreenRect(null, dip)
}

// Matches the whole "FullPosition":{...} object so it can be swapped without
// re-serialising the rest of the file. The settings blob also holds column
// widths, sort order and a long efficiency-mode deny list; a full parse and
// stringify would reformat all of it, so a targeted replacement is the smaller
// blast radius if the format ever shifts.
const FULL_POSITION_RE = /"FullPosition"\s*:\s*\{[^{}]*\}/

interface SavedPosition {
  Left: number
  Top: number
  Right: number
  Bottom: number
}

function isPosition(value: unknown): value is SavedPosition {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.Left === 'number' &&
    typeof p.Top === 'number' &&
    typeof p.Right === 'number' &&
    typeof p.Bottom === 'number'
  )
}

// Best-effort by design. The format is undocumented and could change in any
// Windows update, so every assumption is checked and anything unexpected means
// we leave the file exactly as it was: the button still opens Task Manager,
// just wherever Task Manager wanted it. The file is never created.
function saveCentredPlacement(rect: Rect): void {
  let raw: string
  try {
    raw = readFileSync(SETTINGS_PATH, 'utf8')
  } catch {
    return
  }

  // Parse only to validate that this really is the settings shape we expect.
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return
    if (!isPosition((parsed as Record<string, unknown>).FullPosition)) return
  } catch {
    return
  }

  const matches = raw.match(new RegExp(FULL_POSITION_RE, 'g'))
  if (!matches || matches.length !== 1) return

  const replacement =
    `"FullPosition":{"Left":${rect.x},"Top":${rect.y},` +
    `"Right":${rect.x + rect.width},"Bottom":${rect.y + rect.height}}`
  const updated = raw.replace(FULL_POSITION_RE, replacement)

  try {
    writeFileSync(SETTINGS_PATH, updated, 'utf8')
  } catch {
    /* read-only or locked — Task Manager just opens where it was */
  }
}

export function launchTaskManager(): void {
  // Placement has to be written before the process starts, since Task Manager
  // reads it once during startup.
  try {
    saveCentredPlacement(targetRect())
  } catch {
    /* never let a cosmetic step stop the button from working */
  }

  // Absolute path (no PATH lookup), detached + unref so Task Manager outlives
  // us and we hold no handle on it.
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'Taskmgr.exe')
  try {
    spawn(exe, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* Task Manager unavailable — nothing sensible to do */
  }
}
