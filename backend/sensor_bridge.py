#!/usr/bin/env python3
"""
MOSS-ALGAE INDIA: Real-Time Hardware Sensor Bridge
Reads dual MQ-135 (Inlet/Outlet) and DHT22 telemetry from Arduino via USB Serial,
and posts readings to the FastAPI backend service.

Usage:
  # Auto-detect Arduino serial port:
  python backend/sensor_bridge.py

  # Specify serial port manually:
  python backend/sensor_bridge.py --port /dev/cu.usbserial-110 (macOS)
  python backend/sensor_bridge.py --port COM3 (Windows)

  # Run in simulated/mock mode (no Arduino hardware required):
  python backend/sensor_bridge.py --mock
"""

import sys
import time
import json
import argparse
import urllib.request
import urllib.error

DEFAULT_API_URL = "http://127.0.0.1:8000/api/sensors/reading"
DEFAULT_BAUD = 115200

def post_to_backend(data: dict, api_url: str = DEFAULT_API_URL) -> bool:
    try:
        req = urllib.request.Request(
            api_url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        print(f"⚠️  Backend not reachable at {api_url}: {e.reason}")
        return False
    except Exception as e:
        print(f"⚠️  Error posting to backend: {e}")
        return False

def run_mock_stream(api_url: str):
    import random
    print("🌿 Starting MOSS-ALGAE Mock Sensor Stream (Demo Mode)...")
    print(f"📡 Forwarding simulated telemetry to: {api_url}")
    print("Press Ctrl+C to stop.\n")

    inlet_base = 450.0
    while True:
        try:
            # Simulate natural fluctuating ambient air pollution
            inlet = round(inlet_base + random.uniform(-25.0, 35.0), 2)
            # Living biofilter achieves 30-45% removal efficiency
            eff = round(random.uniform(34.0, 42.5), 2)
            outlet = round(inlet * (1.0 - eff / 100.0), 2)
            # Healthy chamber temperature (22-26 C) and high humidity (68-78% RH)
            temp = round(23.5 + random.uniform(-1.0, 1.2), 1)
            hum = round(72.0 + random.uniform(-3.5, 4.0), 1)

            payload = {
                "inlet_ppm": inlet,
                "outlet_ppm": outlet,
                "efficiency": eff,
                "temperature": temp,
                "humidity": hum,
                "device_id": "simulated_chamber_rig",
                "board_type": "simulator",
                "transport": "simulation"
            }

            ok = post_to_backend(payload, api_url)
            status_mark = "✅ POST 200" if ok else "❌ FAIL"
            print(f"{status_mark} | Inlet: {inlet:6.1f} ppm | Outlet: {outlet:6.1f} ppm | Efficiency: {eff:5.1f}% | Temp: {temp:4.1f}°C | Hum: {hum:4.1f}%")
            time.sleep(2.0)
        except KeyboardInterrupt:
            print("\nStopped mock stream.")
            break

def run_serial_stream(port: str, baud: int, api_url: str, board: str, transport: str):
    try:
        import serial
        import serial.tools.list_ports
    except ImportError:
        print("❌ 'pyserial' is not installed. Install it with:")
        print("   pip install pyserial")
        print("\nOr test with simulated mode:")
        print("   python backend/sensor_bridge.py --mock")
        sys.exit(1)

    if not port:
        ports = list(serial.tools.list_ports.comports())
        if not ports:
            print("⚠️  No serial devices detected.")
            print("   Please connect your Arduino via USB or run with --mock")
            sys.exit(1)
        print("Found serial ports:")
        for idx, p in enumerate(ports):
            print(f"  [{idx}] {p.device} - {p.description}")
        port = ports[0].device
        print(f"Auto-selected first port: {port}\n")

    print(f"🔌 Opening serial port {port} at {baud} baud...")
    try:
        ser = serial.Serial(port, baud, timeout=2.0)
    except Exception as e:
        print(f"❌ Could not open port {port}: {e}")
        print("Check if Arduino IDE Serial Monitor is open and close it first.")
        sys.exit(1)

    print("🌿 Connected to Arduino! Listening for JSON sensor stream...")
    print("Format expected: {\"inlet_ppm\":...,\"outlet_ppm\":...,\"efficiency\":...,\"temperature\":...,\"humidity\":...}\n")

    while True:
        try:
            line = ser.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if line.startswith("{") and line.endswith("}"):
                try:
                    payload = json.loads(line)
                    payload["board_type"] = board
                    payload["transport"] = transport
                    payload.setdefault("device_id", f"{board}_{transport}_{port}")
                    ok = post_to_backend(payload, api_url)
                    inlet = payload.get("inlet_ppm", "N/A")
                    outlet = payload.get("outlet_ppm", "N/A")
                    eff = payload.get("efficiency", "N/A")
                    temp = payload.get("temperature", "N/A")
                    hum = payload.get("humidity", "N/A")

                    status_mark = "✅ POST" if ok else "❌ NO-BACKEND"
                    print(f"{status_mark} | Inlet: {inlet} ppm | Outlet: {outlet} ppm | Eff: {eff}% | Temp: {temp}°C | Hum: {hum}%")
                except json.JSONDecodeError:
                    print(f"Raw: {line}")
            else:
                print(f"[Arduino Boot/Debug]: {line}")

        except KeyboardInterrupt:
            print("\nClosing serial connection.")
            ser.close()
            break
        except Exception as e:
            print(f"⚠️ Read error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MOSS-ALGAE Chamber Sensor Bridge")
    parser.add_argument("--port", type=str, help="Serial port (e.g. /dev/cu.usbserial-110 or COM3)")
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD, help="Baud rate (default 115200)")
    parser.add_argument("--api-url", type=str, default=DEFAULT_API_URL, help="FastAPI endpoint URL")
    parser.add_argument("--mock", action="store_true", help="Run simulated telemetry generator")
    parser.add_argument("--board", choices=["arduino", "esp32"], default="arduino", help="Connected controller type")
    parser.add_argument("--transport", choices=["wired", "bluetooth"], default="wired", help="Serial transport; Bluetooth is ESP32-only")
    args = parser.parse_args()

    if args.board == "arduino" and args.transport != "wired":
        parser.error("Arduino supports wired USB serial only; use --board esp32 for Bluetooth")

    if args.mock:
        run_mock_stream(args.api_url)
    else:
        run_serial_stream(args.port, args.baud, args.api_url, args.board, args.transport)
