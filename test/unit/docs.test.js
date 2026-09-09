// The documentation is checked the way code is: a setting or command that
// nobody documented fails the build, and so does a documented one that no
// longer exists.
//
// The previous version of this file was close to vacuous: a command counted
// as documented if its title appeared anywhere in 40 KB of prose, or merely
// if extension.ts mentioned its id. Renaming or merging a command passed
// silently, which is exactly the change this test exists to catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, tmpDir } = require("../helpers");

const pkg = require(path.join(ROOT, "package.json"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const readme = read("README.md");
const reference = read("docs/REFERENCE.md");

/** The schema, whether it is one section or several. */
function configurationProperties() {
  const c = pkg.contributes.configuration;
  return Object.assign({}, ...(Array.isArray(c) ? c : [c]).map((s) => s.properties));
}

/** The part of a document under a heading, up to the next one of its level. */
function section(doc, heading) {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `docs/REFERENCE.md has no "${heading}" section`);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Rows of any `| \`id\` | value | ... |` table in a document. */
function tableRows(doc) {
  return new Map(
    doc
      .split("\n")
      .map((l) => /^\| `([\w.]+)` \| (.+?) \|/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()])
  );
}

test("every setting is documented with its current default, and nothing else is", () => {
  const props = configurationProperties();
  const documented = tableRows(section(reference, "Settings"));
  const missing = [];
  const wrongDefault = [];
  for (const [key, spec] of Object.entries(props)) {
    const short = key.replace(/^claudeCodeTts\./, "");
    const cell = documented.get(short);
    if (cell === undefined) {
      missing.push(short);
      continue;
    }
    const d = spec.default;
    const expected = typeof d === "string" ? (d === "" ? '`""`' : `\`${d}\``) : `\`${JSON.stringify(d)}\``;
    // Long free-text defaults are described in prose rather than quoted.
    const longText = typeof d === "string" && d.length > 30;
    const objectDefault = d !== null && typeof d === "object";
    if (!longText && !objectDefault && cell !== expected) {
      wrongDefault.push(`${short}: reference says ${cell}, package.json says ${expected}`);
    }
  }
  assert.deepEqual(missing, [], "settings missing from docs/REFERENCE.md");
  assert.deepEqual(wrongDefault, [], "documented defaults that no longer match package.json");

  const known = new Set(Object.keys(props).map((k) => k.replace(/^claudeCodeTts\./, "")));
  const stale = [...documented.keys()].filter((k) => !known.has(k));
  assert.deepEqual(stale, [], "documented settings that no longer exist");
});

test("every command has a row in the reference, with its current title", () => {
  const rows = tableRows(section(reference, "Commands"));
  const declared = pkg.contributes.commands.map((c) => c.command.replace(/^claudeCodeTts\./, ""));
  assert.deepEqual(
    declared.filter((c) => !rows.has(c)),
    [],
    "commands with no row in docs/REFERENCE.md"
  );
  // The title too, not just the id: renaming a command is exactly the change
  // this test exists to catch, and it passed silently before.
  const wrongTitle = pkg.contributes.commands
    .map((c) => [c.command.replace(/^claudeCodeTts\./, ""), c.title])
    .filter(([id, title]) => rows.get(id) !== title)
    .map(([id, title]) => `${id}: reference says "${rows.get(id)}", package.json says "${title}"`);
  assert.deepEqual(wrongTitle, [], "command titles that drifted from the documentation");
});

test("the store page stays a store page", () => {
  // It was a 40 KB engineering manual whose first screen was a privacy
  // essay. A Marketplace reader decides in about ten seconds. What that
  // reader gets is README.md minus the blocks marked github-only, written by
  // scripts/marketplace-readme.js at packaging time, so the page that ships
  // is the page measured here.
  const out = path.join(tmpDir("cv-store-"), "README.marketplace.md");
  const written = spawnSync(process.execPath, [path.join(ROOT, "scripts", "marketplace-readme.js"), out], {
    encoding: "utf8",
  });
  assert.equal(written.status, 0, written.stderr);
  const page = fs.readFileSync(out, "utf8");
  assert.ok(page.length < 12000, `the store page is ${page.length} bytes; it is not the manual`);
  const firstScreen = page.split("\n").slice(0, 12).join("\n");
  assert.match(firstScreen, /Hear Claude Code work/, "the first line must say what it does");
  assert.match(readme, /## Sixty seconds/, "a new user needs a quickstart above the detail");
  assert.match(readme, /## Requirements/, "the store page must say what it needs");
});

test("every keybinding is documented, with both platforms", () => {
  for (const k of pkg.contributes.keybindings) {
    const title = pkg.contributes.commands.find((c) => c.command === k.command)?.title;
    assert.ok(title, `${k.command} has a keybinding but is not a command`);
    assert.ok(readme.includes(`\`${k.key}\``), `${k.key} (${title}) is not in the README shortcut table`);
    assert.ok(readme.includes(`\`${k.mac}\``), `${k.mac} (${title}) is not in the README shortcut table`);
    assert.ok(readme.includes(title), `${title} is not named in the README`);
  }
});

test("every document links to the others, and every link resolves", () => {
  const docs = [
    "README.md",
    "docs/GUIDE.md",
    "docs/REFERENCE.md",
    "docs/PRIVACY.md",
    "docs/ARCHITECTURE.md",
    "docs/RESPONSIBLE-USE.md",
    "docs/CONTRIBUTING.md",
  ];
  for (const doc of docs) {
    const body = read(doc);
    for (const m of body.matchAll(/\[[^\]]+\]\(([^)#]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^https?:/.test(target)) continue;
      const resolved = path.resolve(ROOT, path.dirname(doc), target);
      assert.ok(fs.existsSync(resolved), `${doc} links to ${target}, which does not exist`);
    }
  }
  for (const doc of [
    "docs/GUIDE.md",
    "docs/REFERENCE.md",
    "docs/PRIVACY.md",
    "docs/ARCHITECTURE.md",
    "docs/RESPONSIBLE-USE.md",
  ]) {
    assert.ok(readme.includes(doc), `${doc} is not linked from the README, so nobody will find it`);
  }
});

test("architecture and privacy docs exist, and their mermaid blocks are well formed", () => {
  for (const f of ["docs/ARCHITECTURE.md", "docs/PRIVACY.md", "docs/RESPONSIBLE-USE.md"]) {
    const md = read(f);
    assert.ok(md.length > 500, `${f} looks empty`);
    const fences = md.split("\n").filter((l) => l.trim().startsWith("```"));
    assert.equal(fences.length % 2, 0, `${f} has an unclosed code fence`);
    const blocks = md.match(/```mermaid\n[\s\S]*?```/g) ?? [];
    if (f !== "docs/RESPONSIBLE-USE.md") assert.ok(blocks.length > 0, `${f} has no diagrams`);
    for (const b of blocks) {
      const body = b.replace(/```mermaid\n/, "").replace(/```$/, "");
      assert.match(
        body.trim().split("\n")[0],
        /^(flowchart|graph|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram|gantt|mindmap|timeline)\b/,
        `unknown diagram type in ${f}`
      );
      // Node labels with parentheses or colons must be quoted, the classic
      // mermaid parse failure.
      for (const m of body.matchAll(/\[([^\]"]*)\]/g)) {
        assert.ok(!/[(),:]/.test(m[1]), `unquoted label in ${f}: ${m[1]}`);
      }
    }
  }
});

test("the privacy audit's countable claims are true", () => {
  // This document's whole value is that a reader can check it. It claimed
  // four URLs where there were five, and two importers of the HTTP client
  // where there were three, which costs more trust than no number at all.
  const privacy = read("docs/PRIVACY.md");
  const sources = (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "__pycache__" ? [] : walk(full);
      return /\.(ts|js|py|swift)$/.test(e.name) ? [full] : [];
    });
  })(path.join(ROOT, "src")).concat(
    fs
      .readdirSync(path.join(ROOT, "assets"))
      .filter((f) => /\.(js|py|swift)$/.test(f))
      .map((f) => path.join(ROOT, "assets", f))
  );

  const urls = new Set();
  const importers = new Set();
  for (const file of sources) {
    const body = fs.readFileSync(file, "utf8");
    for (const m of body.matchAll(/https?:\/\/[\w./-]+/g)) urls.add(m[0].replace(/[.,)]+$/, ""));
    // Posix separators: PRIVACY.md names these files the way the repository
    // spells them, and path.relative answers with backslashes on Windows.
    if (/from "\.{1,2}\/(tts\/)?net"/.test(body)) importers.add(path.relative(ROOT, file).split(path.sep).join("/"));
  }
  const written = { 4: "Four", 5: "Five", 6: "Six", 7: "Seven" }[urls.size];
  assert.ok(
    privacy.includes(`${written} URLs exist`),
    `PRIVACY.md must say "${written} URLs exist"; the tree has ${urls.size}: ${[...urls].join(", ")}`
  );
  const count = { 2: "two", 3: "three", 4: "four" }[importers.size];
  assert.ok(
    privacy.includes(`imported by exactly ${count} files`),
    `PRIVACY.md must say the HTTP client is imported by exactly ${count} files: ${[...importers].join(", ")}`
  );
  for (const file of importers) {
    assert.ok(privacy.includes(`\`${file}\``), `${file} imports the HTTP client and is not named in PRIVACY.md`);
  }
});

test("every preset voice has a recording to audition before its model exists", () => {
  // The model that speaks the presets is gigabytes and is not downloaded
  // until one is chosen, so without these the picker cannot play the voices
  // it is asking the user to choose between.
  const { QWEN3_SPEAKERS } = require(path.join(ROOT, "out", "tts", "qwen3.js"));
  const dir = path.join(ROOT, "assets", "voice-samples");
  const missing = QWEN3_SPEAKERS.map((s) => `${s.name.toLowerCase()}.wav`).filter(
    (f) => !fs.existsSync(path.join(dir, f))
  );
  assert.deepEqual(missing, [], "presets with no bundled sample");

  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    const bytes = fs.statSync(path.join(dir, f)).size;
    total += bytes;
    assert.ok(bytes > 20000, `${f} is too small to be speech`);
  }
  assert.ok(total < 2 * 1024 * 1024, `the samples weigh ${Math.round(total / 1024)} KB; they ship with every install`);
});
