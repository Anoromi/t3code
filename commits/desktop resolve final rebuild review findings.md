# Desktop: resolve final rebuild review findings

## Goal

Keep the rebuilt desktop integrations usable during transient credential outages and preserve ordinary shell syntax in custom Hyprnav commands.

## Included Changes

- Keeps an Electron-owned Corkdiff window focusable after its credential refresh deadline while the existing refresh loop retries ticket issuance.
- Preserves `${NAME}` shell parameter expansions while continuing to validate and expand Hyprnav's `{name}` placeholders.

## Validation Coverage

Preserve focused regression scenarios for expired managed Corkdiff sessions, unmanaged viewers, credential replacement, and mixed shell/Hyprnav placeholder expansion.

## Review Provenance

Resolves both findings from the final whole-branch `codex review` against pinned upstream `ebe8afb1df357423a0e036b388af3e739d640205`.
