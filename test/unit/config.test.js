// The settings the speech pipeline runs on, read without the rest of the
// extension: readConfig() is called at activation, and once built another
// config from inside itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpDir } = require("../helpers");
const { createVscodeStub, installVscodeStub } = require("../helpers/vscodeStub");

// MLX asked for on a machine that is not Apple Silicon resolves to no
// runtime at all, without a probe; on Apple Silicon it resolves to what is
// installed, and the read is the same either way.
const harness = createVscodeStub({
  settings: { enabled: false, volume: 0, engine: "qwen3", "qwen3.runtime": "mlx", "qwen3.model": "0.6B" },
});
installVscodeStub(harness.stub);
const { runtime } = require("../../out/core/runtime.js");
runtime.context = harness.context(tmpDir("cv-config-storage-"));
const { readConfig, chunkPlan, chunkPlanFor, firstChunk } = require("../../out/core/config.js");

test("the config reads with Qwen3 selected and no runtime for it, and its merge limit is the plan's first chunk", () => {
  // Used to recurse: the merge limit came from chunkPlanFor, whose default
  // runtime argument read config(), which was being built.
  const cfg = readConfig();
  assert.equal(cfg.speechConfig.engine, "qwen3");
  // The MLX plan whether the runtime is there or not: "mlx" never resolves to torch.
  assert.equal(cfg.speechConfig.coalesceMax, 110);
  assert.equal(cfg.speechConfig.coalesceMax, firstChunk(chunkPlanFor("qwen3", "0.6B")));
});

test("reading the settings starts no process, whichever runtime is asked for", () => {
  // config() is read at activation, and the probe that is sure which Qwen3
  // runtime this machine has starts a Python that imports mlx_audio or
  // torch: seconds of a frozen extension host, three times over, for a
  // machine whose venv was removed. What is on disk answers it.
  const cp = require("child_process");
  const real = cp.spawnSync;
  const started = [];
  cp.spawnSync = (cmd, args = []) => {
    started.push([cmd, ...(Array.isArray(args) ? args : [])].join(" "));
    return { status: 1, signal: null, stdout: "", stderr: "", pid: 1, output: ["", "", ""] };
  };
  try {
    for (const pref of ["auto", "mlx", "torch"]) {
      harness.settings.set("qwen3.runtime", pref);
      assert.ok(readConfig().speechConfig.coalesceMax > 0, pref);
    }
  } finally {
    cp.spawnSync = real;
    harness.settings.set("qwen3.runtime", "mlx");
  }
  assert.deepEqual(started, [], "reading the settings ran a probe; it must read the disk instead");
});

test("the plan depends on the runtime it is given, not on the settings", () => {
  assert.deepEqual(chunkPlan("qwen3", "0.6B", "torch"), [45, 70, 90]);
  assert.deepEqual(chunkPlan("qwen3", "0.6B", "mlx"), chunkPlan("qwen3", "0.6B", undefined));
  assert.equal(chunkPlan("system", "0.6B", undefined), 260);
  assert.equal(firstChunk(260), 260);
  assert.equal(firstChunk([45, 70, 90]), 45);
});
