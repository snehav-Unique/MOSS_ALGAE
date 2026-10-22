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

  # Run deterministic model mode from explicit inputs (no hardware required):
  python backend/sensor_bridge.py --mock --inlet-ppm 500 --moss-efficiency 40 --algae-efficiency 25 --airflow-m3-h 50 --chamber-volume-m3 1
"""

import sys
import time
import json
import math
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

def run_model_stream(api_url: str, inlet: float, moss_efficiency: float, algae_efficiency: float, airflow: float, chamber_volume: float, temperature: float | None, humidity: float | None):
    combined_efficiency = 1.0 - (1.0 - moss_efficiency / 100.0) * (1.0 - algae_efficiency / 100.0)
    target_outlet = inlet * (1.0 - combined_efficiency)
    residence_time_seconds = chamber_volume / airflow * 3600.0
    elapsed_seconds = 0.0
    print("Starting deterministic MOSS-ALGAE model stream...")
    print(f"Forwarding model-derived telemetry to: {api_url}")
    print("Press Ctrl+C to stop.\n")

    while True:
        try:
            outlet = round(target_outlet + (inlet - target_outlet) * math.exp(-elapsed_seconds / residence_time_seconds), 2)
            efficiency = round((inlet - outlet) / inlet * 100.0, 2)
            payload = {
                "inlet_ppm": inlet,
                "outlet_ppm": outlet,
                "efficiency": efficiency,
                "temperature": temperature,
                "humidity": humidity,
                "device_id": "two_stage_input_model",
                "board_type": "simulator",
                "transport": "simulation"
            }

            ok = post_to_backend(payload, api_url)
            status_mark = "✅ POST 200" if ok else "❌ FAIL"
            print(f"{status_mark} | Inlet: {inlet:6.1f} ppm | Outlet: {outlet:6.1f} ppm | Efficiency: {efficiency:5.1f}%")
            time.sleep(2.0)
            elapsed_seconds += 2.0
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
        print("   python backend/sensor_bridge.py --mock --inlet-ppm 500 --moss-efficiency 40 --algae-efficiency 25 --airflow-m3-h 50 --chamber-volume-m3 1")
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
    parser.add_argument("--mock", action="store_true", help="Run deterministic model telemetry from explicit inputs")
    parser.add_argument("--inlet-ppm", type=float, help="Required inlet concentration for --mock")
    parser.add_argument("--moss-efficiency", type=float, default=0.0, help="Moss efficiency percent for --mock")
    parser.add_argument("--algae-efficiency", type=float, default=0.0, help="Algae efficiency percent for --mock")
    parser.add_argument("--airflow-m3-h", type=float, help="Required airflow for the smooth model curve")
    parser.add_argument("--chamber-volume-m3", type=float, help="Required chamber volume for the smooth model curve")
    parser.add_argument("--temperature", type=float, help="Optional chamber temperature for --mock")
    parser.add_argument("--humidity", type=float, help="Optional chamber humidity for --mock")
    parser.add_argument("--board", choices=["arduino", "esp32"], default="arduino", help="Connected controller type")
    parser.add_argument("--transport", choices=["wired", "bluetooth"], default="wired", help="Serial transport; Bluetooth is ESP32-only")
    args = parser.parse_args()

    if args.board == "arduino" and args.transport != "wired":
        parser.error("Arduino supports wired USB serial only; use --board esp32 for Bluetooth")

    if args.mock:
        if args.inlet_ppm is None or args.inlet_ppm <= 0:
            parser.error("--mock requires --inlet-ppm greater than zero")
        if not 0 <= args.moss_efficiency <= 100 or not 0 <= args.algae_efficiency <= 100:
            parser.error("model efficiencies must be between 0 and 100")
        if args.airflow_m3_h is None or args.airflow_m3_h <= 0:
            parser.error("--mock requires --airflow-m3-h greater than zero")
        if args.chamber_volume_m3 is None or args.chamber_volume_m3 <= 0:
            parser.error("--mock requires --chamber-volume-m3 greater than zero")
        if args.humidity is not None and not 0 <= args.humidity <= 100:
            parser.error("humidity must be between 0 and 100")
        run_model_stream(args.api_url, args.inlet_ppm, args.moss_efficiency, args.algae_efficiency, args.airflow_m3_h, args.chamber_volume_m3, args.temperature, args.humidity)
    else:
        run_serial_stream(args.port, args.baud, args.api_url, args.board, args.transport)
