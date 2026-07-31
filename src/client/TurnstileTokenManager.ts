import { ClientEnv } from "src/client/ClientEnv";
import { isDesktopShell } from "src/client/DesktopShell";
import { GameEnv } from "../core/configuration/Config";

// Manages Turnstile token lifecycle to prevent duplicate widget creation and
// Cloudflare 429 rate limits. A fresh single-use token is kept on hand:
// desktop sessions prefetch a token after an authenticated account is
// restored, and the token is refilled in the background after it is consumed
// or just before it expires, so a lobby join can take a ready token without
// blocking on a verification challenge. Only one widget is ever active.

// Cloudflare tokens are valid for five minutes and are single-use. Keep a
// small safety margin so a token cannot sit in the lobby flow until it is
// close to expiry. Tokens are never written to storage.
const TOKEN_TTL_MS = 4 * 60 * 1000;
const TOKEN_GENERATION_TIMEOUT_MS = 60 * 1000;
const TURNSTILE_SCRIPT_TIMEOUT_MS = 15 * 1000;
const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
// Regenerate the cached token this long before it would expire, keeping a
// join-ready token available while the player is in the menu.
const TOKEN_REFRESH_LEAD_MS = 60 * 1000;
// Backoff before retrying a failed background generation.
const TOKEN_RETRY_DELAY_MS = 5 * 1000;

