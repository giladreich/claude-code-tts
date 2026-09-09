// The release automation, checked without cutting a release.
//
// Tagging is the one workflow nobody exercises until it matters, and its
// failure is quiet: the step that pulls this version's notes out of the
// changelog matched a heading of the form "## 1.2.3", while the changelog
// writes "## [1.2.3]", so every release would have been published with the
// words "See CHANGELOG.md." in place of its notes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, tmpDir } = require("../helpers");

const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const pkg = require(path.join(ROOT, "package.json"));

/** The `node -e '...'` program the workflow runs to write release-notes.md. */
function extractionScript() {
  const start = workflow.indexOf("node -e '");
  assert.notEqual(start, -1, "the release workflow no longer runs a node script");
  const body = workflow.slice(start + "node -e '".length);
  const end = body.indexOf("\n          '");
  assert.notEqual(end, -1, "could not find the end of the script");
  return body.slice(0, end);
}

/** Run it the way the workflow does, against a given changelog. */
function releaseNotesFor(version, changelog) {
  const dir = tmpDir("cv-release-");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  const r = spawnSync(process.execPath, ["-e", extractionScript()], {
    cwd: dir,
    env: { ...process.env, GITHUB_REF_NAME: version },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(dir, "release-notes.md"), "utf8").trim();
}

test("the notes for a version are the changelog section for that version", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.2.0]",
    "",
    "- the newer thing",
    "",
    "## [1.1.0]",
    "",
    "- the older thing",
    "",
  ].join("\n");
  assert.equal(releaseNotesFor("1.2.0", changelog), "- the newer thing");
  assert.equal(releaseNotesFor("1.1.0", changelog), "- the older thing");
});

test("the heading may carry a date, or no brackets at all", () => {
  assert.equal(releaseNotesFor("2.3.4", "## [2.3.4] - 2026-01-01\n\n- dated\n"), "- dated");
  assert.equal(releaseNotesFor("2.3.4", "## 2.3.4\n\n- bare\n"), "- bare");
});

test("a version with no section says so instead of inventing notes", () => {
  assert.equal(releaseNotesFor("9.9.9", "## [1.0.0]\n\n- something\n"), "See CHANGELOG.md.");
});

test("a similar version number is not mistaken for this one", () => {
  // "1.0.0" must not match the "1.0.0-beta" section, nor "11.0.0".
  const changelog = "## [11.0.0]\n\n- eleven\n\n## [1.0.0-beta]\n\n- beta\n\n## [1.0.0]\n\n- one\n";
  assert.equal(releaseNotesFor("1.0.0", changelog), "- one");
  assert.equal(releaseNotesFor("11.0.0", changelog), "- eleven");
});

test("this repository's current version has notes to release", () => {
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const notes = releaseNotesFor(pkg.version, changelog);
  assert.notEqual(notes, "See CHANGELOG.md.", `CHANGELOG.md has no section for ${pkg.version}`);
  assert.ok(notes.length > 40, "the notes for a release should say something");
});

test("the workflow refuses a tag that does not match package.json", () => {
  assert.match(
    workflow,
    /tag \$TAG but package\.json is \$PKG/,
    "the version guard is what stops a mislabelled release"
  );
});

test("the Marketplace README is this one, minus what only GitHub needs", () => {
  // The Marketplace draws the icon, the name and the publisher in its own
  // header, so the centred icon at the top of README.md arrives twice on the
  // extension page. Packaging strips the marked blocks rather than keeping a
  // second document in step by hand.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const opens = (readme.match(/<!--\s*github-only\b/g) ?? []).length;
  const closes = (readme.match(/<!--\s*\/github-only\s*-->/g) ?? []).length;
  assert.ok(opens > 0, "the GitHub-only header is marked");
  assert.equal(opens, closes, "a stray marker would take the rest of the file with it");

  const out = path.join(tmpDir("cv-readme-"), "README.marketplace.md");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "marketplace-readme.js"), out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const marketplace = fs.readFileSync(out, "utf8");
  assert.doesNotMatch(marketplace, /assets\/icon\.png/, "the icon block is gone");
  assert.doesNotMatch(marketplace, /github-only/, "and so are the markers");
  assert.ok(marketplace.includes("Hear Claude Code work."), "everything else survives");
  assert.ok(marketplace.length > readme.length - 200, "only the marked block was removed");
});

test("packaging always goes through the script that writes that README", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  for (const [name, body] of [
    ["ci.yml", ci],
    ["release.yml", workflow],
  ]) {
    assert.doesNotMatch(body, /vsce package/, `${name} packages through "npm run package", or the icon ships twice`);
    assert.match(body, /npm run package/, `${name} builds no .vsix at all`);
  }
  assert.match(pkg.scripts.package, /marketplace-readme\.js && vsce package --readme-path/, "the script does both");
});
