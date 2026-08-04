import { memo } from 'react'
import { Sparkline } from './Sparkline'

interface Props {
  label: string
  value: string
  detail?: string
  sparkline?: number[]
  accent?: string
  max?: number
  window?: number
  format?: (v: number) => string
}

function MetricCardImpl({
  label,
  value,
  detail,
  sparkline,
  accent,
  max,
  window,
  format
}: Props) {
  return (
    <div className="bg-neutral-900 rounded-lg p-3 border border-neutral-800">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        <span className="text-sm font-medium text-neutral-100 tabular-nums">
          {value}
        </span>
      </div>
      {detail && (
        <div className="text-[11px] text-neutral-500 mb-1 tabular-nums">{detail}</div>
      )}
      {sparkline && (
        <Sparkline
          values={sparkline}
          color={accent}
          height={24}
          max={max}
          window={window}
          format={format}
        />
      )}
    </div>
  )
}

export const MetricCard = memo(MetricCardImpl)
