from __future__ import annotations

import asyncio
import os
import statistics
import threading
import time
import json
import math
import hmac
from datetime import datetime, timezone
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from typing import Literal, Optional

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError:
    firebase_admin = credentials = firestore = None

import sys
from pathlib import Path

# Ensure backend directory is in sys.path for local module imports
_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

# Load local server-only settings when the API is started from either the
# repository root or backend directory. Real service environment variables
# retain precedence over values in this file.
load_dotenv(Path(__file__).resolve().parents[1] / '.env')

try:
    import serial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False

try:
    from .model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture, series_efficiency
    from .exposure import SITES, fetch_exposure, load_snapshot
    from .assistant import AssistantUnavailable, ask
    from . import gemini_assistant
except ImportError:
    from model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture, series_efficiency
    from exposure import SITES, fetch_exposure, load_snapshot
    from assistant import AssistantUnavailable, ask
    import gemini_assistant


def load_env_file(path):
    """Read KEY=value lines from a local .env (git-ignored); real environment variables take precedence."""
    try:
        lines = open(path, encoding='utf-8').read().splitlines()
    except OSError:
        return
    for line in lines:
        key, sep, value = line.strip().partition('=')
        if sep and key and not key.startswith('#') and value.strip() and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip('"').strip("'")

load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'))

app=FastAPI(title='MOSS–ALGAE INDIA',version='0.1.0')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['GET','POST'],allow_headers=['Content-Type','Authorization','X-Owner-Key'])


@app.get('/health')
def health(): return {'status':'ok','calibration':'not supplied'}

@app.get('/api/air-quality/hourly')
async def hourly_air_quality(latitude: float, longitude: float, past_days: int = 0, forecast_days: int = 3):
    """Proxy Open-Meteo so browser network/CORS restrictions do not blank forecast views."""
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise HTTPException(422, 'Invalid latitude or longitude')
    if not 0 <= past_days <= 92 or not 0 <= forecast_days <= 7 or past_days + forecast_days == 0:
        raise HTTPException(422, 'past_days must be 0-92 and forecast_days must be 0-7')
    params = {
        'latitude': latitude,
        'longitude': longitude,
        'hourly': 'pm2_5,us_aqi',
        'past_days': past_days,
        'forecast_days': forecast_days,
        'timezone': 'GMT',
        'timeformat': 'unixtime',
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get('https://air-quality-api.open-meteo.com/v1/air-quality', params=params)
            response.raise_for_status()
        hourly = response.json().get('hourly', {})
        times, pm25_values = hourly.get('time', []), hourly.get('pm2_5', [])
        aqi_values = hourly.get('us_aqi', [])
        if not times or len(times) != len(pm25_values):
            raise ValueError('Open-Meteo returned no hourly PM2.5 series')
        points = []
        for index, (timestamp, pm25) in enumerate(zip(times, pm25_values)):
            if pm25 is None or not math.isfinite(float(pm25)):
                continue
            aqi = aqi_values[index] if index < len(aqi_values) else None
            points.append({
                'time': datetime.fromtimestamp(int(timestamp), timezone.utc).isoformat().replace('+00:00', 'Z'),
                'pm25': float(pm25),
                'aqi': float(aqi) if aqi is not None and math.isfinite(float(aqi)) else None,
            })
        if not points:
            raise ValueError('Open-Meteo returned no usable hourly PM2.5 values')
        return {'source': 'Open-Meteo CAMS', 'points': points}
    except (httpx.HTTPError, KeyError, TypeError, ValueError, OverflowError) as error:
        raise HTTPException(502, 'Open-Meteo forecast is temporarily unavailable') from error

@app.get('/api/observations')
async def observations():
    checked=datetime.now(timezone.utc).isoformat()
    key=os.getenv('OPENAQ_API_KEY')
    ids=[v for v in os.getenv('OPENAQ_LOCATION_IDS','').split(',') if v.isdigit()][:20]
    if not key:
        return {'status':'OpenAQ API key required','observations':[],'checked_at':checked,'source':'https://api.openaq.org/v3'}
    out=[]
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            locations=[]
            if not ids:
                latitude=os.getenv('OPENAQ_LATITUDE','12.9716')
                longitude=os.getenv('OPENAQ_LONGITUDE','77.5946')
                radius=os.getenv('OPENAQ_RADIUS_METERS','25000')
                nearby=await client.get(
                    'https://api.openaq.org/v3/locations',
                    params={'coordinates':f'{latitude},{longitude}','radius':radius,'limit':20},
                    headers={'X-API-Key':key},
                )
                nearby.raise_for_status()
                locations=[location for location in nearby.json().get('results',[]) if location.get('id')][:20]
                ids=[str(location['id']) for location in locations]
            else:
                for id in ids:
                    meta=await client.get(f'https://api.openaq.org/v3/locations/{id}',headers={'X-API-Key':key});meta.raise_for_status()
                    locations.append(meta.json()['results'][0])

            async def latest_for(location):
                location_id=location['id']
                sensors={s['id']:s['parameter'] for s in location.get('sensors',[])}
                r=await client.get(f'https://api.openaq.org/v3/locations/{location_id}/latest',headers={'X-API-Key':key});r.raise_for_status()
                rows=[]
                for row in r.json().get('results',[]):
                    rows.append({**row,'parameter':sensors.get(row.get('sensorsId')),'location_name':location.get('name'),'provider':location.get('provider'),'source_url':f'https://api.openaq.org/v3/locations/{location_id}/latest','retrieved_at':checked})
                return rows

            results=await asyncio.gather(*(latest_for(location) for location in locations),return_exceptions=True)
            failures=[]
            for result in results:
                if isinstance(result, Exception): failures.append(result)
                else: out.extend(result)
            if locations and len(failures) == len(locations):
                first=failures[0]
                if isinstance(first,httpx.HTTPStatusError): raise first
                raise httpx.RequestError('All OpenAQ station requests failed')
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401,403):
            raise HTTPException(502,'OpenAQ rejected the configured API key')
        raise HTTPException(502,'OpenAQ upstream unavailable or invalid response; no replacement readings generated')
    except (httpx.HTTPError,KeyError,ValueError):
        raise HTTPException(502,'OpenAQ upstream unavailable or invalid response; no replacement readings generated')
    return {'status':'Timestamped observations available' if out else ('No nearby OpenAQ stations found' if not ids else 'No observations returned'),'observations':out,'checked_at':checked,'note':'Check measurement time before use; latest may be stale. No interpolation or AQI conversion.'}

