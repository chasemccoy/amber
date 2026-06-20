/** Deterministic tests for the extension's native-messaging host framing.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";

import { frame, decodeMessage } from "../extension/host/amber-host.js";

test("native-host framing round-trips a message (length prefix + UTF-8 JSON)", () => {
  const msg = { ok: true, outDir: "/tmp/x", title: "héllo · unicode ✓" };
  const buf = frame(msg);
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  assert.equal(buf.length, 4 + body.length); // 4-byte header + body
  assert.deepEqual(decodeMessage(buf), msg);
});

test("decodeMessage reads only the framed length, ignoring trailing bytes", () => {
  const buf = Buffer.concat([frame({ a: 1 }), Buffer.from("trailing garbage")]);
  assert.deepEqual(decodeMessage(buf), { a: 1 });
});
