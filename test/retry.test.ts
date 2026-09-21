/** Deterministic tests for fetchRetrying against a local server — no external network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { fetchRetrying } from "../src/capture.js";

async function serve(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("fetchRetrying retries a 503 with backoff and returns the eventual 200", async () => {
  let hits = 0;
  const s = await serve((_req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      res.end();
    } else {
      res.end("ok");
    }
  });
  try {
    const res = await fetchRetrying(`${s.base}/x`, {}, { attempts: 4, baseDelayMs: 5 });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(hits, 3);
  } finally {
    await s.close();
  }
});

test("fetchRetrying stops after `attempts` and hands back the last retryable response", async () => {
  let hits = 0;
  const s = await serve((_req, res) => {
    hits++;
    res.statusCode = 503;
    res.end();
  });
  try {
    const res = await fetchRetrying(`${s.base}/x`, {}, { attempts: 3, baseDelayMs: 5 });
    assert.equal(res.status, 503);
    assert.equal(hits, 3);
  } finally {
    await s.close();
  }
});

test("fetchRetrying retries a refused connection (how archive.org throttles), then throws", async () => {
  const s = await serve(() => {});
  await s.close(); // nothing listens on the port any more -> ECONNREFUSED
  const t0 = Date.now();
  await assert.rejects(fetchRetrying(`${s.base}/x`, {}, { attempts: 3, baseDelayMs: 40 }), TypeError);
  assert.ok(Date.now() - t0 >= 60, "two backoffs (>=30ms each) happened before giving up");
});

test("fetchRetrying does not replay deterministic failures — a redirect loop is one chain, not `attempts` of them", async () => {
  let hits = 0;
  const s = await serve((req, res) => {
    hits++;
    res.writeHead(302, { location: `http://${req.headers.host}/loop` });
    res.end();
  });
  try {
    await assert.rejects(fetchRetrying(`${s.base}/loop`, { redirect: "follow" }, { attempts: 3, baseDelayMs: 5 }));
    assert.ok(hits <= 21, `one chain of at most 21 hops, got ${hits}`);
  } finally {
    await s.close();
  }
});
