"""Local dictation: the HTTP routes (with the model stubbed) and the audio helpers."""
from concurrent.futures import Future, ThreadPoolExecutor
import http.client
import json
import threading
import unittest
from unittest.mock import Mock, patch

from claude_remote_bridge import bridge, stt


class SttRouteTests(unittest.TestCase):
    def setUp(self):
        self.httpd = bridge._Bridge(("127.0.0.1", 0), bridge._Handler, Mock())
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.httpd.shutdown)

    def post(self, path, body=b"", headers=None):
        conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=2)
        try:
            conn.request("POST", path, body, headers=headers or {})
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"null")
        finally:
            conn.close()

    def test_needs_the_token(self):
        with patch.object(bridge, "TOKEN", "secret"), patch.object(stt, "available", return_value=True), \
                patch.object(stt, "start", return_value="0123456789abcdef") as start:
            self.assertEqual(self.post("/api/stt/start", b"{}")[0], 401)
            start.assert_not_called()
            status, body = self.post("/api/stt/start", b"{}", {"Authorization": "Bearer secret"})
        self.assertEqual(status, 200)

    def test_unauthorized_audio_is_rejected_before_reading_any_bytes(self):
        handler = Mock(spec=bridge._Handler)
        handler._authed.return_value = False
        handler.rfile = Mock()
        bridge._Handler._stt(handler, "/api/stt/start")
        handler.rfile.read.assert_not_called()
        handler._json.assert_called_once_with({"error": "unauthorized", "status": 401}, status=401)
        self.assertTrue(handler.close_connection)

    def test_whoami_reports_local_dictation(self):
        conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=2)
        for installed in (True, False):
            with patch.object(stt, "available", return_value=installed), \
                    patch.object(bridge, "load_credentials", side_effect=bridge.CredentialsError("none")):
                conn.request("GET", "/api/whoami")
                self.assertEqual(json.loads(conn.getresponse().read())["local_stt"], installed)
        conn.close()

    def test_not_installed_is_501(self):
        with patch.object(stt, "available", return_value=False):
            status, body = self.post("/api/stt/start", b"{}")
        self.assertEqual(status, 501)
        self.assertIn("local-stt", body["error"])

    def test_start_audio_finish_cancel(self):
        did = "0123456789abcdef"
        pcm = b"\x01\x00" * 800
        with patch.object(stt, "available", return_value=True), \
                patch.object(stt, "start", return_value=did) as start, \
                patch.object(stt, "model_state", return_value="ready"), \
                patch.object(stt, "process", side_effect=[{"seq": 0, "interim": "hello"}, {"seq": 1, "final": ["hello world"]}]) as process, \
                patch.object(stt, "cancel") as cancel:
            self.assertEqual(self.post("/api/stt/start", json.dumps({"language": "en"}).encode()), (200, {"id": did, "model": "ready", "protocol": 1}))
            start.assert_called_once_with("en")
            self.assertEqual(self.post(f"/api/stt/{did}/audio?seq=0", pcm)[1]["interim"], "hello")
            process.assert_called_with(did, "audio", 0, pcm)
            self.assertEqual(self.post(f"/api/stt/{did}/finish?seq=1", pcm[:10])[1]["final"], ["hello world"])
            process.assert_called_with(did, "finish", 1, pcm[:10])
            self.assertEqual(self.post(f"/api/stt/{did}/cancel")[0], 200)
            cancel.assert_called_once_with(did)

    def test_unknown_dictation_is_404(self):
        with patch.object(stt, "available", return_value=True), \
                patch.object(stt, "process", side_effect=stt.UnknownDictation("x")):
            self.assertEqual(self.post("/api/stt/0123456789abcdef/audio?seq=0", b"\x00\x00")[0], 404)
        with patch.object(stt, "available", return_value=True):
            self.assertEqual(self.post("/api/stt/not-an-id/audio", b"\x00\x00")[0], 404)

    def test_oversized_post_is_refused_unread(self):
        with patch.object(stt, "MAX_POST_BYTES", 10), patch.object(stt, "available", return_value=True), patch.object(stt, "process") as feed:
            self.assertEqual(self.post("/api/stt/0123456789abcdef/audio?seq=0", b"\x00" * 20)[0], 413)
        feed.assert_not_called()


    def test_numbered_posts_and_pcm_shape_are_validated(self):
        path = "/api/stt/0123456789abcdef/audio"
        with patch.object(stt, "available", return_value=True), patch.object(stt, "process") as process:
            for suffix in ("", "?seq=-1", "?seq=invalid", "?seq=1&seq=0"):
                self.assertEqual(self.post(path + suffix)[0], 400)
            self.assertEqual(self.post(path + "?seq=0", b"odd")[0], 400)
            for length in ("-1", "unknown"):
                self.assertEqual(self.post(path + "?seq=0", headers={"Content-Length": length})[0], 400)
        process.assert_not_called()


