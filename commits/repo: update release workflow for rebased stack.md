# repo: update release workflow for rebased stack

## Goal

Keep release automation aligned with the rebased desktop and packaging stack without mixing it into feature implementation commits.

## Implementation Summary

- Restores the branch's release workflow changes on top of upstream/main.
- Keeps the workflow update separate from runtime, desktop, and web feature commits.
- Documents the final squashed-history metadata commit in `commits/`.

## Reimplementation Notes

- Preserve upstream release guard behavior while carrying the branch-specific release upload and desktop artifact adjustments.
- Do not reintroduce the old one-file-per-original-commit specs from the unsquashed branch.

## Expected Behavior

- Release jobs keep the rebased branch's intended gating and artifact behavior.
- The rewritten branch has a concise spec file for each new squashed commit.
