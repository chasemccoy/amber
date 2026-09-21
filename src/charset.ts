/**
 * Decode an HTML body honoring its declared charset. Node's `Response.text()`
 * decodes UTF-8 unconditionally — fine for the modern web, mojibake for the
 * Latin-1 / windows-1252 / EUC-JP pages that make up much of the historical
 * web (and a few living ones). Precedence follows the HTML encoding-sniffing
 * algorithm as browsers actually apply it: BOM > Content-Type charset > <meta>
 * charset in the leading bytes > default — where an unrecognised label at any
 * step falls through to the next (Chromium ignores `charset=none` and reads
 * the meta), and the no-declaration default is UTF-8 only when the bytes are
 * valid UTF-8, else windows-1252 (browsers' locale default for undeclared
 * pages, which is what a 2001 page with no charset anywhere was written for).
 */

/** How far into the body to look for a <meta charset>. The spec prescans 1024 bytes; Chromium honours later ones too. */
const META_SCAN_BYTES = 8192;

export interface CharsetVerdict {
  label: string;
  source: "bom" | "header" | "meta" | "utf-8-valid" | "default";
}

export function sniffCharset(body: Buffer, contentType?: string | null): CharsetVerdict {
  const bom = bomLabel(body);
  if (bom) return { label: bom, source: "bom" };
  const header = knownLabel(headerCharset(contentType));
  if (header) return { label: header, source: "header" };
  const meta = knownLabel(metaCharset(body));
  if (meta) return { label: meta, source: "meta" };
  if (isValidUtf8(body)) return { label: "utf-8", source: "utf-8-valid" };
  return { label: "windows-1252", source: "default" };
}

export function decodeHtml(body: Buffer, contentType?: string | null): string {
  const { label } = sniffCharset(body, contentType);
  return decodeWith(label, body) ?? decodeWith("utf-8", body)!;
}

function bomLabel(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return "utf-8";
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return "utf-16le";
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return "utf-16be";
  return null;
}

function headerCharset(contentType?: string | null): string | null {
  const m = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

function metaCharset(b: Buffer): string | null {
  // Charset declarations are ASCII, so a latin1 view of the leading bytes is
  // safe to regex regardless of the true encoding. Comments are skipped, as
  // the browser prescan skips them, and "charset=" only counts as a `charset`
  // attribute or inside an http-equiv Content-Type value — not as text in
  // some other meta's content.
  const head = b.subarray(0, META_SCAN_BYTES).toString("latin1").replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    }
    if (attrs.charset) return attrs.charset.toLowerCase();
    if (/^content-type$/i.test(attrs["http-equiv"] ?? "")) {
      const m = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(attrs.content ?? "");
      if (m) return m[1]!.toLowerCase();
    }
  }
  return null;
}

/**
 * CSS has its own rules: BOM > Content-Type charset > a leading
 * `@charset "x";` > (valid UTF-8, else windows-1252). The `@charset` rule is
 * dropped from the result: the archive is written as UTF-8, and a surviving
 * `@charset "iso-8859-1"` would mis-decode it when served from the folder.
 */
export function decodeCss(body: Buffer, contentType?: string | null): string {
  const rule = /^\s*@charset\s+"([^"]+)"\s*;/i.exec(body.subarray(0, 1024).toString("latin1"));
  const label =
    bomLabel(body) ??
    knownLabel(headerCharset(contentType)) ??
    knownLabel(rule ? rule[1]!.toLowerCase() : null) ??
    (isValidUtf8(body) ? "utf-8" : "windows-1252");
  const css = decodeWith(label, body) ?? decodeWith("utf-8", body)!;
  return css.replace(/^﻿/, "").replace(/^\s*@charset\s+"[^"]*"\s*;/i, "");
}

/** The label if Node (or our windows-1252 table) can decode it, else null so the caller falls through. */
function knownLabel(label: string | null): string | null {
  if (!label) return null;
  if (WINDOWS_1252_LABELS.has(label)) return "windows-1252";
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

function isValidUtf8(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every label the WHATWG Encoding Standard maps to windows-1252 — including
 * "iso-8859-1" and "latin1", because browsers treat them as windows-1252 too.
 */
const WINDOWS_1252_LABELS = new Set([
  "ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100",
  "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252",
]);

/**
 * windows-1252's 0x80–0x9F block. Node's TextDecoder decodes these labels as
 * plain ISO-8859-1 (C1 control characters), but the historical web's curly
 * quotes, em dashes, bullets and ellipses live exactly here.
 */
const C1_TO_UNICODE = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeWindows1252(b: Buffer): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    out += c >= 0x80 && c <= 0x9f ? String.fromCharCode(C1_TO_UNICODE[c - 0x80]!) : String.fromCharCode(c);
  }
  return out;
}

/** Decode with a WHATWG encoding label, or null when Node doesn't know it. */
function decodeWith(label: string, b: Buffer): string | null {
  if (WINDOWS_1252_LABELS.has(label.toLowerCase())) return decodeWindows1252(b);
  try {
    return new TextDecoder(label).decode(b);
  } catch {
    return null; // RangeError: unknown label — caller falls back
  }
}
