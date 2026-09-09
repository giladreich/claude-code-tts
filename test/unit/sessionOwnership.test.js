// Which window speaks which session, when several are open.
//
// Claude Code writes the same transcripts whether it runs in VSCode's
// terminal or a native one, so this extension can speak all of them. But
// every open VSCode window runs its own copy of the extension and watches
// the same directory, and without a rule they all speak the same terminal
// session at once, two or three voices over each other.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { SessionOwnership, projectLabel, registryDir, STALE_MS } = require("../../out/session/sessionOwnership.js");
const { tmpDir } = require("../helpers");

/** A window in a shared registry, with a clock the test drives. */
function windowAt(dir, id, startedAt, dirs, clock) {
  return new SessionOwnership({ dir, id, pid: 1, startedAt, dirs: () => dirs, now: () => clock.t });
}

test("a window speaks its own folders, and never another window's", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const a = windowAt(dir, "a", 0, ["-home-me-alpha"], clock);
  const b = windowAt(dir, "b", 0, ["-home-me-beta"], clock);
  a.start();
  b.start();
  try {
    assert.equal(a.owns("-home-me-alpha"), true, "its own project");
    assert.equal(b.owns("-home-me-beta"), true);
    assert.equal(a.owns("-home-me-beta"), false, "the other window's project is not this one's to speak");
    assert.equal(b.owns("-home-me-alpha"), false);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("a session no window has open is spoken by exactly one of them", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const windows = [
    windowAt(dir, "a", 100, ["-home-me-alpha"], clock),
    windowAt(dir, "b", 200, ["-home-me-beta"], clock),
    windowAt(dir, "c", 300, [], clock),
  ];
  for (const w of windows) w.start();
  try {
    // A Claude session started in a terminal, in a folder nobody has open.
    const speaking = windows.filter((w) => w.owns("-home-me-scratch"));
    assert.equal(speaking.length, 1, "exactly one window may speak an unowned session");
    assert.equal(speaking[0].id, "a", "the oldest window, so opening one never steals the voice");
  } finally {
    for (const w of windows) w.dispose();
  }
});

test("a newly opened window does not take the terminal sessions from the older one", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const old = windowAt(dir, "zzz-old", 100, [], clock); // an id that sorts last
  old.start();
  assert.equal(old.owns("-home-me-scratch"), true);
  const fresh = windowAt(dir, "aaa-new", 900, [], clock);
  fresh.start();
  try {
    clock.t += 4000; // past the snapshot window, so both re-read the registry
    assert.equal(old.owns("-home-me-scratch"), true, "the window already speaking keeps speaking");
    assert.equal(fresh.owns("-home-me-scratch"), false);
  } finally {
    old.dispose();
    fresh.dispose();
  }
});

test("when the speaking window goes away, the next oldest takes over", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const first = windowAt(dir, "a", 100, [], clock);
  const second = windowAt(dir, "b", 200, [], clock);
  first.start();
  second.start();
  assert.equal(second.owns("-home-me-scratch"), false);
  // The first window closes cleanly: its record is removed at once.
  first.dispose();
  clock.t += 4000;
  assert.equal(second.owns("-home-me-scratch"), true);
  second.dispose();
});

test("a window that crashed stops counting once its heartbeat goes stale", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const crashed = windowAt(dir, "a", 100, ["-home-me-alpha"], clock);
  const alive = windowAt(dir, "b", 200, [], clock);
  crashed.start(); // and then never heartbeats again
  alive.start();
  try {
    assert.equal(alive.owns("-home-me-scratch"), false, "while the older window is alive");
    assert.equal(alive.owns("-home-me-alpha"), false, "and its folders are still its own");
    clock.t += STALE_MS + 1000;
    alive.refresh(); // its own record stays fresh
    assert.equal(alive.owns("-home-me-scratch"), true, "the crashed window no longer counts");
    assert.equal(alive.owns("-home-me-alpha"), true, "nor does it hold its folders");
  } finally {
    crashed.dispose();
    alive.dispose();
  }
});

test("a single window speaks everything, and an unwritable registry does not silence it", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const only = windowAt(dir, "a", 100, ["-home-me-alpha"], clock);
  only.start();
  assert.equal(only.owns("-home-me-alpha"), true);
  assert.equal(only.owns("-home-me-anything"), true);
  only.dispose();

  // Storage that cannot be written (read-only, missing): speaking is the
  // safer failure than a silent extension nobody can diagnose.
  const broken = new SessionOwnership({
    dir: path.join(dir, "nope", "\0bad"),
    id: "x",
    dirs: () => [],
    now: () => clock.t,
  });
  broken.start();
  assert.equal(broken.owns("-home-me-alpha"), true);
  broken.dispose();
});

test("the registry survives a half-written file from another window", () => {
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "torn.json"), '{"id":"torn","at":');
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a record");
  const w = windowAt(dir, "a", 100, [], clock);
  w.start();
  assert.equal(w.windowCount(), 1, "only this window is readable, so only it counts");
  assert.equal(w.owns("-home-me-scratch"), true);
  w.dispose();
});

test("the project label is the folder name a person would recognise", () => {
  assert.equal(projectLabel("-Users-me-dev-proj"), "proj");
  assert.equal(projectLabel("-home-me-work-api-server"), "server");
  assert.equal(projectLabel("weird"), "weird");
});

test("a window speaks its own folder even when an older window is the terminal owner", () => {
  // The window you are working in reads its own project, always. Otherwise
  // the oldest window would speak everything and the one you are looking at
  // would sit silent, which is not what anybody means by "open a second
  // window".
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const first = windowAt(dir, "a", 100, [], clock); // an empty window, opened first
  const second = windowAt(dir, "b", 200, ["-home-me-beta"], clock);
  first.start();
  second.start();
  try {
    assert.equal(first.owns("-home-me-scratch"), true, "the oldest window takes the terminal sessions");
    assert.equal(first.owns("-home-me-beta"), false, "but not the folder another window has open");
    assert.equal(second.owns("-home-me-beta"), true, "which that window speaks itself");
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("two windows on the same folder do not both speak it", () => {
  // Opening a second window on the same project (a worktree, a split screen)
  // is ordinary, and it used to mean hearing every message twice.
  const dir = tmpDir("cv-own-");
  const clock = { t: 1000 };
  const older = windowAt(dir, "a", 100, ["-home-me-alpha"], clock);
  const newer = windowAt(dir, "b", 200, ["-home-me-alpha"], clock);
  older.start();
  newer.start();
  try {
    assert.equal(older.owns("-home-me-alpha"), true, "the window open longest reads it");
    assert.equal(newer.owns("-home-me-alpha"), false, "and the other one stays quiet");
    // And when it closes, the remaining window picks it up.
    older.dispose();
    clock.t += 4000;
    assert.equal(newer.owns("-home-me-alpha"), true);
  } finally {
    newer.dispose();
  }
});

test("the registry sits where every VSCode build can see it", () => {
  // Code and Code Insiders keep separate storage directories, so a registry
  // inside one of them would be invisible to the other and both would speak
  // the same terminal session.
  const home = tmpDir("cv-home-");
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere; setting one
  // of them moved the home directory on two platforms out of three.
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const storage = path.join(home, "storage");
    assert.equal(registryDir(storage), path.join(storage, "windows"), "no ~/.claude: keep to our own storage");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    assert.equal(registryDir(storage), path.join(home, ".claude", "claude-code-tts-windows"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
