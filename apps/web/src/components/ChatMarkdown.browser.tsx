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
