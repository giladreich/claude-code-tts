// How far a download is, as every notification says it: bytes against the
// total the server or the estimate gives, a percentage that never runs
// backwards, and uv's own announcements read for the packages it fetches.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVscodeStub, installVscodeStub } = require("../helpers/vscodeStub");

installVscodeStub(createVscodeStub().stub);
const { downloadText, DownloadReport, reportUvDownloads } = require("../../out/ui/downloads.js");
const { UvDownloads } = require("../../out/platform/uvBootstrap.js");

const MB = 1024 * 1024;

/** A notification that remembers what it was told. */
function notification() {
  const reports = [];
  return { reports, report: (r) => reports.push(r) };
}

test("the text says bytes of total with a percentage, bytes alone without a total, and never 100% early", () => {
  assert.equal(downloadText(12 * MB, 335 * MB), "12 of 335 MB (3%)");
  assert.equal(downloadText(12 * MB), "12 MB");
  assert.equal(downloadText(1.5 * 1024 * MB, 4.2 * 1024 * MB), "1.5 of 4.2 GB (35%)");
  assert.equal(downloadText(400 * MB, 335 * MB), "335 of 335 MB (99%)", "a fetch past its estimate holds at 99");
});

test("a report adds its files up, takes the server's total over the estimate, and moves the bar forward only", () => {
  const n = notification();
  const report = new DownloadReport(n);
  const runtime = report.file(25 * MB);
  const model = report.file(335 * MB);
  runtime(5 * MB, 20 * MB); // the server says 20, not 25
  assert.equal(n.reports.at(-1).message, "downloading: 5 of 355 MB (1%)");
  runtime(15 * MB, 20 * MB);
  model(100 * MB);
  assert.equal(n.reports.at(-1).message, "downloading: 120 of 355 MB (33%)");
  const increments = n.reports.map((r) => r.increment ?? 0);
  assert.ok(
    increments.every((i) => i >= 0),
    "the bar never goes back"
  );
  assert.equal(
    increments.reduce((a, b) => a + b, 0),
    33,
    "the increments add up to the percentage shown"
  );
  report.message("extracting");
  assert.equal(n.reports.at(-1).message, "extracting");
});

test("uv's announcements give the packages, their sizes, and which are still on their way", () => {
  const d = new UvDownloads();
  assert.equal(d.note("Resolved 47 packages in 1.2s"), false);
  assert.equal(d.note("Downloading torch (2.4GiB)"), true);
  assert.equal(d.note("Downloading numpy (12.0MiB)"), true);
  assert.equal(d.note(" Downloaded numpy"), true);
  assert.equal(d.note(" Downloaded something-never-announced"), false);
  const s = d.summary();
  assert.equal(s.done, 12 * MB);
  assert.equal(s.total, Math.round(2.4 * 1024 * MB) + 12 * MB);
  assert.deepEqual(
    s.inFlight.map((p) => p.name),
    ["torch"]
  );
});

test("the uv reporter names what is in flight and how much of what uv has announced is done", () => {
  const n = notification();
  const show = reportUvDownloads(n);
  show("Resolved 2 packages in 100ms");
  assert.equal(n.reports.length, 0, "nothing to say yet");
  show("Downloading torch (2.4GiB)");
  show("Downloading numpy (12.0MiB)");
  show(" Downloaded numpy");
  assert.match(n.reports.at(-1).message, /^downloading torch \(2\.4 GB\); 0\.01 of 2\.4 GB \(0%\)$/);
  show(" Downloaded torch");
  assert.match(n.reports.at(-1).message, /^downloaded 2\.4 of 2\.4 GB \(99%\)$/);
  const total = n.reports.reduce((a, r) => a + (r.increment ?? 0), 0);
  assert.equal(total, 100);
});
