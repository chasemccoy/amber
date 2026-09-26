/**
 * Regression tests for the keep-js replay shim — the inline script that makes
 * archived apps work offline. Every behavior here was added because a real
 * site broke without it, so each gets a pinned test:
 *
 *   - URL-space translation (bruno-simon: apps pre-resolve relative paths
 *     against the document's file:// URL)
 *   - cross-host path fallback (lusion: assets recorded under a CDN domain
 *     picked by a hostname check that fails offline)
 *   - blob:/data: fetch passthrough (apps fetch blobs they just created)
 *   - fail-closed networking (unrecorded http(s) loads must NOT hit the web)
 *   - <a href> protection (fail-closing anchors would destroy links)
 *   - inline-style url() and document.write'd loads (evernote.com 2010: a
 *     jQuery carousel sets root-relative backgrounds; CDN jQuery and
 *     analytics arrive via document.write)
 *   - history.pushState fallback (SPA routers throw on file:// and can
 *     hard-navigate away)
 *   - seeded Math.random parity between render and replay
 *
 * The shim under test is the REAL one: applyKeepJs builds the page, and the
 * script + data elements are lifted from its output and executed in a vm
 * sandbox with a minimal DOM. No browser, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as cheerio from "cheerio";
import { applyKeepJs } from "../src/keepjs.js";
import { SEEDED_RANDOM_SNIPPET, type RenderedResource } from "../src/render.js";

const PAGE = "https://example.com/";

function res(body: string, contentType: string, resourceType: string): RenderedResource {
  return { contentType, body: Buffer.from(body), resourceType };
}

/** Build a real page via applyKeepJs and lift its shim + replay data. */
async function buildShim(): Promise<{ shimSrc: string; replayJson: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amber-shim-"));
  const $ = cheerio.load("<html><head></head><body></body></html>");
  const resources = new Map<string, RenderedResource>([
    ["https://example.com/api/data.json", res('{"a":1}', "application/json", "fetch")],
    ["https://cdn.example.net/textures/matcap.exr", res("EXR-BYTES", "application/octet-stream", "fetch")],
  ]);
  await applyKeepJs($, { pageUrl: PAGE, resources, rootDir: root });
  fs.rmSync(root, { recursive: true, force: true });
  return {
    shimSrc: $("script[data-amber='shim']").html()!,
    replayJson: $("#amber-replay-data").html()!,
  };
}

const ASSET_MAP_JSON = JSON.stringify({
  "https://example.com/img/pic.png": "assets/images/pic-abc.png",
  "https://example.com/films/1536/f_010.webp": "assets/images/f_010-abc.webp",
  "https://cdn.example.net/lib/jquery.min.js": "assets/static/jquery.min-abc.js",
});

interface Sandbox {
  [k: string]: any;
}

