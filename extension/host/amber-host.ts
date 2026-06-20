/**
 * Native-messaging host for the amber browser extension.
 *
 * Chrome launches this process and speaks the native-messaging protocol over
 * stdio: each message is a 4-byte (native-endian) length prefix followed by
 * UTF-8 JSON. The extension sends one `{ url, html, resources? }` message (the
 * rendered DOM of the active tab); we archive it with amber and reply once with
 * the result, then exit.
 *
 * stdout is the protocol channel — nothing else may be written to it, so we
 * route all logging to stderr.
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveFromDom, defaultArchiveDir, type DomCapture } from "../../src/pipeline.js";

const LITTLE_ENDIAN = os.endianness() === "LE";

function readUInt32(buf: Buffer, offset: number): number {
  return LITTLE_ENDIAN ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

/** Encode a message as a native-endian length prefix + UTF-8 JSON body. */
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Decode one complete framed message from a buffer (inverse of `frame`). */
export function decodeMessage(buf: Buffer): unknown {
  const needed = readUInt32(buf, 0);
  return JSON.parse(buf.subarray(4, 4 + needed).toString("utf8"));
}

/** Read exactly one framed message from stdin. */
function readMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let needed = -1;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      const buf = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      if (needed < 0 && total >= 4) needed = readUInt32(buf, 0);
      if (needed >= 0 && total >= 4 + needed) {
        process.stdin.off("data", onData);
        try {
          resolve(decodeMessage(buf));
        } catch (err) {
          reject(err);
        }
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", reject);
    process.stdin.on("end", () => reject(new Error("stdin closed before a full message arrived")));
  });
}

function reply(message: unknown): void {
  process.stdout.write(frame(message), () => process.exit(0));
}

async function main(): Promise<void> {
  let msg: unknown;
  try {
    msg = await readMessage();
  } catch (err) {
    reply({ ok: false, error: `could not read message: ${String(err)}` });
    return;
  }

  const capture = msg as Partial<DomCapture>;
  if (!capture || typeof capture.url !== "string" || typeof capture.html !== "string") {
    reply({ ok: false, error: "message must include { url: string, html: string }" });
    return;
  }

  const outRoot = defaultArchiveDir();

  try {
    const res = await archiveFromDom(
      { url: capture.url, html: capture.html, resources: capture.resources },
      {
        outRoot,
        useLLM: true,
        model: process.env.AMBER_MODEL || "claude-sonnet-4-6",
        verbose: false,
        insecureTLS: process.env.AMBER_INSECURE_TLS === "1",
      },
    );
    reply({
      ok: true,
      outDir: res.outDir,
      indexPath: path.join(res.outDir, "index.html"),
      title: res.plan.title,
      planSource: res.plan.source,
      assetCount: res.assetCount,
      assetErrors: res.assetErrors,
      removed: res.cleanReport.removed,
      media: res.cleanReport.media.filter((m) => m.ok).length,
    });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
}

// Run the protocol loop only when launched directly by the browser — importing
// this module (e.g. from a test) must not touch stdin/stdout or reassign console.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Anything amber logs must NOT land on stdout (it would corrupt the framing).
  console.log = console.error;
  void main();
}
