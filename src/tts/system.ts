import { execFile, spawn } from "child_process";
import { hasCommand } from "../platform/platform";
import { Backend, VoiceInfo, wrapProcess } from "./types";

/**
 * The OS-provided engines: `say` on macOS, espeak/speech-dispatcher on Linux,
 * System.Speech via PowerShell on Windows. Instant and dependency-free.
 */
export function systemBackend(onError: (msg: string) => void): Backend | undefined {
  switch (process.platform) {
    case "darwin":
      return darwinBackend();
    case "linux": {
      const b = linuxBackend();
      if (!b) {
        onError("No TTS engine found. Install espeak-ng (or speech-dispatcher).");
      }
      return b;
    }
    case "win32":
      return windowsBackend();
    default:
      onError(`Unsupported platform for TTS: ${process.platform}`);
      return undefined;
  }
}

/** Enumerate installed voices for the current platform's system engine. */
export function listSystemVoices(): Promise<VoiceInfo[]> {
  return new Promise((resolve) => {
    const done = (v: VoiceInfo[]) => resolve(v);
    if (process.platform === "darwin") {
      execFile("say", ["-v", "?"], (err, stdout) => {
        if (err) {
          return done([]);
        }
        // "Samantha            en_US    # Hello! My name is Samantha."
        const voices: VoiceInfo[] = [];
        for (const line of stdout.split("\n")) {
          const m = line.match(/^(.+?)\s{2,}([a-zA-Z_-]+)\s+#\s*(.*)$/);
          if (m) {
            voices.push({ name: m[1].trim(), detail: `${m[2]} - ${m[3]}`, language: m[2].slice(0, 2).toLowerCase() });
          }
        }
        done(voices);
      });
    } else if (process.platform === "linux") {
      const bin = hasCmd("espeak-ng") ? "espeak-ng" : "espeak";
      execFile(bin, ["--voices"], (err, stdout) => {
        if (err) {
          return done([]);
        }
        const voices: VoiceInfo[] = [];
        for (const line of stdout.split("\n").slice(1)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 4) {
            voices.push({ name: cols[3], detail: cols[1], language: cols[1].slice(0, 2).toLowerCase() });
          }
        }
        done(voices);
      });
    } else if (process.platform === "win32") {
      const script =
        "Add-Type -AssemblyName System.Speech; " +
        "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
        "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }";
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], (err, stdout) => {
        if (err) {
          return done([]);
        }
        const voices: VoiceInfo[] = [];
        for (const line of stdout.split("\n")) {
          const [name, culture] = line.trim().split("|");
          if (name) {
            voices.push({ name, detail: culture, language: culture?.slice(0, 2).toLowerCase() });
          }
        }
        done(voices);
      });
    } else {
      done([]);
    }
  });
}

// Reading the disk, not running `which`: this decides the Linux engine, and
// it is asked during activation and on every engine rebuild.
const hasCmd = hasCommand;

function darwinBackend(): Backend {
  return {
    name: "say",
    canFreeze: true,
    speak({ text, wpm, voice, volume }, onDone, onError) {
      const args = ["-r", String(wpm)];
      if (voice) {
        args.push("-v", voice);
      }
      // "[[...]]" is say's embedded-command syntax; transcript text must not
      // be able to inject e.g. [[rate 900]].
      text = text.replace(/\[\[/g, "( (");
      if (volume < 100) {
        text = `[[volm ${(volume / 100).toFixed(2)}]] ${text}`;
      }
      // Text via stdin: no shell, no argv length limits.
      const child = spawn("say", args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.stdin?.end(text);
      return wrapProcess(child, true, "say", onDone, onError);
    },
  };
}

function linuxBackend(): Backend | undefined {
  if (hasCmd("espeak-ng") || hasCmd("espeak")) {
    const bin = hasCmd("espeak-ng") ? "espeak-ng" : "espeak";
    return {
      name: bin,
      canFreeze: true,
      speak({ text, wpm, voice, volume }, onDone, onError) {
        const args = ["-s", String(wpm), "--stdin"];
        if (voice) {
          args.push("-v", voice);
        }
        // Amplitude 0-200, default 100
        if (volume < 100) {
          args.push("-a", String(volume));
        }
        const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        child.stdin?.end(text);
        return wrapProcess(child, true, bin, onDone, onError);
      },
    };
  }
  if (hasCmd("spd-say")) {
    return {
      name: "spd-say",
      canFreeze: false, // audio comes from the daemon, not this process
      speak({ text, wpm, voice, volume }, onDone, onError) {
        // speech-dispatcher rate/volume are -100..100 around defaults.
        const rate = Math.max(-100, Math.min(100, Math.round((wpm - 200) / 2)));
        const args = ["-w", "-r", String(rate)];
        if (volume < 100) {
          args.push("-i", String(volume - 100));
        }
        if (voice) {
          args.push("-y", voice);
        }
        args.push(text); // truncated upstream, argv is safe
        const child = spawn("spd-say", args, { stdio: "ignore", windowsHide: true });
        return wrapProcess(child, false, "spd-say", onDone, onError);
      },
      cancel() {
        // Killing spd-say does not stop the daemon's audio; -C cancels it.
        const proc = spawn("spd-say", ["-C"], { stdio: "ignore", windowsHide: true });
        proc.on("error", () => {}); // a failed cancel must not raise in the host
      },
    };
  }
  return undefined;
}

function windowsBackend(): Backend {
  return {
    name: "powershell",
    canFreeze: false, // no SIGSTOP on win32
    speak({ text, wpm, voice, volume }, onDone, onError) {
      // System.Speech rate is -10..10 around ~200 wpm.
      const rate = Math.max(-10, Math.min(10, Math.round((wpm - 200) / 20)));
      const voicePs = voice.replace(/'/g, "''");
      const script =
        "Add-Type -AssemblyName System.Speech; " +
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
        `$s.Rate = ${rate}; ` +
        `$s.Volume = ${Math.max(0, Math.min(100, Math.round(volume)))}; ` +
        (voicePs ? `try { $s.SelectVoice('${voicePs}') } catch {}; ` : "") +
        "$s.Speak([Console]::In.ReadToEnd())";
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.stdin?.end(text);
      return wrapProcess(child, false, "powershell", onDone, onError);
    },
  };
}