/** Minimal DOM realm for the shim: document, location, history, elements. */
function runShim(
  shimSrc: string,
  replayJson: string,
  opts?: { href?: string; realFetch?: (...a: any[]) => any; assetMap?: boolean },
) {
  const els: Record<string, { textContent: string }> = {
    "amber-replay-data": { textContent: replayJson },
    ...(opts?.assetMap === false ? {} : { "amber-asset-map": { textContent: ASSET_MAP_JSON } }),
  };
  const historyCalls: Array<{ fn: string; url: any }> = [];

  class FakeElement {
    attrs: Record<string, string> = {};
    _tag = "DIV";
    get tagName() {
      return this._tag;
    }
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    }
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    }
  }
  const withSrc = (tag: string) => {
    const C = class extends FakeElement {
      _src = "";
      constructor() {
        super();
        this._tag = tag;
      }
    };
    Object.defineProperty(C.prototype, "src", {
      get() {
        return (this as any)._src;
      },
      set(v: string) {
        (this as any)._src = v;
      },
      configurable: true,
    });
    return C;
  };

  class FakeResponse {
    body: any;
    status: number;
    statusText: string;
    constructor(body: any, init?: { status?: number; statusText?: string }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.statusText = init?.statusText ?? "";
    }
  }

  const written: string[] = [];
  // Chromium-shaped: setProperty/getPropertyValue/cssText are real members,
  // the camelCase properties are NOT (a named-property interceptor serves
  // them), so the shim has to define its own accessors for those.
  class FakeStyle {
    props: Record<string, string> = {};
    _cssText = "";
    setProperty(name: string, value: string) {
      this.props[name] = value;
    }
    getPropertyValue(name: string) {
      return this.props[name] ?? "";
    }
    get cssText() {
      return this._cssText;
    }
    set cssText(v: string) {
      this._cssText = v;
    }
  }

  const sandbox: Sandbox = {
    document: {
      getElementById: (id: string) => els[id] ?? null,
      write(...parts: string[]) {
        written.push(parts.join(""));
      },
      writeln(...parts: string[]) {
        written.push(parts.join("") + "\n");
      },
    },
    CSSStyleDeclaration: FakeStyle,
    location: { href: opts?.href ?? "file:///Users/t/archives/slug/index.html" },
    navigator: {},
    history: {
      pushState(_s: any, _t: any, url?: any) {
        // Mimic Chrome on file://: any real URL throws; fragments are fine.
        if (url !== undefined && !String(url).startsWith("#")) throw new Error("SecurityError");
        historyCalls.push({ fn: "pushState", url });
      },
      replaceState(_s: any, _t: any, url?: any) {
        if (url !== undefined && !String(url).startsWith("#")) throw new Error("SecurityError");
        historyCalls.push({ fn: "replaceState", url });
      },
    },
    URL,
    JSON,
    Promise,
    Map,
    Set,
    String,
    Error,
    RegExp,
    Uint8Array,
    atob,
    TextDecoder,
    setTimeout: (f: () => void) => {
      f(); // synchronous — makes XHR/WebSocket callbacks deterministic
      return 0;
    },
    Response: FakeResponse,
    EventTarget,
    Element: FakeElement,
    HTMLImageElement: withSrc("IMG"),
    HTMLMediaElement: withSrc("AUDIO"),
    HTMLSourceElement: withSrc("SOURCE"),
    HTMLScriptElement: withSrc("SCRIPT"),
    Math: { imul: Math.imul, random: Math.random }, // shadow — never mutate host Math
    Object,
  };
  const HTMLVideoElement = class extends (sandbox.HTMLMediaElement as any) {
    constructor() {
      super();
      (this as any)._tag = "VIDEO";
    }
  };
  Object.defineProperty(HTMLVideoElement.prototype, "poster", {
    get() {
      return (this as any)._poster;
    },
    set(v: string) {
      (this as any)._poster = v;
    },
    configurable: true,
  });
  sandbox.HTMLVideoElement = HTMLVideoElement;
  const HTMLLinkElement = class extends FakeElement {
    constructor() {
      super();
      this._tag = "LINK";
    }
  };
  Object.defineProperty(HTMLLinkElement.prototype, "href", {
    get() {
      return (this as any)._href;
    },
    set(v: string) {
      (this as any)._href = v;
    },
    configurable: true,
  });
  sandbox.HTMLLinkElement = HTMLLinkElement;
  // document.currentScript, as Chromium exposes it: a prototype accessor.
  class FakeDocument {
    get currentScript() {
      return (this as any)._current ?? null;
    }
  }
  Object.setPrototypeOf(sandbox.document, FakeDocument.prototype);
  sandbox.Document = FakeDocument;
  sandbox.Proxy = Proxy;
  sandbox.Reflect = Reflect;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.fetch = opts?.realFetch ?? (() => Promise.resolve("REAL-FETCH"));
  sandbox.__historyCalls = historyCalls;
  sandbox.__written = written;
  sandbox.__els = els;

  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox);
  return sandbox;
}

async function bodyText(r: any): Promise<string> {
  return new TextDecoder().decode(r.body);
}

