# Next IVE version: faster device tasks and photo review

Status: initial execution improvements, implementation plan and interactive
review prototype, 2026-11-22.
Base: IVE 1.0.33 / `fa7844024147deee18d5f85c044b1a38f172f535`.
Implemented locally: action plus screenshot in one result, bounded inventory
and prerequisite caches, bounded setup waiting, related agent instructions,
timing fields, and Fable selection. The resident helper, guarded workflows and
photo analysis/source integration below remain planned. The running app,
device sessions and photo libraries have not been changed. Nothing is released.

## Product outcome

The agent should spend time deciding what to do, while IVE handles predictable
device operations and large local jobs. A person reviewing 10,000 photos should
receive a growing collection of similar-shot groups and choose which images to
keep. They should not watch an agent open 10,000 photos individually.

The separate physical IVE adapter is still future work. Today's implementation
uses a Mac/CoreDevice bridge (`backend/device_adapter.py`). Build the execution
contract independently of that transport, then reuse it for a future adapter.
Do not advertise a physical adapter, raw iPhone library access or a measured
speed improvement based on the current source alone.

## 1. Remove unnecessary model round trips

The 1.0.33 baseline requires `device_observe`, one `device_act`, another
`device_observe`, etc. Both paths enumerate devices. Coordinate actions take
another screenshot internally solely to check dimensions/orientation. Setup
asks the agent to poll background jobs. The native wrapper resolves service
descriptors and starts helper processes repeatedly.

Target design, with steps 1, 2 and bounded waiting from step 5 now implemented
locally; the remaining steps still require implementation:

1. **Action with observation.** Extend `device_act` to return the next image,
   frame ID, dimensions, observation timestamp and input outcome in the same
   MCP result. The existing MCP wrapper already accepts image content. Keep
   `device_observe` for initial inspection and recovery. Update task prompts
   to read the returned screen instead of automatically requesting another.
2. **Short-lived discovery cache.** Reuse device inventory for a short, bounded
   interval and cache host prerequisites separately. Deduplicate concurrent
   requests. Refresh on setup transitions, explicit refresh, connection errors
   and native device events where available. Never cache permission/lease
   decisions. A cached device entry is not proof that an input succeeded.
3. **Resident transport.** Keep a native helper and verified HID service IDs
   alive per device/connection generation. Use a bounded request/response
   protocol, an idle timeout and a tunnel lifetime check. Stop/reassignment
   must terminate all old-generation work. No retry after uncertain dispatch.
   This requires a real-phone check; a persistent shell around short-lived
   native commands would not remove the actual connection overhead.
4. **Screen readiness.** Use bounded frame-change/stability checks after input.
   Report `unchanged`, `changed`, `stable` or `timed_out` as observation facts,
   not as proof that the user's task succeeded. Avoid fixed sleeps per step.
   Reuse trustworthy orientation metadata from a live transport when available;
   retain the extra orientation capture for transports without that capability.
5. **Setup jobs.** Add a bounded wait operation/events so setup completion does
   not require repeated model-driven status polling. A timeout returns a job ID
   and current state; it must not restart preparation or pairing.

Idempotency must survive combining input and capture: journal input submission
before dispatch; if the following capture fails, return the recorded action
outcome plus a capture error. Reusing the command ID must never repeat the input.
Revalidate the assignment after awaits, including before returning a frame.
Record timings for discovery, connection, input, settling, capture and encoding;
measure model waiting separately. Do not log screenshot contents or typed text.

## 2. Execute known steps locally

Add `device_run` for small bounded sequences and `device_workflow` for saved
routines. These are structured actions, not arbitrary scripts or shell code.

- Each step declares the expected precondition and expected result. Use a
  specific UI target when the transport provides one; otherwise use an observed
  visual anchor/region and checked geometry. Coordinates alone are insufficient
  for an unattended multi-screen sequence.
- Perform checks between steps locally. Pause with a screenshot and a precise
  completed-step list when the screen differs, the phone disconnects, a modal
  appears or input becomes uncertain. Resume only from a newly validated state.
