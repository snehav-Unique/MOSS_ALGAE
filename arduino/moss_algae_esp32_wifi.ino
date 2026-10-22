/*
 * MOSS-ALGAE INDIA: Real-Time Chamber Sensor Telemetry (ESP32 Wi-Fi Mode)
 * Board: ESP32 Dev Module / NodeMCU-32S
 * 
 * Hardware Connections:
 *   - Robocraze MQ-135 #1 (Inlet Air)  -> ADC Pin GPIO 34
 *   - Robocraze MQ-135 #2 (Outlet Air) -> ADC Pin GPIO 35
 *   - Robocraze DHT22 (Temp & Hum)     -> GPIO 4
 *   - Sensor VCC                       -> 5V (or VIN)
 *   - Sensor GND                       -> GND
 * 
 * Communication: Wi-Fi HTTP POST directly to FastAPI /api/sensors/reading
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>

// --- Wi-Fi Configuration ---
// Enter your Wi-Fi credentials here:
const char* ssid     = "YOUR_WIFI_NAME";
const char* password = "YOUR_WIFI_PASSWORD";

// --- FastAPI Backend Server URL ---
// Your computer's current local IP address is 172.17.12.124:
const char* serverUrl = "http://172.17.12.124:8000/api/sensors/reading";

// --- Optional: Direct Telegram Bot Alerts ---
// Enter your Telegram Bot Token & Chat ID here to get alerts even if computer is off:
const char* TELEGRAM_BOT_TOKEN = ""; // e.g. "123456789:ABCdefGhIJKlmNoPQRstuvwxyZ"
const char* TELEGRAM_CHAT_ID   = ""; // e.g. "987654321"
unsigned long lastTelegramAlert = 0;

void sendTelegramAlertDirect(String text) {
  if (strlen(TELEGRAM_BOT_TOKEN) == 0 || strlen(TELEGRAM_CHAT_ID) == 0) return;
  if (millis() - lastTelegramAlert < 300000 && lastTelegramAlert != 0) return; // 5 min cooldown
  HTTPClient https;
  String url = "https://api.telegram.org/bot" + String(TELEGRAM_BOT_TOKEN) + "/sendMessage";
  https.begin(url);
  https.addHeader("Content-Type", "application/json");
  String body = "{\"chat_id\":\"" + String(TELEGRAM_CHAT_ID) + "\",\"text\":\"" + text + "\"}";
  int code = https.POST(body);
  if (code > 0) {
    lastTelegramAlert = millis();
    Serial.println("📱 Telegram alert sent: " + text);
  }
  https.end();
}


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
  pinMode(2, OUTPUT); // Onboard blue LED on most ESP32 boards
  dht.begin();

  Serial.println("\n🌿 Connecting to Wi-Fi: " + String(ssid));
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    digitalWrite(2, !digitalRead(2)); // Blink while connecting
  }
  digitalWrite(2, HIGH); // Solid blue when connected
  Serial.println("\n✅ Connected to Wi-Fi! ESP32 IP: " + WiFi.localIP().toString());
  Serial.println("Target Backend: " + String(serverUrl));

  delay(1500);
  R0_inlet = getResistance(MQ135_INLET_PIN) / R0_CLEAN_AIR_FACTOR;
  R0_outlet = getResistance(MQ135_OUTLET_PIN) / R0_CLEAN_AIR_FACTOR;
  if (R0_inlet <= 0) R0_inlet = 10.0;
  if (R0_outlet <= 0) R0_outlet = 10.0;
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
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

    // 4. HTTP POST JSON to FastAPI
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonPayload = "{";
    jsonPayload += "\"inlet_ppm\":" + String(inlet_ppm, 2) + ",";
    jsonPayload += "\"outlet_ppm\":" + String(outlet_ppm, 2) + ",";
    jsonPayload += "\"efficiency\":" + String(efficiency, 2) + ",";
    jsonPayload += "\"temperature\":" + (dht_valid ? String(temperature, 1) : "null") + ",";
    jsonPayload += "\"humidity\":" + (dht_valid ? String(humidity, 1) : "null") + ",";
    jsonPayload += "\"device_id\":\"esp32_wifi_" + WiFi.localIP().toString() + "\",";
    jsonPayload += "\"board_type\":\"esp32\",";
    jsonPayload += "\"transport\":\"wifi\"";
    jsonPayload += "}";

    int httpCode = http.POST(jsonPayload);
    Serial.println("POST " + String(httpCode) + " -> " + jsonPayload);
    http.end();

    // 5. Direct Telegram Alerts on Critical Conditions
    if (dht_valid) {
      if (temperature > 32.0) {
        sendTelegramAlertDirect("🚨 MOSS-ALGAE ALERT: High Temp " + String(temperature, 1) + "°C! Algal thermal stress.");
      } else if (humidity < 45.0) {
        sendTelegramAlertDirect("⚠️ MOSS-ALGAE ALERT: Low Humidity " + String(humidity, 1) + "%! Moss drying out.");
      }
    }

  } else {
    Serial.println("⚠️ Wi-Fi disconnected. Reconnecting...");
    WiFi.reconnect();
  }

  delay(2000);
}
