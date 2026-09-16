#!/usr/bin/env node
// Claude Code TTS notification hook. Installed into ~/.claude/settings.json by
// the VSCode extension; plays a per-category system sound for Claude Code
// events. Works for terminal sessions and even when VSCode is closed. Local.
//
// Usage: node notify.js <stop|permission|question|notification|tool|subagent|prompt>
//   "notification" classifies itself into permission/waiting from the hook
//   payload; "tool" filters by tool name against cfg.toolFilter.
// Config: ~/.claude/claude-code-tts-notify.json (written by the extension).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/**
 * The user's settings file is never truncated in place: the new contents go
 * to a sibling file and are renamed over it, so a crash or another writer at
 * the same moment leaves the old file rather than an empty one. Windows can
 * refuse the rename while another process holds the file; it is retried for
 * a while and then given up, never copied over the target: a copy is the
 * truncation this exists to avoid, and the hook is removed at the next event.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(e && e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt);
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/**
 * VSCode runs no code when an extension is uninstalled, so nothing on that
 * side can take these hooks out of ~/.claude/settings.json. This script can:
 * it runs on every Claude Code event, it knows where the extension lived, and
 * a hook whose extension is gone should take itself with it rather than leave
 * Claude Code starting a process for a missing feature.
 *
 * Conservative on purpose: it acts only when the extensions directory is
 * readable and holds no version of the extension, and it removes only entries
 * that run this script.
 */
function removeSelfIfExtensionGone(cfg) {
  if (!cfg.extensionsDir || !cfg.extensionId) return false;
  let installed;
  try {
    installed = fs.readdirSync(cfg.extensionsDir);
  } catch {
    return false; // cannot tell: leave everything alone
  }
  if (installed.some((name) => name === cfg.extensionId || name.startsWith(cfg.extensionId + "-"))) return false;

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    const mine = (hook) => String(hook && hook.command).includes("claude-code-tts-notify.js");
    let changed = false;
    for (const event of Object.keys(settings.hooks || {})) {
      const groups = [];
      for (const group of settings.hooks[event]) {
        const kept = (group.hooks || []).filter((h) => !mine(h));
        if (kept.length !== (group.hooks || []).length) changed = true;
        if (kept.length) groups.push({ ...group, hooks: kept });
      }
      if (groups.length) settings.hooks[event] = groups;
      else delete settings.hooks[event];
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    if (changed) writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    /* no settings file, or not ours to rewrite */
  }
  try {
    fs.unlinkSync(path.join(os.homedir(), ".claude", "claude-code-tts-notify.json"));
  } catch {}
  return true;
}

