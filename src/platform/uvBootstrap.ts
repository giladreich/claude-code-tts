/**
 * A private copy of uv, so the Python engines install without asking the
 * user to run anything.
 *
 * Every neural engine except Kokoro is a Python package. Until now setting
 * one up dead-ended at "install uv, then run this again" whenever uv was not
 * on PATH, and the pip fallback wrote into the user's own Python (which PEP
 * 668 distributions refuse outright). Kokoro showed the way: it downloads
 * its runtime into the extension's storage and nothing else is touched.
 *
 * Here uv itself is the runtime. When the user has uv, theirs is used and
 * their tool directory stays theirs. When they do not, a pinned release is
 * downloaded from GitHub, verified against the SHA-256 the project publishes
 * next to it, and kept under <globalStorage>/uv together with everything it
 * installs (tools, a managed Python, its cache): nothing lands on PATH, in
 * ~/.local, or in any Python the user owns. The whole tree is one folder to
 * delete. See docs/PRIVACY.md for the one network call this adds.
 */

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exe, hasCommand, isWindows, userScriptDirs } from "./platform";
import { download } from "../tts/net";

/** Pinned. Bumping it makes the next setup fetch the new release. */
export const UV_VERSION = "0.12.10";
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`;

export interface UvAsset {
  name: string;
  archive: "tar.gz" | "zip";
}

/** The release asset for a platform, or undefined where uv has no build. */
export function uvAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): UvAsset | undefined {
  const triples: Record<string, Record<string, string>> = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  const triple = triples[platform]?.[arch];
  if (!triple) {
    return undefined;
  }
  const archive = platform === "win32" ? "zip" : "tar.gz";
  return { name: `uv-${triple}.${archive}`, archive };
}

export function privateUvRoot(storage: string): string {
  return path.join(storage, "uv");
}

export function privateUvBinary(storage: string): string {
  return path.join(privateUvRoot(storage), "bin", exe("uv"));
}

/** Where a private uv puts the tools it installs. */
export function privateUvToolsDir(storage: string): string {
  return path.join(privateUvRoot(storage), "tools");
}

/**
 * Environment that keeps a private uv entirely inside the extension's
 * storage. Only applied to the private copy: a user's own uv keeps its own
 * directories, exactly as if they had typed the command.
 */
export function privateUvEnv(storage: string): Record<string, string> {
  const root = privateUvRoot(storage);
  return {
    UV_TOOL_DIR: privateUvToolsDir(storage),
    UV_TOOL_BIN_DIR: path.join(root, "tool-bin"),
    UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
    UV_CACHE_DIR: path.join(root, "cache"),
    // Only interpreters uv manages, fetched into UV_PYTHON_INSTALL_DIR: a
    // tool built on whatever Python happens to be on the machine breaks
    // when that Python is upgraded or removed, and would be the one thing
    // outside this folder. Verified: without this, uv used a Homebrew 3.12.
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_MODIFY_PATH: "1",
  };
}

export interface UvInfo {
  /** Executable to spawn. */
  bin: string;
  /** Extra environment for it (empty for the user's own uv). */
  env: Record<string, string>;
  /** True for the copy the extension downloaded. */
  private: boolean;
}

/**
 * The uv to use, in order: the user's own on PATH, their own in the usual
 * installer locations that a GUI-launched editor's PATH often misses, then
 * the private copy if it has been downloaded. Nothing is downloaded here.
 */
export function findUv(storage: string, user: UvInfo | null = findUserUv() ?? null): UvInfo | undefined {
  // `null` says "the user has none" explicitly (tests); a default parameter
  // would be re-evaluated for an explicit undefined.
  if (user) {
    return user;
  }
  const priv = privateUvBinary(storage);
  if (fs.existsSync(priv) && readVersion(storage) === UV_VERSION) {
    return { bin: priv, env: privateUvEnv(storage), private: true };
  }
  return undefined;
}

/** The user's own uv, if any: on PATH, or in the usual installer locations. */
export function findUserUv(): UvInfo | undefined {
  if (hasCommand("uv")) {
    return { bin: "uv", env: {}, private: false };
  }
  for (const dir of [...userScriptDirs(), path.join(os.homedir(), ".cargo", "bin")]) {
    const candidate = path.join(dir, exe("uv"));
    if (fs.existsSync(candidate)) {
      return { bin: candidate, env: {}, private: false };
    }
  }
  return undefined;
}

function readVersion(storage: string): string | undefined {
  try {
    return fs.readFileSync(path.join(privateUvRoot(storage), "version"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The 64-hex digest from a "<sha256>  <filename>" sidecar, or undefined. */
export function parseSha256Sidecar(text: string): string | undefined {
  const m = /\b([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) {
        return hit;
      }
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}

export type Fetch = (url: string, dest: string, onBytes: (n: number) => void) => Promise<void>;

/**
 * Download the pinned uv release for this machine, verify it against the
 * checksum the project publishes beside it, and place it under the private
 * root. Throws, leaving nothing behind, if anything does not add up: a
 * binary that fails its checksum is never extracted, let alone run.
 * `fetch` is injectable so tests can serve local files.
 */
export async function installPrivateUv(
  storage: string,
  onProgress: (message: string, bytes?: number) => void = () => {},
  fetch: Fetch = download
): Promise<string> {
  const asset = uvAsset();
  if (!asset) {
    throw new Error(`uv publishes no build for ${process.platform} ${process.arch}`);
  }
  const root = privateUvRoot(storage);
  const tmp = path.join(root, "tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, asset.name);
    onProgress("fetching the checksum");
    await fetch(`${RELEASE_BASE}${asset.name}.sha256`, `${archive}.sha256`, () => {});
    const expected = parseSha256Sidecar(fs.readFileSync(`${archive}.sha256`, "utf8"));
    if (!expected) {
      throw new Error("the published checksum could not be read");
    }
    onProgress("downloading uv");
    await fetch(`${RELEASE_BASE}${asset.name}`, archive, (n) => onProgress("downloading uv", n));
    const actual = await sha256File(archive);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset.name}: refusing to install it`);
    }
    onProgress("unpacking");
    // tar handles both archives: bsdtar, which Windows 10 ships, opens zip too.
    const tar = spawnSync("tar", ["-xf", archive, "-C", tmp], { stdio: "ignore", windowsHide: true });
    if (tar.status !== 0) {
      throw new Error("could not unpack the uv archive (tar failed)");
    }
    const found = findFile(tmp, exe("uv"));
    if (!found) {
      throw new Error("the uv archive did not contain the uv executable");
    }
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const dest = privateUvBinary(storage);
    fs.copyFileSync(found, dest);
    if (!isWindows) {
      fs.chmodSync(dest, 0o755);
    }
    const probe = spawnSync(dest, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ...privateUvEnv(storage) },
    });
    if (probe.status !== 0) {
      fs.rmSync(dest, { force: true });
      throw new Error(
        `the downloaded uv does not run here (${(probe.stderr || probe.error?.message || "").trim().slice(0, 120)})`
      );
    }
    fs.writeFileSync(path.join(root, "version"), UV_VERSION);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Arguments that install a Python tool with this uv. The private copy pins
 * the interpreter so uv fetches a managed CPython into the private root
 * instead of picking up whatever Python happens to be on the machine; the
 * user's own uv keeps its own defaults.
 */
export function toolInstallArgs(uv: UvInfo, pkg: string, extra: string[] = []): string[] {
  return ["tool", "install", ...(uv.private ? ["--python", "3.12"] : []), ...extra, pkg];
}

/**
 * Run uv with live output. Resolves with ok=false rather than rejecting so
 * callers report and move on; `onLine` receives every line for the log.
 */
export function runUv(
  uv: UvInfo,
  args: string[],
  onLine: (line: string) => void,
  cancel?: { onCancel: (kill: () => void) => void }
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    onLine(`$ ${uv.private ? "uv (private)" : uv.bin} ${args.join(" ")}`);
    const proc = spawn(uv.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...uv.env },
    });
    const onData = (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        if (line.trim()) {
          onLine(line.trimEnd());
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    let cancelled = false;
    cancel?.onCancel(() => {
      cancelled = true;
      proc.kill();
    });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("exit", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: cancelled ? "cancelled" : `exit code ${code}` })
    );
  });
}
