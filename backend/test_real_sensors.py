import unittest
from fastapi.testclient import TestClient
from backend import main

def post(client, **fields):
    return client.post('/api/sensors/reading', json={'board_type': 'esp32', 'transport': 'wired', 'device_id': 'esp32_wired', **fields}).json()

class RealSensorReadingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.sensor_issue.update(message=None, at=None)

    def test_relative_readings_become_co2_equivalent_ppm(self):
        data = post(self.client, inlet_ppm=3.36, outlet_ppm=2.52, temperature=24.1, humidity=70.0)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400.0, 300.0))
        self.assertEqual(data['efficiency'], 25.0)
        self.assertEqual((data['inlet_raw'], data['outlet_raw']), (3.36, 2.52))

    def test_sensors_are_not_swapped_or_substituted(self):
        data = post(self.client, inlet_ppm=3.0, outlet_ppm=4.0)['recorded']
        self.assertLess(data['inlet_ppm'], data['outlet_ppm'])
        self.assertEqual(data['efficiency'], 0.0)

    def test_missing_dht22_stays_missing(self):
        data = post(self.client, inlet_ppm=3.36, outlet_ppm=3.0)['recorded']
        self.assertIsNone(data['temperature'])
        self.assertIsNone(data['humidity'])

    def test_spike_is_rejected_and_reported(self):
        self.assertEqual(post(self.client, inlet_ppm=6418494652416.0, outlet_ppm=3.0)['status'], 'ignored')
        self.assertIn('spike', self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_zero_reference_is_rejected_and_reported(self):
        self.assertEqual(post(self.client, inlet_ppm=0.0, outlet_ppm=0.0)['status'], 'ignored')
        self.assertIn('press EN', self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_good_reading_clears_issue(self):
        post(self.client, inlet_ppm=0.0, outlet_ppm=0.0)
        post(self.client, inlet_ppm=3.4, outlet_ppm=3.1)
        self.assertIsNone(self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_simulation_values_pass_through(self):
        data = self.client.post('/api/sensors/reading', json={'inlet_ppm': 450.0, 'outlet_ppm': 270.0, 'board_type': 'simulator', 'transport': 'simulation'}).json()['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (450.0, 270.0))

if __name__ == '__main__':
    unittest.main()
