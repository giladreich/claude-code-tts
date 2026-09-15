import { ChildProcess, execFile, spawn } from "child_process";
import * as readline from "readline";
import { hasCommand } from "../platform/platform";
import { reportPlayed } from "./played";
import { Backend, killProcess, SpeakRequest, Speaker, VoiceInfo, wrapProcess } from "./types";

/**
 * The OS-provided engines: `say` on macOS, espeak/speech-dispatcher on Linux,
 * System.Speech via PowerShell on Windows. Instant and dependency-free.
 * `hostScript` is the persistent Windows speech host (see windowsBackend).
 */
export function systemBackend(onError: (msg: string) => void, hostScript?: string): Backend | undefined {
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
      return windowsBackend(hostScript);
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

/** How a request is rendered again for an export: the same voice and rate, no volume. */
type Render = (outWav: string) => Promise<void>;

/**
 * Speak through a child process and, once it has finished on its own, offer
 * the utterance for keeping together with a way to render it again. These
 * engines write no file while they speak, so the audio for an export is made
 * later, in the background, by the same engine with the same voice and rate:
 * the speaking path pays nothing for it.
 */
function speakAndReport(
  child: ChildProcess,
  name: string,
  canFreeze: boolean,
  req: SpeakRequest,
  render: Render | undefined,
  onDone: () => void,
  onError: (msg: string) => void
): Speaker {
  const startedAt = Date.now();
  let killed = false;
  let exitCode: number | null = null;
  // Registered before wrapProcess's own exit handler, so the code is known
  // by the time onDone runs.
  child.on("exit", (code) => (exitCode = code));
  const speaker = wrapProcess(
    child,
    canFreeze,
    name,
    () => {
      if (!killed && exitCode === 0 && render && !req.preview) {
        reportPlayed({
          text: req.text,
          engine: name,
          voice: req.voice,
          wpm: req.wpm,
          language: req.language,
          group: req.group,
          tempo: 1,
          synthSpeed: 1,
          startedAt,
          endedAt: Date.now(),
          render,
        });
      }
      onDone();
    },
    onError
  );
  return {
    ...speaker,
    kill: () => {
      killed = true;
      speaker.kill();
    },
  };
}

/** A render that takes longer than this is not going to finish; it is killed rather than waited for. */
const RENDER_TIMEOUT_MS = 90_000;

/** Resolves when a rendering process exits cleanly; the last stderr line otherwise. */
function rendered(child: ChildProcess, stdinText: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      killProcess(child);
      reject(new Error(`${name} took too long to render`));
    }, RENDER_TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-400)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        return resolve();
      }
      const reason = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
      reject(new Error(`${name} exited with ${code}${reason ? `: ${reason.slice(0, 200)}` : ""}`));
    });
    child.stdin?.end(stdinText);
  });
}

