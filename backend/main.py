import os
import threading
import time
import json
from datetime import datetime, timezone
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    import serial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False

try:
    from .model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture
except ImportError:
    from model import capture, local_balance, uncertainty, lifecycle, optimize, staged_capture


app=FastAPI(title='MOSS–ALGAE INDIA',version='0.1.0')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['GET','POST'],allow_headers=['Content-Type'])


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

# --- REAL-TIME CHAMBER SENSOR TELEMETRY (MQ-135 & DHT22) ---
class SensorReading(BaseModel):
    inlet_ppm: float = Field(ge=0, description="Raw input air gas concentration (MQ-135 #1)")
    outlet_ppm: float = Field(ge=0, description="Purified output air gas concentration (MQ-135 #2)")
    efficiency: float = Field(default=None, ge=0, le=100, description="Calculated single-pass efficiency %")
    temperature: float = Field(default=None, description="Chamber temperature in Celsius (DHT22)")
    humidity: float = Field(default=None, description="Chamber relative humidity % (DHT22)")
    device_id: str = Field(default="robocraze_chamber_01", description="Microcontroller or station ID")

sensor_telemetry_history: list = []
latest_sensor_reading: dict = None

def evaluate_chamber_health(temperature: float, humidity: float) -> dict:
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


@app.post('/api/sensors/reading')
def ingest_sensor_reading(reading: SensorReading):
    global latest_sensor_reading
    # Calculate measured efficiency: (inlet - outlet) / inlet * 100
    eff = reading.efficiency
    if eff is None:
        if reading.inlet_ppm > 0:
            eff = max(0.0, min(95.0, (reading.inlet_ppm - reading.outlet_ppm) / reading.inlet_ppm * 100.0))
        else:
            eff = 0.0

    timestamp = datetime.now(timezone.utc).isoformat()
    health = evaluate_chamber_health(reading.temperature, reading.humidity)

    data = {
        "inlet_ppm": round(reading.inlet_ppm, 2),
        "outlet_ppm": round(reading.outlet_ppm, 2),
        "efficiency": round(eff, 2),
        "temperature": round(reading.temperature, 1) if reading.temperature is not None else None,
        "humidity": round(reading.humidity, 1) if reading.humidity is not None else None,
        "device_id": reading.device_id,
        "timestamp": timestamp,
        "health": health
    }

    latest_sensor_reading = data
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


hardware_serial_state = {
    "active": False,
    "port": None,
    "device_name": None,
    "baud": 115200,
    "last_seen": None,
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
                    with serial.Serial(candidate_port, 115200, timeout=2.5) as ser:
                        hardware_serial_state["active"] = True
                        hardware_serial_state["port"] = candidate_port
                        print(f"🌿 [AUTO-SERIAL] Physical Arduino connected on {candidate_port} ({candidate_desc})")
                        time.sleep(1.8) # Wait for Arduino board reset
                        while True:
                            line = ser.readline().decode('utf-8', errors='ignore').strip()
                            if not line:
                                continue
                            if line.startswith('{') and line.endswith('}'):
                                try:
                                    payload = json.loads(line)
                                    if "inlet_ppm" in payload and "outlet_ppm" in payload:
                                        hardware_serial_state["last_seen"] = datetime.now(timezone.utc).isoformat()
                                        reading = SensorReading(
                                            inlet_ppm=float(payload["inlet_ppm"]),
                                            outlet_ppm=float(payload["outlet_ppm"]),
                                            efficiency=float(payload["efficiency"]) if payload.get("efficiency") is not None else None,
                                            temperature=float(payload["temperature"]) if payload.get("temperature") is not None else None,
                                            humidity=float(payload["humidity"]) if payload.get("humidity") is not None else None,
                                            device_id=f"physical_arduino_{candidate_port.split('/')[-1]}"
                                        )
                                        ingest_sensor_reading(reading)
                                except json.JSONDecodeError:
                                    pass
                except (serial.SerialException, OSError):
                    # Device disconnected or port busy
                    hardware_serial_state["active"] = False
                    hardware_serial_state["port"] = None
                    time.sleep(2.0)
            else:
                hardware_serial_state["active"] = False
                hardware_serial_state["port"] = None
                time.sleep(2.0)
        except Exception:
            time.sleep(2.5)

# Start auto-detector daemon thread immediately
threading.Thread(target=serial_auto_scanner_loop, daemon=True).start()

@app.get('/api/sensors/live')
def get_live_sensors():
    return {
        "connected": latest_sensor_reading is not None,
        "hardware": hardware_serial_state,
        "latest": latest_sensor_reading,
        "history": sensor_telemetry_history,
        "history_count": len(sensor_telemetry_history)
    }

@app.post('/api/sensors/simulate')
def simulate_sensor_tick():
    """Generates realistic test telemetry for demonstration and UI testing."""
    import random
    base_inlet = round(random.uniform(380.0, 520.0), 2)
    # realistic biofilter reduction: 30% to 45%
    reduction_pct = random.uniform(32.0, 44.0)
    outlet = round(base_inlet * (1.0 - reduction_pct / 100.0), 2)
    temp = round(random.uniform(22.5, 25.8), 1)
    hum = round(random.uniform(68.0, 78.5), 1)

    reading = SensorReading(
        inlet_ppm=base_inlet,
        outlet_ppm=outlet,
        efficiency=round(reduction_pct, 2),
        temperature=temp,
        humidity=hum,
        device_id="simulated_robocraze_kit"
    )
    return ingest_sensor_reading(reading)


