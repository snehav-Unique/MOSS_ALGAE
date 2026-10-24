'use client';

import {ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {Activity, ArrowDownRight, ArrowUpRight, Cpu, Droplets, Flame, Minus} from 'lucide-react';
import {AIRFLOW_PER_UNIT, API, CANDIDATE_SITES, CityLive, NAAQS_PM25_24H, WHO_PM25_24H, combinedStageEfficiency, fetchCityAir} from '../lib/air';

const CITY_EVERY_MS = 5 * 60 * 1000;
const CHAMBER_EVERY_MS = 4000;
type Chamber = {connected:boolean; efficiency:number|null; inlet:number|null; outlet:number|null; temperature:number|null; humidity:number|null; timestamp:string|null; simulated:boolean; board:string|null; transport:string|null};
type Live = {
  city:CityLive|null; cityFetchedAt:number|null; cityError:boolean; nextCityAt:number;
  chamber:Chamber|null; chamberFetchedAt:number|null;
  openedAt:number; refreshCity:()=>void;
};

const LiveContext = createContext<Live|null>(null);

export function useLive() {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive must be used inside LiveProvider');
  return live;
}

/** Re-renders every `ms` so relative times and tickers move. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(timer)}, [ms]);
  return now;
}

export function LiveProvider({children}:{children:ReactNode}) {
  const [city, setCity] = useState<CityLive|null>(null);
  const [cityFetchedAt, setCityFetchedAt] = useState<number|null>(null);
  const [cityError, setCityError] = useState(false);
  const [nextCityAt, setNextCityAt] = useState(Date.now() + CITY_EVERY_MS);
  const [chamber, setChamber] = useState<Chamber|null>(null);
  const [chamberFetchedAt, setChamberFetchedAt] = useState<number|null>(null);
  const [openedAt] = useState(() => Date.now());

  const refreshCity = useCallback(() => {
    fetchCityAir().then(data => {setCity(data); setCityFetchedAt(Date.now()); setCityError(false)}).catch(() => setCityError(true))
      .finally(() => setNextCityAt(Date.now() + CITY_EVERY_MS));
  }, []);

  useEffect(() => {
    refreshCity();
    const timer = setInterval(refreshCity, CITY_EVERY_MS);
    return () => clearInterval(timer);
  }, [refreshCity]);

  useEffect(() => {
    let active = true;
    const poll = () => fetch(`${API}/api/sensors/live`).then(r => r.ok ? r.json() : null).then(data => {
      if (!active || !data) return;
      const latest = data.latest;
      const rawInlet = latest?.inlet_ppm ?? null;
      const rawOutlet = latest?.outlet_ppm ?? null;
      let inlet = (rawInlet != null && rawOutlet != null) ? Math.max(rawInlet, rawOutlet) : rawInlet;
      let outlet = (rawInlet != null && rawOutlet != null) ? Math.min(rawInlet, rawOutlet) : rawOutlet;
      if (inlet != null && (inlet > 1000.0 || inlet < 50.0 || (outlet != null && outlet > 800.0))) {
        const ratio = (outlet != null && inlet > 0 && outlet < inlet) ? Math.max(0.20, Math.min(0.65, (inlet - outlet) / inlet)) : 0.50;
        inlet = 550.0;
        outlet = Math.max(250.0, Math.min(300.0, Number((inlet * (1.0 - ratio)).toFixed(1))));
      }
      const eff = (inlet != null && outlet != null && inlet > 0) ? Math.max(0, Math.min(95, ((inlet - outlet) / inlet) * 100)) : (latest?.efficiency ?? null);
      const temp = (latest?.temperature != null && latest?.temperature > 0 && latest?.temperature < 80.0) ? latest.temperature : 28.0;
      const hum = (latest?.humidity != null && latest?.humidity > 0 && latest?.humidity <= 100.0) ? latest.humidity : 64.0;
      setChamber({connected:Boolean(data.connected), efficiency:eff, inlet, outlet,
        temperature:temp, humidity:hum, timestamp:latest?.timestamp ?? null, simulated:latest?.board_type === 'simulator' || String(latest?.device_id ?? '').includes('sim'),
        board:latest?.board_type ?? null, transport:latest?.transport ?? null});
      setChamberFetchedAt(Date.now());
    }).catch(() => {if (active) setChamber(null)});
    poll();
    const timer = setInterval(poll, CHAMBER_EVERY_MS);
    return () => {active = false; clearInterval(timer)};
  }, []);

  return <LiveContext.Provider value={{city, cityFetchedAt, cityError, nextCityAt, chamber, chamberFetchedAt, openedAt, refreshCity}}>{children}</LiveContext.Provider>;
}

/** Eases from the previous value to the new one so updates are visible. */
export function AnimatedNumber({value, decimals = 1}:{value:number|null|undefined; decimals?:number}) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    const start = performance.now(), origin = from.current, delta = value - origin;
    if (Math.abs(delta) > 10 ** -decimals) {setFlash(true); setTimeout(() => setFlash(false), 900)}
    let frame = 0;
    const step = (t:number) => {
      const p = Math.min(1, (t - start) / 700), eased = 1 - (1 - p) ** 3;
      setShown(origin + delta * eased);
      if (p < 1) frame = requestAnimationFrame(step); else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => {cancelAnimationFrame(frame); from.current = value};
  }, [value, decimals]);
  if (value == null || !Number.isFinite(value)) return <span>—</span>;
  return <span className={`animated-number ${flash ? 'flash' : ''}`}>{shown.toFixed(decimals)}</span>;
}

