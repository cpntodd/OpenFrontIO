import fs from "node:fs";
import path from "node:path";

const outputPath = path.resolve("electron-dist", "desktop-config.json");
const siteKey =
  process.env.OPENFRONT_TURNSTILE_SITE_KEY ?? process.env.TURNSTILE_SITE_KEY;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ turnstileSiteKey: siteKey ?? null }, null, 2)}\n`,
);