- Bound action count, execution time and retry count. Stop and permission
  changes take effect between steps as well as during native requests.
- Save a workflow only from an inspected successful run. Persist parameter
  placeholders, expected states and versioned transport requirements; avoid
  recording secrets or typed personal content as fixed defaults.
- Replay returns the final screen, per-step results and the first failed
  precondition. A checked sequence is reusable; it is not guaranteed to work
  after every app update. Never turn an unverified trace into a verified routine.

Use this for repeated test flows and known forms. A large photo scan should use
the separate media pipeline below, even when its launch came from Device mode.

## 3. Similar photos: source to decisions

### Source and permissions

First deliver an explicitly chosen **export folder on the Mac**. This works
without the unfinished hardware adapter. Keep the source-folder hierarchy as a
navigation/filter option; review groups are virtual folders, not moved files.
Never scan inside an Apple Photos library package.

For a later native photo source, use PhotoKit on the device that actually owns
the library, after that app receives Photos permission. A Mac Photos library
and an iPhone library are not interchangeable. Limited access covers only
authorized assets. An unsynced iPhone library needs the iPhone companion/source
connector; USB device control does not provide PhotoKit access automatically.

Expose source capabilities independently: `screen_control`, `media_list`,
`media_thumbnail`, `media_original`, `media_selection`, `media_change`.
The UI offers only operations actually supported by the selected source.

### Local pipeline

1. Enumerate stable asset IDs and source revisions, creation times, dimensions,
   type and original folder/album. Stream progress with processed, remaining,
   skipped and unavailable counts. A partial library must be labelled partial.
2. Decode oriented thumbnails in bounded batches. Cache by source ID, asset ID,
   edit revision and analyzer version. Compute once; later scans handle changes.
   Fetch large originals only when needed for confirmation or close comparison.
3. Detect exact copies separately using a content hash when bytes are available.
   A perceptual match is never labelled a byte-identical duplicate.
4. Find near-duplicate candidates with perceptual hashes, aspect ratio and
   capture-time/burst hints. Use a hash index or neighbor index; avoid comparing
   every full-resolution image with every other image. Search across dates too,
   so an edited/re-exported copy is not missed solely because its date changed.
5. Validate candidates with local image features, for example Apple's Vision
   feature prints, plus crop/geometry checks. Calibrate per analyzer revision.
   Similar subject matter alone must not join two distinct moments.
6. Form groups around a representative and enforce a maximum member distance.
   Avoid transitive chains where A resembles B and B resembles C, but A and C
   are different photos. Separate exact copies, edited variants and burst shots.
7. Suggest a keeper using measured sharpness, clipping/exposure and useful
   resolution. Show the reason. Personal expression and composition remain the
   user's choice. Do not claim blink/facial-quality detection unless implemented.

Vision feature prints and thumbnail caching are documented Apple building
blocks. Their accuracy and speed for this product still need evaluation. A
Vision distance is not a calibrated percentage of similarity. No cloud model
or image upload is required for the proposed default analysis.

### Review interaction

Entry: **Choose photos to keep**. Explain the source and scope, then scan.

The first view is a folder-like collection of groups: a small image stack,
date/source, number of photos and type of similarity. Offer source folder, date,
group type and review-status filters. Open one group into a large comparison
area; on a phone show one main image with a filmstrip and an explicit compare
action. Keep resolution, date and source reachable without crowding the images.

Inside a group:

- **Keep this** selects a keeper. Multiple selections are allowed.
- **Keep all** resolves the group without discarding a distinct moment.
- **Review later** leaves it unresolved, preserving a draft selection.
- A suggestion is labelled separately from the user's selection.
- **Save selection** records keeper IDs and leaves originals unchanged.

At the end show selected, unselected and unresolved items separately. Unselected
does not mean authorized for deletion. Initial delivery exports a decision
manifest and, optionally, copies the selected files to a new destination. A
future move/delete operation requires a concrete review and explicit user
instruction, revalidates asset revisions and respects Live Photo/RAW sidecars.
Do not empty Recently Deleted or promise storage savings from logical sizes.

