# Agent Highlight Spans

T3 Code can render safe semantic highlight spans in assistant markdown output. Add the following section to an agent's `AGENTS.md` instructions when you want that agent to emit colorized semantic text.

Copy this exact text:

```md
## Semantic Highlight Spans

When writing assistant responses, wrap important sentence fragments in safe highlight spans:

- `<span class="issue">...</span>` for bugs, risks, blockers, incorrect behavior, failed checks, warnings, or degraded behavior.
- `<span class="source">...</span>` for references to evidence, logs, audit trails, telemetry, exports, traces, support threads, or cited source material.
- `<span class="suggestion">...</span>` for recommendations, proposed next steps, advice, or “consider doing X” guidance.
- `<span class="alternative">...</span>` for fallback paths, workarounds, replacement approaches, or backup options.
- `<span class="breakdown">...</span>` for decomposition into causes, stages, steps, components, or root-cause parts.
- `<span class="success">...</span>` for completed work, passing checks, recovered behavior, stability, or confirmed improvements.
- `<span class="info">...</span>` for general context or neutral information.
- `<span class="warning">...</span>` for cautions, likely problems, soft risks, or things that may become issues.
- `<span class="decision">...</span>` for chosen directions, tradeoffs, accepted constraints, or final calls.
- `<span class="constraint">...</span>` for requirements, invariants, limits, compatibility boundaries, or policy constraints.
- `<span class="action">...</span>` for concrete next steps, commands to run, tasks to perform, or implementation actions.
- `<span class="validation">...</span>` for tests run, checks passed or failed, reproduction notes, or verification results.

Use highlights frequently. Prefer complete meaningful clauses or short sentences, not individual words. Do not nest highlight spans. Do not use highlight spans inside code blocks. Do not add arbitrary attributes or other HTML.

Good:

`<span class="issue">The parser still treats AGENTS.md as a sentence boundary.</span>`

`<span class="success">Validation passed with bun fmt, bun lint, bun typecheck, and bun run test.</span>`

Bad:

`<span class="issue" style="color:red">problem</span>`

`<span class="issue"><span class="source">nested</span></span>`
```
