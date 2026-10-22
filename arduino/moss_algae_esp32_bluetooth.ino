/*
 * MOSS-ALGAE INDIA: Real-Time Chamber Sensor Telemetry (ESP32 Bluetooth Serial)
 * Board: ESP32 Dev Module / NodeMCU-32S
 * 
 * Hardware Connections:
 *   - Robocraze MQ-135 #1 (Inlet Air)  -> ADC Pin GPIO 34
 *   - Robocraze MQ-135 #2 (Outlet Air) -> ADC Pin GPIO 35
 *   - Robocraze DHT22 (Temp & Hum)     -> GPIO 4
 *   - Sensor VCC                       -> 5V (or VIN)
 *   - Sensor GND                       -> GND
 * 
 * Communication: Bluetooth Classic Serial (SPP)
 * Broadcast Device Name: "MOSS_ALGAE_ESP32"
 * 
 * How to Pair with Mac:
 *   1. Open macOS System Settings -> Bluetooth.
 *   2. Find "MOSS_ALGAE_ESP32" and click Connect/Pair.
 *   3. Mac creates a virtual port (e.g. /dev/cu.MOSS_ALGAE_ESP32).
 *   4. The MOSS-ALGAE backend auto-scanner automatically detects and reads it!
 */

#include "BluetoothSerial.h"
#include <DHT.h>

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth is not enabled! Please run make menuconfig to enable it
#endif

BluetoothSerial SerialBT;

#define DHTPIN 4
#define DHTTYPE DHT22

#define MQ135_INLET_PIN  34
#define MQ135_OUTLET_PIN 35

DHT dht(DHTPIN, DHTTYPE);

const float RL_VALUE = 10.0;
const float R0_CLEAN_AIR_FACTOR = 3.6;
const float PARA = 116.602;
const float PARB = -2.769;

float R0_inlet = 10.0;
float R0_outlet = 10.0;

// Read analog resistance on ESP32 (12-bit ADC: 0-4095, 3.3V)
float getResistance(int pin) {
  int rawADC = 0;
  for (int i = 0; i < 8; i++) {
    rawADC += analogRead(pin);
    delay(5);
  }
  rawADC /= 8;
  if (rawADC <= 0) rawADC = 1;
  if (rawADC >= 4095) rawADC = 4094;

  float vrl = ((float)rawADC / 4095.0) * 3.3;
  float rs = ((3.3 - vrl) / vrl) * RL_VALUE;
  return rs;
}

float getPPM(float rs, float r0) {
  if (r0 <= 0) return 0;
  float ratio = rs / r0;
  if (ratio <= 0) return 0;
  return PARA * pow(ratio, PARB);
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT); // Onboard status LED
  dht.begin();

  // Start Bluetooth Serial with advertised name
  SerialBT.begin("MOSS_ALGAE_ESP32");
  Serial.println("🌿 Bluetooth Serial Started!");
  Serial.println("Pair your Mac/PC with: 'MOSS_ALGAE_ESP32'");

  delay(1500);
  R0_inlet = getResistance(MQ135_INLET_PIN) / R0_CLEAN_AIR_FACTOR;
  R0_outlet = getResistance(MQ135_OUTLET_PIN) / R0_CLEAN_AIR_FACTOR;
  if (R0_inlet <= 0) R0_inlet = 10.0;
  if (R0_outlet <= 0) R0_outlet = 10.0;
}

void loop() {
  digitalWrite(2, HIGH);

  // 1. Read DHT22
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  bool dht_valid = !isnan(humidity) && !isnan(temperature);

  // 2. Read MQ-135 sensors
  float rs_inlet = getResistance(MQ135_INLET_PIN);
  float rs_outlet = getResistance(MQ135_OUTLET_PIN);
  float inlet_ppm = getPPM(rs_inlet, R0_inlet);
  float outlet_ppm = getPPM(rs_outlet, R0_outlet);

  // 3. Compute efficiency
  float efficiency = 0.0;
  if (inlet_ppm > 0) {
    efficiency = ((inlet_ppm - outlet_ppm) / inlet_ppm) * 100.0;
    if (efficiency < 0.0) efficiency = 0.0;
    if (efficiency > 95.0) efficiency = 95.0;
  }

  // 4. Format JSON
  String jsonPayload = "{";
  jsonPayload += "\"inlet_ppm\":" + String(inlet_ppm, 2) + ",";
  jsonPayload += "\"outlet_ppm\":" + String(outlet_ppm, 2) + ",";
  jsonPayload += "\"efficiency\":" + String(efficiency, 2) + ",";
  jsonPayload += "\"temperature\":" + (dht_valid ? String(temperature, 1) : "null") + ",";
  jsonPayload += "\"humidity\":" + (dht_valid ? String(humidity, 1) : "null") + ",";
  jsonPayload += "\"device_id\":\"esp32_bluetooth\"";
  jsonPayload += "}";

  // Transmit over Bluetooth Serial
  SerialBT.println(jsonPayload);

  // Also print to USB Serial for debugging
  Serial.println("[BT STREAM] " + jsonPayload);

  digitalWrite(2, LOW);
  delay(2000);
}
