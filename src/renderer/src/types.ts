export interface AppSettings {
  autoLaunch: boolean
}

export interface CpuStats {
  overall: number
  cores: number
}

export interface MemoryStats {
  used: number
  total: number
  percent: number
}

export interface DiskUsage {
  drive: string
  used: number
  total: number
  percent: number
}

export interface DiskIO {
  // Task Manager-style "Active time" %. Only available on Windows.
  activePct?: number
  readPerSec: number
  writePerSec: number
}

export interface NetworkStats {
  upPerSec: number
  downPerSec: number
}

export interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memBytes: number
}

export interface HeaderInfo {
  hostname: string
  os: string
  cpuModel: string
  totalRam: number
  gpu: string
}

export interface Stats {
  timestamp: number
  cpu?: CpuStats
  memory?: MemoryStats
  diskUsage?: DiskUsage[]
  diskIO?: DiskIO
  network?: NetworkStats
  processes?: ProcessInfo[]
  // Sent once; static system facts. Uptime travels separately below so the
  // header object stays referentially stable in the renderer (React.memo).
  header?: HeaderInfo
  uptime?: number
}

export interface MonitorAPI {
  onStats: (cb: (stats: Stats) => void) => () => void
  // Fired when the popup hides so the next open starts with fresh graphs.
  onReset: (cb: () => void) => () => void
  getSettings: () => Promise<AppSettings>
  setAutoLaunch: (enabled: boolean) => Promise<boolean>
  hide: () => Promise<void>
  quit: () => Promise<void>
  openTaskManager: () => Promise<void>
}

declare global {
  interface Window {
    monitor: MonitorAPI
  }
}
