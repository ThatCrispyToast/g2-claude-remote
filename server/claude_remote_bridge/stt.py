"""Local dictation: transcribe the glasses' mic audio on this machine.

The app posts PCM (s16le, 16 kHz, mono, the G2 mic's own format) to a
dictation opened with `start()`. Each post re-transcribes the audio not yet
committed and returns it as the interim. That audio is committed (transcribed
for good and returned as a final) when the speaker pauses for `PAUSE_S`, or
once it runs past `COMMIT_S`, cut at its quietest moment near the end, so each
pass stays short however long the dictation runs. Silence with no speech
before it is dropped as it arrives, so a quiet mic costs no model passes.
`finish()` commits the rest.

Whisper does the transcribing: through `mlx-whisper` on Apple Silicon, which
runs it on the GPU, and through `faster-whisper` (CTranslate2) anywhere else,
on an NVIDIA GPU when CUDA works there and on the CPU otherwise. `RC_BRIDGE_STT_BACKEND` (`mlx` or `faster-whisper`)
overrides the choice. The model loads on the first dictation and is freed after
`IDLE_UNLOAD_S` without one. It is an optional install (the `local-stt` extra
picks the package per platform); without it `available()` is False and the
routes answer 501.
"""

from __future__ import annotations

import gc
import hashlib
import math
import os
from concurrent.futures import Future, ThreadPoolExecutor
import secrets
import threading
import time
from typing import Optional

from .config import config_value

SAMPLE_RATE = 16000
BYTES_PER_S = SAMPLE_RATE * 2

try:
    IDLE_UNLOAD_S = float(config_value("RC_BRIDGE_STT_IDLE_S", "300"))
    if not math.isfinite(IDLE_UNLOAD_S) or IDLE_UNLOAD_S < 0:
        raise ValueError
except ValueError:
    IDLE_UNLOAD_S = 300.0
# Uncommitted audio past this is committed, cut at its quietest point within
# the last CUT_WINDOW_S, so a word is not split in two.
COMMIT_S = 20.0
CUT_WINDOW_S = 5.0
# Shorter than this is not worth a pass (and Whisper invents text for it).
MIN_AUDIO_S = 0.4
# A 100 ms frame whose mean absolute amplitude (of 32768) is below this is
# silence; audio is silent when none of its frames reach it.
SILENCE_LEVEL = 120
FRAME = SAMPLE_RATE // 10
# Speech followed by this much silence is committed.
PAUSE_S = 1.2
# Silence kept ahead of speech, so its first word is not clipped.
LEAD_S = 0.3
# A dictation nobody has posted to for this long is dropped.
ABANDON_S = 600.0
# The largest single post accepted (60 s of audio).
MAX_POST_BYTES = 60 * BYTES_PER_S

# Includes short-lived acknowledgements of finished dictations. When full,
# evict the oldest such receipt before refusing another live mic.
MAX_DICTATIONS = 32


class _Mlx:
    """Whisper through mlx-whisper, on an Apple Silicon GPU."""

    name = "mlx-whisper"
    default_model = "mlx-community/whisper-small.en-mlx"
    device = "the GPU"

    def __init__(self) -> None:
        import mlx.core as mx
        import mlx_whisper
        from mlx_whisper.transcribe import ModelHolder

        self._mx, self._whisper, self._holder = mx, mlx_whisper, ModelHolder

    def load(self, model: str) -> None:
        self._holder.get_model(model, self._mx.float16)

    def cached(self, model: str) -> bool:
        from huggingface_hub import snapshot_download

        try:
            return os.path.isdir(model) or bool(snapshot_download(model, local_files_only=True))
        except Exception:  # noqa: BLE001 — not on disk yet
            return False

    def loaded(self) -> bool:
        return self._holder.model is not None

    def unload(self) -> None:
        self._holder.model = None
        self._holder.model_path = None
        gc.collect()
        self._mx.clear_cache()

    def segments(self, model: str, audio: "np.ndarray", language: Optional[str]) -> list[tuple[str, float, float]]:
        result = self._whisper.transcribe(
            audio, path_or_hf_repo=model, language=language, fp16=True, condition_on_previous_text=False, verbose=None
        )
        return [(s["text"], s.get("no_speech_prob", 0.0), s.get("avg_logprob", 0.0)) for s in result.get("segments") or []]


