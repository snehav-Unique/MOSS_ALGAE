import unittest
from fastapi.testclient import TestClient
from backend import main

def post(client, **fields):
    return client.post('/api/sensors/reading', json={'board_type': 'esp32', 'transport': 'wired', 'device_id': 'esp32_wired', **fields}).json()

class RealSensorReadingTests(unittest.TestCase):
    """Relative MQ-135 readings become CO2-equivalent ppm against each sensor's own baseline (fresh air = 400 ppm)."""
    def setUp(self):
        self.client = TestClient(main.app)
        main.sensor_issue.update(message=None, at=None)
        main.reset_gas_baseline()

    def test_first_reading_is_fresh_air_for_each_sensor(self):
        data = post(self.client, inlet_ppm=3.10, outlet_ppm=3.80, temperature=24.1, humidity=70.0)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400, 400))
        self.assertEqual((data['inlet_raw'], data['outlet_raw']), (3.10, 3.80))
        self.assertIsNotNone(data['baseline']['reset_at'])

    def test_values_already_in_ppm_pass_through(self):
        data = post(self.client, inlet_ppm=550.0, outlet_ppm=275.0)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (550, 275))

    def test_sensors_are_not_swapped(self):
        post(self.client, inlet_ppm=3.0, outlet_ppm=3.0)
        data = post(self.client, inlet_ppm=3.0, outlet_ppm=4.5)['recorded']
        self.assertLess(data['inlet_ppm'], data['outlet_ppm'])
        self.assertEqual(data['efficiency'], 0.0)

    def test_missing_dht22_stays_missing(self):
        data = post(self.client, inlet_ppm=0.67, outlet_ppm=0.65)['recorded']
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

    def test_relayed_values_pass_through(self):
        data = post(self.client, inlet_ppm=41.0, outlet_ppm=39.0, calibrated=True)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (41.0, 39.0))
        self.assertIsNone(data['baseline'])

    def test_simulation_values_pass_through(self):
        data = self.client.post('/api/sensors/reading', json={'inlet_ppm': 450.0, 'outlet_ppm': 270.0, 'board_type': 'simulator', 'transport': 'simulation'}).json()['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (450.0, 270.0))

class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.sensor_issue.update(message=None, at=None)
        main.reset_gas_baseline()

    def test_clean_air_heater_drift_returns_to_fresh_air(self):
        # Observed on the chamber: clean-air raw readings tripled (3.4 -> 11.5) over 20 minutes of heater warm-up.
        for i in range(600):
            raw = 3.4 + (11.5 - 3.4) * i / 600
            main.baseline_ppm_pair(raw, raw * 1.1)
        for _ in range(150):
            data = post(self.client, inlet_ppm=11.5, outlet_ppm=12.65)['recorded']
        self.assertAlmostEqual(data['inlet_ppm'], 400, delta=10)
        self.assertAlmostEqual(data['outlet_ppm'], 400, delta=10)

    def test_smoke_at_intake_puts_sensor_1_above_sensor_2(self):
        for _ in range(20):
            post(self.client, inlet_ppm=3.10, outlet_ppm=3.80)
        for _ in range(main.SMOOTH_READINGS):
            data = post(self.client, inlet_ppm=3.97, outlet_ppm=4.18)['recorded']  # the agarbathi test: S1 +28%, S2 +10%
        self.assertGreater(data['inlet_ppm'], data['outlet_ppm'])
        self.assertGreater(data['efficiency'], 10)

    def test_below_fresh_air_is_corrected_quickly(self):
        post(self.client, inlet_ppm=4.0, outlet_ppm=4.0)
        for _ in range(15):
            data = post(self.client, inlet_ppm=3.0, outlet_ppm=3.0)['recorded']
        self.assertGreaterEqual(data['inlet_ppm'], 380)

    def test_air_cleaned_by_the_filter_stays_lower_at_the_exhaust(self):
        for _ in range(main.RATIO_READINGS):  # reset with both sensors in the same air
            post(self.client, inlet_ppm=3.0, outlet_ppm=3.3)
        for _ in range(300):  # 10 minutes of the filter removing 20%
            data = post(self.client, inlet_ppm=3.0, outlet_ppm=3.3 * 0.8)['recorded']
        self.assertAlmostEqual(data['inlet_ppm'], 400, delta=5)
        self.assertAlmostEqual(data['outlet_ppm'], 320, delta=5)
        self.assertGreater(data['efficiency'], 15)

    def test_step_noise_does_not_flip_intake_and_exhaust(self):
        # Same air, values with 2 decimals as the sketch prints them: single readings jump by ~2%.
        import random
        rng = random.Random(1)
        for i in range(200):
            data = post(self.client, inlet_ppm=round(0.52 + rng.uniform(-0.015, 0.015), 2),
                        outlet_ppm=round(0.39 + rng.uniform(-0.015, 0.015), 2))['recorded']
            if i > 20:
                self.assertLess(abs(data['inlet_ppm'] - data['outlet_ppm']), 25)

    def test_stuck_readings_are_reported(self):
        for _ in range(main.STATIC_READINGS + 1):
            post(self.client, inlet_ppm=3.0, outlet_ppm=3.0)
        self.assertIn('not changed', self.client.get('/api/sensors/live').json()['sensor_issue'])
        post(self.client, inlet_ppm=3.01, outlet_ppm=3.0)
        self.assertIsNone(self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_reset_endpoint_and_restart_detection(self):
        post(self.client, inlet_ppm=3.0, outlet_ppm=3.0)
        self.assertEqual(self.client.post('/api/sensors/reset-baseline').json()['status'], 'reset')
        self.assertIsNone(main.gas_baseline['inlet'])
        self.assertEqual(main.sensor_telemetry_history, [])
        data = post(self.client, inlet_ppm=9.0, outlet_ppm=10.0)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400, 400))
        self.assertTrue(main.is_board_restart_line('rst:0x1 (POWERON_RESET),boot:0x17'))
        self.assertTrue(main.is_board_restart_line('Connecting to Wi-Fi: hotspot'))
        self.assertFalse(main.is_board_restart_line('{"inlet_ppm":3.1,"outlet_ppm":3.8}'))

if __name__ == '__main__':
    unittest.main()
