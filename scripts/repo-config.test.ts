import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function stripJsoncComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function commitSubjectToSpecPath(subject: string): string {
  return path.join(repoRoot, "commits", `${subject}.md`);
}

describe("repo configuration and branch metadata", () => {
  it("parses btca.config.jsonc and declares named resources", () => {
    const config = JSON.parse(stripJsoncComments(readRepoFile("btca.config.jsonc"))) as {
      resources?: Array<{ name?: string; type?: string }>;
    };

    expect(config.resources?.some((resource) => resource.name === "monaco-vim")).toBe(true);
    expect(config.resources?.every((resource) => typeof resource.type === "string")).toBe(true);
  });

  it("keeps AGENTS.md aligned with test, BTCA, and rebase workflow requirements", () => {
    const agents = readRepoFile("AGENTS.md");
    const criticalWorkflow = agents.slice(agents.indexOf("## Critical Workflow"));

    expect(agents).toContain("NEVER run `bun test`. Always use `bun run test`");
    expect(criticalWorkflow.indexOf("listResources")).toBeGreaterThanOrEqual(0);
    expect(criticalWorkflow.indexOf("listResources")).toBeLessThan(criticalWorkflow.indexOf("ask"));
    expect(agents).toContain("t3code-rebase-conflict-resolution");
  });

  it("installs the project rebase skill with persistence and orchestration guidance", () => {
    const skill = readRepoFile(".codex/skills/t3code-rebase-conflict-resolution/SKILL.md");

    expect(skill).toContain("persistence");
    expect(skill).toContain("orchestration");
    expect(skill).toContain("migrations");
    expect(skill).toContain("projections");
    expect(skill).toContain("settings");
  });

  it("has a commit spec file for each commit currently above upstream/main", () => {
    let subjects: string[];
    try {
      execFileSync("git", ["rev-parse", "--verify", "upstream/main"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      subjects = execFileSync("git", ["log", "--format=%s", "upstream/main..HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      subjects = fs
        .readdirSync(path.join(repoRoot, "commits"))
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => entry.slice(0, -".md".length));
    }

    expect(subjects.length).toBeGreaterThan(0);
    for (const subject of subjects) {
      const specPath = commitSubjectToSpecPath(subject);
      expect(fs.existsSync(specPath), specPath).toBe(true);
      expect(fs.readFileSync(specPath, "utf8")).toContain("# ");
    }
  });
});
