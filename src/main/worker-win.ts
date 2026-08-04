import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { cpus } from 'os'
import type { ProcessInfo, DiskUsage } from '../renderer/src/types'

// One persistent PowerShell child that loops forever, emitting a JSON line
// with top processes + per-drive usage every cycle (~2.8s: 0.3s query +
// 2.5s sleep). Replaces both si.processes() — which permanently hangs on
// systeminformation's shared persistent shell under Electron — and
// si.fsSize(). Started on popup show, killed on hide: zero idle cost.
//
// (Win32_PerfFormattedData gives instantaneous CPU%, no baseline sample.)
const WORKER_SCRIPT = [
  'while ($true) {',
  '  $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |',
  "    Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |",
  '    Sort-Object PercentProcessorTime -Descending |',
  '    Select-Object -First 8 Name,IDProcess,PercentProcessorTime,WorkingSetPrivate;',
  "  $d = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |",
  '    Select-Object DeviceID,Size,FreeSpace;',
  '  @{ p = @($p); d = @($d) } | ConvertTo-Json -Compress -Depth 3;',
  '  Start-Sleep -Milliseconds 2500',
  '}'
].join(' ')

interface RawProc {
  Name?: string
  IDProcess?: number
  PercentProcessorTime?: number
  WorkingSetPrivate?: number
}

interface RawDisk {
  DeviceID?: string
  Size?: number
  FreeSpace?: number
}

export interface WorkerData {
  processes: ProcessInfo[]
  diskUsage: DiskUsage[]
}

export class WinWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''

  constructor(private onData: (data: WorkerData) => void) {}

  start(): void {
    if (this.proc) return
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WORKER_SCRIPT],
        { windowsHide: true }
      )
    } catch {
      this.proc = null
      return
    }
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (line.startsWith('{')) this.parseLine(line)
      }
    })
    this.proc.on('error', () => this.cleanup())
    this.proc.on('exit', () => this.cleanup())
  }

  stop(): void {
    if (this.proc) this.proc.kill()
    this.cleanup()
  }

  private parseLine(line: string): void {
    try {
      const raw = JSON.parse(line) as { p?: RawProc | RawProc[]; d?: RawDisk | RawDisk[] }
      const procs = raw.p ? (Array.isArray(raw.p) ? raw.p : [raw.p]) : []
      const disks = raw.d ? (Array.isArray(raw.d) ? raw.d : [raw.d]) : []
      const cores = Math.max(1, cpus().length)

      const processes: ProcessInfo[] = procs
        .filter((p) => p && typeof p.IDProcess === 'number')
        .map((p) => ({
          pid: p.IDProcess as number,
          // Perf instance names disambiguate duplicates as "name#2" — strip.
          name: (p.Name ?? '?').replace(/#\d+$/, ''),
          // PercentProcessorTime is per-core-normalized (up to cores*100);
          // divide to match Task Manager's % of total.
          cpu: Math.min(100, (p.PercentProcessorTime ?? 0) / cores),
          memBytes: p.WorkingSetPrivate ?? 0
        }))
        .slice(0, 5)

      const diskUsage: DiskUsage[] = disks
        .filter((d) => d && typeof d.Size === 'number' && d.Size > 0)
        .map((d) => {
          const size = d.Size as number
          const used = size - (d.FreeSpace ?? 0)
          return {
            drive: d.DeviceID ?? '?',
            used,
            total: size,
            percent: (used / size) * 100
          }
        })

      this.onData({ processes, diskUsage })
    } catch {
      /* malformed line — skip */
    }
  }

  private cleanup(): void {
    this.proc = null
    this.buffer = ''
  }
}
