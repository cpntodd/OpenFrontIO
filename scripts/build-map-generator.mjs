import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "map-generator.exe" : "map-generator";
const outputPath = resolve(projectRoot, "build", "map-generator", binaryName);

mkdirSync(dirname(outputPath), { recursive: true });
execFileSync("go", ["build", "-o", outputPath, "."], {
  cwd: resolve(projectRoot, "map-generator"),
  stdio: "inherit",
});

console.log(`Built map generator: ${outputPath}`);
