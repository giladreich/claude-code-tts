const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { scanStorage, removeItems, formatBytes, dirSize, activeModelIds } = require("../../out/platform/storage.js");
const { exportVoices, importVoices } = require("../../out/voices/backup.js");
const { tmpDir, writeWav } = require("../helpers");

function fixture() {
  const root = tmpDir("cv-storage-");
  const storage = path.join(root, "storage");
  const hf = path.join(root, "hf");
  const tmp = path.join(root, "tmp");
  const uv = path.join(root, "uv");
  const ext = path.join(root, "extensions");
  const file = (p, kb) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(kb * 1024));
  };
  file(path.join(storage, "kokoro", "kokoro-multi-lang-v1_0", "model.onnx"), 400);
  file(path.join(storage, "kokoro", "kokoro-en-v0_19", "model.onnx"), 300); // legacy, unused
  file(path.join(storage, "kokoro", "sherpa-onnx-v1.13.7-osx-arm64-shared", "bin"), 60);
  file(path.join(storage, "piper-voices", "en_US-amy-medium.onnx"), 120);
  file(path.join(storage, "piper-voices", "en_US-amy-medium.onnx.json"), 1);
  file(path.join(hf, "hub", "models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-bf16", "blob"), 500);
  file(path.join(hf, "hub", "models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", "blob"), 900);
  file(path.join(hf, "hub", "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base", "blob"), 480); // torch copy, unused under MLX
  file(path.join(hf, "hub", "models--openai--whisper-small.en", "blob"), 200);
  file(path.join(hf, "hub", "models--openai--whisper-tiny.en", "blob"), 90); // another tool's model
  file(path.join(hf, "hub", "models--some--other-model", "blob"), 700); // not ours: ignored
  // Both Chatterbox runtimes, ~6 GB in the real world and invisible until now.
  file(path.join(hf, "hub", "models--mlx-community--chatterbox-multilingual-v3", "blob"), 640);
  file(path.join(hf, "hub", "models--ResembleAI--chatterbox", "blob"), 700);
  file(path.join(storage, "chatterbox-venv", "lib", "torch"), 800);
  file(path.join(storage, "player.log"), 5);
  file(path.join(storage, "bin", "claude-code-tts-player-v4"), 2);
  file(path.join(tmp, "claude-code-tts-abc.wav"), 3);
  file(path.join(storage, "played", "p1.wav"), 2); // spoken audio kept for export
  file(path.join(tmp, "unrelated.wav"), 50); // not ours: ignored
  file(path.join(uv, "mlx-audio", "lib"), 400);
  file(path.join(storage, "uv", "bin", "uv"), 30); // the extension's private uv and what it installed
  file(path.join(storage, "uv", "tools", "qwen-tts", "lib"), 500);
  for (const slug of ["mine", "designed"]) {
    fs.mkdirSync(path.join(storage, "qwen3-voices", slug), { recursive: true });
    writeWav(path.join(storage, "qwen3-voices", slug, "ref.wav"), 1);
    fs.writeFileSync(
      path.join(storage, "qwen3-voices", slug, "meta.json"),
      JSON.stringify({ name: slug, refText: "hello there", gain: 1, pace: 1 })
    );
  }
  const argos = path.join(root, "argos-translate");
  file(path.join(argos, "packages", "translate-en_he-1_5", "model.bin"), 100);
  const opts = {
    storageDir: storage,
    hfHome: hf,
    tmpDir: tmp,
    uvToolsDir: uv,
    extensionsDir: ext,
    argosDir: argos,
    engine: "qwen3",
    qwen3Model: "0.6B",
    qwen3Voice: "clone:mine",
    piperVoice: "",
    kokoroVoice: "",
    qwen3Runtime: "mlx",
  };
  return { root, storage, hf, tmp, argos, opts };
}

test("formatBytes and dirSize", async () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024 * 1024 * 3), "3 MB");
  assert.equal(formatBytes(1024 ** 3 * 2.5), "2.5 GB");
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a"), Buffer.alloc(2048));
  fs.mkdirSync(path.join(d, "sub"));
  fs.writeFileSync(path.join(d, "sub", "b"), Buffer.alloc(1024));
  assert.equal(await dirSize(d), 3072);
  assert.equal(await dirSize(path.join(d, "missing")), 0);
});

