import * as fs from "fs";
import * as https from "https";

/** HTTPS download following redirects (GitHub/Hugging Face redirect to CDNs). */
export function download(url: string, dest: string, onBytes: (n: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("too many redirects"));
      return;
    }
    https
      .get(url, { headers: { "user-agent": "claude-code-tts-vscode" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Location may be relative; resolve it against the current URL.
          const next = new URL(res.headers.location, url).toString();
          download(next, dest, onBytes, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.on("data", (chunk: Buffer) => onBytes(chunk.length));
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
}
