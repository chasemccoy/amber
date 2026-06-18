/**
 * Playwright capture backend: render a page in headless Chromium so JavaScript,
 * lazy-loaded images, and client-rendered content are all present before we
 * capture. While the browser loads the page it already fetches every asset, so
 * we snapshot those response bodies and hand them to the capturer — no second
 * download, and we get assets that a plain HTTP fetch couldn't (JS-injected,
 * cookie-gated, etc.).
 */

import { chromium } from "playwright";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RenderResult {
  html: string;
  finalUrl: string;
  baseUrl: string;
  /** url (without fragment) -> bytes the browser already downloaded. */
  resources: Map<string, { contentType: string; body: Buffer }>;
}

export interface RenderOptions {
  timeoutMs: number;
  insecureTLS: boolean;
}

/** Scroll the page to trigger lazy-loaded images/content, then return to top. */
async function autoScroll(page: import("playwright").Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: opts.insecureTLS,
    });
    const page = await context.newPage();

    const resources = new Map<string, { contentType: string; body: Buffer }>();
    const pending: Promise<void>[] = [];
    page.on("response", (resp) => {
      pending.push(
        (async () => {
          try {
            const req = resp.request();
            if (req.resourceType() === "document") return; // the page HTML, not an asset
            const ct = resp.headers()["content-type"] ?? "";
            const body = await resp.body();
            resources.set(resp.url().split("#")[0]!, { contentType: ct, body });
          } catch {
            /* streaming/redirect/opaque responses have no body — skip */
          }
        })(),
      );
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs });
    await autoScroll(page).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await Promise.allSettled(pending);

    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl, baseUrl: finalUrl, resources };
  } finally {
    await browser.close();
  }
}
