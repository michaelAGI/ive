# Device Hub integration handoff

Prepared 2026-11-18 on `feat/device-hub-integration-20261118`, based on public
`main` / IVE 1.0.31 (`f30c134`). Release candidate 1.0.32 is prepared on
`release/1.0.32`. Release artifacts and validation reports belong in
`packaging/artifacts/`; a source commit alone is not a signed desktop release.
See [the user guide](device-hub-guide.md).

## Included

- Devices navigation, command palette entry, connection guide, provider choice,
  explicit Full access choice, setup-agent creation, task delivery and recovery
  link to an already-created session on failure.
- Ten editable use-case templates. Picking a template does not dispatch it.
  A task submitted with setup runs only after verification; assigned agents
  can receive a task directly.
- Authenticated REST routes at `/api/device-hub/*`. Grant/revoke is restricted
  to the local owner UI; agent calls require the persisted session proof,
  not the legacy self-declared session identity. Plan/read-only modes cannot
  send inputs or perform setup mutations.
- Shared MCP tools in Commander and ordinary Claude/Codex worker sessions:
  `device_list`, `device_setup`, `device_observe`, `device_act`, `device_release`.
  Observe returns both metadata and an MCP image. Sidechat has no new runtime.
- Physical iPhone discovery; exact CoreDevice UUID selection; setup grant
  pinned to the selected device (or the sole reachable device); separate
  control lease per device/session, expiring after one hour.
- Scoped screenshot, portrait tap/swipe, clipboard text input, Home and four
  named keys. No raw shell command or arbitrary devicectl endpoint is exposed
  through the device MCP contract.
- Setup orchestration: requirements check, bundled helper preparation, Apple
  pairing, Developer Mode request and screen verification. Xcode installation,
  Trust, passcode and required Apple confirmations remain user steps.
- The read-only photo report script is packaged and its interpreter/path
  arguments are returned in `device_list`. It accepts only an explicitly
  chosen export folder; pairing does not mount the phone's photo library.

## Native source and packaging

`packaging/device-control/ipb/manifest.json` pins ipb 0.6.0 at upstream revision
`8c227a10710dad479852aa0203de729fed57471b`. Twelve source/support files are copied
unchanged from that revision, with SHA-256 digests and the original MIT license.
The aggregate notice collector includes ipb. No unrelated prototype UI, private
recordings or device identifiers are bundled.

PyInstaller includes the source payload and photo report. Setup verifies every
source digest, copies it under IVE's data directory, and invokes only
`make check-reports build/ipb-helper`. It never runs upstream `install`, `update`,
mirror or smoke targets, or downloads another tool. Native preparation was
executed successfully on this Apple-Silicon Mac with macOS 27.2 and Xcode 27.2.
The optional runtime cache includes source, host version/architecture and the
CoreDevice package fingerprint. Native requirements do not raise IVE's general
macOS minimum or link the app itself to the private frameworks.

## Input and access behavior

Frames last 45 seconds and are consumed by one input. The UI preview cannot
overwrite an agent's frame. Immediately before coordinate input, the adapter
checks current screenshot dimensions and rejects rotation/landscape. Grant
identity and expiry are rechecked after asynchronous preparation. Stop kills
the adapter process group; it cannot undo an already-delivered input.

The last 256 command outcomes are journaled privately (0600, atomic replace),
with hashes of input arguments, not typed text or images. Retries of a recorded
ID return its saved result. An interrupted record is unknown after restart;
an unreadable journal blocks new input. This is bounded retry protection, not
an indefinite deduplication guarantee. Native submission is reported as
`submitted`, never as verified effect; the agent must observe again.

Setup/control grants are in memory and disappear on backend restart. A missing
device or expired grant releases control. Revoking a completed setup's device
also removes its setup grant, preventing it from silently reassigning control.
Finishing Mac preparation is `step_complete`; only final screen verification
reports the setup as ready.

Full-access sessions retain arbitrary Mac execution capabilities. Local-owner
checks and device leases scope the supported IVE route; they are not an OS
sandbox against arbitrary local shell calls. Stop the agent session as well
when all activity must end. Screen content goes to the selected agent/provider
and may exist in that provider's transcript.

## Validation and reproduction

Use the repository's Python environment with backend dependencies installed.

```sh
cd backend
python -m unittest test_device_hub test_device_hub_discovery test_tool_semantics_ive_tools test_session_proofs test_desktop_runtime.DesktopRuntimeTests -q
cd ../scripts
python -m unittest test_photo_duplicate_report -q
cd ..
node --test frontend/tests/device-hub-unit.mjs
npm --prefix frontend run build -- --configLoader runner --logLevel warn
node frontend/tests/device-hub-preview.mjs
```

The preview generator bundles the production DeviceHub component with fixture
API functions, inline local fonts and no network access. Open
`frontend/device-hub-review/index.html`; it has wide/390px and
initial/empty/ready/assigned modes. The generated HTML is ignored by Git.

Observed checks: 82 tests passed in total (70 backend, 6 photo-report,
6 frontend start-flow tests).

- Backend/device/auth/tool semantics and desktop dispatcher unit checks pass.
- Six photo-report tests pass with both Python 3.12 and Apple's Python 3.9:
  real copied-file fixtures, same-size different contents, hardlinks, symlinks,
  library exclusions, changed files and exclusive report creation.
- Six frontend start-flow tests pass: permission choice, grant-before-input,
  autostart failure, failed grant and uncertain-delivery recovery, ten recipes.
- Frontend production build passes. Existing CSS `::highlight`, mixed import
  and bundle-size warnings remain.
- Safari visual inspection at 1280px and 390px, with production component and
  fixture data: empty/connected/assigned states, recipe selection, queued task,
  direct task delivery, Stop setup, Stop control, scrolling and expanded guide.
- Native source digests and helper build pass. `devicectl` screenshot/pair
  argument names were checked against the installed Xcode help output.
- Registered route tests use aiohttp mocked requests; they do not bind sockets.

## Still required before calling the release phone-tested

At source integration commit `03d270b`, no desktop app had been packaged,
notarized, published or installed; the installed app was still 1.0.31.
Sandbox restrictions prevented a local HTTP server test; the UI fixture is not
an end-to-end live IVE session.
CoreDevice enumeration timed out in this environment, so no real screenshot,
touch or text input was asserted for this integration.

For release acceptance, build/sign the app through the normal packaging flow,
then use one authorized, unlocked iPhone and an ordinary agent session to check:
discovery → setup → screenshot → harmless tap/swipe → test-field text → Home →
fresh screenshot. Also verify Stop control, cable removal/reconnect, lease
expiry, old-session restart, unsupported-platform messaging, and both provider
MCP image paths. Do not use a real purchase, message or deletion as the smoke
test. Revalidate the private HID interface after Apple platform updates.
