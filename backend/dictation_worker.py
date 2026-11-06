#!/usr/bin/env python3
"""IVE dictation worker: on-device speech-to-text with NVIDIA Parakeet TDT 0.6B v3.

backend/dictation.py launches this script inside the dictation runtime, a separate
interpreter that has mlx. The worker imports nothing from the backend, never opens
the network and never writes audio to disk. One stream at a time.

Protocol on stdin, binary frames: kind (1 byte) + payload length (4 bytes, big-endian) + payload.
  b"J"  JSON control  {"op": "start", "stream": "<id>", "sample_rate": 16000}
                      {"op": "stop"}    finalize the stream and emit "done"
                      {"op": "abort"}   drop the stream without a result
                      {"op": "ping"}    answers "pong"
                      {"op": "exit"}
  b"A"  audio: mono int16 little-endian PCM at the stream's sample rate
Events on stdout, one JSON object per line:
  {"ev": "ready", "load_ms": n}      the model is loaded and warmed up
  {"ev": "started", "stream": id}
  {"ev": "interim", "text": s}       current draft; may still change
  {"ev": "final", "text": s}         text that will not change any more (ends on a word boundary)
  {"ev": "done", "text": s}          text after the last "final" once the stream stopped
  {"ev": "aborted"}
  {"ev": "error", "error": s}
  {"ev": "pong"}
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import types

import numpy as np

TARGET_RATE = 16000
CHUNK_SECONDS = 0.5      # audio per encoder step
TAIL_SECONDS = 0.6       # silence appended on stop so the last words leave the draft window
MAX_FRAME_BYTES = 4 * 1024 * 1024


# ─── Mel filterbank (replaces librosa.filters.mel for the Slaney scale) ─────────
# parakeet-mlx only uses librosa for this one function. librosa pulls in numba,
# scipy and scikit-learn, which is more than the runtime should download. The
# formulas below are the Slaney mel scale and Slaney normalisation; the output
# matches librosa.filters.mel(htk=False, norm="slaney") to float32 rounding
# (verified in backend/test_dictation.py when librosa is installed).

def _hz_to_mel(frequencies):
    frequencies = np.asanyarray(frequencies, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = frequencies / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    if frequencies.ndim:
        log_t = frequencies >= min_log_hz
        mels[log_t] = min_log_mel + np.log(frequencies[log_t] / min_log_hz) / logstep
    elif frequencies >= min_log_hz:
        mels = min_log_mel + np.log(frequencies / min_log_hz) / logstep
    return mels


def _mel_to_hz(mels):
    mels = np.asanyarray(mels, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = f_sp * mels
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    if mels.ndim:
        log_t = mels >= min_log_mel
        freqs[log_t] = min_log_hz * np.exp(logstep * (mels[log_t] - min_log_mel))
    elif mels >= min_log_mel:
        freqs = min_log_hz * np.exp(logstep * (mels - min_log_mel))
    return freqs


def mel_filterbank(*, sr, n_fft, n_mels=128, fmin=0.0, fmax=None, htk=False, norm="slaney", dtype=np.float32):
    if htk or norm != "slaney":
        raise ValueError("only the Slaney mel scale with Slaney normalisation is implemented")
    if fmax is None:
        fmax = float(sr) / 2
    n_mels = int(n_mels)
    weights = np.zeros((n_mels, int(1 + n_fft // 2)), dtype=np.float64)
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2 : n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, np.newaxis]
    return weights.astype(dtype)


def install_stubs() -> None:
    """Provide the two optional imports of parakeet-mlx when the runtime lacks them."""
    try:
        import librosa  # noqa: F401
    except ImportError:
        librosa = types.ModuleType("librosa")
        filters = types.ModuleType("librosa.filters")
        filters.mel = mel_filterbank
        librosa.filters = filters
        sys.modules["librosa"] = librosa
        sys.modules["librosa.filters"] = filters
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        hub = types.ModuleType("huggingface_hub")

        def hf_hub_download(*args, **kwargs):
            # parakeet_mlx.from_pretrained falls back to the local directory
            # when this raises; the backend downloads and verifies the files.
            raise RuntimeError("downloads are disabled in the dictation worker")

        hub.hf_hub_download = hf_hub_download
        sys.modules["huggingface_hub"] = hub


# ─── Audio helpers ──────────────────────────────────────────────────────────────

def pcm16_to_float(payload: bytes) -> np.ndarray:
    return np.frombuffer(payload[: len(payload) - len(payload) % 2], dtype="<i2").astype(np.float32) / 32768.0


class LinearResampler:
    """Chunk-wise linear interpolation that stays continuous across chunk borders."""

    def __init__(self, source_rate: int, target_rate: int = TARGET_RATE) -> None:
        self.ratio = source_rate / target_rate
        self.prev: float | None = None
        self.phase = 0.0

    def process(self, pcm: np.ndarray) -> np.ndarray:
        if len(pcm) == 0:
            return pcm
        source = pcm if self.prev is None else np.concatenate([np.array([self.prev], dtype=np.float32), pcm])
        n = len(source)
        positions = np.arange(self.phase, n - 1, self.ratio) if n > 1 else np.zeros(0)
        out = np.interp(positions, np.arange(n), source).astype(np.float32) if len(positions) else np.zeros(0, np.float32)
        next_position = positions[-1] + self.ratio if len(positions) else self.phase
        self.phase = next_position - (n - 1)
        self.prev = float(source[-1])
        return out


def token_text(tokens) -> str:
    return "".join(token.text for token in tokens)


# ─── Streaming session ──────────────────────────────────────────────────────────

class Stream:
    def __init__(self, model, mx, stream_id: str, sample_rate: int, context: tuple[int, int], depth: int) -> None:
        self.id = stream_id
        self.mx = mx
        self.resampler = LinearResampler(sample_rate) if sample_rate != TARGET_RATE else None
        self.context = model.transcribe_stream(context_size=context, depth=depth)
        self.transcriber = self.context.__enter__()
        self.pending = np.zeros(0, dtype=np.float32)
        self.emitted = ""
        self.last_interim: str | None = None
        self.seconds = 0.0
        self.open = True

    def feed(self, payload: bytes) -> None:
        pcm = pcm16_to_float(payload)
        if self.resampler is not None:
            pcm = self.resampler.process(pcm)
        self.pending = np.concatenate([self.pending, pcm])
        chunk = int(CHUNK_SECONDS * TARGET_RATE)
        while len(self.pending) >= chunk:
            self._step(self.pending[:chunk])
            self.pending = self.pending[chunk:]

    def _step(self, audio: np.ndarray) -> None:
        self.transcriber.add_audio(self.mx.array(audio))
        self.seconds += len(audio) / TARGET_RATE
        self._publish()

    def _publish(self) -> None:
        finalized = token_text(self.transcriber.finalized_tokens)
        draft = token_text(self.transcriber.draft_tokens)
        cut = finalized.rfind(" ")  # keep a possibly unfinished last word for later
        if cut > len(self.emitted):
            emit({"ev": "final", "text": finalized[len(self.emitted):cut]})
            self.emitted = finalized[:cut]
        interim = (finalized[len(self.emitted):] + draft).strip()
        if interim != self.last_interim:
            emit({"ev": "interim", "text": interim})
            self.last_interim = interim

    def stop(self) -> str:
        tail = np.zeros(int(TAIL_SECONDS * TARGET_RATE), dtype=np.float32)
        audio = np.concatenate([self.pending, tail])
        self.pending = np.zeros(0, dtype=np.float32)
        self.transcriber.add_audio(self.mx.array(audio))
        full = token_text(self.transcriber.finalized_tokens) + token_text(self.transcriber.draft_tokens)
        self.close()
        return full[len(self.emitted):]

    def close(self) -> None:
        if self.open:
            self.open = False
            self.context.__exit__(None, None, None)


# ─── Protocol ───────────────────────────────────────────────────────────────────

def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_exact(stream, size: int) -> bytes | None:
    chunks = []
    remaining = size
    while remaining > 0:
        part = stream.read(remaining)
        if not part:
            return None
        chunks.append(part)
        remaining -= len(part)
    return b"".join(chunks)


def read_frame(stream) -> tuple[bytes, bytes] | None:
    header = read_exact(stream, 5)
    if header is None:
        return None
    kind = header[:1]
    (length,) = struct.unpack(">I", header[1:5])
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"frame too large: {length} bytes")
    payload = read_exact(stream, length) if length else b""
    if payload is None:
        return None
    return kind, payload


def parse_context(value: str) -> tuple[int, int]:
    left, right = (int(part) for part in value.split(","))
    if left <= 0 or right <= 0:
        raise ValueError("context sizes must be positive")
    return left, right


def load_model(model_dir: str):
    install_stubs()
    import mlx.core as mx
    from parakeet_mlx import from_pretrained

    model = from_pretrained(model_dir)
    # One short pass compiles the Metal kernels so the first real chunk is fast.
    with model.transcribe_stream(context_size=(64, 16), depth=1) as warm:
        warm.add_audio(mx.zeros(TARGET_RATE, dtype=mx.float32))
    return model, mx


def serve(model, mx, context: tuple[int, int], depth: int, stdin) -> None:
    stream: Stream | None = None
    while True:
        frame = read_frame(stdin)
        if frame is None:
            break
        kind, payload = frame
        try:
            if kind == b"A":
                if stream is not None:
                    stream.feed(payload)
                continue
            if kind != b"J":
                continue
            message = json.loads(payload.decode("utf-8"))
            op = message.get("op")
            if op == "start":
                if stream is not None:
                    stream.close()
                    emit({"ev": "aborted", "stream": stream.id})
                rate = int(message.get("sample_rate") or TARGET_RATE)
                if not 8000 <= rate <= 96000:
                    raise ValueError(f"unsupported sample rate {rate}")
                stream = Stream(model, mx, str(message.get("stream") or ""), rate, context, depth)
                emit({"ev": "started", "stream": stream.id})
            elif op == "stop":
                if stream is not None:
                    text = stream.stop()
                    emit({"ev": "done", "stream": stream.id, "text": text, "seconds": round(stream.seconds, 2)})
                    stream = None
            elif op == "abort":
                if stream is not None:
                    stream.close()
                    emit({"ev": "aborted", "stream": stream.id})
                    stream = None
            elif op == "ping":
                emit({"ev": "pong"})
            elif op == "exit":
                break
        except Exception as exc:  # keep serving; the backend decides what to tell the user
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass
                stream = None
            emit({"ev": "error", "error": f"{type(exc).__name__}: {exc}"})
    if stream is not None:
        stream.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="directory with config.json and model.safetensors")
    parser.add_argument("--context", default="256,64", help="encoder context (keep,drop) in 80 ms frames")
    parser.add_argument("--depth", type=int, default=1)
    args = parser.parse_args(argv)
    context = parse_context(args.context)
    started = time.monotonic()
    try:
        model, mx = load_model(args.model)
    except Exception as exc:
        emit({"ev": "error", "error": f"model load failed: {type(exc).__name__}: {exc}", "fatal": True})
        return 2
    emit({"ev": "ready", "load_ms": int((time.monotonic() - started) * 1000), "context": list(context), "depth": args.depth})
    serve(model, mx, context, args.depth, sys.stdin.buffer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
