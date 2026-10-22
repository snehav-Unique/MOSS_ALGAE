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

float getPPM(float rs, float r0) {
  if (r0 <= 0 || rs <= 0) return 0;
  return PARA * pow(rs / r0, PARB);
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
  float inlet = getPPM(getResistance(MQ135_INLET_PIN), R0_inlet);
  float outlet = getPPM(getResistance(MQ135_OUTLET_PIN), R0_outlet);
  float efficiency = inlet > 0 ? constrain(((inlet - outlet) / inlet) * 100.0, 0.0, 95.0) : 0.0;

  Serial.print(F("{\"inlet_ppm\":")); Serial.print(inlet, 2);
  Serial.print(F(",\"outlet_ppm\":")); Serial.print(outlet, 2);
  Serial.print(F(",\"efficiency\":")); Serial.print(efficiency, 2);
  Serial.print(F(",\"temperature\":")); dhtValid ? Serial.print(temperature, 1) : Serial.print(F("null"));
  Serial.print(F(",\"humidity\":")); dhtValid ? Serial.print(humidity, 1) : Serial.print(F("null"));
  Serial.println(F(",\"device_id\":\"esp32_wired\",\"board_type\":\"esp32\",\"transport\":\"wired\"}"));
  delay(2000);
}
