#!/usr/bin/env node
/**
 * Cross-platform entry for FFmpeg sidecar setup.
 * Windows → PowerShell script; macOS/Linux → bash script.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const isWin = process.platform === "win32";

let result;
if (isWin) {
  const script = path.join(root, "scripts", "setup-ffmpeg.ps1");
  const psArgs = ["-ExecutionPolicy", "Bypass", "-File", script];
  if (args.includes("--build")) {
    console.error(
      "Windows source builds are produced by CI (mingw cross-compile).\n" +
        "Run the Build FFmpeg sidecars workflow, then: npm run setup:ffmpeg"
    );
    process.exit(1);
  }
  if (args.includes("--force") || args.includes("-Force")) {
    psArgs.push("-Force");
  }
  const tagIdx = args.indexOf("--tag");
  if (tagIdx !== -1 && args[tagIdx + 1]) {
    psArgs.push("-Tag", args[tagIdx + 1]);
  }
  result = spawnSync("powershell", psArgs, { stdio: "inherit", cwd: root });
} else {
  const script = path.join(root, "scripts", "setup-ffmpeg.sh");
  result = spawnSync("bash", [script, ...args], { stdio: "inherit", cwd: root });
}

process.exit(result.status ?? 1);
