/*
 * MOSS-ALGAE INDIA: Real-Time Chamber Sensor Telemetry (ESP32 Wi-Fi HTTP POST)
 * 
 * Hardware:
 *   1. Robocraze MQ-135 Sensor #1 (Inlet Air)  -> ADC Pin GPIO34 (or GPIO36/VP)
 *   2. Robocraze MQ-135 Sensor #2 (Outlet Air) -> ADC Pin GPIO35 (or GPIO39/VN)
 *   3. Robocraze DHT22 Temp & Humidity Sensor  -> GPIO4
 * 
 * Target Board: ESP32 Dev Module
 * Communication: Wi-Fi HTTP POST directly to FastAPI /api/sensors/reading
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>

// --- Wi-Fi Credentials ---
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// --- Backend API URL ---
// Change to your computer's local IP address (e.g. http://192.168.1.50:8000/api/sensors/reading)
const char* serverUrl = "http://192.168.1.100:8000/api/sensors/reading";

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
  dht.begin();

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected! IP: " + WiFi.localIP().toString());

  delay(2000);
  R0_inlet = getResistance(MQ135_INLET_PIN) / R0_CLEAN_AIR_FACTOR;
  R0_outlet = getResistance(MQ135_OUTLET_PIN) / R0_CLEAN_AIR_FACTOR;
  if (R0_inlet <= 0) R0_inlet = 10.0;
  if (R0_outlet <= 0) R0_outlet = 10.0;
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();
    bool dht_valid = !isnan(humidity) && !isnan(temperature);

    float rs_inlet = getResistance(MQ135_INLET_PIN);
    float rs_outlet = getResistance(MQ135_OUTLET_PIN);
    float inlet_ppm = getPPM(rs_inlet, R0_inlet);
    float outlet_ppm = getPPM(rs_outlet, R0_outlet);

    float efficiency = 0.0;
    if (inlet_ppm > 0) {
      efficiency = ((inlet_ppm - outlet_ppm) / inlet_ppm) * 100.0;
      if (efficiency < 0.0) efficiency = 0.0;
      if (efficiency > 95.0) efficiency = 95.0;
    }

    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonPayload = "{";
    jsonPayload += "\"inlet_ppm\":" + String(inlet_ppm, 2) + ",";
    jsonPayload += "\"outlet_ppm\":" + String(outlet_ppm, 2) + ",";
    jsonPayload += "\"efficiency\":" + String(efficiency, 2) + ",";
    jsonPayload += "\"temperature\":" + (dht_valid ? String(temperature, 1) : "null") + ",";
    jsonPayload += "\"humidity\":" + (dht_valid ? String(humidity, 1) : "null");
    jsonPayload += "}";

    int httpCode = http.POST(jsonPayload);
    Serial.println("POST " + String(httpCode) + " -> " + jsonPayload);
    http.end();
  }
  delay(2000);
}
