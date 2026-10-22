# MOSS-ALGAE Sensor Integration Guide

This guide details how to integrate your **Robocraze MQ-135** (Air Quality / Gas Detection) and **Robocraze DHT22** (Temperature & Humidity) sensors with the MOSS-ALGAE digital twin and dashboard.

---

## 1. System Architecture

```
                      +-----------------------------+
                      |   LIVING BIOFILTER CHAMBER  |
                      |                             |
                      |  [STAGE 1: Moss Matrix]    |
                      |  [STAGE 2: Microalgae]     |
                      |                             |
                      |  DHT22 (Inside Chamber)     |
                      +-----------------------------+
                                    ^
                                    |
   [Inlet / Dirty Air]              |               [Outlet / Clean Air]
       =====>                       |                     =====>
 [MQ-135 Sensor #1]                                 [MQ-135 Sensor #2]
   (Pin A0 on Arduino)                                (Pin A1 on Arduino)
            \                                                /
             \                     |                        /
              +---------------> [ARDUINO] <----------------+
                                   |
                          USB Serial (115200)
                                   |
                                   v
                      [Python Sensor Bridge]
                                   |
                            HTTP POST JSON
                                   |
                                   v
                    [FastAPI Backend (/api/sensors)]
                                   |
                                   v
                   [Next.js Interactive Dashboard]
```

---

## 2. Hardware Bill of Materials (BOM)

### Supported controller connections

| Controller | Wi-Fi | Bluetooth | Wired USB serial |
| :--- | :---: | :---: | :---: |
| **ESP32** | Yes | Yes (Classic SPP) | Yes |
| **Arduino Uno / Nano / Mega** | No | No | Yes |

The dashboard identifies both the controller and transport in every reading. Invalid combinations, such as Arduino + Bluetooth, are rejected by the API instead of being mislabeled as live hardware.

| Component | Quantity | Purpose |
| :--- | :--- | :--- |
| **Robocraze MQ-135 Air Quality Sensor Module** | 2 | 1 for **Inlet** (dirty air entering), 1 for **Outlet** (clean air exiting) |
| **Robocraze DHT22 Module** | 1 | Chamber microclimate (Temperature & Relative Humidity) |
| **Arduino Uno / Nano / Mega or ESP32** | 1 | Arduino uses wired USB only; ESP32 can use wired USB, Wi-Fi, or Bluetooth |
| **Jumper Wires** | ~10 | Male-to-Female / Male-to-Male jumper cables |
| **External 5V Power Adapter (Recommended)** | 1 | Supplies sufficient current for both MQ-135 heating elements |

---

## 3. Circuit Wiring & Pinout

### Arduino Uno / Nano Connections

| Sensor | Sensor Pin | Arduino Pin | Notes |
| :--- | :--- | :--- | :--- |
| **MQ-135 #1 (Inlet / Input)** | VCC | **5V** | Sensor heater requires 5V |
| | GND | **GND** | Common ground |
| | AOUT | **A0** | Analog output (0–5V) |
| | DOUT | *Leave unconnected* | (Digital threshold not needed) |
| **MQ-135 #2 (Outlet / Output)** | VCC | **5V** | Sensor heater requires 5V |
| | GND | **GND** | Common ground |
| | AOUT | **A1** | Analog output (0–5V) |
| | DOUT | *Leave unconnected* | (Digital threshold not needed) |
| **Robocraze DHT22** | VCC | **5V or 3.3V** | DHT22 operates 3.3V–5.5V |
| | GND | **GND** | Common ground |
| | DATA / OUT | **Digital Pin 2 (D2)** | Robocraze module has built-in pull-up resistor |

> [!WARNING]
> **Power Requirement Notice:**
> Each MQ-135 sensor has an internal heating coil that draws approximately **150mA at 5V**. Running two MQ-135 modules simultaneously requires **~300mA**. 
> - If powered solely via computer USB, ensure your USB port can deliver stable 500mA without voltage drops.
> - For best stability, plug a 7–12V DC power adapter into the Arduino DC barrel jack, or use a powered USB hub.

