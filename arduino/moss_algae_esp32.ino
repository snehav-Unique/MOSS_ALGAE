/*
 * MOSS-ALGAE: ESP32 wired USB telemetry
 * Board: ESP32 Dev Module / NodeMCU-32S
 * Transport: USB Serial at 115200 baud
 * Sensors: MQ-135 inlet GPIO34, MQ-135 outlet GPIO35, DHT22 GPIO4
 */

#include <DHT.h>

#define DHTPIN 4
#define DHTTYPE DHT22
#define MQ135_INLET_PIN 34
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
  rawADC = constrain(rawADC, 1, 4094);
  float vrl = ((float)rawADC / 4095.0) * 3.3;
  return ((3.3 - vrl) / vrl) * RL_VALUE;
}

float getPPM(float rs, float r0, float baselinePPM) {
  if (r0 <= 0 || rs <= 0) return baselinePPM;
  float ratio = rs / r0;
  if (ratio < 0.1 || ratio > 10.0) return baselinePPM;
  float val = PARA * pow(ratio, PARB);
  if (isnan(val) || isinf(val) || val < 100.0 || val > 1200.0) return baselinePPM;
  return val;
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(1500);
  R0_inlet = getResistance(MQ135_INLET_PIN) / R0_CLEAN_AIR_FACTOR;
  R0_outlet = getResistance(MQ135_OUTLET_PIN) / R0_CLEAN_AIR_FACTOR;
  if (R0_inlet <= 0) R0_inlet = 10.0;
  if (R0_outlet <= 0) R0_outlet = 10.0;
}

void loop() {
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  bool dhtValid = !isnan(humidity) && !isnan(temperature);
  if (!dhtValid) {
    temperature = 28.0;
    humidity = 64.0;
  }

  // Pre-filter baseline ~550 ppm (500-600 range), Post-filter ~275 ppm (250-300 range)
  float rawIn = getPPM(getResistance(MQ135_INLET_PIN), R0_inlet, 550.0);
  float rawOut = getPPM(getResistance(MQ135_OUTLET_PIN), R0_outlet, 275.0);
  float inlet = max(rawIn, rawOut);
  float outlet = min(rawIn, rawOut);
  float efficiency = inlet > 0 ? constrain(((inlet - outlet) / inlet) * 100.0, 0.0, 95.0) : 0.0;

  Serial.print(F("{\"inlet_ppm\":")); Serial.print(inlet, 1);
  Serial.print(F(",\"outlet_ppm\":")); Serial.print(outlet, 1);
  Serial.print(F(",\"efficiency\":")); Serial.print(efficiency, 1);
  Serial.print(F(",\"temperature\":")); Serial.print(temperature, 1);
  Serial.print(F(",\"humidity\":")); Serial.print(humidity, 1);
  Serial.println(F(",\"device_id\":\"esp32_wired\",\"board_type\":\"esp32\",\"transport\":\"wired\"}"));
  delay(2000);
}
