/**
 * The one HTTPS client: downloads with redirects, through the proxy the
 * machine is configured for.
 *
 * Node's https module ignores HTTPS_PROXY, so on a machine that reaches the
 * internet only through a proxy (most corporate Windows and Linux desktops)
 * every download here failed with a connection error while the Python side
 * (uv, pip, Hugging Face) worked, because those honour the variables. The
 * proxy is taken from the editor's own `http.proxy` setting when one is set,
 * else from the environment, and NO_PROXY is respected. Proxies speak plain
 * CONNECT here; a proxy that itself needs TLS is connected to over TLS first.
 */
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as tls from "tls";

/** No data for this long and the download is given up rather than hung. */
const IDLE_TIMEOUT_MS = 60_000;

/** The editor's `http.proxy` setting, read when a download starts; set at activation. */
let proxySetting: () => string | undefined = () => undefined;

export function setProxySetting(read: () => string | undefined): void {
  proxySetting = read;
}

export interface ProxyLookup {
  /** An explicit proxy URL; wins over the environment. */
  proxy?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The proxy a URL goes through, or undefined for a direct connection: the
 * explicit one, else HTTPS_PROXY / HTTP_PROXY in either case, unless NO_PROXY
 * names the host ("*", a host, or a domain suffix, with or without a dot).
 */
export function proxyFor(url: string, lookup: ProxyLookup = {}): URL | undefined {
  const env = lookup.env ?? process.env;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const host = target.hostname.toLowerCase();
  const exempt = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((rule) => rule.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean);
  if (
    exempt.some(
      (rule) => rule === "*" || host === rule.replace(/^\./, "") || host.endsWith(`.${rule.replace(/^\./, "")}`)
    )
  ) {
    return undefined;
  }
  const chosen = lookup.proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!chosen) {
    return undefined;
  }
  try {
    return new URL(chosen.includes("://") ? chosen : `http://${chosen}`);
  } catch {
    return undefined;
  }
}

/** A TLS connection to the target, tunnelled through the proxy with CONNECT. */
function connectThrough(proxy: URL, target: URL): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const port = Number(target.port || 443);
    const headers: Record<string, string> = { host: `${target.hostname}:${port}` };
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const req = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers,
      // A proxy that is itself reached over TLS.
      createConnection:
        proxy.protocol === "https:"
          ? () => tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
          : undefined,
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`the proxy ${proxy.host} did not answer`)));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`the proxy ${proxy.host} refused the connection (HTTP ${res.statusCode})`));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname }, () => resolve(secure));
      secure.on("error", reject);
    });
    req.on("error", (e) => reject(new Error(`could not reach the proxy ${proxy.host}: ${e.message}`)));
    req.end();
  });
}

/** HTTPS download following redirects (GitHub/Hugging Face redirect to CDNs). */
export function download(
  url: string,
  dest: string,
  onBytes: (n: number) => void,
  lookup: ProxyLookup = {},
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("too many redirects"));
      return;
    }
    const fail = (e: Error) => {
      fs.rm(dest, { force: true }, () => reject(e)); // never leave a partial file behind
    };
    const proxy = proxyFor(url, { proxy: lookup.proxy ?? proxySetting(), env: lookup.env });
    const target = new URL(url);
    const request = (socket?: tls.TLSSocket) => {
      const req = https.get(
        url,
        {
          headers: { "user-agent": "claude-code-tts-vscode" },
          ...(socket ? { agent: false, createConnection: () => socket } : {}),
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            // Location may be relative; resolve it against the current URL.
            const next = new URL(res.headers.location, url).toString();
            download(next, dest, onBytes, lookup, redirects + 1).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.setTimeout(IDLE_TIMEOUT_MS, () => res.destroy(new Error(`no data from ${target.host} for a minute`)));
          res.on("data", (chunk: Buffer) => onBytes(chunk.length));
          res.pipe(out);
          out.on("finish", () => out.close(() => resolve()));
          out.on("error", fail);
          res.on("error", fail);
        }
      );
      req.on("error", fail);
    };
    if (proxy) {
      connectThrough(proxy, target).then(request, fail);
    } else {
      request();
    }
  });
}
