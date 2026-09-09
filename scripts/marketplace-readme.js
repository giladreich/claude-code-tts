#!/usr/bin/env node
/**
 * The README the Marketplace gets: this repository's, minus the parts that
 * only make sense on GitHub.
 *
 * The Marketplace draws the icon, the name and the publisher in its own
 * header, so the centred icon at the top of README.md is duplicated there.
 * Rather than keep two documents in step, README.md marks such blocks:
 *
 *   <!-- github-only --> ... <!-- /github-only -->
 *
 * and packaging runs this first, then passes the result to vsce with
 * --readme-path. The file is written next to README.md so that every
 * relative link inside it still resolves the way vsce expects.
 *
 *   node scripts/marketplace-readme.js [output path]
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const target = process.argv[2] ?? path.join(root, "README.marketplace.md");
const source = fs.readFileSync(path.join(root, "README.md"), "utf8");

const OPEN = /<!--\s*github-only\b[\s\S]*?-->/g;
const CLOSE = /<!--\s*\/github-only\s*-->/g;
const opens = (source.match(OPEN) ?? []).length;
const closes = (source.match(CLOSE) ?? []).length;
if (opens !== closes) {
  // A stray marker would silently take the rest of the file with it.
  console.error(`README.md has ${opens} github-only markers opened and ${closes} closed`);
  process.exit(1);
}

const stripped = source.replace(/<!--\s*github-only\b[\s\S]*?-->[\s\S]*?<!--\s*\/github-only\s*-->\n*/g, "").trimStart();
fs.writeFileSync(target, stripped);
