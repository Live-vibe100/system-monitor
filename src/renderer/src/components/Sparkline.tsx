import { memo, useRef, useState, type MouseEvent } from 'react'

interface Props {
  values: number[]
  color?: string
  height?: number
  max?: number
  // Fixed number of time slots the graph spans. The newest sample is pinned
  // to the right edge and the line grows leftward as history fills — like
  // Task Manager — instead of stretching a few points across the full width.
  window?: number
  // Formats a sample for the hover tooltip (e.g. "47%" or "1.2 MB/s").
  format?: (v: number) => string
}

const VB_WIDTH = 100

function SparklineImpl({
  values,
  color = '#3b82f6',
  height = 24,
  max,
  window = 60,
  format = (v) => v.toFixed(0)
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  if (values.length < 2) {
    return <svg width="100%" height={height} viewBox={`0 0 ${VB_WIDTH} ${height}`} />
  }

  const n = values.length
  const slots = Math.max(window, 2)
  const step = VB_WIDTH / (slots - 1)
  const cap = max ?? Math.max(...values, 1)

  // Newest sample (i = n-1) sits at the right edge; older samples step left.
  const xAt = (i: number): number => VB_WIDTH - (n - 1 - i) * step
  const yAt = (v: number): number => height - (Math.min(v, cap) / cap) * height

  let line = ''
  for (let i = 0; i < n; i++) {
    line += `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(values[i]).toFixed(2)}`
  }
  const x0 = xAt(0)
  const area = `${line}L${VB_WIDTH.toFixed(2)},${height}L${x0.toFixed(2)},${height}Z`

  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const vbX = ((e.clientX - rect.left) / rect.width) * VB_WIDTH
    const slotFromRight = Math.round((VB_WIDTH - vbX) / step)
    const i = n - 1 - slotFromRight
    setHover(i >= 0 && i < n ? i : null)
  }

  const hoverX = hover != null ? xAt(hover) : 0
  const hoverY = hover != null ? yAt(values[hover]) : 0
  const secondsAgo = hover != null ? n - 1 - hover : 0
  // Keep the tooltip label from spilling off either edge of the card.
  const labelLeft = Math.min(92, Math.max(8, hoverX))

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${VB_WIDTH} ${height}`}
        preserveAspectRatio="none"
        className="block cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={area} fill={color} opacity="0.15" />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
        {hover != null && (
          <line
            x1={hoverX}
            y1={0}
            x2={hoverX}
            y2={height}
            stroke={color}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            opacity="0.5"
          />
        )}
      </svg>
      {/* Marker dot as an HTML element so the stretched viewBox doesn't
          squash it into an ellipse. */}
      {hover != null && (
        <div
          className="pointer-events-none absolute z-10 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${hoverX}%`, top: `${hoverY}px`, background: color }}
        />
      )}
      {hover != null && (
        <div
          className="pointer-events-none absolute -top-7 z-20 -translate-x-1/2 whitespace-nowrap rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-100 shadow"
          style={{ left: `${labelLeft}%` }}
        >
          {format(values[hover])} · {secondsAgo === 0 ? 'now' : `${secondsAgo}s ago`}
        </div>
      )}
    </div>
  )
}

export const Sparkline = memo(SparklineImpl)