class Capture(BaseModel):
    pollutant: str
    airflow_m3_h: float=Field(ge=0)
    efficiency: float=Field(ge=0,le=1)
    concentration_ug_m3: float=Field(ge=0)
    count: int=Field(default=1,ge=0)
    measured_efficiency_samples: list[float]=Field(default_factory=list)

@app.post('/api/twin/capture')
def twin(p:Capture):
    result=capture(p.airflow_m3_h,p.efficiency,p.concentration_ug_m3,p.count)
    try: interval=uncertainty(p.airflow_m3_h,p.measured_efficiency_samples,p.concentration_ug_m3,p.count) if p.measured_efficiency_samples else None
    except ValueError as e: raise HTTPException(422,str(e))
    return {**result,'pollutant':p.pollutant,'interval':interval,'ambient_aqi_change':None,'calibration_status':'user-supplied inputs, not independently validated'}

class Balance(BaseModel):
    initial:float=Field(ge=0)
    background:float=Field(ge=0)
    source_ug_h:float=Field(ge=0)
    ventilation_m3_h:float=Field(ge=0)
    volume_m3:float=Field(gt=0)
    cadr_m3_h:float=Field(ge=0)
    hours:float=Field(ge=0)
    calibration_reference:str=Field(min_length=10)

@app.post('/api/twin/balance')
def balance(p:Balance):
    inputs=p.model_dump(exclude={'calibration_reference'})
    return {'concentration_ug_m3':local_balance(**inputs),'calibration_reference':p.calibration_reference,'validation':'reference supplied by caller; not independently verified','aqi_change':None}

class StagedCapture(BaseModel):
    pollutant: str
    airflow_m3_h: float=Field(ge=0)
    moss_efficiency: float=Field(ge=0,le=1)
    algae_efficiency: float=Field(ge=0,le=1)
    concentration_ug_m3: float=Field(ge=0)
    count: int=Field(default=1,ge=0)

@app.post('/api/twin/stages')
def stages(p:StagedCapture):
    return {**staged_capture(p.airflow_m3_h,p.moss_efficiency,p.algae_efficiency,p.concentration_ug_m3,p.count),'pollutant':p.pollutant,'stage_order':['moss','algae'],'calibration_status':'stage efficiencies supplied by caller; independent validation required'}

class Candidate(BaseModel):
    id:str
    cost:float=Field(ge=0)
    scores:list[float]=Field(min_length=4,max_length=4)
class Optimization(BaseModel):
    candidates:list[Candidate]=Field(min_length=1,max_length=16)
    weights:list[float]=Field(min_length=4,max_length=4)
    budget:float=Field(ge=0)
@app.post('/api/optimize')
def optimization(p:Optimization):
    candidates=[c.model_dump() for c in p.candidates]
    try:
        result=optimize(candidates,p.weights,p.budget)
        result['sensitivity']=[{'criterion':i,'result':optimize(candidates,[v*1.2 if j==i else v for j,v in enumerate(p.weights)],p.budget)} for i in range(4)]
        return result
    except ValueError as e: raise HTTPException(422,str(e))

class Economics(BaseModel):
    capex:float=Field(ge=0)
    annual_energy_kwh:float=Field(ge=0)
    tariff:float=Field(ge=0)
    annual_maintenance:float=Field(ge=0)
    years:int=Field(ge=1,le=100)
    discount:float=Field(ge=0,le=1)
@app.post('/api/economics')
def economics(p:Economics):return {'discounted_cost_inr':lifecycle(**p.model_dump()),'benefit_monetization':None,'note':'No health benefits monetized without validated exposure-response evidence'}

# --- SENSITIVE RECEPTORS NEAR CANDIDATE SITES (OpenStreetMap / Overpass) ---
exposure_cache: dict = {'data': None, 'fetched': 0.0}

@app.get('/api/exposure')
async def exposure():
    if exposure_cache['data'] and time.time() - exposure_cache['fetched'] < 86400:
        return exposure_cache['data']
    # Overpass can take over a minute; answer from the snapshot now and refresh in the background.
    if not exposure_cache.get('refreshing'):
        exposure_cache['refreshing'] = True
        asyncio.create_task(refresh_exposure())
    return exposure_cache['data'] or {**load_snapshot(), 'mode': 'snapshot'}

async def refresh_exposure():
    try:
        exposure_cache.update(data=await fetch_exposure(attempts=1), fetched=time.time())
    except RuntimeError:
        pass
    finally:
        exposure_cache['refreshing'] = False

# --- CITY HOTSPOTS FROM MEASURED STATIONS (OpenAQ v3) ---
BENGALURU_CENTER = (12.9716, 77.5946)
NAAQS_PM25_24H = 60
WHO_PM25_24H = 15
STALE_AFTER_HOURS = 3
hotspot_cache: dict = {'data': None, 'fetched': 0.0}

def assess_stations(stations: list, now: datetime) -> list:
    """Adds age, staleness, outlier and hotspot flags. Thresholds are 24-h standards applied to latest values (indicative)."""
    values = [s['pm25'] for s in stations if s['pm25'] is not None and s['pm25'] >= 0]
    median = statistics.median(values) if values else None
    for s in stations:
        flags = []
        measured = datetime.fromisoformat(s['measured_at'].replace('Z', '+00:00')) if s.get('measured_at') else None
        s['age_hours'] = round((now - measured).total_seconds() / 3600, 1) if measured else None
        if s['age_hours'] is None or s['age_hours'] > STALE_AFTER_HOURS: flags.append('stale')
        if s['pm25'] is None or s['pm25'] < 0 or s['pm25'] > 1000: flags.append('invalid')
        elif median and len(values) >= 4 and s['pm25'] > 3 * median: flags.append('outlier')
        s['flags'] = flags
        usable = not flags
        s['status'] = ('hotspot' if s['pm25'] > NAAQS_PM25_24H else 'elevated' if s['pm25'] > WHO_PM25_24H else 'within_who') if usable else 'unverified'
    return stations

