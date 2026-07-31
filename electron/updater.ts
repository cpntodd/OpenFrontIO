/**
 * Auto-updater using electron-updater.
 *
 * Checks for updates on startup (silent background check).
 * Downloads updates automatically and prompts the user to
 * restart when ready.
 *
 * Configured for a GitHub Releases provider by default.
 * The update server URL can be overridden via APP_UPDATE_URL.
 */

import { BrowserWindow } from "electron";

// electron-updater is a CJS module; use `require` for direct access
const { autoUpdater } = require("electron-updater");

export function initAutoUpdater(): void {
  // Configure the update provider
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // Set custom update URL if configured
  const updateUrl = process.env.APP_UPDATE_URL;
  if (updateUrl) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateUrl,
    });
  }

  // ── Events ────────────────────────────────────

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for updates...");
  });

  autoUpdater.on("update-available", (info: { version: string }) => {
    console.log("[updater] Update available:", info.version);
    // Notify renderer if we want to show a UI indicator
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("updater:available", info);
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] No update available");
  });

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("updater:progress", progress);
    }
  });

  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    console.log("[updater] Update downloaded:", info.version);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("updater:downloaded", info);
    }
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[updater] Error:", err.message);
  });

  // Start checking
  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.warn("[updater] Initial check failed:", err.message);
  });
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.warn("[updater] Manual check failed:", err.message);
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
