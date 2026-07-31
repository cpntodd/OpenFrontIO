// The Electron desktop shells expose a contextBridge global — either the
// legacy Steam bridge (openfrontDesktop) or the newer electronAPI bridge
// used by the OpenFront Desktop build. Either one is a reliable signal
// that we are running inside a desktop shell.
declare global {
  interface Window {
    openfrontDesktop?: unknown;
  }
}

export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.openfrontDesktop !== undefined || window.electronAPI !== undefined)
  );
}