@app.get('/api/hotspots')
async def hotspots():
    if hotspot_cache['data'] and time.time() - hotspot_cache['fetched'] < 600:
        return hotspot_cache['data']
    now = datetime.now(timezone.utc)
    key = os.getenv('OPENAQ_API_KEY')
    if not key:
        return {'status': 'OpenAQ configuration required', 'stations': [], 'checked_at': now.isoformat()}
    headers = {'X-API-Key': key}
    try:
        async with httpx.AsyncClient(timeout=20, headers=headers) as client:
            r = await client.get('https://api.openaq.org/v3/locations', params={'coordinates': f'{BENGALURU_CENTER[0]},{BENGALURU_CENTER[1]}', 'radius': 25000, 'parameters_id': 2, 'limit': 100})
            r.raise_for_status()
            locations = [l for l in r.json().get('results', []) if not l.get('isMobile')][:25]
            gate = asyncio.Semaphore(5)

            async def latest(location):
                pm_sensors = {s['id'] for s in location.get('sensors', []) if s.get('parameter', {}).get('name') == 'pm25'}
                async with gate:
                    resp = await client.get(f"https://api.openaq.org/v3/locations/{location['id']}/latest")
                if resp.status_code != 200:
                    return None
                rows = [row for row in resp.json().get('results', []) if row.get('sensorsId') in pm_sensors]
                if not rows:
                    return None
                row = max(rows, key=lambda x: x.get('datetime', {}).get('utc') or '')
                return {
                    'id': location['id'],
                    'name': location.get('name'),
                    'provider': (location.get('provider') or {}).get('name'),
                    'reference_grade': bool(location.get('isMonitor')),
                    'lat': location['coordinates']['latitude'],
                    'lng': location['coordinates']['longitude'],
                    'pm25': row.get('value'),
                    'measured_at': row.get('datetime', {}).get('utc'),
                    'source_url': f"https://api.openaq.org/v3/locations/{location['id']}/latest",
                }

            stations = [s for s in await asyncio.gather(*(latest(l) for l in locations)) if s]
    except (httpx.HTTPError, KeyError, ValueError):
        raise HTTPException(502, 'OpenAQ upstream unavailable or invalid response; no replacement readings generated')
    data = {
        'status': 'ok' if stations else 'No PM2.5 stations returned',
        'stations': assess_stations(stations, now),
        'checked_at': now.isoformat(),
        'thresholds': {'naaqs_24h': NAAQS_PM25_24H, 'who_24h': WHO_PM25_24H, 'stale_after_hours': STALE_AFTER_HOURS},
        'note': 'Latest hourly values compared against 24-hour standards; indicative only. No interpolation.',
    }
    hotspot_cache.update(data=data, fetched=time.time())
    return data

# --- PLANNING ASSISTANT (Claude with the platform's own tools) ---
SITE_NAMES = {s['id']: s['name'] for s in SITES}
CRITERIA = ['cost efficiency', 'exposure', 'feasibility', 'equity']

class ChatTurn(BaseModel):
    role: str = Field(pattern='^(user|assistant)$')
    text: str = Field(min_length=1, max_length=4000)

class AssistantRequest(BaseModel):
    history: list[ChatTurn] = Field(min_length=1, max_length=20)
    planner: Optional[dict] = None

def assistant_handlers(planner: Optional[dict]) -> dict:
    async def get_planner_state(_):
        if not planner:
            return {'error': 'The Planner has not been opened in this browser session yet, so no candidate scores are loaded. Ask the user to open the Planner tab once.'}
        return planner

    async def optimize_deployment(args):
        if not planner or not planner.get('candidates'):
            return await get_planner_state(args)
        candidates = [{'id': c['id'], 'cost': c['cost'], 'scores': c['scores']} for c in planner['candidates']]
        weights = args['weights']
        base = optimize(candidates, weights, args['budget_inr'])
        cost = {c['id']: c['cost'] for c in candidates}
        def names(ids): return [SITE_NAMES.get(i, i) for i in ids]
        shifts = []
        for i in range(4):
            alt = optimize(candidates, [w * 1.2 if j == i else w for j, w in enumerate(weights)], args['budget_inr'])
            shifts.append({'criterion_raised_20pct': CRITERIA[i], 'adds': names(set(alt['selected']) - set(base['selected'])), 'drops': names(set(base['selected']) - set(alt['selected']))})
        return {'selected': names(base['selected']), 'spend_inr': sum(cost[i] for i in base['selected']), 'budget_inr': args['budget_inr'],
                'pods': len(base['selected']) * planner.get('pods_per_site', 0), 'weighted_score': round(base['utility'], 3), 'sensitivity': shifts}

    async def lifecycle_cost(args):
        energy = args['pods'] * args['fan_watts_per_pod'] * args['full_power_hours_per_day'] * 365 / 1000
        total = lifecycle(args['capex_inr'], energy, args['tariff_inr_per_kwh'], args['pods'] * args['maintenance_inr_per_pod_year'], args['years'], args['discount_rate'])
        return {'discounted_lifecycle_cost_inr': round(total), 'annual_energy_kwh': round(energy, 1), 'note': 'No health benefits monetized.'}

    async def get_city_hotspots(_):
        data = await hotspots()
        stations = data.get('stations', [])
        counts = {k: sum(1 for s in stations if s['status'] == k) for k in ('hotspot', 'elevated', 'within_who', 'unverified')}
        worst = sorted(stations, key=lambda s: -(s['pm25'] or 0))[:10]
        top = [{k: s.get(k) for k in ('name', 'pm25', 'status', 'age_hours', 'flags', 'provider')} for s in worst]
        return {'status': data.get('status'), 'counts': counts, 'worst_stations': top, 'note': data.get('note')}

    async def get_site_receptors(_):
        data = await exposure()
        return {'radius_m': data['radius_m'], 'source': data.get('mode', data['source']), 'retrieved_at': data['retrieved_at'],
                'sites': {SITE_NAMES.get(k, k): {'schools': v['school'], 'health_facilities': v['health'], 'bus_stops': v['bus_stop']} for k, v in data['sites'].items()}}

    async def get_site_air(args):
        site = next(s for s in SITES if s['id'] == args['site_id'])
        params = {'latitude': site['lat'], 'longitude': site['lng'], 'current': 'pm2_5,us_aqi', 'hourly': 'pm2_5', 'forecast_days': 3, 'timezone': 'auto'}
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get('https://air-quality-api.open-meteo.com/v1/air-quality', params=params)
            r.raise_for_status()
        data = r.json()
        now = data['current']['time']
        hours = [(t, v) for t, v in zip(data['hourly']['time'], data['hourly']['pm2_5']) if v is not None and t >= now][:72]
        peak, clean = max(hours, key=lambda h: h[1]), min(hours, key=lambda h: h[1])
        def readable(t):  # Local time with the weekday spelled out, so the model never computes it.
            return datetime.fromisoformat(t).strftime('%a %d %b, %I:%M %p').replace(' 0', ' ')
        return {'site': site['name'], 'source': 'Open-Meteo modeled (coarse grid)', 'timezone': data.get('timezone'),
                'current': {'pm25_ug_m3': data['current']['pm2_5'], 'us_aqi': data['current']['us_aqi'], 'time': readable(now)},
                'forecast_72h': {'peak': {'pm25_ug_m3': peak[1], 'time': readable(peak[0])}, 'cleanest': {'pm25_ug_m3': clean[1], 'time': readable(clean[0])}, 'mean_ug_m3': round(sum(v for _, v in hours) / len(hours), 1)}}

    return {f.__name__: f for f in (get_planner_state, optimize_deployment, lifecycle_cost, get_city_hotspots, get_site_receptors, get_site_air)}

