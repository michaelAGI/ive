# Permission dialog fixtures

Real dialogs of Claude Code 2.1.310 and Codex 0.164.0, captured on 2026-10-25 with
`tools/capture_dialogs.py`: each CLI ran in a pseudo-terminal of 120x40 cells with a
throwaway config (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` under a scratch folder, IVE hooks
disabled, model haiku / default), got a scripted prompt, and the tool waited for the
dialog, then for 1.5 s of quiet output. `<name>.txt` holds every raw PTY byte received
since spawn (ANSI, CR), `<name>.screen.txt` the screen a user saw, rendered with pyte and
right-stripped. `manifest.json` lists each capture with `kind`, the `question`, the
option labels as the CLI prints them, `selected_index`, `cursor_glyph`, `footer` and
notes. Kinds map to the parser contract in `backend/server.py`
(`_session_permission_menu`): `permission` -> permission, `plan_approval` -> plan,
`ask_user_question` -> question; `startup_blocker`, `negative` and `probe` must give
no menu. `backend/test_prompt_menu_parser.py` renders every raw file at the manifest's
size and asserts the same result as for the `.screen.txt`.

To re-capture after a CLI update: `.venv/bin/python tools/capture_dialogs.py --scratch
/tmp/dlg --out backend/fixtures/permission_dialogs` (add `--only <scenario>` for one
scenario, `--list` for the names, `--reparse` to refresh manifest fields from existing
screens). A capture needs a logged-in Claude / Codex on this machine and runs them for
real: the scratch projects are created and deleted by the tool, nothing else is touched.
Keep the old files when a dialog changes shape; the parser must read both.

- `claude-trust`: first-run folder trust (unnumbered). Startup blocker, never a menu.
- `claude-bash`: Bash permission with four options, option 2 wraps over three lines.
- `claude-bash-after-digit-2`: the screen 0.5 s after pressing `2`: the digit selected and confirmed at once. Probe.
- `claude-create-file`: Write tool, "Do you want to create notes.txt?".
- `claude-edit-file`: Edit tool with a diff, "Do you want to make this edit to notes.txt?".
- `claude-fetch`: WebFetch, no footer line, "No, and tell Claude what to do differently (esc)".
- `claude-ask-single`: AskUserQuestion, one question, descriptions under the options, rule above "Chat about this".
- `claude-ask-multi`: AskUserQuestion with two questions, first tab (single select).
- `claude-ask-multi-q2`: second tab, multi-select with `[ ]` checkboxes. Recognised, `answerable` false.
- `claude-model-picker`, `claude-permissions`: `/model` and `/permissions`. Never a menu.
- `claude-plan-approval`: ExitPlanMode in `--permission-mode plan`, footer "ctrl+g to edit in Vim".
- `codex-trust`: Codex folder trust (numbered, `›` cursor). Startup blocker, never a menu.
- `codex-command`, `codex-network`, `codex-patch`: Codex approvals (command, network, file change); labels carry hotkeys, "Environment" and "Reason" lines sit between question and command.
- `codex-command-after-digit-2`: the screen after pressing `2`: approved and ran at once. Probe.
- `codex-model-picker`: Codex `/model`, cursor on the current model. Never a menu.
- `legacy-2.1.299/`: rendered screens (not raw bytes) of Claude 2.1.299 at 140 columns from 2026-10-14, plus `claude-tool-use-redraw.json`, the before/expected/after screens of a dialog that redrew while an Overview reply was in flight (409 `stale_session_prompt`).
