"""Forward live ESP32 readings from this laptop to the deployed (Vercel) app.

The local backend reads the ESP32 over USB; this script sends each new real reading to
{target}/api/sensors/relay every few seconds, where the deployed API stores it in Firestore
for every viewer of the Sensors tab.

Usage (from the project folder, with the local backend running):
  python tools/sensor_relay.py --target https://your-app.vercel.app
Settings can also come from .env: RELAY_TARGET_URL and SENSOR_RELAY_KEY (must match the key set in Vercel).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def load_env(path):
    try:
        for line in Path(path).read_text(encoding='utf-8').splitlines():
            key, sep, value = line.strip().partition('=')
            if sep and key and not key.startswith('#') and key not in os.environ:
                os.environ[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass


def request(url, payload=None, key=None, timeout=10):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
    req.add_header('Content-Type', 'application/json')
    if key:
        req.add_header('X-Relay-Key', key)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode())


def main():
    load_env(Path(__file__).resolve().parent.parent / '.env')
    parser = argparse.ArgumentParser(description='Relay live ESP32 readings to the deployed app.')
    parser.add_argument('--target', default=os.getenv('RELAY_TARGET_URL', ''), help='deployed app URL, e.g. https://your-app.vercel.app')
    parser.add_argument('--key', default=os.getenv('SENSOR_RELAY_KEY', ''), help='must match SENSOR_RELAY_KEY on Vercel')
    parser.add_argument('--local', default='http://127.0.0.1:8000', help='local backend that reads the ESP32')
    parser.add_argument('--interval', type=float, default=1.0,
                        help='seconds between checks of the local backend; only new readings are sent (~1 per 2 s from the ESP32)')
    args = parser.parse_args()
    if not args.target or not args.key:
        sys.exit('Set --target (or RELAY_TARGET_URL) and --key (or SENSOR_RELAY_KEY).')
    target = args.target.rstrip('/') + '/api/sensors/relay'
    disconnect_target = target + '/disconnect'
    print(f'Relaying {args.local} -> {target} every {args.interval:g} s. Ctrl+C to stop.\n')

    last_sent = None
    disconnect_reported_at = 0.0
    while True:
        stamp = time.strftime('%H:%M:%S')
        try:
            live = request(args.local.rstrip('/') + '/api/sensors/live')
            latest = live.get('latest') or {}
            if live.get('sensor_issue'):
                print(f'{stamp}  sensor problem: {live["sensor_issue"]}', flush=True)
            elif not live.get('connected'):
                # Tell viewers right away (and every 30 s) that the board is unplugged.
                if time.time() - disconnect_reported_at > 30:
                    request(disconnect_target, {}, args.key)
                    disconnect_reported_at = time.time()
                    print(f'{stamp}  ESP32 disconnected: the deployed app now shows "disconnected"', flush=True)
                else:
                    print(f'{stamp}  waiting for the ESP32 to reconnect...', flush=True)
                last_sent = None
            elif latest.get('board_type') == 'simulator' or 'inlet_raw' not in latest:
                print(f'{stamp}  waiting for live ESP32 readings on the local backend...', flush=True)
            elif latest.get('timestamp') != last_sent:
                payload = {
                    # Already calibrated ppm CO2 on this laptop; the deployed app stores them unchanged.
                    'inlet_ppm': latest['inlet_ppm'], 'outlet_ppm': latest['outlet_ppm'], 'calibrated': True,
                    'temperature': latest.get('temperature'), 'humidity': latest.get('humidity'),
                    'device_id': latest.get('device_id') or 'esp32', 'board_type': latest.get('board_type', 'esp32'),
                    'transport': latest.get('transport', 'wired'),
                }
                result = request(target, payload, args.key)
                recorded = result.get('recorded') or {}
                print(f"{stamp}  sent: intake {recorded.get('inlet_ppm')} | exhaust {recorded.get('outlet_ppm')} ppm CO2 | "
                      f"{recorded.get('temperature')} °C | {recorded.get('humidity')} %", flush=True)
                last_sent = latest.get('timestamp')
                disconnect_reported_at = 0.0
        except urllib.error.HTTPError as e:
            hint = ' (relay key does not match SENSOR_RELAY_KEY on Vercel)' if e.code == 401 else ''
            print(f'{stamp}  deployed app answered HTTP {e.code}{hint}', flush=True)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f'{stamp}  connection problem: {getattr(e, "reason", e)}', flush=True)
        time.sleep(args.interval)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped.')
