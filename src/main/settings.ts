import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface AppSettings {
  autoLaunch: boolean
}

const DEFAULTS: AppSettings = {
  autoLaunch: false
}

// One boolean doesn't need a settings library. Same file name and location
// electron-store used (%APPDATA%\system-monitor\config.json), so settings
// saved by v1.0.0 carry straight over on upgrade.
const settingsPath = (): string => join(app.getPath('userData'), 'config.json')

// Anything missing, malformed or the wrong type falls back to the default —
// a hand-edited or half-written file can never crash the app.
function load(): AppSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
    const autoLaunch = (raw as Record<string, unknown>).autoLaunch
    return {
      autoLaunch: typeof autoLaunch === 'boolean' ? autoLaunch : DEFAULTS.autoLaunch
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export class Settings {
  private values: AppSettings = load()

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.values[key]
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.values = { ...this.values, [key]: value }
    // Write to a temp file then rename over the real one, so a crash
    // mid-write can't leave a truncated config behind.
    const path = settingsPath()
    const tmp = `${path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      console.warn('[settings] save failed:', err)
    }
  }

  getAll(): AppSettings {
    return { ...this.values }
  }
}
