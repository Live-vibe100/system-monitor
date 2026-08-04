import { memo, useEffect, useRef, useState } from 'react'
import { formatUptime } from '../format'

interface Props {
  uptime: number
  autoLaunch: boolean
  onToggleAutoLaunch: (v: boolean) => void
  onOpenTaskManager: () => void
  onQuit: () => void
}

function FooterImpl({
  uptime,
  autoLaunch,
  onToggleAutoLaunch,
  onOpenTaskManager,
  onQuit
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="flex items-center justify-between pt-2 border-t border-neutral-800 relative">
      <div className="text-[11px] text-neutral-500 tabular-nums">
        Up {formatUptime(uptime)}
      </div>
      <button
        className="flex items-center gap-1.5 text-[11px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 px-2 py-1 rounded"
        onClick={onOpenTaskManager}
        title="Open Task Manager"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 15l3-3 2 2 4-5" />
        </svg>
        Task Manager
      </button>
      <div ref={ref}>
        <button
          className="text-neutral-500 hover:text-neutral-200 p-1 rounded"
          onClick={() => setOpen((o) => !o)}
          aria-label="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {open && (
          <div className="absolute bottom-full right-0 mb-2 bg-neutral-900 border border-neutral-700 rounded-lg p-1 min-w-[180px] shadow-xl">
            <label className="flex items-center gap-2 text-xs p-2 cursor-pointer hover:bg-neutral-800 rounded">
              <input
                type="checkbox"
                checked={autoLaunch}
                onChange={(e) => onToggleAutoLaunch(e.target.checked)}
                className="accent-blue-500"
              />
              <span className="text-neutral-300">Launch on login</span>
            </label>
            <button
              className="w-full text-left text-xs p-2 hover:bg-neutral-800 rounded text-neutral-300"
              onClick={onQuit}
            >
              Quit
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export const Footer = memo(FooterImpl)