export class TurnstileTokenManager {
  private currentToken: { token: string; createdAt: number } | null = null;
  private pendingPromise: Promise<{ token: string; createdAt: number }> | null =
    null;
  private prefetchPromise: Promise<void> | null = null;
  private activeWidgetId: string | number | null = null;
  private activeReject: ((reason?: unknown) => void) | null = null;
  private consumptionQueue: Promise<void> = Promise.resolve();
  private generationCancelled = false;
  private lastError: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async takeToken(): Promise<string | null> {
    const previous = this.consumptionQueue;
    let release!: () => void;
    this.consumptionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.lastError = null;
      const result = await this.ensureToken(true);

      // A Turnstile token may only be submitted once. Clear it before
      // returning so a second join cannot accidentally replay it, then
      // refill immediately so the next join stays instant.
      if (this.currentToken?.token === result.token) {
        this.currentToken = null;
        this.clearRefreshTimer();
        this.scheduleRefill();
      }
      this.setVerificationVisible(false);
      return result.token;
    } catch (err) {
      console.error("[Turnstile] Token generation failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("cancelled")) {
        this.lastError = message;
        // Failed (e.g. transient network blip); retry in the background so a
        // valid token is ready by the time the player joins again.
        this.scheduleRefill(TOKEN_RETRY_DELAY_MS);
      }
      this.setVerificationVisible(false);
      return null;
    } finally {
      release();
    }
  }

  cancel(): void {
    this.generationCancelled = true;
    this.activeReject?.(new Error("Turnstile verification cancelled"));
    this.activeReject = null;
    this.removeActiveWidget();
    this.setVerificationVisible(false);
  }

  /**
   * Start desktop verification as soon as a linked account is restored.
   * Failures stay silent here; the join path reports them if a token is still
   * unavailable when the player actually joins.
   */
  async prefetch(): Promise<void> {
    if (
      !isDesktopShell() ||
      ClientEnv.env() === GameEnv.Dev ||
      !window.electronAPI?.getTurnstileToken
    ) {
      return;
    }
    if (this.prefetchPromise) return this.prefetchPromise;

    this.prefetchPromise = this.ensureToken(false)
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn(
          "[Turnstile] Background verification was not completed:",
          error,
        );
      })
      .finally(() => {
        this.prefetchPromise = null;
      });
    return this.prefetchPromise;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Triggers a background token generation after `delayMs` unless one is
  // already scheduled. Keeping the pipeline full means a lobby join can take
  // a ready token without blocking on a verification challenge.
  private scheduleRefill(delayMs = 0): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.ensureToken(false).catch((error: unknown) => {
        console.warn("[Turnstile] Background refill failed:", error);
        this.scheduleRefill(TOKEN_RETRY_DELAY_MS);
      });
    }, delayMs);
  }

  private async ensureToken(
    showWebVerification: boolean,
  ): Promise<{ token: string; createdAt: number }> {
    if (this.currentToken) {
      const remaining = this.currentToken.createdAt + TOKEN_TTL_MS - Date.now();
      if (remaining > TOKEN_REFRESH_LEAD_MS) {
        // A valid token is on hand; refresh it in the background before it
        // expires so joins keep finding a ready token.
        this.scheduleRefill(remaining - TOKEN_REFRESH_LEAD_MS);
        return this.currentToken;
      }
      // Too close to expiry to hand out; regenerate now.
      this.currentToken = null;
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    this.generationCancelled = false;
    const pending = this.generateToken(showWebVerification);
    this.pendingPromise = pending;
    try {
      const result = await pending;
      this.currentToken = result;
      // Keep the pipeline full: refresh before this token expires.
      this.scheduleRefill(TOKEN_TTL_MS - TOKEN_REFRESH_LEAD_MS);
      return result;
    } finally {
      if (this.pendingPromise === pending) {
        this.pendingPromise = null;
      }
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private async generateToken(
    showWebVerification: boolean,
  ): Promise<{ token: string; createdAt: number }> {
    // On the desktop shell, the Turnstile widget must render on the
    // openfront.io domain (the site key is only authorised there). The main
    // process runs the widget in an embedded verification view and keeps that
    // view hidden unless Cloudflare requires interaction.
    const desktopApi = (window as any).electronAPI;
    if (desktopApi?.getTurnstileToken) {
      const result = await desktopApi.getTurnstileToken();
      if (!result?.token) {
        throw new Error(
          result?.error ?? "Security verification was not completed.",
        );
      }
      return { token: result.token, createdAt: Date.now() };
    }

    const siteKey = ClientEnv.turnstileSiteKey().trim();
    if (!siteKey) {
      throw new Error(
        "Desktop security verification is not configured. Build with OPENFRONT_TURNSTILE_SITE_KEY.",
      );
    }
    if (
      ClientEnv.env() === GameEnv.Prod &&
      siteKey === TEST_TURNSTILE_SITE_KEY
    ) {
      throw new Error(
        "Production security verification is not configured. This build still uses the Turnstile test key.",
      );
    }

    if (showWebVerification) {
      this.setVerificationVisible(true, "Loading the security verification...");
    }
    await this.waitForTurnstile();
    if (this.generationCancelled) {
      throw new Error("Turnstile verification cancelled");
    }
    if (showWebVerification) {
      this.setVerificationVisible(
        true,
        "Complete the security check to join the game.",
      );
    }
    const container = document.getElementById("turnstile-container");
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let widgetId: string | number | null = null;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.activeReject = null;
        this.removeActiveWidget(widgetId);
        callback();
      };
      const timeout = window.setTimeout(() => {
        finish(() => reject(new Error("Turnstile verification timed out")));
      }, TOKEN_GENERATION_TIMEOUT_MS);
      this.activeReject = (reason?: unknown) =>
        finish(() =>
          reject(reason ?? new Error("Turnstile verification cancelled")),
        );
      try {
        // Turnstile's callbacks belong to render(). Passing them to
        // execute() is ignored by the API. Render mode starts the widget now,
        // which is exactly when the user has requested an online join.
        widgetId = window.turnstile.render("#turnstile-container", {
          sitekey: siteKey,
          size: "normal",
          appearance: "always",
          theme: "dark",
          retry: "auto",
          "refresh-expired": "auto",
          execution: "render",
          callback: (token: string) => {
            if (typeof token !== "string" || token.length === 0) {
              finish(() =>
                reject(new Error("Turnstile returned an empty token")),
              );
              return;
            }
            finish(() => {
              console.log("[Turnstile] Token received");
              resolve({ token, createdAt: Date.now() });
            });
          },
          "error-callback": (errorCode: string) => {
            finish(() => {
              console.error(`[Turnstile] Error: ${errorCode}`);
              reject(new Error(`Turnstile failed: ${errorCode}`));
            });
          },
          "expired-callback": () => {
            finish(() => reject(new Error("Turnstile verification expired")));
          },
        });
        this.activeWidgetId = widgetId;
        // A synchronous callback is not expected, but test keys and future
        // Turnstile changes should not leave a widget behind in that case.
        if (settled) this.removeActiveWidget(widgetId);
      } catch (error) {
        finish(() =>
          reject(
            new Error(
              `Turnstile execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          ),
        );
      }
    });
  }

  private async waitForTurnstile(): Promise<void> {
    const deadline = Date.now() + TURNSTILE_SCRIPT_TIMEOUT_MS;
    while (typeof window.turnstile === "undefined") {
      if (this.generationCancelled) {
        throw new Error("Turnstile verification cancelled");
      }
      if (window.turnstileScriptError) {
        throw new Error(
          "Cloudflare security verification could not load. Check network access to challenges.cloudflare.com.",
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          window.turnstileScriptLoaded
            ? "Cloudflare security verification loaded without exposing its widget API."
            : "Cloudflare security verification did not load. Check network access to challenges.cloudflare.com.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Do not call turnstile.ready() here. Turnstile rejects ready() when its
    // script is loaded with async/defer; the script onload flag plus the
    // presence of the global API are sufficient before render().
  }

  private removeActiveWidget(
    widgetId: string | number | null = this.activeWidgetId,
  ): void {
    if (widgetId === this.activeWidgetId) this.activeWidgetId = null;
    if (widgetId !== null && typeof window.turnstile?.remove === "function") {
      try {
        window.turnstile.remove(widgetId);
      } catch (error) {
        console.warn("[Turnstile] Failed to remove widget:", error);
      }
    }
    const container = document.getElementById("turnstile-container");
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }
  }

  private setVerificationVisible(
    visible: boolean,
    message = "Verifying your connection...",
  ): void {
    const panel = document.getElementById("turnstile-verification");
    const status = document.getElementById("turnstile-verification-status");
    const cancel = document.getElementById("turnstile-verification-cancel");
    if (!panel || !status || !cancel) return;

    status.textContent = message;
    panel.classList.toggle("hidden", !visible);
    panel.classList.toggle("flex", visible);
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    cancel.onclick = visible ? () => this.cancel() : null;
  }
}
