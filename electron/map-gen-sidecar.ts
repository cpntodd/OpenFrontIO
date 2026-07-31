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
import { deflateRawSync } from "zlib";

const MAX_SEED_MAP_DIMENSION = 8000;
const MAP_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

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

    if (!options.outputName?.trim()) {
      return { success: false, error: "Enter a name for the generated map." };
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // Build CLI arguments
    const outputName = options.outputName!.trim();
    const outputFolder = this.safeOutputFolder(outputName);
    const outputDir = path.join(
      app.getPath("userData"),
      "maps",
      outputFolder,
    );
    const args = this.buildCliArgs(options, outputDir);

    return new Promise((resolve) => {
      execFile(
        binPath,
        args,
        {
          timeout: MAP_GENERATION_TIMEOUT_MS,
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
            outputFolder,
          });
        },
      );
    });
  }

  async preview(options: MapGenOptions): Promise<MapGenPreviewResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        error: "Map generator binary not found. Build it with: npm run build:map-generator",
      };
    }
    const validationError = this.validateOptions(options);
    if (validationError) return { success: false, error: validationError };

    const previewDir = await fs.promises.mkdtemp(
      path.join(app.getPath("temp"), "openfront-map-preview-"),
    );
    const previewPath = path.join(previewDir, "preview.png");
    try {
      const args = this.buildCliArgs(options, previewPath, true);
      const result = await this.runBinary(args);
      if (!result.success) return result;
      const data = await fs.promises.readFile(previewPath);
      const dimensions = result.stdout?.match(/Preview dimensions: (\d+)x(\d+)/);
      return {
        success: true,
        dataUrl: `data:image/png;base64,${data.toString("base64")}`,
        width: dimensions ? Number(dimensions[1]) : undefined,
        height: dimensions ? Number(dimensions[2]) : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await fs.promises.rm(previewDir, { recursive: true, force: true });
    }
  }

  async exportMap(folder: string): Promise<MapGenExportResult> {
    const mapsDir = path.join(app.getPath("userData"), "maps");
    const mapDir = this.safeMapDirectory(mapsDir, folder);
    if (!mapDir || !fs.existsSync(path.join(mapDir, "manifest.json"))) {
      return { success: false, error: "Generated map was not found." };
    }

    let mapName = folder;
    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(path.join(mapDir, "manifest.json"), "utf8"),
      );
      if (typeof manifest.name === "string" && manifest.name.trim()) {
        mapName = manifest.name.trim();
      }
    } catch {
      // Keep the folder name as the export filename if the manifest is invalid.
    }

    const saveResult = await dialog.showSaveDialog({
      title: "Export OpenFront map",
      defaultPath: `${mapName.replace(/[\\/:*?"<>|]/g, "_")}.openfront-map.zip`,
      filters: [{ name: "OpenFront map", extensions: ["zip"] }],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: "Export cancelled." };
    }

    const files = [
      "manifest.json",
      "map.bin",
      "map4x.bin",
      "map16x.bin",
      "thumbnail.webp",
    ];
    const entries = [];
    for (const fileName of files) {
      const filePath = path.join(mapDir, fileName);
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `Generated map is missing ${fileName}.` };
      }
      entries.push({ name: fileName, data: await fs.promises.readFile(filePath) });
    }

    const outputPath = saveResult.filePath.endsWith(".zip")
      ? saveResult.filePath
      : `${saveResult.filePath}.zip`;
    await fs.promises.writeFile(outputPath, createZip(entries));
    return { success: true, outputPath };
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
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"],
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

  private validateOptions(options: MapGenOptions): string | null {
    const hasImage = typeof options.inputImage === "string" && options.inputImage.length > 0;
    const hasSeed = typeof options.seed === "string" && options.seed.length > 0;
    if (hasImage === hasSeed) return "Choose either a source image or a seed.";
    if (hasImage && !fs.existsSync(options.inputImage!)) {
      return `Input image not found: ${options.inputImage}`;
    }
    if (hasSeed) {
      if (!/^[\x20-\x7e]+$/.test(options.seed!)) {
        return "Seed must contain printable ASCII characters only.";
      }
      if (options.seed!.length > 128) {
        return "Seeds must contain 128 characters or fewer.";
      }
      for (const [label, dimension] of [
        ["width", options.width],
        ["height", options.height],
      ] as const) {
        if (
          dimension !== undefined &&
          (!Number.isInteger(dimension) || dimension < 32 || dimension > MAX_SEED_MAP_DIMENSION)
        ) {
          return `${label} must be an integer from 32 to ${MAX_SEED_MAP_DIMENSION} for seed maps.`;
        }
      }
    }
    const water = options.waterLevel ?? 127;
    const mountain = options.mountainThreshold ?? 200;
    if (
      !Number.isInteger(water) ||
      !Number.isInteger(mountain) ||
      water < 0 ||
      water > 255 ||
      mountain < 0 ||
      mountain > 255 ||
      mountain <= water
    ) {
      return "Mountain threshold must be greater than water level, with both values from 0 to 255.";
    }
    const brightness = options.brightness ?? 0;
    const contrast = options.contrast ?? 100;
    if (
      !Number.isInteger(brightness) ||
      !Number.isInteger(contrast) ||
      brightness < -100 ||
      brightness > 100 ||
      contrast < 25 ||
      contrast > 300
    ) {
      return "Brightness must be -100 to 100 and contrast must be 25% to 300%.";
    }
    const minIslandSize = options.minIslandSize ?? 30;
    const minLakeSize = options.minLakeSize ?? 200;
    if (!Number.isInteger(minIslandSize) || minIslandSize < 1 || !Number.isInteger(minLakeSize) || minLakeSize < 1) {
      return "Minimum island and lake sizes must be positive whole numbers.";
    }
    return null;
  }

  private buildCliArgs(
    options: MapGenOptions,
    outputPath: string,
    preview = false,
  ): string[] {
    const args = [
      "--map-name",
      options.outputName?.trim() || "preview",
      "--output",
      outputPath,
      "--water-level",
      String(options.waterLevel ?? 127),
      "--mountain-threshold",
      String(options.mountainThreshold ?? 200),
      "--brightness",
      String(options.brightness ?? 0),
      "--contrast",
      String(options.contrast ?? 100),
      "--remove-small=" + String(options.removeSmall !== false),
      "--min-island-size",
      String(options.minIslandSize ?? 30),
      "--min-lake-size",
      String(options.minLakeSize ?? 200),
    ];
    if (options.invert) args.push("--invert");
    if (preview) args.push("--preview", "--preview-output", outputPath);
    if (options.inputImage) args.push("--input", options.inputImage);
    else args.push("--seed", options.seed!);
    if (options.width) args.push("--width", String(options.width));
    if (options.height) args.push("--height", String(options.height));
    return args;
  }

  private async runBinary(args: string[]): Promise<{ success: boolean; stdout?: string; error?: string }> {
    return new Promise((resolve) => {
      execFile(
        this.getMapGenPath(),
        args,
        { timeout: MAP_GENERATION_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 10 },
        (error, stdout, stderr) => {
          if (error) {
            console.error("[mapgen] Error:", error.message);
            console.error("[mapgen] stderr:", stderr);
            resolve({ success: false, error: stderr || error.message });
            return;
          }
          console.log("[mapgen] stdout:", stdout);
          resolve({ success: true, stdout });
        },
      );
    });
  }

  private safeMapDirectory(mapsDir: string, folder: string): string | null {
    if (!folder || folder === "." || folder === ".." || folder.includes("/") || folder.includes("\\")) {
      return null;
    }
    const root = path.resolve(mapsDir);
    const candidate = path.resolve(root, folder);
    return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
  }
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += localParts[localParts.length - 1].length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
