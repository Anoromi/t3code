# web: add agent-authored markdown highlights

## Goal

Render safe semantic highlight spans in agent-authored markdown without enabling arbitrary raw HTML.

## Included Changes

- Adds a remark transform for whitelisted `<span class="...">...</span>` semantic labels.
- Preserves normal markdown behavior while rejecting unsupported classes and unsafe markup.
- Adds tests for allowed labels, markdown preservation, fenced code, and script safety.
- Adds styling and documentation for semantic highlight spans.

## Expected Behavior

Agent responses can annotate meaningful prose fragments with safe semantic classes, and the chat renderer displays them as readable colored text while keeping markdown rendering safe.
