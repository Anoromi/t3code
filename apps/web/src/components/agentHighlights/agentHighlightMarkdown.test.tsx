import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AGENT_HIGHLIGHT_LABELS, remarkAgentHighlightSpans } from "./agentHighlightMarkdown";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkAgentHighlightSpans]}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkAgentHighlightSpans", () => {
  it("renders whitelisted agent highlight spans", () => {
    const html = renderMarkdown('This is <span class="issue">broken</span>.');

    expect(html).toContain('class="agent-highlight agent-highlight-issue"');
    expect(html).toContain('data-agent-highlight="issue"');
    expect(html).toContain(">broken</span>");
  });

  it("supports every agent highlight label", () => {
    const html = renderMarkdown(
      AGENT_HIGHLIGHT_LABELS.map((label) => `<span class="${label}">${label}</span>`).join(" "),
    );

    for (const label of AGENT_HIGHLIGHT_LABELS) {
      expect(html).toContain(`agent-highlight-${label}`);
      expect(html).toContain(`data-agent-highlight="${label}"`);
    }
  });

  it("preserves markdown inside highlights", () => {
    const html = renderMarkdown('<span class="issue">bad **result** and `code`</span>');

    expect(html).toContain("<strong>result</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("preserves links inside highlights", () => {
    const html = renderMarkdown('<span class="source">See [docs](https://example.com)</span>');

    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it("does not transform unknown or extra span classes", () => {
    const html = renderMarkdown(
      '<span class="random">random</span> <span class="issue urgent">urgent</span> <span class="agent-highlight issue">ok</span>',
    );

    expect(html).toContain("random");
    expect(html).toContain("urgent");
    expect(html).toContain('data-agent-highlight="issue"');
    expect(html.match(/data-agent-highlight=/g)).toHaveLength(1);
  });

  it("does not transform agent highlight spans inside fenced code", () => {
    const html = renderMarkdown('```html\n<span class="issue">broken</span>\n```');

    expect(html).not.toContain("data-agent-highlight");
    expect(html).toContain("&lt;span class=&quot;issue&quot;&gt;broken&lt;/span&gt;");
  });

  it("does not enable arbitrary raw html and tolerates malformed spans", () => {
    const html = renderMarkdown('<script>alert(1)</script> <span class="issue">unterminated');

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("data-agent-highlight");
    expect(html).toContain("unterminated");
  });
});
