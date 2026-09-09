import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execFile } from "child_process";
import { wavFileSeconds } from "./wav";

/** Name of macOS's current default output device, for actionable warnings. */
function defaultOutputDevice(cb: (name: string) => void): void {
  execFile("system_profiler", ["SPAudioDataType", "-json"], { timeout: 8000 }, (err, stdout) => {
    if (err) {
      return cb("unknown");
    }
    try {
      const items = JSON.parse(stdout).SPAudioDataType?.[0]?._items ?? [];
      const def = items.find((d: any) => d.coreaudio_default_audio_output_device === "spaudio_yes");
      cb(def?._name ?? "unknown");
    } catch {
      cb("unknown");
    }
  });
}

/**
 * Persistent WAV playback for macOS. afplay costs 1-1.5s of device
 * open/teardown per invocation; a tiny bundled Swift player (compiled once at
 * activation, in the background) keeps the device open and plays each file
 * with ~0.3s overhead, including pitch-preserving tempo. Falls back to
 * afplay wherever the compiler is unavailable.
 */
let binPath: string | undefined;
let compiling = false;
/** Set when the persistent player proved unreliable this session; afplay takes over. */
let disabled = false;
let logFile: string | undefined;
let onErrorGlobal: (msg: string) => void = () => {};

function logLine(s: string): void {
  if (!logFile) {
    return;
  }
  fs.appendFile(logFile, `${new Date().toISOString()} ${s}\n`, () => {});
}

/** Bump when the stdin protocol changes; forces a recompile on update. */
const BIN_NAME = "claude-code-tts-player-v4";

export function initPersistentPlayer(storageDir: string, swiftSource: string, onError: (msg: string) => void): void {
  onErrorGlobal = onError;
  logFile = path.join(storageDir, "player.log");
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(logFile, ""); // fresh per activation
  } catch {}
  if (process.platform !== "darwin" || compiling || binPath) {
    return;
  }
  // Remove protocol-incompatible older builds.
  for (const old of ["claude-code-tts-player", "claude-code-tts-player-v2", "claude-code-tts-player-v3"]) {
    fs.rm(path.join(storageDir, "bin", old), { force: true }, () => {});
  }
  const bin = path.join(storageDir, "bin", BIN_NAME);
  // Newer than its source, or it was built from Swift this version no longer
  // ships and has to be built again.
  let fresh = false;
  try {
    fresh = fs.statSync(bin).mtimeMs >= fs.statSync(swiftSource).mtimeMs;
  } catch {}
  if (fresh) {
    binPath = bin;
    return;
  }
  // A binary that exists but is older than the source is still a working
  // player. Use it while the rebuild is attempted, and keep it if the
  // rebuild cannot happen at all, rather than dropping to afplay because a
  // file's timestamp moved.
  const stale = fs.existsSync(bin);
  if (stale) {
    binPath = bin;
  }
  if (!fs.existsSync(swiftSource)) {
    return;
  }
  // Only compile when the CommandLineTools are already installed; probing
  // swiftc without them pops Apple's install dialog.
  if (spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) {
    return;
  }
  compiling = true;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const proc = spawn("swiftc", ["-O", "-o", bin, swiftSource], { stdio: "ignore" });
  proc.on("exit", (code) => {
    compiling = false;
    if (code === 0) {
      binPath = bin;
    } else if (!stale) {
      onError("wavplayer compile failed; staying on afplay");
    }
  });
  proc.on("error", () => {
    compiling = false;
  });
}

export interface Playback {
  done: Promise<void>;
  cancel(): void;
  freeze(): void;
  unfreeze(): void;
  /** Streaming: queue a further audio part of this same utterance; mark the
   *  last one final so "done" fires after it. Gapless. */
  append(file: string, isFinal: boolean): void;
}

/** Duration of a PCM WAV (chunk-aware); undefined if unreadable. */
export function wavDurationSeconds(file: string): number | undefined {
  return wavFileSeconds(file);
}

class PersistentPlayer {
  private proc: ChildProcess | undefined;
  /** The playback whose completion we are waiting for, keyed by stream id. */
  private current: { id: number; resolve: () => void; reject: (e: Error) => void } | undefined;
  private nextId = 1;

  constructor(private bin: string) {}