test("shim fetch replays recorded responses: exact, relative, and file://-translated URLs", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  const exact = await sb.fetch("https://example.com/api/data.json");
  assert.equal(exact.status, 200);
  assert.equal(await bodyText(exact), '{"a":1}');

  // Relative URL resolves against the ORIGINAL base, not the file:// page.
  const rel = await sb.fetch("api/data.json");
  assert.equal(rel.status, 200);

  // bruno-simon regression: the app pre-resolved a relative path against the
  // document's own directory — translate back into the original URL space.
  const translated = await sb.fetch("file:///Users/t/archives/slug/api/data.json");
  assert.equal(translated.status, 200);
  assert.equal(await bodyText(translated), '{"a":1}');
});

test("shim fetch falls back across hosts by pathname (CDN-domain recordings)", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  // lusion regression: recorded under cdn.example.net, requested same-origin.
  const r = await sb.fetch("https://example.com/textures/matcap.exr");
  assert.equal(r.status, 200);
  assert.equal(await bodyText(r), "EXR-BYTES");
});

test("shim fetch passes blob:/data: through to real fetch, 504s everything else", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const realCalls: string[] = [];
  const sb = runShim(shimSrc, replayJson, {
    realFetch: (u: any) => {
      realCalls.push(String(u));
      return Promise.resolve("REAL");
    },
  });

  assert.equal(await sb.fetch("blob:null/abc-123"), "REAL");
  assert.equal(await sb.fetch("data:text/plain,x"), "REAL");
  assert.deepEqual(realCalls, ["blob:null/abc-123", "data:text/plain,x"]);

  // Fail closed: nothing unrecorded may reach the network.
  const miss = await sb.fetch("https://tracker.example/beacon.js");
  assert.equal(miss.status, 504);
  assert.equal(realCalls.length, 2);
});

test("shim XHR replays recorded responses synchronously-observably", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  const xhr = new sb.XMLHttpRequest();
  let loaded = false;
  xhr.onload = () => {
    loaded = true;
  };
  xhr.open("GET", "https://example.com/api/data.json");
  xhr.send(); // sandbox setTimeout is synchronous
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '{"a":1}');
  assert.equal(xhr.getResponseHeader("content-type"), "application/json");
  assert.ok(loaded);

  const missXhr = new sb.XMLHttpRequest();
  missXhr.open("GET", "https://elsewhere.example/nope.json");
  missXhr.send();
  assert.equal(missXhr.status, 0);
});

test("shim remaps runtime-set element sources through the asset map", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  const img = new sb.HTMLImageElement();
  img.src = "https://example.com/img/pic.png";
  assert.equal(img._src, "assets/images/pic-abc.png");

  // Nearest-variant fallback: viewport picked /768/, recording has /1536/.
  const img2 = new sb.HTMLImageElement();
  img2.src = "/films/768/f_010.webp";
  assert.equal(img2._src, "assets/images/f_010-abc.webp");

  // Fail closed: unmatched http(s) element loads become inert data: URIs.
  const img3 = new sb.HTMLImageElement();
  img3.src = "https://tracker.example/pixel.gif";
  assert.equal(img3._src, "data:,");

  // Local and data: refs pass through untouched.
  const img4 = new sb.HTMLImageElement();
  img4.src = "assets/images/already-local.png";
  assert.equal(img4._src, "assets/images/already-local.png");

  // Runtime-injected scripts too (evernote 2010: a tracker's loader created
  // <script src="http://t.tellapart.com/tpv?…"> — that must not go out).
  const lib = new sb.HTMLScriptElement();
  lib.src = "https://cdn.example.net/lib/jquery.min.js";
  assert.equal(lib._src, "assets/static/jquery.min-abc.js");
  const tpv = new sb.HTMLScriptElement();
  tpv.src = "http://t.tellapart.com/tpv?aid=x";
  assert.equal(tpv._src, "data:,");
});