The prototype at `prototypes/photo-review.html` demonstrates group navigation,
multi-selection, keeping a whole group, deferring, comparing two images and
exporting decisions. It uses illustrated fixture images and makes no detection
or real-library claim. Its choices are demo-only and are not persisted on reload.

### Job API proposal

`photo_scan(source_id, scope, sensitivity)` starts one local job and returns a
job ID. The UI receives incremental progress/groups; the agent can use a bounded
`photo_scan_wait(job_id)` instead of polling each asset. `photo_groups` pages
results, `photo_selection` updates asset IDs/revisions, and `photo_export` writes
the reviewed selection. Read-only analysis and media changes are distinct
operations. Cancellation stops new decoding and preserves a resumable index.

## 4. Sharper use cases

| Entry | Scope | Concrete output | Execution |
| --- | --- | --- | --- |
| Choose photos to keep | Chosen export/authorized photo selection | Similar-shot groups with keeper choices | Local media job + review |
| Find exact copies | Chosen export | Hash-confirmed duplicates, separate from similar shots | Existing report, then richer review |
| Make screenshots useful | Chosen album/date range | Groups for tickets, references, tasks; visible source links | Local OCR batch; approval for new tasks |
| Prepare receipts | Selected folder + period | Editable date/merchant/amount table with uncertain fields | Local OCR batch + focused review |
| Test this phone flow | Named app and test data | Reproducible steps, checkpoints and failure screen | Checked device workflow |
| Free up space | Storage screen + chosen source | Ranked, non-overlapping cleanup candidates | Bounded screen inspection |
| Review my week | Chosen calendars, next seven days | Conflicts and preparation list | Direct connector if available, UI fallback |
| Prepare a trip | Selected tickets, notes, events | Checklist with confirmed dates and missing information | Batch extraction + review |

Photo review, screenshots and app testing should lead the Device task ideas.
Each template must declare its source, scope, output and completion condition.
If the required media capability is absent, offer an export-folder path rather
than pretending a whole-library scan can be done through a handful of screens.
Keep the existing product templates accurate until the corresponding API ships.

## 5. Delivery and acceptance

1. Combined action/observation, caches, timing diagnostics and revised agent
   instructions. Test stop, expiry, rotation, disconnect, failed capture and
   repeated command IDs. Benchmark real Claude and Codex device loops.
2. Resident transport and guarded sequences, after native reconnection and
   cancellation tests. Keep unsupported transport capabilities explicit.
3. Folder photo source, incremental similarity analysis and review UI. Test
   transformed copies, unrelated lookalikes, bursts, crops, orientation,
   HEIC/JPEG, RAW/Live Photo associations, unreadable files and edited files.
4. Native PhotoKit source in the appropriate private native-app checkout, with
   limited/full/revoked permission and iCloud availability tests.

Measure 1k/10k-image fixtures on a named Mac: time to first useful group, total
scan time, peak memory, cancellation latency, cached rescans, pair precision and
recall against labelled examples. Proposed UX targets: initial progress within
one second, reviewable groups as soon as available, selection feedback within
100 ms and cancellation acknowledgement within one second. These are targets,
not measured performance claims. Set full-scan budgets after the first benchmark.

Shipping requires the normal release checks and the user's next-release
instruction. No current installation or live session needs to be restarted for
this preparation.

## Fable selection

Use Claude Code's documented `fable` alias in the static backend/frontend menus,
API family discovery and Claude launch alias handling. Let Claude resolve the
provider's model version and enforce account access. Keep existing defaults and
automatic escalation unchanged; adding a manual choice must not change costs
for existing sessions. No live paid model request is needed to test menu/argv
propagation, and that test alone cannot prove the account's model entitlement.

## Primary references checked

- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code supported model names](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)
- [PhotoKit asset fetching and authorization](https://developer.apple.com/documentation/photokit/fetching-assets)
- [PhotoKit thumbnail loading and caching](https://developer.apple.com/documentation/photokit/loading-and-caching-assets-and-thumbnails)
- [Vision image similarity with feature prints](https://developer.apple.com/documentation/vision/analyzing-image-similarity-with-feature-print)
