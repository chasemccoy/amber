/**
 * decodeHtml: the historical web is mostly not UTF-8, and Response.text()
 * decodes UTF-8 unconditionally. Precedence: BOM > Content-Type charset >
 * <meta> charset > (UTF-8 if the bytes are valid UTF-8, else windows-1252);
 * an unknown label at any step falls through to the next, as Chromium does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCss, decodeHtml, sniffCharset } from "../src/charset.js";

const latin1 = (s: string) => Buffer.from(s, "latin1");

test("decodeHtml honours the Content-Type charset (windows-1252 é is not U+FFFD)", () => {
  const body = latin1("<p>caf\xe9</p>");
  assert.equal(decodeHtml(body, "text/html; charset=windows-1252"), "<p>café</p>");
  assert.equal(decodeHtml(body, "text/html; charset=ISO-8859-1"), "<p>café</p>");
  assert.equal(decodeHtml(body, "text/html;charset=EUC-JP".replace("EUC-JP", "latin1")), "<p>café</p>"); // no space after ';'
  // The very bug: utf-8 decoding of a latin-1 byte. A header is "certain" —
  // browsers don't rescue it either.
  assert.equal(decodeHtml(body, "text/html; charset=utf-8"), "<p>caf�</p>");
});

test("windows-1252's 0x80–0x9F block decodes to curly quotes and dashes, not C1 controls", () => {
  const body = latin1("<p>\x93quoted\x94 \x96 it\x92s \x85</p>");
  assert.equal(decodeHtml(body, "text/html; charset=iso-8859-1"), "<p>“quoted” – it’s …</p>");
});

test("<meta> sniffing ignores comments and charset= text in unrelated meta tags", () => {
  const cafe = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin-1
  // A commented-out declaration must not win over the real one after it.
  const commented = Buffer.concat([
    Buffer.from('<!-- <meta charset="shift_jis"> --><meta charset="windows-1252"><p>'),
    cafe,
    Buffer.from("</p>"),
  ]);
  assert.equal(sniffCharset(commented, "text/html").label, "windows-1252");
  // "charset=" inside a description is prose, not a declaration.
  const prose = Buffer.concat([
    Buffer.from('<meta name="description" content="set charset=utf-8 in your headers"><p>'),
    cafe,
    Buffer.from("</p>"),
  ]);
  assert.equal(sniffCharset(prose, "text/html").source, "default", "falls through to the byte-level default");
  // The http-equiv form still counts.
  const httpEquiv = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">');
  assert.equal(sniffCharset(httpEquiv, "text/html").label, "euc-jp");
});

test("decodeCss honours @charset / the header and strips the rule from the UTF-8 result", () => {
  const latin1 = Buffer.concat([Buffer.from('@charset "iso-8859-1";\n.q:before{content:"'), Buffer.from([0xe9]), Buffer.from('"}')]);
  assert.equal(decodeCss(latin1, "text/css"), '\n.q:before{content:"é"}');
  // Header beats the rule; a plain UTF-8 sheet is untouched.
  assert.equal(decodeCss(Buffer.from("a{color:red}"), "text/css; charset=utf-8"), "a{color:red}");
  const undeclared = Buffer.concat([Buffer.from('b:after{content:"'), Buffer.from([0x93, 0x94]), Buffer.from('"}')]);
  assert.equal(decodeCss(undeclared, "text/css"), 'b:after{content:"“”"}', "invalid UTF-8 defaults to windows-1252");
});

test("decodeHtml falls back to a <meta> charset when the header has none", () => {
  const body = latin1(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body>na\xefve</body></html>`);
  assert.deepEqual(sniffCharset(body, "text/html"), { label: "windows-1252", source: "meta" });
  assert.match(decodeHtml(body, "text/html"), /naïve/);

  const html5 = latin1(`<!doctype html><meta charset="windows-1252"><p>\x93quoted\x94</p>`);
  assert.equal(sniffCharset(html5, null).source, "meta");
  assert.match(decodeHtml(html5, null), /“quoted”/);
});

test("an unrecognised header label falls through to the <meta>, like Chromium", () => {
  const body = latin1(`<meta charset="windows-1252"><p>caf\xe9</p>`);
  assert.deepEqual(sniffCharset(body, "text/html; charset=none"), { label: "windows-1252", source: "meta" });
  assert.equal(decodeHtml(body, "text/html; charset=x-made-up-1999"), '<meta charset="windows-1252"><p>café</p>');
});

test("with no declaration anywhere: UTF-8 when the bytes are valid UTF-8, else windows-1252", () => {
  // heise.de 2001 / lemonde.fr 2002: no header charset, no meta, latin-1 bytes.
  const undeclaredLatin1 = latin1("<html><body>Z\xe4hlsoftware</body></html>");
  assert.deepEqual(sniffCharset(undeclaredLatin1, "text/html"), { label: "windows-1252", source: "default" });
  assert.match(decodeHtml(undeclaredLatin1, "text/html"), /Zählsoftware/);

  const undeclaredUtf8 = Buffer.from("<html><body>日本語 — café</body></html>", "utf8");
  assert.deepEqual(sniffCharset(undeclaredUtf8, "text/html"), { label: "utf-8", source: "utf-8-valid" });
  assert.match(decodeHtml(undeclaredUtf8, "text/html"), /日本語 — café/);
});

test("decodeHtml: BOM wins over everything", () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>é</p>", "utf8")]);
  assert.deepEqual(sniffCharset(bom, "text/html; charset=windows-1252"), { label: "utf-8", source: "bom" });
  assert.equal(decodeHtml(bom, "text/html; charset=windows-1252"), "<p>é</p>");
});

test("decodeHtml handles CJK legacy encodings (Shift_JIS, EUC-JP)", () => {
  const sjis = Buffer.concat([Buffer.from("<p>"), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from("</p>")]);
  assert.equal(decodeHtml(sjis, "text/html; charset=Shift_JIS"), "<p>日本</p>");
  // 新着情報 in EUC-JP (yahoo.co.jp, 2001 — 1084 U+FFFD under res.text())
  const eucjp = Buffer.concat([Buffer.from("<p>"), Buffer.from([0xbf, 0xb7, 0xc3, 0xe5, 0xbe, 0xf0, 0xca, 0xf3]), Buffer.from("</p>")]);
  assert.equal(decodeHtml(eucjp, "text/html;charset=EUC-JP"), "<p>新着情報</p>");
});
