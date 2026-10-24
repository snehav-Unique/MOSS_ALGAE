"""Read live MOSS-ALGAE sensor data from an ESP32 without re-flashing it. Independent of the website.

Usage (from the project folder):
  python tools/esp32_monitor.py scan                      # find the ESP32 on this Wi-Fi network
  python tools/esp32_monitor.py serial [COM5]             # read JSON lines over USB (115200 baud)
  python tools/esp32_monitor.py listen [--port 8000]      # receive readings the board POSTs over Wi-Fi
  python tools/esp32_monitor.py blynk --token TOKEN       # read Blynk virtual pins (--server, --pins)

Stop the dashboard backend first for `serial` (it holds the USB port) and for `listen` on port 8000.
"""
import argparse
import ipaddress
import json
import re
import socket
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# MAC prefixes registered to Espressif (ESP32 / ESP8266 makers); not exhaustive.
ESPRESSIF_OUI = set('''
08:3A:F2 08:B6:1F 08:D1:F9 0C:B8:15 10:52:1C 10:97:BD 18:FE:34 24:0A:C4 24:58:7C 24:62:AB 24:6F:28 24:B2:DE
24:DC:C3 2C:3A:E8 30:83:98 30:AE:A4 30:C6:F7 34:85:18 34:86:5D 34:94:54 34:AB:95 34:B7:DA 3C:61:05 3C:71:BF
3C:E9:0E 40:22:D8 40:91:51 44:17:93 48:27:E2 48:3F:DA 48:E7:29 4C:11:AE 4C:EB:D6 50:02:91 54:43:B2 54:5A:A6
58:BF:25 5C:CF:7F 60:01:94 64:B7:08 64:E8:33 68:C6:3A 70:03:9F 70:B8:F6 78:21:84 78:E3:6D 7C:87:CE 7C:9E:BD
7C:DF:A1 80:7D:3A 84:0D:8E 84:CC:A8 84:F3:EB 8C:AA:B5 8C:CE:4E 90:97:D5 94:3C:C6 94:B9:7E 94:E6:86 98:CD:AC
98:F4:AB A0:20:A6 A0:76:4E A0:B7:65 A4:7B:9D A4:CF:12 A8:03:2A AC:67:B2 AC:D0:74 B0:A7:32 B4:8A:0A B4:E6:2D
B8:D6:1A BC:DD:C2 C0:49:EF C4:4F:33 C4:5B:BE C8:2B:96 C8:C9:A3 CC:50:E3 CC:7B:5C CC:DB:A7 D4:8A:FC D4:F9:8D
D8:A0:1D D8:BF:C0 DC:4F:22 E0:5A:1B E0:98:06 E4:65:B8 E8:68:E7 E8:DB:84 EC:62:60 EC:94:CB EC:FA:BC F0:08:D1
F4:12:FA F4:CF:A2 FC:F5:C4
'''.split())


def show(reading, source):
    """One readable line per reading; unknown shapes are printed raw."""
    stamp = time.strftime('%H:%M:%S')
    if isinstance(reading, dict) and 'inlet_ppm' in reading:
        r = reading
        print(f"{stamp}  intake {r.get('inlet_ppm')} ppm | exhaust {r.get('outlet_ppm')} ppm | efficiency {r.get('efficiency')} % | "
              f"temp {r.get('temperature')} °C | humidity {r.get('humidity')} %   [{r.get('device_id', source)}]", flush=True)
    else:
        print(f'{stamp}  {source}: {reading}', flush=True)


# ---------------- serial ----------------
def cmd_serial(args):
    import serial
    import serial.tools.list_ports
    ports = list(serial.tools.list_ports.comports())
    if not ports and not args.port:
        sys.exit('No COM ports. In Device Manager the ESP32 shows as "CP2102 USB to UART Bridge Controller" with an error:\n'
                 'install the Silicon Labs CP210x driver (silabs.com > USB to UART Bridge VCP Drivers), then replug the board.')
    port = args.port or next((p.device for p in ports if re.search('CP210|CH34|UART|USB', p.description, re.I)), ports[0].device)
    print(f'Reading {port} at {args.baud} baud. Ctrl+C to stop.\n')
    try:
        with serial.Serial(port, args.baud, timeout=2) as ser:
            while True:
                line = ser.readline().decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                payload = line.split('] ', 1)[-1] if line.startswith('[') else line
                try:
                    show(json.loads(payload), port)
                except json.JSONDecodeError:
                    show(line, port)
    except serial.SerialException as e:
        sys.exit(f'Cannot open {port}: {e}\nIf it says "access denied", close the dashboard backend or Arduino Serial Monitor first.')


# ---------------- listen ----------------
def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except socket.gaierror:
        pass
    return sorted(ip for ip in ips if not ip.startswith('127.'))


def cmd_listen(args):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode('utf-8', errors='replace')
            try:
                show(json.loads(body), f'{self.client_address[0]} POST {self.path}')
            except json.JSONDecodeError:
                show(body, f'{self.client_address[0]} POST {self.path}')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

        def log_message(self, *_):
            pass

    ips = ', '.join(local_ips()) or 'unknown'
    print(f'Listening on 0.0.0.0:{args.port} (this laptop: {ips}). Ctrl+C to stop.')
    print('The board only reaches this if its sketch posts to one of those addresses on this port.')
    print('Allow Python through Windows Firewall if prompted.\n')
    try:
        ThreadingHTTPServer(('0.0.0.0', args.port), Handler).serve_forever()
    except OSError as e:
        sys.exit(f'Cannot listen on port {args.port}: {e}\nStop the dashboard backend first, or use --port with another port.')


