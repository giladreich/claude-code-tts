// Reading a download's progress off the cache directory.
//
// The engines fetch their weights inside the Python runtime, so nothing on
// this side sees an HTTP response: the only evidence is the cache growing.
// Getting this wrong is not a crash, it is a status bar that says "loading
// model" for six minutes and a user who assumes it has hung.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  expectedBytes,
  cacheName,
  combine,
  fractionDone,
  fractionOf,
  progressText,
  growingModel,
  hubDir,
  isFetching,
  modelBytes,
  modelLabel,
  progressLabel,
  scanHub,
} = require("../../out/platform/modelProgress.js");
const { tmpDir } = require("../helpers");

const GB = 1024 ** 3;

/** A cache with the given blobs, in bytes. */
function fakeHub(models) {
  const hub = tmpDir("cv-hub-");
  for (const [name, blobs] of Object.entries(models)) {
    const dir = path.join(hub, name, "blobs");
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, size] of Object.entries(blobs)) {
      fs.writeFileSync(path.join(dir, file), Buffer.alloc(size));
    }
  }
  return hub;
}

/** The file listing the runtimes write when a download starts. */
function writeTree(hub, model, files, revision = "rev1") {
  const dir = path.join(hub, model, "trees");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(hub, model, "refs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${revision}.json`),
    JSON.stringify({
      format_version: 1,
      files: Object.fromEntries(Object.entries(files).map(([n, size]) => [n, { size }])),
    })
  );
}

test("a model's size is what its blobs weigh, partial downloads included", () => {
  const hub = fakeHub({
    "models--openai--whisper-small": { abc: 1000, "def.incomplete": 500 },
    "models--other--thing": { x: 7 },
  });
  assert.equal(modelBytes(hub, "models--openai--whisper-small"), 1500);
  assert.equal(modelBytes(hub, "models--nothing--here"), 0, "a model not in the cache weighs nothing");
  assert.deepEqual([...scanHub(hub).keys()].sort(), ["models--openai--whisper-small", "models--other--thing"]);
  assert.deepEqual(scanHub(path.join(hub, "does-not-exist")), new Map(), "an empty cache is not an error");
});

test("leftovers from a cancelled fetch are not progress, and not a fetch", () => {
  // Both numbers were read off abandoned files: 0.35 GB left behind five
  // hours earlier was added to a fresh download ("2.7 of 2.3 GB") and its
  // presence said a download was still running, so the notification stayed
  // at 99% with nothing happening.
  const hub = fakeHub({ "models--a--model": { done: 1000, "stale.incomplete": 500, "live.incomplete": 300 } });
  const blobs = path.join(hub, "models--a--model", "blobs");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(blobs, "stale.incomplete"), old, old);
  assert.equal(modelBytes(hub, "models--a--model"), 1300, "the fresh partial counts, the abandoned one does not");
  assert.equal(isFetching(hub, "models--a--model"), true, "something is being written to");

  const now = new Date();
  fs.utimesSync(path.join(blobs, "live.incomplete"), now, now);
  const later = Date.now() + 10 * 60 * 1000; // ten minutes on, nothing has moved
  assert.equal(modelBytes(hub, "models--a--model", later), 1000);
  assert.equal(isFetching(hub, "models--a--model", later), false, "a download nothing is writing to has stopped");
});

test("a partial file is what says a fetch is in flight", () => {
  const hub = fakeHub({
    "models--a--busy": { "one.incomplete": 10 },
    "models--a--finished": { one: 10 },
  });
  assert.equal(isFetching(hub, "models--a--busy"), true);
  assert.equal(isFetching(hub, "models--a--finished"), false);
  assert.equal(isFetching(hub, "models--a--absent"), false);
});

test("the model that grew is the one being reported, with the size the cache says", () => {
  const hub = fakeHub({ "models--a--big": { one: 9000 }, "models--other--thing": { one: 600 } });
  writeTree(hub, "models--a--big", { "model.safetensors": 40000, "config.json": 500 });
  const before = new Map([
    ["models--a--big", 1000],
    ["models--other--thing", 500],
  ]);
  const after = new Map([
    ["models--a--big", 9000],
    ["models--other--thing", 600],
  ]);
  const grew = growingModel(hub, before, after);
  assert.equal(grew.name, "models--a--big", "the largest gain is the one doing the work");
  assert.equal(grew.bytes, 9000);
  assert.equal(grew.expected, 40500);

  assert.equal(growingModel(hub, after, after), undefined, "nothing growing is nothing to report");
  // A model appearing for the first time counts as growth from zero.
  const fresh = growingModel(hub, new Map(), new Map([["models--new--one", 42]]));
  assert.equal(fresh.name, "models--new--one");
  assert.equal(fresh.expected, undefined, "a cache with no listing has no total, and that is allowed");
});

