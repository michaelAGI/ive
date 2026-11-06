"""Codex turn boundaries, independent of hooks; bounded IO off the event loop.

Only complete JSONL records count. Assistant text (even final_answer) does
not prove the turn ended. Unchanged tails are cached, including large files.
"""
from collections import OrderedDict
from datetime import datetime
import json
from pathlib import Path
import threading

_TAIL_BYTES = 256 * 1024
_cache = OrderedDict()
_lock = threading.Lock()


def read_turn_boundary(path):
    path = Path(path)
    try:
        st = path.stat()
        key = (str(path), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        with _lock:
            if key in _cache:
                _cache.move_to_end(key)
                return _cache[key]
        with path.open("rb") as f:
            offset = max(0, st.st_size - _TAIL_BYTES)
            f.seek(offset)
            data = f.read(_TAIL_BYTES)
        lines = data.split(b"\n")[:-1]
        if offset:
            lines = lines[1:]
        boundary = None
        for line in lines:
            try:
                record = json.loads(line)
                payload = record.get("payload") or {}
                if record.get("type") != "event_msg" or not isinstance(payload, dict):
                    continue
                kind = payload.get("type")
                if kind not in {"task_started", "task_complete", "turn_aborted"}:
                    continue
                at = datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00")).timestamp()
                turn_id = payload.get("turn_id")
                if not turn_id:
                    continue
                if kind != "task_started" and boundary and boundary[0] == "task_started" and boundary[1] != turn_id:
                    continue
                boundary = (kind, turn_id, at)
            except (ValueError, TypeError, KeyError, AttributeError):
                continue
        with _lock:
            _cache[key] = boundary
            while len(_cache) > 32:
                _cache.popitem(last=False)
        return boundary
    except OSError:
        return None