  private ensureProc(): ChildProcess {
    if (this.proc) {
      return this.proc;
    }
    const proc = spawn(this.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr?.on("data", (d) => logLine(`[player] ${String(d).trimEnd()}`));
    logLine(`[node] spawned player pid=${proc.pid}`);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready) {
        return;
      }
      const cur = this.current;
      if (!cur) {
        return;
      }
      // A stop followed immediately by a new play yields a "done" for the
      // OLD stream; ids keep it from completing the new one prematurely.
      if (typeof msg.id === "number" && msg.id !== cur.id) {
        logLine(`[node] ignoring ${msg.done ? "done" : "error"} for stream ${msg.id} (current ${cur.id})`);
        return;
      }
      this.current = undefined;
      if (msg.done) {
        cur.resolve();
      } else {
        cur.reject(new Error(String(msg.error ?? "playback failed")));
      }
    });
    proc.on("exit", () => {
      if (this.proc === proc) {
        this.proc = undefined;
      }
      const cur = this.current;
      this.current = undefined;
      cur?.reject(new Error("player exited"));
    });
    proc.on("error", () => {
      if (this.proc === proc) {
        this.proc = undefined;
      }
    });
    this.proc = proc;
    return proc;
  }

  private send(obj: Record<string, unknown>): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
      /* process gone; exit handler rejects pending playback */
    }
  }

  private earlyDones = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  /**
   * A long-lived player can end up holding a stale CoreAudio device
   * connection (e.g. a Bluetooth headset that dozed off), which renders
   * silence forever. Respawning after idle time is cheap (~50ms) and gives
   * each burst of speech a fresh connection to the current output device.
   */
  private scheduleIdleRecycle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (!this.current && this.proc) {
        logLine("[node] idle 5min: recycling player process");
        this.dispose();
      }
    }, 300_000);
  }

  /**
   * Play one file (or start a multi-part stream when isFinal is false; use
   * append() for further parts). The extension's queue guarantees serial use.
   */
  play(file: string, tempo: number, volume: number, isFinal = true): Playback {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.ensureProc();
    // Deadline math assumes the slowest tempo the user could switch to
    // mid-play (0.5x): a false watchdog kill costs speech, a late one only
    // delays stall recovery.
    const budgetMs = (secs: number) => (secs / 0.5) * 1000;
    let audioSecs = wavDurationSeconds(file) ?? 0;
    let expectedMs = (audioSecs / Math.max(0.5, tempo)) * 1000;
    let startedAt = Date.now();
    let pausedAt: number | undefined;
    let cancelled = false;
    const id = this.nextId++;
    let resolveRaw!: () => void;
    const raw = new Promise<void>((resolve, reject) => {
      resolveRaw = resolve;
      this.current = { id, resolve, reject };
    });
    raw.catch(() => {});
    // Watchdog: a playback that never reports done (audio clock stuck) must
    // not silence the extension forever. Re-armed as parts are appended so
    // the deadline always reflects the total audio queued.
    let timer: NodeJS.Timeout | undefined;
    const armWatchdog = () => {
      if (timer) {
        clearTimeout(timer);
      }
      // Paused: no deadline runs
      if (pausedAt !== undefined) {
        return;
      }
      const delay = Math.max(1000, startedAt + budgetMs(audioSecs) + 8000 - Date.now());
      timer = setTimeout(onWatchdog, delay);
    };
    const onWatchdog = () => {
      if (this.current?.id === id) {
        logLine(`[node] WATCHDOG playback exceeded ${Math.round(expectedMs)}ms; restarting player`);
        defaultOutputDevice((name) =>
          onErrorGlobal(
            `audio playback stalled on output device "${name}" - if that is a Bluetooth headset, it may be asleep, out of range, or not worn; pick another output in macOS Sound settings. Restarting the audio player.`
          )
        );
        this.proc?.kill("SIGKILL"); // exit handler rejects the pending playback
      }
    };
    armWatchdog();
    const done = raw
      .finally(() => timer && clearTimeout(timer))
      .then(() => {
        this.scheduleIdleRecycle();
        const took = Date.now() - startedAt;
        logLine(
          `[node] done id=${id} in ${took}ms (expected ~${Math.round(expectedMs)}ms)${cancelled ? " cancelled" : ""}`
        );
        // Instant "done" on a multi-second file = CoreAudio refused to play in
        // this process. Twice in a row: hand playback to afplay for the session.
        if (!cancelled && expectedMs > 1500 && took < expectedMs * 0.25) {
          this.earlyDones++;
          if (this.earlyDones >= 2 && !disabled) {
            disabled = true;
            onErrorGlobal(
              "audio playback ended instantly twice; switching to afplay for this session (see player.log)"
            );
            this.dispose();
          }
        } else if (!cancelled) {
          this.earlyDones = 0;
        }
      });
    done.catch(() => {});
    logLine(
      `[node] play id=${id} ${path.basename(file)} tempo=${tempo.toFixed(2)} vol=${volume.toFixed(2)} expect=${Math.round(expectedMs)}ms`
    );
    this.send({ play: file, id, rate: tempo, volume, final: isFinal });
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the returned object's methods are called as plain functions
    const self = this;
    return {
      done,
      append(part: string, final: boolean) {
        const secs = wavDurationSeconds(part) ?? 0;
        audioSecs += secs;
        expectedMs += (secs / Math.max(0.5, tempo)) * 1000;
        armWatchdog();
        self.send({ append: part, final });
      },
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        // Only stop the player if this stream is still the one playing; a
        // later play() has already superseded it otherwise.
        if (self.current?.id === id) {
          self.current = undefined;
          self.send({ stop: true });
        }
        resolveRaw(); // settle now; the player's own reply is ignored by id
      },
      freeze: () => {
        if (pausedAt === undefined) {
          pausedAt = Date.now();
          // A long pause is not a stall
          if (timer) {
            clearTimeout(timer);
          }
        }
        this.send({ pause: true });
      },
      unfreeze: () => {
        if (pausedAt !== undefined) {
          startedAt += Date.now() - pausedAt; // the deadline shifts by the pause
          pausedAt = undefined;
          armWatchdog();
        }
        this.send({ resume: true });
      },
    };
  }

  /** Live adjust the CURRENT playback (pitch-preserving). */
  setRate(tempo: number): void {
    this.send({ rate: tempo });
  }

  setVolume(volume: number): void {
    this.send({ volume });
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = undefined;
    try {
      this.proc?.kill("SIGTERM");
    } catch {}
    this.proc = undefined;
  }
}

let player: PersistentPlayer | undefined;

export function getPersistentPlayer(): PersistentPlayer | undefined {
  if (!binPath || disabled) {
    return undefined;
  }
  if (!player) {
    player = new PersistentPlayer(binPath);
  }
  return player;
}

export function disposePersistentPlayer(): void {
  player?.dispose();
  player = undefined;
}
