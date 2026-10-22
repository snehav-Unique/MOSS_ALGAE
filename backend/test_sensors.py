import unittest
from fastapi.testclient import TestClient
from backend.main import app, evaluate_chamber_health

class SensorEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_evaluate_chamber_health(self):
        # Optimal
        h1 = evaluate_chamber_health(24.0, 72.0)
        self.assertEqual(h1['moss_status'], 'Optimal Hydration')
        self.assertIsNone(h1['moss_alert'])
        self.assertEqual(h1['algae_status'], 'Optimal Growth')

        # Dry moss warning
        h2 = evaluate_chamber_health(24.0, 45.0)
        self.assertEqual(h2['moss_status'], 'Desiccated / Inactive')
        self.assertIsNotNone(h2['moss_alert'])

        # Overheated algae warning
        h3 = evaluate_chamber_health(35.0, 70.0)
        self.assertEqual(h3['algae_status'], 'Thermal Stress Warning')
        self.assertIsNotNone(h3['algae_alert'])

    def test_ingest_and_get_live_reading(self):
        payload = {
            "inlet_ppm": 450.0,
            "outlet_ppm": 270.0,
            "efficiency": 40.0,
            "temperature": 23.5,
            "humidity": 70.0,
            "device_id": "test_arduino"
        }
        res = self.client.post("/api/sensors/reading", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["recorded"]["inlet_ppm"], 450.0)
        self.assertEqual(data["recorded"]["outlet_ppm"], 270.0)
        self.assertEqual(data["recorded"]["efficiency"], 40.0)
        self.assertEqual(data["recorded"]["board_type"], "arduino")
        self.assertEqual(data["recorded"]["transport"], "wired")

        # Retrieve live
        live_res = self.client.get("/api/sensors/live")
        self.assertEqual(live_res.status_code, 200)
        live_data = live_res.json()
        self.assertTrue(live_data["connected"])
        self.assertIsNotNone(live_data["latest"])
        self.assertEqual(live_data["latest"]["device_id"], "test_arduino")

    def test_simulate_endpoint(self):
        res = self.client.post("/api/sensors/simulate")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "ok")
        self.assertGreater(data["recorded"]["inlet_ppm"], 0)
        self.assertEqual(data["recorded"]["board_type"], "simulator")
        self.assertEqual(data["recorded"]["transport"], "simulation")

    def test_board_transport_compatibility(self):
        base = {
            "inlet_ppm": 450.0,
            "outlet_ppm": 300.0,
            "temperature": 24.0,
            "humidity": 72.0,
        }
        rejected = self.client.post("/api/sensors/reading", json={
            **base, "board_type": "arduino", "transport": "bluetooth"
        })
        self.assertEqual(rejected.status_code, 422)

        for transport in ("wired", "wifi", "bluetooth"):
            accepted = self.client.post("/api/sensors/reading", json={
                **base,
                "device_id": f"esp32_{transport}",
                "board_type": "esp32",
                "transport": transport,
            })
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json()["recorded"]["transport"], transport)

if __name__ == "__main__":
    unittest.main()
