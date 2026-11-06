"""Observational pending requests, independent of open browser terminals.

This module never approves a command or writes to a PTY. Hook lifecycle events
are authoritative; terminal fallback requires a currently visible dialog footer.
"""
import re
import time

_TOOL_INPUT_KEYS = 8
_TOOL_INPUT_VALUE = 240


def _trim_tool_input(tool_input):
    """A compact copy of the tool input for the question card (never the
    whole file content of a Write)."""
    if not isinstance(tool_input, dict) or not tool_input:
        return None
    out = {}
    for key in list(tool_input.keys())[:_TOOL_INPUT_KEYS]:
        value = tool_input[key]
        if isinstance(value, str):
            out[key] = value[:_TOOL_INPUT_VALUE]
        elif value is None or isinstance(value, (bool, int, float)):
            out[key] = value
        else:
            out[key] = str(value)[:_TOOL_INPUT_VALUE]
    return out

_pending: dict[str, dict] = {}
_last_screen: dict[str, str] = {}
_resolved_screen: dict[str, str] = {}
# Hook questions and recognised menus: whether the CLI's dialog was seen on
# screen since the question arrived, and how many screens in a row showed no
# dialog since.
_dialog_seen: set[str] = set()
_dialog_missing: dict[str, int] = {}
# (menu identity, when) of a question answered from the Overview: the CLI may
# still draw that dialog for a moment, which must not raise it again.
_answered: dict[str, tuple] = {}
_ANSWERED_GRACE = 5.0
_MENU_TITLES = {"permission": "Permission needed", "plan": "Plan ready for your approval",
                "question": "Your answer is needed"}
_broadcast = None

# The CLI's own composer line: Claude's ❯ (placeholder after a NBSP) or
# Codex's ›, never a menu cursor in front of a numbered option.
_COMPOSER_RE = re.compile(r"(?m)^[^\S\r\n]*[❯>›](?:[^\S\r\n]|$)(?![^\S\r\n]*[0-9]+[.)])")
_MENU_CURSOR_RE = re.compile(r"(?m)^[^\S\r\n]*[❯›][^\S\r\n]*[0-9]+[.)]\s")


def set_broadcast_fn(fn):
    """Injected by server.py: how a resolved question reaches every client."""
    global _broadcast
    _broadcast = fn


def get_attention(session_id):
    value = _pending.get(session_id)
    return dict(value) if value else None


def clear_attention(session_id):
    _pending.pop(session_id, None)
    _last_screen.pop(session_id, None)
    _resolved_screen.pop(session_id, None)
    _forget_dialog(session_id)


def _forget_dialog(session_id):
    _dialog_seen.discard(session_id)
    _dialog_missing.pop(session_id, None)
    _answered.pop(session_id, None)


def _dialog_on_screen(session_id):
    _dialog_seen.add(session_id)
    _dialog_missing.pop(session_id, None)


def _with_menu(found, menu):
    """The question as the CLI draws it, attached to hook or terminal details."""
    found = dict(found)
    found["menu"] = menu
    if found.get("kind") != "configuration":
        found["kind"] = menu["kind"]
        found["title"] = _MENU_TITLES.get(menu["kind"], found.get("title"))
    return found


def details(data, source="hook"):
    context = str(data.get("context") or "")[-6000:]
    tool_input = data.get("tool_input") or {}
    operation = str(tool_input.get("command") or tool_input.get("cmd") or tool_input.get("file_path") or tool_input.get("path") or "")[:240] if isinstance(tool_input, dict) else ""
    message = str(data.get("reason") or data.get("message") or data.get("question") or operation)[:1200]
    compact = re.sub(r"\s+", "", message + context).lower()
    configuration = "safetygate" in compact and bool(re.search(r"missingapi_?key|notconfigured|classifierunavailable", compact))
    permission = configuration or data.get("tool_name") or re.search(r"permission|confirmation|proceed|approve", message, re.I)
    options = data.get("options")
    actions = data.get("actions")
    asked_at = data.get("asked_at")
    return {
        "kind": "configuration" if configuration else "permission" if permission else "question",
        "title": "Safety check needs setup" if configuration else "Permission needed" if permission else "Your answer is needed",
        "message": "The extra safety check is unavailable. Open Safety settings to fix its provider." if configuration else message or (f"Review the {data['tool_name']} request." if data.get("tool_name") else "The agent is waiting for your input."),
        "tool_name": data.get("tool_name") or "", "context": context, "source": source,
        # The question as data (backend.md 5.h.3): choices and keys from the
        # CLI notification, the trimmed tool input and when it was asked.
        "options": list(options) if isinstance(options, list) else [],
        "actions": list(actions) if isinstance(actions, list) else [],
        "notification_type": str(data.get("notification_type") or ""),
        "tool_input": _trim_tool_input(tool_input),
        "asked_at": float(asked_at) if isinstance(asked_at, (int, float)) else time.time(),
    }


