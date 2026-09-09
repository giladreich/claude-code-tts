// Shared helpers for the test suite (node:test). Everything is silent: audio
// tests play at volume 0 so a developer's session is never disturbed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * A temp directory that removes itself when the test process exits.
 *
 * The suite calls this from 79 places and used to clean up in three of them,
 * so a full run left about 1.8 GB of fixtures behind in the system temp
 * directory. Set CLAUDE_CODE_TTS_KEEP_TMP=1 to keep them while debugging.
 */
const tmpDirs = [];
function tmpDir(prefix = "cv-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  if (process.env.CLAUDE_CODE_TTS_KEEP_TMP) return;
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a daemon may still hold a file open; the OS cleans temp eventually */
    }
  }
});

/** Canonical 16-bit mono PCM WAV of `secs` seconds; sine or silence. */
function writeWav(file, secs, { rate = 24000, silence = false, freq = 440 } = {}) {
  const n = Math.round(rate * secs);
  const pcm = Buffer.alloc(n * 2);
  if (!silence) {
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  }
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([b, pcm]));
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred()` is true or fail after `ms`. */
async function until(pred, ms = 5000, step = 20) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await sleep(step);
  }
}

const isMac = process.platform === "darwin";
const hasSwiftc = isMac && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status === 0;

/** Compile (once per test run) the Swift player into a temp storage dir. */
let playerStorage;
function playerStorageDir() {
  if (playerStorage) return playerStorage;
  playerStorage = tmpDir("cv-player-");
  fs.mkdirSync(path.join(playerStorage, "bin"), { recursive: true });
  const src = path.join(ROOT, "assets", "wavplayer.swift");
  const bin = path.join(playerStorage, "bin", "claude-code-tts-player-v4");
  // Reuse the extension's compiled binary when it is newer than the source;
  // a compile takes ~10s.
  const cached = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Code",
    "User",
    "globalStorage",
    "giladreich.claude-code-tts",
    "bin",
    "claude-code-tts-player-v4"
  );
  if (fs.existsSync(cached) && fs.statSync(cached).mtimeMs >= fs.statSync(src).mtimeMs) fs.copyFileSync(cached, bin);
  else {
    const r = spawnSync("swiftc", ["-O", "-o", bin, src], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("swiftc failed");
  }
  fs.chmodSync(bin, 0o755);
  return playerStorage;
}

/** Python that can run the daemons' logic against fake model modules. */
function pythonWithNumpy() {
  // uv's tool venvs live in different places and use a different layout on
  // Windows, so the compiled helper decides where to look.
  const { uvToolsDir, venvPython } = require(path.join(ROOT, "out", "platform", "platform.js"));
  const candidates = ["mlx-audio", "sherpa-onnx", "qwen-tts"]
    .map((t) => venvPython(path.join(uvToolsDir(), t)))
    .concat(["python3", "python"]);
  for (const p of candidates) {
    const r = spawnSync(p, ["-c", "import numpy"], { stdio: "ignore" });
    if (r.status === 0) return p;
  }
  return undefined;
}

module.exports = { ROOT, tmpDir, writeWav, sleep, until, isMac, hasSwiftc, playerStorageDir, pythonWithNumpy };