---

## 4. Sensor Calibration & Preheating

1. **Pre-heat Burn-in Time:**
   - Tin-dioxide ($SnO_2$) sensors require a warm-up period.
   - For a brand-new sensor, keep it powered for 24–48 hours initially to stabilize the surface coating.
   - Before taking measurement readings for tests, allow **10–15 minutes** of pre-heating so the heating element reaches operating temperature.
2. **Efficiency Calculation Formula:**
   $$\text{Single-Pass Efficiency } \eta = \left( \frac{\text{Inlet PPM} - \text{Outlet PPM}}{\text{Inlet PPM}} \right) \times 100\%$$
   The Arduino sketch computes this in real-time. If clean air passes through active moss and microalgae stages, you will observe the outlet reading drop below the inlet reading.

---

## 5. Software Setup & Flashing

### Step 1: Install Arduino Libraries
In Arduino IDE, go to **Tools** > **Manage Libraries...** and install:
1. `DHT sensor library` by Adafruit
2. `Adafruit Unified Sensor` by Adafruit

### Step 2: Upload Sketch
1. Open [`arduino/moss_algae_sensors.ino`](file:///Users/saitriveni/moss%20algae/MOSS_ALGAE/arduino/moss_algae_sensors.ino).
2. Select your board (`Arduino Uno` or `Arduino Nano`) and the correct COM/Serial port.
3. Click **Upload**.
4. Open the Serial Monitor at **115200 baud** to verify that JSON output is printing:
   ```json
   {"inlet_ppm": 452.10, "outlet_ppm": 284.50, "efficiency": 37.07, "temperature": 24.2, "humidity": 71.5}
   ```
5. **Close the Arduino Serial Monitor** before starting the Python bridge (otherwise the serial port will be locked).

### ESP32 sketch selection

- Wired USB: `arduino/moss_algae_esp32.ino`
- Wi-Fi direct HTTP: `arduino/moss_algae_esp32_wifi.ino`
- Bluetooth Classic serial: `arduino/moss_algae_esp32_bluetooth.ino`

For Wi-Fi, set the network credentials and backend LAN URL inside the sketch. For Bluetooth, pair `MOSS_ALGAE_ESP32` first and use the created serial port with the bridge.

---

## 6. Running the Sensor Bridge

### Start the FastAPI Backend
```bash
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### Start the Sensor Bridge
```bash
# Auto-detects connected Arduino:
python3 backend/sensor_bridge.py

# Or specify your port explicitly:
python3 backend/sensor_bridge.py --port /dev/cu.usbserial-110   # macOS
python3 backend/sensor_bridge.py --port COM3                   # Windows

# ESP32 wired or paired Bluetooth serial:
python3 backend/sensor_bridge.py --board esp32 --transport wired --port COM3
python3 backend/sensor_bridge.py --board esp32 --transport bluetooth --port COM4
```

### Testing Without Hardware (Mock Mode)
If your sensors are not yet wired up and you want to test the full dashboard live:
```bash
python3 backend/sensor_bridge.py --mock
```

---

## 7. Biological Interpretation Guide

| Metric | Ideal Range | Biological Meaning | Action Required |
| :--- | :--- | :--- | :--- |
| **Humidity (RH)** | 65% – 85% | Essential for moss survival. Moss absorbs water & nutrients across its leaves. | If < 50%, moss enters dormancy and particulate filtration drops. Mist immediately. |
| **Temperature** | 20°C – 28°C | Optimal photosynthesis rate for microalgae culture. | If > 32°C, algal culture experiences thermal decay. Provide ventilation. |
| **Efficiency %** | 25% – 50% | Real-time single-pass pollutant capture by the combined biological matrix. | Directly informs the digital twin CADR calculation. |