@app.post('/api/assistant')
async def assistant(req: AssistantRequest):
    if req.history[-1].role != 'user':
        raise HTTPException(422, 'The last turn must be a user question.')
    history, handlers = [t.model_dump() for t in req.history], assistant_handlers(req.planner)
    # Gemini is the default provider; Claude is used only when just an Anthropic key is configured.
    use_claude = bool(os.getenv('ANTHROPIC_API_KEY') or os.getenv('ANTHROPIC_AUTH_TOKEN')) and not gemini_assistant.has_key()
    try:
        return await (ask(history, handlers) if use_claude else gemini_assistant.ask(history, handlers))
    except AssistantUnavailable as e:
        raise HTTPException(503, str(e))

# --- CITIZEN SUGGESTIONS (durable Firestore storage; owner-only reads) ---
class Suggestion(BaseModel):
    lat: float = Field(ge=12.6, le=13.4)
    lng: float = Field(ge=77.3, le=77.9)
    reason: str = Field(min_length=3, max_length=280)

FIREBASE_APP_NAME = 'moss-algae-suggestions'
SUGGESTIONS_COLLECTION = 'pod_suggestions'
_firestore_client = None
_firestore_lock = threading.Lock()

def suggestion_store():
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client
    if firebase_admin is None:
        raise HTTPException(503, 'Firebase Admin is not installed on the API service')
    project_id = os.getenv('FIREBASE_PROJECT_ID', '').strip()
    client_email = os.getenv('FIREBASE_CLIENT_EMAIL', '').strip()
    private_key = os.getenv('FIREBASE_PRIVATE_KEY', '').replace('\\n', '\n').strip()
    if not project_id:
        raise HTTPException(503, 'Firebase is not configured: FIREBASE_PROJECT_ID is missing')
    with _firestore_lock:
        if _firestore_client is not None:
            return _firestore_client
        try:
            app = firebase_admin.get_app(FIREBASE_APP_NAME)
        except ValueError:
            if client_email and private_key:
                credential = credentials.Certificate({
                    'type': 'service_account',
                    'project_id': project_id,
                    'private_key_id': os.getenv('FIREBASE_PRIVATE_KEY_ID', 'configured-in-environment'),
                    'private_key': private_key,
                    'client_email': client_email,
                    'client_id': os.getenv('FIREBASE_CLIENT_ID', ''),
                    'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                    'token_uri': 'https://oauth2.googleapis.com/token',
                    'auth_provider_x509_cert_url': 'https://www.googleapis.com/oauth2/v1/certs',
                    'client_x509_cert_url': f'https://www.googleapis.com/robot/v1/metadata/x509/{client_email.replace("@", "%40")}',
                })
            elif os.getenv('GOOGLE_APPLICATION_CREDENTIALS'):
                credential = credentials.ApplicationDefault()
            else:
                raise HTTPException(503, 'Firebase service-account credentials are not configured')
            app = firebase_admin.initialize_app(credential, {'projectId': project_id}, name=FIREBASE_APP_NAME)
        _firestore_client = firestore.client(app=app)
    return _firestore_client

def owner_only(authorization: Optional[str] = Header(default=None), x_owner_key: Optional[str] = Header(default=None)):
    expected = os.getenv('OWNER_DASHBOARD_KEY', '').strip()
    if not expected:
        raise HTTPException(503, 'Owner dashboard access is not configured')
    supplied = x_owner_key or (authorization[7:] if authorization and authorization.startswith('Bearer ') else '')
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, 'Invalid owner access key', headers={'WWW-Authenticate': 'Bearer'})

def nearest_pod(lat: float, lng: float) -> dict:
    def distance(site):
        lat1, lat2 = math.radians(lat), math.radians(site['lat'])
        dlat, dlng = lat2 - lat1, math.radians(site['lng'] - lng)
        value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
        return 6371 * 2 * math.asin(math.sqrt(value))
    site = min(SITES, key=distance)
    return {'id': site['id'], 'name': site['name'], 'distance_km': round(distance(site), 2)}

@app.post('/api/suggestions')
def add_suggestion(s: Suggestion):
    entry = {**s.model_dump(), 'received_at': datetime.now(timezone.utc).isoformat(), 'nearest_pod': nearest_pod(s.lat, s.lng)}
    try:
        reference = suggestion_store().collection(SUGGESTIONS_COLLECTION).document()
        reference.set(entry)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, 'Could not store the suggestion in Firebase') from error
    return {'status': 'ok', 'id': reference.id}

@app.get('/api/suggestions')
def list_suggestions(_: None = Depends(owner_only)):
    try:
        documents = suggestion_store().collection(SUGGESTIONS_COLLECTION).order_by('received_at', direction='DESCENDING').limit(500).stream()
        suggestions = [{'id': document.id, **document.to_dict()} for document in documents]
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, 'Could not read suggestions from Firebase') from error
    return {'suggestions': suggestions, 'count': len(suggestions), 'storage': 'Firebase Firestore'}

