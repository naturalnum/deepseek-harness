/** Sandboxed preload helpers without application boot, filesystem or provider capabilities. */
export { createDesktopShortcutBridge } from './preload-shortcuts.ts'
export { createDesktopBrowserBridge } from './preload-browser.ts'
export { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'
export { syncNativeTheme } from './preload-theme.ts'
export { DESKTOP_IPC } from './ipc.ts'
