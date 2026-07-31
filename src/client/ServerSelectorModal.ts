/**
 * Server selector modal for the desktop application.
 *
 * Lets the player choose which game server to connect to:
 * - Staging (main.openfront.dev) — default, no Cloudflare blocking
 * - Production (openfront.io) — normal & ranked games
 * - Custom URL — self-hosted or dedicated servers
 *
 * The selection is persisted through electronAPI.serverConfig IPC to a
 * JSON file in the app's userData directory, so it survives restarts.
 */

import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

// ── Types ──────────────────────────────────────────────────

interface ServerProfile {
  host: string;
  audience: string;
  env: string;
  workers: number;
}

interface ServerConfigResponse {
  current: ServerProfile;
  presets: Record<string, ServerProfile>;
}

// ── Text helper ────────────────────────────────────────────

function text(key: string, fallback: string): string {
  const translated = translateText(key);
  return translated === key ? fallback : translated;
}

function presetLabel(id: string, fallback: string): string {
  switch (id) {
    case "production":
      return text("server_selector.production", fallback);
    case "staging":
      return text("server_selector.staging", fallback);
    default:
      return fallback;
  }
}

// ── Element ────────────────────────────────────────────────

@customElement("server-selector-modal")
export class ServerSelectorModal extends LitElement {
  @state() private visible = false;
  @state() private presets: Record<string, ServerProfile> = {};
  @state() private currentHost = "";
  @state() private selectedHost = "";
  @state() private customHost = "";
  @state() private switching = false;
  @state() private errorMessage: string | null = null;

  // ── Event handlers ───────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("show-server-selector", this._onShow);
    this.addEventListener("close-server-selector", this._onClose);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("show-server-selector", this._onShow);
    this.removeEventListener("close-server-selector", this._onClose);
  }

  private _onShow = async (): Promise<void> => {
    const api = (window as any).electronAPI;
    if (!api?.serverConfig?.get) {
      this.errorMessage = "Server selection requires the desktop application.";
      this.visible = true;
      return;
    }
    this.errorMessage = null;
    try {
      const config: ServerConfigResponse = await api.serverConfig.get();
      this.presets = config.presets;
      this.currentHost = config.current.host;
      this.selectedHost = config.current.host;
      this.customHost = "";
    } catch {
      this.errorMessage = "Unable to read server configuration.";
    }
    this.visible = true;
  };

  private _onClose = (): void => {
    this.visible = false;
    this.switching = false;
  };

  private async _onConnect(): Promise<void> {
    const api = (window as any).electronAPI;
    if (!api?.serverConfig?.set) return;

    const targetHost =
      this.selectedHost === "custom"
        ? this.customHost.trim()
        : this.selectedHost;
    if (!targetHost) return;

    this.switching = true;
    this.errorMessage = null;

    try {
      const result = await api.serverConfig.set(targetHost);
      if (result.success) {
        // Reload the renderer so the bootstrap config picks up the new
        // server host and environment.
        setTimeout(() => window.location.reload(), 300);
      } else {
        this.errorMessage = "Server switch failed. Please try again.";
        this.switching = false;
      }
    } catch (err) {
      this.errorMessage =
        err instanceof Error ? err.message : "Connection error";
      this.switching = false;
    }
  }

  private _selectPreset(host: string): void {
    this.selectedHost = host;
    this.errorMessage = null;
  }

  private _onCustomInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.customHost = input.value;
    if (this.selectedHost === "custom") {
      this.selectedHost = input.value ? "custom" : this.currentHost;
    }
  }

  // ── Render ────────────────────────────────────────────────

  protected createRenderRoot(): this {
    return this;
  }

  render(): unknown {
    if (!this.visible) return null;

    const presetEntries = Object.entries(this.presets);
    const isCurrentSelected =
      this.selectedHost === this.currentHost && !this.customHost;
    const canConnect =
      !this.switching &&
      (this.selectedHost !== "custom"
        ? this.selectedHost.length > 0
        : this.customHost.trim().length > 0);

    return html`
      <div class="fixed inset-0 z-[9998] flex items-center justify-center">
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/70 backdrop-blur-sm"
          @click=${this._onClose}
        ></div>
        <!-- Modal -->
        <div
          class="relative z-[9999] w-full max-w-lg rounded-xl border border-white/10 bg-[#1e1e1e] p-6 shadow-2xl"
        >
          <h2 class="mb-4 text-lg font-semibold text-white">
            ${text("server_selector.title", "Select Game Server")}
          </h2>

          <p class="mb-4 text-sm text-white/60">
            ${text(
              "server_selector.description",
              "Choose which server to connect to for multiplayer games.",
            )}
          </p>

          <!-- Server list -->
          <div
            class="mb-3 space-y-2"
            @click=${(e: Event) => {
              e.stopPropagation();
            }}
          >
            ${presetEntries.map(([id, profile]) => {
              const isSelected = this.selectedHost === profile.host;
              const isCurrent = profile.host === this.currentHost;
              return html`
                <button
                  class="w-full rounded-lg border px-4 py-3 text-left transition-colors ${isSelected
                    ? "border-malibu-blue bg-malibu-blue/10"
                    : "border-white/10 hover:border-white/30"}"
                  @click=${() => this._selectPreset(profile.host)}
                >
                  <div class="flex items-center justify-between">
                    <div>
                      <span class="text-sm font-medium text-white"
                        >${presetLabel(id, profile.host)}</span
                      >
                      <span
                        class="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/50"
                        >${profile.env}</span
                      >
                    </div>
                    ${isCurrent
                      ? html`<span class="text-xs text-malibu-blue"
                          >${text("server_selector.current", "current")}</span
                        >`
                      : null}
                  </div>
                </button>
              `;
            })}
          </div>

          <!-- Custom server -->
          <div class="mb-4">
            <button
              class="w-full rounded-lg border px-4 py-3 text-left transition-colors ${this
                .selectedHost === "custom"
                ? "border-malibu-blue bg-malibu-blue/10"
                : "border-white/10 hover:border-white/30"}"
              @click=${() => this._selectPreset("custom")}
            >
              <span class="text-sm font-medium text-white"
                >${text("server_selector.custom", "Custom Server...")}</span
              >
            </button>
            ${this.selectedHost === "custom"
              ? html`
                  <input
                    class="mt-2 w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-malibu-blue focus:ring-1 focus:ring-malibu-blue/40"
                    type="text"
                    placeholder="your-server.com"
                    .value=${this.customHost}
                    @input=${this._onCustomInput}
                  />
                `
              : null}
          </div>

          <!-- Error message -->
          ${this.errorMessage
            ? html`<p class="mb-3 text-sm text-red-400">
                ${this.errorMessage}
              </p>`
            : null}

          <!-- Actions -->
          <div class="flex items-center justify-end gap-3">
            <button
              class="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/60 transition-colors hover:bg-white/5"
              @click=${this._onClose}
            >
              ${text("server_selector.cancel", "Cancel")}
            </button>
            <button
              class="rounded-lg bg-malibu-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-malibu-blue/80 disabled:opacity-50"
              ?disabled=${!canConnect}
              @click=${this._onConnect}
            >
              ${this.switching
                ? text("server_selector.connecting", "Connecting...")
                : isCurrentSelected
                  ? text("server_selector.reconnect", "Reconnect")
                  : text("server_selector.connect", "Connect")}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
