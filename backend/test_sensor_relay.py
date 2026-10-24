import os
import time
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import main

class FakeDoc:
    def __init__(self):
        self.data = None
    def get(self):
        data = self.data
        return type('Snapshot', (), {'exists': data is not None, 'to_dict': lambda _self: dict(data)})()
    def set(self, data):
        self.data = data

class FakeStore:
    def __init__(self):
        self.doc = FakeDoc()
    def collection(self, _name):
        return self
    def document(self, _name):
        return self.doc

READING = {'inlet_ppm': 400.0, 'outlet_ppm': 300.0, 'calibrated': True, 'temperature': 25.0, 'humidity': 80.0, 'board_type': 'esp32', 'transport': 'wired', 'device_id': 'esp32_wired'}

class SensorRelayTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.store = FakeStore()
        main._remote_cache.update(data=None, fetched=0.0)
        main.sensor_issue.update(message=None, at=None)

    def relay(self, key):
        headers = {'X-Relay-Key': key} if key else {}
        with patch.object(main, 'suggestion_store', return_value=self.store):
            return self.client.post('/api/sensors/relay', json=READING, headers=headers)

    def test_rejects_missing_or_wrong_key(self):
        with patch.dict(os.environ, {'SENSOR_RELAY_KEY': 'secret'}):
            self.assertEqual(self.relay(None).status_code, 401)
            self.assertEqual(self.relay('wrong').status_code, 401)
        with patch.dict(os.environ, {'SENSOR_RELAY_KEY': ''}):
            self.assertEqual(self.relay('anything').status_code, 401)

    def test_publishes_latest_and_history(self):
        with patch.dict(os.environ, {'SENSOR_RELAY_KEY': 'secret'}):
            self.assertEqual(self.relay('secret').status_code, 200)
            self.relay('secret')
        saved = self.store.doc.data
        self.assertEqual(saved['latest']['inlet_ppm'], 400.0)
        self.assertEqual(len(saved['history']), 2)
        self.assertGreater(saved['updated_at'], time.time() - 5)

    def test_deployed_live_feed_reads_relayed_state(self):
        self.store.doc.data = {'latest': {'inlet_ppm': 410.0, 'outlet_ppm': 300.0}, 'history': [{'inlet_ppm': 410.0}], 'issue': None, 'updated_at': time.time() - 3}
        main.latest_sensor_reading = None
        main.latest_sensor_received_at = None
        with patch.dict(os.environ, {'FIREBASE_PROJECT_ID': 'demo'}), patch.object(main, 'suggestion_store', return_value=self.store):
            data = self.client.get('/api/sensors/live').json()
        self.assertEqual(data['source'], 'relay')
        self.assertTrue(data['connected'])
        self.assertEqual(data['latest']['inlet_ppm'], 410.0)

    def test_stale_relay_is_not_connected(self):
        self.store.doc.data = {'latest': {'inlet_ppm': 410.0}, 'history': [], 'issue': None, 'updated_at': time.time() - 120}
        main.latest_sensor_reading = None
        main.latest_sensor_received_at = None
        with patch.dict(os.environ, {'FIREBASE_PROJECT_ID': 'demo'}), patch.object(main, 'suggestion_store', return_value=self.store):
            self.assertFalse(self.client.get('/api/sensors/live').json()['connected'])

if __name__ == '__main__':
    unittest.main()
