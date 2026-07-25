/**
 * amber — save a URL as a self-contained, de-junked offline folder.
 * (Installed from npm as `in-amber`; the command is `amber`. In-repo: `pnpm archive`.)
 *
 *   amber https://example.com/post                 # auto capture + Claude if a key is set
 *   amber --no-llm https://example.com/post        # heuristics only
 *   amber --static https://example.com/post        # force static fetch (no browser)
 *   amber --playwright https://example.com/post    # force a headless-Chromium render
 *   amber --plan plan.json https://example.com/post
 *   amber --overwrite https://example.com/post     # replace the latest, keep no history
 *   amber agent https://example.com/post           # Claude cleans interactively (hard pages)
 *   amber doctor                                   # check the environment
 *
 * Re-archiving a URL keeps history: the previous capture rotates into
 * `<slug>/versions/<timestamp>/` and the newest stays at `<slug>/`. Identical
 * re-captures are skipped. `--overwrite` replaces the latest in place instead.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { archiveUrl, defaultArchiveDir } from "./pipeline.js";
import { runDoctor } from "./doctor.js";
import { AmberError } from "./errors.js";

const USAGE =
  "usage: amber [options] <url>\n" +
  "       amber agent [options] <url>\n" +
  "       amber doctor";

const HELP = `amber — save a web page as a clean, self-contained offline folder

${USAGE}

options:
  -o, --out <dir>    output directory (default ~/Documents/Archives, or $AMBER_ARCHIVE_DIR)
  --static           force a plain HTTP fetch (never boot Chromium)
  --playwright       force a headless-Chromium render
  --no-llm           heuristics only; never call the model
  --plan <file>      replay a saved plan.json instead of asking for judgement
  --model <id>       planning model (default claude-sonnet-4-6, or $AMBER_MODEL)
  --overwrite        replace the latest snapshot in place; keep no history
  --timeout <ms>     capture timeout (default 45000)
  --insecure-tls     tolerate a trusted MITM proxy (or $AMBER_INSECURE_TLS=1)
  -q, --quiet        suppress progress output
  -h, --help         show this help
  --version          print the version

subcommands:
  agent <url>        Claude cleans the page interactively with tools instead of
                     one planning call — for pages the pipeline gets wrong.
                     Needs a key + Playwright; costs more (amber agent --help)
  doctor             check the environment: key, Playwright, yt-dlp, ffmpeg

Re-archiving a URL keeps history: the previous capture rotates into
<slug>/versions/<timestamp>/ and the newest stays at <slug>/. Identical
re-captures are skipped. Run \`amber doctor\` to check your setup.`;

const AGENT_HELP = `amber agent — archive a page with Claude working interactively

usage: amber agent [options] <url>

Instead of the pipeline's single planning call, Claude drives real tools in a
loop — outline the DOM, inspect ambiguous elements, remove junk, download and
swap embedded media, finalize. Slower and costlier (many model calls instead of
one), but it can handle pages the one-shot plan mangles. Requires
ANTHROPIC_API_KEY (no heuristic fallback) and Playwright (the page is always
rendered in headless Chromium).

options:
  -o, --out <dir>    output directory (default ~/Documents/Archives, or $AMBER_ARCHIVE_DIR)
  --model <id>       model to use (default claude-sonnet-4-6, or $AMBER_MODEL)
  --overwrite        replace the latest snapshot in place; keep no history
  -h, --help         show this help`;

/** `amber agent <url>` — the interactive-judgement escalation path. */
async function runAgentCli(args: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o", default: defaultArchiveDir() },
        model: { type: "string", default: process.env.AMBER_MODEL || "claude-sonnet-4-6" },
        overwrite: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\nusage: amber agent [options] <url>`);
    return 2;
  }

  if (values.help) {
    console.log(AGENT_HELP);
    return 0;
  }
  const url = positionals[0];
  if (!url) {
    console.error("usage: amber agent [options] <url>\n\nRun \`amber agent --help\` for details.");
    return 2;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AmberError(
      "agent mode needs ANTHROPIC_API_KEY — Claude drives the cleanup interactively, there is no heuristic fallback.\n" +
        "  For a no-key archive, use: amber --no-llm " + url,
    );
  }

  // Lazy import: plain archives never load the agent (or the SDK tool runner).
  const { runAgent } = await import("../agent/agent.js");
  await runAgent(url, values.out!, values.model!, { overwrite: values.overwrite });
  return 0;
}

async function main(): Promise<number> {
  if (process.argv[2] === "doctor") return runDoctor();
  if (process.argv[2] === "agent") return runAgentCli(process.argv.slice(3));

  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o", default: defaultArchiveDir() },
        "no-llm": { type: "boolean", default: false },
        static: { type: "boolean", default: false }, // force plain HTTP fetch, never boot Chromium
        playwright: { type: "boolean", default: false }, // force a headless-Chromium render
        plan: { type: "string" },
        model: { type: "string", default: process.env.AMBER_MODEL || "claude-sonnet-4-6" },
        "insecure-tls": { type: "boolean", default: process.env.AMBER_INSECURE_TLS === "1" },
        timeout: { type: "string", default: "45000" },
        overwrite: { type: "boolean", default: false }, // replace latest in place, no history
        quiet: { type: "boolean", short: "q", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\n${USAGE}\n\nRun \`amber --help\` for all options.`);
    return 2;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    // package.json sits one level above this file in both layouts: dist/cli.js
    // when installed, src/cli.ts when run from a checkout via tsx.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }

  const url = positionals[0];
  if (!url) {
    console.error(`${USAGE}\n\nRun \`amber --help\` for all options.`);
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
  // Expected failures get a plain message; stack traces are for actual bugs.
  console.error(`error: ${err instanceof AmberError ? err.message : err?.stack ?? err}`);
  process.exit(1);
});
