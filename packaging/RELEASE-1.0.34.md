IVE 1.0.34 — Device execution and terminal tabs

Device actions now return the next screen in the same tool result. Short-lived
device and setup-check caches, plus bounded setup waiting, reduce repeated tool
calls. Capture errors preserve the action outcome so retries do not repeat input.
These changes reduce round trips; a real-phone speed benchmark is still pending.

Terminal tabs can be dragged into a new order. Cmd+1–9 follows the visible order
after opening, closing or rearranging tabs. Reordering keeps existing terminals
running. Alt+Shift+Left/Right also moves a focused tab.

Claude Fable is available in model selection through the Claude Code alias.
Availability depends on the connected Claude account. Existing defaults and
automatic model escalation are unchanged.

Device task ideas now give clearer scopes and outputs for similar-photo review,
screenshots, receipts and app testing. The photo review concept is documented;
a connected photo similarity scanner is not included in this release.

The changes passed backend tests, production frontend builds and Chromium/WebKit
checks. Physical iPhone control and its elapsed-time performance still need
device validation. Existing phone-control requirements and Apple prompts apply.
