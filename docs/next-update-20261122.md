# IVE 1.0.34 update — 2026-11-22

Prepared source changes selected for release 1.0.34 after the user's explicit
rollout request. The development checkpoint below predates packaging; release
notes are in `packaging/RELEASE-1.0.34.md` and packaging evidence is kept under
`packaging/artifacts/release-1.0.34-preflight/`. These changes are based on the
released 1.0.33 source.

Development branch: `feat/device-execution-20261122`; release: `release/1.0.34`.
Base: `fa7844024147deee18d5f85c044b1a38f172f535`.
Implementation commits: `4390a61` (device/Fable/prototype), `1963f4f` (terminal).
This document and the revised task templates complete the local handoff.

## Implemented

### Device execution

- `device_act` returns the resulting screenshot and fresh frame ID by default.
  After the initial observation, the agent can inspect that result and perform
  the next action without a separate `device_observe` call. Orientation checks
  remain in place; this reduces model/tool round trips, not every native capture.
- Device inventory has a two-second cache with concurrent-request deduplication;
  host prerequisites have a 30-second cache. Manual refresh, setup transitions
  and errors invalidate relevant state. Permissions and assignment leases are
  still checked independently.
- Setup can wait up to 20 seconds for an existing job. Timing out does not cancel
  or restart it. Action timing fields expose input, capture and total duration.
- Failed post-action capture preserves the input outcome. Retrying the same
  command ID never repeats input. Stop/expiry discards a no-longer-authorized
  frame. `screen_changed` compares captured bytes and does not claim task success.
- Both MCP clients allow the combined action/capture request enough time.
  Agent instructions use returned observations and bounded setup waiting.

### Claude Fable

Fable is available in the backend model profile, frontend fallback and API model
discovery. Claude launch handling accepts the documented `fable` alias and full
model IDs. Existing defaults and the automatic escalation ladder are unchanged.
Menu, request and launch tests do not establish account entitlement; no live
paid inference request was made.

### Terminal tabs

- Tab labels and Cmd+1–9 use the same visible, live tab order. Closing or opening
  a tab immediately updates the positions. The browser's Ctrl+1–9 fallback is
  covered separately.
- Tabs can be dragged left/right, with an insertion marker and edge scrolling.
  Alt+Shift+Left/Right also reorders a focused tab. Pointer events avoid the
  native desktop file-drop handler's HTML5 drag/drop conflict.
- Reordering uses session IDs, survives tabs closing during a drag and cancels
  when released outside the strip. Reordering preserves the active session;
  reordering and switching retain terminal DOM and running PTYs. Saved order
  survives page reload.

### Device task ideas

Photo review now explicitly includes similar shots, bursts and edited variants,
with source/scope checks and keeper choices. Screenshot and receipt tasks specify
batch tools when available, coverage, source references and uncertain results.
App testing specifies starting state, expected result and screen checkpoints.
Templates do not claim that a missing photo connector or workflow runner exists.

## Photo review: concept and prototype, not a connected scanner

[Execution and media plan](device-execution-next.md) defines an export-folder
source first, incremental local similarity analysis and later native PhotoKit
sources. Exact duplicates and near duplicates remain distinct. The existing
SHA-256 report has not been relabelled as a similarity detector.

[Interactive review prototype](prototypes/photo-review.html) uses illustrated
fixtures. It demonstrates folder-like groups, one/multiple keepers, keep all,
review later, side-by-side comparison and a JSON decision manifest. It does not
read a real library, detect similar photos or persist choices across reloads.
No source photos have been read, moved or deleted.

Still to implement: the local similarity worker and source connector, production
review integration, resident native transport and guarded multi-step workflows.
Those are specified in the plan and are not part of the current source fixes.

## Verification

- Backend: 106 tests passed across `test_claude_models`, `test_device_hub`,
  `test_device_hub_discovery`, `test_tool_semantics_ive_tools`,
  `test_session_proofs`, `test_codex_models` and `test_effort`.
- Frontend production build passed. Existing chunk-size/CSS warnings remain.
- Frontend units: 15 tests passed across `device-hub-unit.mjs`,
  `effort-unit.mjs` and `session-tabs-unit.mjs`.
- Terminal integration: 78 checks in Chromium and 78 in WebKit against the
  combined production build, including desktop Cmd and browser Ctrl shortcuts,
  open/close/drag/reload, retained terminal nodes and unchanged PTY start counts.
- Fable picker: 16 checks in each of Chromium and WebKit using model choices
  generated from the production backend profile and isolated provider transport.
- Photo prototype: Chromium and WebKit, desktop and mobile; group decisions,
  comparison, keyboard dismissal, export, reload reset and overflow checks passed.
- Terminal and photo screenshots were visually inspected. `git diff --check`
  passed. Local screenshots/logs are under
  `packaging/artifacts/device-next-review/` (ignored, not public assets).

Device tests use fake adapters; browser tests use isolated HTTP/PTY fixtures.
No physical iPhone, native Tauri runtime, real photo-library scan or elapsed-time
speed benchmark has been exercised for this batch. Before release, run normal
native packaging/lifecycle checks and test the combined device loop on a phone.
