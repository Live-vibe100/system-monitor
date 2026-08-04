import { totalmem, uptime as osUptime, cpus, hostname, release } from 'os'
import { spawn } from 'child_process'
import type {
  Stats,
  HeaderInfo,
  CpuStats,
  MemoryStats,
  DiskUsage,
  DiskIO,
  NetworkStats,
  ProcessInfo
} from '../renderer/src/types'
import { WinCounters } from './counters-win'
import { WinWorker, type WorkerData } from './worker-win'

export type StatsSender = (stats: Stats) => void

const FAST_MS = 1000
const SLOW_MS = 5000
const IS_WINDOWS = process.platform === 'win32'

// systeminformation is only needed on non-Windows platforms (Windows uses
// typeperf + a PowerShell worker + the native os module). Loading its ~200
// files eagerly was pure startup cost at login, so it's imported on first
// use — on Windows that means never.
type SI = typeof import('systeminformation')
let siPromise: Promise<SI> | null = null
function loadSi(): Promise<SI> {
  siPromise ??= import('systeminformation')
  return siPromise
}

// Windows architecture: two helper children run ONLY while the popup is
// visible — a typeperf stream (counters-win.ts) covering CPU / memory /
// disk / network at the same sampling instant Task Manager uses, and a
// looping PowerShell worker (worker-win.ts) for top processes + disk
// usage. The 1s fast tick just reads the latest typeperf snapshot (no
// async system calls at all); worker results are forwarded as they land.
// systeminformation is only used for the one-time header and, on other
// platforms, the original polling path.
export class StatsEngine {
  private fastTimer: NodeJS.Timeout | null = null
  private slowTimer: NodeJS.Timeout | null = null
  private header: HeaderInfo | null = null
  private headerPromise: Promise<void> | null = null
  private fastBusy = false
  private slowBusy = false
  // Cleared on every start(): the popup only shows data once the first
  // complete counter sample exists, so each open begins in sync.
  private winPrimed = false
  private pendingWorker: WorkerData | null = null
  private winCounters = IS_WINDOWS ? new WinCounters() : null
  private winWorker = IS_WINDOWS
    ? new WinWorker((data) => {
        // The worker's first result lands slightly before typeperf's, so
        // holding it back keeps the process list and drive bars from
        // appearing ahead of the four metric cards.
        if (!this.winPrimed) {
          this.pendingWorker = data
          return
        }
        this.sender({
          timestamp: Date.now(),
          processes: data.processes,
          diskUsage: data.diskUsage
        })
      })
    : null

  constructor(private sender: StatsSender) {}

  // Call once at app launch, before the popup is first opened. The header
  // calls (osInfo/cpu/graphics) go through WMI and can take several seconds
  // on a VM; collecting in the background means the data is cached by the
  // time the user first clicks the tray icon. On non-Windows also primes
  // si.processes() so its first reading has a CPU%-delta baseline.
  prime(): void {
    void this.ensureHeader()
    if (!IS_WINDOWS) {
      void loadSi().then((si) => si.processes().catch(() => null))
    }
  }

  start(): void {
    if (this.fastTimer) return
    this.winCounters?.start()
    this.winWorker?.start()
    // Every open starts from nothing: the helpers were killed on hide, so
    // both sources have to warm up again and should surface together.
    this.winPrimed = false
    this.pendingWorker = null
    // Never block ticks on the header — send it now if cached, or let
    // ensureHeader() push it whenever it lands.
    if (this.header) {
      this.sender({ timestamp: Date.now(), header: this.header, uptime: osUptime() })
    } else {
      void this.ensureHeader()
    }
    this.tickFast()
    this.fastTimer = setInterval(() => this.tickFast(), FAST_MS)
    if (!IS_WINDOWS) {
      this.tickSlow()
      this.slowTimer = setInterval(() => this.tickSlow(), SLOW_MS)
    }
  }