test("shim never caches a missing asset map (head scripts load before it is parsed)", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson, { assetMap: false });

  // evernote 2010 regression: Google's loader (in <head>) document.write'd
  // jQuery before the map element existed; the {} miss got cached and every
  // later lookup — the whole carousel — failed closed.
  const early = new sb.HTMLImageElement();
  early.src = "https://example.com/img/pic.png";
  assert.equal(early._src, "data:,", "before the map exists: fail closed");

  sb.__els["amber-asset-map"] = { textContent: ASSET_MAP_JSON };
  const late = new sb.HTMLImageElement();
  late.src = "https://example.com/img/pic.png";
  assert.equal(late._src, "assets/images/pic-abc.png", "the miss was not cached");
});

test("shim remaps url() in runtime-set inline styles", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  // evernote 2010 regression: jQuery's .css() assigns el.style.background =
  // 'url(/about/…/slide_background.gif) …' — root-relative, which on file://
  // resolves to the filesystem root. Chromium has no prototype accessor for
  // the camelCase properties, so the shim defines its own.
  const st = new sb.CSSStyleDeclaration();
  st.background = 'url("/img/pic.png") 0px -1px no-repeat';
  assert.equal(st.props["background"], 'url("assets/images/pic-abc.png") 0px -1px no-repeat');
  assert.equal(st.background, 'url("assets/images/pic-abc.png") 0px -1px no-repeat', "getter reads back through getPropertyValue");
  st.backgroundImage = "url(/img/pic.png)";
  assert.equal(st.props["background-image"], "url(assets/images/pic-abc.png)");

  // setProperty and cssText (a real accessor everywhere) are covered too.
  st.setProperty("background-image", "url('/img/pic.png')");
  assert.equal(st.props["background-image"], "url('assets/images/pic-abc.png')");
  st.cssText = "color: red; background: url(/img/pic.png)";
  assert.equal(st._cssText, "color: red; background: url(assets/images/pic-abc.png)");

  // Fail closed: an unrecorded http(s) url() becomes inert, never a network hit.
  st.backgroundImage = "url(https://tracker.example/pixel.gif)";
  assert.equal(st.props["background-image"], "url(data:,)");

  // Values without url() and non-strings pass through untouched.
  st.background = "red";
  assert.equal(st.props["background"], "red");
  st.setProperty("width", 10 as any);
  assert.equal(st.props["width"], 10 as any);

  // setAttribute('style', …) is the same surface by another door.
  const el = new sb.Element();
  el.setAttribute("style", "background-image: url(/img/pic.png)");
  assert.equal(el.attrs["style"], "background-image: url(assets/images/pic-abc.png)");
});

test("shim routes document.write'd loads through the asset map", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  // evernote 2010: Google's loader document.write's a CDN jQuery, GA writes
  // ga.js — the parser fetches those from the network, past every src patch.
  sb.document.write('<script src="https://cdn.example.net/lib/jquery.min.js" type="text/javascript"></script>');
  assert.equal(
    sb.__written[0],
    '<script src="assets/static/jquery.min-abc.js" type="text/javascript"></script>',
  );

  // Unrecorded loads fail closed; entity-escaped query strings still match.
  sb.document.write("<script type='text/javascript' src='http://www.google-analytics.com/ga.js'></script>");
  assert.equal(sb.__written[1], "<script type='text/javascript' src='data:,'></script>");
  sb.document.writeln('<img src="https://example.com/img/pic.png?a=1&amp;b=2">');
  assert.equal(sb.__written[2], '<img src="assets/images/pic-abc.png">\n');

  // Arguments are one document — a tag split across them still rewrites —
  // and anchors are not loads.
  sb.document.write('<a href="https://example.com/page">x</a><script src="', "https://cdn.example.net/lib/jquery.min.js", '"></script>');
  assert.equal(
    sb.__written[3],
    '<a href="https://example.com/page">x</a><script src="assets/static/jquery.min-abc.js"></script>',
  );
});

