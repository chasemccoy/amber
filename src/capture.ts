/**
 * Deterministic capture: take a page's HTML (rendered or fetched), download
 * every asset it references, and rewrite all references to local paths under
 * an `assets/` tree. The result is a self-contained folder whose HTML never
 * reaches back out to the original host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { USER_AGENT, type RenderResult } from "./render.js";
import type { Asset } from "./types.js";

const EXT_BY_CTYPE: Record<string, string> = {
  "text/css": ".css",
  "application/javascript": ".js",
  "text/javascript": ".js",
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
};

/** url(...) inside CSS, tolerant of quotes and whitespace. */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

export function slugFor(url: string, contentType: string): string {
  const u = safeUrl(url);
  let name = (u ? path.basename(u.pathname) : "") || "index";
  name = name.replace(/[^A-Za-z0-9._-]/g, "_");
  let ext = path.extname(name);
  if (!ext) {
    ext = EXT_BY_CTYPE[contentType.split(";")[0]!.trim()] ?? "";
  }
  const root = (path.basename(name, ext) || "asset").slice(0, 60);
  const digest = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${root}-${digest}${ext}`;
}

export function subdirFor(contentType: string, url: string): "images" | "static" | "media" {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i.test(url)) {
    return "images";
  }
  if (ct.startsWith("video/") || ct.startsWith("audio/") || /\.(mp4|webm|ogv|ogg|oga|mov|m4v|m4a|mp3|wav|flac|aac|opus|mkv)(\?|$)/i.test(url)) {
    return "media"; // self-hosted <video>/<audio> — sits alongside yt-dlp downloads
  }
  return "static"; // css, fonts, everything else
}

function safeUrl(u: string, base?: string): URL | null {
  try {
    return new URL(u, base);
  } catch {
    return null;
  }
}

/**
 * A same-document fragment reference (`#gradient` for an SVG `fill`, `#b`, …) is
 * not a downloadable asset. Resolving one against the page URL yields a valid
 * http(s) URL that points at the page itself — or, when the `#` arrives already
 * percent-encoded as `%23`, at a bogus sibling path (`…/951391/%23b` → HTTP 400).
 * Either way it must not be fetched. Skip both spellings before resolving.
 */
function isSameDocFragment(raw: string): boolean {
  const r = raw.trim().toLowerCase();
  return r.startsWith("#") || r.startsWith("%23");
}

/**
 * Once a reference points at a local copy, `crossorigin` and `integrity` are not
 * just meaningless — they break the offline page. A `crossorigin` <link>/<script>
 * opened from `file://` fails its CORS check and the browser silently drops the
 * resource (the classic "my CSS won't load offline"), and a Subresource
 * Integrity hash can never match because we rewrite the asset's `url()`s. Strip
 * both from any element whose URL we've localised.
 */
function stripLocalGuards($: CheerioAPI, el: Element): void {
  $(el).removeAttr("crossorigin").removeAttr("integrity");
}

export class Capturer {
  readonly assets: Asset[] = [];
  readonly errors: string[] = [];
  $!: CheerioAPI;
  baseUrl = "";
  finalUrl = "";

  private cache = new Map<string, Asset>();
  private prefetched = new Map<string, { contentType: string; body: Buffer }>();

  constructor(
    readonly rootDir: string,
    private readonly opts: { timeoutMs: number; insecureTLS: boolean },
  ) {}

  /** Build state from a Playwright render (preferred — assets come for free). */
  loadRender(r: RenderResult): void {
    this.$ = cheerio.load(r.html);
    this.finalUrl = r.finalUrl;
    this.prefetched = r.resources;
    this.applyBaseTag(r.baseUrl);
  }

  /** Static backend: fetch the page over HTTP, no browser. */
  async fetchPage(url: string): Promise<void> {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
    const html = await res.text();
    this.$ = cheerio.load(html);
    this.finalUrl = res.url || url;
    this.applyBaseTag(this.finalUrl);
  }

  private applyBaseTag(fallback: string): void {
    this.baseUrl = fallback;
    const baseHref = this.$("base[href]").attr("href");
    if (baseHref) {
      const resolved = safeUrl(baseHref, fallback);
      if (resolved) this.baseUrl = resolved.toString();
    }
    this.$("base").remove(); // drop it; everything is local now
  }

  // -- downloading --------------------------------------------------------

  private async getBytes(absUrl: string): Promise<{ contentType: string; body: Buffer } | null> {
    const cached = this.prefetched.get(absUrl);
    if (cached) return cached;
    const u = safeUrl(absUrl);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
    const res = await fetch(absUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    return { contentType: res.headers.get("content-type") ?? "", body };
  }

  private async download(absUrl: string): Promise<Asset | null> {
    absUrl = absUrl.split("#")[0]!;
    const existing = this.cache.get(absUrl);
    if (existing) return existing;
    const u = safeUrl(absUrl);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return null; // data:, mailto:, …

    let got: { contentType: string; body: Buffer } | null;
    try {
      got = await this.getBytes(absUrl);
    } catch (err) {
      const asset: Asset = { url: absUrl, localPath: "", contentType: "", ok: false, note: String(err) };
      this.cache.set(absUrl, asset);
      this.errors.push(`${absUrl}: ${err}`);
      return asset;
    }
    if (!got) return null;

    const subdir = subdirFor(got.contentType, absUrl);
    const rel = `assets/${subdir}/${slugFor(absUrl, got.contentType)}`;
    const abs = path.join(this.rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, got.body);

    const asset: Asset = { url: absUrl, localPath: rel, contentType: got.contentType, ok: true, note: "" };
    this.cache.set(absUrl, asset);
    this.assets.push(asset);

    if (got.contentType.toLowerCase().includes("css") || absUrl.toLowerCase().endsWith(".css")) {
      await this.rewriteCssFile(abs, absUrl);
    }
    return asset;
  }

  // -- rewriting ----------------------------------------------------------

  private localRef(fromRel: string, asset: Asset | null): string | null {
    if (!asset || !asset.ok || !asset.localPath) return null;
    const fromDir = path.dirname(path.join(this.rootDir, fromRel));
    const target = path.join(this.rootDir, asset.localPath);
    return path.relative(fromDir, target).split(path.sep).join("/");
  }

  private async rewriteCssFile(cssAbs: string, cssUrl: string): Promise<void> {
    const cssRel = path.relative(this.rootDir, cssAbs).split(path.sep).join("/");
    let css = fs.readFileSync(cssAbs, "utf8");
    const replacements: Array<{ match: string; ref: string }> = [];
    for (const m of css.matchAll(CSS_URL_RE)) {
      const raw = m[2]!.trim();
      if (raw.startsWith("data:") || isSameDocFragment(raw)) continue;
      const abs = safeUrl(raw, cssUrl);
      if (!abs) continue;
      const asset = await this.download(abs.toString());
      const ref = this.localRef(cssRel, asset);
      if (ref) replacements.push({ match: m[0], ref });
    }
    for (const { match, ref } of replacements) {
      css = css.split(match).join(`url(${ref})`);
    }
    fs.writeFileSync(cssAbs, css);
  }

  /** Walk the DOM, download every referenced asset, rewrite links to local paths. */
  async captureAssets(): Promise<void> {
    const $ = this.$;
    const htmlRel = "index.html";

    const localise = async (el: Element, attr: string) => {
      const val = $(el).attr(attr);
      if (!val || isSameDocFragment(val)) return;
      const abs = safeUrl(val, this.baseUrl);
      if (!abs) return;
      const ref = this.localRef(htmlRel, await this.download(abs.toString()));
      if (ref) {
        $(el).attr(attr, ref);
        stripLocalGuards($, el);
      }
    };

    const linkRels = new Set(["stylesheet", "icon", "shortcut", "apple-touch-icon", "mask-icon", "preload"]);
    for (const el of $("link[href]").toArray()) {
      const rels = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
      // Script-type preloads are stripped in clean — don't download the JS.
      if (rels.includes("preload") && ($(el).attr("as") ?? "").toLowerCase() === "script") continue;
      if (rels.some((r) => linkRels.has(r))) await localise(el, "href");
    }
    // Responsive image preloads carry their URLs in `imagesrcset`, not `href`.
    for (const el of $("link[imagesrcset]").toArray()) await this.localiseSrcset(el, htmlRel, "imagesrcset");
    // <script src> is intentionally not localised — scripts are stripped in the
    // clean step (a static offline snapshot never runs them), so downloading
    // them would just orphan bytes in assets/.
    for (const el of $("img").toArray()) {
      await localise(el, "src");
      await this.localiseSrcset(el, htmlRel);
    }
    for (const el of $("source").toArray()) {
      await localise(el, "src");
      await this.localiseSrcset(el, htmlRel);
    }
    for (const el of $("video[src], audio[src]").toArray()) await localise(el, "src");
    for (const el of $("[style]").toArray()) {
      const style = $(el).attr("style")!;
      $(el).attr("style", await this.rewriteInlineStyle(style, htmlRel));
    }
    // `url(...)` inside <style> elements — same as inline style attrs and .css
    // files, but these live in the document. Common with MathJax/KaTeX @font-face.
    for (const el of $("style").toArray()) {
      const css = $(el).html();
      if (css) $(el).html(await this.rewriteInlineStyle(css, htmlRel));
    }
  }

  private async localiseSrcset(el: Element, htmlRel: string, attr = "srcset"): Promise<void> {
    const $ = this.$;
    const srcset = $(el).attr(attr);
    if (!srcset) return;
    const out: string[] = [];
    let localised = false;
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      if (!isSameDocFragment(bits[0])) {
        const abs = safeUrl(bits[0], this.baseUrl);
        if (abs) {
          const ref = this.localRef(htmlRel, await this.download(abs.toString()));
          if (ref) {
            bits[0] = ref;
            localised = true;
          }
        }
      }
      out.push(bits.join(" "));
    }
    $(el).attr(attr, out.join(", "));
    if (localised) stripLocalGuards($, el);
  }

  private async rewriteInlineStyle(style: string, htmlRel: string): Promise<string> {
    const replacements: Array<{ match: string; ref: string }> = [];
    for (const m of style.matchAll(CSS_URL_RE)) {
      const raw = m[2]!.trim();
      if (raw.startsWith("data:") || isSameDocFragment(raw)) continue;
      const abs = safeUrl(raw, this.baseUrl);
      if (!abs) continue;
      const ref = this.localRef(htmlRel, await this.download(abs.toString()));
      if (ref) replacements.push({ match: m[0], ref });
    }
    let out = style;
    for (const { match, ref } of replacements) out = out.split(match).join(`url(${ref})`);
    return out;
  }
}

export { CSS_URL_RE };
