/**
 * Type declarations for the Electron preload bridge.
 *
 * In the Electron renderer process, window.electronAPI is exposed
 * by the preload script via contextBridge. This file declares it
 * so TypeScript knows about it.
 *
 * In the browser (non-Electron), window.electronAPI is undefined.
 * All code that uses electronAPI must guard with a truthiness check.
 */

import type {
  AssetManifest,
  CustomMapList,
  ElectronAPI,
  LanGame,
  MapGenOptions,
  MapGenPreviewResult,
  MapGenExportResult,
  MapGenResult,
  ServerStatus,
  SyncResult,
} from "../../electron/preload";

declare global {
  interface Window {
    /**
     * Electron desktop bridge. Only available when running inside
     * the Electron shell. Undefined in browser builds.
     */
    electronAPI?: ElectronAPI;

    /**
     * Legacy Steam desktop bridge (compatibility with upstream).
     * Exposed by the Electron main process's preload script.
     */
    openfrontDesktop?: {
      steam?: {
        getAuthTicket(): Promise<string | null>;
        getUser(): Promise<{ steamId: string; name: string } | null>;
      };
    };
  }
}

export type {
  AssetManifest,
  CustomMapList,
  ElectronAPI,
  LanGame,
  MapGenOptions,
  MapGenPreviewResult,
  MapGenExportResult,
  MapGenResult,
  ServerStatus,
  SyncResult,
};
