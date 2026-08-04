import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

// One long-lived typeperf process streaming every fast metric once per
// second — the exact counters Task Manager reads, all sampled at the same
// instant. Killed whenever the popup hides, so idle cost is zero.
//
// Counter paths are English-locale; on localized Windows typeperf exits
// nonzero and snapshot() just keeps returning null (cards show "—").
const COUNTERS = [
  '\\Processor Information(_Total)\\% Processor Utility',
  '\\Memory\\Available Bytes',
  '\\PhysicalDisk(_Total)\\% Idle Time',
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec'
]

export interface CounterSnapshot {
  cpuUtilityPct: number
  memAvailableBytes: number
  diskActivePct: number
  diskReadPerSec: number
  diskWritePerSec: number
  netRxPerSec: number
  netTxPerSec: number
}

interface ColumnMap {
  cpu: number
  memAvail: number
  diskIdle: number
  diskRead: number
  diskWrite: number
  netRx: number[]
  netTx: number[]
}

export class WinCounters {
  private proc: ChildProcessWithoutNullStreams | null = null
  private latest: CounterSnapshot | null = null
  private columns: ColumnMap | null = null
  private buffer = ''

  start(): void {
    if (this.proc) return
    try {
      this.proc = spawn('typeperf', [...COUNTERS, '-si', '1'], {
        windowsHide: true
      })
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
        this.parseLine(line)
      }
    })
    this.proc.on('error', () => this.cleanup())
    this.proc.on('exit', () => this.cleanup())
  }

  stop(): void {
    if (this.proc) this.proc.kill()
    this.cleanup()
  }

  snapshot(): CounterSnapshot | null {
    return this.latest
  }

  private parseLine(line: string): void {
    if (!line.startsWith('"')) return
    const cols = line
      .split('","')
      .map((c) => c.replace(/^"|"\r?$/g, ''))
    if (line.includes('PDH-CSV')) {
      // Header row: map each counter path to its column index. Wildcard
      // counters (network) expand to one column per adapter instance.
      const map: ColumnMap = {
        cpu: -1,
        memAvail: -1,
        diskIdle: -1,
        diskRead: -1,
        diskWrite: -1,
        netRx: [],
        netTx: []
      }
      cols.forEach((path, i) => {
        const p = path.toLowerCase()
        if (p.includes('processor utility')) map.cpu = i
        else if (p.includes('available bytes')) map.memAvail = i
        else if (p.includes('% idle time')) map.diskIdle = i
        else if (p.includes('disk read bytes')) map.diskRead = i
        else if (p.includes('disk write bytes')) map.diskWrite = i
        else if (p.includes('bytes received')) map.netRx.push(i)
        else if (p.includes('bytes sent')) map.netTx.push(i)
      })
      this.columns = map
      return
    }
    const map = this.columns
    if (!map) return
    const num = (i: number): number => {
      if (i < 0 || i >= cols.length) return NaN
      return Number.parseFloat(cols[i])
    }
    const sum = (idxs: number[]): number =>
      idxs.reduce((acc, i) => {
        const v = num(i)
        return acc + (Number.isFinite(v) ? v : 0)
      }, 0)

    const cpu = num(map.cpu)
    const memAvail = num(map.memAvail)
    const diskIdle = num(map.diskIdle)
    if (!Number.isFinite(cpu) || !Number.isFinite(memAvail)) return

    this.latest = {
      // % Processor Utility exceeds 100 under turbo boost; Task Manager
      // caps its display at 100, so we do too.
      cpuUtilityPct: Math.min(100, Math.max(0, cpu)),
      memAvailableBytes: memAvail,
      diskActivePct: Number.isFinite(diskIdle)
        ? Math.min(100, Math.max(0, 100 - diskIdle))
        : 0,
      diskReadPerSec: Number.isFinite(num(map.diskRead)) ? num(map.diskRead) : 0,
      diskWritePerSec: Number.isFinite(num(map.diskWrite)) ? num(map.diskWrite) : 0,
      netRxPerSec: sum(map.netRx),
      netTxPerSec: sum(map.netTx)
    }
  }

  private cleanup(): void {
    this.proc = null
    this.buffer = ''
    this.latest = null
    this.columns = null
  }
}