def observe_event(event):
    sid = event.get("session_id")
    if not sid:
        return
    kind, state = event.get("type"), event.get("state")
    if ((kind == "session_state" and state == "prompting")
            or kind == "permission_question"
            or (kind == "permission_event" and event.get("phase") == "request")):
        found = details(event)
        found["origin"] = kind
        before = _pending.get(sid)
        # Claude reports one dialog twice, in either order: PermissionRequest
        # (tool_name, tool_input) and Notification (message). Keep both; the
        # question was asked when the first of them arrived.
        if before and before.get("source") == "hook" and {before.get("origin"), kind} == {"permission_event", "session_state"}:
            request, note = (found, before) if kind == "permission_event" else (before, found)
            found = dict(request)
            for key in ("message", "notification_type"):
                if note.get(key):
                    found[key] = note[key]
            found["asked_at"] = before["asked_at"]
            found["origin"] = "permission_event"
            if note.get("menu") and not found.get("menu"):
                found = _with_menu(found, note["menu"])
        # The dialog already read off the screen belongs to this question only
        # when it came without a tool (terminal detection) or names the same
        # tool: a new hook question for another tool gets its own dialog.
        if (before and before.get("menu") and not found.get("menu")
                and before.get("tool_name") in ("", found.get("tool_name"))):
            found = _with_menu(found, before["menu"])
        _pending[sid] = found
        _forget_dialog(sid)
        if found.get("menu"):
            _dialog_on_screen(sid)
    elif ((kind == "session_state" and state in {"working", "idle"})
          or (kind == "permission_event" and event.get("phase") == "denied")):
        _pending.pop(sid, None)
        _forget_dialog(sid)
        if sid in _last_screen:
            _resolved_screen[sid] = _last_screen[sid]


async def resolve(session_id, identity=None):
    """A guarded Overview reply reached the CLI: the question is answered.

    Drops the pending request unless another question (a different menu
    identity) has replaced it meanwhile, and broadcasts the clear that every
    client already applies for a finished hook question.
    """
    pending = _pending.get(session_id)
    if not pending:
        return False
    current = (pending.get("menu") or {}).get("identity") or pending.get("identity")
    if identity and current and identity != current:
        return False
    _pending.pop(session_id, None)
    _forget_dialog(session_id)
    if identity or current:
        _answered[session_id] = (identity or current, time.time())
    if session_id in _last_screen:
        _resolved_screen[session_id] = _last_screen[session_id]
    if _broadcast:
        await _broadcast({"type": "session_attention", "session_id": session_id, "attention": None})
    return True


def answered_recently(session_id, identity):
    """The Overview answered exactly this question moments ago and the CLI has
    not drawn anything else since: no second reply to the same dialog."""
    answered = _answered.get(session_id)
    return bool(answered and identity and answered[0] == identity and time.time() - answered[1] < _ANSWERED_GRACE)


def _dialog_footer(text):
    """(tail, compact tail, footer index) of a dialog that is on screen now."""
    tail = str(text or "")[-8000:]
    compact = re.sub(r"\s+", "", tail).lower()
    footer = compact.rfind("esctocancel")
    after = compact[footer:]
    if (footer < 0 or compact.rfind("esctointerrupt") > footer or len(after) > 260
            or re.search(r"interrupted|automodeon|bypasspermissions|shift\+tab|cogitated|workedfor", after)):
        return None
    return tail, compact, footer


def dialog_visible(text):
    """Any CLI dialog is on screen, including forms the terminal detector does
    not answer (AskUserQuestion). Plan approval has no "Esc to cancel" footer:
    its question plus a menu cursor count."""
    if _dialog_footer(text) is not None:
        return True
    tail = str(text or "")[-3000:]
    return "wouldyouliketoproceed" in re.sub(r"\s+", "", tail).lower() and bool(_MENU_CURSOR_RE.search(tail))