test("shim setAttribute remaps loads but never touches <a href>", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  const a = new sb.Element();
  a._tag = "A";
  a.setAttribute("href", "https://example.com/some-page");
  assert.equal(a.attrs["href"], "https://example.com/some-page", "anchors must keep their real hrefs");

  const link = new sb.HTMLLinkElement();
  link.setAttribute("href", "https://example.com/img/pic.png");
  assert.equal(link.attrs["href"], "assets/images/pic-abc.png");

  const img = new sb.HTMLImageElement();
  img.setAttribute("src", "https://tracker.example/pixel.gif");
  assert.equal(img.attrs["src"], "data:,");
});

test("shim history.pushState survives file:// by falling back to a fragment", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  // Would throw unpatched (see the sandbox history stub) — the shim's wrapper
  // must retry as a same-document fragment instead of letting routers die.
  sb.history.pushState({}, "", "/works/some-project");
  assert.deepEqual(sb.__historyCalls, [{ fn: "pushState", url: "#/works/some-project" }]);

  sb.history.replaceState({}, "", "/about");
  assert.equal(sb.__historyCalls[1]?.url, "#/about");
});

test("seeded Math.random is deterministic and identical in render and replay", async () => {
  const seq = (src: string) => {
    const sandbox: Sandbox = { Math: { imul: Math.imul, random: Math.random } };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return [sandbox.Math.random(), sandbox.Math.random(), sandbox.Math.random()];
  };
  const render = seq(SEEDED_RANDOM_SNIPPET);
  const renderAgain = seq(SEEDED_RANDOM_SNIPPET);
  assert.deepEqual(render, renderAgain, "same seed, same sequence");

  // The shim embeds the same snippet — its sandbox must produce the same run.
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);
  assert.deepEqual([sb.Math.random(), sb.Math.random(), sb.Math.random()], render);
});

test("shim gives inlined chunks their original src back through document.currentScript", async () => {
  const { shimSrc, replayJson } = await buildShim();
  const sb = runShim(shimSrc, replayJson);

  // anthropic.com regression: Turbopack keys every chunk by
  // document.currentScript.getAttribute('src') AS WRITTEN — root-relative for
  // same-origin chunks — and waits for that key to register. Inlined scripts
  // have no src, so nothing ever registered and the app never booted.
  const inlined = new sb.Element();
  inlined._tag = "SCRIPT";
  inlined.setAttribute("data-amber-src", "https://example.com/_next/static/chunks/app.js?v=1");
  sb.document._current = inlined;
  let cs = sb.document.currentScript;
  assert.equal(cs.getAttribute("src"), "/_next/static/chunks/app.js?v=1", "the attribute as written (Turbopack's chunk key)");
  assert.equal(cs.src, "https://example.com/_next/static/chunks/app.js?v=1", "the resolved URL (Next's getAssetPrefix does new URL(src))");
  assert.equal(cs.getAttribute("data-amber-src"), "https://example.com/_next/static/chunks/app.js?v=1", "other attributes pass through");
  assert.equal(cs.tagName, "SCRIPT");

  // A CDN chunk was written absolute, so it stays absolute.
  const cdn = new sb.Element();
  cdn._tag = "SCRIPT";
  cdn.setAttribute("data-amber-src", "https://cdn.example.net/lib/jquery.min.js");
  sb.document._current = cdn;
  assert.equal(sb.document.currentScript.getAttribute("src"), "https://cdn.example.net/lib/jquery.min.js");

  // A chunk the runtime injected itself: its src was mapped to the local copy
  // by the patches above — recognised by reverse lookup through the asset map.
  const injected = new sb.Element();
  injected._tag = "SCRIPT";
  injected.setAttribute("src", "assets/static/jquery.min-abc.js");
  sb.document._current = injected;
  assert.equal(sb.document.currentScript.getAttribute("src"), "https://cdn.example.net/lib/jquery.min.js");

  // Anything else is handed back untouched.
  const external = new sb.Element();
  external._tag = "SCRIPT";
  external.setAttribute("src", "https://unrelated.example/x.js");
  sb.document._current = external;
  assert.equal(sb.document.currentScript, external);
  sb.document._current = null;
  assert.equal(sb.document.currentScript, null);
});