  stop(): void {
    if (this.fastTimer) clearInterval(this.fastTimer)
    if (this.slowTimer) clearInterval(this.slowTimer)
    this.fastTimer = null
    this.slowTimer = null
    this.winCounters?.stop()
    this.winWorker?.stop()
  }

  // Full teardown on app quit (stop() only pauses for popup-hide).
  dispose(): void {
    this.stop()
  }

  private ensureHeader(): Promise<void> {
    if (!this.headerPromise) {
      this.headerPromise = this.collectHeader().then((h) => {
        this.header = h
        this.sender({ timestamp: Date.now(), header: h })
      })
    }
    return this.headerPromise
  }

  private async collectHeader(): Promise<HeaderInfo> {
    if (IS_WINDOWS) {
      // Native os module for everything except the GPU, plus one *hidden*
      // PowerShell call for the GPU name. Avoids systeminformation's
      // wmic/PowerShell shell-outs, which spawn without windowsHide and
      // flashed console windows on screen during login.
      return {
        hostname: hostname() || 'unknown',
        os: winOsLabel(),
        cpuModel: (cpus()[0]?.model ?? '').trim() || 'unknown',
        totalRam: totalmem(),
        gpu: await queryGpuName()
      }
    }
    try {
      const si = await loadSi()
      const [os, cpu, gfx] = await Promise.all([
        si.osInfo(),
        si.cpu(),
        si.graphics()
      ])
      const gpu = gfx.controllers?.[0]?.model ?? 'Unknown GPU'
      return {
        hostname: os.hostname ?? 'unknown',
        os: `${os.distro ?? ''} ${os.release ?? ''}`.trim() || 'unknown',
        cpuModel: `${cpu.manufacturer ?? ''} ${cpu.brand ?? ''}`.trim() || 'unknown',
        totalRam: totalmem(),
        gpu
      }
    } catch {
      return {
        hostname: 'unknown',
        os: 'unknown',
        cpuModel: 'unknown',
        totalRam: totalmem(),
        gpu: 'unknown'
      }
    }
  }

  private async tickFast(): Promise<void> {
    if (this.fastBusy) return
    this.fastBusy = true
    try {
      let cpu: CpuStats | undefined
      let memory: MemoryStats | undefined
      let diskIO: DiskIO | undefined
      let network: NetworkStats | undefined
      let processes: ProcessInfo[] | undefined
      let diskUsage: DiskUsage[] | undefined

      if (IS_WINDOWS) {
        // Everything comes from the typeperf snapshot — one sampling
        // instant, zero syscall latency, matches Task Manager's counters.
        const snap = this.winCounters?.snapshot()
        if (!snap) {
          // typeperf needs ~3s before its first sample, because rate counters
          // need two readings to produce one value. CPU and memory could be
          // served instantly from the native os module, and used to be — but
          // disk and network are pure rates with no native equivalent, so
          // that left two cards several samples ahead of the other two and
          // their graphs visibly offset. Nothing is sent until the first
          // complete sample exists, so all four start together. Uptime still
          // rides through: it's not a rolling counter and the footer would
          // otherwise sit blank.
          this.sender({ timestamp: Date.now(), uptime: osUptime() })
          return
        }
        const total = totalmem()
        const used = Math.max(0, total - snap.memAvailableBytes)
        cpu = { overall: snap.cpuUtilityPct, cores: cpusCount() }
        memory = {
          used,
          total,
          percent: total > 0 ? (used / total) * 100 : 0
        }
        diskIO = {
          activePct: snap.diskActivePct,
          readPerSec: snap.diskReadPerSec,
          writePerSec: snap.diskWritePerSec
        }
        network = {
          upPerSec: snap.netTxPerSec,
          downPerSec: snap.netRxPerSec
        }
        // First complete frame: release whatever the worker parked so the
        // process list and drive bars appear on the same paint as the cards.
        if (!this.winPrimed) {
          this.winPrimed = true
          if (this.pendingWorker) {
            processes = this.pendingWorker.processes
            diskUsage = this.pendingWorker.diskUsage
            this.pendingWorker = null
          }
        }
      } else {
        const si = await loadSi()
        const [load, mem, io, net] = await Promise.all([
          si.currentLoad().catch(() => null),
          si.mem().catch(() => null),
          si.disksIO().catch(() => null),
          si.networkStats().catch(() => null)
        ])
        if (load) {
          cpu = {
            overall: load.currentLoad ?? 0,
            cores: (load.cpus ?? []).length
          }
        }
        if (mem) {
          memory = {
            used: mem.active,
            total: mem.total,
            percent: mem.total > 0 ? (mem.active / mem.total) * 100 : 0
          }
        }
        if (io) {
          diskIO = {
            readPerSec: io.rIO_sec ?? 0,
            writePerSec: io.wIO_sec ?? 0
          }
        }
        const primaryNet = net?.find((n) => n.operstate === 'up') ?? net?.[0]
        if (primaryNet) {
          network = {
            upPerSec: primaryNet.tx_sec ?? 0,
            downPerSec: primaryNet.rx_sec ?? 0
          }
        }
      }

      this.sender({
        timestamp: Date.now(),
        cpu,
        memory,
        diskIO,
        network,
        processes,
        diskUsage,
        // Uptime rides every tick as a plain number; the header object is
        // sent once and stays stable so the renderer's memo works.
        uptime: osUptime()
      })
    } catch (err) {
      console.warn('[stats] fast tick failed:', err)
    } finally {
      this.fastBusy = false
    }
  }