test("the total comes from the listing the runtime wrote, not from a table here", () => {
  // The listing arrives before the weights, so the total is known from the
  // first second of a download; a table in the source went out of date and
  // reported "2.7 of 2.3 GB (99%)" on a model 100 MB larger than it said.
  const hub = fakeHub({ "models--a--model": { one: 10 } });
  assert.equal(expectedBytes(hub, "models--a--model"), undefined, "no listing, no invented total");
  writeTree(hub, "models--a--model", { "model.safetensors": 2_000_000, "tokenizer.json": 1_000 }, "abc123");
  assert.equal(expectedBytes(hub, "models--a--model"), 2_001_000);

  // Several revisions in the cache: the one the cache points at wins.
  writeTree(hub, "models--a--model", { "model.safetensors": 9_000_000 }, "old999");
  fs.writeFileSync(path.join(hub, "models--a--model", "refs", "main"), "abc123");
  assert.equal(
    expectedBytes(hub, "models--a--model"),
    2_001_000,
    "the revision being fetched, not the biggest leftover"
  );
  // A listing that cannot be read is skipped rather than fatal.
  fs.writeFileSync(path.join(hub, "models--a--model", "trees", "abc123.json"), "{not json");
  assert.equal(expectedBytes(hub, "models--a--model"), 9_000_000);
});

test("progress reads as a size, and only claims a percentage when it knows one", () => {
  const known = {
    name: "models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
    bytes: 1.4 * GB,
    expected: 4.2 * GB,
  };
  assert.equal(progressLabel(known), "1.4 of 4.2 GB (33%)");
  assert.equal(Math.round(fractionDone(known) * 100), 33);

  const unknown = { name: "models--someone--else", bytes: 1.4 * GB };
  assert.equal(progressLabel(unknown), "1.4 GB", "no invented total, no invented percentage");
  assert.equal(fractionDone(unknown), undefined);

  // A model that comes out larger than the one the total was measured from
  // must not read as "4.6 of 4.2 GB", which is a number nobody can act on,
  // and must never claim to be done before it is.
  const over = { name: "x", bytes: 4.6 * GB, expected: 4.2 * GB };
  assert.equal(progressLabel(over), "4.2 of 4.2 GB (99%)");
  assert.equal(fractionDone(over), 1);
});

test("the names line up with what the runtimes write", () => {
  assert.equal(
    cacheName("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"),
    "models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"
  );
  assert.equal(
    modelLabel("models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"),
    "Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"
  );
});

test("the cache location follows the environment the runtimes use", () => {
  assert.equal(hubDir({ HF_HOME: "/tmp/hf" }, "/home/x"), path.join("/tmp/hf", "hub"));
  assert.equal(hubDir({}, "/home/x"), path.join("/home/x", ".cache", "huggingface", "hub"));
});

test("two downloads at once are added up, not shown one instead of the other", () => {
  // The case that made this necessary: the engine fetching its weights while
  // the voice designer fetches its own. Reporting whichever grew last made
  // the number jump backwards and lose the first one entirely.
  const engine = {
    name: "models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
    bytes: 1.4 * GB,
    expected: 4.2 * GB,
  };
  const designer = {
    name: "models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
    bytes: 1.0 * GB,
    expected: 4.2 * GB,
  };
  const both = combine([engine, designer]);
  assert.equal(both.count, 2);
  assert.equal(Math.round((both.bytes / GB) * 10) / 10, 2.4);
  assert.equal(Math.round((both.expected / GB) * 10) / 10, 8.4);
  assert.equal(progressText(both), "2.4 of 8.4 GB (29%), 2 models");
  assert.equal(Math.round(fractionOf(both) * 100), 29);

  // One alone reads as it did before, with no count to explain.
  assert.equal(progressText(combine([engine])), "1.4 of 4.2 GB (33%)");

  // An unknown model in the set removes the percentage rather than inventing
  // a total that the known one would blow past.
  const mystery = { name: "models--someone--else", bytes: 0.5 * GB };
  const mixed = combine([engine, mystery]);
  assert.equal(mixed.expected, undefined);
  assert.equal(progressText(mixed), "1.9 GB, 2 models");
  assert.equal(fractionOf(mixed), undefined);

  assert.deepEqual(combine([]), { bytes: 0, expected: 0, count: 0 });
});
