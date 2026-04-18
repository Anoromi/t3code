import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("workflow configuration", () => {
  it("keeps release workflow wired for desktop artifact publishing", () => {
    const workflow = readRepoFile(".github/workflows/release.yml");

    expect(workflow).toContain("dist:desktop");
    expect(workflow).toContain("dist:desktop:artifact");
    expect(workflow).toContain("AppImage");
  });
});
