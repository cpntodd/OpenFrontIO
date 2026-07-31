/**
 * Electron main process entry point.
 *
 * Responsibilities:
 * - Create BrowserWindow with WebGL2 support
 * - Register IPC handlers (server lifecycle, asset cache, mDNS, map gen)
 * - Serve the production page via local HTTP server with EJS rendering
 * - Handle app lifecycle (ready, window-all-closed, activate)
 */

import { randomUUID } from "crypto";
import ejs from "ejs";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  shell,
  WebContentsView,
} from "electron";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { AssetCache } from "./asset-cache";
import { MapGenSidecar } from "./map-gen-sidecar";
import { MDNSDiscovery } from "./mdns";
import { getOAuthRedirectUri } from "./oauth";
import { ServerSidecar } from "./server-sidecar";
import { initAutoUpdater } from "./updater";
import { createMainWindow, getMainWindow } from "./windows";

// ── Server profile types ───────────────────────────────────

interface ServerProfile {
  host: string;
  audience: string;
  env: string;
  workers: number;
}

interface ServerConfig {
  current: ServerProfile;
}

const SERVER_PRESETS: Record<string, ServerProfile> = {
  staging: {
    host: "main.openfront.dev",
    audience: "openfront.dev",
    env: "staging",
    workers: 2,
  },
  production: {
    host: "openfront.io",
    audience: "openfront.io",
    env: "prod",
    // Keep this aligned with BOOTSTRAP_CONFIG.numWorkers on openfront.io.
    // A wrong value sends game IDs to the wrong /wN endpoint; that worker
    // deliberately ignores the join because it belongs to another worker.
    workers: 20,
  },
};

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  current: SERVER_PRESETS.production,
};

// ── Server config persistence ──────────────────────────────

function getServerConfigPath(): string {
  return path.join(app.getPath("userData"), "server-config.json");
}

function readServerConfig(): ServerConfig {
  try {
    const raw = fs.readFileSync(getServerConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed?.current?.host &&
      parsed?.current?.audience &&
      parsed?.current?.env &&
      typeof parsed.current.workers === "number"
    ) {
      const preset = Object.values(SERVER_PRESETS).find(
        (candidate) => candidate.host === parsed.current.host,
      );
      // Preset runtime values can change as the hosted service scales. Do not
      // let an old persisted worker count keep routing games incorrectly.
      if (preset) return { current: { ...preset } };
      return parsed as ServerConfig;
    }
  } catch {
    // No valid config yet — use defaults.
  }
  return {
    ...DEFAULT_SERVER_CONFIG,
    current: { ...DEFAULT_SERVER_CONFIG.current },
  };
}

function writeServerConfig(config: ServerConfig): void {
  const dir = path.dirname(getServerConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getServerConfigPath(),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
}

let currentServer = readServerConfig();

/** Derive the full API base URL from the current server config. */
function getApiBaseUrl(): string {
  return `https://api.${currentServer.current.audience}`;
}

let assetCache: AssetCache;
let serverSidecar: ServerSidecar | null = null;
let mapGenSidecar: MapGenSidecar;
let mdnsDiscovery: MDNSDiscovery;
let localServer: http.Server | null = null;
let localServerPort: number | null = null;

// Keep the renderer's origin stable between launches. Username, TAG, settings,
// and other client state are stored in localStorage, which is keyed by origin;
// an ephemeral port would silently create a fresh store every time the app
// starts. This port is separate from the embedded LAN server's default 9000.
const ELECTRON_LOCAL_SERVER_PORT = 47837;

// This is a public Turnstile site key, not a secret. The production key below
// is the same one served by https://openfront.io to every browser visitor.
// It is embedded here so the desktop client can challenge players without
// requiring a per-build env var. Deployments or local packaging can override
// it via OPENFRONT_TURNSTILE_SITE_KEY or a desktop-config.json file.
const DEFAULT_TURNSTILE_SITE_KEY = "0x4AAAAAACFLkaecN39lS8sk";

function getDesktopTurnstileSiteKey(): string {
  try {
    const configPath = path.join(__dirname, "desktop-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      turnstileSiteKey?: unknown;
    };
    if (
      typeof config.turnstileSiteKey === "string" &&
      config.turnstileSiteKey.trim().length > 0
    ) {
      return config.turnstileSiteKey.trim();
    }
  } catch {
    // Development builds may not have a generated desktop config yet.
  }
  const configured =
    process.env.OPENFRONT_TURNSTILE_SITE_KEY ?? process.env.TURNSTILE_SITE_KEY;
  if (configured?.trim()) return configured.trim();

  // The dummy key is useful for `start:electron` against the local dev server,
  // but must never be presented as a production credential. A production
  // desktop build without a configured public key will now show a verification
  // error instead of sending a token that the production API must reject.
  return isDev() ? "1x00000000000000000000AA" : DEFAULT_TURNSTILE_SITE_KEY;
}

const DESKTOP_TURNSTILE_SITE_KEY = getDesktopTurnstileSiteKey();

// ── Environment ────────────────────────────────────────────

function isDev(): boolean {
  return (
    process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL
  );
}

function getDevServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
}

