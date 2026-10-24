import os
import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient
from backend.exposure import summarize
from backend.main import app, assess_stations

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

def station(pm25, hours_old=1):
    return {'pm25': pm25, 'measured_at': (NOW - timedelta(hours=hours_old)).isoformat().replace('+00:00', 'Z')}

class HotspotQualityTests(unittest.TestCase):
    def test_status_thresholds(self):
        result = assess_stations([station(10), station(30), station(75), station(40)], NOW)
        self.assertEqual([s['status'] for s in result], ['within_who', 'elevated', 'hotspot', 'elevated'])

    def test_stale_reading_is_unverified(self):
        result = assess_stations([station(120, hours_old=5)], NOW)
        self.assertIn('stale', result[0]['flags'])
        self.assertEqual(result[0]['status'], 'unverified')

    def test_outlier_needs_four_stations(self):
        self.assertEqual(assess_stations([station(20), station(200)], NOW)[1]['flags'], [])
        result = assess_stations([station(20), station(22), station(25), station(200)], NOW)
        self.assertIn('outlier', result[3]['flags'])
        self.assertEqual(result[3]['status'], 'unverified')

    def test_hotspots_without_key_returns_empty(self):
        os.environ.pop('OPENAQ_API_KEY', None)
        data = TestClient(app).get('/api/hotspots').json()
        self.assertEqual(data['stations'], [])

class ExposureSummaryTests(unittest.TestCase):
    def test_counts_by_kind_within_radius(self):
        sites = [{'id': 'a', 'lat': 12.97, 'lng': 77.59}]
        elements = [
            {'lat': 12.9701, 'lon': 77.5901, 'tags': {'amenity': 'school', 'name': 'Near school'}},
            {'center': {'lat': 12.9702, 'lon': 77.5902}, 'tags': {'amenity': 'hospital'}},
            {'lat': 12.9703, 'lon': 77.5899, 'tags': {'highway': 'bus_stop'}},
            {'lat': 13.10, 'lon': 77.70, 'tags': {'amenity': 'school'}},
            {'lat': 12.9701, 'lon': 77.5901, 'tags': {'amenity': 'cafe'}},
        ]
        result = summarize(elements, sites, 500)['a']
        self.assertEqual((result['school'], result['health'], result['bus_stop']), (1, 1, 1))
        self.assertEqual(len(result['features']), 3)

class SuggestionPrivacyTests(unittest.TestCase):
    def test_owner_read_rejects_missing_key(self):
        with patch.dict(os.environ, {'OWNER_DASHBOARD_KEY': 'owner-secret'}):
            response = TestClient(app).get('/api/suggestions')
        self.assertEqual(response.status_code, 401)

    def test_public_submission_writes_to_store_with_nearest_pod(self):
        document = MagicMock()
        document.id = 'suggestion-1'
        collection = MagicMock()
        collection.document.return_value = document
        store = MagicMock()
        store.collection.return_value = collection
        with patch('backend.main.suggestion_store', return_value=store):
            response = TestClient(app).post('/api/suggestions', json={
                'lat': 12.9250, 'lng': 77.4992, 'reason': 'Busy school crossing needs cleaner air',
            })
        self.assertEqual(response.status_code, 200)
        saved = document.set.call_args.args[0]
        self.assertEqual(saved['nearest_pod']['id'], 'rr-nagar')
        self.assertEqual(response.json()['id'], 'suggestion-1')

if __name__ == '__main__':
    unittest.main()
