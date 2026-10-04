/** Side-effect-free main-process assembly for applications that explicitly own another backend. */
export { createDesktopWindow, type DesktopWindowOptions } from './window.ts'
export { chooseDesktopDirectory } from './directory-picker.ts'
export { DesktopBackendController, type DesktopBackendHost, type DesktopBackendState } from './backend-controller.ts'
export { installDesktopShortcuts } from './keyboard.ts'
export { installMicrophonePermissions } from './microphone-permissions.ts'
export { resolveDesktopLocale, type DesktopLocale } from './locale.ts'
export { DESKTOP_IPC } from './ipc.ts'
