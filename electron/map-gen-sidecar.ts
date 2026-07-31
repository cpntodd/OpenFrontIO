/**
 * Map generator sidecar.
 *
 * Bundles the Go map generator binary and provides a bridge
 * to run it from the Electron main process. The renderer calls
 * IPC methods which invoke the Go CLI with user-supplied options.
 */

import { execFile } from "child_process";
import { dialog } from "electron";
import fs from "fs";
import path from "path";
import { app } from "electron";

export interface MapGenOptions {
  inputImage?: string;
  seed?: string;
  outputName: string;
  width?: number;
  height?: number;
  waterLevel?: number;
  mountainThreshold?: number;
}

export interface MapGenResult {
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

export class MapGenSidecar {
  // ── Binary path ───────────────────────────────

  private getMapGenPath(): string {
    const binaryName = process.platform === "win32" ? "map-generator.exe" : "map-generator";
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "map-generator", binaryName);
    }
    // In development, use the project build output. Keep the source-tree
    // path as a fallback for existing local binaries.
    const builtPath = path.join(app.getAppPath(), "build", "map-generator", binaryName);
    if (fs.existsSync(builtPath)) return builtPath;
    return path.join(app.getAppPath(), "map-generator", binaryName);
  }

  // ── Generate ───────────────────────────────────

  async generate(options: MapGenOptions): Promise<MapGenResult> {
    const binPath = this.getMapGenPath();

    // Check if binary exists
    if (!this.isAvailable()) {
      return {
        success: false,
        error:
          "Map generator binary not found. Build it with: " +
          "npm run build:map-generator",
      };
    }

    const hasImage = typeof options.inputImage === "string" && options.inputImage.length > 0;
    const hasSeed = typeof options.seed === "string" && options.seed.length > 0;
    if (hasImage === hasSeed) {
      return {
        success: false,
        error: "Choose either a source image or a seed.",
      };
    }

    if (hasImage && !fs.existsSync(options.inputImage!)) {
      return {
        success: false,
        error: `Input image not found: ${options.inputImage}`,
      };
    }

    if (hasSeed && !/^[\x20-\x7e]+$/.test(options.seed!)) {
      return {
        success: false,
        error: "Seed must contain printable ASCII characters only.",
      };
    }

    // Build CLI arguments
    const outputFolder = this.safeOutputFolder(options.outputName);
    const outputDir = path.join(
      app.getPath("userData"),
      "maps",
      outputFolder,
    );
    const args: string[] = [
      "--map-name",
      options.outputName,
      "--output",
      outputDir,
    ];

    if (hasImage) {
      args.push("--input", options.inputImage!);
    } else {
      args.push("--seed", options.seed!);
    }

    if (options.width) {
      args.push("--width", String(options.width));
    }
    if (options.height) {
      args.push("--height", String(options.height));
    }

    // The map generator uses Blue channel for terrain by default.
    // Additional options can be added as needed.

    return new Promise((resolve) => {
      execFile(
        binPath,
        args,
        {
          timeout: 120_000, // 2 minutes max
          maxBuffer: 1024 * 1024 * 10, // 10MB stdout
        },
        (error, stdout, stderr) => {
          if (error) {
            console.error("[mapgen] Error:", error.message);
            console.error("[mapgen] stderr:", stderr);
            resolve({
              success: false,
              error: stderr || error.message,
            });
            return;
          }

          console.log("[mapgen] stdout:", stdout);

          // Verify output was created
          const manifestPath = path.join(outputDir, "manifest.json");
          if (!fs.existsSync(manifestPath)) {
            resolve({
              success: false,
              error:
                "Map generation completed but no output files were found. Check the logs.",
            });
            return;
          }

          resolve({
            success: true,
            outputPath: outputDir,
          });
        },
      );
    });
  }

  async list(): Promise<CustomMapEntry[]> {
    const mapsDir = path.join(app.getPath("userData"), "maps");
    if (!fs.existsSync(mapsDir)) return [];

    const entries: CustomMapEntry[] = [];
    for (const entry of await fs.promises.readdir(mapsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifestPath = path.join(mapsDir, entry.name, "manifest.json");
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
        const width = Number(manifest?.map?.width);
        const height = Number(manifest?.map?.height);
        if (
          typeof manifest?.name !== "string" ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 1 ||
          height < 1
        ) {
          continue;
        }
        entries.push({
          folder: entry.name,
          name: manifest.name,
          width,
          height,
        });
      } catch (error) {
        console.warn(`[mapgen] Skipping invalid custom map ${entry.name}:`, error);
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── File picker ────────────────────────────────

  async pickImage(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: "Select Map Image",
      filters: [
        {
          name: "PNG Images",
          extensions: ["png"],
        },
      ],
      properties: ["openFile"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  // ── Binary verification ────────────────────────

  /**
   * Check if the map generator binary exists and is executable.
   */
  isAvailable(): boolean {
    const binPath = this.getMapGenPath();
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private safeOutputFolder(outputName: string): string {
    const safeName = outputName
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\.+$/g, "")
      .slice(0, 120);
    return safeName || "custom-map";
  }
}