test("the scan finds every category, marks what is in use, and ignores other tools' files", async () => {
  const { opts } = fixture();
  const items = await scanStorage(opts);
  const by = (id) => items.find((i) => i.id === id);
  // Sorted by size, biggest first.
  assert.ok(items[0].bytes >= items[items.length - 1].bytes);
  // Qwen3 0.6B Base is what the active settings load (a clone is selected).
  assert.deepEqual(activeModelIds(opts), ["mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"]);
  assert.deepEqual(activeModelIds({ ...opts, qwen3Runtime: "torch" }), ["Qwen/Qwen3-TTS-12Hz-0.6B-Base"]);
  assert.equal(by("hf:models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-bf16").inUse, true);
  // The private uv is one removable item, in use while a Python engine is configured.
  assert.equal(by("uv:private").bytes, 530 * 1024);
  assert.equal(by("uv:private").removable, true);
  assert.equal(by("uv:private").inUse, true);
  assert.equal(by("uv:private").category, "helpers");
  // The PyTorch copy of the same model is dead weight when MLX is the runtime.
  assert.equal(by("hf:models--Qwen--Qwen3-TTS-12Hz-0.6B-Base").inUse, false);
  // Whisper builds this extension never downloads belong to other tools.
  assert.equal(by("hf:models--openai--whisper-tiny.en"), undefined);
  assert.equal(by("hf:models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16").inUse, false);
  assert.equal(by("hf:models--openai--whisper-small.en").inUse, false);
  assert.equal(
    items.find((i) => i.label.includes("other-model")),
    undefined,
    "models of other tools are not listed"
  );
  // Chatterbox: both runtimes' weights and the PyTorch virtualenv are listed,
  // and none of them is in use while another engine is selected.
  assert.equal(by("hf:models--mlx-community--chatterbox-multilingual-v3").inUse, false);
  assert.equal(by("hf:models--ResembleAI--chatterbox").inUse, false);
  assert.equal(by("chatterbox-venv").category, "helpers");
  assert.equal(by("chatterbox-venv").removable, true);
  const cbActive = await scanStorage({ ...opts, engine: "chatterbox", chatterboxRuntime: "torch" });
  const cbBy = (id) => cbActive.find((i) => i.id === id);
  assert.equal(cbBy("chatterbox-venv").inUse, true, "the runtime in use must not be offered for deletion as unused");
  assert.equal(cbBy("hf:models--ResembleAI--chatterbox").inUse, true);
  assert.equal(
    cbBy("hf:models--mlx-community--chatterbox-multilingual-v3").inUse,
    false,
    "the other runtime's copy is dead weight"
  );
  // The legacy Kokoro model is present and flagged as unused.
  const legacy = by("kokoro:kokoro-en-v0_19");
  assert.ok(legacy && legacy.inUse === false && /nothing uses it/.test(legacy.detail));
  // Voices are listed, sized, and marked as not re-downloadable.
  const voices = by("voices");
  assert.match(voices.label, /Your voices \(2\)/);
  assert.match(voices.hint, /export/i);
  assert.equal(voices.category, "voices");
  // Temp parts only count ours.
  assert.equal(by("temp").bytes, 3 * 1024);
  // The audio kept for export is listed, removable, and never "in use".
  assert.equal(by("played").bytes, 2 * 1024);
  assert.equal(by("played").category, "temp");
  assert.equal(by("played").inUse, false);
  // Tool venvs are advisory.
  assert.equal(by("uv:mlx-audio").removable, false);
  assert.match(by("uv:mlx-audio").hint, /uv tool uninstall mlx-audio/);
});

