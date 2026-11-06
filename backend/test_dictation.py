"""On-device dictation: install bookkeeping, verified downloads and the worker protocol, without mlx.

Run from backend/:  python -m unittest test_dictation
The numpy-dependent checks (mel filterbank, resampler) are skipped when numpy is not
installed in the interpreter running the tests."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

import dictation

HERE = Path(__file__).resolve().parent

FAKE_WORKER = textwrap.dedent('''
    import json, struct, sys, time
    def emit(o):
        sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
    def read(n):
        out = b""
        while len(out) < n:
            part = sys.stdin.buffer.read(n - len(out))
            if not part: return None
            out += part
        return out
    args = sys.argv[1:]
    time.sleep(0.3)   # pretend to load the model
    emit({"ev": "ready", "load_ms": 300, "context": args[args.index("--context") + 1] if "--context" in args else None})
    received = 0; stream = None
    while True:
        head = read(5)
        if head is None: break
        kind, (length,) = head[:1], struct.unpack(">I", head[1:5])
        payload = read(length) if length else b""
        if kind == b"A":
            received += len(payload); emit({"ev": "interim", "text": f"heard {received}"})
        elif kind == b"J":
            msg = json.loads(payload)
            if msg["op"] == "start":
                stream = msg["stream"]; received = 0; emit({"ev": "started", "stream": stream, "rate": msg.get("sample_rate")})
            elif msg["op"] == "stop":
                emit({"ev": "final", "text": " hello"}); emit({"ev": "done", "stream": stream, "text": f" world {received}", "seconds": received / 32000})
                stream = None
            elif msg["op"] == "abort":
                emit({"ev": "aborted", "stream": stream}); stream = None
            elif msg["op"] == "exit":
                break
''')


def run(coro):
    return asyncio.run(coro)


class SupportTests(unittest.TestCase):
    def test_apple_silicon_macos_14_is_supported(self):
        with patch.object(dictation.sys, 'platform', 'darwin'), \
             patch.object(dictation.platform, 'machine', return_value='arm64'), \
             patch.object(dictation.platform, 'mac_ver', return_value=('15.1', ('', '', ''), '')):
            self.assertEqual(dictation.support(), (True, ''))

    def test_intel_and_old_macos_are_refused(self):
        with patch.object(dictation.sys, 'platform', 'darwin'), \
             patch.object(dictation.platform, 'machine', return_value='x86_64'):
            ok, reason = dictation.support()
            self.assertFalse(ok); self.assertIn('Apple silicon', reason)
        with patch.object(dictation.sys, 'platform', 'darwin'), \
             patch.object(dictation.platform, 'machine', return_value='arm64'), \
             patch.object(dictation.platform, 'mac_ver', return_value=('13.6', ('', '', ''), '')):
            ok, reason = dictation.support()
            self.assertFalse(ok); self.assertIn('macOS 14', reason)
        with patch.object(dictation.sys, 'platform', 'linux'):
            self.assertFalse(dictation.support()[0])


class PinsTests(unittest.TestCase):
    def test_requirements_lock_is_hash_pinned(self):
        text = (HERE / 'dictation-requirements.txt').read_text()
        names = re.findall(r'^([a-z][a-z0-9-]*)==', text, re.M)
        self.assertEqual(sorted(set(names)), ['dacite', 'mlx', 'mlx-metal', 'numpy', 'parakeet-mlx'])
        for block in re.split(r'\n(?=[a-z])', text.split('\n\n', 1)[1].strip()):
            self.assertIn('--hash=sha256:', block, block.splitlines()[0])
        self.assertIn('numpy==2.5.4 ; python_version >= "3.12"', text)
        self.assertIn('numpy==2.3.5 ; python_version < "3.12"', text)

    def test_model_pins_are_complete(self):
        self.assertEqual(set(dictation.MODEL_FILES), {'config.json', 'model.safetensors'})
        for name, (sha, size) in dictation.MODEL_FILES.items():
            self.assertRegex(sha, r'^[0-9a-f]{64}$'); self.assertGreater(size, 0)
        self.assertRegex(dictation.MODEL_REVISION, r'^[0-9a-f]{40}$')
        self.assertNotIn('.bin', ' '.join(dictation.MODEL_FILES))

    def test_python_runtime_matches_packaging_pin(self):
        source = HERE.parent / 'packaging' / 'prepare-python.py'
        if not source.is_file():
            self.skipTest('packaging/ is not part of this checkout')
        text = source.read_text()
        self.assertIn(f"VERSION = '{dictation.PYTHON_VERSION}'", text)
        self.assertIn(f"RELEASE = '{dictation.PYTHON_RELEASE}'", text)
        self.assertIn(f"SHA256 = '{dictation.PYTHON_SHA256}'", text)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'dictation'
        self.rt = dictation.DictationRuntime(self.root, frozen=False, interpreter=sys.executable)
        self.supported = patch.object(dictation, 'support', return_value=(True, ''))
        self.supported.start()

    def tearDown(self):
        self.supported.stop()
        self.tmp.cleanup()

    def fake_install(self, rt=None):
        rt = rt or self.rt
        interpreter = rt.interpreter()
        interpreter.parent.mkdir(parents=True, exist_ok=True)
        interpreter.write_text('#!/bin/sh\n')
        rt.packages_marker.write_text(json.dumps({'lock_sha256': rt.requirements_sha256(), 'interpreter': str(interpreter)}))
        rt.model_dir.mkdir(parents=True, exist_ok=True)
        files = {}
        for name, (sha, size) in dictation.MODEL_FILES.items():
            with (rt.model_dir / name).open('wb') as handle:
                handle.truncate(size)
            files[name] = sha
        rt.model_marker.write_text(json.dumps({'revision': dictation.MODEL_REVISION, 'files': files}))

    def test_not_installed_until_every_part_is_verified(self):
        self.assertEqual(self.rt.state(), 'not_installed')
        self.fake_install()
        self.assertEqual(self.rt.state(), 'ready')
        status = self.rt.status()
        self.assertEqual(status['installed'], {'python': True, 'packages': True, 'model': True})
        self.assertFalse(status['worker']['running'])
        # A changed lock invalidates the packages, a wrong size invalidates the model.
        self.rt.packages_marker.write_text(json.dumps({'lock_sha256': 'stale', 'interpreter': str(self.rt.interpreter())}))
        self.assertEqual(self.rt.state(), 'not_installed')
        self.fake_install()
        with (self.rt.model_dir / 'config.json').open('ab') as handle:
            handle.write(b'x')
        self.assertFalse(self.rt.model_ok())

    def test_frozen_layout_uses_the_downloaded_runtime(self):
        rt = dictation.DictationRuntime(self.root, frozen=True)
        self.assertEqual(rt.interpreter(), self.root / 'python' / 'python' / 'bin' / 'python3')
        self.assertGreater(rt.status()['download_bytes'], self.rt.status()['download_bytes'])

    def test_unsupported_wins(self):
        self.supported.stop()
        with patch.object(dictation, 'support', return_value=(False, 'nope')):
            self.fake_install()
            self.assertEqual(self.rt.state(), 'unsupported')
            with self.assertRaises(RuntimeError):
                self.rt.start_install()
        self.supported.start()


class DownloadTests(unittest.TestCase):
    """A local HTTP server with Range support stands in for huggingface.co / GitHub."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.payload = os.urandom(300_000)
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.requests = []

    def tearDown(self):
        self.tmp.cleanup()

    def app(self):
        async def handler(request):
            self.requests.append(request.headers.get('Range'))
            data = self.payload
            if request.headers.get('Range'):
                start = int(request.headers['Range'].split('=')[1].rstrip('-'))
                return web.Response(body=data[start:], status=206, headers={'Content-Length': str(len(data) - start)})
            return web.Response(body=data, headers={'Content-Length': str(len(data))})
        app = web.Application()
        app.router.add_get('/file', handler)
        return app

    def test_download_checks_size_and_sha_and_resumes(self):
        async def scenario():
            server = TestServer(self.app())
            await server.start_server()
            try:
                url = str(server.make_url('/file'))
                rt = dictation.DictationRuntime(self.root / 'd', frozen=False)
                rt.root.mkdir()
                dest = rt.root / 'blob.bin'
                # Resume: half of the file is already on disk.
                part = dest.with_name('blob.bin.part')
                part.write_bytes(self.payload[:100_000])
                await rt._download(url, dest, expected_sha=self.sha, expected_size=len(self.payload), step='model', detail='blob')
                self.assertEqual(dest.read_bytes(), self.payload)
                self.assertFalse(part.exists())
                self.assertEqual(self.requests[-1], 'bytes=100000-')
                # Wrong checksum: the file is discarded and reported.
                with self.assertRaisesRegex(RuntimeError, 'checksum'):
                    await rt._download(url, rt.root / 'other.bin', expected_sha='0' * 64, step='model', detail='other')
                self.assertFalse((rt.root / 'other.bin').exists())
                self.assertFalse((rt.root / 'other.bin.part').exists())
                # Cancellation stops the stream.
                rt._cancel = True
                with self.assertRaises(dictation.InstallCancelled):
                    await rt._download(url, rt.root / 'third.bin', expected_sha=self.sha, step='model', detail='third')
            finally:
                await server.close()
        run(scenario())


