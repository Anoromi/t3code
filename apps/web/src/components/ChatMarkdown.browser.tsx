import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { openInPreferredEditorMock, readAloudContextMock, readLocalApiMock } = vi.hoisted(() => ({
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  readAloudContextMock: vi.fn<() => unknown>(() => null),
  readLocalApiMock: vi.fn(() => ({
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: { openInEditor: vi.fn(async () => undefined) },
  })),
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

vi.mock("./readAloud/ThreadReadAloudProvider", () => ({
  useThreadReadAloudContext: readAloudContextMock,
}));

import ChatMarkdown, { buildReadAloudCodeFocusKey } from "./ChatMarkdown";
import { AGENT_HIGHLIGHT_LABELS } from "./agentHighlights/agentHighlightMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    readAloudContextMock.mockReset();
    readAloudContextMock.mockReturnValue(null);
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("renders whitelisted agent highlight spans", async () => {
    const screen = await render(
      <ChatMarkdown text={'This is <span class="issue">broken</span>.'} cwd="/repo/project" />,
    );

    try {
      const highlight = document.querySelector(".agent-highlight-issue");
      expect(highlight).not.toBeNull();
      expect(highlight).toHaveAttribute("data-agent-highlight", "issue");
      expect(highlight?.textContent).toBe("broken");
    } finally {
      await screen.unmount();
    }
  });

  it("supports every agent highlight label", async () => {
    const screen = await render(
      <ChatMarkdown
        text={AGENT_HIGHLIGHT_LABELS.map((label) => `<span class="${label}">${label}</span>`).join(
          " ",
        )}
        cwd="/repo/project"
      />,
    );

    try {
      for (const label of AGENT_HIGHLIGHT_LABELS) {
        const highlight = document.querySelector(`[data-agent-highlight="${label}"]`);
        expect(highlight).not.toBeNull();
        expect(highlight).toHaveClass(`agent-highlight-${label}`);
        expect(highlight?.textContent).toBe(label);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("preserves markdown formatting inside agent highlights", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'<span class="issue">bad **result** and `code`</span>'}
        cwd="/repo/project"
      />,
    );

    try {
      const highlight = document.querySelector("[data-agent-highlight='issue']");
      expect(highlight).not.toBeNull();
      expect(highlight?.querySelector("strong")?.textContent).toBe("result");
      expect(highlight?.querySelector("code")?.textContent).toBe("code");
    } finally {
      await screen.unmount();
    }
  });

  it("applies semantic highlight color to nested inline markdown affordances", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'<span class="issue">bad `activeTurnId` and [docs](https://example.com)</span>'}
        cwd="/repo/project"
      />,
    );

    try {
      const highlight = document.querySelector<HTMLElement>("[data-agent-highlight='issue']");
      const code = highlight?.querySelector<HTMLElement>("code");
      const link = highlight?.querySelector<HTMLElement>("a");

      expect(highlight).not.toBeNull();
      expect(code).not.toBeNull();
      expect(link).not.toBeNull();

      const highlightColor = getComputedStyle(highlight!).color;
      expect(getComputedStyle(code!).color).toBe(highlightColor);
      expect(getComputedStyle(link!).color).toBe(highlightColor);
    } finally {
      await screen.unmount();
    }
  });

  it("preserves links inside agent highlights", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'<span class="source">See [docs](https://example.com)</span>'}
        cwd="/repo/project"
      />,
    );

    try {
      const highlight = document.querySelector("[data-agent-highlight='source']");
      const link = highlight?.querySelector("a");
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link?.textContent).toBe("docs");
    } finally {
      await screen.unmount();
    }
  });

  it("does not transform unknown or extra span classes", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          '<span class="random">random</span> <span class="issue urgent">urgent</span> <span class="agent-highlight issue">ok</span>'
        }
        cwd="/repo/project"
      />,
    );

    try {
      const highlights = [...document.querySelectorAll("[data-agent-highlight]")];
      expect(highlights).toHaveLength(1);
      expect(highlights[0]?.textContent).toBe("ok");
      expect(highlights[0]).toHaveAttribute("data-agent-highlight", "issue");
    } finally {
      await screen.unmount();
    }
  });

  it("does not transform agent highlight spans inside fenced code", async () => {
    const screen = await render(
      <ChatMarkdown text={'```html\n<span class="issue">broken</span>\n```'} cwd="/repo/project" />,
    );

    try {
      expect(document.querySelector("[data-agent-highlight]")).toBeNull();
      expect(document.querySelector(".chat-markdown-codeblock")?.textContent).toContain(
        '<span class="issue">broken</span>',
      );
    } finally {
      await screen.unmount();
    }
  });

  it("does not enable arbitrary raw html and tolerates malformed spans", async () => {
    const screen = await render(
      <ChatMarkdown
        text={'<script>alert(1)</script> <span class="issue">unterminated'}
        cwd="/repo/project"
      />,
    );

    try {
      expect(document.querySelector(".chat-markdown script")).toBeNull();
      expect(document.querySelector("[data-agent-highlight]")).toBeNull();
      expect(document.body.textContent).toContain("unterminated");
    } finally {
      await screen.unmount();
    }
  });

  it("renders stable read-aloud focus keys for code blocks", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"```sh\nbun run dev\n```\n\n```ts\nconst value = 1\n```"}
        cwd="/repo/project"
        readAloudScopeId="message:test"
      />,
    );

    try {
      const blocks = [...document.querySelectorAll(".chat-markdown-codeblock")];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toHaveAttribute("data-read-aloud-code-focus-key", "message:test:code:0");
      expect(blocks[1]).toHaveAttribute("data-read-aloud-code-focus-key", "message:test:code:1");
      expect(blocks[0]).not.toHaveAttribute("data-read-aloud-code-active");
      expect(blocks[1]).not.toHaveAttribute("data-read-aloud-code-active");
    } finally {
      await screen.unmount();
    }
  });

  it("renders active code state from read-aloud context", async () => {
    readAloudContextMock.mockReturnValue({
      activeCodeFocusKey: buildReadAloudCodeFocusKey({
        scopeId: "message:test",
        codeBlockIndex: 1,
      }),
      onMarkdownContextMenu: vi.fn(),
    });
    const screen = await render(
      <ChatMarkdown
        text={"```sh\nbun run dev\n```\n\n```sh\nbun run lint\n```"}
        cwd="/repo/project"
        readAloudScopeId="message:test"
      />,
    );

    try {
      const blocks = [...document.querySelectorAll(".chat-markdown-codeblock")];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).not.toHaveAttribute("data-read-aloud-code-active");
      expect(blocks[1]).toHaveAttribute("data-read-aloud-code-active", "true");
    } finally {
      await screen.unmount();
    }
  });
});
