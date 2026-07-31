/**
 * Window management.
 *
 * Creates and manages the main BrowserWindow with appropriate
 * settings for OpenFront (WebGL2, reasonable defaults).
 */

import { BrowserWindow, screen } from "electron";
import path from "path";
import { fileURLToPath } from "url";

// In CJS, __dirname is always available
// @ts-ignore - __dirname is a CJS global
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  // Get primary display dimensions, clamped to reasonable desktop sizes
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } =
    primaryDisplay.workAreaSize;

  const windowWidth = Math.min(1440, Math.floor(screenWidth * 0.85));
  const windowHeight = Math.min(900, Math.floor(screenHeight * 0.85));

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1024,
    minHeight: 720,
    title: "OpenFront",
    backgroundColor: "#1e1e1e",
    show: false, // Show after ready-to-show to avoid flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Context isolation is required for security with contextBridge
      contextIsolation: true,
      // Disable Node.js integration in the renderer
      nodeIntegration: false,
      // Allow WebGL2
      webgl: true,
      // For the game's Web Worker (core simulation)
      nodeIntegrationInWorker: false,
      // Allow loading local assets via file://
      webSecurity: true,
    },
  });

  // Show window when ready (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
