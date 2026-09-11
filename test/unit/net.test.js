// Downloads go through the proxy the machine is configured for: Node's own
// https client ignores HTTPS_PROXY, and a corporate desktop that reaches the
// internet only that way could not fetch a single model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { download, proxyFor } = require("../../out/tts/net.js");
const { tmpDir } = require("../helpers");

test("the proxy comes from the setting, else the environment, unless NO_PROXY names the host", () => {
  const env = { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "localhost, .internal.corp, github.com:443" };
  assert.equal(proxyFor("https://huggingface.co/x", { env }).href, "http://proxy.corp:3128/");
  assert.equal(proxyFor("https://github.com/x", { env }), undefined, "an exempt host, port and all");
  assert.equal(proxyFor("https://git.internal.corp/x", { env }), undefined, "a domain suffix");
  assert.equal(proxyFor("https://huggingface.co/x", { env, proxy: "http://other:8080" }).host, "other:8080");
  assert.equal(
    proxyFor("https://huggingface.co/x", { env: { http_proxy: "proxy.corp:80" } }).href,
    "http://proxy.corp/"
  );
  assert.equal(proxyFor("https://huggingface.co/x", { env: {} }), undefined, "no proxy: a direct connection");
  assert.equal(proxyFor("https://huggingface.co/x", { env: { NO_PROXY: "*", HTTPS_PROXY: "http://p" } }), undefined);
  assert.equal(proxyFor("not a url", { env: { HTTPS_PROXY: "http://p" } }), undefined);
});

test("a download through a proxy opens a CONNECT tunnel to the target, and leaves no partial file when refused", async () => {
  const seen = [];
  const proxy = http.createServer((_req, res) => res.end());
  proxy.on("connect", (req, socket) => {
    seen.push({ target: req.url, auth: req.headers["proxy-authorization"] });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const port = proxy.address().port;
  const dest = path.join(tmpDir(), "file.bin");
  try {
    await assert.rejects(
      download("https://huggingface.co/model.onnx", dest, () => {}, {
        env: { HTTPS_PROXY: `http://user:p%40ss@127.0.0.1:${port}` },
      }),
      /refused the connection \(HTTP 403\)/
    );
    assert.deepEqual(seen, [
      { target: "huggingface.co:443", auth: `Basic ${Buffer.from("user:p@ss").toString("base64")}` },
    ]);
    assert.ok(!fs.existsSync(dest), "nothing half-written is left for a later run to trust");
  } finally {
    proxy.close();
  }
});

test("a proxy that is not there is reported as such, not as a failure of the site", async () => {
  const dest = path.join(tmpDir(), "file.bin");
  await assert.rejects(
    download("https://huggingface.co/model.onnx", dest, () => {}, { env: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
    /could not reach the proxy 127\.0\.0\.1:1/
  );
});
