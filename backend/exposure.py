"""Sensitive receptors (schools, health facilities, bus stops) near candidate sites from OpenStreetMap.

Run directly to refresh the bundled frontend snapshot:
    python backend/exposure.py
"""
import asyncio
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
USER_AGENT = 'moss-algae-india/1.0 (urban air planning prototype)'
RADIUS_M = 500

SITES = [
    {'id': 'peenya', 'name': 'Peenya', 'lat': 13.0296, 'lng': 77.5199},
    {'id': 'yeshwanthpur', 'name': 'Yeshwanthpur', 'lat': 13.0285, 'lng': 77.5409},
    {'id': 'majestic', 'name': 'Majestic', 'lat': 12.9767, 'lng': 77.5713},
    {'id': 'hebbal', 'name': 'Hebbal', 'lat': 13.0358, 'lng': 77.5970},
    {'id': 'kr-puram', 'name': 'KR Puram', 'lat': 13.0004, 'lng': 77.6952},
    {'id': 'whitefield', 'name': 'Whitefield', 'lat': 12.9698, 'lng': 77.7500},
    {'id': 'silk-board', 'name': 'Silk Board', 'lat': 12.9177, 'lng': 77.6233},
    {'id': 'jayanagar', 'name': 'Jayanagar', 'lat': 12.9250, 'lng': 77.5938},
    {'id': 'rr-nagar', 'name': 'RR Nagar', 'lat': 12.9250, 'lng': 77.4992},
    {'id': 'vijayanagar', 'name': 'Vijayanagar', 'lat': 12.9719, 'lng': 77.5299},
    {'id': 'jp-nagar', 'name': 'JP Nagar', 'lat': 12.9063, 'lng': 77.5857},
    {'id': 'sarjapur', 'name': 'Sarjapur', 'lat': 12.8600, 'lng': 77.7860},
]


def _distance_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _kind(tags):
    amenity = tags.get('amenity')
    if amenity in ('school', 'kindergarten'): return 'school'
    if amenity in ('hospital', 'clinic'): return 'health'
    if tags.get('highway') == 'bus_stop': return 'bus_stop'
    return None


def _query(sites, radius):
    clauses = ''.join(
        f'nwr["amenity"~"^(school|kindergarten|hospital|clinic)$"](around:{radius},{s["lat"]},{s["lng"]});'
        f'node["highway"="bus_stop"](around:{radius},{s["lat"]},{s["lng"]});'
        for s in sites
    )
    return f'[out:json][timeout:60];({clauses});out center;'


def summarize(elements, sites=SITES, radius=RADIUS_M):
    result = {s['id']: {'school': 0, 'health': 0, 'bus_stop': 0, 'features': []} for s in sites}
    for element in elements:
        tags = element.get('tags', {})
        kind = _kind(tags)
        lat = element.get('lat', element.get('center', {}).get('lat'))
        lng = element.get('lon', element.get('center', {}).get('lon'))
        if kind is None or lat is None or lng is None:
            continue
        for s in sites:
            if _distance_m(s['lat'], s['lng'], lat, lng) <= radius:
                bucket = result[s['id']]
                bucket[kind] += 1
                bucket['features'].append({'kind': kind, 'lat': round(lat, 6), 'lng': round(lng, 6), 'name': tags.get('name')})
    return result


async def fetch_exposure(sites=SITES, radius=RADIUS_M, attempts=3):
    query = _query(sites, radius)
    last_error = None
    async with httpx.AsyncClient(timeout=90, headers={'User-Agent': USER_AGENT}) as client:
        for attempt in range(attempts):
            for url in OVERPASS_MIRRORS:
                try:
                    response = await client.post(url, data={'data': query})
                    response.raise_for_status()
                    elements = response.json().get('elements', [])
                    return {
                        'radius_m': radius,
                        'sites': summarize(elements, sites, radius),
                        'source': url,
                        'retrieved_at': datetime.now(timezone.utc).isoformat(),
                        'note': 'OpenStreetMap features; completeness varies by area. Counts are receptors, not population.',
                    }
                except (httpx.HTTPError, ValueError) as error:
                    last_error = error
            await asyncio.sleep(2 ** attempt * 5)
    raise RuntimeError(f'All Overpass mirrors failed: {last_error}')


SNAPSHOT_PATH = Path(__file__).resolve().parent / 'exposure_snapshot.json'


def load_snapshot():
    """Bundled copy for when every Overpass mirror is busy."""
    return json.loads(SNAPSHOT_PATH.read_text(encoding='utf-8'))


if __name__ == '__main__':
    data = asyncio.run(fetch_exposure(attempts=6))
    for target in (SNAPSHOT_PATH, SNAPSHOT_PATH.parent.parent / 'public' / 'exposure-snapshot.json'):
        target.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    counts = {k: (v['school'], v['health'], v['bus_stop']) for k, v in data['sites'].items()}
    print(f'Wrote snapshots from {data["source"]}: {counts}', file=sys.stderr)