class SttSessionTests(unittest.TestCase):
    def setUp(self):
        self.warmup = Future()
        self.warmup.set_result(None)
        for name, value in {"_dictations": {}, "_warmup": self.warmup, "_reaper": Mock(), "_model_state": "ready"}.items():
            patcher = patch.object(stt, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_lost_audio_and_finish_replies_can_be_replayed(self):
        did = stt.start("en")
        with patch.object(stt, "_recognize", side_effect=[(b"", ["hello"], ""), (b"", ["world"], "")]) as model:
            for seq, action, phrase in ((0, "audio", "hello"), (1, "finish", "world")):
                expected = {"seq": seq, "final": [phrase], "interim": "", "model": "ready"}
                self.assertEqual(stt.process(did, action, seq, b"aa"), expected)
                self.assertEqual(stt.process(did, action, seq, b"aa"), expected)
                with self.assertRaises(stt.DictationConflict):
                    stt.process(did, action, seq, b"bb")
            with self.assertRaises(stt.DictationConflict):
                stt.process(did, "audio", 2, b"")
            self.assertEqual(model.call_count, 2)

    def test_concurrent_retry_only_runs_model_once(self):
        did = stt.start("en")
        entered, release = threading.Event(), threading.Event()

        def recognize(*args):
            entered.set()
            release.wait(2)
            return b"", ["once"], ""

        with patch.object(stt, "_recognize", side_effect=recognize) as model, ThreadPoolExecutor(2) as pool:
            first = pool.submit(stt.process, did, "audio", 0, b"aa")
            self.assertTrue(entered.wait(2))
            duplicate = pool.submit(stt.process, did, "audio", 0, b"aa")
            release.set()
            self.assertEqual(first.result(2), duplicate.result(2))
            model.assert_called_once()

    def test_cancel_drops_in_flight_audio_and_its_waiting_retry(self):
        did = stt.start("en")
        entered, release, queued = threading.Event(), threading.Event(), threading.Event()
        lock = stt._dictations[did].lock

        class ObservedLock:
            def __enter__(self):
                if lock.locked():
                    queued.set()
                lock.acquire()

            def __exit__(self, *args):
                lock.release()

        stt._dictations[did].lock = ObservedLock()

        def recognize(*args):
            entered.set()
            release.wait(2)
            return b"", ["cancelled words"], ""

        with patch.object(stt, "_recognize", side_effect=recognize) as model, ThreadPoolExecutor(2) as pool:
            first = pool.submit(stt.process, did, "audio", 0, b"aa")
            self.assertTrue(entered.wait(2))
            duplicate = pool.submit(stt.process, did, "audio", 0, b"aa")
            self.assertTrue(queued.wait(2))
            stt.cancel(did)
            release.set()
            for request in (first, duplicate):
                with self.assertRaises(stt.UnknownDictation):
                    request.result(2)
            model.assert_called_once()

    def test_an_open_mic_prevents_idle_unload(self):
        did = stt.start("en")
        with patch.object(stt, "_BACKEND") as backend, patch.object(stt, "IDLE_UNLOAD_S", 0):
            stt._unload_if_idle()
            backend.unload.assert_not_called()
            stt.cancel(did)
            stt._unload_if_idle()
            backend.unload.assert_called_once()


@unittest.skipUnless(hasattr(stt, "np"), "NumPy is required for the PCM tests")
class SttAudioTests(unittest.TestCase):
    def setUp(self):
        warmup = Future()
        warmup.set_result(None)
        for name, value in {"_dictations": {}, "_warmup": warmup, "_reaper": Mock(), "_model_state": "ready"}.items():
            patcher = patch.object(stt, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_english_only_model_takes_only_english(self):
        with patch.object(stt, "MODEL", "mlx-community/whisper-small.en-mlx"):
            self.assertEqual(stt._language("de"), "en")
        with patch.object(stt, "MODEL", "mlx-community/whisper-small-mlx"):
            self.assertEqual(stt._language("pt-BR"), "pt")
            self.assertIsNone(stt._language("multi"))
            self.assertIsNone(stt._language(""))

    def test_cut_falls_in_the_quiet(self):
        import numpy as np
        rate = stt.SAMPLE_RATE
        loud = (np.sin(np.arange(rate * 10) / 3) * 8000).astype("<i2")
        loud[rate * 8: rate * 8 + rate // 5] = 0  # 200 ms gap at 8 s
        cut = stt._cut_point(loud.tobytes()) // 2
        self.assertTrue(rate * 8 <= cut <= rate * 8 + rate // 5, cut / rate)

    def test_short_phrase_then_long_silence_is_kept(self):
        import numpy as np
        rate = stt.SAMPLE_RATE
        phrase = (np.sin(np.arange(rate) / 3) * 3000).astype("<i2").tobytes()  # 1 s
        quiet = b"\x00\x00" * rate
        seen = []
        with patch.object(stt, "_transcribe", side_effect=lambda pcm, lang: "" if stt._is_silent(pcm) else seen.append(len(pcm)) or "yes"), \
                patch.object(stt, "_worker"), patch.object(stt, "_model_state", "ready"):
            did = stt.start("en")
            finals = []
            chunks = [quiet] * 3 + [phrase] + [quiet] * 25
            for seq, chunk in enumerate(chunks):
                finals += stt.process(did, "audio", seq, chunk)["final"]
            finals += stt.process(did, "finish", len(chunks), b"")["final"]
        self.assertFalse(stt._is_silent(phrase + quiet * 19))  # one loud second is speech
        self.assertEqual(finals, ["yes"])  # committed at the pause, not lost
        self.assertLess(seen[-1], rate * 2 * 4)  # the 3 s of silence before it was dropped

    def test_download_poll_and_stop_do_not_wait_or_admit_early_audio(self):
        with patch.object(stt, "_warmup", Future()), patch.object(stt, "_model_state", "downloading"):
            did = stt.start("en")
            self.assertEqual(stt.process(did, "audio", 0, b"")["model"], "downloading")
            with self.assertRaises(stt.DictationConflict):
                stt.process(did, "audio", 1, b"aa")
            self.assertEqual(stt.process(did, "finish", 1, b"")["final"], [])

    def test_finishing_during_cached_warmup_transcribes_speech(self):
        warmup = Future()
        with patch.object(stt, "_warmup", warmup), patch.object(stt, "_model_state", "loading"), \
                patch.object(stt, "_transcribe", return_value="yes") as model, ThreadPoolExecutor(1) as pool:
            did = stt.start("en")
            audio = b"aa" * stt.SAMPLE_RATE
            done = pool.submit(stt.process, did, "finish", 0, audio)
            stt._model_state = "ready"
            warmup.set_result(None)
            self.assertEqual(done.result(2)["final"], ["yes"])
            model.assert_called_once_with(audio, "en")

    def test_failed_load_reaches_finish(self):
        warmup = Future()
        warmup.set_exception(RuntimeError("load failed"))
        did = stt.start("en")
        stt._dictations[did].warmup = warmup
        with self.assertRaisesRegex(RuntimeError, "load failed"):
            stt.process(did, "finish", 0, b"")

    def test_failed_inference_does_not_consume_pending_audio(self):
        did = stt.start("en")
        first, last = b"aa" * stt.SAMPLE_RATE, b"bb" * stt.SAMPLE_RATE
        with patch.object(stt, "_transcribe", side_effect=["old", RuntimeError("busy"), "both"]) as model:
            stt.process(did, "audio", 0, first)
            with self.assertRaises(RuntimeError):
                stt.process(did, "finish", 1, last)
            self.assertEqual(stt.process(did, "finish", 1, last)["final"], ["both"])
            self.assertEqual(model.call_args[0][0], first + last)

    def test_faster_whisper_falls_back_to_the_cpu_when_cuda_fails(self):
        loads = []

        class FakeModel:
            def __init__(self, model, device, compute_type):
                loads.append(device)
                self.device = device

            def transcribe(self, audio, **kwargs):
                if self.device == "cuda":
                    raise RuntimeError("Library libcublas.so.12 is not found")  # as a missing CUDA runtime reports
                return iter([]), None

        backend = stt._FasterWhisper.__new__(stt._FasterWhisper)
        backend._cls, backend._model = FakeModel, None
        backend._ct2 = Mock(get_cuda_device_count=Mock(return_value=1))
        with patch("builtins.print"):
            backend.load("small.en")
        self.assertEqual(loads, ["cuda", "cpu"])
        self.assertEqual(backend.device, "the CPU")
        self.assertEqual(backend._model.device, "cpu")

        loads.clear()
        backend._model = None
        backend._ct2 = Mock(get_cuda_device_count=Mock(return_value=0))  # no NVIDIA GPU
        backend.load("small.en")
        self.assertEqual(loads, ["cpu"])

    def test_silence_is_not_transcribed(self):
        with patch.object(stt, "_worker") as worker:
            self.assertEqual(stt._transcribe(b"\x00\x00" * stt.SAMPLE_RATE, "en"), "")
        worker.submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
