/**
 * Deterministic tests for the agent's pure-DOM tools — the judgement loop
 * itself needs a key and lives in evals/, but outline/inspect/remove/
 * list_embeds/set_main_content/finalize are plain DOM + fs operations that
 * must behave regardless of what model drives them. (download_and_swap shells
 * out to yt-dlp, so it stays untested here.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { buildTools, domOutline, type Ctx } from "../agent/agent.js";

const HTML = `<html><head><title>Test page</title></head><body>
  <div id="cookie-banner" class="consent overlay">We value your privacy</div>
  <article id="main"><h1>A fine post</h1><p>Body text of the article.</p></article>
  <iframe src="https://www.youtube.com/embed/abc123"></iframe>
</body></html>`;

function makeCtx(html = HTML): Ctx {
  return {
    url: "https://example.com/post",
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), "amber-agent-")),
    $: cheerio.load(html),
    removed: 0,
    media: [],
    mainSelector: null,
    title: "",
    tags: [],
    finalized: false,
  };
}

function tool(ctx: Ctx, name: string) {
  const t = buildTools(ctx).find((t) => t.name === name);
  assert.ok(t, `tool ${name} should exist`);
  return t as unknown as { run: (input: unknown) => Promise<string> };
}

test("domOutline shows ids/classes with text previews and truncates", () => {
  const ctx = makeCtx();
  const outline = domOutline(ctx.$);
  assert.match(outline, /#cookie-banner\.consent\.overlay/);
  assert.match(outline, /#main/);
  assert.match(outline, /We value your privacy/);

  const many = `<html><body>${"<div class=x>hi</div>".repeat(300)}</body></html>`;
  const truncated = domOutline(cheerio.load(many), 10);
  assert.match(truncated, /truncated/);
  assert.ok(truncated.split("\n").length <= 11, "outline should respect the limit");
});

test("inspect shows matching HTML, and says so when nothing matches", async () => {
  const ctx = makeCtx();
  assert.match(await tool(ctx, "inspect").run({ selector: "#cookie-banner" }), /1 match\(es\)/);
  assert.match(await tool(ctx, "inspect").run({ selector: "#cookie-banner" }), /We value your privacy/);
  assert.equal(await tool(ctx, "inspect").run({ selector: ".nope" }), "no matches");
});

test("remove deletes matches, counts them, and survives invalid selectors", async () => {
  const ctx = makeCtx();
  const report = await tool(ctx, "remove").run({ selectors: ["#cookie-banner", "p("] });
  assert.match(report, /#cookie-banner: removed 1/);
  assert.match(report, /p\(: invalid/);
  assert.equal(ctx.removed, 1);
  assert.equal(ctx.$("#cookie-banner").length, 0, "banner should be gone from the DOM");
  assert.equal(ctx.$("#main").length, 1, "main content should survive");
});

test("list_embeds lists iframe sources, or reports none", async () => {
  const ctx = makeCtx();
  assert.match(await tool(ctx, "list_embeds").run({}), /youtube\.com\/embed\/abc123/);
  const empty = makeCtx("<html><body><p>text</p></body></html>");
  assert.equal(await tool(empty, "list_embeds").run({}), "no embeds found");
});

test("set_main_content records selector/title and normalises tags", async () => {
  const ctx = makeCtx();
  await tool(ctx, "set_main_content").run({
    selector: "#main",
    title: "A fine post",
    tags: ["Web Archiving", "web archiving", "  CLAUDE  "],
  });
  assert.equal(ctx.mainSelector, "#main");
  assert.equal(ctx.title, "A fine post");
  for (const t of ctx.tags) {
    assert.equal(t, t.toLowerCase().trim(), `tag ${JSON.stringify(t)} should be normalised`);
  }
  assert.equal(new Set(ctx.tags).size, ctx.tags.length, "tags should be deduped");
});

test("finalize writes index.html + manifest.json and marks the run finished", async () => {
  const ctx = makeCtx();
  await tool(ctx, "remove").run({ selectors: ["#cookie-banner"] });
  await tool(ctx, "set_main_content").run({ selector: "#main", title: "A fine post", tags: ["testing"] });
  const out = await tool(ctx, "finalize").run({});
  assert.match(out, /archive written/);
  assert.ok(ctx.finalized);

  const html = fs.readFileSync(path.join(ctx.outDir, "index.html"), "utf8");
  assert.ok(!html.includes("cookie-banner"), "removed junk should not be in the written HTML");
  assert.match(html, /A fine post/);

  const manifest = JSON.parse(fs.readFileSync(path.join(ctx.outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.sourceUrl, "https://example.com/post");
  assert.equal(manifest.mainContentSelector, "#main");
  assert.deepEqual(manifest.tags, ["testing"]);
  assert.equal(manifest.elementsRemoved, 1);
  assert.ok(manifest.contentHash, "manifest should carry a content hash");
});