# ---------------- blynk ----------------
def cmd_blynk(args):
    pins = {}
    for item in args.pins.split(','):
        name, _, pin = item.partition('=')
        pins[name.strip()] = pin.strip().upper()
    base = f'https://{args.server}/external/api'
    query = '&'.join([f'token={args.token}', *pins.values()])
    print(f'Polling {args.server} every {args.interval:g} s. Ctrl+C to stop.\n')
    while True:
        try:
            online = urllib.request.urlopen(f'{base}/isHardwareConnected?token={args.token}', timeout=10).read().decode().strip()
            values = json.loads(urllib.request.urlopen(f'{base}/get?{query}', timeout=10).read().decode())
            values = {k.upper(): v for k, v in values.items()}
            print(f"{time.strftime('%H:%M:%S')}  device {'ONLINE ' if online == 'true' else 'OFFLINE'} | " +
                  ' | '.join(f'{name} {values.get(pin)}' for name, pin in pins.items()), flush=True)
        except Exception as e:  # keep polling through network blips
            print(f"{time.strftime('%H:%M:%S')}  error: {str(e).replace(args.token, '***')}", flush=True)
        time.sleep(args.interval)


# ---------------- scan ----------------
def wifi_network():
    """IPv4 network of the active adapter, from Windows ipconfig or Unix `ip`."""
    out = subprocess.run(['ipconfig'] if sys.platform == 'win32' else ['ip', '-4', 'addr'], capture_output=True, text=True).stdout
    if sys.platform == 'win32':
        pairs = re.findall(r'IPv4 Address[ .]*: ([\d.]+).*?Subnet Mask[ .]*: ([\d.]+)', out, re.S)
        nets = [ipaddress.ip_network(f'{ip}/{mask}', strict=False) for ip, mask in pairs if not ip.startswith(('127.', '169.254.'))]
    else:
        nets = [ipaddress.ip_network(n, strict=False) for n in re.findall(r'inet ([\d.]+/\d+)', out) if not n.startswith('127.')]
    if not nets:
        sys.exit('No active IPv4 network found.')
    return nets[0]


def arp_table():
    out = subprocess.run(['arp', '-a'], capture_output=True, text=True).stdout
    entries = {}
    for ip, mac in re.findall(r'([\d.]+)\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})', out):
        entries[ip] = mac.upper().replace('-', ':')
    return entries


def probe_http(ip):
    for port in (80, 8080):
        try:
            with urllib.request.urlopen(f'http://{ip}:{port}/', timeout=2) as r:
                return f'HTTP {port}: {r.status} {r.read(200).decode("utf-8", errors="replace")!r}'
        except Exception:
            continue
    return 'no web server on ports 80/8080'


def cmd_scan(args):
    net = wifi_network()
    hosts = list(net.hosts())
    print(f'Scanning {net} ({len(hosts)} addresses) for Espressif (ESP32) devices...')
    # A UDP datagram to each address makes Windows resolve its MAC into the ARP table.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        for ip in hosts:
            try:
                s.sendto(b'', (str(ip), 9))
            except OSError:
                pass
    time.sleep(3)
    entries = arp_table()
    found = {ip: mac for ip, mac in entries.items() if mac[:8] in ESPRESSIF_OUI and ipaddress.ip_address(ip) in net}
    if not found:
        print(f'\nNo Espressif devices found among {len(entries)} visible devices.')
        print('Possible reasons: the ESP32 is on a different Wi-Fi network, it is not connected, or this Wi-Fi')
        print('isolates clients from each other (common on campus / hotspot networks).')
        if args.all:
            for ip, mac in sorted(entries.items()):
                print(f'  {ip:15} {mac}')
        return
    with ThreadPoolExecutor(8) as pool:
        results = dict(zip(found, pool.map(probe_http, found)))
    for ip, mac in found.items():
        print(f'\n  ESP32 candidate {ip}  (MAC {mac})\n    {results[ip]}')
    print('\nThe repo sketches push data rather than serve it; use `listen` or `serial` to read values.')


def main():
    parser = argparse.ArgumentParser(description='Read live ESP32 sensor data without re-flashing.')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('serial', help='read USB serial output')
    p.add_argument('port', nargs='?')
    p.add_argument('--baud', type=int, default=115200)
    p = sub.add_parser('listen', help='receive HTTP POSTs from the board')
    p.add_argument('--port', type=int, default=8000)
    p = sub.add_parser('blynk', help='read Blynk virtual pins')
    p.add_argument('--token', required=True)
    p.add_argument('--server', default='blr1.blynk.cloud')
    p.add_argument('--pins', default='temperature=V0,humidity=V1,sensor1=V2,sensor2=V3')
    p.add_argument('--interval', type=float, default=3)
    p = sub.add_parser('scan', help='find ESP32 boards on this network')
    p.add_argument('--all', action='store_true', help='list every device seen if no ESP32 is found')
    args = parser.parse_args()
    try:
        {'serial': cmd_serial, 'listen': cmd_listen, 'blynk': cmd_blynk, 'scan': cmd_scan}[args.command](args)
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
