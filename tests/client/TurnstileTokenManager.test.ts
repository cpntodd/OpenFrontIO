import { ClientEnv } from "src/client/ClientEnv";
import { TurnstileTokenManager } from "src/client/TurnstileTokenManager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captures the Turnstile widget callbacks from the mocked window.turnstile so
// tests can complete or fail the in-flight challenge deterministically. The
// desktop manager passes callbacks to render() (execution: "render"), unlike
// the older execute() flow.
let resolveToken: ((token: string) => void) | null = null;
let rejectToken: ((code: string) => void) | null = null;
let renderCount = 0;

function stubTurnstile(): void {
  resolveToken = null;
  rejectToken = null;
  renderCount = 0;
  vi.stubGlobal("turnstile", {
    render: vi.fn(
      (
        _selector: string,
        opts: {
          callback: (token: string) => void;
          "error-callback": (code: string) => void;
        },
      ) => {
        renderCount++;
        resolveToken = opts.callback;
        rejectToken = opts["error-callback"];
        return `widget-${renderCount}`;
      },
    ),
    remove: vi.fn(),
  });
}

// Flush pending promise microtasks (not faked by fake timers).
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// Resolves the currently in-flight Turnstile challenge with a token.
function completeChallenge(token: string): void {
  expect(
    resolveToken,
    "expected an in-flight Turnstile challenge",
  ).not.toBeNull();
  const cb = resolveToken!;
  resolveToken = null;
  cb(token);
}

// Fails the currently in-flight Turnstile challenge.
function failChallenge(code: string): void {
  expect(
    rejectToken,
    "expected an in-flight Turnstile challenge",
  ).not.toBeNull();
  const cb = rejectToken!;
  rejectToken = null;
  cb(code);
}

// prefetch() is desktop-gated (isDesktopShell() is false under jsdom), so the
// tests seed a token through takeToken(), which generates on demand via the
// web fallback path (mocked window.turnstile).

describe("TurnstileTokenManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.BOOTSTRAP_CONFIG = {
      gameEnv: "staging",
      numWorkers: 4,
      turnstileSiteKey: "test-key",
      jwtAudience: "openfront.dev",
      instanceId: "TEST_ID",
      gitCommit: "abc123",
    };
    ClientEnv.reset();
    stubTurnstile();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    ClientEnv.reset();
  });

  it("generates a token on demand and returns it exactly once", async () => {
    const manager = new TurnstileTokenManager();
    const take = manager.takeToken();
    await flush();

    expect(renderCount).toBe(1);
    completeChallenge("tok-1");
    expect(await take).toBe("tok-1");

    // The single-use token was consumed and an immediate background refill
    // was scheduled (not yet rendered).
    expect(renderCount).toBe(1);
  });

  it("refills in the background after a token is consumed", async () => {
    const manager = new TurnstileTokenManager();
    const first = manager.takeToken();
    await flush();
    completeChallenge("tok-1");
    expect(await first).toBe("tok-1");

    // The consumed token schedules an immediate background refill.
    await vi.advanceTimersByTimeAsync(0);
    expect(renderCount).toBe(2);
    completeChallenge("tok-2");
    await flush();

    const second = await manager.takeToken();
    expect(second).toBe("tok-2");
    expect(second).not.toBe("tok-1");
  });

  it("keeps a token ready by refreshing before it expires", async () => {
    const manager = new TurnstileTokenManager();
    const first = manager.takeToken();
    await flush();
    completeChallenge("tok-1");
    expect(await first).toBe("tok-1");

    // Background refill caches tok-2 without consuming it.
    await vi.advanceTimersByTimeAsync(0);
    completeChallenge("tok-2");
    await flush();

    // Advance to the proactive refresh point (TTL 4min - 60s lead = 3min):
    // the manager regenerates on its own.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(renderCount).toBe(3);
    completeChallenge("tok-3");
    await flush();

    // takeToken hands out the fresh token, never the stale one.
    expect(await manager.takeToken()).toBe("tok-3");
    expect(renderCount).toBe(3);
  });

  it("never hands out an expired token; it regenerates instead", async () => {
    const manager = new TurnstileTokenManager();
    const first = manager.takeToken();
    await flush();
    completeChallenge("tok-1");
    expect(await first).toBe("tok-1");

    // Let successive cached tokens age past expiry in steps, completing each
    // proactive refresh as it fires so no generation times out.
    await vi.advanceTimersByTimeAsync(0);
    completeChallenge("tok-2");
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    completeChallenge("tok-3");
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    completeChallenge("tok-4");
    await flush();

    // takeToken hands out the latest token; the expired tok-1..tok-3 were
    // discarded by the proactive refreshes.
    expect(await manager.takeToken()).toBe("tok-4");
  });

  it("returns null on failure and retries generation in the background", async () => {
    const manager = new TurnstileTokenManager();
    const first = manager.takeToken();
    await flush();
    failChallenge("challenge-failed");
    expect(await first).toBeNull();

    // The failed join schedules a background retry after a backoff.
    await vi.advanceTimersByTimeAsync(5 * 1000);
    expect(renderCount).toBe(2);
    completeChallenge("tok-retry");
    await flush();

    expect(await manager.takeToken()).toBe("tok-retry");
  });
});
