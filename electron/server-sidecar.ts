/**
 * Game server sidecar process manager.
 *
 * Manages the lifecycle of the bundled game server binary.
 * The server is compiled via Node.js SEA (Single Executable Application)
 * and shipped as a resource alongside the Electron app.
 *
 * Responsibilities:
 * - Start/stop the game server as a child process
 * - Health checks via HTTP GET /health
 * - Pass appropriate environment variables
 * - Handle server crash/restart
 */

import { ChildProcess, spawn } from "child_process";
import http from "http";
import path from "path";
import { app } from "electron";

export interface ServerStatus {
  status: "stopped" | "starting" | "running" | "error";
  port?: number;
  pid?: number;
  error?: string;
  players?: number;
}

const DEFAULT_PORT = 9000;
const HEALTH_CHECK_INTERVAL_MS = 2000;
const STARTUP_TIMEOUT_MS = 15_000;

export class ServerSidecar {
  private process: ChildProcess | null = null;
  private port: number = DEFAULT_PORT;
  private running = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ── Paths ──────────────────────────────────────

  private getServerBinaryPath(): string {
    // In production, the server binary is in the app's resources directory
    if (app.isPackaged) {
      return path.join(
        process.resourcesPath,
        "server",
        "openfront-server",
      );
    }
    // In development, use the local compiled or via tsx
    return path.join(
      app.getAppPath(),
      "node_modules",
      ".bin",
      "tsx",
    );
  }

  private getServerEntryPath(): string {
    return path.join(app.getAppPath(), "src", "server", "Server.ts");
  }

  // ── Lifecycle ───────────────────────────────────

  async start(config?: {
    port?: number;
    gameConfig?: unknown;
  }): Promise<ServerStatus> {
    if (this.running) {
      return {
        status: "running",
        port: this.port,
        pid: this.process?.pid,
      };
    }

    this.port = config?.port ?? DEFAULT_PORT;

    const isPackaged = app.isPackaged;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GAME_ENV: "prod",
      NUM_WORKERS: "1",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      API_KEY: "DESKTOP_SELFHOSTED",
      ADMIN_BOT_API_KEY: "DESKTOP_SELFHOSTED",
      DOMAIN: "localhost",
      GIT_COMMIT: app.getVersion() || "desktop",
      PORT: String(this.port),
      // Disable external API calls — self-hosted mode
      SELF_HOSTED: "true",
    };

    return new Promise((resolve) => {
      try {
        const args = isPackaged
          ? []
          : [this.getServerEntryPath()];

        const binaryPath = isPackaged
          ? this.getServerBinaryPath()
          : this.getServerBinaryPath();

        const child = spawn(binaryPath, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        this.process = child;

        child.stdout?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          console.log(`[server] ${line}`);
          // Detect when server is ready (listening)
          if (line.includes("listening") || line.includes("Server started")) {
            this.running = true;
            this.startHealthChecks();
            resolve({
              status: "running",
              port: this.port,
              pid: child.pid ?? undefined,
            });
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          console.error(`[server:err] ${data.toString().trim()}`);
        });

        child.on("error", (err) => {
          console.error("[server] Failed to start:", err.message);
          this.running = false;
          resolve({
            status: "error",
            error: err.message,
          });
        });

        child.on("exit", (code, signal) => {
          console.log(`[server] Exited with code=${code} signal=${signal}`);
          this.running = false;
          this.stopHealthChecks();
          this.process = null;
        });

        // Timeout fallback
        setTimeout(() => {
          if (!this.running) {
            resolve({
              status: "error",
              error: "Server startup timed out",
            });
          }
        }, STARTUP_TIMEOUT_MS);
      } catch (err) {
        resolve({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopHealthChecks();

    if (this.process) {
      // Graceful shutdown: send SIGTERM, then SIGKILL after 5s
      this.process.kill("SIGTERM");

      const killTimer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        this.process?.on("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });

      this.process = null;
    }

    this.running = false;
  }

  async status(): Promise<ServerStatus> {
    if (!this.running) {
      return { status: "stopped" };
    }
    return {
      status: "running",
      port: this.port,
      pid: this.process?.pid,
    };
  }

  // ── Health checks ──────────────────────────────

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private checkHealth(): void {
    const req = http.get(
      `http://localhost:${this.port}/health`,
      { timeout: 3000 },
      (res) => {
        if (res.statusCode !== 200) {
          console.warn(
            `[server] Health check returned ${res.statusCode}`,
          );
        }
      },
    );
    req.on("error", () => {
      // Server may not have a /health endpoint yet — that's OK
    });
    req.end();
  }
}
