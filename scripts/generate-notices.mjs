/**
 * Write NOTICES.txt from the lockfiles and the pinned FFmpeg/x264 build.
 *
 *   npm run notices
 *   npm run notices -- --check
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticesPath = path.join(root, "NOTICES.txt");
const check = process.argv.includes("--check");

function readVersions() {
  const text = readFileSync(path.join(root, "scripts", "ffmpeg", "versions.env"), "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  if (!values.FFMPEG_VERSION || !values.X264_VERSION) {
    throw new Error("scripts/ffmpeg/versions.env is missing FFMPEG_VERSION or X264_VERSION");
  }
  return values;
}

function npmPackageName(lockPath) {
  const parts = lockPath.split("node_modules/");
  return parts[parts.length - 1];
}

function licenseString(license) {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  return "";
}

async function licenseFromRegistry(name, version) {
  const url = `https://registry.npmjs.org/${name}/${version}`;
  const response = await fetch(url);
  if (!response.ok) return "";
  const body = await response.json();
  return licenseString(body.license);
}

async function readNpmPackages() {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const byKey = new Map();

  for (const [lockPath, meta] of Object.entries(lock.packages)) {
    if (!lockPath.startsWith("node_modules/") || !meta.version) continue;
    const name = npmPackageName(lockPath);
    const key = `${name}@${meta.version}`;
    const shipped = meta.dev !== true;
    const existing = byKey.get(key);
    if (existing?.shipped) continue;
    let license = licenseString(meta.license);
    if (!license) license = await licenseFromRegistry(name, meta.version);
    if (!license) {
      throw new Error(`No license metadata for npm package ${key}`);
    }
    byKey.set(key, {
      name,
      version: meta.version,
      license,
      url: `https://www.npmjs.com/package/${name}/v/${meta.version}`,
      shipped: existing?.shipped || shipped,
    });
  }

  return [...byKey.values()];
}

function readRustPackages() {
  const stdout = execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: root },
  );
  const metadata = JSON.parse(stdout);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const rootId = metadata.resolve.root;
  const runtime = new Set();
  const buildOnly = new Set();
  const seen = new Set();

  function walk(id, viaBuild) {
    const mark = `${id}:${viaBuild ? "build" : "runtime"}`;
    if (seen.has(mark)) return;
    seen.add(mark);

    if (id !== rootId) {
      if (viaBuild) {
        if (!runtime.has(id)) buildOnly.add(id);
      } else {
        runtime.add(id);
        buildOnly.delete(id);
      }
    }

    const node = nodes.get(id);
    if (!node) return;
    for (const dep of node.deps ?? []) {
      const kinds = dep.dep_kinds ?? [];
      const normal = kinds.some((kind) => kind.kind == null || kind.kind === "normal");
      const buildy = kinds.some((kind) => kind.kind === "build" || kind.kind === "dev");
      if (!viaBuild && normal) walk(dep.pkg, false);
      if (viaBuild || buildy) walk(dep.pkg, true);
    }
  }

  walk(rootId, false);

  function toEntry(id, shipped) {
    const pkg = packages.get(id);
    if (!pkg || pkg.name === "squeeze") return null;
    const license = licenseString(pkg.license);
    if (!license) {
      throw new Error(
        `No SPDX license for crate ${pkg.name} ${pkg.version}` +
          (pkg.license_file ? ` (license file: ${pkg.license_file})` : ""),
      );
    }
    const url =
      (typeof pkg.repository === "string" && pkg.repository) ||
      pkg.homepage ||
      `https://crates.io/crates/${pkg.name}/${pkg.version}`;
    return {
      name: pkg.name,
      version: pkg.version,
      license,
      url: url.replace(/\.git$/, ""),
      shipped,
    };
  }

  return [...runtime].map((id) => toEntry(id, true)).concat([...buildOnly].map((id) => toEntry(id, false))).filter(Boolean);
}

function sortEntries(entries) {
  return entries.sort((a, b) =>
    a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en", { numeric: true }),
  );
}

function formatEntries(entries) {
  return sortEntries(entries)
    .map((entry) => `${entry.name} ${entry.version} | ${entry.license} | ${entry.url}`)
    .join("\n");
}

function section(title, entries) {
  if (entries.length === 0) return "";
  return `${title}\n\n${formatEntries(entries)}\n\n`;
}

function render(npmPackages, rustPackages, versions) {
  const shippedNpm = npmPackages.filter((entry) => entry.shipped);
  const buildNpm = npmPackages.filter((entry) => !entry.shipped);
  const shippedRust = rustPackages.filter((entry) => entry.shipped);
  const buildRust = rustPackages.filter((entry) => !entry.shipped);

  return `NOTICES

Third-party software used by Squeeze.
Generated by \`npm run notices\` from package-lock.json, src-tauri/Cargo.lock,
and scripts/ffmpeg/versions.env. Do not edit this file by hand.

Squeeze's own source code is under the MIT License. See LICENSE.
Everything listed below keeps its own license.

Bundled programs
----------------

These ship inside the installers as separate executables. They are not linked
into the Squeeze binary. This build of FFmpeg uses --enable-gpl and libx264,
so the ffmpeg and ffprobe binaries are under the GNU General Public License
version 2 or any later version:

https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

Corresponding source is scripts/ffmpeg/ in this repository. FFmpeg is pinned
to tag n${versions.FFMPEG_VERSION}. x264 is the ${versions.X264_VERSION} branch
fetched when the sidecars are built (scripts/ffmpeg/versions.env). Rebuild with
scripts/ffmpeg/build.sh.

FFmpeg ${versions.FFMPEG_VERSION} | GPL-2.0-or-later | https://github.com/FFmpeg/FFmpeg
x264 ${versions.X264_VERSION} | GPL-2.0-or-later | https://code.videolan.org/videolan/x264

The app also bundles the Manrope font, listed with the shipped JavaScript
packages. Manrope is under the SIL Open Font License 1.1:

https://openfontlicense.org/

Shipped in the app
------------------

JavaScript packages bundled into the desktop app.

${formatEntries(shippedNpm)}

Rust crates compiled into at least one platform build.

${formatEntries(shippedRust)}

Build tools
-----------

Used to develop and build Squeeze. Not included in the installers.

${section("JavaScript", buildNpm)}${section("Rust", buildRust)}
License identifiers are SPDX expressions copied from package metadata.
Where an expression offers a choice, any one of those licenses may be used.
Full texts: https://spdx.org/licenses/

${shippedNpm.length} shipped JavaScript packages, ${buildNpm.length} build-only JavaScript packages.
${shippedRust.length} shipped Rust crates, ${buildRust.length} build-only Rust crates.
`.replace(/\n{3,}/g, "\n\n");
}

const versions = readVersions();
const [npmPackages, rustPackages] = await Promise.all([readNpmPackages(), Promise.resolve().then(readRustPackages)]);
const notices = render(npmPackages, rustPackages, versions);

if (check) {
  const current = readFileSync(noticesPath, "utf8").replace(/\r\n/g, "\n");
  if (current !== notices) {
    console.error("NOTICES.txt is out of date. Run npm run notices and commit the result.");
    process.exit(1);
  }
  console.log("NOTICES.txt matches the lockfiles.");
} else {
  writeFileSync(noticesPath, notices);
  console.log(`Wrote ${path.relative(root, noticesPath)}`);
}
