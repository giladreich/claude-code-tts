/**
 * Voice profiles are the one thing here that cannot be downloaded again: a
 * recording of someone's voice plus its transcript. Export writes a portable
 * archive (tar.gz, so it opens with any standard tool) that can be backed up
 * or handed to another machine; import validates and installs it.
 *
 * Sharing an exported voice means sharing a person's voice: only do it with
 * that person's agreement (docs/RESPONSIBLE-USE.md).
 */

import { execFile } from "child_process";
import { hasCommand } from "../platform/platform";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const VOICE_PACK_EXT = "cvvoices.tgz";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** tar ships with macOS, Linux and Windows 10 1803+; older Windows needs a hint. */
export function backupsAvailable(): boolean {
  return hasCommand("tar");
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (err, _o, stderr) =>
      err
        ? reject(
            new Error(
              String(stderr || err.message)
                .trim()
                .slice(-300)
            )
          )
        : resolve()
    );
  });
}

/** Archive the given profile directories into `destFile`. */
export async function exportVoices(voicesDir: string, slugs: string[], destFile: string): Promise<number> {
  if (!backupsAvailable()) {
    throw new Error("tar was not found on PATH (Windows 10 1803 and newer ship it)");
  }
  const valid = slugs.filter((s) => SLUG.test(s) && fs.existsSync(path.join(voicesDir, s, "ref.wav")));
  if (valid.length === 0) {
    throw new Error("no voice profiles to export");
  }
  await run("tar", ["-czf", destFile, "-C", voicesDir, ...valid]);
  return valid.length;
}

export interface ImportedVoice {
  slug: string;
  name: string;
  /** Renamed because a profile with that slug already existed. */
  renamed: boolean;
}

/**
 * Install profiles from an archive. Only directories that actually look like
 * a profile are taken, and each is copied under a fresh slug rather than
 * overwriting anything that exists.
 */
export async function importVoices(voicesDir: string, srcFile: string): Promise<ImportedVoice[]> {
  if (!backupsAvailable()) {
    throw new Error("tar was not found on PATH (Windows 10 1803 and newer ship it)");
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-tts-import-"));
  try {
    await run("tar", ["-xzf", srcFile, "-C", staging]);
    const out: ImportedVoice[] = [];
    fs.mkdirSync(voicesDir, { recursive: true });
    for (const entry of fs.readdirSync(staging)) {
      // Anything that is not a plain profile directory is ignored: no
      // absolute paths, no traversal, no executables.
      if (!SLUG.test(entry)) {
        continue;
      }
      const from = path.join(staging, entry);
      if (!fs.lstatSync(from).isDirectory()) {
        continue;
      }
      const ref = path.join(from, "ref.wav");
      const metaPath = path.join(from, "meta.json");
      if (!fs.existsSync(ref) || !fs.existsSync(metaPath)) {
        continue;
      }
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        continue;
      }
      let slug = entry;
      let renamed = false;
      while (fs.existsSync(path.join(voicesDir, slug))) {
        slug += "-imported";
        renamed = true;
      }
      const to = path.join(voicesDir, slug);
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(ref, path.join(to, "ref.wav"));
      fs.writeFileSync(
        path.join(to, "meta.json"),
        JSON.stringify({ ...meta, importedAt: new Date().toISOString() }, null, 2)
      );
      out.push({ slug, name: typeof meta.name === "string" ? meta.name : slug, renamed });
    }
    if (out.length === 0) {
      throw new Error("the file contains no voice profiles");
    }
    return out;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
