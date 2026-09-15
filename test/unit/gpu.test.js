// Which torch build a machine's GPU can use, and whether the installed one
// is it. PyPI's Windows torch has no CUDA, so a laptop with a GeForce ran
// Qwen3 on the CPU, several times slower than speech, and nothing said so.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { torchIndexFor, torchIndexArgs, torchHasCuda, torchCudaOf, venvOf } = require("../../out/platform/gpu.js");
const { checkSetup } = require("../../out/setup/diagnostics.js");
const { tmpDir } = require("../helpers");

test("the index follows the driver's CUDA generation, on Windows only, and a torch 2.6 pin stays on 12.6", () => {
  const at = (cuda) => ({ cuda, gpu: "NVIDIA GeForce RTX 3060 Laptop GPU" });
  assert.equal(torchIndexFor(at("13.1"), "win32"), "https://download.pytorch.org/whl/cu130");
  assert.equal(torchIndexFor(at("12.9"), "win32"), "https://download.pytorch.org/whl/cu128");
  assert.equal(torchIndexFor(at("12.8"), "win32"), "https://download.pytorch.org/whl/cu128");
  assert.equal(torchIndexFor(at("12.6"), "win32"), "https://download.pytorch.org/whl/cu126");
  assert.equal(torchIndexFor(at("12.2"), "win32"), "https://download.pytorch.org/whl/cu126");
  assert.equal(torchIndexFor(at("11.8"), "win32"), undefined, "too old for the builds on offer");
  assert.equal(torchIndexFor(at("13.1"), "win32", true), "https://download.pytorch.org/whl/cu126");
  assert.equal(torchIndexFor(at("13.1"), "linux"), undefined, "PyPI's Linux build carries CUDA");
  assert.equal(torchIndexFor(undefined, "win32"), undefined, "no driver, no GPU build");
  assert.deepEqual(torchIndexArgs("https://download.pytorch.org/whl/cu130"), [
    "--index",
    "https://download.pytorch.org/whl/cu130",
  ]);
  assert.deepEqual(torchIndexArgs(undefined), []);
});

test("whether the installed torch was built with CUDA is read from the files it ships", () => {
  const root = tmpDir("cv-gpu-");
  const cpu = path.join(root, "cpu");
  const cuda = path.join(root, "cuda");
  const none = path.join(root, "none");
  for (const [venv, files] of [
    [cpu, ["c10.dll"]],
    [cuda, ["c10.dll", "c10_cuda.dll"]],
  ]) {
    const lib = path.join(venv, "Lib", "site-packages", "torch", "lib");
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(path.join(venv, "Scripts"), { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(lib, f), "");
    }
  }
  assert.equal(torchHasCuda(cpu, "win32"), false);
  assert.equal(torchHasCuda(cuda, "win32"), true);
  assert.equal(torchHasCuda(none, "win32"), undefined, "torch is not installed there");
  assert.equal(torchCudaOf(path.join(cpu, "Scripts", "python.exe")), process.platform === "win32" ? false : undefined);
  assert.equal(venvOf(path.join(cpu, "Scripts", "python.exe")), cpu);
  // The POSIX layout: lib/pythonX.Y/site-packages.
  const posix = path.join(root, "posix");
  const plib = path.join(posix, "lib", "python3.12", "site-packages", "torch", "lib");
  fs.mkdirSync(plib, { recursive: true });
  fs.writeFileSync(path.join(plib, "libc10_cuda.so"), "");
  assert.equal(torchHasCuda(posix, "linux"), true);
});

test("Check Setup names a PyTorch runtime that runs on the CPU beside a GPU, and sends it back through the setup", () => {
  const input = {
    ffmpeg: true,
    ffplay: true,
    pythonInstaller: true,
    backups: true,
    engine: "qwen3",
    engineName: "qwen3",
    engineReady: true,
    kokoroReady: false,
    kokoroDaemon: false,
    qwen3Runtime: "torch",
    chatterboxRuntime: "torch",
    chatterboxDiacritizer: true,
    listenTo: "all",
    terminalOwner: true,
    windows: 1,
    piperAvailable: false,
    persistentPlayer: false,
    playerName: "powershell",
    playerTempo: false,
    hooksInstalled: true,
    voices: 2,
    speakLanguage: "",
    translationReady: false,
    translationPairs: [],
  };
  const rows = (i) => checkSetup(i).filter((c) => /Qwen3|Chatterbox/.test(c.name));
  const [q, c] = rows({ ...input, gpu: "NVIDIA GeForce RTX 3060 Laptop GPU", qwen3Cuda: false, chatterboxCuda: false });
  assert.equal(q.status, "partial");
  assert.match(q.detail, /CPU/);
  assert.match(q.detail, /RTX 3060/);
  assert.equal(q.command, "claudeCodeTts.setupQwen3");
  assert.equal(c.status, "partial");
  assert.equal(c.command, "claudeCodeTts.setupChatterbox");
  const [q2, c2] = rows({ ...input, gpu: "NVIDIA GeForce RTX 3060 Laptop GPU", qwen3Cuda: true, chatterboxCuda: true });
  assert.equal(q2.status, "ok");
  assert.equal(c2.status, "ok");
  const [q3] = rows({ ...input, gpu: undefined, qwen3Cuda: false });
  assert.equal(q3.status, "ok", "no GPU to use: the CPU build is the right one");
  const [q4] = rows({ ...input, qwen3Runtime: "mlx", gpu: undefined, qwen3Cuda: undefined });
  assert.equal(q4.status, "ok");
});
