#!/usr/bin/env python3
"""Package the FINAL notarized app for Tauri updates. Never publishes anything."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def verify_app(app):
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app))
    run('/usr/bin/xcrun', 'stapler', 'validate', str(app))
    run('/usr/sbin/spctl', '--assess', '--type', 'execute', str(app))
    details = run('/usr/bin/codesign', '-dv', str(app)).stderr
    if 'TeamIdentifier=66Y43UAY3C' not in details or 'Authority=Developer ID Application:' not in details:
        raise ValueError('The app must carry the IVE Developer ID signature.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--key', type=Path, default=Path.home()/'.config/ive/updater/release.key')
    parser.add_argument('--notes', type=Path, required=True)
    args = parser.parse_args()
    app = args.app.resolve()
    if app.name != 'IVE.app': raise ValueError('Expected the final IVE.app.')
    verify_app(app)
    info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
    config = json.loads((ROOT/'frontend/src-tauri/tauri.conf.json').read_text())
    version = info['CFBundleShortVersionString']
    if info['CFBundleIdentifier'] != 'com.ive.desktop' or version != config['version']:
        raise ValueError('Bundle identity/version does not match this checkout.')
    arch = run('/usr/bin/lipo', '-archs', str(app/'Contents/MacOS'/info['CFBundleExecutable'])).stdout.strip()
    if arch != 'arm64': raise ValueError('This release supports Apple Silicon only.')
    public = args.key.with_suffix(args.key.suffix+'.pub')
    if public.read_text().strip() != config['plugins']['updater']['pubkey']:
        raise ValueError('Signing key does not match the public key in the app configuration.')
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output/'IVE-macOS-arm64.app.tar.gz'
    if archive.exists() or (args.output/'latest.json').exists(): raise ValueError('Refusing to overwrite existing updater artifacts.')
    # No AppleDouble entries: Tauri expects a single app folder as archive root.
    run('/usr/bin/tar', '-czf', str(archive.resolve()), '-C', str(app.parent), app.name,
        env={**os.environ, 'COPYFILE_DISABLE': '1'})
    with tempfile.TemporaryDirectory(prefix='ive-updater-verify-') as directory:
        run('/usr/bin/tar', '-xzf', str(archive.resolve()), '-C', directory)
        verify_app(Path(directory)/'IVE.app')
    signer = ROOT/'frontend/node_modules/.bin/tauri'
    run(str(signer), 'signer', 'sign', '--private-key-path', str(args.key), '--app-version', version, str(archive.resolve()), stdin=subprocess.DEVNULL)
    signature = archive.with_suffix(archive.suffix+'.sig').read_text().strip()
    # Catch old CLIs that do not bind the signed version before writing the feed.
    decoded = base64.b64decode(signature).decode()
    if f'version:{version}' not in decoded:
        raise ValueError('The updater signature does not bind the app version. Use the current Tauri CLI.')
    manifest = {
        'version': version, 'notes': args.notes.read_text().strip(),
        'pub_date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'platforms': {'darwin-aarch64': {
            'signature': signature,
            'url': f'https://github.com/michaelAGI/ive/releases/download/v{version}/{archive.name}',
        }},
    }
    (args.output/'latest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix+'.sha256').write_text(f'{digest}  {archive.name}\n')
    print(f'Updater bundle and latest.json ready for IVE {version}; signature and extracted Apple ticket checked.')

if __name__ == '__main__': main()
