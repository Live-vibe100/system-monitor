import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Stats,
  AppSettings,
  HeaderInfo,
  CpuStats,
  MemoryStats,
  DiskUsage,
  DiskIO,
  NetworkStats,
  ProcessInfo
} from './types'
import { Header } from './components/Header'
import { MetricCard } from './components/MetricCard'
import { ProcessList } from './components/ProcessList'
import { Footer } from './components/Footer'
import { formatBytes, formatBytesPerSec } from './format'

const BUFFER_SIZE = 60

// Hover-tooltip formatters. Percent cards share one; byte-rate cards another.
const fmtPct = (v: number): string => `${v.toFixed(0)}%`
const fmtBytesRate = (v: number): string => formatBytesPerSec(v)

interface Buffers {
  cpu: number[]
  memPct: number[]
  diskCombined: number[]
  netCombined: number[]
}

const EMPTY_BUFFERS: Buffers = {
  cpu: [],
  memPct: [],
  diskCombined: [],
  netCombined: []
}

function pushBuf(buf: number[], val: number): number[] {
  const next = buf.length >= BUFFER_SIZE ? buf.slice(1) : buf.slice()
  next.push(val)
  return next
}

export default function App() {
  const [header, setHeader] = useState<HeaderInfo | undefined>()
  const [cpu, setCpu] = useState<CpuStats | undefined>()
  const [memory, setMemory] = useState<MemoryStats | undefined>()
  const [diskUsage, setDiskUsage] = useState<DiskUsage[]>([])
  const [diskIO, setDiskIO] = useState<DiskIO | undefined>()
  const [network, setNetwork] = useState<NetworkStats | undefined>()
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [uptime, setUptime] = useState(0)
  const [settings, setSettings] = useState<AppSettings>({ autoLaunch: false })
  const [buffers, setBuffers] = useState<Buffers>(EMPTY_BUFFERS)

  const buffersRef = useRef(buffers)
  buffersRef.current = buffers

  useEffect(() => {
    window.monitor.getSettings().then(setSettings).catch(() => {})

    const unsub = window.monitor.onStats((s: Stats) => {
      if (s.header) setHeader(s.header)
      if (s.cpu) setCpu(s.cpu)
      if (s.memory) setMemory(s.memory)
      if (s.diskUsage) setDiskUsage(s.diskUsage)
      if (s.diskIO) setDiskIO(s.diskIO)
      if (s.network) setNetwork(s.network)
      if (s.processes) setProcesses(s.processes)
      if (s.uptime !== undefined) setUptime(s.uptime)

      const prev = buffersRef.current
      const nextBuffers: Buffers = {
        cpu: s.cpu ? pushBuf(prev.cpu, s.cpu.overall) : prev.cpu,
        memPct: s.memory ? pushBuf(prev.memPct, s.memory.percent) : prev.memPct,
        diskCombined: s.diskIO
          ? pushBuf(
              prev.diskCombined,
              s.diskIO.activePct ?? s.diskIO.readPerSec + s.diskIO.writePerSec
            )
          : prev.diskCombined,
        netCombined: s.network
          ? pushBuf(prev.netCombined, s.network.upPerSec + s.network.downPerSec)
          : prev.netCombined
      }
      buffersRef.current = nextBuffers
      setBuffers(nextBuffers)
    })
    // Popup closed: wipe graphs AND live readings so reopening starts
    // fresh, like Task Manager. Header and disk-drive usage stay — they
    // aren't rolling counters. Fresh values arrive within a tick.
    const unsubReset = window.monitor.onReset(() => {
      buffersRef.current = EMPTY_BUFFERS
      setBuffers(EMPTY_BUFFERS)
      setCpu(undefined)
      setMemory(undefined)
      setDiskIO(undefined)
      setNetwork(undefined)
      setProcesses([])
    })
    return () => {
      unsub()
      unsubReset()
    }
  }, [])

  const handleToggleAutoLaunch = useCallback(async (enabled: boolean) => {
    const result = await window.monitor.setAutoLaunch(enabled)
    setSettings((s) => ({ ...s, autoLaunch: result }))
  }, [])

  const handleQuit = useCallback(() => {
    window.monitor.quit()
  }, [])

  const handleOpenTaskManager = useCallback(() => {
    window.monitor.openTaskManager()
  }, [])

  const cpuDetail = useMemo(
    () => (cpu ? `${cpu.cores} cores` : undefined),
    [cpu]
  )
  const memoryDetail = useMemo(
    () =>
      memory
        ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`
        : undefined,
    [memory]
  )
  const diskIODetail = useMemo(
    () =>
      diskIO
        ? `↓ ${formatBytesPerSec(diskIO.readPerSec)}   ↑ ${formatBytesPerSec(diskIO.writePerSec)}`
        : undefined,
    [diskIO]
  )
  const networkValue = useMemo(
    () =>
      network
        ? `↓ ${formatBytesPerSec(network.downPerSec)}`
        : '—',
    [network]
  )
  const networkDetail = useMemo(
    () => (network ? `↑ ${formatBytesPerSec(network.upPerSec)}` : undefined),
    [network]
  )

  return (
    <div className="w-full h-full p-3 flex flex-col gap-2 overflow-y-auto">
      <Header info={header} onClose={() => window.monitor.hide()} />

      <MetricCard
        label="CPU"
        value={cpu ? `${cpu.overall.toFixed(0)}%` : '—'}
        detail={cpuDetail}
        sparkline={buffers.cpu}
        accent="#3b82f6"
        max={100}
        window={BUFFER_SIZE}
        format={fmtPct}
      />

      <MetricCard
        label="Memory"
        value={memory ? `${memory.percent.toFixed(0)}%` : '—'}
        detail={memoryDetail}
        sparkline={buffers.memPct}
        accent="#10b981"
        max={100}
        window={BUFFER_SIZE}
        format={fmtPct}
      />

      <MetricCard
        label="Disk"
        value={
          diskIO
            ? diskIO.activePct !== undefined
              ? `${diskIO.activePct.toFixed(0)}%`
              : formatBytesPerSec(diskIO.readPerSec + diskIO.writePerSec)
            : '—'
        }
        detail={diskIODetail}
        sparkline={buffers.diskCombined}
        accent="#f59e0b"
        max={diskIO?.activePct !== undefined ? 100 : undefined}
        window={BUFFER_SIZE}
        format={diskIO?.activePct !== undefined ? fmtPct : fmtBytesRate}
      />

      <MetricCard
        label="Network"
        value={networkValue}
        detail={networkDetail}
        sparkline={buffers.netCombined}
        accent="#a855f7"
        window={BUFFER_SIZE}
        format={fmtBytesRate}
      />

      {diskUsage.length > 0 && (
        <div className="bg-neutral-900 rounded-lg p-3 border border-neutral-800">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
            Disk usage
          </div>
          <div className="space-y-1.5">
            {diskUsage.map((d) => (
              <div
                key={d.drive}
                className="flex items-center justify-between text-[11px] gap-2"
              >
                <span className="text-neutral-300 shrink-0 min-w-[36px]">
                  {d.drive}
                </span>
                <div className="flex items-center gap-2 flex-1">
                  <div className="flex-1 h-1.5 bg-neutral-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${Math.min(100, d.percent)}%` }}
                    />
                  </div>
                  <span className="text-neutral-500 tabular-nums w-10 text-right shrink-0">
                    {d.percent.toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ProcessList processes={processes} />

      <Footer
        uptime={uptime}
        autoLaunch={settings.autoLaunch}
        onToggleAutoLaunch={handleToggleAutoLaunch}
        onOpenTaskManager={handleOpenTaskManager}
        onQuit={handleQuit}
      />
    </div>
  )
}
