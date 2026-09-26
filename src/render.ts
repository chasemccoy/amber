/**
 * Playwright capture backend: render a page in headless Chromium so JavaScript,
 * lazy-loaded images, and client-rendered content are all present before we
 * capture. While the browser loads the page it already fetches every asset, so
 * we snapshot those response bodies and hand them to the capturer — no second
 * download, and we get assets that a plain HTTP fetch couldn't (JS-injected,
 * cookie-gated, etc.).
 */

import { pathToFileURL } from "node:url";
import { AmberError } from "./errors.js";
import { decodeHtml } from "./charset.js";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RenderedResource {
  contentType: string;
  body: Buffer;
  /**
   * Playwright's request.resourceType() — "script", "xhr", "fetch",
   * "stylesheet", … Lets keep-js mode tell app code and runtime data apart.
   * Absent for resources that arrived without one (extension captures).
   */
  resourceType?: string;
}

export interface RenderResult {
  html: string;
  finalUrl: string;
  baseUrl: string;
  /** url (without fragment) -> bytes the browser already downloaded (2xx only). */
  resources: Map<string, RenderedResource>;
  /** Viewport JPEG taken after the page settled — the library index thumbnail. */
  thumbnail?: Buffer;
}

export interface RenderOptions {
  timeoutMs: number;
  insecureTLS: boolean;
  /**
   * keep-js: seed Math.random with a fixed PRNG before any page script runs.
   * The replay shim seeds identically, so a page that randomises at boot
   * (pick-a-film, A/B variants) makes the same choices offline as it did
   * during the recorded render — otherwise it would request variants the
   * recording never captured.
   */
  deterministicRandom?: boolean;
  /**
   * Answer every network request the page makes from this function instead
   * of the network (the Wayback keep-js path: the browser navigates to the
   * ORIGINAL url and each request is served from the archive at a timestamp,
   * so the page's own JS runs against its own era's assets and every recorded
   * URL stays in the original URL space). Return null to block the request.
   */
  fulfill?: (url: string, resourceType: string) => Promise<FulfilledResponse | null>;
  /**
   * Rewrite the main document's HTML before the browser parses it (keep-js:
   * strip tracker scripts so the render runs exactly the code the archive
   * will replay — a tracker that consumed Math.random during the render
   * would otherwise shift every seeded choice made after it). Top-level
   * navigation only; the result is served as UTF-8.
   */
  transformDocument?: (html: string) => string;
}

