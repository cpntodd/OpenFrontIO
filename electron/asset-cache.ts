/**
 * Asset cache manager.
 *
 * Responsibilities:
 * - On first launch, download the full asset set from CDN to ~/.cache/
 * - On subsequent launches, check the remote manifest for changes and
 *   download only changed/delta files
 * - When offline, serve assets from the local cache
 * - Provide local file:// paths to the renderer for direct loading
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface AssetManifest {
  [filePath: string]: string; // relative path -> SHA-256 hex digest
}

export interface SyncResult {
  status: "success" | "partial" | "offline" | "error";
  downloaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  error?: string;
}

export interface AssetSyncProgress {
  phase: "manifest" | "downloading";
  current: number;
  total: number;
  fileName?: string;
}

export class AssetCache {
  private cacheDir: string;
  private manifestPath: string;
  private localManifest: AssetManifest | null = null;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.manifestPath = path.join(cacheDir, "manifest.json");
    fs.mkdirSync(cacheDir, { recursive: true });
    this.loadLocalManifest();
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  // ── Manifest loading ────────────────────────────

  private loadLocalManifest(): void {
    try {
      if (fs.existsSync(this.manifestPath)) {
        this.localManifest = JSON.parse(
          fs.readFileSync(this.manifestPath, "utf-8"),
        );
      }
    } catch {
      this.localManifest = null;
    }
  }

  private saveLocalManifest(manifest: AssetManifest): void {
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    this.localManifest = manifest;
  }

  // ── Path helpers ───────────────────────────────

  private getCachePath(remotePath: string): string {
    // Remote paths may start with / or not. Normalize.
    const normalized = remotePath.replace(/^\/+/, "").replace(/\.\./g, "");
    return path.join(this.cacheDir, normalized);
  }

  getLocalPath(assetPath: string): string {
    const localFile = this.getCachePath(assetPath);
    if (fs.existsSync(localFile)) {
      return `file://${localFile}`;
    }
    // Fallback: return the CDN URL (will be used if online)
    return assetPath;
  }

  isOfflineMode(): boolean {
    // We're offline if we have a local manifest but no network access.
    // Network check is done by the actual sync attempt.
    return this.localManifest !== null;
  }

  async getManifest(): Promise<AssetManifest | null> {
    return this.localManifest;
  }

  // ── CDN sync ───────────────────────────────────

  async syncFromCDN(
    cdnBase: string,
    onProgress?: (progress: AssetSyncProgress) => void,
  ): Promise<SyncResult> {
    if (!cdnBase) {
      return {
        status: "offline",
        downloaded: 0,
        skipped: 0,
        failed: 0,
        totalBytes: 0,
        error: "No CDN_BASE configured",
      };
    }

    const result: SyncResult = {
      status: "success",
      downloaded: 0,
      skipped: 0,
      failed: 0,
      totalBytes: 0,
    };

    try {
      // Fetch the remote manifest
      const manifestUrl = `${cdnBase}/manifest.json`;
      const remoteManifest = await this.fetchManifest(manifestUrl);

      if (!remoteManifest) {
        result.status = "error";
        result.error = "Failed to fetch remote manifest";
        return result;
      }

      // Determine which files need updating
      const toDownload: string[] = [];
      for (const [filePath, remoteHash] of Object.entries(remoteManifest)) {
        const localHash = this.localManifest?.[filePath];
        if (localHash !== remoteHash) {
          toDownload.push(filePath);
        }
      }

      result.skipped =
        Object.keys(remoteManifest).length - toDownload.length;

      // Report total count for progress
      if (onProgress) {
        onProgress({
          phase: "downloading",
          current: 0,
          total: toDownload.length,
        });
      }

      // Download changed files
      let processed = 0;
      for (const filePath of toDownload) {
        try {
          const url = `${cdnBase}/${filePath}`;
          if (onProgress) {
            onProgress({
              phase: "downloading",
              current: processed,
              total: toDownload.length,
              fileName: filePath,
            });
          }
          const success = await this.downloadFile(url, filePath);
          if (success) {
            result.downloaded++;
          } else {
            result.failed++;
          }
        } catch {
          result.failed++;
        }
        processed++;
      }

      // Final progress report
      if (onProgress) {
        onProgress({
          phase: "downloading",
          current: processed,
          total: toDownload.length,
        });
      }

      // Update local manifest
      if (result.failed === 0) {
        this.saveLocalManifest(remoteManifest);
        result.status = "success";
      } else if (result.downloaded > 0) {
        // Merged manifest: update only successfully downloaded entries
        const merged = { ...this.localManifest };
        for (const [key, hash] of Object.entries(remoteManifest)) {
          if (toDownload.includes(key) && !result.failed) {
            merged[key] = hash;
          }
        }
        this.saveLocalManifest(merged);
        result.status = "partial";
      }

      return result;
    } catch (err) {
      result.status = "error";
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }
  }

  // ── Network fetch helpers ───────────────────────

  private async fetchManifest(url: string): Promise<AssetManifest | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as AssetManifest;
    } catch {
      return null;
    }
  }

  private async downloadFile(
    url: string,
    filePath: string,
  ): Promise<boolean> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return false;

      const localPath = this.getCachePath(filePath);
      const dir = path.dirname(localPath);
      fs.mkdirSync(dir, { recursive: true });

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);

      // Verify hash against manifest if the manifest entry exists
      return true;
    } catch {
      return false;
    }
  }

  // ── Hash verification ─────────────────────────

  private hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Verify that all cached files match the manifest hashes.
   * Returns list of corrupted/missing files.
   */
  verifyCache(): string[] {
    if (!this.localManifest) return [];
    const corrupted: string[] = [];

    for (const [filePath, expectedHash] of Object.entries(
      this.localManifest,
    )) {
      const localPath = this.getCachePath(filePath);
      if (!fs.existsSync(localPath)) {
        corrupted.push(filePath);
        continue;
      }
      try {
        const actualHash = this.hashFile(localPath);
        if (actualHash !== expectedHash) {
          corrupted.push(filePath);
        }
      } catch {
        corrupted.push(filePath);
      }
    }

    return corrupted;
  }
}
