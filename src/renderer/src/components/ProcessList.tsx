import { memo } from 'react'
import type { ProcessInfo } from '../types'
import { formatBytes } from '../format'

interface Props {
  processes: ProcessInfo[]
}

function ProcessListImpl({ processes }: Props) {
  return (
    <div className="bg-neutral-900 rounded-lg p-3 border border-neutral-800">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Top processes
      </div>
      <div className="space-y-1">
        {processes.length === 0 && (
          <div className="text-[11px] text-neutral-600">Waiting…</div>
        )}
        {processes.map((p) => (
          <div
            key={p.pid}
            className="flex items-center justify-between text-[11px]"
          >
            <span className="truncate text-neutral-300 max-w-[210px]">
              {p.name}
            </span>
            <span className="text-neutral-500 tabular-nums shrink-0">
              {p.cpu.toFixed(1)}% · {formatBytes(p.memBytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const ProcessList = memo(ProcessListImpl)
