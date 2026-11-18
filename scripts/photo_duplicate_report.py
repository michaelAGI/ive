#!/usr/bin/env python3
"""Read-only SHA-256 duplicate report for an explicitly exported media folder.

Python 3.9+, no packages, models, network, shell commands or deletion. Never
operate on an Apple Photos library package. Similar images need human review
or a perceptual-image tool; this script finds byte-identical files only.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

MEDIA = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp',
         '.avif', '.bmp', '.dng', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.mov', '.mp4', '.m4v'}
LIBRARIES = {'.photoslibrary', '.photolibrary', '.aplibrary'}


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def open_media(root_fd, relative):
    """Resolve every path component without following symlinks, also after a scan."""
    parts = Path(relative).parts
    current = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = following
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
    finally:
        os.close(current)


def scan_folder(folder, max_files=100000):
    requested = Path(folder).expanduser()
    if requested.is_symlink():
        raise ValueError('Choose the real exported folder, not a symlink.')
    root = requested.resolve(strict=True)
    if not root.is_dir() or any(p.suffix.lower() in LIBRARIES for p in (root, *root.parents)):
        raise ValueError('Choose a folder of exported copies, outside the Apple Photos library.')
    by_size, seen, skipped = defaultdict(list), set(), defaultdict(int)
    errors, examined = [], 0
    def walk_error(error):
        errors.append({'path': str(error.filename or ''), 'reason': 'unreadable_directory'})
    # fwalk supplies directory descriptors, so a replaced path cannot escape
    # the selected tree. A second descriptor-based check protects hashing.
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for directory, dirs, files, directory_fd in os.fwalk('.', dir_fd=root_fd, follow_symlinks=False, onerror=walk_error):
            keep = []
            for name in sorted(dirs):
                if Path(name).suffix.lower() in LIBRARIES:
                    skipped['photo_libraries'] += 1
                elif stat.S_ISLNK(os.stat(name, dir_fd=directory_fd, follow_symlinks=False).st_mode):
                    skipped['symlinks'] += 1
                else:
                    keep.append(name)
            dirs[:] = keep
            for name in sorted(files):
                examined += 1
                if examined > max_files:
                    raise ValueError(f'The folder exceeds {max_files} files; choose a smaller export.')
                relative = str(Path(directory) / name)
                try:
                    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        skipped['symlinks'] += 1
                    elif not stat.S_ISREG(info.st_mode) or Path(name).suffix.lower() not in MEDIA:
                        skipped['other_files'] += 1
                    elif not info.st_size:
                        skipped['empty_files'] += 1
                    elif (info.st_dev, info.st_ino) in seen:
                        skipped['hardlinks'] += 1
                    else:
                        seen.add((info.st_dev, info.st_ino))
                        by_size[info.st_size].append((relative, snapshot(info)))
                except OSError:
                    errors.append({'path': relative, 'reason': 'unreadable_or_changed'})
        groups, hashed = [], 0
        for size, candidates in sorted(by_size.items()):
            if len(candidates) < 2:
                continue
            hashes = defaultdict(list)
            for relative, original in candidates:
                try:
                    with os.fdopen(open_media(root_fd, relative), 'rb') as handle:
                        info = os.fstat(handle.fileno())
                        if not stat.S_ISREG(info.st_mode) or snapshot(info) != original:
                            raise ValueError('changed')
                        digest, remaining = hashlib.sha256(), size
                        while remaining:
                            block = handle.read(min(1024 * 1024, remaining))
                            if not block:
                                raise ValueError('changed')
                            digest.update(block)
                            remaining -= len(block)
                        if handle.read(1) or snapshot(os.fstat(handle.fileno())) != original:
                            raise ValueError('changed')
                    hashes[digest.hexdigest()].append(relative)
                    hashed += 1
                except (OSError, ValueError):
                    errors.append({'path': relative, 'reason': 'unreadable_or_changed'})
            groups.extend({'sha256': digest, 'file_bytes': size, 'files': sorted(paths),
                           'redundant_file_bytes': size * (len(paths) - 1)}
                          for digest, paths in hashes.items() if len(paths) > 1)
    finally:
        os.close(root_fd)
    groups.sort(key=lambda group: (-group['redundant_file_bytes'], group['files'][0]))
    return {'schema': 1, 'method': 'sha256-byte-identical', 'folder': str(root),
            'scan_complete': not errors, 'media_files': len(seen), 'hashed_files': hashed,
            'duplicate_groups': len(groups), 'redundant_files': sum(len(g['files']) - 1 for g in groups),
            'redundant_file_bytes': sum(g['redundant_file_bytes'] for g in groups),
            'note': 'Report only. No files changed. Redundant file bytes are not guaranteed free disk space; '
                    'APFS clones, Live Photos, albums and cloud copies need separate review. '
                    'Similar-looking or re-encoded images are not detected.',
            'groups': groups, 'skipped': dict(skipped), 'errors': errors}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path, help='Explicitly exported media folder (never a Photos library)')
    parser.add_argument('--output', type=Path, help='New JSON report file; an existing file is never overwritten')
    args = parser.parse_args(argv)
    try:
        report = scan_folder(args.folder)
        content = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        if args.output:
            with args.output.open('x', encoding='utf-8') as handle:
                handle.write(content)
            print(f'Report saved: {args.output}')
        else:
            print(content, end='')
        return 0 if report['scan_complete'] else 2
    except (ValueError, OSError) as exc:
        print(f'No changes made to media: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
