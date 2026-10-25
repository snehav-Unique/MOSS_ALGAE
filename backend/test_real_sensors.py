import unittest
from fastapi.testclient import TestClient
from backend import main

def post(client, **fields):
    return client.post('/api/sensors/reading', json={'board_type': 'esp32', 'transport': 'wired', 'device_id': 'esp32_wired', **fields}).json()

class RealSensorReadingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.sensor_issue.update(message=None, at=None)
        self.client.post('/api/sensors/calibrate')

    def calibrate(self, inlet=0.6, outlet=0.5):
        for _ in range(main.CALIBRATION_SAMPLES):
            last = post(self.client, inlet_ppm=inlet, outlet_ppm=outlet)
        return last

    def test_first_readings_calibrate_to_fresh_air(self):
        first = post(self.client, inlet_ppm=0.6, outlet_ppm=0.5)
        self.assertEqual(first['reason'], 'calibrating')
        self.assertIn('Calibrating', self.client.get('/api/sensors/live').json()['sensor_issue'])
        data = self.calibrate()['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400.0, 400.0))
        self.assertIsNotNone(data['calibrated_at'])

    def test_dirtier_air_reads_higher_than_400(self):
        self.calibrate(inlet=0.6, outlet=0.5)
        data = post(self.client, inlet_ppm=0.9, outlet_ppm=0.55)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (600.0, 440.0))
        self.assertAlmostEqual(data['efficiency'], 26.67, places=2)
        self.assertEqual((data['inlet_raw'], data['outlet_raw']), (0.9, 0.55))

    def test_downward_drift_is_corrected_back_toward_fresh_air(self):
        self.calibrate(inlet=0.45, outlet=0.42)
        first = post(self.client, inlet_ppm=0.30, outlet_ppm=0.28)['recorded']
        self.assertLess(first['inlet_ppm'], 380)
        for _ in range(8):
            settled = post(self.client, inlet_ppm=0.30, outlet_ppm=0.28)['recorded']
        self.assertGreaterEqual(settled['inlet_ppm'], 375)
        self.assertLessEqual(settled['inlet_ppm'], 400)
        polluted = post(self.client, inlet_ppm=0.45, outlet_ppm=0.30)['recorded']
        self.assertGreater(polluted['inlet_ppm'], 550)

    def test_board_restart_lines_are_detected(self):
        for line in ('rst:0x1 (POWERON_RESET),boot:0x17 (SPI_FAST_FLASH_BOOT)', 'ets Jul 29 2019 12:21:46',
                     'Connecting to Wi-Fi: hotspot', '{"status":"INITIALIZED","device":"MOSS_ALGAE_CHAMBER_V1"}'):
            self.assertEqual(main.is_board_restart_line(line), not line.startswith('{'), line)
        self.assertFalse(main.is_board_restart_line('{"inlet_ppm":5.2,"outlet_ppm":5.4}'))

    def test_scale_jump_after_board_restart_recalibrates(self):
        self.calibrate(inlet=0.45, outlet=0.42)
        main.recalibrate_sensors()  # what the USB scanner does on reconnect / boot output
        data = self.calibrate(inlet=5.2, outlet=5.4)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400.0, 400.0))

    def test_recalibrate_resets_reference(self):
        self.calibrate(inlet=0.6, outlet=0.5)
        self.assertEqual(self.client.post('/api/sensors/calibrate').json()['status'], 'calibrating')
        data = self.calibrate(inlet=3.0, outlet=2.0)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (400.0, 400.0))

    def test_sensors_are_not_swapped_or_substituted(self):
        self.calibrate(inlet=0.6, outlet=0.6)
        data = post(self.client, inlet_ppm=0.6, outlet_ppm=0.9)['recorded']
        self.assertLess(data['inlet_ppm'], data['outlet_ppm'])
        self.assertEqual(data['efficiency'], 0.0)

    def test_missing_dht22_stays_missing(self):
        data = self.calibrate()['recorded']
        self.assertIsNone(data['temperature'])
        self.assertIsNone(data['humidity'])

    def test_spike_is_rejected_and_reported(self):
        self.assertEqual(post(self.client, inlet_ppm=6418494652416.0, outlet_ppm=3.0)['status'], 'ignored')
        self.assertIn('spike', self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_zero_reference_is_rejected_and_reported(self):
        self.assertEqual(post(self.client, inlet_ppm=0.0, outlet_ppm=0.0)['status'], 'ignored')
        self.assertIn('press EN', self.client.get('/api/sensors/live').json()['sensor_issue'])

    def test_already_calibrated_values_pass_through(self):
        data = post(self.client, inlet_ppm=41.0, outlet_ppm=39.0, calibrated=True)['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (41.0, 39.0))

    def test_simulation_values_pass_through(self):
        data = self.client.post('/api/sensors/reading', json={'inlet_ppm': 450.0, 'outlet_ppm': 270.0, 'board_type': 'simulator', 'transport': 'simulation'}).json()['recorded']
        self.assertEqual((data['inlet_ppm'], data['outlet_ppm']), (450.0, 270.0))

if __name__ == '__main__':
    unittest.main()
