import "../index.css";

import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { MarkdownFileLink } from "./ChatMarkdown";

describe("MarkdownFileLink", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens code paths in the preferred editor on primary click", async () => {
    const openInEditor = vi.fn(async () => AsyncResult.success(undefined));
    const openInBrowser = vi.fn(async () => AsyncResult.success(undefined));
    const screen = await render(
      <MarkdownFileLink
        href="/workspace/project/src/index.ts"
        targetPath="/workspace/project/src/index.ts"
        iconPath="src/index.ts"
        displayPath="src/index.ts"
        workspaceRelativePath="src/index.ts"
        label="index.ts"
        copyMarkdown="[index.ts](src/index.ts)"
        theme="dark"
        onOpen={openInEditor}
        onOpenInBrowser={openInBrowser}
      />,
    );

    try {
      await page.getByRole("link", { name: "index.ts" }).click();
      expect(openInEditor).toHaveBeenCalledOnce();
      expect(openInEditor).toHaveBeenCalledWith("/workspace/project/src/index.ts");
      expect(openInBrowser).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
