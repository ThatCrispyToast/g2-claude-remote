"""Local dictation: the HTTP routes (with the model stubbed) and the audio helpers."""
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
                patch.object(stt, "feed", return_value={"final": [], "interim": "hello"}) as feed, \
                patch.object(stt, "finish", return_value={"final": ["hello world"], "interim": ""}) as finish, \
                patch.object(stt, "cancel") as cancel:
            self.assertEqual(self.post("/api/stt/start", json.dumps({"language": "en"}).encode()), (200, {"id": did, "model": "ready"}))
            start.assert_called_once_with("en")
            self.assertEqual(self.post(f"/api/stt/{did}/audio", pcm)[1]["interim"], "hello")
            feed.assert_called_once_with(did, pcm)
            self.assertEqual(self.post(f"/api/stt/{did}/finish", pcm[:10])[1]["final"], ["hello world"])
            finish.assert_called_once_with(did, pcm[:10])
            self.assertEqual(self.post(f"/api/stt/{did}/cancel")[0], 200)
            cancel.assert_called_once_with(did)

    def test_unknown_dictation_is_404(self):
        with patch.object(stt, "available", return_value=True), \
                patch.object(stt, "feed", side_effect=stt.UnknownDictation("x")):
            self.assertEqual(self.post("/api/stt/0123456789abcdef/audio", b"\x00\x00")[0], 404)
        with patch.object(stt, "available", return_value=True):
            self.assertEqual(self.post("/api/stt/not-an-id/audio", b"\x00\x00")[0], 404)

    def test_oversized_post_is_refused_unread(self):
        with patch.object(stt, "MAX_POST_BYTES", 10), patch.object(stt, "feed") as feed:
            self.assertEqual(self.post("/api/stt/0123456789abcdef/audio", b"\x00" * 20)[0], 413)
        feed.assert_not_called()


@unittest.skipUnless(stt.available(), "local-stt extra not installed")
class SttAudioTests(unittest.TestCase):
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
            for chunk in [quiet] * 3 + [phrase] + [quiet] * 25:
                finals += stt.feed(did, chunk)["final"]
            finals += stt.finish(did, b"")["final"]
        self.assertFalse(stt._is_silent(phrase + quiet * 19))  # one loud second is speech
        self.assertEqual(finals, ["yes"])  # committed at the pause, not lost
        self.assertLess(seen[-1], rate * 2 * 4)  # the 3 s of silence before it was dropped

    def test_audio_is_dropped_while_the_model_downloads_and_kept_while_it_loads(self):
        import numpy as np
        rate = stt.SAMPLE_RATE
        early = (np.sin(np.arange(rate) / 3) * 3000).astype("<i2").tobytes()
        later = (np.sin(np.arange(rate) / 5) * 3000).astype("<i2").tobytes()
        with patch.object(stt, "_transcribe", return_value="hello") as transcribe, \
                patch.object(stt, "_worker"), patch.object(stt, "_model_state", "downloading"):
            did = stt.start("en")
            reply = stt.feed(did, early)
            self.assertEqual(reply, {"final": [], "interim": "", "model": "downloading"})  # answered at once
            stt._model_state = "loading"  # downloaded; loading from disk
            self.assertEqual(stt.feed(did, later)["model"], "loading")
            transcribe.assert_not_called()
            stt._model_state = "ready"
            self.assertEqual(stt.feed(did, b"")["interim"], "hello")
            self.assertEqual(bytes(transcribe.call_args[0][0]), later)  # the download's audio is gone, the load's kept
            stt._model_state = "failed"
            with self.assertRaises(RuntimeError):
                stt.feed(did, later)

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
