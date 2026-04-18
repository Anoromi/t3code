# repo: add local agent and BTCA workflow guidance

Current hash: `pending` (informational; may change after rebase/amend)
Date: `2026-04-18`

## A. What This Achieves

Adds repository-local agent guidance, BTCA MCP setup, and a T3 Code-specific rebase conflict resolution skill so future automation follows the repo's persistence, orchestration, and desktop startup constraints.

## B. How It Achieves It

The commit adds Codex and BTCA configuration, extends AGENTS.md with BTCA and rebase-work instructions, adds the uncodixify frontend guidance, and installs the `.codex/skills/t3code-rebase-conflict-resolution` workflow.

## C. Reimplementation Notes

Keep local repository inspection separate from BTCA-backed external documentation lookup. Rebase guidance should stay concrete about migrations, orchestration events, projections, settings, sidebar behavior, and desktop startup.

## D. Expected Behavioral Results

- Agents use the project rebase skill when resolving T3 Code rebase conflicts or post-rebase regressions.
- BTCA usage requires listing configured resources first and is not used as a substitute for inspecting this repository.
- Repository-local frontend and workflow guidance is available without relying on global agent configuration.
