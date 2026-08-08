/**
 * `amber serve` — a tiny local static server for viewing archives.
 *
 * Most archives open fine by double-clicking index.html. Keep-js archives of
 * WebGL-heavy sites don't: Chrome treats every file:// URL as a unique origin,
 * so uploading a locally-loaded <img>/<video> as a WebGL texture throws
 * SecurityError and the site's rendering dies. Over http://127.0.0.1 the
 * archive is one origin and everything composites. Localhost-only, zero deps.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { AmberError } from "./errors.js";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve what the user asked to serve: an archive folder path, or a slug
 * under `outRoot`. Must contain an index.html.
 */
export function resolveArchiveDir(arg: string, outRoot: string): string {
  const candidates = [path.resolve(arg), path.join(outRoot, arg)];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  throw new AmberError(
    `no archive found at "${arg}" — expected a folder containing index.html\n` +
      `  (looked in ${candidates.join(" and ")})`,
  );
}

export interface ServeResult {
  server: http.Server;
  url: string;
  port: number;
}

/** Serve `dir` on 127.0.0.1. Port 0 (default) picks a free ephemeral port. */
export async function serveArchive(dir: string, port = 0): Promise<ServeResult> {
  const root = fs.realpathSync(dir);

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let rel = path.normalize(reqPath).replace(/^([/\\])+/, "");
    if (rel === "" || rel === ".") rel = "index.html";
    const abs = path.join(root, rel);
    // path.join + normalize can still be escaped by ../ — resolve and contain.
    if (!path.resolve(abs).startsWith(root + path.sep) && path.resolve(abs) !== root) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let file = abs;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    } catch {
      /* fall through to the read attempt */
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, url: `http://127.0.0.1:${boundPort}/`, port: boundPort };
}
