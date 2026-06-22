#!/usr/bin/env -S pnpm exec tsx
/**
 * amber — save a URL as a self-contained, de-junked offline folder.
 *
 *   pnpm archive https://example.com/post                 # auto capture + Claude if a key is set
 *   pnpm archive --no-llm https://example.com/post        # heuristics only
 *   pnpm archive --static https://example.com/post        # force static fetch (no browser)
 *   pnpm archive --playwright https://example.com/post    # force a headless-Chromium render
 *   pnpm archive --plan plan.json https://example.com/post
 *   pnpm archive --overwrite https://example.com/post     # replace the latest, keep no history
 *
 * Re-archiving a URL keeps history: the previous capture rotates into
 * `<slug>/versions/<timestamp>/` and the newest stays at `<slug>/`. Identical
 * re-captures are skipped. `--overwrite` replaces the latest in place instead.
 */

import { parseArgs } from "node:util";
import { archiveUrl, defaultArchiveDir } from "./pipeline.js";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: defaultArchiveDir() },
      "no-llm": { type: "boolean", default: false },
      static: { type: "boolean", default: false }, // force plain HTTP fetch, never boot Chromium
      playwright: { type: "boolean", default: false }, // force a headless-Chromium render
      plan: { type: "string" },
      model: { type: "string", default: "claude-sonnet-4-6" },
      "insecure-tls": { type: "boolean", default: process.env.AMBER_INSECURE_TLS === "1" },
      timeout: { type: "string", default: "45000" },
      overwrite: { type: "boolean", default: false }, // replace latest in place, no history
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
    overwrite: values.overwrite,
    verbose: !values.quiet,
  });

  if (!values.quiet) {
    if (!res.changed) {
      console.log(`\nUnchanged since the last archive — kept: ${res.outDir}/`);
    } else {
      console.log(`\nArchive written to: ${res.outDir}/`);
      if (res.archivedTo) console.log(`  previous snapshot archived to ${res.archivedTo}/`);
      console.log(`  open ${res.outDir}/index.html`);
    }
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`error: ${err?.stack ?? err}`);
  process.exit(1);
});
