/**
 * Context bridge (preload script).
 *
 * Exposes a safe, typed API to the renderer process via
 * `window.electronAPI`. This is the ONLY way the renderer
 * communicates with the main process — no Node.js APIs
 * are available in the renderer.
 *
 * The existing Steam bridge (`window.openfrontDesktop.steam`)
 * is preserved for compatibility with upstream code.
 */

/**
 * Context bridge (preload script).
 *
 * Exposes a safe, typed API to the renderer process via
 * `window.electronAPI`. This is the ONLY way the renderer
 * communicates with the main process -- no Node.js APIs
 * are available in the renderer.
 *
 * The existing Steam bridge (`window.openfrontDesktop.steam`)
 * is preserved for compatibility with upstream code.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface ElectronAPI {
  // ── Asset cache ──
  assetCache: {
    sync(): Promise<SyncResult>;
    getLocalPath(assetPath: string): Promise<string>;
    isOffline(): Promise<boolean>;
    getManifest(): Promise<AssetManifest | null>;
  };

  // ── Server lifecycle ──
  server: {
    start(config?: { port?: number; gameConfig?: unknown }): Promise<ServerStatus>;
    stop(): Promise<{ status: "stopped" }>;
    status(): Promise<ServerStatus>;
  };

  // ── LAN discovery ──
  lan: {
    discover(): Promise<LanGame[]>;
    stopDiscovery(): Promise<void>;
    connect(host: string, port: number): Promise<{ host: string; port: number }>;
  };

  // ── Map generator ──
  mapGen: {
    generate(options: MapGenOptions): Promise<MapGenResult>;
    preview(options: MapGenOptions): Promise<MapGenPreviewResult>;
    exportMap(folder: string): Promise<MapGenExportResult>;
    list(): Promise<CustomMapList>;
    pickImage(): Promise<string | null>;
  };

  // ── App info ──
  app: {
    getVersion(): Promise<string>;
    getUserDataPath(): Promise<string>;
    getCachePath(): Promise<string>;
  };

  // ── External browser ──
  openExternal(url: string): Promise<void>;

  // ── OAuth login ──
  "oauth-login"(provider: string): Promise<void>;

  // ── Events (main -> renderer) ──
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

// ── Types ──────────────────────────────────────────────────

export interface SyncResult {
  status: "success" | "partial" | "offline" | "error";
  downloaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  error?: string;
}

export interface AssetManifest {
  [filePath: string]: string; // filePath -> hash/version
}

export interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port?: number;
  pid?: number;
  error?: string;
  players?: number;
}

export interface LanGame {
  name: string;
  host: string;
  port: number;
  playerCount: number;
  maxPlayers: number;
  map: string;
}

export interface MapGenOptions {
  inputImage?: string;
  seed?: string;
  outputName?: string;
  width?: number;
  height?: number;
  waterLevel?: number;
  mountainThreshold?: number;
  brightness?: number;
  contrast?: number;
  invert?: boolean;
  removeSmall?: boolean;
  minIslandSize?: number;
  minLakeSize?: number;
}

export interface MapGenResult {
  success: boolean;
  outputPath?: string;
  outputFolder?: string;
  error?: string;
}

export interface MapGenPreviewResult {
  success: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface MapGenExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface CustomMapEntry {
  folder: string;
  name: string;
  width: number;
  height: number;
}

export interface CustomMapList {
  maps: CustomMapEntry[];
  assetBaseUrl: string | null;
}

// ── Bridge ─────────────────────────────────────────────────

const electronAPI: ElectronAPI = {
  assetCache: {
    sync: () => ipcRenderer.invoke("asset-cache:sync"),
    getLocalPath: (assetPath: string) =>
      ipcRenderer.invoke("asset-cache:get-local-path", assetPath),
    isOffline: () => ipcRenderer.invoke("asset-cache:is-offline"),
    getManifest: () => ipcRenderer.invoke("asset-cache:get-manifest"),
  },

  server: {
    start: (config?) => ipcRenderer.invoke("server:start", config),
    stop: () => ipcRenderer.invoke("server:stop"),
    status: () => ipcRenderer.invoke("server:status"),
  },

  lan: {
    discover: () => ipcRenderer.invoke("lan:discover"),
    stopDiscovery: () => ipcRenderer.invoke("lan:stop-discovery"),
    connect: (host, port) => ipcRenderer.invoke("lan:connect", host, port),
  },

  mapGen: {
    generate: (options) => ipcRenderer.invoke("mapgen:generate", options),
    preview: (options) => ipcRenderer.invoke("mapgen:preview", options),
    exportMap: (folder) => ipcRenderer.invoke("mapgen:export", folder),
    list: () => ipcRenderer.invoke("mapgen:list"),
    pickImage: () => ipcRenderer.invoke("mapgen:pick-image"),
  },

  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version"),
    getUserDataPath: () => ipcRenderer.invoke("app:get-user-data-path"),
    getCachePath: () => ipcRenderer.invoke("app:get-cache-path"),
  },

  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  "oauth-login": (provider: string) =>
    ipcRenderer.invoke("app:oauth-login", provider),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

// ── Preserve existing Steam bridge interface ────────────────
// The upstream code expects window.openfrontDesktop.steam
// We keep this for backward compatibility; the Steam bridge
// is set up by the main process via contextBridge as well.

// (Steam bridge is exposed separately by a dedicated preload
//  or through the electronAPI — the existing code in SteamSDK.ts
//  checks for window.openfrontDesktop.steam)
