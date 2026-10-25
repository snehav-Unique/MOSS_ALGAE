# MOSS–ALGAE INDIA

Next.js / TypeScript / Tailwind / shadcn-style Radix button / MapLibre / Recharts frontend with a separately deployed Python FastAPI service. No Figma file was supplied; visual implementation is an original evidence-led dashboard.

## Run

1. `npm ci` then `npm run dev` (Node 20+).
2. `python -m pip install -r backend/requirements.txt`.
3. Set environment variables from `.env.example` in the service environment. Keep OpenAQ keys on the server. Next only exposes `NEXT_PUBLIC_API_URL`.
4. `python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`.
5. Interactive API documentation: `http://127.0.0.1:8000/docs`.

Checks: `npm run build`, `python -m unittest backend.test_model -v`.

In development `npm run dev` proxies `/api` to `BACKEND_URL` (default `http://127.0.0.1:8000`), so no extra frontend configuration is needed.

## Decision features

- **Exposure** — `/api/exposure` counts schools, hospitals/clinics and bus stops within 500 m of each candidate area from OpenStreetMap (Overpass). `public/exposure-snapshot.json` is the offline fallback; refresh it with `python backend/exposure.py`.
- **Planner** — budget optimizer over cost, exposure, feasibility and equity via `/api/optimize` (with ±20% weight sensitivity) and discounted lifecycle cost via `/api/economics`. Feasibility, equity and setup costs are editable team assumptions.
- **Forecast** — 72-hour Open-Meteo PM2.5 forecast turned into a boost/eco operating schedule; reports energy saved and capture retained versus always-on, and can push its duty cycle into Planner economics.
- **Time-lapse** — the Twin view replays the past 7 days hour by hour on both synced maps.
- **Planning assistant** — `/api/assistant` runs Google Gemini (`gemini-3.5-flash-lite`, override with `GEMINI_MODEL`) with the platform's own tools: Planner state, optimizer, lifecycle economics, hotspots, receptors and forecast. Set `GEMINI_API_KEY` on the API service (free key from https://aistudio.google.com/apikey); the key never reaches the browser. If only `ANTHROPIC_API_KEY` is set, Claude is used instead.
- **Deployment brief** — Planner → "Deployment brief (PDF)" renders a printable report with an optional AI executive summary; use the browser's Save as PDF.
- **Citizen page** — `/citizen` is a mobile page in English, ಕನ್ನಡ and हिंदी: PM2.5 near you, advice by group, cleanest 2-hour window, nearest proposed pod area, and a "suggest a pod location" form stored in Firebase Firestore.
- **Owner feedback** — a standalone owner console on port `3001` reads citizen suggestions only after the backend validates `OWNER_DASHBOARD_KEY`; feedback is not exposed on the public Planner.

### Live ESP32 readings on the deployed site

The laptop wired to the ESP32 runs the local backend (it reads USB) plus a relay that forwards each real reading to the deployed API; the API stores the latest readings in Firestore (`live_sensors/chamber`) so every viewer's Sensors tab updates live.

1. On Vercel set `SENSOR_RELAY_KEY` (a long random secret) next to the existing Firebase variables, and redeploy.
2. On the laptop put the same `SENSOR_RELAY_KEY` and `RELAY_TARGET_URL=https://<your-app>.vercel.app` in `.env`.
3. Run the local backend (`python -m uvicorn backend.main:app --port 8000`) and `python tools/sensor_relay.py`.

Gas readings are shown as CO₂-equivalent ppm (start-up air = 400 ppm). The relay forwards each new reading (about one every 2 s, ~1,800 Firestore writes per hour); the free tier allows 20,000 writes a day, so stop the relay when you are not demoing.

### Firebase suggestion storage

1. Create a Firebase project with a Firestore database and service account.
2. Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` on the backend. A `GOOGLE_APPLICATION_CREDENTIALS` file can be used instead of the last two values.
3. Set a long random `OWNER_DASHBOARD_KEY` on the backend.
4. Restart the API and submit feedback through `/citizen`.
5. Start the independent owner API with `python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001`.
6. In a second terminal, run `cd owner-dashboard` then `npm start`, and open `http://127.0.0.1:3001` to review it.

The owner console is a separate dependency-free Node app. It proxies only its own `/api/suggestions` request to `OWNER_API_URL` (default `http://127.0.0.1:8001`) and does not modify or restart the public dashboard on port 3000.

Firebase credentials and the owner key are server-only. Never prefix them with `NEXT_PUBLIC_` or commit them to Git.

## Evidence boundaries

No live AQ readings, measured efficiencies, transport coefficients, benefits or station scores ship with this project. OpenAQ requires a key. The backend uses explicitly configured location IDs when supplied; otherwise, it discovers monitoring locations within the configured radius around Bengaluru. The Locations view maps each candidate area to the nearest returned station with a PM2.5 measurement and keeps the station name, distance, units and measurement time visible; it does not spatially interpolate readings. CPCB is a documented source reference, not an implemented authenticated connector. Historical ingestion and aggregation are not implemented, and no fake time series is displayed.

Open-Meteo modeled air quality is still used by the Digital Twin and Analysis views at a user-selected coordinate. The Locations view uses measured OpenAQ station observations through the backend instead. Production/commercial usage must use appropriately licensed data endpoints. Basemap: OSM / CARTO. Purple and Green alignments are coarse planning schematics with approximate coordinates; not engineering GIS. Map tiles require internet.

## Engineering models

CADR = airflow × pollutant-specific single-pass efficiency. Capture (g/day) = CADR × inlet concentration × unit count × 24 / 1,000,000. Constant concentration and continuous operation are explicit assumptions. Capture is never converted directly to ambient AQI change.

The local model solves V dC/dt = S + Qvent Cbackground − (Qvent + CADR) C analytically. It assumes a well-mixed volume, constant source and ventilation, independent filtration, no recirculation overlap, chemistry or deposition. A caller must provide a calibration reference; this is not a claim that this implementation has been calibrated. A field calibration pipeline, holdout validation and exposure modeling remain necessary for real deployment decisions.

Uncertainty API resamples measured efficiency replicates with a reproducible seed; intervals exclude transport, airflow and spatial uncertainty. Missing replicates yield no interval. The UI clearly shows absent confidence intervals. Economics discounts energy and maintenance cash flows; no health benefits are fabricated.

Optimization enumerates candidate subsets under a budget (API limited to 16 candidates). Four normalized higher-is-better scores represent cost efficiency, exposure reduction, feasibility and equity. The cost score must be transformed before submission. Sensitivity increases each criterion weight by 20%. These utilities are not physical exposure estimates. Candidate scores need validated provenance; there are no default scores. UI sliders provide planning controls; scoring and sensitivity run through the API after valid inputs are supplied.

## Deployment and limitations

`npm run build` exports `out/` for static hosting. Deploy FastAPI separately over HTTPS and rebuild with its `NEXT_PUBLIC_API_URL`; set CORS to the exact frontend origin. Static hosting does not execute Python. Weather works independently; the frontend reports API unavailable when no reachable service exists.

This is a working research application foundation, not a field-validated production digital twin. Persistent scenario storage, authenticated ingestion jobs, historical CPCB/OpenAQ warehousing, geospatial population/exposure analysis, validated infrastructure GIS, calibration fitting, observability and production access controls require further integration. Scenarios persist only for the current browser session. Exports preserve the entered assumptions and calibration state. No selected Figma could be matched without a supplied reference.
