import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import photo_duplicate_report as report


class DuplicateReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'export'
        self.root.mkdir()
    def write(self, name, content=b'image-data'):
        path = self.root / name
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(content)
        return path
    def test_reports_exact_copies_but_not_equal_size_different_images(self):
        self.write('original.HEIC')
        self.write('nested/copy.heic')
        self.write('different.jpg', b'other-data')
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = report.scan_folder(self.root)
        self.assertEqual(result['duplicate_groups'], 1)
        self.assertEqual(result['groups'][0]['files'], ['nested/copy.heic', 'original.HEIC'])
        self.assertEqual(result['redundant_file_bytes'], 10)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
    def test_does_not_follow_symlinks_or_count_hardlinks_as_savings(self):
        original = self.write('original.jpg')
        os.link(original, self.root / 'hardlink.jpg')
        (self.root / 'link.jpg').symlink_to(original)
        external = Path(self.temp.name) / 'outside'
        external.mkdir()
        (external / 'copy.jpg').write_bytes(original.read_bytes())
        (self.root / 'outside').symlink_to(external, target_is_directory=True)
        value = report.scan_folder(self.root)
        self.assertEqual(value['duplicate_groups'], 0)
        self.assertEqual(value['skipped']['symlinks'], 2)
        self.assertEqual(value['skipped']['hardlinks'], 1)
    def test_refuses_and_skips_photos_libraries(self):
        library = self.root / 'Photos.photoslibrary'
        library.mkdir()
        (library / 'copy.jpg').write_bytes(b'image-data')
        self.write('original.jpg')
        self.assertEqual(report.scan_folder(self.root)['skipped']['photo_libraries'], 1)
        with self.assertRaises(ValueError): report.scan_folder(library)
        (library / 'originals').mkdir()
        with self.assertRaises(ValueError): report.scan_folder(library / 'originals')
    def test_changed_file_is_not_a_confirmed_duplicate(self):
        self.write('original.jpg')
        changed = self.write('copy.jpg')
        original_open = report.open_media
        def mutate(fd, path):
            if path == 'copy.jpg': changed.write_bytes(b'changed!!!')
            return original_open(fd, path)
        with patch.object(report, 'open_media', side_effect=mutate):
            value = report.scan_folder(self.root)
        self.assertFalse(value['scan_complete'])
        self.assertEqual(value['duplicate_groups'], 0)
    def test_output_is_json_and_never_overwrites(self):
        self.write('a.jpg')
        self.write('b.jpg')
        output = Path(self.temp.name) / 'report.json'
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(report.main([str(self.root), '--output', str(output)]), 0)
            before = output.read_bytes()
            self.assertEqual(report.main([str(self.root), '--output', str(output)]), 1)
        self.assertEqual(output.read_bytes(), before)
        self.assertEqual(json.loads(before)['duplicate_groups'], 1)
    def test_scan_limit_does_not_produce_false_complete_result(self):
        self.write('a.jpg')
        self.write('b.jpg')
        with self.assertRaises(ValueError): report.scan_folder(self.root, max_files=1)


if __name__ == '__main__':
    unittest.main()
