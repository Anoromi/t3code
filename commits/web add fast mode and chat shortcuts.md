# Web add fast mode and chat shortcuts

Expose provider-backed fast-mode controls and chat-scoped focus and interrupt shortcuts without interfering with terminals, model selection, or command surfaces. Preserve live navigation status indicators while toggling upstream's live `serviceTier` descriptor and retaining legacy boolean fast-mode compatibility.

## Reimplementation Sources

This intent reimplements source commit `4ad89548eb` against upstream's model-option descriptors, composer draft persistence, interrupt command, navigation menu, and thread status components. It adds no duplicate fast-mode protocol and does not restore `/r`.

## Validation Coverage

Unit tests cover keybinding schemas and defaults, customized shortcut preservation, running-session action resolution, per-thread interrupt exclusion, standalone `/fast` parsing and context guards, live service-tier and legacy boolean descriptor validation, and unrelated option preservation. Chromium coverage verifies focus and single interrupt dispatch, repeat consumption, idle, terminal, command-surface, prevented-event, model-picker, and live preview-context guards; provider-supported and unsupported `/fast`; attached-context submission; sticky service-tier toggling; and navigation working, approval, input, connection, terminal, and remote status indicators.
