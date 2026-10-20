import os
from datetime import datetime, timezone
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
try:
    from .model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture
except ImportError:
    from model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture

app=FastAPI(title='MOSS–ALGAE INDIA',version='0.1.0')
app.add_middleware(CORSMiddleware,allow_origins=os.getenv('CORS_ORIGINS','http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:3001,http://localhost:3001').split(','),allow_methods=['GET','POST'],allow_headers=['Content-Type'])

@app.get('/health')
def health(): return {'status':'ok','calibration':'not supplied'}

@app.get('/api/observations')
async def observations():
    checked=datetime.now(timezone.utc).isoformat()
    key=os.getenv('OPENAQ_API_KEY')
    ids=[v for v in os.getenv('OPENAQ_LOCATION_IDS','').split(',') if v.isdigit()][:20]
    if not key or not ids:
        return {'status':'OpenAQ configuration required','observations':[],'checked_at':checked,'source':'https://api.openaq.org/v3'}
    out=[]
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            for id in ids:
                meta=await client.get(f'https://api.openaq.org/v3/locations/{id}',headers={'X-API-Key':key});meta.raise_for_status()
                location=meta.json()['results'][0]
                sensors={s['id']:s['parameter'] for s in location.get('sensors',[])}
                r=await client.get(f'https://api.openaq.org/v3/locations/{id}/latest',headers={'X-API-Key':key});r.raise_for_status()
                for row in r.json().get('results',[]):
                    out.append({**row,'parameter':sensors.get(row.get('sensorsId')),'location_name':location.get('name'),'provider':location.get('provider'),'source_url':f'https://api.openaq.org/v3/locations/{id}/latest','retrieved_at':checked})
    except (httpx.HTTPError,KeyError,ValueError):
        raise HTTPException(502,'OpenAQ upstream unavailable or invalid response; no replacement readings generated')
    return {'status':'Timestamped observations available' if out else 'No observations returned','observations':out,'checked_at':checked,'note':'Check measurement time before use; latest may be stale. No interpolation or AQI conversion.'}

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