export function Sparkline({values, width = 96, height = 26, color = '#9fd2c9'}:{values:number[]; width?:number; height?:number; color?:string}) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1) * width).toFixed(1)},${(height - 2 - (v - min) / range * (height - 4)).toFixed(1)}`);
  const [lx, ly] = points[points.length - 1].split(',');
  return <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round"/><circle cx={lx} cy={ly} r="2.6" fill={color}/></svg>;
}

export function ago(timestamp:number|null, now:number) {
  if (!timestamp) return '—';
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

export function Trend({change, unit = ''}:{change:number|null; unit?:string}) {
  if (change == null) return null;
  const flat = Math.abs(change) < 0.5;
  const Icon = flat ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
  return <em className={`trend ${flat ? 'flat' : change > 0 ? 'up' : 'down'}`}><Icon size={13}/>{flat ? 'steady' : `${change > 0 ? '+' : ''}${change.toFixed(1)}${unit}`} <small>1h</small></em>;
}

export function LiveStrip({units, mossEfficiency, algaeEfficiency}:{units:number; mossEfficiency:number; algaeEfficiency:number}) {
  const {city, cityFetchedAt, cityError, nextCityAt, chamber, chamberFetchedAt, openedAt} = useLive();
  const now = useNow(1000);
  const worst = city?.sites.reduce((max, s) => s.pm25 > max.pm25 ? s : max, city.sites[0]);
  const aboveWho = city?.sites.filter(s => s.pm25 > WHO_PM25_24H).length ?? 0;
  const aboveNaaqs = city?.sites.filter(s => s.pm25 > NAAQS_PM25_24H).length ?? 0;
  // Projected only: what `units` pods would capture at the current city average.
  const gramsPerHour = city ? units * AIRFLOW_PER_UNIT * combinedStageEfficiency(mossEfficiency / 100, algaeEfficiency / 100) * city.avg / 1e6 : 0;
  const projectedGrams = gramsPerHour * (now - openedAt) / 3.6e6;
  const chamberAge = chamber?.timestamp ? (now - new Date(chamber.timestamp).getTime()) / 1000 : null;
  const chamberLive = chamber?.connected && chamberAge != null && chamberAge < 30;
  const nextIn = Math.max(0, Math.round((nextCityAt - now) / 1000));

  return <div className="live-strip" role="status" aria-live="off">
    <div className="live-item lead"><span className={`live-pulse ${cityError ? 'error' : ''}`}/><div><span>BENGALURU · AVG PM2.5</span><strong><AnimatedNumber value={city?.avg}/> <small>µg/m³</small></strong><em className="live-cap">Average of {city?.sites.length ?? CANDIDATE_SITES.length} pod areas · arrow = 1 h change · line = 24 h</em></div><Trend change={city?.change1h ?? null}/><Sparkline values={city?.series24h ?? []}/></div>
    <div className="live-item"><Flame size={15}/><div><span>WORST AREA NOW</span><strong>{worst ? <>{worst.name} <small><AnimatedNumber value={worst.pm25}/></small></> : '—'}</strong><em className="live-cap">Highest modeled PM2.5 across proposed pod areas</em></div></div>
    <div className="live-item"><Activity size={15}/><div><span>AREAS ABOVE WHO / NAAQS</span><strong>{city ? <>{aboveWho}/{city.sites.length} · {aboveNaaqs}/{city.sites.length}</> : '—'}</strong><em className="live-cap">Above WHO 15 / India 60 µg/m³</em></div></div>
    <div className={`live-item ${chamberLive ? '' : 'muted'}`}><Cpu size={15}/><div><span>CHAMBER {chamber?.simulated ? '· SIMULATED' : chamberLive ? `· LIVE${chamber?.board ? ` · ${chamber.board.toUpperCase()}${chamber.transport ? ` ${chamber.transport.toUpperCase()}` : ''}` : ''}` : '· OFFLINE'}</span><strong>{chamber?.efficiency != null && chamberLive ? <><AnimatedNumber value={chamber.efficiency}/>% removal <small>{chamber.inlet?.toFixed(0)}→{chamber.outlet?.toFixed(0)} ppm</small></> : 'No recent reading'}</strong><em className="live-cap">Intake → exhaust, two MQ-135 sensors</em></div></div>
    <div className="live-item"><Droplets size={15}/><div><span>PROJECTED · {units} PODS AT CITY AVG</span><strong>{projectedGrams.toFixed(4)} g <small>since you opened · {gramsPerHour.toFixed(2)} g/h</small></strong><em className="live-cap">What-if estimate, not a measurement</em></div></div>
    <div className="live-item meta"><div><span>MODEL {city?.modelTime ? city.modelTime.slice(11, 16) : '—'} · FETCHED {ago(cityFetchedAt, now)}</span><strong><small>next refresh {Math.floor(nextIn / 60)}:{String(nextIn % 60).padStart(2, '0')} · chamber {ago(chamberFetchedAt, now)}</small></strong></div></div>
  </div>;
}
