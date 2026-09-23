import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import workbench_store as store


def stream(*events):
    return io.BytesIO(b''.join(
        ('data: ' + json.dumps(event) + '\n\n').encode() for event in events
    ))


class OpenAIErrorsTest(unittest.TestCase):
    def request(self, streaming=True, callback=None):
        return store._openai_structured_json_request(
            api_key='test-key', model='gpt-6-sol', reasoning_effort='high',
            system_prompt='Test', user_content=[], schema_name='test', schema={},
            stream=streaming, stream_event_callback=callback,
        )

    def test_saved_failure_replay(self):
        path = Path(__file__).parent / 'fixtures' / 'credit_balance_exhausted.jsonl'
        events = [json.loads(line) for line in path.read_text().splitlines()]
        captured = []
        with patch.object(store, 'urlopen', return_value=stream(*events)) as call:
            with self.assertRaisesRegex(RuntimeError, 'Saldo.*agotado.*credit_balance_exhausted'):
                self.request(callback=captured.append)
        call.assert_called_once()
        self.assertEqual(captured[-1]['type'], 'error')

    def test_stream_error_shapes(self):
        error = {'code': 'credit_balance_exhausted', 'message': 'No credits remaining.'}
        for event in [
            {'type': 'error', 'error': error},
            {'type': 'error', **error},
            {'type': 'response.failed', 'response': {'status': 'failed', 'error': error}},
        ]:
            with self.subTest(event=event['type']):
                with patch.object(store, 'urlopen', return_value=stream(event)) as call:
                    with self.assertRaisesRegex(RuntimeError, 'credit_balance_exhausted'):
                        self.request()
                call.assert_called_once()

    def test_incomplete_partial_output_is_rejected(self):
        event = {'type': 'response.incomplete', 'response': {
            'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'},
            'output_text': '{"partial":true}',
        }}
        with patch.object(store, 'urlopen', return_value=stream(event)):
            with self.assertRaisesRegex(RuntimeError, 'incompleta.*max_output_tokens'):
                self.request()

    def test_unknown_provider_error_is_preserved(self):
        event = {'type': 'error', 'code': 'server_error', 'message': 'Provider diagnostic'}
        with patch.object(store, 'urlopen', return_value=stream(event)):
            with self.assertRaisesRegex(RuntimeError, 'server_error.*Provider diagnostic'):
                self.request()

    def test_successful_stream_is_unchanged(self):
        response = {'status': 'completed', 'output_text': '{"ok":true}'}
        with patch.object(store, 'urlopen', return_value=stream({'type': 'response.completed', 'response': response})):
            self.assertEqual(self.request(), response)

    def test_nonstream_failure_and_success(self):
        for response in [
            {'status': 'failed', 'error': {'code': 'insufficient_quota', 'message': 'Quota exceeded'}},
            {'status': 'completed', 'output_text': '{"ok":true}'},
        ]:
            with patch.object(store, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())):
                if response['status'] == 'failed':
                    with self.assertRaisesRegex(RuntimeError, 'cuota.*insufficient_quota'):
                        self.request(streaming=False)
                else:
                    self.assertEqual(self.request(streaming=False), response)

    def test_http_failures_are_not_retried(self):
        for status, code in [(429, 'credit_balance_exhausted'), (429, 'rate_limit_exceeded'), (401, 'invalid_api_key'), (500, 'server_error')]:
            with self.subTest(status=status, code=code):
                error = HTTPError('https://api.openai.com/v1/responses', status, 'Error', {}, io.BytesIO(json.dumps({'error': {'code': code, 'message': 'Diagnostic'}}).encode()))
                with patch.object(store, 'urlopen', side_effect=error) as call:
                    with self.assertRaisesRegex(RuntimeError, code):
                        self.request()
                call.assert_called_once()

    def test_schema_rejection_retains_fallback(self):
        error = HTTPError('https://api.openai.com/v1/responses', 400, 'Error', {}, io.BytesIO(json.dumps({'error': {'code': 'invalid_json_schema', 'param': 'text.format.schema', 'message': 'Invalid schema'}}).encode()))
        response = {'status': 'completed', 'output_text': '{}'}
        with patch.object(store, 'urlopen', side_effect=[error, stream({'type': 'response.completed', 'response': response})]) as call:
            self.assertEqual(self.request(), response)
        self.assertEqual(call.call_count, 2)


if __name__ == '__main__':
    unittest.main()