  // Non-Windows only; Windows gets this data pushed from WinWorker.
  private async tickSlow(): Promise<void> {
    if (this.slowBusy) return
    this.slowBusy = true
    try {
      const si = await loadSi()
      const [fs, processes] = await Promise.all([
        si.fsSize().catch(() => null),
        si.processes().then(
          (procs) =>
            (procs.list ?? [])
              .filter((p) => (p.cpu ?? 0) > 0 || (p.memRss ?? 0) > 0)
              .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))
              .slice(0, 5)
              .map((p) => ({
                pid: p.pid,
                name: p.name ?? '?',
                cpu: p.cpu ?? 0,
                memBytes: (p.memRss ?? 0) * 1024
              })),
          () => [] as ProcessInfo[]
        )
      ])

      const diskUsage: DiskUsage[] = (fs ?? [])
        .filter((d) => d.size > 0)
        .map((d) => ({
          drive: d.mount ?? d.fs ?? '?',
          used: d.used,
          total: d.size,
          percent: d.use ?? 0
        }))

      this.sender({ timestamp: Date.now(), diskUsage, processes })
    } catch (err) {
      console.warn('[stats] slow tick failed:', err)
    } finally {
      this.slowBusy = false
    }
  }

}

// "10.0.26200" -> "Windows 11 (26200)". Build >= 22000 is Windows 11; both
// 10 and 11 report major 10.0, so the build number is the only native tell.
function winOsLabel(): string {
  const build = Number.parseInt(release().split('.')[2] ?? '', 10)
  if (!Number.isFinite(build) || build <= 0) return 'Windows'
  return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (${build})`
}

// One hidden PowerShell call for the GPU model, with a hard timeout so a
// stuck WMI query can never block the header forever.
function queryGpuName(): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (v: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(v.trim() || 'Unknown GPU')
    }
    try {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name'
        ],
        { windowsHide: true }
      )
      timer = setTimeout(() => {
        try {
          ps.kill()
        } catch {
          /* ignore */
        }
        finish('Unknown GPU')
      }, 4000)
      ps.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      ps.on('error', () => finish('Unknown GPU'))
      ps.on('exit', () => finish(out))
    } catch {
      finish('Unknown GPU')
    }
  })
}

let cachedCores = 0
function cpusCount(): number {
  if (!cachedCores) {
    cachedCores = Math.max(1, cpus().length)
  }
  return cachedCores
}
