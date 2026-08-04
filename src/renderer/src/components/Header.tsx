import { memo } from 'react'
import type { HeaderInfo } from '../types'
import { formatBytes } from '../format'

interface Props {
  info?: HeaderInfo
  onClose: () => void
}

// The header doubles as the window's drag handle (.app-drag is what makes a
// frameless window movable). The close button lives INSIDE it as a no-drag
// child — the previous position:fixed overlay didn't reliably punch a
// clickable hole in the drag region, which made the X unclickable.
function HeaderImpl({ info, onClose }: Props) {
  const closeButton = (
    <button
      className="app-no-drag shrink-0 p-1 rounded text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800 cursor-pointer"
      onClick={onClose}
      aria-label="Close"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  )

  if (!info) {
    return (
      <div className="app-drag cursor-move flex items-start justify-between gap-2 pb-2 border-b border-neutral-800">
        <div className="text-xs text-neutral-500">Loading system info…</div>
        {closeButton}
      </div>
    )
  }
  return (
    <div className="app-drag cursor-move flex items-start justify-between gap-2 pb-2 border-b border-neutral-800">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-neutral-100 truncate">
          {info.hostname}
        </div>
        <div className="text-[11px] text-neutral-500 truncate">{info.os}</div>
        <div className="text-[11px] text-neutral-500 truncate">
          {info.cpuModel}
        </div>
        <div className="text-[11px] text-neutral-500 truncate">
          {formatBytes(info.totalRam)} RAM · {info.gpu}
        </div>
      </div>
      {closeButton}
    </div>
  )
}

export const Header = memo(HeaderImpl)
