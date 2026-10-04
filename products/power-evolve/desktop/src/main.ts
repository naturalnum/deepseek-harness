/** Electron carrier for the shared DSH Host, with a separate persistent product browser session. */
import { readFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, session, ipcMain, dialog } from 'electron'
import { createDesktopWindow, installDesktopShortcuts, installMicrophonePermissions,
  resolveDesktopLocale, DesktopBackendController } from '@deepseek-ai/dsh-desktop/assembly'
import { allowsCloudHost, allowsCloudNavigation, parseCloudDesktopConfig } from './config.ts'
import { installCloudNavigation, loadCloudDocument, assertCloudSender } from './window-policy.ts'
import { cloudDesktopPartition } from './partition.ts'
import { installCloudPreferences } from './preferences.ts'
import { cloudDesktopArguments } from './arguments.ts'
import { parseDesktopDeviceConfig } from './device-config.ts'
import { DeviceProcess } from './device-process.ts'
import { LocalDeviceWindow } from './local-device-window.ts'
import { DEVICE_DESKTOP_IPC } from './device-ipc.ts'
import { deviceEn, deviceZh } from './device-locale.ts'
import { readInstalledDesktopConfig } from './installed-config.ts'
import { prepareInstalledDeviceProfile } from './installed-profile.ts'

const values = cloudDesktopArguments(process.argv, app.getAppPath(), app.isPackaged)
if (app.isPackaged && Object.keys(values).length !== 0) {
  throw new Error('PowerEvolve desktop: installed startup does not accept runtime overrides')
}
if (!app.isPackaged && (values.config === undefined || !isAbsolute(values.config))) {
  throw new Error('PowerEvolve desktop: --config must name an absolute local file')
}
if (values['data-dir'] !== undefined && !isAbsolute(values['data-dir'])) {
  throw new Error('PowerEvolve desktop: --data-dir is an absolute development-only directory')
}
if (values['device-config'] !== undefined && !isAbsolute(values['device-config'])) {
  throw new Error('PowerEvolve desktop: --device-config is an absolute development-only file')
}
app.setName('PowerEvolve')
const userData = values['data-dir'] ?? join(app.getPath('appData'), 'PowerEvolve')
mkdirSync(userData, { recursive: true, mode: 0o700 })
app.setPath('userData', userData)
app.setAppLogsPath()
const installed = app.isPackaged
  ? readInstalledDesktopConfig({ resourcesPath: process.resourcesPath, productUserDataPath: userData }) : undefined
const config = installed?.config ?? parseCloudDesktopConfig(JSON.parse(readFileSync(values.config!, 'utf8')))
const deviceConfig = installed?.deviceConfig ?? (values['device-config'] === undefined ? undefined
  : parseDesktopDeviceConfig(JSON.parse(readFileSync(values['device-config'], 'utf8'))))
