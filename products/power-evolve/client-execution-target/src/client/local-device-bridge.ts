/** Optional Electron action opens local authorization without returning paths or credentials. */
declare global {
  interface Window {
    powerEvolveDesktopDevice?: { openAuthorization(): Promise<void> }
  }
}

/**
 * Read the native capability installed only in the owned Host main frame.
 * @returns Authorization opener, or no capability in an ordinary browser.
 */
export function localDeviceAuthorization(): (() => Promise<void>) | undefined {
  const bridge = window.powerEvolveDesktopDevice
  return bridge === undefined ? undefined : () => bridge.openAuthorization()
}
