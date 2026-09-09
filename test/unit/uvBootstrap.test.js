// The private uv: which release asset each platform gets, how the published
// checksum is read, and that a download whose checksum does not match is
// refused and leaves nothing behind. The network is replaced by a fetcher
// that serves files from a local "release" directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmpDir } = require("../helpers");
const uvb = require("../../out/platform/uvBootstrap.js");

test("every supported platform maps to a real release asset name", () => {
  assert.deepEqual(uvb.uvAsset("darwin", "arm64"), { name: "uv-aarch64-apple-darwin.tar.gz", archive: "tar.gz" });
  assert.deepEqual(uvb.uvAsset("darwin", "x64"), { name: "uv-x86_64-apple-darwin.tar.gz", archive: "tar.gz" });
  assert.deepEqual(uvb.uvAsset("linux", "x64"), { name: "uv-x86_64-unknown-linux-gnu.tar.gz", archive: "tar.gz" });
  assert.deepEqual(uvb.uvAsset("linux", "arm64"), { name: "uv-aarch64-unknown-linux-gnu.tar.gz", archive: "tar.gz" });
  assert.deepEqual(uvb.uvAsset("win32", "x64"), { name: "uv-x86_64-pc-windows-msvc.zip", archive: "zip" });
  assert.equal(uvb.uvAsset("freebsd", "x64"), undefined);
  assert.equal(uvb.uvAsset("linux", "ia32"), undefined);
});

test("the checksum sidecar is read in the format uv publishes", () => {
  const hex = "51c6170e8e3a01cef9f33b94f582b7b81ac65046f55d40afb35f9cff5a68c179";
  assert.equal(uvb.parseSha256Sidecar(`${hex}  uv-aarch64-apple-darwin.tar.gz\n`), hex);
  assert.equal(uvb.parseSha256Sidecar(hex.toUpperCase()), hex);
  assert.equal(uvb.parseSha256Sidecar("not a checksum"), undefined);
});

test("the private environment keeps everything under the storage folder", () => {
  const env = uvb.privateUvEnv("/store");
  for (const [k, v] of Object.entries(env))
    if (k.endsWith("_DIR")) assert.ok(v.startsWith(path.join("/store", "uv")), v);
  assert.equal(env.UV_NO_MODIFY_PATH, "1");
  assert.equal(env.UV_PYTHON_PREFERENCE, "only-managed", "a Python outside the folder must never be picked up");
  assert.deepEqual(uvb.toolInstallArgs({ bin: "uv", env: {}, private: true }, "qwen-tts"), [
    "tool",
    "install",
    "--python",
    "3.12",
    "qwen-tts",
  ]);
  assert.deepEqual(uvb.toolInstallArgs({ bin: "uv", env: {}, private: false }, "sherpa-onnx", ["--with", "numpy"]), [
    "tool",
    "install",
    "--with",
    "numpy",
    "sherpa-onnx",
  ]);
});

/** A fake release: a tarball holding a runnable "uv" plus its .sha256 sidecar. */
function fakeRelease(dir, { corrupt = false } = {}) {
  const asset = uvb.uvAsset();
  const stage = path.join(dir, "stage", asset.name.replace(/\.(tar\.gz|zip)$/, ""));
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "uv"), "#!/bin/sh\necho 'uv 0.0.0-fake'\n", { mode: 0o755 });
  const archive = path.join(dir, asset.name);
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", path.join(dir, "stage"), path.basename(stage)]).status, 0);
  const hash = require("crypto").createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(`${archive}.sha256`, `${corrupt ? "0".repeat(64) : hash}  ${asset.name}\n`);
  return (url, dest) => {
    const name = url.split("/").pop();
    fs.copyFileSync(path.join(dir, name), dest);
    return Promise.resolve();
  };
}

test(
  "a verified archive is installed and runs; the version is recorded",
  { skip: process.platform === "win32" && "POSIX shell stub" },
  async () => {
    const storage = tmpDir("cv-uvstore-");
    const fetch = fakeRelease(tmpDir("cv-uvrel-"));
    const messages = [];
    const bin = await uvb.installPrivateUv(storage, (m) => messages.push(m), fetch);
    assert.equal(bin, uvb.privateUvBinary(storage));
    assert.ok(fs.existsSync(bin));
    assert.equal(fs.readFileSync(path.join(uvb.privateUvRoot(storage), "version"), "utf8"), uvb.UV_VERSION);
    assert.ok(!fs.existsSync(path.join(uvb.privateUvRoot(storage), "tmp")), "the download scratch space is cleaned up");
    assert.ok(messages.includes("fetching the checksum") && messages.includes("downloading uv"));
    // Found by the lookup as the private copy with its private environment
    // (the developer machine's own uv is passed as absent; it is found first
    // whenever it exists, and tested for by the platform tests' hasCommand).
    const found = uvb.findUv(storage, null);
    assert.ok(found?.private, "the private copy is used when there is no uv of the user's own");
    assert.equal(found.env.UV_TOOL_DIR, uvb.privateUvToolsDir(storage));
    assert.equal(
      uvb.findUv(storage, { bin: "uv", env: {}, private: false })?.private,
      false,
      "the user's own uv wins when present"
    );
  }
);

test(
  "a checksum mismatch is refused and nothing is installed",
  { skip: process.platform === "win32" && "POSIX shell stub" },
  async () => {
    const storage = tmpDir("cv-uvstore-");
    const fetch = fakeRelease(tmpDir("cv-uvrel-"), { corrupt: true });
    await assert.rejects(
      uvb.installPrivateUv(storage, () => {}, fetch),
      /checksum mismatch/
    );
    assert.ok(!fs.existsSync(uvb.privateUvBinary(storage)), "no binary was placed");
    assert.ok(!fs.existsSync(path.join(uvb.privateUvRoot(storage), "tmp")), "no leftovers");
    assert.equal(uvb.findUv(storage, null), undefined, "nothing usable was left behind");
  }
);
