import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiBase, getAudience } from "../../src/client/Api";

describe("API audience resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      BOOTSTRAP_CONFIG: undefined,
      location: { href: "http://127.0.0.1:47837/" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the injected audience for the Electron loopback origin", () => {
    window.BOOTSTRAP_CONFIG = { jwtAudience: "openfront.io" };

    expect(getAudience()).toBe("openfront.io");
    expect(getApiBase()).toBe("https://api.openfront.io");
  });

  it("falls back to the page hostname for normal web origins", () => {
    window.location.href = "https://openfront.dev/";

    expect(getAudience()).toBe("openfront.dev");
    expect(getApiBase()).toBe("https://api.openfront.dev");
  });
});
