/**
 * Wayback Machine support — the pure parts: recognising Wayback URLs, turning
 * human dates into Wayback timestamps and back, and building the raw (`id_`)
 * fetch URLs the capture routes through. The network path is covered
 * end-to-end against a fake Wayback server in archive-url.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTimestamp,
  mementoToTimestamp,
  normalizeTimestamp,
  parseWaybackUrl,
  timestampToIso,
  waybackFetchUrl,
  waybackResolver,
} from "../src/wayback.js";

test("parseWaybackUrl recognises replay URLs in their common spellings", () => {
  assert.deepEqual(parseWaybackUrl("https://web.archive.org/web/20090615123456/http://example.com/page?x=1"), {
    timestamp: "20090615123456",
    originalUrl: "http://example.com/page?x=1",
  });
  // Any replay modifier, partial timestamps, http on the archive host.
  assert.deepEqual(parseWaybackUrl("http://web.archive.org/web/2009id_/https://example.com/"), {
    timestamp: "2009",
    originalUrl: "https://example.com/",
  });
  assert.equal(parseWaybackUrl("https://web.archive.org/web/20090615im_/http://example.com/a.png")?.originalUrl, "http://example.com/a.png");
  // Scheme-less originals and Wayback's collapsed "http:/" both normalise.
  assert.equal(parseWaybackUrl("https://web.archive.org/web/20090615/example.com/")?.originalUrl, "http://example.com/");
  assert.equal(parseWaybackUrl("https://web.archive.org/web/20090615/http:/example.com/")?.originalUrl, "http://example.com/");
  // Not Wayback URLs.
  assert.equal(parseWaybackUrl("https://example.com/web/2009/"), null);
  assert.equal(parseWaybackUrl("https://web.archive.org/web/2009*/example.com*"), null);
  assert.equal(parseWaybackUrl("https://archive.org/details/foo"), null);
});

test("normalizeTimestamp accepts human dates and raw stamps, rejects garbage", () => {
  assert.equal(normalizeTimestamp("2009"), "2009");
  assert.equal(normalizeTimestamp("2009-06"), "200906");
  assert.equal(normalizeTimestamp("2009-06-15"), "20090615");
  assert.equal(normalizeTimestamp("2009-06-15T14:30"), "200906151430");
  assert.equal(normalizeTimestamp("2009-06-15 14:30:05"), "20090615143005");
  assert.equal(normalizeTimestamp(" 20090615123456 "), "20090615123456");
  assert.throws(() => normalizeTimestamp("June 2009"), /can't read/);
  assert.throws(() => normalizeTimestamp("09"), /can't read/);
});

test("timestampToIso / mementoToTimestamp / formatTimestamp round-trip", () => {
  assert.equal(timestampToIso("20090615083000"), "2009-06-15T08:30:00.000Z");
  assert.equal(timestampToIso("2009"), "2009-01-01T00:00:00.000Z"); // partial → first instant
  assert.equal(timestampToIso("200906"), "2009-06-01T00:00:00.000Z");
  assert.equal(mementoToTimestamp("Mon, 15 Jun 2009 08:30:00 GMT"), "20090615083000");
  assert.equal(mementoToTimestamp("not a date"), null);
  assert.equal(formatTimestamp("20090615083000"), "2009-06-15 08:30 UTC");
  assert.equal(formatTimestamp("200906"), "2009-06");
  assert.equal(formatTimestamp("2009"), "2009");
});

test("waybackFetchUrl / waybackResolver route through the raw id_ modifier at the timestamp", () => {
  assert.equal(
    waybackFetchUrl("20090615083000", "http://example.com/a.css"),
    "https://web.archive.org/web/20090615083000id_/http://example.com/a.css",
  );
  const resolve = waybackResolver("20090615083000", "http://127.0.0.1:9999");
  assert.equal(resolve("http://example.com/img/logo.gif"), "http://127.0.0.1:9999/web/20090615083000id_/http://example.com/img/logo.gif");
});
