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
    if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
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
    const fire = (cmd, args) => {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => {}); // missing player binary: stay silent, never crash the hook
      child.unref();
    };

    // The configured sound is a name from this platform's sound library; the
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
        win32: {
          stop: "Windows Proceed",
          permission: "Windows Notify",
          question: "Windows Notify",
          waiting: "Windows Notify",
          tool: "Windows Navigation Start",
          subagent: "Windows Print complete",
          prompt: "Windows Navigation Start",
        },
      }[process.platform] || {};
    const resolve = (name) => {
      for (const candidate of [name, fallbacks[kind]]) {
        if (!candidate) continue;
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
      const psFile = file.replace(/'/g, "''");
      fire("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object Media.SoundPlayer '${psFile}').PlaySync()`,
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
