#!/usr/bin/env node
/**
 * Release-gate guard. Fails when the current version is not release-coherent:
 *   1. CHANGELOG.md has no `## [<version>]` section, or
 *   2. server.json or package-lock.json disagree with package.json's version.
 *
 * `version` is read from package.json and treated as the source of truth. A
 * `## [Unreleased]` changelog section is allowed to coexist. Exit 0 when
 * everything lines up, exit 1 with a clear message otherwise.
 *
 * Wired into CI (runs on every PR) and `prepublishOnly` so a release can never
 * ship a version without a changelog entry or with a stale registry manifest /
 * lockfile (a stale server.json breaks the MCP Registry publish).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    console.error(`check-changelog: cannot read ${rel} (not found or unreadable)`);
    process.exit(1);
  }
};
const readJson = (rel) => {
  const text = read(rel);
  try {
    return JSON.parse(text);
  } catch {
    console.error(`check-changelog: ${rel} is not valid JSON`);
    process.exit(1);
  }
};

const errors = [];

const pkg = readJson("package.json");
const version = pkg.version;
if (!version) {
  console.error("check-changelog: package.json has no version field");
  process.exit(1);
}

// 1. Changelog section present.
// Match a Keep-a-Changelog version heading: `## [x.y.z]` at line start, with
// or without a trailing date. Escape regex metachars so 0.8.0 stays literal.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^##\\s+\\[${escaped}\\]`, "m");
if (!heading.test(read("CHANGELOG.md"))) {
  errors.push(
    `CHANGELOG.md has no "## [${version}]" section. Add a ` +
      `"## [${version}] - <date>" heading with the notable changes before publishing.`,
  );
}

// 2. Version coherence across the files a publish reads. A mismatch here breaks
// npm and/or the MCP Registry publish, so gate on it at the same point.
const lock = readJson("package-lock.json");
const lockVersions = [
  ["package-lock.json .version", lock.version],
  ["package-lock.json .packages[''].version", lock.packages?.[""]?.version],
];
const server = readJson("server.json");
const serverVersions = [
  ["server.json .version", server.version],
  ["server.json .packages[0].version", server.packages?.[0]?.version],
];
for (const [label, actual] of [...lockVersions, ...serverVersions]) {
  if (actual !== version) {
    errors.push(
      `${label} is "${actual ?? "(missing)"}" but package.json version is "${version}". ` +
        `Bump it to "${version}" to keep the release coherent.`,
    );
  }
}

if (errors.length > 0) {
  console.error("check-changelog: release is not coherent:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`check-changelog: ${version} is release-coherent (changelog + version files) ✓`);