if (deviceConfig !== undefined && [config.hostOrigin, config.platformOrigin].includes(deviceConfig.loopbackOrigin)) {
  throw new Error('PowerEvolve desktop: Device must have a separate local origin')
}
if (!app.requestSingleInstanceLock()) app.exit(0)
else {
  void app.whenReady().then(async () => {
    let primary: BrowserWindow | undefined
    let language: string | undefined
    const locale = (): ReturnType<typeof resolveDesktopLocale> => resolveDesktopLocale(language ?? app.getLocale())
    const deviceMessages = (): typeof deviceEn => /^(zh|cn)/iu.test(language ?? app.getLocale()) ? deviceZh : deviceEn
    let quitting = false, quitPending = false
    let ownedDevice: DeviceProcess | undefined
    const deviceBackend = deviceConfig === undefined ? undefined : new DesktopBackendController(
      onFailure => { ownedDevice = new DeviceProcess({ ...deviceConfig, env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(key))),
        ...(installed === undefined ? {} : { PATH: installed.commandSearchPath.join(':'),
          PYTHONDONTWRITEBYTECODE: '1', NARB_DISABLE_NATIVE_CACHE: '1' }),
        ...(deviceConfig.nodeExecutable === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      } }, onFailure)
        const child = ownedDevice
        return { process: child, start: () => child.start(), stop: async () => {
          try { await child.stop() }
          catch (error) {
            // The controller needs confirmed OS exit; the quit flow separately reports retained stop uncertainty.
            if (!child.exitConfirmed) throw error
          }
        } }
      }, () => {},
    )
    const localDevice = deviceConfig === undefined ? undefined : new LocalDeviceWindow({ origin: deviceConfig.loopbackOrigin,
      getDevice: () => deviceBackend?.host?.process, messages: () => locale().messages })
    async function prepareLocalProfile(): Promise<void> {
      if (installed === undefined) return
      // Installed Device Profiles admit only the product composition, including after upgrades.
      try {
        lstatSync(join(installed.state.homeDir, 'cordis.patch.yml'))
        throw new Error('PowerEvolve desktop: installed Home overlay requires explicit migration')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const selected = createRequire(installed.resources.cliEntrypoint).resolve('@power-evolve/device/package.json')
      if (realpathSync(dirname(selected)) !== installed.resources.deviceBundle) {
        throw new Error('PowerEvolve desktop: installed Device bundle differs from CLI selection')
      }
      await prepareInstalledDeviceProfile(installed, installed.worker, installed.resources.deviceBundle)
    }
    async function openLocalAuthorization(): Promise<void> {
      if (quitPending || quitting || deviceBackend === undefined || localDevice === undefined) throw new Error('PowerEvolve desktop: local device unavailable')
      await deviceBackend.start(prepareLocalProfile)
      if (quitPending || quitting) throw new Error('PowerEvolve desktop: local device unavailable')
      await localDevice.open()
    }
    if (localDevice !== undefined) ipcMain.handle(DEVICE_DESKTOP_IPC.open, async (event, ...args: unknown[]) => {
      assertCloudSender(primary, config, event)
      if (args.length !== 0) throw new Error('PowerEvolve desktop: invalid local authorization request')
      try { await openLocalAuthorization() }
      catch (_deviceUnavailable) { throw new Error('PowerEvolve desktop: local device unavailable') }
    })
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
        ...(deviceBackend === undefined ? [] : [{ label: deviceMessages().menu, submenu: [{ label: deviceMessages().open,
          click: () => { void openLocalAuthorization().catch(() => {
            void dialog.showMessageBox({ type: 'error', title: deviceMessages().startupTitle, message: deviceMessages().startupBody })
          }) },
        }] }]),
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
        additionalArguments: [`--power-evolve-host-origin=${config.hostOrigin}`,
          ...(deviceConfig === undefined ? [] : ['--power-evolve-device-enabled'])],
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
    app.on('before-quit', event => {
      if (quitting || deviceBackend === undefined || localDevice === undefined) return
      event.preventDefault()
      if (quitPending) return
      quitPending = true
      void (async () => {
        const host = ownedDevice
        if (host !== undefined) {
          const snapshot = await host.inspect().catch(() => null)
          if (snapshot === null || snapshot.pendingActions > 0 || snapshot.journalEntries > 0) {
            const answer = await dialog.showMessageBox({ type: 'warning', title: deviceMessages().quitTitle,
              message: deviceMessages().quitActive, buttons: [deviceMessages().cancel, deviceMessages().quit],
              cancelId: 0, defaultId: 0 })
            if (answer.response !== 1) { quitPending = false; return }
          }
        }
        const results = await Promise.allSettled([deviceBackend.close(), localDevice.close()])
        if (ownedDevice !== undefined && !ownedDevice.exitConfirmed) throw new Error('local_device_exit_unconfirmed')
        if (results[1].status === 'rejected') throw new Error('local_authorization_close_failed')
        if (results[0].status === 'rejected' || ownedDevice !== undefined && (!ownedDevice.lastStopClean
          || (ownedDevice.lastDrain?.entries.length ?? 0) > 0 || (ownedDevice.lastDrain?.cleanupPending ?? 0) > 0)) {
          await dialog.showMessageBox({ type: 'warning', title: deviceMessages().quitTitle,
            message: deviceMessages().quitUnknown, buttons: [deviceMessages().acknowledge] })
        }
        quitting = true
        app.quit()
      })().catch(() => {
        quitPending = false
        void dialog.showMessageBox({ type: 'error', title: deviceMessages().quitTitle,
          message: deviceMessages().quitFailed, buttons: [deviceMessages().acknowledge] })
      })
    })
    app.on('will-quit', () => {
      shortcuts.dispose(); disposePreferences()
      if (localDevice !== undefined) ipcMain.removeHandler(DEVICE_DESKTOP_IPC.open)
    })
    updateMenu()
    await open()
  }).catch(() => { console.error('PowerEvolve desktop: could not start the application'); app.exit(1) })
}
