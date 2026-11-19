"""Regression checks at the phone-facing HTTP boundary, using a fictional worker."""
import http.client
import json
import threading
import unittest
from unittest.mock import Mock, patch

from claude_remote_bridge import bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.rc = Mock()
        self.rc.get_session.return_value = {"status": "active", "connection_status": "connected"}
        self.httpd = bridge._Bridge(("127.0.0.1", 0), bridge._Handler, self.rc)
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.httpd.shutdown)

    def request(self, path, data=None, headers=None):
        conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=2)
        try:
            method = "GET" if data is None else "POST"
            conn.request(method, f"/api/sessions/test/{path}", json.dumps(data) if data is not None else None,
                         headers=headers or {})
            res = conn.getresponse()
            return res.status, res.headers, res.read()
        finally:
            conn.close()

    def test_message_and_slash_command(self):
        for text in ("/context", "/compact notes"):
            self.assertEqual(self.request("send", {"text": text})[0], 422)
        self.rc.send_message.assert_not_called()
        self.assertEqual(self.request("send", {"text": "Read /tmp/example"})[0], 200)
        self.rc.send_message.assert_called_once_with("test", "Read /tmp/example")
        self.rc.get_session.return_value["connection_status"] = "disconnected"
        self.assertEqual(self.request("send", {"text": "Continue"})[0], 409)

    def test_pagination_reset_and_gzip(self):
        events = [bridge.Event({"type": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": "a" * 2100}]}}, sequence_num=i) for i in range(1, 101)]
        events[19] = bridge.Event({"type": "conversation_reset"}, sequence_num=20)

        def list_events(sid, *, limit, sort_order, cursor):
            self.assertEqual(sort_order, "desc")
            return [ev for ev in reversed(events) if cursor is None or ev.sequence_num < int(cursor)][:limit]

        self.rc.list_events.side_effect = list_events
        status, headers, payload = self.request("events?limit=40", headers={"Accept-Encoding": "gzip;q=0, *;q=1"})
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Content-Encoding"))
        page = json.loads(payload)
        self.assertEqual([e["sequenceNum"] for e in page["events"]], list(range(61, 101)))
        self.assertEqual(page["before"], 61)
        _, headers, payload = self.request("events?before=61", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(headers["Content-Encoding"], "gzip")
        page = json.loads(bridge.gzip.decompress(payload))
        self.assertEqual([e["sequenceNum"] for e in page["events"]], list(range(20, 61)))
        self.assertIsNone(page["before"])
        self.assertEqual(self.request("events?before=NaN")[0], 400)
        self.assertFalse(bridge._is_transcript(bridge.Event({"type": "user", "message": {
            "content": [{"type": "text", "text": "<local-command-caveat>hidden</local-command-caveat>"}]}})))

    def test_context_and_plan_shortcuts_use_only_the_named_control(self):
        self.rc.get_context_usage.return_value = {"totalTokens": 4, "maxTokens": 20, "percentage": 20,
                                                   "categories": [{"name": "Messages", "tokens": 4}]}
        status, _, body = self.request("info?section=context")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["context"]["categories"], [{"name": "Messages", "tokens": 4}])
        self.rc.get_usage.assert_not_called()
        self.rc.get_usage.return_value = {}
        self.assertEqual(self.request("info?section=usage")[0], 200)
        self.rc.get_usage.assert_called_once()
        self.rc.get_workspace_diff.assert_not_called()
        self.rc.send_message.assert_not_called()

    def test_session_allow_requires_matching_current_offer(self):
        rule = {"type": "addRules", "behavior": "allow", "destination": "session",
                "rules": [{"toolName": "Bash", "ruleContent": "npm test"}]}
        pending = {"request_id": "r", "request": {"tool_name": "Bash", "permission_suggestions": [rule]}}
        self.rc.initialize.return_value = {"pending_permission_requests": [pending]}
        answer = {"decision": "allow", "request_id": "r", "session_rule": "Bash(npm test)"}
        with patch.object(bridge, "_rc_version", (0, 7, 1)):
            self.assertEqual(self.request("permission", answer)[0], 200)
            self.assertEqual(self.rc.respond_permission.call_args.kwargs["updated_permissions"], [rule])
            rule["destination"] = "localSettings"
            self.assertEqual(self.request("permission", answer)[0], 422)
            self.rc.initialize.return_value = {}
            self.assertEqual(self.request("permission", answer)[0], 422)
            self.assertEqual(self.rc.respond_permission.call_count, 1)
        self.assertEqual(self.request("permission", {"decision": "deny", "request_id": "r", "message": "Use staging"})[0], 200)
        self.assertEqual(self.rc.respond_permission.call_args.kwargs["message"], "Use staging")
        self.assertNotIn("updated_permissions", self.rc.respond_permission.call_args.kwargs)

    def test_custom_answer_and_unknown_dialog(self):
        question = {"question": "What next?", "options": [{"label": "Stop"}]}
        data = {"request_id": "r", "subtype": "can_use_tool", "status": "completed",
                "input": {"questions": [question]}, "answers": [{"question": "What next?", "options": ["Custom choice"]}]}
        self.assertEqual(self.request("dialog", data)[0], 200)
        self.rc.answer_question.assert_called_once_with("test", "r", {"What next?": "Custom choice"},
                                                       tool_input={"questions": [question]}, tool_use_id=None)
        self.assertEqual(self.request("dialog", dict(data, subtype="request_user_dialog"))[0], 422)
        self.rc.send_raw.assert_not_called()
