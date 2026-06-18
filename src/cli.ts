#!/usr/bin/env -S pnpm exec tsx
/**
 * amber — save a URL as a self-contained, de-junked offline folder.
 *
 *   pnpm archive https://example.com/post                 # auto capture + Claude if a key is set
 *   pnpm archive --no-llm https://example.com/post        # heuristics only
 *   pnpm archive --static https://example.com/post        # force static fetch (no browser)
 *   pnpm archive --playwright https://example.com/post    # force a headless-Chromium render
 *   pnpm archive --plan plan.json https://example.com/post
 */

import { parseArgs } from "node:util";
import { archiveUrl } from "./pipeline.js";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "archives" },
      "no-llm": { type: "boolean", default: false },
      static: { type: "boolean", default: false }, // force plain HTTP fetch, never boot Chromium
      playwright: { type: "boolean", default: false }, // force a headless-Chromium render
      plan: { type: "string" },
      model: { type: "string", default: "claude-opus-4-8" },
      "insecure-tls": { type: "boolean", default: process.env.AMBER_INSECURE_TLS === "1" },
      timeout: { type: "string", default: "45000" },
      quiet: { type: "boolean", short: "q", default: false },
    },
  });

  const url = positionals[0];
  if (!url) {
    console.error("usage: archive [--static|--playwright] [--no-llm] [--plan p.json] [-o dir] <url>");
    return 2;
  }
  if (values.static && values.playwright) {
    console.error("error: --static and --playwright are mutually exclusive");
    return 2;
  }

  const res = await archiveUrl(url, {
    outRoot: values.out!,
    backend: values.static ? "fetch" : values.playwright ? "playwright" : "auto",
    useLLM: !values["no-llm"],
    planPath: values.plan,
    model: values.model!,
    insecureTLS: values["insecure-tls"]!,
    timeoutMs: Number(values.timeout),
    verbose: !values.quiet,
  });

  if (!values.quiet) {
    console.log(`\nArchive written to: ${res.outDir}/`);
    console.log(`  open ${res.outDir}/index.html`);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`error: ${err?.stack ?? err}`);
  process.exit(1);
});