class StreamTests(unittest.TestCase):
    """The WebSocket handler against a fake worker that speaks the real protocol."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'dictation'
        self.root.mkdir()
        self.worker = self.root / 'fake_worker.py'
        self.worker.write_text(FAKE_WORKER)
        self.rt = dictation.DictationRuntime(self.root, frozen=False, interpreter=sys.executable)
        self.rt.worker_script = self.worker
        self.rt.interpreter = lambda: Path(sys.executable)
        self.rt.state = lambda: 'ready'

    def tearDown(self):
        self.tmp.cleanup()

    def server(self):
        app = web.Application()
        app.router.add_get('/api/dictation/stream', self.rt.stream_handler)
        app.router.add_get('/api/dictation/status', self.rt.status_handler)
        return TestServer(app)

    async def collect(self, ws):
        events = []
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                events.append(json.loads(msg.data))
            else:
                break
        return events

    def test_audio_sent_while_loading_is_transcribed_and_done_closes(self):
        async def scenario():
            server = self.server()
            await server.start_server()
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(server.make_url('/api/dictation/stream')) as ws:
                        await ws.send_json({'type': 'start', 'sample_rate': 16000})
                        for _ in range(3):
                            await ws.send_bytes(b'\x00\x01' * 1600)  # 3 × 3200 bytes before "ready"
                        await asyncio.sleep(0.6)
                        await ws.send_bytes(b'\x00\x01' * 1600)
                        await ws.send_json({'type': 'stop'})
                        events = await self.collect(ws)
                types = [e['type'] for e in events]
                self.assertEqual(types[0], 'status')
                self.assertIn('ready', types)
                self.assertEqual(types[-1], 'done')
                self.assertEqual(events[-1]['text'], ' world 12800')
                self.assertIn({'type': 'final', 'text': ' hello'}, events)
                self.assertTrue(any(e['type'] == 'interim' for e in events))
                self.assertIsNone(self.rt._stream)
                self.assertTrue(self.rt.worker_alive(), 'the worker stays warm for the next dictation')
                self.assertEqual(self.rt._worker_info['context'], dictation.DEFAULT_CONTEXT)
                # Second stream reuses the warm worker (no new "load" wait).
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(server.make_url('/api/dictation/stream')) as ws:
                        await ws.send_json({'type': 'start'})
                        await ws.send_bytes(b'\x00' * 3200)
                        await ws.send_json({'type': 'stop'})
                        events = await self.collect(ws)
                self.assertEqual(events[-1], {'type': 'done', 'text': ' world 3200', 'seconds': 0.1})
                await self.rt.stop_worker()
                self.assertFalse(self.rt.worker_alive())
            finally:
                await self.rt.shutdown()
                await server.close()
        run(scenario())

    def test_second_concurrent_stream_is_refused_with_fallback(self):
        async def scenario():
            server = self.server()
            await server.start_server()
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(server.make_url('/api/dictation/stream')) as first:
                        await first.send_json({'type': 'start'})
                        async with session.ws_connect(server.make_url('/api/dictation/stream')) as second:
                            events = await self.collect(second)
                        self.assertEqual(events[0]['type'], 'error')
                        self.assertTrue(events[0]['fallback'])
                        await first.send_json({'type': 'abort'})
                        await self.collect(first)
                await asyncio.sleep(0.1)
                self.assertIsNone(self.rt._stream)
            finally:
                await self.rt.shutdown()
                await server.close()
        run(scenario())

    def test_not_ready_reports_fallback(self):
        async def scenario():
            self.rt.state = lambda: 'not_installed'
            server = self.server()
            await server.start_server()
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(server.make_url('/api/dictation/stream')) as ws:
                        events = await self.collect(ws)
                self.assertEqual(events, [{'type': 'error', 'error': 'On-device dictation is not installed.', 'fallback': True}])
            finally:
                await server.close()
        run(scenario())

    def test_oversized_frame_ends_the_stream(self):
        async def scenario():
            server = self.server()
            await server.start_server()
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(server.make_url('/api/dictation/stream')) as ws:
                        await ws.send_json({'type': 'start'})
                        await ws.send_bytes(b'\x00' * (dictation.MAX_WS_FRAME + 2))
                        events = await self.collect(ws)
                self.assertEqual(events[-1]['type'], 'error')
                self.assertIn('too large', events[-1]['error'])
            finally:
                await self.rt.shutdown()
                await server.close()
        run(scenario())


class FrameTests(unittest.TestCase):
    def test_frame_layout(self):
        self.assertEqual(dictation.frame(b'J', b'{}'), b'J\x00\x00\x00\x02{}')


@unittest.skipUnless(__import__('importlib').util.find_spec('numpy'), 'numpy not installed')
class WorkerMathTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        import dictation_worker
        self.np = np
        self.worker = dictation_worker

    def test_mel_filterbank_matches_librosa(self):
        try:
            import librosa
        except ImportError:
            self.skipTest('librosa not installed')
        np = self.np
        for sr, n_fft, n_mels in [(16000, 512, 128), (16000, 400, 80), (22050, 1024, 64)]:
            ours = self.worker.mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=0, fmax=sr / 2, norm='slaney')
            theirs = librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=0, fmax=sr / 2, norm='slaney')
            self.assertTrue(np.allclose(ours, theirs, rtol=1e-6, atol=1e-8), (sr, n_fft, n_mels))

    def test_mel_filterbank_shape_and_normalisation(self):
        np = self.np
        bank = self.worker.mel_filterbank(sr=16000, n_fft=512, n_mels=128, fmin=0, fmax=8000)
        self.assertEqual(bank.shape, (128, 257))
        self.assertEqual(bank.dtype, np.float32)
        self.assertTrue((bank >= 0).all())
        self.assertTrue((bank.sum(axis=1) > 0).all())

    def test_resampler_is_continuous_across_chunks(self):
        np = self.np
        t = np.arange(48000) / 48000
        signal = np.sin(2 * np.pi * 440 * t).astype(np.float32)
        resampler = self.worker.LinearResampler(48000, 16000)
        chunks = [resampler.process(signal[i:i + 1000]) for i in range(0, len(signal), 1000)]
        out = np.concatenate(chunks)
        reference = np.interp(np.arange(0, len(signal) - 1, 3.0), np.arange(len(signal)), signal)
        self.assertEqual(len(out), len(reference))
        self.assertTrue(np.allclose(out, reference, atol=1e-5))

    def test_frames_and_pcm(self):
        import io
        payload = json.dumps({'op': 'ping'}).encode()
        stream = io.BytesIO(dictation.frame(b'J', payload) + dictation.frame(b'A', b'\x00\x80\xff\x7f'))
        self.assertEqual(self.worker.read_frame(stream), (b'J', payload))
        kind, audio = self.worker.read_frame(stream)
        self.assertEqual(kind, b'A')
        samples = self.worker.pcm16_to_float(audio)
        self.assertAlmostEqual(float(samples[0]), -1.0)
        self.assertAlmostEqual(float(samples[1]), 32767 / 32768)
        self.assertIsNone(self.worker.read_frame(stream))
        self.assertEqual(self.worker.parse_context('256,256'), (256, 256))
        with self.assertRaises(ValueError):
            self.worker.parse_context('0,1')


if __name__ == '__main__':
    unittest.main()
