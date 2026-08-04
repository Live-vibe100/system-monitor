import { app, ipcMain } from 'electron'
import { menubar } from 'menubar'
import { join } from 'path'
import { Settings } from './settings'
import { StatsEngine } from './stats'
import { launchTaskManager } from './taskmgr-win'

const APP_ID = 'com.systemmonitor.app'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const startHidden = process.argv.includes('--hidden')

  // GPU-accelerated window creation during logon hung DWM/explorer on this
  // machine (full black screen at boot). The UI is static cards + tiny SVG
  // sparklines — software rendering looks identical, so skip the GPU.
  app.disableHardwareAcceleration()

  app.setAppUserModelId(APP_ID)

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e) => e.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray.ico')
    : join(__dirname, '../../resources/tray.ico')

  const indexUrl =
    process.env.ELECTRON_RENDERER_URL ??
    `file://${join(__dirname, '../renderer/index.html')}`

  app.whenReady().then(() => {
    const settings = new Settings()

    // Only a packaged build may touch the OS login item. In dev,
    // process.execPath is node_modules\electron\dist\electron.exe, so writing
    // it here hijacks login to launch the dev copy out of the project folder
    // and leaves a dangling Run entry that uninstall can't clean up.
    const setLoginItem = (enabled: boolean): void => {
      if (!app.isPackaged) return
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    }

    // Sync OS login-item state with stored preference on launch.
    setLoginItem(settings.get('autoLaunch'))

    const mb = menubar({
      index: indexUrl,
      icon: trayIconPath,
      tooltip: 'System Monitor',
      showDockIcon: false,
      // At login (--hidden) don't create the renderer window at all — the
      // logon session is still settling and window creation is what blacked
      // out the screen. First tray click pays ~1s load instead.
      preloadWindow: !startHidden,
      browserWindow: {
        width: 400,
        // Tall enough that header + 4 graphs + disk usage + processes +
        // footer all fit without scrolling.
        height: 800,
        transparent: false,
        resizable: false,
        // Double-clicking a drag region maximizes a frameless window by
        // default — that's what flung the popup to the top-left corner.
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Also disables menubar's hide-on-blur: the popup stays open until
        // the X button or the tray icon closes it.
        alwaysOnTop: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          // No text inputs and no debugging in production — skip the
          // spellchecker and DevTools overhead entirely.
          spellcheck: false,
          devTools: !app.isPackaged,
          preload: join(__dirname, '../preload/index.js')
        }
      }
    })

    let engine: StatsEngine | null = null

    // Diagnostics: SM_DIAG=1 logs every payload's fields to %TEMP%\sm-stats.log
    // and auto-opens the popup shortly after launch.
    const diag = process.env.SM_DIAG === '1'
    const diagLog = (line: string): void => {
      if (!diag) return
      try {
        require('fs').appendFileSync(
          require('path').join(require('os').tmpdir(), 'sm-stats.log'),
          `${new Date().toISOString()} ${line}\n`
        )
      } catch {
        /* ignore */
      }
    }

    mb.on('ready', () => {
      diagLog('ready')
      if (diag) {
        setTimeout(() => mb.showWindow(), 3000)
        setTimeout(() => mb.hideWindow(), 24000)
        setInterval(() => {
          const win = mb.window
          if (win && !win.isDestroyed()) {
            win.webContents
              .executeJavaScript(
                // Prefix with scroll vs client height of the scroll container
                // so the log shows whether content fits without scrolling.
                `(() => { const el = document.querySelector('#root > div'); const drag = document.querySelector('.app-drag'); const btn = document.querySelector('.app-no-drag'); const region = (n) => n ? getComputedStyle(n)['-webkit-app-region'] || getComputedStyle(n)['app-region'] || '?' : 'missing'; return 'FIT ' + (el ? el.scrollHeight + '/' + el.clientHeight : '?') + ' DRAG ' + region(drag) + '/' + region(btn) + ' | ' + document.body.innerText })()`
              )
              .then((txt: string) =>
                diagLog('UI: ' + String(txt).replace(/\n/g, ' | ').slice(0, 500))
              )
              .catch((e: Error) => diagLog('UI-err: ' + e.message))
          } else {
            diagLog('UI: no window')
          }
        }, 5000)
      }
      engine = new StatsEngine((stats) => {
        diagLog(
          'payload: ' +
            Object.entries(stats)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k)
              .join(',')
        )
        const win = mb.window
        if (win && !win.isDestroyed()) {
          win.webContents.send('stats', stats)
        }
      })
      // Warm the slow WMI-backed header + process baseline in the background
      // so the first popup open renders immediately. At login, wait out the
      // logon rush first — WMI is contended then and the popup isn't open.
      if (startHidden) {
        setTimeout(() => engine?.prime(), 15_000)
      } else {
        engine.prime()
      }
    })

    // Full stats polling only runs while the popup is visible — big perf win.
    mb.on('after-show', () => {
      diagLog('after-show -> engine.start()')
      engine?.start()
    })
    mb.on('after-hide', () => {
      diagLog('after-hide -> engine.stop()')
      engine?.stop()
      // Quick-glance app: reset the graphs so the next open starts fresh,
      // the same way Task Manager restarts its history.
      const win = mb.window
      if (win && !win.isDestroyed()) {
        win.webContents.send('stats:reset')
      }
    })

    // Whitelisted IPC handlers only — no dynamic channel names.
    ipcMain.handle('settings:get', () => settings.getAll())
    ipcMain.handle('settings:setAutoLaunch', (_e, enabled: unknown) => {
      const value = Boolean(enabled)
      settings.set('autoLaunch', value)
      setLoginItem(value)
      return value
    })
    ipcMain.handle('app:hide', () => {
      mb.hideWindow()
    })
    ipcMain.handle('app:openTaskManager', () => {
      if (process.platform !== 'win32') return
      // Launches it and centres its window — see taskmgr-win.ts. Popup hides
      // so the always-on-top window doesn't cover what the user asked for.
      launchTaskManager()
      mb.hideWindow()
    })
    ipcMain.handle('app:quit', () => {
      engine?.dispose()
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    // Keep the tray running when the popup closes.
    // (Having any listener on this event prevents Electron's default quit.)
  })

  app.on('second-instance', () => {
    // Single-instance lock already blocks duplicates; menubar keeps the tray.
  })
}
