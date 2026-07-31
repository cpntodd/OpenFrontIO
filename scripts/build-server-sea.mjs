/**
 * Build the game server as a Node.js Single Executable Application (SEA).
 *
 * This compiles src/server/ into a standalone binary that can be bundled
 * with the Electron app. The resulting binary includes the Node.js runtime
 * and can run without any external dependencies.
 *
 * Requires: Node.js >= 20.x
 *
 * Steps:
 * 1. Build the server TypeScript into a single JS bundle
 * 2. Generate a SEA config (blob)
 * 3. Inject the blob into a copy of the Node.js binary
 * 4. Sign the resulting binary (macOS only)
 *
 * Output: build/server/openfront-server
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const OUT_DIR = path.join(rootDir, "build", "server");
const BUNDLE_PATH = path.join(OUT_DIR, "server-bundle.js");
const SEA_CONFIG_PATH = path.join(OUT_DIR, "sea-config.json");
const BLOB_PATH = path.join(OUT_DIR, "server.blob");
const BINARY_OUT = path.join(OUT_DIR, "openfront-server");

function log(msg: string) {
  console.log(`[build-server-sea] ${msg}`);
}

function step(msg: string) {
  console.log(`\n  >>> ${msg}`);
}

async function main() {
  log("Building server SEA binary...");

  // Ensure output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Bundle the server code
  step("Bundling server code with esbuild...");
  execSync(
    `npx esbuild src/server/Server.ts ` +
      `--bundle ` +
      `--platform=node ` +
      `--target=node20 ` +
      `--format=esm ` +
      `--outfile=${BUNDLE_PATH} ` +
      `--external:canvas ` + // canvas is a native module, cannot be bundled
      `--external:pg-native ` + // optional native PostgreSQL driver
      `--minify`,
    { cwd: rootDir, stdio: "inherit" },
  );
  log(`Bundled to ${BUNDLE_PATH}`);

  // Step 2: Create SEA config
  step("Creating SEA configuration...");
  const seaConfig = {
    main: BUNDLE_PATH,
    output: BLOB_PATH,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(SEA_CONFIG_PATH, JSON.stringify(seaConfig, null, 2));
  log(`Config written to ${SEA_CONFIG_PATH}`);

  // Step 3: Generate the blob
  step("Generating SEA blob...");
  execSync(
    `node --experimental-sea-config "${SEA_CONFIG_PATH}"`,
    { cwd: rootDir, stdio: "inherit" },
  );
  log(`Blob generated at ${BLOB_PATH}`);

  // Step 4: Copy Node.js binary and inject the blob
  step("Injecting blob into Node.js binary...");
  const nodeBinary = process.execPath;

  // Copy the Node binary
  fs.copyFileSync(nodeBinary, BINARY_OUT);
  fs.chmodSync(BINARY_OUT, 0o755);

  // Inject the blob (platform-specific)
  if (process.platform === "linux") {
    execSync(
      `npx --yes postject "${BINARY_OUT}" NODE_SEA_BLOB "${BLOB_PATH}" ` +
        `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      { cwd: rootDir, stdio: "inherit" },
    );
  } else if (process.platform === "darwin") {
    execSync(
      `npx --yes postject "${BINARY_OUT}" NODE_SEA_BLOB "${BLOB_PATH}" ` +
        `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ` +
        `--macho-segment-name NODE_SEA`,
      { cwd: rootDir, stdio: "inherit" },
    );
    // Sign the binary on macOS
    execSync(`codesign --sign - "${BINARY_OUT}"`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  } else if (process.platform === "win32") {
    // Windows: postject support would be different
    log("Windows SEA injection not yet supported; skipping");
    return;
  }

  // Step 5: Verify
  step("Verifying binary...");
  if (fs.existsSync(BINARY_OUT)) {
    const stats = fs.statSync(BINARY_OUT);
    log(`Binary created: ${BINARY_OUT} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    log(`ERROR: Binary not found at ${BINARY_OUT}`);
    process.exit(1);
  }

  log("Done! Server SEA binary is ready.");
  log("");
  log("To test: ./build/server/openfront-server");
}

main().catch((err) => {
  console.error("[build-server-sea] Error:", err);
  process.exit(1);
});