test("deleted voices are listed separately and are never part of a bulk free", async () => {
  const { opts, storage } = fixture();
  const trash = path.join(storage, "qwen3-voices", ".trash", "gone-123");
  fs.mkdirSync(trash, { recursive: true });
  writeWav(path.join(trash, "ref.wav"), 1);
  fs.writeFileSync(path.join(trash, "meta.json"), JSON.stringify({ name: "Gone" }));
  const items = await scanStorage(opts);
  const bin = items.find((i) => i.id === "voices-trash");
  assert.match(bin.label, /Deleted voices \(1, still restorable\)/);
  assert.equal(bin.category, "voices", "the trash is excluded from bulk cleanup like live voices");
  // The live-voices entry does not count or point at the trash.
  const live = items.find((i) => i.id === "voices");
  assert.match(live.label, /Your voices \(2\)/);
  assert.ok(live.paths.every((p) => !p.includes(".trash")));
  const unused = items.filter((i) => i.removable && !i.inUse && i.category !== "voices");
  assert.ok(!unused.some((i) => i.id.startsWith("voices")));
});

test("nothing outside the fixture is ever scanned, let alone deleted", async () => {
  // This is not hypothetical. The fixture once omitted `argosDir`, the scanner
  // fell back to the real ~/.local/share/argos-translate, and the removal test
  // below deleted a developer's own 100 MB translation model. The directories
  // are required arguments now; this keeps any new one from repeating it.
  const { opts, root } = fixture();
  for (const item of await scanStorage(opts)) {
    for (const p of item.paths ?? []) {
      // Only the fixture root. Every directory the fixture hands the scanner
      // lives under it, including its temp directory, so anything else means
      // a real location leaked in.
      assert.ok(p.startsWith(root), `scan reached outside the fixture: ${item.id} -> ${p}`);
    }
  }
});

test("removing frees the chosen items, keeps voices, and never touches advisory entries", async () => {
  const { opts, storage, hf, argos } = fixture();
  const items = await scanStorage(opts);
  const unused = items.filter((i) => i.removable && !i.inUse && i.category !== "voices");
  const { freed, errors } = await removeItems(unused);
  assert.deepEqual(errors, []);
  assert.ok(freed > 1_400_000, `freed ${freed}`);
  assert.ok(!fs.existsSync(path.join(storage, "kokoro", "kokoro-en-v0_19")));
  assert.ok(!fs.existsSync(path.join(hf, "hub", "models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16")));
  assert.ok(
    fs.existsSync(path.join(hf, "hub", "models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-bf16")),
    "in-use model kept"
  );
  assert.ok(fs.existsSync(path.join(storage, "qwen3-voices", "mine", "ref.wav")), "voices kept");
  assert.ok(!fs.existsSync(path.join(argos, "packages")), "the fixture's translation model went, not the developer's");
  // Advisory items are refused even if passed in.
  const uv = (await scanStorage(opts)).find((i) => i.id === "uv:mlx-audio");
  await removeItems([uv]);
  assert.ok(fs.existsSync(uv.paths[0]), "tool venvs are never deleted by us");
});

test("voices survive a backup round trip, and imports never overwrite", async () => {
  const { storage, root } = fixture();
  const voices = path.join(storage, "qwen3-voices");
  const pack = path.join(root, "backup.cvvoices.tgz");
  assert.equal(await exportVoices(voices, ["mine", "designed"], pack), 2);
  assert.ok(fs.statSync(pack).size > 200);
  // Import into an empty machine.
  const fresh = path.join(root, "fresh-voices");
  const imported = await importVoices(fresh, pack);
  assert.deepEqual(imported.map((i) => i.name).sort(), ["designed", "mine"]);
  assert.ok(fs.existsSync(path.join(fresh, "mine", "ref.wav")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, "mine", "meta.json"), "utf8")).refText, "hello there");
  // Importing again keeps the originals and renames the copies.
  const again = await importVoices(fresh, pack);
  assert.ok(again.every((i) => i.renamed));
  assert.ok(fs.existsSync(path.join(fresh, "mine-imported", "ref.wav")));
  // Junk in the archive is ignored, and a file with no profiles fails clearly.
  const junk = path.join(root, "junk.tgz");
  fs.writeFileSync(path.join(root, "notes.txt"), "hello");
  await exportVoices(voices, ["mine"], junk);
  await assert.rejects(importVoices(fresh, path.join(root, "notes.txt")), /import|tar|profiles/i);
  await assert.rejects(exportVoices(voices, ["../escape"], pack), /no voice profiles/);
});