# --- REAL-TIME CHAMBER SENSOR TELEMETRY (MQ-135 & DHT22) ---
class SensorReading(BaseModel):
    inlet_ppm: float = Field(ge=0, description="Raw input air gas concentration (MQ-135 #1)")
    outlet_ppm: float = Field(ge=0, description="Purified output air gas concentration (MQ-135 #2)")
    efficiency: Optional[float] = Field(default=None, ge=0, le=100, description="Calculated single-pass efficiency %")
    temperature: Optional[float] = Field(default=None, description="Chamber temperature in Celsius (DHT22)")
    humidity: Optional[float] = Field(default=None, description="Chamber relative humidity % (DHT22)")
    device_id: str = Field(default="robocraze_chamber_01", description="Microcontroller or station ID")
    board_type: Literal["arduino", "esp32", "simulator"] = "arduino"
    calibrated: bool = Field(default=False, description="True when inlet/outlet are already calibrated ppm CO2 (e.g. relayed)")
    transport: Literal["wired", "wifi", "bluetooth", "simulation"] = "wired"

    @model_validator(mode="after")
    def validate_board_transport(self):
        allowed = {
            "arduino": {"wired"},
            "esp32": {"wired", "wifi", "bluetooth"},
            "simulator": {"simulation"},
        }
        if self.transport not in allowed[self.board_type]:
            raise ValueError(f"{self.board_type} does not support {self.transport} telemetry")
        return self

sensor_telemetry_history: list = []
latest_sensor_reading: dict = None
latest_sensor_received_at: Optional[float] = None

DEVICE_CAPABILITIES = {
    "esp32": ["wifi", "bluetooth", "wired"],
    "arduino": ["wired"],
    "simulator": ["simulation"],
}

def evaluate_chamber_health(temperature: Optional[float], humidity: Optional[float]) -> dict:
    moss_status = "Optimal"
    moss_alert = None
    if humidity is not None:
        if humidity >= 65:
            moss_status = "Optimal Hydration"
        elif humidity >= 50:
            moss_status = "Moderate (Misting Recommended)"
            moss_alert = "Chamber humidity is below 65%. Consider misting the moss matrix."
        else:
            moss_status = "Desiccated / Inactive"
            moss_alert = "Critical: Chamber humidity < 50%. Moss stomata closed; biofiltration paused."

    algae_status = "Optimal"
    algae_alert = None
    if temperature is not None:
        if 20 <= temperature <= 29:
            algae_status = "Optimal Growth"
        elif 15 <= temperature < 20:
            algae_status = "Slow Metabolism (Cool)"
        elif temperature > 32:
            algae_status = "Thermal Stress Warning"
            algae_alert = "Chamber temperature exceeds 32°C. Risk of algal culture decline."
        else:
            algae_status = "Cold Stressed"
            algae_alert = "Chamber temperature below 15°C. Slow photosynthetic uptake."

    return {
        "moss_status": moss_status,
        "moss_alert": moss_alert,
        "algae_status": algae_status,
        "algae_alert": algae_alert
    }

# --- TELEGRAM NOTIFICATIONS & ALERTS DISPATCHER ---
telegram_config = {
    "bot_token": os.getenv("TELEGRAM_BOT_TOKEN", ""),
    "chat_id": os.getenv("TELEGRAM_CHAT_ID", ""),
    "enabled": True,
    "last_sent": None,
    "total_alerts_sent": 0
}
telegram_cooldowns: dict = {}

class TelegramConfigReq(BaseModel):
    bot_token: str
    chat_id: str
    enabled: bool = True

async def send_telegram_msg(token: str, chat_id: str, text: str) -> bool:
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            return resp.status_code == 200
    except Exception as e:
        print(f"⚠️ Telegram dispatch failed: {e}")
        return False

def dispatch_alert_async(message: str, alert_type: str):
    global telegram_config
    if not telegram_config["enabled"] or not telegram_config["bot_token"] or not telegram_config["chat_id"]:
        return
    now = time.time()
    if alert_type in telegram_cooldowns and (now - telegram_cooldowns[alert_type]) < 300:
        return # 5 minute cooldown
    telegram_cooldowns[alert_type] = now

    def _worker():
        import asyncio
        async def _run():
            ok = await send_telegram_msg(telegram_config["bot_token"], telegram_config["chat_id"], message)
            if ok:
                telegram_config["last_sent"] = datetime.now(timezone.utc).isoformat()
                telegram_config["total_alerts_sent"] += 1
        asyncio.run(_run())

    threading.Thread(target=_worker, daemon=True).start()

@app.get('/api/alerts/telegram/config')
def get_telegram_config():
    token = telegram_config["bot_token"]
    masked = f"{token[:5]}...{token[-4:]}" if len(token) > 9 else ("configured" if token else "")
    return {
        "enabled": telegram_config["enabled"],
        "has_token": bool(token),
        "token_masked": masked,
        "chat_id": telegram_config["chat_id"],
        "last_sent": telegram_config["last_sent"],
        "total_alerts_sent": telegram_config["total_alerts_sent"]
    }

@app.post('/api/alerts/telegram/config')
def save_telegram_config(req: TelegramConfigReq):
    global telegram_config
    telegram_config["bot_token"] = req.bot_token.strip()
    telegram_config["chat_id"] = req.chat_id.strip()
    telegram_config["enabled"] = req.enabled
    return {"status": "ok", "message": "Telegram alerts configuration updated"}

@app.post('/api/alerts/telegram/test')
async def test_telegram_alert():
    if not telegram_config["bot_token"] or not telegram_config["chat_id"]:
        raise HTTPException(400, "Please configure both Telegram Bot Token and Chat ID first.")
    msg = (
        "🌿 <b>MOSS–ALGAE INDIA / Telemetry Connected</b>\n\n"
        "✅ Test notification successful! Your chamber is linked to your Telegram.\n"
        "You will receive automatic alerts if:\n"
        "• Temperature > 32°C (Algal Thermal Stress)\n"
        "• Humidity < 45% RH (Moss Desiccation)"
    )
    ok = await send_telegram_msg(telegram_config["bot_token"], telegram_config["chat_id"], msg)
    if not ok:
        raise HTTPException(502, "Failed to send message to Telegram. Verify your Bot Token and Chat ID.")
    telegram_config["last_sent"] = datetime.now(timezone.utc).isoformat()
    telegram_config["total_alerts_sent"] += 1
    return {"status": "ok", "message": "Telegram test alert sent successfully!"}


# Software fresh-air calibration: the MQ-135 sketches only report gas relative to their own start-up air,
# so each sensor's average over the first readings after (re)calibration is taken as fresh air (400 ppm CO2).
CALIBRATION_SAMPLES = 5
BASELINE_FLOOR_PPM = 380.0   # below this the reference has drifted, not the air
BASELINE_ADAPT_RATE = 0.3    # share of the gap closed per reading (~5 readings to settle)
gas_calibration: dict = {'inlet': None, 'outlet': None, 'samples': [], 'at': None}


