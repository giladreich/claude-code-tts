/**
 * How a download in progress is shown: every fetch this extension starts
 * says how far it is, as "12 of 335 MB (4%)" with the notification's bar
 * following, whatever fetches it.
 *
 * Three kinds of fetch reach a person: a file this extension downloads
 * itself (a Kokoro or Piper archive, uv, a translation model), which reports
 * its bytes as they arrive and the total the server names; the packages uv
 * installs, which uv announces one by one with their sizes; and the model
 * weights a runtime fetches into its own cache, which the status bar watches
 * and a flow can show in a notification of its own (statusBar.ts, which
 * holds that watcher; this module stays below core/config.ts).
 */
import * as vscode from "vscode";
import { UvDownloads } from "../platform/uvBootstrap";

type Notification = vscode.Progress<{ message?: string; increment?: number }>;

const MB = 1024 * 1024;

/** "12 of 335 MB (4%)", or "12 MB" while the total is not known; GB past a gigabyte. */
export function downloadText(bytes: number, total?: number): string {
  const inGb = (n: number) => n >= 1000 * MB;
  // A gigabyte total with megabytes done reads as 0.03, not 0.0
  const amount = (n: number, gb: boolean) =>
    gb ? (n / 1024 / MB).toFixed(n < 100 * MB ? 2 : 1) : String(Math.round(n / MB));
  const unit = (gb: boolean) => (gb ? "GB" : "MB");
  if (!total) {
    return `${amount(bytes, inGb(bytes))} ${unit(inGb(bytes))}`;
  }
  const done = Math.min(bytes, total);
  const gb = inGb(total);
  return `${amount(done, gb)} of ${amount(total, gb)} ${unit(gb)} (${Math.min(99, Math.floor((done / total) * 100))}%)`;
}

/**
 * The files one notification fetches, added up: each is given an estimate
 * of its size, replaced by the size the server names once it answers, so the
 * percentage is over the whole fetch and never runs backwards.
 */
export class DownloadReport {
  private files: { got: number; total: number }[] = [];
  private reported = 0;

  constructor(
    private progress: Notification,
    private label = "downloading"
  ) {}

  /** The byte callback for one file (see net.ts download): its bytes as they arrive, and the total once known. */
  file(estimateBytes: number): (n: number, total?: number) => void {
    const f = { got: 0, total: estimateBytes };
    this.files.push(f);
    return (n, total) => {
      if (total) {
        f.total = total;
      }
      f.got += n;
      this.show();
    };
  }

  /** A stage between fetches ("extracting the runtime"), with the bar where it is. */
  message(text: string): void {
    this.progress.report({ message: text });
  }

  private show(): void {
    let got = 0;
    let total = 0;
    for (const f of this.files) {
      got += f.got;
      total += f.total;
    }
    this.report(`${this.label}: ${downloadText(got, total)}`, total ? got / total : 0);
  }

  /** The bar only ever moves forward; a fetch that grows past its estimate holds at the end. */
  private report(message: string, fraction: number): void {
    const percent = Math.min(100, Math.floor(fraction * 100));
    this.progress.report({ message, increment: Math.max(0, percent - this.reported) });
    this.reported = Math.max(this.reported, percent);
  }
}

/**
 * The packages uv is fetching, shown as it announces them: what is done
 * against what it has named so far, and the one in flight by name and size,
 * since uv reports a package's bytes only once they are all there.
 */
export function reportUvDownloads(progress: Notification): (line: string) => void {
  const downloads = new UvDownloads();
  let reported = 0;
  return (line) => {
    if (!downloads.note(line)) {
      return;
    }
    const { done, total, inFlight } = downloads.summary();
    const percent = total ? Math.floor((done / total) * 100) : 0;
    const current = inFlight.map((p) => `${p.name} (${downloadText(p.bytes)})`).join(", ");
    progress.report({
      message: current
        ? `downloading ${current}; ${downloadText(done, total)}`
        : `downloaded ${downloadText(done, total)}`,
      increment: Math.max(0, percent - reported),
    });
    reported = Math.max(reported, percent);
  };
}
