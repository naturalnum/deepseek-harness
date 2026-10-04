/** Electron carrier for the shared DSH Host, with a separate persistent product browser session. */
import { readFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, session } from 'electron'
import { createDesktopWindow, installDesktopShortcuts, installMicrophonePermissions,
  resolveDesktopLocale } from '@deepseek-ai/dsh-desktop/assembly'
import { allowsCloudHost, allowsCloudNavigation, parseCloudDesktopConfig } from './config.ts'
import { installCloudNavigation, loadCloudDocument } from './window-policy.ts'
import { cloudDesktopPartition } from './partition.ts'
import { installCloudPreferences } from './preferences.ts'
import { cloudDesktopArguments } from './arguments.ts'

const values = cloudDesktopArguments(process.argv, app.getAppPath(), app.isPackaged)
if (values.config === undefined || !isAbsolute(values.config)) throw new Error('PowerEvolve desktop: --config must name an absolute local file')
if (values['data-dir'] !== undefined && (app.isPackaged || !isAbsolute(values['data-dir']))) {
  throw new Error('PowerEvolve desktop: --data-dir is an absolute development-only directory')
}
const config = parseCloudDesktopConfig(JSON.parse(readFileSync(values.config, 'utf8')))
app.setName('PowerEvolve')
const userData = values['data-dir'] ?? join(app.getPath('appData'), 'PowerEvolve')
mkdirSync(userData, { recursive: true, mode: 0o700 })
app.setPath('userData', userData)
app.setAppLogsPath()
if (!app.requestSingleInstanceLock()) app.exit(0)
else {
  void app.whenReady().then(async () => {
    let primary: BrowserWindow | undefined
    let language: string | undefined
    const locale = (): ReturnType<typeof resolveDesktopLocale> => resolveDesktopLocale(language ?? app.getLocale())
    const browser = session.fromPartition(cloudDesktopPartition(config))
    const shortcuts = installDesktopShortcuts(() => primary, userData,
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
      updateMenu, () => ({ revision: 0, blocked: false }), value => allowsCloudHost(config, value))
    function updateMenu(): void {
      const messages = locale().messages
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ label: 'PowerEvolve', submenu: [{ role: 'about' as const },
          { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const },
          { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
        shortcuts.fileMenu(messages),
        { label: messages.edit, submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { role: 'viewMenu' }, { role: 'windowMenu' },
      ]))
    }
    // The carrier denies unrelated browser permissions; only owned audio requests use the OS microphone policy.
    installMicrophonePermissions({
      setPermissionCheckHandler: handler => browser.setPermissionCheckHandler((contents, permission, origin, details) =>
        permission === 'media' && handler !== null && handler(contents, permission, origin, details)),
      setPermissionRequestHandler: handler => browser.setPermissionRequestHandler((contents, permission, callback, details) => {
        if (permission === 'media' && handler !== null) handler(contents, permission, callback, details)
        else callback(false)
      }),
    }, () => primary?.webContents, value => {
      try {
        const url = new URL(value)
        return primary !== undefined && allowsCloudHost(config, primary.webContents.mainFrame.url)
          && url.origin === config.hostOrigin && url.username === '' && url.password === ''
      }
      catch (_invalidOrigin) { return false }
    })
    const disposePreferences = installCloudPreferences(() => primary, config, () => app.getPreferredSystemLanguages(), next => {
      language = next; updateMenu()
    })
    async function open(): Promise<void> {
      if (primary !== undefined && !primary.isDestroyed()) { primary.show(); primary.focus(); return }
      const window = createDesktopWindow({ preload: fileURLToPath(new URL('./preload-cloud.cjs', import.meta.url)),
        primary: true, webviewTag: false, session: browser, messages: () => locale().messages,
        additionalArguments: [`--power-evolve-host-origin=${config.hostOrigin}`],
        allowsNavigation: destination => allowsCloudNavigation(config, destination.href), openExternal: () => {},
      })
      primary = window
      installCloudNavigation(window, config)
      shortcuts.attach(window)
      window.on('closed', () => { if (primary === window) primary = undefined })
      window.once('ready-to-show', () => { if (!window.isDestroyed() && primary === window) window.show() })
      try { await loadCloudDocument(window, config, `${config.hostOrigin}/native/`) }
      catch (_hostUnavailable) {
        if (!window.isDestroyed() && primary === window) window.show()
        /* The native failed load remains visible and Reload retries the fixed URL. */
      }
    }
    const reopen = (): void => { void open().catch(() => { console.error('PowerEvolve desktop: could not reopen the application window') }) }
    app.on('second-instance', reopen)
    app.on('activate', reopen)
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
    app.on('will-quit', () => { shortcuts.dispose(); disposePreferences() })
    updateMenu()
    await open()
  }).catch(() => { console.error('PowerEvolve desktop: could not start the application'); app.exit(1) })
}
