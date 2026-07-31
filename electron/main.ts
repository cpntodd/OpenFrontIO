/**
 * Electron main process entry point.
 *
 * Responsibilities:
 * - Create BrowserWindow with WebGL2 support
 * - Register IPC handlers (server lifecycle, asset cache, mDNS, map gen)
 * - Serve the production page via local HTTP server with EJS rendering
 * - Handle app lifecycle (ready, window-all-closed, activate)
 */

import { app, BrowserWindow, ipcMain, protocol, session, shell } from "electron";
import ejs from "ejs";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { AssetCache } from "./asset-cache";
import { MapGenSidecar } from "./map-gen-sidecar";
import { MDNSDiscovery } from "./mdns";
import { ServerSidecar } from "./server-sidecar";
import { initAutoUpdater } from "./updater";
import { createMainWindow, getMainWindow } from "./windows";

let assetCache: AssetCache;
let serverSidecar: ServerSidecar | null = null;
let mapGenSidecar: MapGenSidecar;
let mdnsDiscovery: MDNSDiscovery;
let localServer: http.Server | null = null;
let localServerPort: number | null = null;
let oauthCallbackToken: string | null = null;

// Keep the renderer's origin stable between launches. Username, TAG, settings,
// and other client state are stored in localStorage, which is keyed by origin;
// an ephemeral port would silently create a fresh store every time the app
// starts. This port is separate from the embedded LAN server's default 9000.
const ELECTRON_LOCAL_SERVER_PORT = 47837;

// This is a public Turnstile site key, not a secret. The packaged desktop
// client must use the same production key as the online game; the test key is
// only useful for local development. Allow deployments and local packaging to
// provide it without putting an environment-specific key in source control.
function getDesktopTurnstileSiteKey(): string {
  try {
    const configPath = path.join(__dirname, "desktop-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      turnstileSiteKey?: unknown;
    };
    if (typeof config.turnstileSiteKey === "string" && config.turnstileSiteKey) {
      return config.turnstileSiteKey;
    }
  } catch {
    // Development builds may not have a generated desktop config yet.
  }
  return (
    process.env.OPENFRONT_TURNSTILE_SITE_KEY ??
    process.env.TURNSTILE_SITE_KEY ??
    "1x00000000000000000000AA"
  );
}

const DESKTOP_TURNSTILE_SITE_KEY = getDesktopTurnstileSiteKey();

// ── Environment ────────────────────────────────────────────

function isDev(): boolean {
  return process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL;
}

function getDevServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
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

  const options: http.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: reqHeaders,
  };

  const proxyReq = https.request(apiUrl, options, (proxyRes) => {
    // The renderer talks to the API through this localhost proxy. Cookies
    // returned by api.openfront.io are otherwise rejected by Chromium because
    // their Domain/Secure attributes refer to the remote HTTPS origin.
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

    const findAsset = (urlPath: string): string | null => {
      const clean = urlPath.replace(/^\/+/, "").replace(/\.\./g, "");
      for (const dir of assetDirs) {
        const full = path.join(dir, clean);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
      return null;
    };

    const buildTemplateData = () => ({
      gitCommit: JSON.stringify(appVersion),
      assetManifest: JSON.stringify({}),
      cdnBase: JSON.stringify(""),
      cdnBaseRaw: "",
      gameEnv: JSON.stringify("prod"),
      numWorkers: JSON.stringify(1),
      turnstileSiteKey: JSON.stringify(DESKTOP_TURNSTILE_SITE_KEY),
      jwtAudience: JSON.stringify("openfront.io"),
      instanceId: JSON.stringify("desktop"),
      serverHost: JSON.stringify("openfront.io"),
      manifestHref: "manifest.json",
      faviconHref: "images/Favicon.svg",
      gameplayScreenshotUrl: "images/GameplayScreenshot.png",
      backgroundImageUrl: "images/background.webp",
      desktopLogoImageUrl: "images/OpenFront.png",
      mobileLogoImageUrl: "images/OF.png",
    });

    localServer = http.createServer((req, res) => {
      if (!req.url) { res.writeHead(400); res.end(); return; }

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
          const proxyScript = API_PROXY_SCRIPT.replace("__PORT__", String(serverPort));
          const injected = rendered.replace(
            "</head>",
            "  <script>" + proxyScript + "</script>\n  </head>",
          );

          // Fix CDN base to absolute URL for worker asset resolution
          const finalHtml = injected.replace(
            /cdnBase: ""/,
            `cdnBase: "http://127.0.0.1:${serverPort}"`,
          );

          res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
          res.end(finalHtml);
        } catch (err) {
          console.error("[electron] EJS render failed:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        return;
      }

      // API proxy: forward /__api/* → https://api.openfront.io/*
      if (urlPath.startsWith("/__api/")) {
        const apiPath = urlPath.replace("/__api", "");
        const apiUrl = `https://api.openfront.io${apiPath}`;
        proxyApiRequest(req, res, apiUrl);
        return;
      }

      // OAuth callback: capture the login token from the redirect
      if (urlPath === "/oauth-callback") {
        const token = url.searchParams.get("token") || url.searchParams.get("login-token");
        if (token) {
          oauthCallbackToken = token;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body style='background:#1e1e1e;color:#d4d4d4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
              "<div style='text-align:center'><h2 style='color:#f09040'>Login Successful</h2>" +
              "<p>You can close this tab and return to the OpenFront app.</p></div>" +
              "</body></html>",
          );
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body style='background:#1e1e1e;color:#d4d4d4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
              "<div style='text-align:center'><h2 style='color:#cc4444'>Login Failed</h2>" +
              "<p>No token received. Please try again.</p></div>" +
              "</body></html>",
          );
        }
        return;
      }

      // Generated maps live outside the packaged asset tree. Only expose the
      // five fixed files needed by the map loader, and resolve the folder
      // beneath the user-data maps directory to prevent traversal.
      if (urlPath.startsWith("/__custom-maps/")) {
        const routeParts = urlPath
          .slice("/__custom-maps/".length)
          .split("/");
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
          !["map.bin", "map4x.bin", "map16x.bin", "manifest.json", "thumbnail.webp"].includes(fileName)
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
            "Cache-Control": ext === ".html" ? "no-cache" : "max-age=31536000, immutable",
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
  if (localServer) { localServer.close(); localServer = null; }
  localServerPort = null;
}

// ── IPC handlers ────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle("asset-cache:sync", async () => {
    return assetCache.syncFromCDN(process.env.CDN_BASE ?? "");
  });
  ipcMain.handle("asset-cache:get-local-path", async (_e, p: string) => assetCache.getLocalPath(p));
  ipcMain.handle("asset-cache:is-offline", async () => assetCache.isOfflineMode());
  ipcMain.handle("asset-cache:get-manifest", async () => assetCache.getManifest());

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
  ipcMain.handle("server:status", async () => serverSidecar?.status() ?? { status: "stopped" });

  ipcMain.handle("lan:discover", async () => mdnsDiscovery.browse());
  ipcMain.handle("lan:stop-discovery", async () => mdnsDiscovery.stopBrowsing());
  ipcMain.handle("lan:connect", async (_e, host: string, port: number) => ({ host, port }));

  ipcMain.handle("mapgen:generate", async (_e, opts: any) => mapGenSidecar.generate(opts));
  ipcMain.handle("mapgen:preview", async (_e, opts: any) => mapGenSidecar.preview(opts));
  ipcMain.handle("mapgen:export", async (_e, folder: string) => mapGenSidecar.exportMap(folder));
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

  // ── OAuth login ──
  // Opens the OAuth flow in an Electron BrowserWindow with a redirect to
  // the allowed production URI (https://openfront.io/). The API validates
  // redirect_uri strictly, so localhost URIs are rejected. After auth, the
  // window logs into openfront.io which sets the refresh-token cookie on
  // that domain. We copy the auth cookies into the local app's session so
  // the renderer's proxy-backed refresh flow picks them up.
  ipcMain.handle("app:oauth-login", async (_e, provider: string) => {
    const redirectUri = encodeURIComponent("https://openfront.io/");
    const authUrl = `https://api.openfront.io/auth/login/${provider}?redirect_uri=${redirectUri}`;

    return new Promise<void>((resolve) => {
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

      let completed = false;

      const copyAuthCookiesToLocal = async (): Promise<number> => {
        const localPort =
          localServer?.address() && typeof localServer.address() === "object"
            ? (localServer.address() as any).port
            : 0;
        if (!localPort) return 0;

        // Depending on which endpoint set the refresh cookie, Electron may
        // report it under either the parent or API subdomain. Copy both into
        // the localhost origin used by the renderer's API proxy.
        const cookiesByKey = new Map<string, Electron.Cookie>();
        for (const url of ["https://openfront.io/", "https://api.openfront.io/"]) {
          const cookies = await session.defaultSession.cookies.get({ url });
          for (const cookie of cookies) {
            cookiesByKey.set(`${cookie.name}\u0000${cookie.path}`, cookie);
          }
        }

        let copied = 0;
        for (const cookie of cookiesByKey.values()) {
          await session.defaultSession.cookies.set({
            url: `http://127.0.0.1:${localPort}`,
            name: cookie.name,
            value: cookie.value,
            path: cookie.path || "/",
            httpOnly: cookie.httpOnly,
            secure: false,
            // SameSite=None requires Secure, which is incompatible with the
            // local HTTP origin used by the renderer. Lax is sufficient for
            // the same-origin API proxy and is accepted by Chromium here.
            sameSite: cookie.sameSite === "no_restriction" ? "lax" : cookie.sameSite,
            expirationDate: cookie.expirationDate,
          });
          copied++;
        }
        return copied;
      };

      const finish = async (token?: string): Promise<void> => {
        if (completed) return;
        completed = true;

        try {
          const copied = await copyAuthCookiesToLocal();
          if (token) {
            console.log("[electron] OAuth token captured from URL");
            mainWindow?.webContents.send("oauth:token", token);
          } else if (copied > 0) {
            console.log(`[electron] Copied ${copied} auth cookies to local session`);
            mainWindow?.webContents.send("oauth:token", "REFRESH");
          }
        } catch (err) {
          console.error("[electron] Failed to complete OAuth login:", err);
        } finally {
          // The remote page is only an authentication broker. Once the token
          // or cookies have been handed to the main renderer, close it.
          if (!oauthWin.isDestroyed()) oauthWin.close();
        }
      };

      const handleNavigation = async (url: string) => {
        try {
          const parsed = new URL(url);
          // Capture the login token from the openfront.io redirect if present
          if (
            parsed.hostname === "openfront.io" &&
            (parsed.searchParams.has("login-token") ||
              parsed.searchParams.has("token"))
          ) {
            const token =
              parsed.searchParams.get("login-token") ??
              parsed.searchParams.get("token");
            if (token && !completed) {
              await finish(token);
            }
          }
        } catch {
          // Ignore malformed URLs
        }
      };

      // Intercept both navigation and redirects
      oauthWin.webContents.on("will-navigate", (_e, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("will-redirect", (_e, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("did-navigate", (_e, url) => {
        void handleNavigation(url);
      });
      oauthWin.webContents.on("did-navigate-in-page", (_e, url) => {
        void handleNavigation(url);
      });

      // When the OAuth window finishes loading the openfront.io homepage
      // (logged in), copy the auth cookies to the local app session.
      oauthWin.webContents.on("did-finish-load", async () => {
        const url = oauthWin.webContents.getURL();
        await handleNavigation(url);

        const parsed = new URL(url);
        if (parsed.hostname === "openfront.io" && !completed) {
          // Copy cookies from the authenticated remote session to our local
          // origin so the renderer's refresh flow can use them. Only finish
          // when a cookie was actually found; a failed provider redirect may
          // still land on the public homepage.
          try {
            const copied = await copyAuthCookiesToLocal();
            if (copied > 0) await finish();
          } catch (err) {
            console.error("[electron] Failed to copy auth cookies:", err);
          }
        }
      });

      oauthWin.on("closed", () => {
        resolve();
      });

      oauthWin.loadURL(authUrl);
    });
  });
}

function registerProtocols(): void {
  protocol.registerFileProtocol("local-asset", (request, callback) => {
    const filePath = request.url.replace("local-asset://", "");
    try { callback({ path: filePath }); } catch { callback({ statusCode: 404 }); }
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
  var apiHost = "api.openfront.io";
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
  assetCache = new AssetCache(path.join(app.getPath("userData"), "cache", "assets"));
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
    assetCache.syncFromCDN(process.env.CDN_BASE ?? "", (progress) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send("asset-sync:progress", progress);
    }).catch((err: Error) => {
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
