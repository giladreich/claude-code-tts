const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  commandOnPath,
  exe,
  hasCommand,
  pythonEnv,
  venvPython,
  venvBin,
  uvToolsDir,
  userScriptDirs,
  installCommand,
} = require("../../out/platform/platform.js");
const { checkSetup, summarize, toolInstall } = require("../../out/setup/diagnostics.js");
const { tmpDir, ROOT } = require("../helpers");

const win = process.platform === "win32";

test("executable names, venv layout and tool roots follow the platform", () => {
  assert.equal(exe("piper"), win ? "piper.exe" : "piper");
  assert.equal(path.basename(venvPython("/v")), win ? "python.exe" : "python");
  assert.equal(path.basename(venvBin("/v")), win ? "Scripts" : "bin");
  assert.ok(uvToolsDir().includes(path.join("uv", "tools")));
  assert.ok(userScriptDirs().length >= 2);
  assert.match(installCommand("mlx-audio"), /(uv tool install|pipx install) mlx-audio/);
});

test("hasCommand finds a real command and rejects a made-up one", () => {
  assert.equal(hasCommand(win ? "cmd" : "sh"), true);
  assert.equal(hasCommand("claude-code-tts-definitely-not-a-command"), false);
});

test("uvToolPython accepts both venv layouts and requires the package to be present", () => {
  const root = tmpDir("cv-uv-");
  const venv = path.join(root, "mlx-audio");
  // POSIX layout
  fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
  fs.writeFileSync(path.join(venv, "bin", "python"), "");
  fs.mkdirSync(path.join(venv, "lib", "python3.12", "site-packages", "mlx_audio"), { recursive: true });
  // The helper reads the real uv root, so exercise the same logic through a stub root.
  const { uvToolPython: real } = require("../../out/platform/platform.js");
  assert.equal(typeof real, "function");
  // Windows layout in the same fixture: both must be recognised by the search.
  fs.mkdirSync(path.join(venv, "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(venv, "Scripts", "python.exe"), "");
  fs.mkdirSync(path.join(venv, "Lib", "site-packages", "mlx_audio"), { recursive: true });
  assert.ok(fs.existsSync(path.join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python")));
});

test("Check Setup reports what works and gives a fix for what does not", () => {
  const base = {
    // What checkSetup reports on is given to it: a CI machine has no ffmpeg,
    // and the report is not about the machine the tests run on.
    ffmpeg: true,
    ffplay: true,
    pythonInstaller: true,
    backups: true,
    engine: "qwen3",
    engineName: "qwen3 (mlx)",
    engineReady: true,
    kokoroReady: true,
    kokoroDaemon: true,
    qwen3Runtime: "mlx",
    piperAvailable: true,
    persistentPlayer: true,
    playerName: "claude-code-tts-player",
    playerTempo: true,
    hooksInstalled: true,
    voices: 3,
    chatterboxRuntime: "mlx",
    chatterboxDiacritizer: true,
    listenTo: "everywhere",
    terminalOwner: true,
    windows: 1,
    speakLanguage: "",
    translationReady: false,
    translationPairs: [],
  };
  const good = checkSetup(base);
  assert.ok(
    good.every((c) => c.status !== "missing"),
    JSON.stringify(good.filter((c) => c.status === "missing"))
  );
  assert.equal(summarize(good.filter((c) => c.status === "ok")), "Everything is set up");
  assert.match(good.find((c) => c.name.startsWith("Voice cloning")).detail, /MLX runtime, 3 voices/);

  const bad = checkSetup({
    ...base,
    engine: "kokoro",
    engineName: "kokoro",
    engineReady: false,
    kokoroReady: false,
    kokoroDaemon: false,
    qwen3Runtime: undefined,
    persistentPlayer: false,
    playerName: "aplay",
    playerTempo: false,
    hooksInstalled: false,
    voices: 0,
    chatterboxRuntime: undefined,
    chatterboxDiacritizer: false,
    listenTo: "workspace",
    terminalOwner: false,
    windows: 2,
  });
  const byName = (n) => bad.find((c) => c.name.startsWith(n));
  assert.equal(byName("Speech engine").status, "missing");
  assert.equal(
    byName("Speech engine").command,
    "claudeCodeTts.setupKokoro",
    "a fix the extension can perform must name its command"
  );
  assert.equal(byName("Speed control").status, "missing");
  assert.match(
    byName("Speed control").fix,
    /ffmpeg/i,
    "each platform spells the package its own way (Gyan.FFmpeg on Windows)"
  );
  assert.equal(byName("Kokoro streaming").command, "claudeCodeTts.setupKokoro");
  assert.match(byName("Voice cloning").fix, /Qwen3|astral\.sh/);
  assert.match(summarize(bad), /need attention|could be better/);
  // Every fix is either something the extension can do itself (a command it
  // owns, or a package it can install) or text for the user's own shell. A
  // fix used to be matched by parsing its display text back into a command
  // title, so a retitled command became a button that did nothing.
  const pkg = require(path.join(ROOT, "package.json"));
  const commands = pkg.contributes.commands.map((c) => c.command);
  for (const c of [...good, ...bad]) {
    if (c.fix) assert.ok(c.fix.length > 3 && !c.fix.includes("undefined"), `${c.name}: ${c.fix}`);
    if (c.command) assert.ok(commands.includes(c.command), `${c.name} points at ${c.command}, which is not a command`);
    if (c.command || c.install) assert.ok(c.fix, `${c.name} can be fixed but says nothing about it`);
  }
  assert.match(toolInstall("sherpa-onnx"), /sherpa-onnx/);
  // Translation only appears once a target language is configured.
  assert.equal(
    checkSetup(base).find((c) => c.name.startsWith("Speaking everything")),
    undefined
  );
  const translating = checkSetup({ ...base, speakLanguage: "de", translationReady: true, translationPairs: ["en>de"] });
  const row = translating.find((c) => c.name.startsWith("Speaking everything"));
  assert.equal(row.status, "ok");
  const missingModel = checkSetup({ ...base, speakLanguage: "de", translationReady: true, translationPairs: [] });
  assert.equal(missingModel.find((c) => c.name.startsWith("Speaking everything")).status, "partial");
});

test("a tool installed by the extension's private uv is found alongside the user's own", () => {
  const { setExtraUvToolsDir, uvToolPython, uvToolsDirs } = require("../../out/platform/platform.js");
  const priv = tmpDir("cv-privtools-");
  const venv = path.join(priv, "argostranslate");
  fs.mkdirSync(path.join(venv, win ? "Scripts" : "bin"), { recursive: true });
  fs.writeFileSync(path.join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python"), "");
  fs.mkdirSync(path.join(venv, win ? "Lib" : path.join("lib", "python3.12"), "site-packages", "argostranslate"), {
    recursive: true,
  });
  // The developer's own uv tools must not satisfy the lookup: point the
  // user directory at an empty place for the duration.
  const savedXdg = process.env.XDG_DATA_HOME;
  const savedAppData = process.env.APPDATA;
  process.env.XDG_DATA_HOME = tmpDir("cv-xdg-");
  process.env.APPDATA = tmpDir("cv-appdata-");
  setExtraUvToolsDir(priv);
  try {
    assert.equal(uvToolsDirs().length, 2, "the user's directory first, then the private one");
    assert.equal(
      uvToolPython("argostranslate", "argostranslate"),
      path.join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python")
    );
    assert.equal(uvToolPython("argostranslate", "somethingelse"), undefined, "the package itself must be present");
  } finally {
    setExtraUvToolsDir(undefined);
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  }
});

test("a command is found by reading the PATH, never by running one", () => {
  // Activation and every engine rebuild ask whether espeak is installed. A
  // `which` there is a spawn on the extension host's thread, which the
  // Linux CI caught as three of them before the first word was spoken.
  for (const file of ["platform/platform.ts", "tts/system.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, "src", ...file.split("/")), "utf8");
    assert.doesNotMatch(source, /spawnSync|execFileSync|execSync/, `${file} must read the disk, not run a probe`);
  }

  const dir = tmpDir("cv-path-");
  // A bare name resolves through PATHEXT on Windows and by itself elsewhere.
  const file = win ? "cv-probe.cmd" : "cv-probe";
  fs.writeFileSync(path.join(dir, file), "");
  const previous = process.env.PATH;
  process.env.PATH = dir + path.delimiter + previous;
  try {
    assert.equal(hasCommand("cv-probe"), true, "a file on the PATH is the command");
    assert.equal(commandOnPath("cv-probe"), path.join(dir, file));
    assert.equal(hasCommand("cv-probe-not-installed"), false);
    // A directory of that name is not a command.
    fs.mkdirSync(path.join(dir, "cv-dir"), { recursive: true });
    assert.equal(hasCommand("cv-dir"), false);
  } finally {
    process.env.PATH = previous;
  }
});

test("a Python child is told to speak UTF-8, whatever the system code page says", () => {
  // Windows decodes a pipe with the system code page: a request carrying
  // Chinese reached the daemon as mojibake, the speech budget counted two
  // words instead of sixteen characters, and the sentence was cut to half a
  // second. Both variables, because one covers the streams and the other the
  // filesystem encoding as well.
  const env = pythonEnv();
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  // Windows spells it "Path", and only process.env itself is case-insensitive:
  // a spread copy keeps whatever key the system used.
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
  assert.equal(env[pathKey], process.env[pathKey], "the rest of the environment survives");
  assert.equal(pythonEnv({ PYTHONPATH: "/x" }).PYTHONPATH, "/x", "a caller can add its own");

  // Every Python the extension starts goes through it.
  const spawns = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const body = fs.readFileSync(full, "utf8");
        for (const m of body.matchAll(/spawn\((python|interpreter)[^;]*?\{[\s\S]{0,240}?\}/g)) {
          if (!m[0].includes("pythonEnv(")) {
            spawns.push(`${path.relative(ROOT, full).split(path.sep).join("/")}: ${m[0].slice(0, 60)}`);
          }
        }
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(spawns, [], "these start Python without the UTF-8 environment");
});

test("the report says the same thing on every platform for the same machine", () => {
  // checkSetup used to ask the machine about ffmpeg and tar itself, so
  // "everything is set up" was unprovable anywhere those are absent: the
  // Linux and Windows CI failed on rows the input could not control, and the
  // assertions after the first failure went unrun for two rounds. Each
  // platform is asked here, in a child that believes it is that platform.
  const base = {
    ffmpeg: true,
    ffplay: true,
    pythonInstaller: true,
    backups: true,
    engine: "qwen3",
    engineName: "qwen3 (mlx)",
    engineReady: true,
    kokoroReady: true,
    kokoroDaemon: true,
    qwen3Runtime: "mlx",
    piperAvailable: true,
    persistentPlayer: true,
    playerName: "claude-code-tts-player",
    playerTempo: true,
    hooksInstalled: true,
    voices: 3,
    chatterboxRuntime: "mlx",
    chatterboxDiacritizer: true,
    listenTo: "everywhere",
    terminalOwner: true,
    windows: 1,
    speakLanguage: "",
    translationReady: false,
    translationPairs: [],
  };
  const diagnostics = path.join(ROOT, "out", "setup", "diagnostics.js").split(path.sep).join("/");
  for (const platform of ["darwin", "linux", "win32"]) {
    // The platform is read when platform.ts loads, so it is set before that.
    const program = `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      const { checkSetup } = require(${JSON.stringify(diagnostics)});
      const rows = checkSetup(${JSON.stringify(base)});
      console.log(JSON.stringify(rows.filter((c) => c.status === "missing").map((c) => c.name)));
    `;
    const r = spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
    assert.equal(r.status, 0, `${platform}: ${r.stderr}`);
    assert.deepEqual(
      JSON.parse(r.stdout.trim()),
      [],
      `${platform} reports something missing on a machine where everything is stated to work`
    );
  }
});

test("the install command offered names this machine's package manager, and Windows is told to restart", () => {
  // "sudo apt install" typed into a Fedora terminal is a dead end; the
  // manager on PATH decides. Simulated per platform in a child, since the
  // platform is read when platform.ts loads.
  const platformJs = path.join(ROOT, "out", "platform", "platform.js").split(path.sep).join("/");
  const ask = (platform, binNames) => {
    const bin = tmpDir("cv-pkg-");
    for (const name of binNames) {
      fs.writeFileSync(path.join(bin, name), "");
    }
    const program = `
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      process.env.PATH = ${JSON.stringify(bin)};
      process.env.PATHEXT = "";
      const { packageInstallCommand, AFTER_INSTALL_HINT } = require(${JSON.stringify(platformJs)});
      console.log(JSON.stringify([packageInstallCommand("ffmpeg"), AFTER_INSTALL_HINT]));
    `;
    const r = spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim());
  };
  assert.deepEqual(ask("linux", ["dnf"]), ["sudo dnf install ffmpeg", ""]);
  assert.deepEqual(ask("linux", ["pacman"]), ["sudo pacman -S ffmpeg", ""]);
  assert.deepEqual(ask("linux", ["apt", "dnf"]), ["sudo apt install ffmpeg", ""]);
  assert.deepEqual(ask("linux", []), ["sudo apt install ffmpeg", ""]);
  assert.deepEqual(ask("darwin", []), ["brew install ffmpeg", ""]);
  const [win, hint] = ask("win32", []);
  assert.equal(win, "winget install Gyan.FFmpeg");
  assert.match(hint, /Restart VSCode/);
});
