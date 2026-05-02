/**
 * markdown-render.test.mjs — Unit tests for the pure-JS Markdown renderer.
 *
 * Run:
 *   node --test scripts/test/markdown-render.test.mjs
 *
 * Focus areas:
 *   - Table support (the recently-added feature)
 *   - Existing block constructs (paragraphs, lists, code) keep working
 *     after the table parser was wired in
 *   - HTML escape boundary: nothing user-supplied is interpolated raw
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdownHtml } from "../lib/markdown-render.mjs";

// ---------------------------------------------------------------------------
// Existing constructs — sanity that adding the table parser didn't regress
// ---------------------------------------------------------------------------

test("plain paragraph renders inside <p>", () => {
  assert.equal(renderMarkdownHtml("hello world"), "<p>hello world</p>");
});

test("bold + inline code in a paragraph", () => {
  assert.equal(
    renderMarkdownHtml("status: **OK** (uses `node:crypto`)"),
    "<p>status: <strong>OK</strong> (uses <code>node:crypto</code>)</p>",
  );
});

test("unordered list renders <ul><li>", () => {
  const html = renderMarkdownHtml("- a\n- b");
  assert.equal(html, "<ul><li>a</li><li>b</li></ul>");
});

test("fenced code block escapes HTML inside and drops the closing fence", () => {
  const html = renderMarkdownHtml("```\n<script>alert(1)</script>\n```");
  assert.equal(
    html,
    "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
  );
  assert.doesNotMatch(html, /<script>/u);
});

test("fenced code block with language hint preserves multi-line body", () => {
  const md = "```bash\ngit add a\ngit add b\n```";
  const html = renderMarkdownHtml(md);
  assert.equal(
    html,
    `<pre><code class="language-bash">git add a\ngit add b</code></pre>`,
  );
  // The literal closing fence must not leak into the rendered body.
  assert.doesNotMatch(html, /```/u);
});

test("unterminated code fence keeps every following line in the body", () => {
  // Defensive: if the user (or AI output) opens a fence and never closes it,
  // we should still render the rest of the message as code rather than
  // dropping everything. The closing-fence stripper only runs when the last
  // collected line is itself a fence.
  const md = "```\nline 1\nline 2";
  const html = renderMarkdownHtml(md);
  assert.equal(html, "<pre><code>line 1\nline 2</code></pre>");
});

test("empty input falls back to default", () => {
  assert.equal(renderMarkdownHtml(""), "<p></p>");
  assert.equal(renderMarkdownHtml("   "), "<p></p>");
});

// ---------------------------------------------------------------------------
// Tables — the actual new feature
// ---------------------------------------------------------------------------

test("basic 2x2 table renders thead + tbody", () => {
  const md = [
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n");
  assert.equal(
    renderMarkdownHtml(md),
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("table separator must use at least 2 dashes per cell", () => {
  // Single-dash cells are NOT treated as a separator; falls back to paragraph.
  const md = [
    "| A | B |",
    "|-|-|",
    "| 1 | 2 |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  assert.match(html, /^<p>/u);
  assert.doesNotMatch(html, /<table/u);
});

test("alignment markers map to text-align style", () => {
  const md = [
    "| left | center | right |",
    "|:-----|:------:|------:|",
    "| a    | b      | c     |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  assert.match(html, /<th style="text-align:left">left<\/th>/u);
  assert.match(html, /<th style="text-align:center">center<\/th>/u);
  assert.match(html, /<th style="text-align:right">right<\/th>/u);
  // Body cells inherit the column alignment.
  assert.match(html, /<td style="text-align:left">a<\/td>/u);
  assert.match(html, /<td style="text-align:center">b<\/td>/u);
  assert.match(html, /<td style="text-align:right">c<\/td>/u);
});

test("table cells go through the inline pipeline (bold + code escape)", () => {
  const md = [
    "| name | status |",
    "|------|--------|",
    "| **a** | `<b>` |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  // Bold survives.
  assert.match(html, /<td><strong>a<\/strong><\/td>/u);
  // The angle brackets inside backticks are escaped, not interpreted as HTML.
  assert.match(html, /<td><code>&lt;b&gt;<\/code><\/td>/u);
  assert.doesNotMatch(html, /<td><b><\/td>/u);
});

test("escaped pipe `\\|` stays as a literal '|' in cells", () => {
  const md = [
    "| col |",
    "|-----|",
    "| a \\| b |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  assert.match(html, /<td>a \| b<\/td>/u);
});

test("data-row width can exceed header width without crashing", () => {
  const md = [
    "| h1 | h2 |",
    "|----|----|",
    "| 1  | 2  | 3 |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  // No alignment crash; extra cell renders unaligned.
  assert.match(html, /<td>1<\/td><td>2<\/td><td>3<\/td>/u);
});

test("table preceded by paragraph: paragraph closes before the header", () => {
  const md = [
    "intro line",
    "| col |",
    "|-----|",
    "| val |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  // The header line must not get sucked into the paragraph.
  assert.match(html, /^<p>intro line<\/p>\n<table>/u);
});

test("stray '| not a table |' line without a separator is plain text", () => {
  const md = "| just text |";
  const html = renderMarkdownHtml(md);
  assert.match(html, /^<p>/u);
  assert.doesNotMatch(html, /<table/u);
});

test("table with no body rows still renders thead", () => {
  const md = [
    "| h1 | h2 |",
    "|----|----|",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  assert.match(html, /<thead><tr><th>h1<\/th><th>h2<\/th><\/tr><\/thead><tbody><\/tbody>/u);
});

test("HTML in table cells is escaped (XSS guard)", () => {
  const md = [
    "| col |",
    "|-----|",
    "| <img src=x onerror=alert(1)> |",
  ].join("\n");
  const html = renderMarkdownHtml(md);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});
