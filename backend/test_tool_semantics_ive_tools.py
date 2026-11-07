"""IVE's own MCP tools are records, not file writes: a memory note that
mentions a file name must not be refused by the file-lock guard."""
import unittest

from tool_semantics import COMMON_TOOL_SEMANTICS, classify_tool_call

NOTE = {
    "name": "live-acceptance-test-fixture",
    "type": "project",
    "content": "Source: labels.py, tested via python3 ./test_labels.py.",
}


class IveMcpToolTests(unittest.TestCase):
    def test_claude_memory_save_is_a_store(self):
        c = classify_tool_call("mcp__worker-board__save_memory", NOTE, tool_semantics=COMMON_TOOL_SEMANTICS)
        self.assertEqual(c.operation, "store")
        self.assertTrue(c.declared)
        self.assertEqual(c.target_for("file_path", "path"), "")

    def test_bare_tool_name_from_other_clis(self):
        self.assertEqual(classify_tool_call("save_memory", NOTE, tool_semantics=COMMON_TOOL_SEMANTICS).operation, "store")
        self.assertEqual(classify_tool_call("mcp__documentor__save_memory", NOTE).operation, "store")

    def test_memory_reads_stay_reads(self):
        self.assertEqual(classify_tool_call("mcp__worker-board__search_memory", {"query": "labels.py"}).operation, "read")
        self.assertEqual(classify_tool_call("mcp__worker-board__recall_memory", {"name": "x"}).operation, "read")

    def test_unknown_servers_keep_shape_detection(self):
        c = classify_tool_call("mcp__somebody__save_memory", {**NOTE, "file_path": "/tmp/a.md"})
        self.assertEqual(c.operation, "mutate")
        self.assertEqual(c.target_for("file_path"), "/tmp/a.md")
        c = classify_tool_call("mcp__other__write_file", {"file_path": "/tmp/a.md", "content": "x"})
        self.assertEqual(c.operation, "mutate")

    def test_native_file_tools_unchanged(self):
        c = classify_tool_call("Write", {"file_path": "/tmp/a.md", "content": "x"}, tool_semantics=COMMON_TOOL_SEMANTICS)
        self.assertEqual((c.operation, c.target_for("file_path")), ("mutate", "/tmp/a.md"))


if __name__ == "__main__":
    unittest.main()
