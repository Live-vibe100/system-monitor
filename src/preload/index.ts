import { contextBridge, ipcRenderer } from 'electron'
import type { Stats, AppSettings, MonitorAPI } from '../renderer/src/types'

const api: MonitorAPI = {
  onStats: (cb: (stats: Stats) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, stats: Stats) => cb(stats)
    ipcRenderer.on('stats', listener)
    return () => ipcRenderer.removeListener('stats', listener)
  },
  onReset: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('stats:reset', listener)
    return () => ipcRenderer.removeListener('stats:reset', listener)
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setAutoLaunch: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('settings:setAutoLaunch', enabled),
  hide: (): Promise<void> => ipcRenderer.invoke('app:hide'),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  openTaskManager: (): Promise<void> => ipcRenderer.invoke('app:openTaskManager')
}

contextBridge.exposeInMainWorld('monitor', api)
