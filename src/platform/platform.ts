/**
 * Small platform helpers so the rest of the code can stop assuming macOS.
 * Everything here is cheap (no process spawn unless stated) because some of
 * it runs during activation.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const isWindows = process.platform === "win32";

export const isMac = process.platform === "darwin";

export const isLinux = process.platform === "linux";

/** Executable name with the platform's suffix. */
export function exe(name: string): string {
  return isWindows ? `${name}.exe` : name;
}

/** Is this command on PATH? Uses where.exe on Windows, which elsewhere. */
export function hasCommand(cmd: string): boolean {
  return commandOnPath(cmd) !== undefined;
}

/**
 * Where this command is, by reading the PATH directories rather than running
 * `which` or `where.exe`. Activation and every engine rebuild ask whether
 * espeak is installed, and a spawn there is an extension host that stops
 * answering (test/unit/commands.test.js fails on one); a handful of stat
 * calls is not. Answers are not cached: installing ffmpeg while the window
 * is open must be noticed by the flow that offered it.
 */
export function commandOnPath(cmd: string): string | undefined {
  // Windows resolves a bare name through PATHEXT; elsewhere the name is it.
  const names = isWindows
    ? path.extname(cmd)
      ? [cmd]
      : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => cmd + ext.toLowerCase())
    : [cmd];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not there, or not readable: the next candidate.
      }
    }
  }
  return undefined;
}

/**
 * The environment a Python child gets.
 *
 * Windows decodes a pipe with the system code page unless it is told
 * otherwise, and the daemons speak JSON over stdin: a request carrying
 * Chinese arrived as mojibake, the speech budget counted it as two words
 * rather than sixteen characters, and the sentence was cut to half a second.
 * UTF-8 mode also fixes the filesystem encoding, so a reference recording
 * under a name with an accent in it opens.
 */
export function pythonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...extra };
}

/** Interpreter inside a virtualenv: bin/python on POSIX, Scripts/python.exe on Windows. */
export function venvPython(venvDir: string): string {
  return isWindows ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
}

/** Scripts/binaries directory of a virtualenv. */
export function venvBin(venvDir: string): string {
  return path.join(venvDir, isWindows ? "Scripts" : "bin");
}

/** Root of the user's own uv tool installs on this platform. */
export function uvToolsDir(): string {
  if (isWindows) {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "uv", "tools");
  }
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "uv", "tools");
}

let extraUvToolsDir: string | undefined;

/**
 * The tool directory of the extension's private uv (see uvBootstrap.ts),
 * registered at activation so tools installed there are found like the
 * user's own. Tests point it at a fixture.
 */
export function setExtraUvToolsDir(dir: string | undefined): void {
  extraUvToolsDir = dir;
}

/** Every directory a uv tool may have been installed into, the user's first. */
export function uvToolsDirs(): string[] {
  return extraUvToolsDir ? [uvToolsDir(), extraUvToolsDir] : [uvToolsDir()];
}

/**
 * Python interpreter of a uv tool install, if the package is really there.
 * Checked on disk (no import) so activation never blocks, and looking in
 * both layouts so Windows works without a different code path.
 */
export function uvToolPython(tool: string, packageDir: string): string | undefined {
  for (const toolsDir of uvToolsDirs()) {
    const venv = path.join(toolsDir, tool);
    if (!fs.existsSync(venvPython(venv))) {
      continue;
    }
    if (sitePackageExists(venv, packageDir)) {
      return venvPython(venv);
    }
  }
  return undefined;
}

/**
 * Is a package present in this virtualenv? Answered from the directory
 * listing, never by starting Python: this is called on the activation path.
 */
export function sitePackageExists(venv: string, packageDir: string): boolean {
  const libRoots = isWindows ? [path.join(venv, "Lib", "site-packages")] : [];
  try {
    const lib = path.join(venv, "lib");
    for (const py of fs.readdirSync(lib)) {
      libRoots.push(path.join(lib, py, "site-packages"));
    }
  } catch {
    /* POSIX layout absent: Windows path above covers it */
  }
  return libRoots.some((root) => fs.existsSync(path.join(root, packageDir)));
}

/** Places a pip/uv installed console script can be found, beyond PATH. */
export function userScriptDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const dirs = [path.join(home, ".local", "bin"), path.join(roaming, "Python", "Scripts")];
    try {
      for (const d of fs.readdirSync(roaming)) {
        if (/^Python\d+$/i.test(d)) {
          dirs.push(path.join(roaming, d, "Scripts"));
        }
      }
    } catch {
      /* ignore */
    }
    return dirs;
  }
  return [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The command a user should run to install a Python tool, per platform. */
export function installCommand(pkg: string): string {
  return hasCommand("uv") ? `uv tool install ${pkg}` : `pipx install ${pkg}`;
}

/** Quote a path for a shell command line only when it needs it. */
// A path as a shell writes it. cmd.exe has no backslash escape, and quoting
// one there would put the escapes into the path itself, so on Windows the
// quotes carry the whole of it and nothing inside them is touched.
const shellQuote = (p: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32"
    ? /\s/.test(p)
      ? `"${p}"`
      : p
    : /[\s"'$`\\]/.test(p)
      ? `"${p.replace(/(["$`\\])/g, "\\$1")}"`
      : p;

/**
 * What runs the hook script.
 *
 * Claude Code runs a hook through a shell whose PATH is whatever the session
 * inherited, which is not the user's interactive PATH: node installed as a
 * keg-only Homebrew formula (/opt/homebrew/opt/node@22/bin/node), through
 * nvm, or an editor started from the Dock all leave "node" unresolvable, and
 * the hook then fails with "command not found" where nobody sees it. The
 * sounds stop and nothing says why. So the interpreter is written as an
 * absolute path, and the editor's own runtime (which can run a script as
 * node) is the fallback that is always present.
 */
export function resolveNodeCommand(opts: {
  path?: string;
  electron: string;
  platform: NodeJS.Platform;
  exists: (candidate: string) => boolean;
}): string {
  const names = opts.platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node"];
  // The platform is an argument, so neither the separator nor the delimiter
  // may come from the machine this runs on: asked about a macOS PATH from
  // Windows (which the tests do, and a remote window could), splitting on ";"
  // made one entry of the whole string and found nothing.
  const separator = opts.platform === "win32" ? "\\" : "/";
  const dirs = [
    ...(opts.path ?? "").split(opts.platform === "win32" ? ";" : ":").filter(Boolean),
    // Where a GUI-launched editor still finds one, PATH or no PATH.
    ...(opts.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir.endsWith(separator) ? dir + name : dir + separator + name;
      if (opts.exists(candidate)) {
        return shellQuote(candidate, opts.platform);
      }
    }
  }
  // The editor's own binary is node with a flag; on Windows a shell cannot
  // carry the variable in front of the command, so the bare name stays.
  return opts.platform === "win32" ? "node" : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(opts.electron)}`;
}