def calibrate_gas(raw1: float, raw2: float) -> Optional[tuple]:
    """CO2-equivalent ppm for both sensors, or None while the fresh-air reference is still being collected."""
    if gas_calibration['inlet'] is None:
        gas_calibration['samples'].append((raw1, raw2))
        if len(gas_calibration['samples']) < CALIBRATION_SAMPLES:
            return None
        n = len(gas_calibration['samples'])
        gas_calibration.update(inlet=sum(a for a, _ in gas_calibration['samples']) / n,
                               outlet=sum(b for _, b in gas_calibration['samples']) / n,
                               samples=[], at=datetime.now(timezone.utc).isoformat())
    # Automatic baseline correction: air cannot hold less CO2 than fresh outdoor air, so a reading below
    # BASELINE_FLOOR_PPM means the sensor drifted (MQ-135 heaters settle for hours); ease that reference
    # toward the current signal instead of reporting impossible values.
    for key, raw in (('inlet', raw1), ('outlet', raw2)):
        if raw > 0 and raw * FRESH_AIR_CO2_PPM / gas_calibration[key] < BASELINE_FLOOR_PPM:
            gas_calibration[key] = gas_calibration[key] * (1 - BASELINE_ADAPT_RATE) + raw * BASELINE_ADAPT_RATE
    return (round(raw1 * FRESH_AIR_CO2_PPM / gas_calibration['inlet'], 1),
            round(raw2 * FRESH_AIR_CO2_PPM / gas_calibration['outlet'], 1))


@app.post('/api/sensors/calibrate')
def recalibrate_sensors():
    """Take the current air as fresh air (400 ppm) for both gas sensors over the next readings."""
    gas_calibration.update(inlet=None, outlet=None, samples=[], at=None)
    return {'status': 'calibrating', 'samples_needed': CALIBRATION_SAMPLES}


@app.post('/api/sensors/reading')
def ingest_sensor_reading(reading: SensorReading):
    global latest_sensor_reading, latest_sensor_received_at
    raw1 = round(reading.inlet_ppm, 2)
    raw2 = round(reading.outlet_ppm, 2)
    # Physical sensors are shown as measured: sensor 1 (GPIO34) is the intake, sensor 2 (GPIO35) the exhaust.
    if reading.board_type == "simulator":
        pre_filter, post_filter = raw1, raw2
    else:
        if max(raw1, raw2) > SENSOR_SPIKE_PPM:
            sensor_issue.update(message="Electrical spike on a gas sensor (signal jumped to maximum). Check the MQ-135 AOUT/VCC/GND wires.",
                                at=datetime.now(timezone.utc).isoformat())
            return {"status": "ignored", "reason": "sensor spike"}
        if raw1 == 0 and raw2 == 0:
            sensor_issue.update(message="Both gas sensors read 0: the board restarted while the air or wiring was unstable and saved a wrong reference. "
                                        "In fresh air, wait 2-3 minutes, then press EN on the ESP32.",
                                at=datetime.now(timezone.utc).isoformat())
            return {"status": "ignored", "reason": "zero reference"}
        if reading.calibrated or min(raw1, raw2) >= RELATIVE_SCALE_MAX:
            pre_filter, post_filter = raw1, raw2  # already ppm CO2 (relayed or calibrated firmware)
        else:
            calibrated = calibrate_gas(raw1, raw2)
            if calibrated is None:
                sensor_issue.update(message=f"Calibrating gas sensors to the current air as 400 ppm ({len(gas_calibration['samples'])}/{CALIBRATION_SAMPLES})...",
                                    at=datetime.now(timezone.utc).isoformat())
                return {"status": "ignored", "reason": "calibrating"}
            pre_filter, post_filter = calibrated
        sensor_issue.update(message=None, at=None)

    # Measured single-pass efficiency %: (intake - exhaust) / intake * 100
    eff = max(0.0, min(100.0, (pre_filter - post_filter) / pre_filter * 100.0)) if pre_filter > 0 else 0.0

    # DHT22 values are shown only when valid; a missing reading stays missing.
    temp = round(reading.temperature, 1) if reading.temperature is not None and -20.0 < reading.temperature < 80.0 else None
    hum = round(reading.humidity, 1) if reading.humidity is not None and 0.0 < reading.humidity <= 100.0 else None

    timestamp = datetime.now(timezone.utc).isoformat()
    health = evaluate_chamber_health(temp, hum)

    data = {
        "inlet_ppm": pre_filter,
        "outlet_ppm": post_filter,
        "efficiency": round(eff, 2),
        "temperature": temp,
        "humidity": hum,
        "device_id": reading.device_id,
        "board_type": reading.board_type,
        "transport": reading.transport,
        "timestamp": timestamp,
        "health": health,
        "inlet_raw": raw1,
        "outlet_raw": raw2,
        "calibrated_at": gas_calibration['at'] if reading.board_type != "simulator" and not reading.calibrated else None,
    }

    latest_sensor_reading = data
    latest_sensor_received_at = time.monotonic()
    sensor_telemetry_history.append(data)
    if len(sensor_telemetry_history) > 60:
        sensor_telemetry_history.pop(0)

    # Automatic Telegram Alert triggers on critical chamber conditions
    if reading.temperature is not None and reading.temperature > 32.0:
        dispatch_alert_async(
            f"🚨 <b>MOSS–ALGAE CHAMBER ALERT: High Temperature!</b>\n\n"
            f"Chamber temperature reached <b>{reading.temperature}°C</b> (>32°C limit)!\n"
            f"Risk of microalgae culture crash. Please inspect chamber ventilation immediately.",
            "temp_high"
        )
    elif reading.humidity is not None and reading.humidity < 45.0:
        dispatch_alert_async(
            f"⚠️ <b>MOSS–ALGAE CHAMBER ALERT: Low Humidity!</b>\n\n"
            f"Chamber relative humidity dropped to <b>{reading.humidity}%</b> (<45% limit)!\n"
            f"Moss stomata are closed; biofiltration paused. Please activate chamber misting.",
            "hum_low"
        )

    return {"status": "ok", "recorded": data}


