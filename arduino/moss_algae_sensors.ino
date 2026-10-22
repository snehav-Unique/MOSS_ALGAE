/*
 * MOSS-ALGAE INDIA: Real-Time Chamber Sensor Telemetry
 * 
 * Hardware:
 *   1. Robocraze MQ-135 Sensor #1 (Inlet / Intake Air)  -> Analog Pin A0
 *   2. Robocraze MQ-135 Sensor #2 (Outlet / Exhaust Air) -> Analog Pin A1
 *   3. Robocraze DHT22 Temperature & Humidity Sensor    -> Digital Pin 2
 * 
 * Target Board: Arduino Uno / Nano / Mega (AVR)
 * Communication: Serial USB @ 115200 Baud (JSON stream)
 * 
 * Required Libraries (Install via Arduino Library Manager):
 *   - "DHT sensor library" by Adafruit
 *   - "Adafruit Unified Sensor" by Adafruit
 */

#include <DHT.h>

// --- Pin Definitions ---
#define DHTPIN 2            // Digital pin connected to the DHT22 data pin
#define DHTTYPE DHT22       // DHT 22 (AM2302)

#define MQ135_INLET_PIN  A0 // Analog pin for Inlet MQ-135 (Dirty / Ambient Air)
#define MQ135_OUTLET_PIN A1 // Analog pin for Outlet MQ-135 (Treated / Purified Air)

DHT dht(DHTPIN, DHTTYPE);

// --- MQ-135 Calibration Constants ---
// Load resistance RL on standard breakout board is ~10K ohms (10.0)
const float RL_VALUE = 10.0; 
// Clean air ratio Rs/R0 is approximately 3.6 for MQ-135
const float R0_CLEAN_AIR_FACTOR = 3.6;

// Curve fit parameters for general air quality / CO2 equivalent: ppm = A * (Rs/R0)^B
const float PARA = 116.6020682;
const float PARB = -2.769034857;

// Calibration values for baseline R0 (calibrated during setup or preset)
float R0_inlet = 10.0;
float R0_outlet = 10.0;

// Read analog resistance Rs
float getResistance(int pin) {
  int rawADC = 0;
  // Take 5 samples and average to filter out ADC jitter
  for (int i = 0; i < 5; i++) {
    rawADC += analogRead(pin);
    delay(10);
  }
  rawADC /= 5;

  if (rawADC <= 0) rawADC = 1;
  if (rawADC >= 1023) rawADC = 1022;

  float vrl = ((float)rawADC / 1023.0) * 5.0; // Voltage across RL
  float rs = ((5.0 - vrl) / vrl) * RL_VALUE; // Sensor resistance
  return rs;
}

// Compute gas PPM from resistance and R0
float getPPM(float rs, float r0) {
  if (r0 <= 0) return 0;
  float ratio = rs / r0;
  if (ratio <= 0) return 0;
  float ppm = PARA * pow(ratio, PARB);
  return ppm;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  
  // Non-blocking serial wait (timeout after 2.5s so sketch runs autonomously)
  unsigned long startWait = millis();
  while (!Serial && (millis() - startWait < 2500)) { ; }

  dht.begin();

  // Visual LED blink: 3 quick pulses indicating boot & calibration
  for (int k = 0; k < 3; k++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(100);
    digitalWrite(LED_BUILTIN, LOW);
    delay(100);
  }

  // Initial sensor warm-up sample & baseline calibration
  delay(1000);
  float initial_rs_inlet = getResistance(MQ135_INLET_PIN);
  float initial_rs_outlet = getResistance(MQ135_OUTLET_PIN);
  
  R0_inlet = initial_rs_inlet / R0_CLEAN_AIR_FACTOR;
  R0_outlet = initial_rs_outlet / R0_CLEAN_AIR_FACTOR;
  if (R0_inlet <= 0) R0_inlet = 10.0;
  if (R0_outlet <= 0) R0_outlet = 10.0;

  Serial.println(F("{\"status\":\"INITIALIZED\",\"device\":\"MOSS_ALGAE_CHAMBER_V1\"}"));
}

void loop() {
  // Pulse onboard LED while reading and transmitting
  digitalWrite(LED_BUILTIN, HIGH);

  // Read DHT22
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature(); // Celsius


  // Check if DHT read failed
  bool dht_valid = !isnan(humidity) && !isnan(temperature);

  // Read MQ-135 sensors
  float rs_inlet = getResistance(MQ135_INLET_PIN);
  float rs_outlet = getResistance(MQ135_OUTLET_PIN);

  float inlet_ppm = getPPM(rs_inlet, R0_inlet);
  float outlet_ppm = getPPM(rs_outlet, R0_outlet);

  // Calculate Real-Time Single-Pass Filtration Efficiency (%)
  // Efficiency = ((Inlet - Outlet) / Inlet) * 100
  float efficiency = 0.0;
  if (inlet_ppm > 0) {
    efficiency = ((inlet_ppm - outlet_ppm) / inlet_ppm) * 100.0;
    if (efficiency < 0.0) efficiency = 0.0; // clamp if outlet momentarily spikes
    if (efficiency > 95.0) efficiency = 95.0; // clamp realistic max
  }

  // Format and output clean JSON over Serial
  Serial.print(F("{\"inlet_ppm\":"));
  Serial.print(inlet_ppm, 2);
  Serial.print(F(",\"outlet_ppm\":"));
  Serial.print(outlet_ppm, 2);
  Serial.print(F(",\"efficiency\":"));
  Serial.print(efficiency, 2);
  Serial.print(F(",\"temperature\":"));
  if (dht_valid) Serial.print(temperature, 1);
  else Serial.print(F("null"));
  Serial.print(F(",\"humidity\":"));
  if (dht_valid) Serial.print(humidity, 1);
  else Serial.print(F("null"));
  Serial.println(F("}"));
  digitalWrite(LED_BUILTIN, LOW);

  // Transmit telemetry every 2000ms
  delay(2000);
}

