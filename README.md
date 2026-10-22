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

- **Hotspots** — `/api/hotspots` discovers every OpenAQ PM2.5 station within 25 km of central Bengaluru (needs `OPENAQ_API_KEY`), flags stale (>3 h) and outlier (>3× network median) readings, and only counts verified readings as hotspots. Without a key the view falls back to clearly labeled Open-Meteo modeled values.
- **Exposure** — `/api/exposure` counts schools, hospitals/clinics and bus stops within 500 m of each candidate area from OpenStreetMap (Overpass). `public/exposure-snapshot.json` is the offline fallback; refresh it with `python backend/exposure.py`.
- **Planner** — budget optimizer over cost, exposure, feasibility and equity via `/api/optimize` (with ±20% weight sensitivity) and discounted lifecycle cost via `/api/economics`. Feasibility, equity and setup costs are editable team assumptions.
- **Forecast** — 72-hour Open-Meteo PM2.5 forecast turned into a boost/eco operating schedule; reports energy saved and capture retained versus always-on, and can push its duty cycle into Planner economics.
- **Time-lapse** — the Twin view replays the past 7 days hour by hour on both synced maps.
- **Planning assistant** — `/api/assistant` runs Google Gemini (`gemini-3.5-flash-lite`, override with `GEMINI_MODEL`) with the platform's own tools: Planner state, optimizer, lifecycle economics, hotspots, receptors and forecast. Set `GEMINI_API_KEY` on the API service (free key from https://aistudio.google.com/apikey); the key never reaches the browser. If only `ANTHROPIC_API_KEY` is set, Claude is used instead.
- **Deployment brief** — Planner → "Deployment brief (PDF)" renders a printable report with an optional AI executive summary; use the browser's Save as PDF.
- **Citizen page** — `/citizen` is a mobile page in English, ಕನ್ನಡ and हिंदी: PM2.5 near you, advice by group, cleanest 2-hour window, nearest proposed pod area, and a "suggest a pod location" form (`/api/suggestions`, in-memory) whose entries appear on the Planner map.

## Evidence boundaries

No live AQ readings, measured efficiencies, transport coefficients, benefits or station scores ship with this project. OpenAQ requires a key and explicitly selected location IDs. The API retains measurement timestamps, raw sensor identity, parameter units, location provider, retrieval time, and source URL. No readings are spatially interpolated to metro locations. CPCB is a documented source reference, not an implemented authenticated connector. History period selection is preparatory: historical ingestion and aggregation are not implemented, and no fake time series is displayed.

Open-Meteo current weather is modeled weather, fetched at selected coordinates with a valid time. Production/commercial usage must use an appropriately licensed endpoint. Basemap: OSM / CARTO. Purple and Green alignments are coarse planning schematics with approximate station coordinates; not engineering GIS. Map tiles require internet.

## Engineering models

CADR = airflow × pollutant-specific single-pass efficiency. Capture (g/day) = CADR × inlet concentration × unit count × 24 / 1,000,000. Constant concentration and continuous operation are explicit assumptions. Capture is never converted directly to ambient AQI change.

The local model solves V dC/dt = S + Qvent Cbackground − (Qvent + CADR) C analytically. It assumes a well-mixed volume, constant source and ventilation, independent filtration, no recirculation overlap, chemistry or deposition. A caller must provide a calibration reference; this is not a claim that this implementation has been calibrated. A field calibration pipeline, holdout validation and exposure modeling remain necessary for real deployment decisions.

Uncertainty API resamples measured efficiency replicates with a reproducible seed; intervals exclude transport, airflow and spatial uncertainty. Missing replicates yield no interval. The UI clearly shows absent confidence intervals. Economics discounts energy and maintenance cash flows; no health benefits are fabricated.

Optimization enumerates candidate subsets under a budget (API limited to 16 candidates). Four normalized higher-is-better scores represent cost efficiency, exposure reduction, feasibility and equity. The cost score must be transformed before submission. Sensitivity increases each criterion weight by 20%. These utilities are not physical exposure estimates. Candidate scores need validated provenance; there are no default scores. UI sliders provide planning controls; scoring and sensitivity run through the API after valid inputs are supplied.

## Deployment and limitations

`npm run build` exports `out/` for static hosting. Deploy FastAPI separately over HTTPS and rebuild with its `NEXT_PUBLIC_API_URL`; set CORS to the exact frontend origin. Static hosting does not execute Python. Weather works independently; the frontend reports API unavailable when no reachable service exists.

This is a working research application foundation, not a field-validated production digital twin. Persistent scenario storage, authenticated ingestion jobs, historical CPCB/OpenAQ warehousing, geospatial population/exposure analysis, validated infrastructure GIS, calibration fitting, observability and production access controls require further integration. Scenarios persist only for the current browser session. Exports preserve the entered assumptions and calibration state. AQ cards intentionally remain missing until valid location/pollutant/averaging-period processing is implemented. No selected Figma could be matched without a supplied reference.