FRESH_AIR_CO2_PPM = 400.0
RELATIVE_SCALE_MAX = 50.0         # readings above this are already in ppm
SENSOR_SPIKE_PPM = 100000.0       # anything above this is an electrical spike, not air
sensor_issue: dict = {"message": None, "at": None}
scanner_reading_at: Optional[float] = None  # receive time of the latest reading read by the USB scanner

hardware_serial_state = {
    "active": False,
    "port": None,
    "device_name": None,
    "baud": 115200,
    "last_seen": None,
    "board_type": None,
    "transport": None,
    "scanned_ports": []
}

def serial_auto_scanner_loop():
    """Continuously monitors USB ports; connects immediately when Arduino is plugged in."""
    if not HAS_SERIAL:
        return
    while True:
        try:
            ports = list(serial.tools.list_ports.comports())
            port_list = [{"device": p.device, "description": p.description} for p in ports]
            hardware_serial_state["scanned_ports"] = port_list

            candidate_port = None
            candidate_desc = None
            for p in ports:
                dev = p.device.lower()
                desc = p.description.lower()
                # Skip system default incoming ports that hang
                if "bluetooth-incoming" in dev or "debug-console" in dev or "earbuds" in dev or "airpods" in dev:
                    continue
                # Match Arduino Uno, ESP32 (USB or Bluetooth Serial SPP), CH340, CP210x, FTDI
                if any(k in dev for k in ["usbmodem", "usbserial", "wch", "ttyusb", "ttyacm", "esp32", "moss"]) or \
                   any(k in desc for k in ["arduino", "ch340", "cp210", "ftdi", "usb", "serial", "esp32"]):
                    candidate_port = p.device
                    candidate_desc = p.description
                    break


            if candidate_port:
                hardware_serial_state["device_name"] = candidate_desc
                try:
                    ser = serial.Serial()
                    ser.port, ser.baudrate, ser.timeout = candidate_port, 115200, 2.5
                    # Keep DTR/RTS low so opening the port does not reset the ESP32 (a reset re-zeroes the MQ-135 reference).
                    ser.dtr = False
                    ser.rts = False
                    ser.open()
                    with ser:
                        hardware_serial_state["active"] = True
                        hardware_serial_state["port"] = candidate_port
                        # Plain ASCII: on Windows an emoji here raises UnicodeEncodeError when output is redirected, killing the reader.
                        print(f"[AUTO-SERIAL] Physical board connected on {candidate_port} ({candidate_desc})", flush=True)
                        while True:
                            line = ser.readline().decode('utf-8', errors='ignore').strip()
                            if not line:
                                continue
                            if line.startswith('{') and line.endswith('}'):
                                try:
                                    payload = json.loads(line)
                                    if "inlet_ppm" in payload and "outlet_ppm" in payload:
                                        hardware_serial_state["last_seen"] = datetime.now(timezone.utc).isoformat()
                                        payload_device = str(payload.get("device_id", "")).lower()
                                        is_bluetooth = (
                                            "bluetooth" in candidate_port.lower()
                                            or "bluetooth" in candidate_desc.lower()
                                            or "moss_algae" in candidate_port.lower()
                                        )
                                        board_type = "esp32" if "esp32" in payload_device or "esp32" in candidate_desc.lower() or is_bluetooth else "arduino"
                                        transport = "bluetooth" if is_bluetooth else "wired"
                                        hardware_serial_state["board_type"] = board_type
                                        hardware_serial_state["transport"] = transport
                                        reading = SensorReading(
                                            inlet_ppm=float(payload["inlet_ppm"]),
                                            outlet_ppm=float(payload["outlet_ppm"]),
                                            efficiency=float(payload["efficiency"]) if payload.get("efficiency") is not None else None,
                                            temperature=float(payload["temperature"]) if payload.get("temperature") is not None else None,
                                            humidity=float(payload["humidity"]) if payload.get("humidity") is not None else None,
                                            device_id=payload.get("device_id") or f"physical_{board_type}_{candidate_port.split('/')[-1]}",
                                            board_type=board_type,
                                            transport=transport,
                                        )
                                        ingest_sensor_reading(reading)
                                        global scanner_reading_at
                                        scanner_reading_at = latest_sensor_received_at
                                except json.JSONDecodeError:
                                    pass
                except (serial.SerialException, OSError):
                    # Device disconnected or port busy
                    hardware_serial_state["active"] = False
                    hardware_serial_state["port"] = None
                    hardware_serial_state["board_type"] = None
                    hardware_serial_state["transport"] = None
                    time.sleep(2.0)
            else:
                hardware_serial_state["active"] = False
                hardware_serial_state["port"] = None
                hardware_serial_state["board_type"] = None
                hardware_serial_state["transport"] = None
                time.sleep(2.0)
        except Exception:
            time.sleep(2.5)

# Start auto-detector daemon thread immediately
threading.Thread(target=serial_auto_scanner_loop, daemon=True).start()

# --- REMOTE LIVE SENSORS: laptop relay -> deployed API -> Firestore -> every viewer ---
# Serverless instances share no memory, so the deployed app keeps the latest readings in one Firestore document.
LIVE_SENSOR_COLLECTION, LIVE_SENSOR_DOCUMENT = 'live_sensors', 'chamber'
REMOTE_HISTORY_LENGTH = 40
REMOTE_STALE_SECONDS = 20.0
_remote_cache: dict = {'data': None, 'fetched': 0.0}


@app.get('/api/firebase/status')
def firebase_status():
    """Which Firebase settings this deployment can see (presence only, never values)."""
    key = os.getenv('FIREBASE_PRIVATE_KEY', '')
    return {
        'FIREBASE_PROJECT_ID': bool(os.getenv('FIREBASE_PROJECT_ID', '').strip()),
        'FIREBASE_CLIENT_EMAIL': bool(os.getenv('FIREBASE_CLIENT_EMAIL', '').strip()),
        'FIREBASE_PRIVATE_KEY': bool(key.strip()),
        'private_key_format_ok': 'BEGIN PRIVATE KEY' in key and 'END PRIVATE KEY' in key,
        'SENSOR_RELAY_KEY': bool(os.getenv('SENSOR_RELAY_KEY', '').strip()),
        'deployment': os.getenv('VERCEL_ENV', 'local'),
    }


def live_sensor_doc():
    return suggestion_store().collection(LIVE_SENSOR_COLLECTION).document(LIVE_SENSOR_DOCUMENT)


