"""One-shot: new backstop cards go to Backlog, not Review.

The board-doc backstop files an [auto-triage] card for a session that went
idle without documenting itself. workspaces.board_doc_new_column picks the
column and defaulted to 'review', although the docstring always promised
'backlog'. Review is the column a person has to act on, so these cards looked
like finished work waiting for a decision.

The schema default is now 'backlog'. This migration moves workspace rows that
still hold 'review' in that column. The workspaces table has no updated_at
and workspace edits are not audited, so a row that kept the default cannot be
told apart from one where a person picked 'review' on purpose; every 'review'
row is migrated and the marker in app_settings records how many. Anyone who
wants Review back sets it once in the workspace settings; the marker keeps
later runs from touching it again. Cards already created in Review stay.
"""
from __future__ import annotations

MARKER = "_migr_board_doc_new_column_backlog_v1"
OLD_DEFAULT = "review"
NEW_DEFAULT = "backlog"


async def migrate_board_doc_new_column(db) -> dict | None:
    """Return counts when the migration ran, None when it already had."""
    cur = await db.execute("SELECT 1 FROM app_settings WHERE key = ?", (MARKER,))
    if await cur.fetchone() is not None:
        return None
    cur = await db.execute(
        "UPDATE workspaces SET board_doc_new_column = ? "
        "WHERE lower(trim(board_doc_new_column)) = ?",
        (NEW_DEFAULT, OLD_DEFAULT),
    )
    count = cur.rowcount if cur.rowcount is not None else 0
    await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
        (MARKER, f"workspaces={count}"),
    )
    return {"workspaces": count}