class _FasterWhisper:
    """Whisper through faster-whisper (CTranslate2): on an NVIDIA GPU when
    CUDA works, else on the CPU. CTranslate2 runs no other GPUs."""

    name = "faster-whisper"
    default_model = "small.en"

    def __init__(self) -> None:
        import ctranslate2
        from faster_whisper import WhisperModel

        self._cls = WhisperModel
        self._ct2 = ctranslate2
        self._model = None
        self.device = "the CPU"

    def _cuda_devices(self) -> int:
        try:
            return self._ct2.get_cuda_device_count()
        except Exception:  # noqa: BLE001 — a build without CUDA
            return 0

    def load(self, model: str) -> None:
        if self._model is not None:
            return
        if self._cuda_devices() > 0:
            try:
                gpu = self._cls(model, device="cuda", compute_type="int8_float16")
                # A missing cuBLAS or cuDNN only shows on the first pass, so
                # run one on a second of silence before trusting the GPU.
                list(gpu.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en", beam_size=1)[0])
                self._model, self.device = gpu, "an NVIDIA GPU (CUDA)"
                return
            except Exception as exc:  # noqa: BLE001 — fall back to the CPU
                print(f"  Local dictation: the GPU could not run Whisper ({exc}); using the CPU", flush=True)
        self._model = self._cls(model, device="cpu", compute_type="int8")
        self.device = "the CPU"

    def cached(self, model: str) -> bool:
        from faster_whisper.utils import download_model

        try:
            return os.path.isdir(model) or bool(download_model(model, local_files_only=True))
        except Exception:  # noqa: BLE001 — not on disk yet
            return False

    def loaded(self) -> bool:
        return self._model is not None

    def unload(self) -> None:
        self._model = None
        gc.collect()

    def segments(self, model: str, audio: "np.ndarray", language: Optional[str]) -> list[tuple[str, float, float]]:
        self.load(model)
        # One beam: the audio is re-read about once a second while someone talks.
        segs, _ = self._model.transcribe(audio, language=language, beam_size=1, condition_on_previous_text=False)
        return [(s.text, s.no_speech_prob, s.avg_logprob) for s in segs]


def _pick_backend() -> tuple[Optional[object], Optional[str]]:
    import platform
    import sys

    wanted = config_value("RC_BRIDGE_STT_BACKEND").strip().lower()
    apple = sys.platform == "darwin" and platform.machine() == "arm64"
    order = [_Mlx, _FasterWhisper] if apple else [_FasterWhisper, _Mlx]
    if wanted in ("mlx", "mlx-whisper"):
        order = [_Mlx]
    elif wanted in ("faster-whisper", "faster_whisper"):
        order = [_FasterWhisper]
    errors = []
    for cls in order:
        try:
            return cls(), None
        except Exception as exc:  # noqa: BLE001 — any failure means "not installed here"
            errors.append(f"{cls.name}: {exc!r}")
    return None, "; ".join(errors)


try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    _BACKEND, _IMPORT_ERROR = None, repr(exc)
else:
    _BACKEND, _IMPORT_ERROR = _pick_backend()

BACKEND = getattr(_BACKEND, "name", "")
MODEL = config_value("RC_BRIDGE_STT_MODEL") or getattr(_BACKEND, "default_model", "")

NOT_INSTALLED = (
    "Local dictation is not installed on this bridge. Run it with the local-stt extra, "
    "or add a Deepgram key in Settings."
)


def available() -> bool:
    return _BACKEND is not None


class UnknownDictation(Exception):
    pass


class DictationConflict(Exception):
    pass


class DictationsBusy(Exception):
    pass


class _Dictation:
    def __init__(self, language: Optional[str], warmup: Future):
        self.warmup = warmup
        self.language = language
        self.pcm = b""  # audio not yet committed
        self.next_seq = 0
        self.last_request: Optional[tuple[str, bytes]] = None
        self.last_reply: dict = {}
        self.finished = False
        self.lock = threading.Lock()
        self.touched = time.monotonic()


# Every model call runs on this one thread: MLX keeps its GPU stream per
# thread, and the bridge serves each request on a new one.
_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")
_last_use = 0.0
# The model: idle (not loaded), downloading (first use), loading, ready or
# failed. Posts answer at once until it is ready: audio sent while it
# downloads is dropped (dictation starts once it is done), audio sent while it
# loads from disk (a second or two) is kept.
_model_state = "idle"
_warmup: Optional[Future] = None
_device_said = False  # where the model runs, printed once
_dictations: dict[str, _Dictation] = {}
_dictations_lock = threading.Lock()
_reaper: Optional[threading.Thread] = None


def _language(code: Optional[str]) -> Optional[str]:
    """The `language` to give Whisper. An English-only model takes only `en`;
    `multi` (or nothing) on a multilingual one means detect it."""
    if MODEL.rstrip("/").endswith((".en", ".en-mlx", ".en-ct2")):
        return "en"
    code = (code or "").strip().lower()
    if not code or code == "multi":
        return None
    return code.split("-")[0]


def _to_float(pcm: bytes) -> "np.ndarray":
    return np.frombuffer(bytes(pcm), dtype="<i2").astype(np.float32) / 32768.0


def _frame_levels(pcm: bytes) -> "np.ndarray":
    samples = np.abs(np.frombuffer(bytes(pcm), dtype="<i2").astype(np.int32))
    whole = samples.size // FRAME * FRAME
    if whole == 0:
        return np.array([float(samples.mean())]) if samples.size else np.zeros(0)
    return samples[:whole].reshape(-1, FRAME).mean(axis=1)


def _is_silent(pcm: bytes) -> bool:
    levels = _frame_levels(pcm)
    return levels.size == 0 or float(levels.max()) < SILENCE_LEVEL


def _trailing_silence_s(pcm: bytes) -> float:
    loud = np.nonzero(_frame_levels(pcm) >= SILENCE_LEVEL)[0]
    if loud.size == 0:
        return len(pcm) / BYTES_PER_S
    return (len(pcm) // 2 - (loud[-1] + 1) * FRAME) / SAMPLE_RATE


def _run_whisper(audio: "np.ndarray", language: Optional[str]) -> list[tuple[str, float, float]]:
    global _last_use
    segments = _BACKEND.segments(MODEL, audio, language)
    _last_use = time.monotonic()
    return segments


def _transcribe(pcm: bytes, language: Optional[str]) -> str:
    if len(pcm) < MIN_AUDIO_S * BYTES_PER_S or _is_silent(pcm):
        return ""
    segments = _worker.submit(_run_whisper, _to_float(pcm), language).result()
    # Whisper fills silence and noise with stock phrases; drop segments it
    # rates as probably not speech.
    kept = [text.strip() for text, no_speech, logprob in segments if not (no_speech > 0.6 and logprob < -1.0)]
    return " ".join(t for t in kept if t)


def _cut_point(pcm: bytes) -> int:
    """Byte offset to commit up to: the quietest 100 ms in the last
    CUT_WINDOW_S of `pcm`, so the cut falls between words."""
    samples = np.frombuffer(bytes(pcm), dtype="<i2").astype(np.int32)
    frame = SAMPLE_RATE // 10
    start = max(0, samples.size - int(CUT_WINDOW_S * SAMPLE_RATE))
    best, best_level = samples.size, None
    for i in range(start, samples.size - frame + 1, frame):
        level = float(np.abs(samples[i:i + frame]).mean())
        if best_level is None or level < best_level:
            best, best_level = i + frame // 2, level
    return best * 2


def model_state() -> str:
    return _model_state


def _load() -> None:
    global _last_use, _model_state, _device_said
    if _model_state == "downloading":
        print(f"  Local dictation: downloading {MODEL} (first use; this can take a few minutes)", flush=True)
    try:
        _BACKEND.load(MODEL)
    except Exception as exc:
        print(f"  Local dictation: could not load {MODEL}: {exc!r}", flush=True)
        with _dictations_lock:
            _model_state = "failed"
        raise RuntimeError("The dictation model could not load. Check the bridge log.") from exc
    if not _device_said:
        print(f"  Local dictation: {MODEL} runs on {_BACKEND.device}", flush=True)
        _device_said = True
    with _dictations_lock:
        _last_use = time.monotonic()
        _model_state = "ready"


def _unload_if_idle() -> None:
    global _model_state
    with _dictations_lock:
        if _model_state != "ready" or time.monotonic() - _last_use < IDLE_UNLOAD_S:
            return
        if any(not d.finished for d in _dictations.values()):
            return
        _BACKEND.unload()
        _model_state = "idle"


def _reap() -> None:
    while True:
        time.sleep(30)
        now = time.monotonic()
        with _dictations_lock:
            for did, d in list(_dictations.items()):
                if now - d.touched > ABANDON_S and not d.lock.locked():
                    del _dictations[did]
        try:
            _worker.submit(_unload_if_idle).result()
        except Exception:  # noqa: BLE001 — never let the reaper die
            pass


def start(language: Optional[str]) -> str:
    """Open a mic and share a single warmup across concurrent dictations."""
    global _reaper, _model_state, _warmup
    did = secrets.token_hex(8)
    with _dictations_lock:
        if len(_dictations) >= MAX_DICTATIONS:
            finished = [key for key, d in _dictations.items() if d.finished]
            if not finished:
                raise DictationsBusy("Too many open dictations. Try again in a moment.")
            del _dictations[min(finished, key=lambda key: _dictations[key].touched)]
        if _model_state in ("idle", "failed"):
            _model_state = "loading" if _BACKEND.cached(MODEL) else "downloading"
            _warmup = _worker.submit(_load)
        _dictations[did] = _Dictation(_language(language), _warmup)
        if _reaper is None:
            _reaper = threading.Thread(target=_reap, name="stt-reaper", daemon=True)
            _reaper.start()
    return did


def _recognize(d: _Dictation, pcm: bytes, finish: bool) -> tuple[bytes, list[str], str]:
    """Work from an immutable snapshot; a failed inference leaves the last
    acknowledged bytes and text intact for an exact retry."""
    if _model_state == "downloading" and not d.warmup.done():
        # The app discards microphone frames during a first download and polls with
        # empty audio. A stop in that state has nothing to flush.
        if pcm:
            raise DictationConflict("Wait for the dictation model to download before recording.")
        return b"", [], ""
    d.warmup.result()  # includes a cached load or its failure, also during finish
    audio = d.pcm + pcm
    if _is_silent(audio):
        tail = b"" if finish else audio[-int(LEAD_S * BYTES_PER_S):]
        return tail, [], ""
    if finish or _trailing_silence_s(audio) >= PAUSE_S:
        text = _transcribe(audio, d.language)
        return b"", [text] if text else [], ""
    finals = []
    if len(audio) > COMMIT_S * BYTES_PER_S:
        cut = _cut_point(audio)
        text = _transcribe(audio[:cut], d.language)
        if text:
            finals.append(text)
        audio = audio[cut:]
    return audio, finals, _transcribe(audio, d.language)


def process(did: str, action: str, seq: int, pcm: bytes) -> dict:
    """Apply the next numbered post, or replay its acknowledgement. One post
    at a time per mic means only the latest reply (including finish) is needed."""
    global _last_use
    with _dictations_lock:
        d = _dictations.get(did)
        if d is None:
            raise UnknownDictation(did)
        d.touched = time.monotonic()
    with d.lock:
        # A duplicate may have waited for an earlier inference while a cancel
        # removed this mic. Drop it before replay or another model pass.
        with _dictations_lock:
            if _dictations.get(did) is not d:
                raise UnknownDictation(did)
        request = (action, hashlib.sha256(pcm).digest())
        if seq == d.next_seq - 1 and request == d.last_request:
            return d.last_reply
        if seq != d.next_seq or d.finished:
            raise DictationConflict("Dictation sequence or audio does not match the expected request.")
        finished = action == "finish"
        pending, finals, interim = _recognize(d, pcm, finished)
        reply = {"seq": seq, "final": finals, "interim": interim, "model": model_state()}
        with _dictations_lock:
            if _dictations.get(did) is not d:  # cancelled while inference was in flight
                raise UnknownDictation(did)
            d.pcm, d.last_request, d.last_reply = pending, request, reply
            d.next_seq += 1
            d.finished = finished
            d.touched = _last_use = time.monotonic()
        return reply


def cancel(did: str) -> None:
    global _last_use
    with _dictations_lock:
        if _dictations.pop(did, None) is not None:
            _last_use = time.monotonic()
