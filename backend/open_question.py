"""Is a CLI dialog open on a session's live screen?

Every path that types into a PTY on IVE's behalf (task edits, worker
handoffs, commander nudges, W2W warnings, pipelines, idle reflection) asks
here first: text typed into an open permission or plan dialog answers it (a
digit selects and confirms). server.py injects the probe; without one nothing
is ever "open".
"""
import asyncio
import logging

logger = logging.getLogger(__name__)
_probe = None


def configure(probe):
    """``probe(session_id) -> bool``: server.py's dialog parser over the live screen."""
    global _probe
    _probe = probe


def session_has_open_question(session_id) -> bool:
    if _probe is None or not session_id:
        return False
    try:
        return bool(_probe(session_id))
    except Exception as exc:
        logger.debug("Open-question probe failed for %s: %s", str(session_id)[:8], exc)
        return False


async def wait_until_free(session_id, *, timeout: float = 30.0, interval: float = 5.0) -> bool:
    """True once no dialog is open; False when one is still open after ``timeout`` seconds."""
    waited = 0.0
    while session_has_open_question(session_id):
        if waited >= timeout:
            return False
        await asyncio.sleep(interval)
        waited += interval
    return True