function run(payload) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude", "claude-code-tts-notify.json"), "utf8").replace(/^\uFEFF/, "")
    );
    if (removeSelfIfExtensionGone(cfg)) return;
    if (!cfg.enabled) return;
    const sounds = cfg.sounds ?? {};

    let kind = process.argv[2] || "stop";
    if (kind === "notification") {
      const msg = String(payload.message ?? "").toLowerCase();
      kind = msg.includes("permission") || msg.includes("approv") ? "permission" : "waiting";
    } else if (kind === "tool") {
      const filter = Array.isArray(cfg.toolFilter) ? cfg.toolFilter : ["Bash"];
      if (!filter.includes(String(payload.tool_name ?? ""))) return;
    }

    // Per-category sound; empty means off. Old configs had a single
    // "attention" sound covering permission/question/waiting.
    let sound = sounds[kind];
    if (sound === undefined && ["permission", "question", "waiting"].includes(kind)) {
      sound = sounds.attention ?? cfg.attentionSound;
    }
    if (sound === undefined && kind === "stop") sound = cfg.doneSound;
    if (!sound) return;

    // Several hook events can fire for one moment (Notification +
    // PermissionRequest); suppress repeats of the same kind within 1.5s.
    // Per user: a shared /tmp on a multi-user host must not let one session
    // suppress another's sounds.
    const who = (os.userInfo && os.userInfo().username) || process.env.USER || process.env.USERNAME || "user";
    const state = path.join(os.tmpdir(), `claude-code-tts-notify-${who}.last`);
    try {
      const prev = JSON.parse(fs.readFileSync(state, "utf8"));
      if (prev.kind === kind && Date.now() - prev.at < 1500) return;
    } catch {}
    try {
      fs.writeFileSync(state, JSON.stringify({ kind, at: Date.now() }));
    } catch {}

    const vol = Math.max(0, Math.min(100, cfg.volume ?? 70)) / 100;
    // The player outlives this process, which exits at once so Claude Code
    // is not kept waiting. On Windows a child spawned detached exited within
    // 60 ms without playing (measured with a marker file; PowerShell and
    // ffplay alike), and one started through cmd's "start /b" played but
    // opened a console window for its length. So there the player is
    // started by a PowerShell of its own through Start-Process with the
    // window hidden, a process the hook's exit does not touch; the hook
    // waits for that launcher (about 200 ms; a child still starting when
    // node exits is killed with it, since node keeps its children in a
    // job), and no window is created.
    const fire = (cmd, args) => {
      if (process.platform === "win32") {
        const quote = (a) => `'${String(a).replace(/'/g, "''")}'`;
        const launch = `Start-Process -WindowStyle Hidden -FilePath ${quote(cmd)} -ArgumentList ${args.map(quote).join(",")}`;
        try {
          require("child_process").spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", launch], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
          });
        } catch {}
        return;
      }
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => {}); // missing player binary: stay silent, never crash the hook
      child.unref();
    };

    // The configured sound is one of the extension's own ("builtin/done",
    // copied next to this script by the extension), a file of the user's
    // (an absolute path), or a name from this platform's sound library; the
    // per-kind defaults below are only used when that name is not found, so
    // the same configuration works on macOS, Linux and Windows.
    // Sound themes live in different places per distribution, so several
    // directories are searched rather than one.
    const library =
      process.platform === "darwin"
        ? { dirs: ["/System/Library/Sounds"], ext: [".aiff"] }
        : process.platform === "win32"
          ? { dirs: [path.join(process.env.SystemRoot || "C:\\Windows", "Media")], ext: [".wav"] }
          : {
              dirs: [
                "/usr/share/sounds/freedesktop/stereo",
                "/usr/share/sounds/gnome/default/alerts",
                "/usr/share/sounds/ubuntu/stereo",
                "/usr/share/sounds",
              ],
              ext: [".oga", ".ogg", ".wav"],
            };
    const fallbacks =
      {
        darwin: {
          stop: "Glass",
          permission: "Funk",
          question: "Ping",
          waiting: "Purr",
          tool: "Pop",
          subagent: "Pop",
          prompt: "Tink",
        },
        linux: {
          stop: "complete",
          permission: "dialog-warning",
          question: "dialog-information",
          waiting: "dialog-information",
          tool: "message",
          subagent: "message",
          prompt: "audio-volume-change",
        },
        // Windows 11 ships fewer sounds than Windows 10 ("Windows Proceed"
        // is gone), so each kind names a chain and the first one present
        // plays; without that, a machine set up with another platform's
        // sound names heard nothing at all and nothing said why.
        win32: {
          stop: ["Windows Proceed", "Windows Notify System Generic", "notify"],
          permission: ["Windows Notify", "Windows Notify System Generic", "notify"],
          question: ["Windows Notify Calendar", "Windows Notify", "notify"],
          waiting: ["Windows Notify Messaging", "Windows Notify", "notify"],
          tool: ["Windows Navigation Start", "Windows Menu Command", "ding"],
          subagent: ["Windows Print complete", "Windows Background", "ding"],
          prompt: ["Windows Navigation Start", "Windows Menu Command", "ding"],
        },
      }[process.platform] || {};
    const builtin = (candidate) => {
      const m = /^builtin\/([a-z0-9-]+)$/.exec(candidate);
      if (!m || !cfg.soundsDir) return undefined;
      const f = path.join(cfg.soundsDir, `${m[1]}.wav`);
      return fs.existsSync(f) ? f : undefined;
    };
    const resolve = (name) => {
      // The extension's own sound for this kind comes before the platform's
      // chain: a name this machine does not have (a setting synced from
      // another platform) is heard as the same sound everywhere.
      for (const candidate of [name, `builtin/${kind === "stop" ? "done" : kind}`].concat(fallbacks[kind] || [])) {
        if (!candidate) continue;
        if (path.isAbsolute(candidate)) {
          if (fs.existsSync(candidate)) return candidate;
          continue;
        }
        const own = builtin(candidate);
        if (own) return own;
        if (candidate.startsWith("builtin/")) continue;
        for (const dir of library.dirs) {
          for (const e of library.ext) {
            const f = path.join(dir, candidate + e);
            if (fs.existsSync(f)) return f;
          }
        }
      }
      return undefined;
    };
    const file = resolve(sound);
    if (!file) return;
    // For the tests: say which file would play instead of playing it.
    if (process.env.CLAUDE_CODE_TTS_NOTIFY_PRINT) {
      process.stdout.write(`${file}\n`);
      return;
    }
    // Silent is silent: no player is started for a volume of zero (the
    // tests run at zero, and a player that touches the profile directory
    // while a test removes it fails the test on Windows).
    if (vol <= 0) return;

    // ffplay (from ffmpeg) is used wherever it exists because it is the only
    // one of these that honours the volume setting on every platform.
    const has = (cmd) => {
      try {
        return (
          require("child_process").spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
            stdio: "ignore",
          }).status === 0
        );
      } catch {
        return false;
      }
    };
    if (process.platform === "darwin") {
      fire("afplay", ["-v", vol.toFixed(2), file]);
    } else if (has("ffplay")) {
      fire("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", "-af", `volume=${vol.toFixed(2)}`, file]);
    } else if (process.platform === "win32") {
      // WPF's MediaPlayer rather than System.Media.SoundPlayer: it takes a
      // volume (the system sounds are quiet, and the setting did nothing
      // here), and plays MP3 as well as WAV for a file of the user's own.
      // No message loop in a plain PowerShell, so the end is polled.
      const psFile = file.replace(/'/g, "''");
      fire("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Volume = ${vol.toFixed(2)}; $p.Open([Uri]'${psFile}'); $p.Play(); $t = 0; while ($t -lt 15000) { Start-Sleep -Milliseconds 25; $t += 25; if ($p.NaturalDuration.HasTimeSpan -and $p.Position -ge $p.NaturalDuration.TimeSpan) { break } }; Start-Sleep -Milliseconds 250; $p.Close()`,
      ]);
    } else if (has("paplay")) {
      fire("paplay", ["--volume=" + Math.round(vol * 65536), file]);
    } else if (has("canberra-gtk-play")) {
      fire("canberra-gtk-play", ["-f", file]);
    } else if (has("play")) {
      fire("play", ["-q", file, "vol", vol.toFixed(2)]);
    } else if (has("aplay") && file.endsWith(".wav")) {
      fire("aplay", ["-q", file]);
    }
  } catch {
    /* never break a Claude session over a sound */
  }
}

// "notification" and "tool" need the hook's stdin JSON; everything else can
// fire immediately without waiting on stdin.
const argKind = process.argv[2];
if (argKind === "notification" || argKind === "tool") {
  let data = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let payload = {};
    try {
      payload = JSON.parse(data);
    } catch {}
    run(payload);
    process.exit(0);
  };
  process.stdin.on("data", (d) => (data += d));
  process.stdin.on("end", finish);
  setTimeout(finish, 250);
} else {
  run({});
  process.exit(0);
}