// A stable per-installation identifier is useful for matchmaking diagnostics
// and lets the desktop client identify its own connection without pretending
// that a locally-generated UUID is an authenticated play token. The file is
// deliberately separate from the session cookie and contains no secret.
function getDesktopInstanceId(): string {
  const userDataDir = app.getPath("userData");
  const identityPath = path.join(userDataDir, "desktop-instance.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8")) as {
      instanceId?: unknown;
    };
    if (
      typeof parsed.instanceId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.instanceId,
      )
    ) {
      return parsed.instanceId;
    }
  } catch {
    // The first launch has no identity file yet.
  }

  const instanceId = randomUUID();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      identityPath,
      `${JSON.stringify({ instanceId }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    console.warn("[electron] Failed to persist desktop instance ID:", error);
  }
  return instanceId;
}

// ── MIME types ─────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// ── API request proxy ──────────────────────────────────────
// Forwards a request from the renderer to the real API server
// and pipes the response back. This bypasses CORS entirely.

function proxyApiRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  apiUrl: string,
): void {
  const parsed = new URL(apiUrl);

  // Build clean headers (clone and sanitize)
  const reqHeaders: Record<string, string> = {};
  if (clientReq.headers) {
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (v !== undefined && !Array.isArray(v)) {
        reqHeaders[k] = v;
      }
    }
  }
  // Remove browser-specific headers that may confuse the API
  delete reqHeaders["host"];
  delete reqHeaders["origin"];
  delete reqHeaders["referer"];

  // The embedded verification/official page establishes the anonymous or
  // linked session on api.<audience>. A localhost fetch cannot send those
  // domain-scoped cookies, so attach them in the trusted main-process proxy.
  // This is ordinary cookie forwarding for the same user's Electron session;
  // it does not manufacture or expose authentication credentials.
  void session.defaultSession.cookies
    .get({ url: `${parsed.protocol}//${parsed.host}` })
    .then((apiCookies) => {
      if (apiCookies.length > 0) {
        reqHeaders.cookie = apiCookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");
      }

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: clientReq.method,
        headers: reqHeaders,
      };

      const proxyReq = https.request(apiUrl, options, (proxyRes) => {
        // Also mirror returned cookies onto localhost so renderer requests
        // remain persistent across app launches.
        const responseHeaders = { ...proxyRes.headers };
        if (proxyRes.headers["set-cookie"]) {
          responseHeaders["set-cookie"] = proxyRes.headers["set-cookie"].map(
            (cookie) =>
              cookie
                .replace(/;\s*Domain=[^;]*/gi, "")
                .replace(/;\s*Secure/gi, "")
                .replace(/;\s*SameSite=None/gi, "; SameSite=Lax"),
          );
        }
        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);
        proxyRes.pipe(clientRes);
      });

      proxyReq.on("error", (err) => {
        console.error("[electron] Proxy error:", err.message);
        clientRes.writeHead(502);
        clientRes.end("Proxy Error");
      });

      clientReq.pipe(proxyReq);
    })
    .catch((error) => {
      console.error("[electron] Failed to read API session cookies:", error);
      clientRes.writeHead(502);
      clientRes.end("Proxy Session Error");
    });
}

// ── Local HTTP server (production) ─────────────────────────
// Serves the Vite-built static/ directory and renders the EJS
// template in index.html, matching RenderHtml.ts behaviour.

function startLocalServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const rootDir = path.join(__dirname, "..");
    const staticDir = path.join(rootDir, "static");
    const resourcesDir = path.join(rootDir, "resources");
    const proprietaryDir = path.join(rootDir, "proprietary");
    const customMapsDir = path.join(app.getPath("userData"), "maps");
    const appVersion = app.getVersion() || "desktop";
    let serverPort = ELECTRON_LOCAL_SERVER_PORT;

    // Directories to search for static assets, in priority order:
    // 1. static/ (Vite build output: JS, CSS, bundled assets)
    // 2. resources/ (game assets: maps, images, sounds, fonts, flags)
    // 3. proprietary/ (proprietary images: logos, etc.)
    const assetDirs = [staticDir, resourcesDir, proprietaryDir];
    let assetManifest: Record<string, string> = {};
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(staticDir, "asset-manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      assetManifest = Object.fromEntries(
        Object.entries(parsed).filter(
          ([logicalPath, hashedPath]) =>
            logicalPath.length > 0 && typeof hashedPath === "string",
        ),
      ) as Record<string, string>;
    } catch (error) {
      console.warn("[electron] Asset manifest unavailable:", error);
    }

    const assetUrl = (logicalPath: string): string =>
      assetManifest[logicalPath] ?? logicalPath;

    const findAsset = (urlPath: string): string | null => {
      let clean: string;
      try {
        clean = decodeURIComponent(urlPath).replace(/^\/+/, "");
      } catch {
        return null;
      }
      const segments = clean.replace(/\\/g, "/").split("/");
      if (segments.includes("..") || clean.includes("\0")) return null;

      // Production builds content-hash public assets under /_assets. Keep
      // logical URLs working too, so older cached renderer code and direct
      // HTML references do not turn into 404s.
      const hashedPath = assetManifest[clean];
      if (hashedPath) {
        try {
          const hashedClean = decodeURIComponent(hashedPath).replace(
            /^\/+/,
            "",
          );
          const hashedSegments = hashedClean.replace(/\\/g, "/").split("/");
          if (!hashedSegments.includes("..")) {
            const mapped = path.join(staticDir, hashedClean);
            if (fs.existsSync(mapped) && fs.statSync(mapped).isFile()) {
              return mapped;
            }
          }
        } catch {
          // Fall through to the normal asset directories.
        }
      }

      for (const dir of assetDirs) {
        const full = path.join(dir, clean);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
      return null;
    };

    const buildTemplateData = () => {
      const srv = currentServer.current;
      return {
        gitCommit: JSON.stringify(appVersion),
        assetManifest: JSON.stringify(assetManifest),
        cdnBase: JSON.stringify(""),
        cdnBaseRaw: "",
        gameEnv: JSON.stringify(srv.env),
        numWorkers: JSON.stringify(srv.workers),
        turnstileSiteKey: JSON.stringify(DESKTOP_TURNSTILE_SITE_KEY),
        jwtAudience: JSON.stringify(srv.audience),
        instanceId: JSON.stringify(getDesktopInstanceId()),
        serverHost: JSON.stringify(srv.host),
        isDesktopShell: "true",
        manifestHref: assetUrl("manifest.json"),
        faviconHref: assetUrl("images/Favicon.svg"),
        gameplayScreenshotUrl: assetUrl("images/GameplayScreenshot.png"),
        backgroundImageUrl: assetUrl("images/background.webp"),
        desktopLogoImageUrl: assetUrl("images/OpenFront.png"),
        mobileLogoImageUrl: assetUrl("images/OF.png"),
      };
    };

    localServer = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://localhost");
      const urlPath = url.pathname;

      // Path traversal guard
      if (urlPath.includes("..")) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      // index.html → EJS render
      if (urlPath === "/" || urlPath.endsWith("index.html")) {
        try {
          const indexPath = path.join(staticDir, "index.html");
          const template = fs.readFileSync(indexPath, "utf-8");
          const rendered = ejs.render(template, buildTemplateData());

          // Inject API proxy script before </head>
          const apiHost = `api.${currentServer.current.audience}`;
          const proxyScript = API_PROXY_SCRIPT.replace(
            "__API_HOST__",
            apiHost,
          ).replace("__PORT__", String(serverPort));
          const injected = rendered.replace(
            "</head>",
            "  <script>" + proxyScript + "</script>\n  </head>",
          );

          // Fix CDN base to absolute URL for worker asset resolution
          const finalHtml = injected.replace(
            /cdnBase: ""/,
            `cdnBase: "http://127.0.0.1:${serverPort}"`,
          );

          res.writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": "no-cache",
          });
          res.end(finalHtml);
        } catch (err) {
          console.error("[electron] EJS render failed:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        return;
      }

      // API proxy: forward /__api/* → real API server (derived from server config)
      if (urlPath.startsWith("/__api/")) {
        const apiPath = urlPath.replace("/__api", "");
        const apiUrl = `${getApiBaseUrl()}${apiPath}`;
        proxyApiRequest(req, res, apiUrl);
        return;
      }

      // Generated maps live outside the packaged asset tree. Only expose the
      // five fixed files needed by the map loader, and resolve the folder
      // beneath the user-data maps directory to prevent traversal.
      if (urlPath.startsWith("/__custom-maps/")) {
        const routeParts = urlPath.slice("/__custom-maps/".length).split("/");
        if (routeParts.length !== 2 || !routeParts[0] || !routeParts[1]) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        let folder: string;
        let fileName: string;
        try {
          folder = decodeURIComponent(routeParts[0]);
          fileName = decodeURIComponent(routeParts[1]);
        } catch {
          res.writeHead(400);
          res.end("Bad Request");
          return;
        }

        if (
          !folder ||
          folder === "." ||
          folder === ".." ||
          folder.includes("/") ||
          folder.includes("\\") ||
          ![
            "map.bin",
            "map4x.bin",
            "map16x.bin",
            "manifest.json",
            "thumbnail.webp",
          ].includes(fileName)
        ) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        const mapsRoot = path.resolve(customMapsDir);
        const assetPath = path.resolve(mapsRoot, folder, fileName);
        if (
          !assetPath.startsWith(`${mapsRoot}${path.sep}`) ||
          !fs.existsSync(assetPath) ||
          !fs.statSync(assetPath).isFile()
        ) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        try {
          const ext = path.extname(assetPath).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(fs.readFileSync(assetPath));
        } catch (err) {
          console.error("[electron] Failed to serve custom map asset:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        return;
      }

      // Find and serve asset from any of the asset directories
      const assetPath = findAsset(urlPath);
      if (assetPath) {
        try {
          const ext = path.extname(assetPath).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          const content = fs.readFileSync(assetPath);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control":
              ext === ".html" ? "no-cache" : "max-age=31536000, immutable",
          });
          res.end(content);
        } catch (err) {
          console.error("[electron] Failed to serve asset:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        return;
      }

      // Not found in any directory
      res.writeHead(404);
      res.end("Not Found");
    });

    localServer.listen(ELECTRON_LOCAL_SERVER_PORT, "127.0.0.1", () => {
      const addr = localServer?.address();
      if (addr && typeof addr === "object") {
        serverPort = addr.port;
        localServerPort = addr.port;
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });

    localServer.on("error", reject);
  });
}

