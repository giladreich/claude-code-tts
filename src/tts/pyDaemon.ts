import { ChildProcess, spawn } from "child_process";
import { pythonEnv } from "../platform/platform";
import * as fs from "fs";
import * as readline from "readline";

export interface PyDaemonOptions {
  /** Kill and report if "ready" has not arrived by then (model load hang). */
  readyTimeoutMs?: number;
  /**
   * Give up on a request that has been silent this long. A generation that
   * hangs used to silence the extension for the rest of the session: the
   * promise never settled, so the queue waited on it forever with no error,
   * no log line and nothing the user could do but reload the window.
   */
  requestTimeoutMs?: number;
  /** Extra environment for the process (e.g. HF_HUB_OFFLINE). */
  env?: Record<string, string>;
  /** Append the daemon's stderr here (model load progress, tracebacks). */
  logFile?: string;
}

/**
 * Long-lived Python model process shared by the Kokoro, Qwen3 and Chatterbox
 * engines and by the translation runtime: loads a model once, then serves
 * {id, ...} requests over stdio, answering {id, ok} per request. Fully local.
 */
export class PyTtsDaemon {
  private proc: ChildProcess;
  private pending = new Map<
    number,
    {
      resolve: (msg: any) => void;
      reject: (e: Error) => void;
      onPart?: (file: string, final: boolean) => void;
      /** Reset whenever the daemon says something about this request. */
      watchdog?: NodeJS.Timeout;
    }
  >();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  /** Resolves when the model is loaded; rejects if the daemon dies or stalls. */
  readonly ready: Promise<void>;
  alive = true;

  /** Requests issued and not yet answered. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  constructor(
    python: string,
    script: string,
    cfg: Record<string, unknown>,
    onError: (msg: string) => void,
    opts: PyDaemonOptions = {}
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000;
    this.proc = spawn(python, [script, JSON.stringify(cfg)], {
      stdio: ["pipe", "pipe", opts.logFile ? "pipe" : "ignore"],
      windowsHide: true,
      env: pythonEnv(opts.env),
    });
    if (opts.logFile) {
      const log = opts.logFile;
      try {
        // Append across restarts: a daemon that is unloaded after idle time and
        // started again must not erase the timings of the one before it, or a
        // gap that happened an hour ago cannot be diagnosed. Truncated only
        // when it grows past 2 MB.
        try {
          if (fs.statSync(log).size > 2 * 1024 * 1024) {
            fs.truncateSync(log, 0);
          }
        } catch {}
        fs.appendFileSync(log, `${new Date().toISOString()} start ${python} ${script}\n`);
      } catch {}
      this.proc.stderr?.on("data", (d) => fs.appendFile(log, String(d), () => {}));
    }
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => ((readyResolve = res), (readyReject = rej)));
    this.ready.catch(() => {});

    const fail = (why: string) => {
      if (!this.alive) {
        return;
      }
      this.alive = false;
      onError(`synthesis daemon ${why}`);
      readyReject(new Error(why));
      for (const p of this.pending.values()) {
        if (p.watchdog) {
          clearTimeout(p.watchdog);
        }
        p.reject(new Error(`daemon ${why}`));
      }
      this.pending.clear();
      try {
        this.proc.kill("SIGKILL");
      } catch {}
    };

    // A model load that hangs (typically a stalled Hugging Face network
    // call) would otherwise leave the engine silent forever.
    const timeoutMs = opts.readyTimeoutMs ?? 120_000;
    const readyTimer = setTimeout(
      () => fail(`did not become ready within ${Math.round(timeoutMs / 1000)}s (model download or load stalled)`),
      timeoutMs
    );
    this.ready.then(
      () => clearTimeout(readyTimer),
      () => clearTimeout(readyTimer)
    );

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // libraries sometimes chat on stdout; ignore non-protocol lines
      }
      if (msg.ready) {
        return readyResolve();
      }
      // Any answer at all proves the daemon is alive and working, so every
      // request in flight gets its deadline back. Without this, a chunk
      // prepared ahead of time was killed at the deadline for the time it
      // spent queued behind other requests, which on a slow engine is the
      // normal case rather than a hang.
      for (const id of this.pending.keys()) {
        this.touch(id);
      }
      const p = this.pending.get(msg.id);
      if (!p) {
        return;
      }
      // Streaming daemons emit {id, part, final} per audio part before the
      // closing {id, ok}; non-streaming daemons only send {id, ok}.
      if (typeof msg.part === "string") {
        this.touch(msg.id);
        p.onPart?.(msg.part, msg.final === true);
        return;
      }
      if (p.watchdog) {
        clearTimeout(p.watchdog);
      }
      this.pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg);
      } else {
        p.reject(new Error(String(msg.error ?? "daemon synthesis failed")));
      }
    });
    this.proc.on("error", (e) => fail(`failed to start: ${e.message}`));
    this.proc.on("exit", (code) => fail(`exited with ${code}`));
  }

  synthesize(payload: Record<string, unknown>, onPart?: (file: string, final: boolean) => void): Promise<unknown> {
    return this.request(payload, onPart).promise;
  }

  /**
   * Like synthesize(), with a cancel handle: the daemon aborts the request
   * whether it is still queued or mid-generation (the promise then rejects
   * with "cancelled"). Without this, a skipped or superseded utterance would
   * hold the single-threaded model for its full synthesis time.
   */
  request(
    payload: Record<string, unknown>,
    onPart?: (file: string, final: boolean) => void
  ): { promise: Promise<any>; cancel: () => void } {
    const id = this.nextId++;
    let sent = false;
    let cancelled = false;
    const promise = this.ready.then(
      () =>
        new Promise<any>((resolve, reject) => {
          if (!this.alive) {
            return reject(new Error("daemon gone"));
          }
          if (cancelled) {
            return reject(new Error("cancelled"));
          }
          this.pending.set(id, { resolve, reject, onPart });
          this.touch(id);
          sent = true;
          this.proc.stdin!.write(JSON.stringify({ id, ...payload }) + "\n");
        })
    );
    return {
      promise,
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        if (sent && this.alive && this.pending.has(id)) {
          try {
            this.proc.stdin!.write(JSON.stringify({ cancel: id }) + "\n");
          } catch {}
        }
      },
    };
  }

  /**
   * Restart this request's watchdog. Streaming requests report progress part
   * by part, so the deadline is on silence rather than on total time: a long
   * paragraph that is being generated steadily is not a hang.
   */
  private touch(id: number): void {
    const p = this.pending.get(id);
    if (!p) {
      return;
    }
    if (p.watchdog) {
      clearTimeout(p.watchdog);
    }
    p.watchdog = setTimeout(() => {
      if (!this.pending.has(id)) {
        return;
      }
      this.pending.delete(id);
      try {
        if (this.alive) {
          this.proc.stdin!.write(JSON.stringify({ cancel: id }) + "\n");
        }
      } catch {}
      p.reject(new Error(`no answer for ${Math.round(this.requestTimeoutMs / 1000)}s (generation stalled)`));
    }, this.requestTimeoutMs);
    p.watchdog.unref?.();
  }

  dispose(): void {
    this.alive = false;
    // Rejecting rather than dropping: a pending promise that never settles
    // leaves the speech queue waiting on a process that no longer exists.
    for (const p of this.pending.values()) {
      if (p.watchdog) {
        clearTimeout(p.watchdog);
      }
      p.reject(new Error("daemon stopped"));
    }
    this.pending.clear();
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }
}