@app.post('/api/sensors/relay')
def relay_sensor_reading(reading: SensorReading, x_relay_key: Optional[str] = Header(default=None)):
    """Accepts readings forwarded from the laptop connected to the ESP32 and publishes them to Firestore."""
    expected = os.getenv('SENSOR_RELAY_KEY', '').strip()
    if not expected or not hmac.compare_digest((x_relay_key or '').strip(), expected):
        raise HTTPException(401, 'Invalid or missing relay key')
    result = ingest_sensor_reading(reading)
    doc = live_sensor_doc()
    previous = doc.get()
    state = previous.to_dict() if previous.exists else {}
    history = state.get('history', [])
    if result.get('status') == 'ok':
        history = (history + [result['recorded']])[-REMOTE_HISTORY_LENGTH:]
        state['latest'] = result['recorded']
    doc.set({'latest': state.get('latest'), 'history': history, 'issue': sensor_issue['message'], 'updated_at': time.time(), 'disconnected_at': None})
    return result


@app.post('/api/sensors/relay/disconnect')
def relay_sensor_disconnect(x_relay_key: Optional[str] = Header(default=None)):
    """Called by the laptop relay when the ESP32 is unplugged, so viewers see it at once."""
    expected = os.getenv('SENSOR_RELAY_KEY', '').strip()
    if not expected or not hmac.compare_digest((x_relay_key or '').strip(), expected):
        raise HTTPException(401, 'Invalid or missing relay key')
    live_sensor_doc().set({'disconnected_at': time.time()}, merge=True)
    _remote_cache.update(data=None, fetched=0.0)
    return {'status': 'ok'}


def remote_live_state() -> Optional[dict]:
    """Latest relayed readings from Firestore (deployed app only), cached for 2 s per instance."""
    if not os.getenv('FIREBASE_PROJECT_ID'):
        return None
    if time.time() - _remote_cache['fetched'] < 2.0:
        return _remote_cache['data']
    try:
        snapshot = live_sensor_doc().get()
        data = snapshot.to_dict() if snapshot.exists else None
    except Exception:  # Firestore unavailable: behave as if nothing was relayed.
        data = None
    _remote_cache.update(data=data, fetched=time.time())
    return data


@app.get('/api/sensors/live')
def get_live_sensors():
    reading_age_seconds = time.monotonic() - latest_sensor_received_at if latest_sensor_received_at is not None else None
    # A USB/Bluetooth board counts as disconnected the moment its port closes, not 10 s later.
    unplugged = (not hardware_serial_state['active'] and scanner_reading_at is not None
                 and scanner_reading_at == latest_sensor_received_at)
    connected = reading_age_seconds is not None and reading_age_seconds <= 10.0 and not unplugged
    remote = None if connected else remote_live_state()
    if remote and remote.get('latest'):
        age = time.time() - float(remote.get('updated_at') or 0)
        disconnected_at = remote.get('disconnected_at')
        return {
            "connected": age <= REMOTE_STALE_SECONDS and not (disconnected_at and disconnected_at >= float(remote.get('updated_at') or 0)),
            "hardware": hardware_serial_state,
            "latest": remote['latest'],
            "history": remote.get('history', []),
            "history_count": len(remote.get('history', [])),
            "reading_age_seconds": round(age, 1),
            "sensor_issue": remote.get('issue'),
            "capabilities": DEVICE_CAPABILITIES,
            "source": "relay",
        }
    return {
        "connected": connected,
        "hardware": hardware_serial_state,
        "latest": latest_sensor_reading,
        "history": sensor_telemetry_history,
        "history_count": len(sensor_telemetry_history),
        "reading_age_seconds": round(reading_age_seconds, 1) if reading_age_seconds is not None else None,
        "sensor_issue": sensor_issue["message"],
        "capabilities": DEVICE_CAPABILITIES,
    }

class SimulationInputs(BaseModel):
    moss_efficiency_pct: float = Field(ge=0, le=100)
    algae_efficiency_pct: float = Field(ge=0, le=100)
    airflow_m3_h: float = Field(gt=0)
    chamber_volume_m3: float = Field(gt=0)
    elapsed_seconds: float = Field(ge=0)
    step_seconds: float = Field(default=1.5, gt=0, le=10)
    previous_outlet_ppm: Optional[float] = Field(default=None, ge=0)

@app.post('/api/sensors/simulate')
def simulate_sensor_tick(inputs: SimulationInputs):
    """Advance an autonomous deterministic chamber scenario by one model step."""
    phase = inputs.elapsed_seconds
    inlet = (
        450.0
        + 35.0 * math.sin(2.0 * math.pi * phase / 120.0)
        + 10.0 * math.sin(2.0 * math.pi * phase / 45.0)
    )
    temperature = 25.0 + 2.0 * math.sin(2.0 * math.pi * phase / 300.0)
    humidity = 72.0 + 6.0 * math.sin(2.0 * math.pi * phase / 240.0 + math.pi / 3.0)
    combined_efficiency = series_efficiency(
        inputs.moss_efficiency_pct / 100.0,
        inputs.algae_efficiency_pct / 100.0,
    )
    target_outlet = inlet * (1.0 - combined_efficiency)
    residence_time_seconds = inputs.chamber_volume_m3 / inputs.airflow_m3_h * 3600.0
    if inputs.previous_outlet_ppm is None:
        outlet = inlet
    else:
        response_fraction = 1.0 - math.exp(-inputs.step_seconds / residence_time_seconds)
        outlet = inputs.previous_outlet_ppm + (target_outlet - inputs.previous_outlet_ppm) * response_fraction
    transient_efficiency = max(0.0, (inlet - outlet) / inlet * 100.0)

    reading = SensorReading(
        inlet_ppm=inlet,
        outlet_ppm=outlet,
        efficiency=transient_efficiency,
        temperature=temperature,
        humidity=humidity,
        device_id="autonomous_two_stage_model",
        board_type="simulator",
        transport="simulation",
    )
    result = ingest_sensor_reading(reading)
    result["model"] = {
        "type": "autonomous_deterministic_chamber",
        "equation": "C_out[n] = C_out[n-1] + (C_target[n] - C_out[n-1]) * (1 - exp(-dt / (V/Q)))",
        "inputs": inputs.model_dump(),
        "profile": "smooth_periodic_urban_inlet_v1",
        "combined_efficiency_pct": round(combined_efficiency * 100.0, 4),
        "target_outlet_ppm": round(target_outlet, 4),
        "residence_time_seconds": round(residence_time_seconds, 4),
        "randomness": False,
    }
    return result