function stopLocalServer(): void {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  localServerPort = null;
}

// ── IPC handlers ────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle("asset-cache:sync", async () => {
    return assetCache.syncFromCDN(process.env.CDN_BASE ?? "");
  });
  ipcMain.handle("asset-cache:get-local-path", async (_e, p: string) =>
    assetCache.getLocalPath(p),
  );
  ipcMain.handle("asset-cache:is-offline", async () =>
    assetCache.isOfflineMode(),
  );
  ipcMain.handle("asset-cache:get-manifest", async () =>
    assetCache.getManifest(),
  );

  ipcMain.handle("server:start", async (_e, config: any) => {
    if (serverSidecar) return { status: "error", error: "Already running" };
    serverSidecar = new ServerSidecar();
    const result = await serverSidecar.start(config);
    if (result.status === "running") {
      await mdnsDiscovery.advertise({
        name: config?.name ?? "OpenFront Server",
        port: result.port!,
      });
    }
    return result;
  });
  ipcMain.handle("server:stop", async () => {
    if (!serverSidecar) return { status: "stopped" };
    await serverSidecar.stop();
    await mdnsDiscovery.stopAdvertising();
    serverSidecar = null;
    return { status: "stopped" };
  });
  ipcMain.handle(
    "server:status",
    async () => serverSidecar?.status() ?? { status: "stopped" },
  );

  ipcMain.handle("lan:discover", async () => mdnsDiscovery.browse());
  ipcMain.handle("lan:stop-discovery", async () =>
    mdnsDiscovery.stopBrowsing(),
  );
  ipcMain.handle("lan:connect", async (_e, host: string, port: number) => ({
    host,
    port,
  }));

  ipcMain.handle("mapgen:generate", async (_e, opts: any) =>
    mapGenSidecar.generate(opts),
  );
  ipcMain.handle("mapgen:preview", async (_e, opts: any) =>
    mapGenSidecar.preview(opts),
  );
  ipcMain.handle("mapgen:export", async (_e, folder: string) =>
    mapGenSidecar.exportMap(folder),
  );
  ipcMain.handle("mapgen:list", async () => ({
    maps: await mapGenSidecar.list(),
    assetBaseUrl:
      localServerPort === null ? null : `http://127.0.0.1:${localServerPort}`,
  }));
  ipcMain.handle("mapgen:pick-image", async () => mapGenSidecar.pickImage());

  ipcMain.handle("app:get-version", async () => app.getVersion());
  ipcMain.handle("app:get-user-data-path", async () => app.getPath("userData"));
  ipcMain.handle("app:get-cache-path", async () => assetCache.getCacheDir());
  ipcMain.handle("app:open-external", async (_e, url: string) => {
    await shell.openExternal(url);
  });

  // ── Server config ──
  ipcMain.handle("server-config:get", async () => ({
    current: currentServer.current,
    presets: SERVER_PRESETS,
  }));

  ipcMain.handle("server-config:set", async (_e, host: string) => {
    const preset = Object.values(SERVER_PRESETS).find((p) => p.host === host);
    if (preset) {
      currentServer = { current: preset };
    } else {
      // Custom server — derive audience/env from host
      currentServer = {
        current: {
          host,
          audience: host,
          env: "prod",
          workers: 1,
        },
      };
    }
    writeServerConfig(currentServer);
    console.log(
      "[electron] Server config updated:",
      currentServer.current.host,
    );

    return { success: true };
  });

  // ── Turnstile token (desktop) ────────────────────────────
  // Production Turnstile keys are hostname-bound, so the localhost renderer
  // cannot host the widget. Use a normal WebView on the selected server's
  // public web origin, preserving Electron's default User-Agent and browser
  // behavior as required by Turnstile. The remote page supplies the sitekey
  // that matches its environment; the configured key is only a production
  // fallback if the bootstrap object is unavailable.

  ipcMain.handle("turnstile:get-token", async () => {
    type TurnstileTokenResult = { token: string | null; error?: string };
    const verificationOrigin = `https://${currentServer.current.audience}/`;
    const fallbackSiteKey =
      currentServer.current.audience === "openfront.io"
        ? DESKTOP_TURNSTILE_SITE_KEY
        : "";

    return new Promise<TurnstileTokenResult>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout | null = null;
      let cleanup = (): void => {};
      const finish = (result: TurnstileTokenResult): void => {
        if (resolved) return;
        resolved = true;
        if (timer !== null) clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      const mainWindow = getMainWindow();
      if (!mainWindow) {
        finish({
          token: null,
          error: "The main application window is unavailable.",
        });
        return;
      }

      const turnstileView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          session: session.defaultSession,
        },
      });
      turnstileView.setBackgroundColor("#1e1e1e");
      mainWindow.contentView.addChildView(turnstileView);
      // Let the invisible Turnstile widget run without exposing the remote
      // OpenFront page. The view is revealed only if Cloudflare asks for
      // interaction; successful background verification never appears as a
      // popup or embedded page.
      turnstileView.setVisible(false);

      let revealTimer: NodeJS.Timeout | null = null;
      let interactionRevealed = false;

      const positionView = (): void => {
        if (
          mainWindow.isDestroyed() ||
          turnstileView.webContents.isDestroyed()
        ) {
          return;
        }
        const [contentWidth, contentHeight] = mainWindow.getContentSize();
        const width = Math.min(420, contentWidth);
        const height = Math.min(540, contentHeight);
        turnstileView.setBounds({
          x: Math.max(0, Math.floor((contentWidth - width) / 2)),
          y: Math.max(0, Math.floor((contentHeight - height) / 2)),
          width,
          height,
        });
      };
      const revealInteraction = (): void => {
        if (
          resolved ||
          interactionRevealed ||
          mainWindow.isDestroyed() ||
          turnstileView.webContents.isDestroyed()
        ) {
          return;
        }
        interactionRevealed = true;
        if (revealTimer !== null) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
        positionView();
        turnstileView.setVisible(true);
      };
      positionView();
      mainWindow.on("resize", positionView);
      cleanup = (): void => {
        mainWindow.off("resize", positionView);
        if (revealTimer !== null) clearTimeout(revealTimer);
        turnstileView.setVisible(false);
        try {
          mainWindow.contentView.removeChildView(turnstileView);
        } catch {
          /* The main window may already be closing. */
        }
        if (!turnstileView.webContents.isDestroyed()) {
          turnstileView.webContents.close();
        }
      };

      timer = setTimeout(() => {
        console.warn("[electron] Turnstile token generation timed out");
        finish({
          token: null,
          error: "Security verification timed out. Please try again.",
        });
      }, 120_000);

      let injectionStarted = false;
      turnstileView.webContents.on("did-finish-load", () => {
        if (injectionStarted) return;
        injectionStarted = true;
        // Let the remote SPA finish mounting first. Injecting immediately at
        // did-finish-load lets its initial render replace our verification UI.
        setTimeout(() => {
          if (resolved || turnstileView.webContents.isDestroyed()) return;
          revealTimer = setTimeout(revealInteraction, 10_000);
          void turnstileView.webContents
            .executeJavaScript(
              `new Promise((resolve) => {
            var settled = false;
            var lastError = '';
            var interactionSignaled = false;
            var challengeObserver = null;
            var challengePoller = null;
            var signalInteraction = function() {
              if (interactionSignaled || settled) return;
              interactionSignaled = true;
              try { location.href = 'openfront-turnstile-interaction:'; } catch (_) {}
            };
            var finish = function(result) {
              if (settled) return;
              settled = true;
              if (challengeObserver) challengeObserver.disconnect();
              if (challengePoller) clearInterval(challengePoller);
              resolve(result);
            };
            var overlay = document.createElement('div');
            overlay.id = 'of-turnstile-overlay';
            overlay.innerHTML =
              '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;font-family:sans-serif;color:#d4d4d4;background:#1e1e1e;padding:24px;">' +
              '<h2 style="color:#fff;margin:0;font-size:18px;">Security Verification</h2>' +
              '<p id="of-turnstile-status" style="margin:0;font-size:14px;text-align:center;color:#9d9d9d;">Complete the check to join online games.</p>' +
              '<div id="turnstile-widget"></div>' +
              '<button id="of-turnstile-cancel" type="button" style="padding:9px 18px;border:1px solid #555;border-radius:6px;background:#282828;color:#ddd;cursor:pointer;">Cancel</button>' +
              '</div>';
            overlay.style.cssText = 'position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:2147483647!important;display:block!important;';
            document.documentElement.appendChild(overlay);
            new MutationObserver(function() {
              if (!document.getElementById('of-turnstile-overlay')) {
                document.documentElement.appendChild(overlay);
              }
            }).observe(document.documentElement, { childList: true, subtree: true });

            var checkForInteraction = function() {
              if (settled || interactionSignaled) return;
              var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
              var challengeVisible = frames.some(function(frame) {
                var src = String(frame.src || '');
                if (src.indexOf('challenges.cloudflare.com') === -1) return false;
                var style = window.getComputedStyle(frame);
                var rect = frame.getBoundingClientRect();
                return style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 && rect.height > 0;
              });
              if (challengeVisible) signalInteraction();
            };
            challengeObserver = new MutationObserver(checkForInteraction);
            challengeObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            challengePoller = setInterval(checkForInteraction, 250);

            var status = document.getElementById('of-turnstile-status');
            document.getElementById('of-turnstile-cancel').onclick = function() {
              location.href = 'openfront-turnstile-cancel:';
            };
            var started = Date.now();
            var siteKey =
              window.BOOTSTRAP_CONFIG &&
              typeof window.BOOTSTRAP_CONFIG.turnstileSiteKey === 'string'
                ? window.BOOTSTRAP_CONFIG.turnstileSiteKey.trim()
                : ${JSON.stringify(fallbackSiteKey)};

            if (!siteKey) {
              finish({
                token: null,
                error: 'The selected server did not provide a Turnstile sitekey.'
              });
              return;
            }

            var renderWhenReady = function() {
              if (settled) return;
              if (window.turnstile && typeof window.turnstile.render === 'function') {
                try {
                  window.turnstile.render('#turnstile-widget', {
                    sitekey: siteKey,
                    size: 'invisible',
                    appearance: 'interaction-only',
                    theme: 'dark',
                    retry: 'auto',
                    'retry-interval': 8000,
                    'refresh-expired': 'auto',
                    callback: function(token) {
                      finish({ token: token });
                    },
                    'error-callback': function(code) {
                      lastError = String(code || 'unknown');
                      console.error('[OpenFront] Turnstile error:', lastError);
                      if (status) {
                        status.textContent =
                          'Verification failed (' + lastError + '). Retrying...';
                      }
                      return false;
                    },
                    'expired-callback': function() {
                      if (status) status.textContent = 'Verification expired. Refreshing...';
                    }
                  });
                } catch (error) {
                  finish({
                    token: null,
                    error: 'Turnstile could not start: ' +
                      (error && error.message ? error.message : String(error))
                  });
                }
                return;
              }
              if (Date.now() - started >= 15000) {
                finish({
                  token: null,
                  error: 'Turnstile did not load from challenges.cloudflare.com.'
                });
                return;
              }
              setTimeout(renderWhenReady, 100);
            };

            setTimeout(function() {
              finish({
                token: null,
                error: lastError
                  ? 'Turnstile verification failed with error ' + lastError + '.'
                  : 'Security verification timed out.'
              });
            }, 110000);
            renderWhenReady();
          })`,
              true,
            )
            .then((result: unknown) => {
              if (
                typeof result === "object" &&
                result !== null &&
                "token" in result
              ) {
                const candidate = result as TurnstileTokenResult;
                finish({
                  token:
                    typeof candidate.token === "string" &&
                    candidate.token.length > 0
                      ? candidate.token
                      : null,
                  error:
                    typeof candidate.error === "string"
                      ? candidate.error
                      : undefined,
                });
                return;
              }
              finish({
                token: null,
                error: "Security verification returned an invalid response.",
              });
            })
            .catch((err) => {
              console.warn("[electron] Turnstile injection failed:", err);
              finish({
                token: null,
                error: `Turnstile could not start: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            });
        }, 1500);
      });

      turnstileView.webContents.on(
        "did-fail-load",
        (_event, code, description, url, isMainFrame) => {
          // Chromium reports aborted redirects as ERR_ABORTED (-3), and remote
          // pages can have unrelated ad/analytics subframes fail. Neither means
          // the top-level verification page failed.
          if (!isMainFrame || code === -3) return;
          console.warn(
            "[electron] Turnstile page failed to load:",
            url,
            "code:",
            code,
            "description:",
            description,
          );
          finish({
            token: null,
            error: `Verification page failed to load (${code}: ${description}).`,
          });
        },
      );

      turnstileView.webContents.on("will-navigate", (event, url) => {
        if (url === "openfront-turnstile-interaction:") {
          event.preventDefault();
          revealInteraction();
          return;
        }
        if (url === "openfront-turnstile-cancel:") {
          event.preventDefault();
          finish({
            token: null,
            error: "Security verification was cancelled.",
          });
        }
      });

      turnstileView.webContents.loadURL(verificationOrigin).catch((err) => {
        console.warn("[electron] Turnstile window failed to load:", err);
        finish({
          token: null,
          error: `Verification page could not be opened: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });
    });
  });

  // ── OAuth login ──
  // The OAuth BrowserWindow is only an authentication broker. The renderer
  // must confirm that its proxy-backed /auth/refresh call succeeded before the
  // broker is closed; this prevents the old race where the broker showed a
  // signed-in page but the main Electron window stayed a guest.
  type OAuthLoginResult = {
    status: "authenticated" | "cancelled" | "failed";
    error?: string;
  };
  let activeOAuthWindow: BrowserWindow | null = null;
  let activeOAuthReady = false;
  let completeActiveOAuth: ((result: OAuthLoginResult) => void) | null = null;

  ipcMain.handle("app:oauth-authenticated", async (event) => {
    if (
      event.sender !== getMainWindow()?.webContents ||
      !activeOAuthReady ||
      completeActiveOAuth === null
    ) {
      return false;
    }
    completeActiveOAuth({ status: "authenticated" });
    return true;
  });

  ipcMain.handle("app:oauth-failed", async (event, reason?: string) => {
    if (
      event.sender !== getMainWindow()?.webContents ||
      completeActiveOAuth === null
    ) {
      return false;
    }
    completeActiveOAuth({
      status: "failed",
      error: typeof reason === "string" ? reason : "Authentication failed",
    });
    return true;
  });

  ipcMain.handle("app:oauth-login", async (_e, provider: string) => {
    if (provider !== "discord" && provider !== "google") {
      return {
        status: "failed",
        error: "Unsupported login provider",
      } satisfies OAuthLoginResult;
    }
    if (completeActiveOAuth !== null) {
      return {
        status: "failed",
        error: "A login is already in progress",
      } satisfies OAuthLoginResult;
    }

    const oauthRedirectUri = getOAuthRedirectUri(
      currentServer.current.audience,
    );
    if (oauthRedirectUri === null) {
      return {
        status: "failed",
        error: "OAuth login is not available for the selected server",
      } satisfies OAuthLoginResult;
    }
    const redirectUri = encodeURIComponent(oauthRedirectUri);
    const authUrl = `${getApiBaseUrl()}/auth/login/${provider}?redirect_uri=${redirectUri}`;
    const oauthPublicUrl = new URL(oauthRedirectUri);
    const oauthPublicHosts = new Set([
      oauthPublicUrl.hostname,
      `www.${oauthPublicUrl.hostname}`,
    ]);

    console.log(
      `[electron] Starting ${provider} OAuth for ${currentServer.current.audience}`,
    );
    const mainWindow = getMainWindow();
    const oauthWin = new BrowserWindow({
      width: 500,
      height: 700,
      title: `OpenFront ${provider === "google" ? "Google" : "Discord"} Login`,
      parent: mainWindow ?? undefined,
      modal: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    activeOAuthWindow = oauthWin;
    activeOAuthReady = false;

    return new Promise<OAuthLoginResult>((resolve) => {
      let completed = false;
      let timeout: NodeJS.Timeout | null = null;

      const finish = (result: OAuthLoginResult): void => {
        if (completed) return;
        completed = true;
        if (timeout !== null) clearTimeout(timeout);
        if (activeOAuthWindow === oauthWin) activeOAuthWindow = null;
        activeOAuthReady = false;
        if (completeActiveOAuth !== null) completeActiveOAuth = null;
        if (!oauthWin.isDestroyed()) oauthWin.close();
        resolve(result);
      };

      completeActiveOAuth = finish;
      timeout = setTimeout(
        () => {
          finish({
            status: "failed",
            error: "Login timed out before the desktop session was confirmed",
          });
        },
        2 * 60 * 1000,
      );

      const copyAuthCookiesToLocal = async (): Promise<number> => {
        const localPort = localServerPort ?? 0;
        if (!localPort) return 0;

        const apiBase = getApiBaseUrl();
        const gameHost = currentServer.current.host;

        // Collect refresh/auth cookies from both the game domain and the API
        // subdomain, since the OAuth redirect chain may set cookies on either.
        // Staging has a separate game host (main.openfront.dev) and public web
        // origin (openfront.dev), so include both origins explicitly.
        const cookiesByKey = new Map<string, Electron.Cookie>();
        for (const url of [
          oauthPublicUrl.origin + "/",
          `https://${gameHost}/`,
          apiBase + "/",
        ]) {
          const cookies = await session.defaultSession.cookies.get({ url });
          for (const cookie of cookies) {
            cookiesByKey.set(`${cookie.name}\u0000${cookie.path}`, cookie);
          }
        }

        let copied = 0;
        for (const cookie of cookiesByKey.values()) {
          const cookieDetails = {
            name: cookie.name,
            value: cookie.value,
            path: cookie.path ?? "/",
            httpOnly: cookie.httpOnly,
            secure: false,
            sameSite:
              cookie.sameSite === "no_restriction" ? "lax" : cookie.sameSite,
            expirationDate: cookie.expirationDate,
          } as const;
          for (const targetUrl of [
            `http://127.0.0.1:${localPort}`,
            apiBase,
            `https://${gameHost}`,
          ]) {
            try {
              await session.defaultSession.cookies.set({
                url: targetUrl,
                ...cookieDetails,
              });
            } catch {
              // Some third-party cookies cannot be re-scoped. Auth cookies
              // are still copied to the local and API origins.
            }
          }
          copied++;
        }
        return copied;
      };

      const isOpenFrontRedirect = (parsed: URL): boolean =>
        parsed.protocol === "https:" && oauthPublicHosts.has(parsed.hostname);

      const tokenFromUrl = (rawUrl: string): string | null => {
        try {
          const parsed = new URL(rawUrl);
          const directToken =
            parsed.searchParams.get("login-token") ??
            parsed.searchParams.get("token");
          if (directToken) return directToken;

          const hash = parsed.hash.replace(/^#/, "");
          const hashQueries = [
            hash,
            hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "",
          ];
          for (const query of hashQueries) {
            if (!query) continue;
            const params = new URLSearchParams(query);
            const token =
              params.get("token-login") ??
              params.get("login-token") ??
              params.get("token");
            if (token) return token;
          }
        } catch {
          // Ignore malformed navigation URLs.
        }
        return null;
      };

      const confirmRemoteSession = async (): Promise<{
        jwt: string;
        expiresIn: number;
      } | null> => {
        const apiBase = getApiBaseUrl();
        try {
          // The OAuth page is already on an approved web origin, so this is a
          // normal authenticated refresh—not a token extraction or challenge
          // bypass. It also avoids treating unrelated Cloudflare cookies as
          // proof that the provider login succeeded.
          const sessionPayload = await oauthWin.webContents.executeJavaScript(
            `fetch("${apiBase}/auth/refresh", { method: "POST", credentials: "include" })\n` +
              `  .then(async (response) => response.ok ? await response.json() : null)\n` +
              `  .catch(() => null)`,
            true,
          );
          if (
            typeof sessionPayload !== "object" ||
            sessionPayload === null ||
            typeof (sessionPayload as { jwt?: unknown }).jwt !== "string" ||
            typeof (sessionPayload as { expiresIn?: unknown }).expiresIn !==
              "number"
          ) {
            return null;
          }
          return {
            jwt: (sessionPayload as { jwt: string }).jwt,
            expiresIn: (sessionPayload as { expiresIn: number }).expiresIn,
          };
        } catch (error) {
          console.warn(
            "[electron] Could not confirm remote OAuth session:",
            error,
          );
          return null;
        }
      };

      const notifyRenderer = (
        channel: "oauth:token" | "oauth:session-ready",
        value?: string,
      ) => {
        if (completed || activeOAuthWindow !== oauthWin) return;
        activeOAuthReady = true;
        if (value === undefined) {
          mainWindow?.webContents.send(channel);
        } else {
          mainWindow?.webContents.send(channel, value);
        }
      };

      const handleNavigation = async (url: string): Promise<void> => {
        try {
          const parsed = new URL(url);
          if (!isOpenFrontRedirect(parsed) || activeOAuthReady || completed)
            return;
          const token = tokenFromUrl(url);
          if (token) {
            console.log("[electron] OAuth token captured from redirect");
            notifyRenderer("oauth:token", token);
          }
        } catch {
          // Ignore malformed URLs.
        }
      };

      // Intercept both navigation and redirects. The token may be returned in
      // the query string or in the hash used by the web token-login route.
      oauthWin.webContents.on("will-navigate", (_event, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("will-redirect", (_event, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("did-navigate", (_event, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("did-navigate-in-page", (_event, url) => {
        void handleNavigation(url);
      });

      // When the OAuth window finishes loading the authenticated homepage,
      // copy the refresh cookie and let the renderer confirm /auth/refresh.
      oauthWin.webContents.on("did-finish-load", async () => {
        try {
          const url = oauthWin.webContents.getURL();
          await handleNavigation(url);
          if (activeOAuthReady || completed) return;
          const parsed = new URL(url);
          if (!isOpenFrontRedirect(parsed)) return;
          const remoteSession = await confirmRemoteSession();
          if (remoteSession === null) return;
          const copied = await copyAuthCookiesToLocal();
          if (copied > 0 || remoteSession.jwt.length > 0) {
            console.log(
              `[electron] Copied ${copied} auth cookies to local session`,
            );
            notifyRenderer(
              "oauth:session-ready",
              JSON.stringify(remoteSession),
            );
          }
        } catch (error) {
          console.error(
            "[electron] Failed to complete OAuth navigation:",
            error,
          );
        }
      });

      oauthWin.on("closed", () => {
        if (!completed) finish({ status: "cancelled" });
      });

      oauthWin.loadURL(authUrl).catch((error: unknown) => {
        finish({
          status: "failed",
          error:
            error instanceof Error ? error.message : "Unable to open login",
        });
      });
    });
  });
}

function registerProtocols(): void {
  protocol.registerFileProtocol("local-asset", (request, callback) => {
    const filePath = request.url.replace("local-asset://", "");
    try {
      callback({ path: filePath });
    } catch {
      callback({ statusCode: 404 });
    }
  });
}

// ── API CORS proxy ──────────────────────────────────────────
// The openfront.io API only allows requests from https://openfront.io.
// Our Electron app runs on http://127.0.0.1. We fix this by:
// 1. Running a reverse proxy in our local HTTP server (/__api/*)
// 2. Injecting a script into the rendered HTML that overrides
//    fetch() to route api.openfront.io requests through our proxy.

const API_PROXY_SCRIPT = `
(function() {
  var _fetch = window.fetch;
  var apiHost = "__API_HOST__";
  var proxyBase = "http://127.0.0.1:__PORT__/__api";
  window.fetch = function(resource, options) {
    var url = typeof resource === "string" ? resource : (resource instanceof Request ? resource.url : resource);
    if (url.indexOf(apiHost) !== -1 && url.indexOf("/__api/") === -1) {
      var parsed = new URL(url);
      url = proxyBase + parsed.pathname + parsed.search;
      if (typeof resource === "string") {
        resource = url;
      } else if (resource instanceof Request) {
        resource = new Request(url, resource);
      }
    }
    return _fetch.call(window, resource, options);
  };
})();
`;

// ── App lifecycle ───────────────────────────────────────────

async function onReady(): Promise<void> {
  assetCache = new AssetCache(
    path.join(app.getPath("userData"), "cache", "assets"),
  );
  mapGenSidecar = new MapGenSidecar();
  mdnsDiscovery = new MDNSDiscovery();

  registerProtocols();
  registerIpcHandlers();

  const mainWindow = createMainWindow();

  const port = await startLocalServer();

  if (isDev()) {
    await mainWindow.loadURL(getDevServerUrl());
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const localOrigin = `http://127.0.0.1:${port}`;
    console.log(`[electron] Local server started at ${localOrigin}`);
    await mainWindow.loadURL(localOrigin);
  }

  if (!isDev()) {
    initAutoUpdater();
    assetCache
      .syncFromCDN(process.env.CDN_BASE ?? "", (progress) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send("asset-sync:progress", progress);
      })
      .catch((err: Error) => {
        console.warn("[asset-cache] Initial sync failed:", err.message);
      });
  }
}

app.whenReady().then(onReady);

app.on("window-all-closed", () => {
  serverSidecar?.stop();
  stopLocalServer();
  mdnsDiscovery.destroy();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("before-quit", async () => {
  if (serverSidecar) {
    await serverSidecar.stop();
    await mdnsDiscovery.stopAdvertising();
  }
  mdnsDiscovery.destroy();
});
