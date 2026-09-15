#!/usr/bin/env node
/**
 * Prepare a release: stamp the changelog and set the version everywhere.
 *
 *   npm run release -- 1.2.3
 *
 * Notes for what has changed since the last release are collected under a
 * "## [Unreleased]" heading in CHANGELOG.md as the changes land. This
 * renames that heading to the version, sets the version in package.json and
 * both places package-lock.json carries it, and prints the commands that
 * finish the release (commit, tag, push); it commits nothing itself, so the
 * diff can be read first. The release workflow refuses a tag that does not
 * match package.json, and test/unit/release.test.js fails when the changelog
 * has no section for the version or the lockfile disagrees, so a release that
 * skipped any of this stops before it is published.
 *
 * It refuses to run on a tree with uncommitted changes other than the
 * changelog, on a version that is not newer than the current one, on a
 * version that already has a tag, and when the changelog has nothing to say
 * about it.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const UNRELEASED = /^## \[?Unreleased\]?[ \t]*$/im;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The section under `heading`: everything up to the next "## " or the end. */
function sectionAfter(md, heading) {
  const m = heading.exec(md);
  if (!m) {
    return undefined;
  }
  const start = m.index + m[0].length;
  const next = md.indexOf("\n## ", start);
  return md.slice(start, next === -1 ? md.length : next);
}

/**
 * The changelog with its "Unreleased" section headed by `version` instead.
 * Returns the text unchanged when the version already has a section, and
 * throws when there is nothing to release under either heading.
 */
function stampChangelog(md, version) {
  const heading = new RegExp("^## \\[?" + version.replace(/\./g, "\\.") + "\\]?(\\s|$)", "m");
  const ready = sectionAfter(md, heading);
  if (ready !== undefined) {
    if (!/^- /m.test(ready)) {
      throw new Error(`CHANGELOG.md has a section for ${version} with nothing in it.`);
    }
    return md;
  }
  const pending = sectionAfter(md, UNRELEASED);
  if (pending === undefined) {
    throw new Error(`CHANGELOG.md has no "## [Unreleased]" section and none for ${version}.`);
  }
  if (!/^- /m.test(pending)) {
    throw new Error('CHANGELOG.md has nothing under "## [Unreleased]".');
  }
  return md.replace(UNRELEASED, `## [${version}]`);
}

/** Numeric order on the three parts; a prerelease of a version comes before it. */
function newer(candidate, current) {
  const parse = (v) => {
    const [core, pre] = v.split("-", 2);
    return { parts: core.split(".").map(Number), pre };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) {
      return a.parts[i] > b.parts[i];
    }
  }
  return b.pre !== undefined && a.pre === undefined;
}

function git(root, ...args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

function main(version) {
  const root = path.join(__dirname, "..");
  if (!VERSION.test(version ?? "")) {
    console.error("Usage: npm run release -- <major.minor.patch>");
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  if (!newer(version, pkg.version)) {
    fail(`${version} is not newer than the current version, ${pkg.version}.`);
  }
  // The notes are often written just before the release, so an uncommitted
  // CHANGELOG.md is allowed; anything else uncommitted is not, because the
  // release commit must carry exactly the version and its notes.
  const dirty = git(root, "status", "--porcelain")
    .split("\n")
    .filter((line) => line.trim() !== "" && line.slice(3) !== "CHANGELOG.md");
  if (dirty.length > 0) {
    fail(
      `The working tree has uncommitted changes besides CHANGELOG.md; commit or stash them first:\n${dirty.join("\n")}`
    );
  }
  if (git(root, "tag", "--list", version).trim() !== "") {
    fail(`A tag ${version} already exists.`);
  }
  const changelogPath = path.join(root, "CHANGELOG.md");
  let changelog;
  try {
    changelog = stampChangelog(fs.readFileSync(changelogPath, "utf8"), version);
  } catch (e) {
    const last = git(root, "describe", "--tags", "--abbrev=0").trim();
    console.error(`${e.message}\n\nCommitted since ${last}, to write it from:\n`);
    console.error(git(root, "log", `${last}..HEAD`, "--format=- %s"));
    process.exit(1);
  }
  fs.writeFileSync(changelogPath, changelog);
  // npm rewrites package.json and both version fields of the lockfile in
  // their own formatting; prettier then makes sure format:check agrees.
  // Through a shell on Windows: npm and npx are .cmd files there, which
  // spawnSync cannot start on its own (ENOENT, and the stamp stopped at
  // the changelog with nothing said). One command string then, as a shell
  // takes it; every word in it is a fixed name or the validated version.
  const tool = (cmd, args) =>
    process.platform === "win32"
      ? spawnSync([cmd, ...args].join(" "), { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: true })
      : spawnSync(cmd, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const npm = tool("npm", ["version", version, "--no-git-tag-version"]);
  if (npm.status !== 0) {
    console.error(npm.error ? `npm version: ${npm.error.message}` : `npm version exited with ${npm.status}`);
    process.exit(npm.status ?? 1);
  }
  tool("npx", ["prettier", "--write", "package.json", "package-lock.json"]);
  console.log(
    [
      "",
      `Stamped CHANGELOG.md, package.json and package-lock.json with ${version}. Read the diff, then:`,
      "",
      "  npm run verify",
      `  git commit -am "Release ${version}."`,
      `  git checkout main && git merge --ff-only dev && git tag ${version}`,
      "  git push origin main dev --tags && git checkout dev",
      "",
    ].join("\n")
  );
}

module.exports = { stampChangelog, newer };

if (require.main === module) {
  main(process.argv[2]);
}
