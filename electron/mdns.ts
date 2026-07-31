/**
 * LAN discovery via mDNS (multicast DNS).
 *
 * Advertises the local game server so other OpenFront Desktop instances
 * on the LAN can discover it, and browses for other servers.
 *
 * Uses the `multicast-dns` npm package (pure JavaScript, no native deps).
 *
 * Service type: _openfront._tcp.local
 * TXT record carries: playerCount, maxPlayers, map, version
 */

import mdns from "multicast-dns";
import type { Answer, Packet as DNSPacket } from "dns-packet";

export interface LanGame {
  name: string;
  host: string;
  port: number;
  playerCount: number;
  maxPlayers: number;
  map: string;
}

const SERVICE_TYPE = "_openfront._tcp.local";
const MDNS_INTERVAL_MS = 5000; // re-broadcast every 5s

type BrowseCallback = (games: LanGame[]) => void;

export class MDNSDiscovery {
  private mdnsServer: ReturnType<typeof mdns> | null = null;
  private advertiseTimer: ReturnType<typeof setInterval> | null = null;
  private browseTimer: ReturnType<typeof setInterval> | null = null;
  private discoveredGames: Map<string, LanGame> = new Map();
  private browseCallback: BrowseCallback | null = null;
  private advertising = false;
  private browsing = false;

  private getMdns(): ReturnType<typeof mdns> {
    if (!this.mdnsServer) {
      this.mdnsServer = mdns();
    }
    return this.mdnsServer;
  }

  // ── Advertise ─────────────────────────────────

  async advertise(info: {
    name: string;
    port: number;
    playerCount?: number;
    maxPlayers?: number;
    map?: string;
  }): Promise<void> {
    if (this.advertising) {
      await this.stopAdvertising();
    }

    this.advertising = true;
    const m = this.getMdns();

    const doAdvertise = () => {
      const txt: Record<string, string> = {
        playerCount: String(info.playerCount ?? 0),
        maxPlayers: String(info.maxPlayers ?? 8),
        map: info.map ?? "World",
      };

      m.respond({
        answers: [
          {
            name: SERVICE_TYPE,
            type: "PTR",
            class: "IN" as const,
            ttl: 120,
            data: `${info.name}.${SERVICE_TYPE}`,
          },
          {
            name: `${info.name}.${SERVICE_TYPE}`,
            type: "SRV",
            class: "IN" as const,
            ttl: 120,
            data: {
              priority: 0,
              weight: 0,
              port: info.port,
              target: info.name + ".local",
            },
          },
          {
            name: `${info.name}.${SERVICE_TYPE}`,
            type: "TXT",
            class: "IN" as const,
            ttl: 120,
            data: Object.entries(txt)
              .map(([k, v]) => `${k}=${v}`)
              .join("\0"),
          },
        ],
      });
    };

    // Initial broadcast
    doAdvertise();

    // Re-broadcast periodically so new listeners can discover
    this.advertiseTimer = setInterval(doAdvertise, MDNS_INTERVAL_MS);
  }

  async stopAdvertising(): Promise<void> {
    this.advertising = false;
    if (this.advertiseTimer) {
      clearInterval(this.advertiseTimer);
      this.advertiseTimer = null;
    }
    // Send goodbye packet
    if (this.mdnsServer && this.advertising) {
      this.mdnsServer.respond({
        answers: [
          {
            name: SERVICE_TYPE,
            type: "PTR",
            class: "IN" as const,
            ttl: 0, // TTL 0 = goodbye
            data: `_.${SERVICE_TYPE}`,
          },
        ],
      });
    }
  }

  // ── Browse ────────────────────────────────────

  browse(callback?: BrowseCallback): Promise<LanGame[]> {
    if (callback) {
      this.browseCallback = callback;
    }

    return new Promise((resolve) => {
      if (this.browsing) {
        // Already browsing — return current results
        resolve(Array.from(this.discoveredGames.values()));
        return;
      }

      this.browsing = true;
      const m = this.getMdns();

      m.on("response", (response: DNSPacket) => {
        this.handleResponse(response);
        if (this.browseCallback) {
          this.browseCallback(
            Array.from(this.discoveredGames.values()),
          );
        }
      });

      // Send initial query
      m.query({
        questions: [
          {
            name: SERVICE_TYPE,
            type: "PTR",
          },
        ],
      });

      // Re-query periodically to discover new servers
      this.browseTimer = setInterval(() => {
        m.query({
          questions: [
            {
              name: SERVICE_TYPE,
              type: "PTR",
            },
          ],
        });
      }, MDNS_INTERVAL_MS);

      // Return initial results after a 2s scan period
      setTimeout(() => {
        resolve(Array.from(this.discoveredGames.values()));
      }, 2000);
    });
  }

  async stopBrowsing(): Promise<void> {
    this.browsing = false;
    this.browseCallback = null;
    if (this.browseTimer) {
      clearInterval(this.browseTimer);
      this.browseTimer = null;
    }
    this.discoveredGames.clear();
  }

  // ── Response parsing ──────────────────────────

  private handleResponse(response: DNSPacket): void {
    const services = new Map<
      string,
      { host?: string; port?: number; txt?: Record<string, string> }
    >();

    for (const answer of response.answers ?? []) {
      if (
        answer.type === "SRV" &&
        typeof answer.data === "object" &&
        answer.data !== null
      ) {
        const srvData = answer.data as {
          target?: string;
          port?: number;
        };
        const name = answer.name.replace(/\.$/, "");
        const entry = services.get(name) ?? {};
        entry.host = srvData.target?.replace(/\.$/, "");
        entry.port = srvData.port;
        services.set(name, entry);
      }

      if (answer.type === "TXT") {
        const name = answer.name.replace(/\.$/, "");
        const entry = services.get(name) ?? {};
        // TXT data is a Buffer or array of Buffer
        const rawTxt = answer.data as Buffer | Buffer[] | string;
        let txtStr = "";
        if (Array.isArray(rawTxt)) {
          txtStr = Buffer.concat(rawTxt).toString();
        } else if (Buffer.isBuffer(rawTxt)) {
          txtStr = rawTxt.toString();
        } else if (typeof rawTxt === "string") {
          txtStr = rawTxt;
        }
        entry.txt = this.parseTxt(txtStr);
        services.set(name, entry);
      }
    }

    // Build LanGame entries
    for (const [name, info] of services) {
      if (info.host && info.port) {
        const displayName = name.replace(
          `._openfront._tcp.local`,
          "",
        );
        this.discoveredGames.set(name, {
          name: displayName || info.host,
          host: info.host,
          port: info.port,
          playerCount: parseInt(
            info.txt?.["playerCount"] ?? "0",
            10,
          ),
          maxPlayers: parseInt(
            info.txt?.["maxPlayers"] ?? "8",
            10,
          ),
          map: info.txt?.["map"] ?? "Unknown",
        });
      }
    }
  }

  private parseTxt(txt: string): Record<string, string> {
    const result: Record<string, string> = {};
    const pairs = txt.split("\0").filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        result[pair.substring(0, eq)] = pair.substring(eq + 1);
      }
    }
    return result;
  }

  // ── Cleanup ───────────────────────────────────

  destroy(): void {
    this.stopAdvertising();
    this.stopBrowsing();
    if (this.mdnsServer) {
      this.mdnsServer.destroy();
      this.mdnsServer = null;
    }
  }
}