def detect_terminal_attention(text):
    footer = _dialog_footer(text)
    if not footer:
        return None
    tail, compact, at = footer
    before = compact[:at]
    if not re.search(r"doyouwanttoproceed|wouldyouliketorun|readytocode|requiresconfirmation|allowthis|approve", before[-2500:]):
        return None
    if not re.search(r"[12][.)]", before[-1500:]):
        return None
    return details({"message": "Review the request in the terminal.", "tool_name": "command", "context": tail[-5000:]}, "terminal")


def _composer_or_working(text):
    """The CLI is back at its composer or shows a running turn.

    The composer sits in the last rows (Claude: ❯ over its hint or status
    line; Codex: › over the model line). Claude also echoes the user's prompt
    as a ❯ line in the transcript, so only the last three rows count."""
    tail = str(text or "")[-3000:]
    if "esctointerrupt" in re.sub(r"\s+", "", tail).lower():
        return True
    last = [line for line in tail.splitlines() if line.strip()][-3:]
    return any(_COMPOSER_RE.match(line) for line in last)


def observe_terminal(session_id, text, menu=None):
    """A screen of the session: ``menu`` is what the server's dialog parser
    read from it (None when no complete dialog is on screen).

    A recognised menu is attention by itself, with the question as data; it is
    pushed once per question (identity), never per cursor move. Without a
    menu the footer regex is the fallback for cut-off dialogs. Returns whether
    the attention changed, i.e. whether clients need a push.
    """
    before = get_attention(session_id)
    _last_screen[session_id] = text
    if _resolved_screen.get(session_id) == text:
        return False
    _resolved_screen.pop(session_id, None)
    answered = _answered.get(session_id)
    if answered and (not menu or menu.get("identity") != answered[0]):
        _answered.pop(session_id, None)
    if menu:
        return _observe_menu(session_id, menu, text)
    _observe_screen(session_id, before, text)
    return before != get_attention(session_id)


def _observe_menu(session_id, menu, text):
    _dialog_on_screen(session_id)
    identity = menu.get("identity")
    pending = _pending.get(session_id)
    if pending and (pending.get("menu") or {}).get("identity") == identity:
        pending["menu"] = menu        # only the cursor moved: same question, no push
        return False
    answered = _answered.get(session_id)
    if answered and answered[0] == identity and time.time() - answered[1] < _ANSWERED_GRACE:
        return False                  # answered from the Overview; the CLI has not redrawn yet
    if pending and pending.get("source") == "hook":
        found = pending               # the hook's tool_name and tool_input stay
    else:
        found = details({"message": menu.get("question") or "", "context": text[-5000:]}, "terminal")
    _pending[session_id] = _with_menu(found, menu)
    return True


def _observe_screen(session_id, before, text):
    found = detect_terminal_attention(text)
    if before and before.get("menu"):
        # The recognised dialog is not on this frame: a half-drawn redraw, or
        # the dialog left or changed into one the parser cannot read. One
        # frame is tolerated unless the composer or a running turn shows.
        misses = _dialog_missing.get(session_id, 0) + 1
        if misses < 2 and not _composer_or_working(text):
            _dialog_missing[session_id] = misses
            return
        _dialog_missing.pop(session_id, None)
        if found or dialog_visible(text):
            if before.get("source") == "terminal" and found:
                _pending[session_id] = found
            else:
                _pending[session_id].pop("menu", None)
            return
        clear_attention(session_id)
        return
    if found:
        # Prefer structured context, except when the terminal explains a
        # configuration failure that the CLI's hook didn't include.
        if not before or before.get("source") == "terminal" or found["kind"] == "configuration":
            _pending[session_id] = found
        _dialog_on_screen(session_id)
    elif before and before.get("source") == "terminal":
        clear_attention(session_id)
    elif before and dialog_visible(text):
        _dialog_on_screen(session_id)
    elif before and session_id in _dialog_seen and text.strip():
        # The hook's dialog left the screen: answered or dismissed in the
        # terminal. A redraw can drop the footer for one frame, so require
        # the composer or a running turn, or two screens without the dialog.
        misses = _dialog_missing.get(session_id, 0) + 1
        if misses >= 2 or _composer_or_working(text):
            clear_attention(session_id)
        else:
            _dialog_missing[session_id] = misses
