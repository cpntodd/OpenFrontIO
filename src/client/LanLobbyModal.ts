/**
 * Embedded LAN Games page.
 *
 * Uses mDNS discovery to find OpenFront Desktop instances hosting games on
 * the local network. The element keeps its historical tag name for bootstrap
 * compatibility, but deliberately does not render a modal overlay.
 */

import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

interface LanGame {
  name: string;
  host: string;
  port: number;
  playerCount: number;
  maxPlayers: number;
  map: string;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-malibu-blue focus:ring-1 focus:ring-malibu-blue/40";

function text(key: string, fallback: string): string {
  const translated = translateText(key);
  return translated === key ? fallback : translated;
}

@customElement("lan-lobby-modal")
export class LanLobbyModal extends LitElement {
  @state() private games: LanGame[] = [];
  @state() private browsing = false;
  @state() private manualHost = "";
  @state() private manualPort = "9000";
  @state() private connecting: string | null = null;
  @state() private errorMessage: string | null = null;

  private pollInterval: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this.handlePageChange);
    if (window.currentPageId === "page-lan") void this.startBrowsing();
  }

  disconnectedCallback() {
    window.removeEventListener("showPage", this.handlePageChange);
    this.stopBrowsing();
    super.disconnectedCallback();
  }

  private isElectron(): boolean {
    return typeof window !== "undefined" && window.electronAPI !== undefined;
  }

  private handlePageChange = (event: Event): void => {
    const pageId = (event as CustomEvent).detail;
    if (pageId === "page-lan") {
      void this.startBrowsing();
    } else {
      this.stopBrowsing();
    }
  };

  private async startBrowsing(): Promise<void> {
    if (!this.isElectron() || this.browsing) return;

    this.browsing = true;
    this.errorMessage = null;
    await this.refreshGames();

    if (!this.browsing || this.pollInterval !== null) return;
    this.pollInterval = window.setInterval(() => {
      void this.refreshGames();
    }, 5000);
  }

  private stopBrowsing(): void {
    if (this.pollInterval !== null) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.browsing = false;
  }

  private async refreshGames(): Promise<void> {
    if (!this.isElectron()) return;

    try {
      this.games = await window.electronAPI!.lan.discover();
      this.errorMessage = null;
    } catch (err) {
      this.errorMessage =
        err instanceof Error ? err.message : "Could not scan the local network.";
      console.error("[lan] Discovery error:", err);
    }
  }

  private async handleConnect(game: LanGame): Promise<void> {
    if (!this.isElectron()) return;
    this.connecting = game.name;
    this.errorMessage = null;

    try {
      await window.electronAPI!.lan.connect(game.host, game.port);
      window.dispatchEvent(
        new CustomEvent("lan-join", {
          detail: { host: game.host, port: game.port },
        }),
      );
    } catch (err) {
      this.errorMessage =
        err instanceof Error ? err.message : "Connection failed";
    } finally {
      this.connecting = null;
    }
  }

  private async handleManualConnect(): Promise<void> {
    const host = this.manualHost.trim();
    if (!host) {
      this.errorMessage = "Enter the host address first.";
      return;
    }
    if (!this.isElectron()) {
      this.errorMessage = "LAN discovery is only available in the desktop application.";
      return;
    }

    const port = parseInt(this.manualPort, 10) || 9000;
    this.connecting = `${host}:${port}`;
    this.errorMessage = null;

    try {
      await window.electronAPI!.lan.connect(host, port);
      window.dispatchEvent(
        new CustomEvent("lan-join", { detail: { host, port } }),
      );
    } catch (err) {
      this.errorMessage =
        err instanceof Error ? err.message : "Connection failed";
    } finally {
      this.connecting = null;
    }
  }

  private goBack(): void {
    window.showPage?.("page-play");
  }

  render() {
    return html`
      <div class="flex min-h-full w-full flex-col gap-6 px-2 pb-8 lg:px-4">
        <header class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
          <div class="flex items-start gap-3">
            <div class="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-malibu-blue/40 bg-malibu-blue/15 text-malibu-blue shadow-[var(--shadow-malibu-blue-soft)]">
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h4m6 0h4M7.5 8.5h.01M16.5 15.5h.01M12 5v4m0 6v4" />
                <circle cx="12" cy="12" r="8.5" />
              </svg>
            </div>
            <div>
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <span class="text-[10px] font-bold uppercase tracking-[0.22em] text-malibu-blue">Local network</span>
                <span class="h-1 w-1 rounded-full bg-white/30"></span>
                <span class="text-[10px] uppercase tracking-[0.18em] text-white/40">Desktop only</span>
              </div>
              <h1 class="text-2xl font-bold uppercase tracking-[0.12em] text-white lg:text-3xl">
                ${text("lan_lobby.title", "LAN Games")}
              </h1>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-white/55">
                Find OpenFront games hosted on your local network or connect directly to a desktop host.
              </p>
            </div>
          </div>
          <button
            class="nav-menu-item inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
            data-page="page-play"
            @click=${this.goBack}
          >
            <span aria-hidden="true">←</span>
            Back to play
          </button>
        </header>

        ${!this.isElectron()
          ? html`
              <div class="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
                <span class="mt-0.5 text-amber-300" aria-hidden="true">!</span>
                <p>LAN games are available in the OpenFront Desktop application.</p>
              </div>
            `
          : ""}

        ${this.errorMessage
          ? html`
              <div class="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">
                <span class="mt-0.5" aria-hidden="true">!</span>
                <p>${this.errorMessage}</p>
              </div>
            `
          : ""}

        <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <section class="min-w-0 rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
            <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div class="flex items-center gap-2">
                  <span class="h-2 w-2 rounded-full ${this.browsing ? "animate-pulse bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" : "bg-white/30"}"></span>
                  <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">${text("lan_lobby.discovered", "Discovered games")}</h2>
                </div>
                <p class="mt-1 text-xs text-white/45">${this.browsing ? "Scanning for hosts on your local network." : "Network scan paused."}</p>
              </div>
              <button
                class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white/65 transition-colors hover:border-malibu-blue/50 hover:bg-malibu-blue/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                @click=${() => this.refreshGames()}
                ?disabled=${!this.isElectron()}
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M20 11a8.1 8.1 0 0 0-14.9-4M4 5v4h4M4 13a8.1 8.1 0 0 0 14.9 4M20 19v-4h-4" />
                </svg>
                Scan again
              </button>
            </div>

            ${this.games.length === 0
              ? html`
                  <div class="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/15 px-6 text-center">
                    <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/35">
                      <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 12.5a7 7 0 0 1 14 0M8.5 12.5a3.5 3.5 0 0 1 7 0M12 16.5h.01" />
                      </svg>
                    </div>
                    <p class="text-sm font-medium text-white/70">${this.browsing ? text("lan_lobby.searching", "Searching for games on your local network…") : text("lan_lobby.no_games", "No games found on the LAN.")}</p>
                    <p class="mt-2 max-w-sm text-xs leading-5 text-white/35">Start a desktop host on the same network, or use the direct connection form.</p>
                  </div>
                `
              : html`
                  <div class="grid gap-3">
                    ${this.games.map(
                      (game) => html`
                        <article class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/20 p-4 transition-colors hover:border-malibu-blue/50 hover:bg-malibu-blue/5">
                          <div class="flex min-w-0 items-center gap-3">
                            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-malibu-blue/30 bg-malibu-blue/10 text-malibu-blue" aria-hidden="true">
                              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="m4 8.5 8 4.5 8-4.5M12 13v7" />
                              </svg>
                            </div>
                            <div class="min-w-0">
                              <h3 class="truncate text-sm font-bold text-white">${game.name}</h3>
                              <p class="mt-1 truncate text-xs text-white/45">${game.map} <span class="px-1 text-white/20">•</span> ${game.host}:${game.port}</p>
                              <p class="mt-1 text-[11px] uppercase tracking-wider text-white/30">${game.playerCount}/${game.maxPlayers} players</p>
                            </div>
                          </div>
                          <button
                            class="rounded-lg bg-frame-orange px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[0_0_12px_rgba(249,115,22,0.2)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                            @click=${() => this.handleConnect(game)}
                            ?disabled=${this.connecting !== null}
                          >
                            ${this.connecting === game.name ? "Connecting…" : text("lan_lobby.join", "Join game")}
                          </button>
                        </article>
                      `,
                    )}
                  </div>
                `}
          </section>

          <aside class="flex flex-col gap-5">
            <section class="rounded-2xl border border-white/10 bg-surface/70 p-5">
              <div class="mb-4 flex items-center gap-2">
                <span class="h-2 w-2 rounded-full bg-malibu-blue shadow-[0_0_10px_rgba(0,132,209,0.8)]"></span>
                <h2 class="text-xs font-bold uppercase tracking-[0.16em] text-white">${text("lan_lobby.manual", "Direct connection")}</h2>
              </div>
              <p class="mb-4 text-xs leading-5 text-white/45">Know the host address? Connect without waiting for discovery.</p>
              <div class="space-y-3">
                <label class="block">
                  <span class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-white/55">Host address</span>
                  <input
                    type="text"
                    .value=${this.manualHost}
                    @input=${(e: InputEvent) => (this.manualHost = (e.target as HTMLInputElement).value)}
                    placeholder="192.168.1.100"
                    class=${INPUT_CLASS}
                  />
                </label>
                <label class="block">
                  <span class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-white/55">Port</span>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    .value=${this.manualPort}
                    @input=${(e: InputEvent) => (this.manualPort = (e.target as HTMLInputElement).value)}
                    placeholder="9000"
                    class=${INPUT_CLASS}
                  />
                </label>
                <button
                  class="w-full rounded-lg bg-frame-orange px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-[0_0_12px_rgba(249,115,22,0.2)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  @click=${this.handleManualConnect}
                  ?disabled=${this.connecting !== null || !this.isElectron()}
                >
                  ${text("lan_lobby.connect", "Connect to host")}
                </button>
              </div>
            </section>

            <section class="rounded-2xl border border-white/10 bg-black/20 p-5">
              <h2 class="text-xs font-bold uppercase tracking-[0.16em] text-white">LAN checklist</h2>
              <ul class="mt-4 space-y-3 text-xs leading-5 text-white/45">
                <li class="flex gap-2"><span class="text-malibu-blue">•</span><span>Both players should be on the same local network.</span></li>
                <li class="flex gap-2"><span class="text-malibu-blue">•</span><span>The host must allow OpenFront through the firewall.</span></li>
                <li class="flex gap-2"><span class="text-malibu-blue">•</span><span>Use the host’s LAN address for direct connection.</span></li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    `;
  }
}