export interface FulfilledResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Mulberry32 over a fixed seed — tiny, and identical in render + shim. */
export const SEEDED_RANDOM_SNIPPET = `(function () {
  var s = 0xA3C59AC3;
  Math.random = function () {
    s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

/**
 * Scroll the page to trigger lazy-loaded images/content, then return to top.
 * keep-js uses a denser sweep (smaller steps): scroll-scrubbed sites request
 * assets per scroll band, and each band the sweep skips is an asset the
 * offline replay won't have.
 */
async function autoScroll(page: import("playwright").Page, dense = false): Promise<void> {
  await page.evaluate(async ({ step, interval }: { step: number; interval: number }) => {
    // This callback runs in the browser. Reach the window/document globals via
    // globalThis so the file doesn't require the DOM lib when type-checked by a
    // consumer that imports amber (e.g. a Node server without "DOM" in its lib).
    const w = globalThis as unknown as {
      innerHeight: number;
      scrollBy: (x: number, y: number) => void;
      scrollTo: (x: number, y: number) => void;
      document: { body: { scrollHeight: number } };
    };
    await new Promise<void>((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        w.scrollBy(0, step);
        total += step;
        if (total >= w.document.body.scrollHeight + w.innerHeight) {
          clearInterval(timer);
          w.scrollTo(0, 0);
          resolve();
        }
      }, interval);
    });
  }, dense ? { step: 250, interval: 60 } : { step: 600, interval: 80 });
}

/**
 * Load Playwright, which is an optional peer dependency: static-only installs
 * skip its ~300 MB of browser + driver entirely. Missing module → an error that
 * says how to opt in.
 */
async function loadChromium(): Promise<typeof import("playwright").chromium> {
  try {
    return (await import("playwright")).chromium;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw err;
    throw new AmberError(
      "this page needs a headless-browser render, but Playwright isn't installed.\n" +
        "  Install it:  npm install -g playwright && playwright install chromium\n" +
        "  Or force a browserless capture with --static",
    );
  }
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  // Imported lazily so consumers that never render (e.g. a server doing only
  // static fetches) don't load Playwright at startup.
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: opts.insecureTLS,
    });
    const page = await context.newPage();
    if (opts.deterministicRandom) await page.addInitScript(SEEDED_RANDOM_SNIPPET);
    const transform = opts.transformDocument;
    const isMainDocument = (req: import("playwright").Request) =>
      req.resourceType() === "document" && req.frame() === page.mainFrame();
    const transformed = (body: Buffer, contentType: string | undefined) => ({
      body: Buffer.from(transform!(decodeHtml(body, contentType)), "utf8"),
      contentType: "text/html; charset=utf-8",
    });
    if (opts.fulfill) {
      const fulfill = opts.fulfill;
      await page.route("**/*", async (route) => {
        const req = route.request();
        try {
          let r = await fulfill(req.url(), req.resourceType());
          if (!r) return await route.abort("blockedbyclient");
          if (transform && isMainDocument(req) && r.status >= 200 && r.status < 300) {
            r = { ...r, ...transformed(r.body, r.contentType) };
          }
          await route.fulfill({ status: r.status, headers: { "content-type": r.contentType }, body: r.body });
        } catch {
          await route.abort("failed").catch(() => {});
        }
      });
    } else if (transform) {
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (!isMainDocument(req)) return await route.continue();
        try {
          // Redirects are left to the browser so the page's URL — and every
          // relative resolution against it — stays what it would have been.
          const res = await route.fetch({ maxRedirects: 0 });
          const status = res.status();
          if (status < 200 || status >= 300) return await route.fulfill({ response: res });
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers())) {
            if (!/^(content-length|content-encoding|transfer-encoding|content-type)$/i.test(k)) headers[k] = v;
          }
          const doc = transformed(await res.body(), res.headers()["content-type"]);
          await route.fulfill({ status, headers: { ...headers, "content-type": doc.contentType }, body: doc.body });
        } catch {
          await route.continue().catch(() => {});
        }
      });
    }

    const resources = new Map<string, RenderedResource>();
    const pending: Promise<void>[] = [];
    page.on("response", (resp) => {
      pending.push(
        (async () => {
          try {
            const req = resp.request();
            if (req.resourceType() === "document") return; // the page HTML, not an asset
            // Only complete, successful bodies. A 404's error page must never
            // be localised as the asset it stood in for — a Wayback miss is a
            // full HTML page, which inlined into a <script> is a syntax error —
            // and a 206 is a range slice, not the file.
            const status = resp.status();
            if (status < 200 || status >= 300 || status === 206) return;
            const ct = resp.headers()["content-type"] ?? "";
            const body = await resp.body();
            resources.set(resp.url().split("#")[0]!, {
              contentType: ct,
              body,
              resourceType: req.resourceType(),
            });
          } catch {
            /* streaming/redirect/opaque responses have no body — skip */
          }
        })(),
      );
    });

    // "load" is the hard requirement; network-idle is best effort. Sites with
    // analytics heartbeats or long-polling never go idle, and failing the
    // whole capture over that (anthropic.com) is worse than a settle window.
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, opts.timeoutMs) }).catch(() => {});
    await autoScroll(page, opts.deterministicRandom).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await Promise.allSettled(pending);

    const html = await page.content();
    const finalUrl = page.url();
    // Thumbnail for the library index: the settled top-of-page viewport. A
    // failure here (crashed renderer, teardown race) must never cost a capture.
    let thumbnail: Buffer | undefined;
    try {
      thumbnail = await page.screenshot({ type: "jpeg", quality: 60 });
    } catch {
      /* no thumbnail — the library shows a blank cell */
    }
    return { html, finalUrl, baseUrl: finalUrl, resources, thumbnail };
  } finally {
    await browser.close();
  }
}

/**
 * Screenshot an already-built archive's index.html — the thumbnail fallback
 * for captures that never opened a browser (static fetch, extension DOM).
 * Returns null when Playwright isn't installed or the render fails: the
 * library index simply shows no preview.
 */
export async function thumbnailFromFile(indexPath: string, timeoutMs = 20000): Promise<Buffer | null> {
  let chromium: typeof import("playwright").chromium;
  try {
    chromium = (await import("playwright")).chromium;
  } catch {
    return null;
  }
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(500); // let fonts/first paint settle
    return await page.screenshot({ type: "jpeg", quality: 60 });
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
