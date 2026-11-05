# Chat and Dev modes

IVE provides two views of the same sessions. Chat presents one conversation,
a message composer, saved history, and permission requests. Dev retains the
project tree, terminal tabs and a terminal grid. Switching views does not start
or stop a session, change its provider, or discard an unsent in-memory draft.

## Starting and navigating a conversation

Choose Claude or Codex on Home, optionally select a project, and send a message.
New chat opens the composer without creating an empty session. Saved
conversations can be opened without starting their workers.

The left sidebar can be hidden completely. A labelled recovery control remains
in the header, and the visibility preference persists. Phone navigation has an
explicit close action. The mode choice and Home draft also persist.

Dev keeps live terminal connections and existing scrollback mounted. Never-viewed
sessions explicitly marked as stopped initialize their terminal renderer on
first display. Offscreen grid tiles avoid repeated fitting and context polling.

## Reviewing changes

Review includes the project, conversation, linked task, original request, and
selected diff. Staged means selected for a Git commit; it is not a schedule.
The view identifies missing review-trigger information and does not infer which
agent authored shared-workspace changes. Existing edits are not represented as
pending edits that a review button would apply.

Explain this and Why another agent? run an independent explanation using Claude
or Codex, with no tools. They do not launch a reviewer or send input to the working
session. Feedback, explicit reviewer launch and copying changes remain separate
actions.

The owner-only explanation API hashes the complete selected context before
limiting model input, rejects stale snapshots, deduplicates requests, and supports
cancellation. Refresh updates the visible diff before fetching new context.

## Validation

Browser checks use isolated API and PTY fixtures against the production frontend.
They cover Chat/Dev switching, provider selection, sidebar persistence, mobile and
dark layouts, request choices, permission-key isolation, review explanations,
search scrolling and a grid with 100 saved tabs. That grid test does not measure
the throughput of 100 real agents.

From `frontend/`, after installing the existing project dependencies:

```sh
npm run build
node --test tests/chat-dev-experience.mjs tests/chat-permission-integrated.mjs
node --test tests/session-permission-shortcuts.mjs tests/find-scroll-pinned-integrated.mjs
node --test tests/session-header-geometry.mjs tests/session-composer-mobile.mjs
node --test tests/review-context-unit.mjs tests/review-explanation-browser.mjs tests/review-sidebar-integrated.mjs
```

Set `IVE_QA_BROWSER=webkit` for browser suites that support both engines.
From `backend/`, using the project's Python environment:

```sh
python -m unittest test_review_explanation test_sidechat test_repo_review
```

## Current limits

Review explanations use the selected Git snapshot and linked task information;
they do not query a scheduler history. Session composer drafts remain in memory
across view changes but can be lost on a full browser reload. The Home draft is
persisted. Provider operation requires an installed CLI and a valid login.