// "[[...]]" is say's embedded-command syntax; transcript text must not be
// able to inject e.g. [[rate 900]].
const saySafe = (text: string): string => text.replace(/\[\[/g, "( (");

/** The same utterance `say` spoke, written as a 16-bit WAV. */
function renderDarwin(req: SpeakRequest, out: string): Promise<void> {
  // 16-bit at the voice's own sample rate: naming a rate here would resample
  // a voice that speaks at a higher one.
  // prettier-ignore
  const args = [
    "-o", out, "--file-format=WAVE", "--data-format=LEI16",
    "-r", String(req.wpm), ...(req.voice ? ["-v", req.voice] : []),
  ];
  const child = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  return rendered(child, saySafe(req.text), "say");
}

function darwinBackend(): Backend {
  return {
    name: "say",
    canFreeze: true,
    speak(req, onDone, onError) {
      const { wpm, voice, volume } = req;
      const args = ["-r", String(wpm)];
      if (voice) {
        args.push("-v", voice);
      }
      let text = saySafe(req.text);
      if (volume < 100) {
        text = `[[volm ${(volume / 100).toFixed(2)}]] ${text}`;
      }
      // Text via stdin: no shell, no argv length limits.
      const child = spawn("say", args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.stdin?.end(text);
      return speakAndReport(child, "say", true, req, (out) => renderDarwin(req, out), onDone, onError);
    },
  };
}

/** The same utterance espeak spoke, written as a WAV. */
function renderEspeak(bin: string, req: SpeakRequest, out: string): Promise<void> {
  const args = ["-s", String(req.wpm), "--stdin", "-w", out, ...(req.voice ? ["-v", req.voice] : [])];
  const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  return rendered(child, req.text, bin);
}

function linuxBackend(): Backend | undefined {
  if (hasCmd("espeak-ng") || hasCmd("espeak")) {
    const bin = hasCmd("espeak-ng") ? "espeak-ng" : "espeak";
    return {
      name: bin,
      canFreeze: true,
      speak(req, onDone, onError) {
        const { text, wpm, voice, volume } = req;
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
        return speakAndReport(child, bin, true, req, (out) => renderEspeak(bin, req, out), onDone, onError);
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

/** System.Speech rate is -10..10 around ~200 wpm. */
const sapiRate = (wpm: number): number => Math.max(-10, Math.min(10, Math.round((wpm - 200) / 20)));

const psQuote = (s: string): string => s.replace(/'/g, "''");

/**
 * The text arrives on stdin as UTF-8, and the console would otherwise decode
 * it with the system code page: a sentence with an accent or another script
 * in it was read as other characters.
 */
const PS_UTF8 = "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ";

/** The same utterance System.Speech spoke, written as a WAV. */
function renderWindows(req: SpeakRequest, out: string): Promise<void> {
  const voicePs = psQuote(req.voice);
  const script =
    PS_UTF8 +
    "Add-Type -AssemblyName System.Speech; " +
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
    `$s.Rate = ${sapiRate(req.wpm)}; ` +
    (voicePs ? `try { $s.SelectVoice('${voicePs}') } catch {}; ` : "") +
    `$s.SetOutputToWaveFile('${psQuote(out)}'); ` +
    "$s.Speak([Console]::In.ReadToEnd()); $s.Dispose()";
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  return rendered(child, req.text, "powershell");
}

/** A sentence spoken by its own PowerShell process: the way it was done before the host, kept as the fallback. */
function speakWindowsPerProcess(req: SpeakRequest, onDone: () => void, onError: (msg: string) => void): Speaker {
  const { text, wpm, voice, volume } = req;
  const voicePs = psQuote(voice);
  const script =
    PS_UTF8 +
    "Add-Type -AssemblyName System.Speech; " +
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
    `$s.Rate = ${sapiRate(wpm)}; ` +
    `$s.Volume = ${Math.max(0, Math.min(100, Math.round(volume)))}; ` +
    (voicePs ? `try { $s.SelectVoice('${voicePs}') } catch {}; ` : "") +
    "$s.Speak([Console]::In.ReadToEnd())";
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.stdin?.end(text);
  return speakAndReport(child, "powershell", false, req, (out) => renderWindows(req, out), onDone, onError);
}

/** What the host answers to one request. */
interface HostReply {
  id: number;
  ok: boolean;
  error?: string;
  cancelled?: boolean;
}

/**
 * The persistent speech host (assets/sapi_host.ps1): one PowerShell process
 * for the session, with a synthesizer speaking and another rendering
 * exports, driven by JSON lines. Starting a PowerShell, loading the speech
 * assemblies and opening the audio device for every sentence was a second or
 * two of silence between sentences on a laptop, and speech fell behind
 * Claude; it also made pausing mid-word impossible, since a process on
 * Windows cannot be frozen.
 */
class SapiHost {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: HostReply) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<void>;
  /** The host started and answered; a failure after this is a crash, not a machine that cannot run it. */
  everReady = false;
  alive = true;
  private failed: (why: string) => void = () => {};

  constructor(script: string) {
    this.proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => ((readyResolve = res), (readyReject = rej)));
    this.ready.catch(() => {});
    const readyTimer = setTimeout(() => this.fail("did not start within 30s"), 30_000);
    readyTimer.unref?.();
    this.failed = (why) => {
      clearTimeout(readyTimer);
      readyReject(new Error(why));
    };
    let stderr = "";
    this.proc.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-400)));
    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if ("ready" in msg) {
        if (msg.ready) {
          clearTimeout(readyTimer);
          this.everReady = true;
          readyResolve();
        } else {
          this.fail(String(msg.error ?? "System.Speech could not be loaded"));
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg as HostReply);
      }
    });
    this.proc.on("error", (e) => this.fail(e.message));
    // A write into a host that has just died raises on the pipe, not on the
    // process; unhandled, that is an exception in the extension host.
    this.proc.stdin?.on("error", (e) => this.fail(`stdin closed: ${e.message}`));
    this.proc.on("exit", (code) => {
      const reason = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
      this.fail(`exited with ${code}${reason ? `: ${reason.slice(0, 200)}` : ""}`);
    });
  }

  private fail(why: string): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.failed(why);
    for (const p of this.pending.values()) {
      p.reject(new Error(why));
    }
    this.pending.clear();
    killProcess(this.proc);
  }

  /** Send a request the host answers by id. */
  request(msg: Record<string, unknown>): Promise<HostReply> {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        return reject(new Error("speech host stopped"));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ id, ...msg });
    });
  }

  /** Send a control message nothing answers. */
  send(msg: Record<string, unknown>): void {
    if (this.alive) {
      this.write(msg);
    }
  }

  private write(msg: Record<string, unknown>): void {
    try {
      this.proc.stdin?.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  dispose(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    for (const p of this.pending.values()) {
      p.reject(new Error("speech host stopped"));
    }
    this.pending.clear();
    try {
      this.proc.stdin?.end(JSON.stringify({ quit: true }) + "\n");
    } catch {
      /* already gone */
    }
    const grace = setTimeout(() => killProcess(this.proc), 2000);
    grace.unref?.();
    this.proc.once("exit", () => clearTimeout(grace));
  }
}

function windowsBackend(hostScript: string | undefined): Backend {
  let host: SapiHost | undefined;
  /** The host could not start on this machine: a process per sentence for the rest of the session. */
  let hostBroken = false;
  /** This backend was replaced or shut down: a render that runs later must not start a host nothing will stop. */
  let disposed = false;
  const hostFor = (): SapiHost | undefined => {
    if (!hostScript || hostBroken || disposed) {
      return undefined;
    }
    if (!host?.alive) {
      host = new SapiHost(hostScript);
    }
    return host;
  };
  /** The same utterance rendered again for an export, through the host, or by a process when there is none. */
  const renderThrough = (req: SpeakRequest): Render => {
    return async (out) => {
      const h = hostFor();
      if (!h) {
        return renderWindows(req, out);
      }
      await h.ready;
      const reply = await h.request({ render: req.text, out, rate: sapiRate(req.wpm), voice: req.voice });
      if (!reply.ok) {
        throw new Error(reply.error ?? "render failed");
      }
    };
  };
  return {
    name: "powershell",
    canFreeze: true,
    speak(req, onDone, onError) {
      const h = hostFor();
      if (!h) {
        return speakWindowsPerProcess(req, onDone, onError);
      }
      const { text, wpm, voice, volume } = req;
      const startedAt = Date.now();
      let finished = false;
      let killed = false;
      /** The process speaking this sentence instead, when the host turned out not to start. */
      let fallback: Speaker | undefined;
      const finish = () => {
        if (!finished) {
          finished = true;
          onDone();
        }
      };
      h.ready
        .then(() => {
          if (killed) {
            return undefined;
          }
          return h.request({ speak: text, rate: sapiRate(wpm), volume: Math.round(volume), voice });
        })
        .then(
          (reply) => {
            if (reply && !killed && !reply.ok && !reply.cancelled) {
              onError(`powershell failed: ${reply.error ?? "unknown error"}`);
            }
            if (reply?.ok && !killed && !req.preview) {
              reportPlayed({
                text,
                engine: "powershell",
                voice,
                wpm,
                language: req.language,
                group: req.group,
                tempo: 1,
                synthSpeed: 1,
                startedAt,
                endedAt: Date.now(),
                render: renderThrough(req),
              });
            }
            finish();
          },
          (e: Error) => {
            if (finished || killed) {
              return finish();
            }
            if (!h.everReady) {
              // This machine will not run the host (a PowerShell that cannot
              // load System.Speech): the old way, a process per sentence,
              // still speaks, so this sentence and the rest go that way.
              hostBroken = true;
              onError(`the speech host did not start (${e.message}); speaking through a process per sentence`);
              finished = true;
              fallback = speakWindowsPerProcess(req, onDone, onError);
              return;
            }
            onError(`powershell failed: ${e.message}`);
            finish();
          }
        );
      return {
        kill: () => {
          killed = true;
          fallback?.kill();
          // Only the sentence still in progress: a late kill on a finished
          // one would cut whatever the host is speaking by now.
          if (!finished) {
            h.send({ cancel: true });
          }
        },
        freeze: () => h.send({ pause: true }),
        unfreeze: () => h.send({ resume: true }),
      };
    },
    setLiveVolume(volume) {
      host?.send({ volume: Math.round(volume) });
    },
    dispose() {
      disposed = true;
      host?.dispose();
      host = undefined;
    },
  };
}
