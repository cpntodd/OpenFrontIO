import fs from "node:fs";
import path from "node:path";

const outputPath = path.resolve("electron-dist", "desktop-config.json");
const environmentSiteKey =
  process.env.OPENFRONT_TURNSTILE_SITE_KEY ?? process.env.TURNSTILE_SITE_KEY;
let localSiteKey;
try {
  const localConfig = JSON.parse(
    fs.readFileSync(path.resolve("desktop-config.json"), "utf8"),
  );
  if (typeof localConfig.turnstileSiteKey === "string") {
    localSiteKey = localConfig.turnstileSiteKey;
  }
} catch {
  // A local config file is optional; release builds use the environment.
}
// Blank (not just nullish) keys must fall through to the next source, so
// `||` is intentional here -- `??` would let an empty env key shadow a valid
// local key.
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
const siteKey = environmentSiteKey?.trim() || localSiteKey?.trim();

// The production Turnstile site key is public — it is served to every browser
// visitor of openfront.io. This is the same key the web client uses.
const DEFAULT_KEY = "0x4AAAAAACFLkaecN39lS8sk";

if (!siteKey?.trim()) {
  console.warn(
    "[electron] No TURNSTILE_SITE_KEY set; defaulting to the openfront.io production key.",
  );
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  // A blank key must fall back to the production default, so `||` is
  // intentional here -- `??` would write an empty key.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  `${JSON.stringify({ turnstileSiteKey: siteKey?.trim() || DEFAULT_KEY }, null, 2)}\n`,
);
