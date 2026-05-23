import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../", import.meta.url);

async function readRepoFile(relativePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(relativePath, repoRootUrl), "utf8");
}

describe("workflow configuration", () => {
  it("keeps release workflow wired for desktop artifact publishing", async () => {
    const workflow = await readRepoFile(".github/workflows/release.yml");

    expect(workflow).toContain("dist:desktop");
    expect(workflow).toContain("dist:desktop:artifact");
    expect(workflow).toContain("AppImage");
  });
});
