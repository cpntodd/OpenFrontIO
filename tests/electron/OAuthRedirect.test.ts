import { describe, expect, it } from "vitest";
import { getOAuthRedirectUri } from "../../electron/oauth";

describe("getOAuthRedirectUri", () => {
  it("uses the staging web origin for the staging API audience", () => {
    expect(getOAuthRedirectUri("openfront.dev")).toBe("https://openfront.dev/");
  });

  it("uses the production web origin for the production API audience", () => {
    expect(getOAuthRedirectUri("OPENFRONT.IO")).toBe("https://openfront.io/");
  });

  it("does not send OAuth redirects to arbitrary custom servers", () => {
    expect(getOAuthRedirectUri("localhost:8787")).toBeNull();
  });
});
