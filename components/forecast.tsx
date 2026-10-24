'use client';

import {useEffect, useMemo, useState} from 'react';
import {ArrowRight, CalendarClock, LoaderCircle, ShieldCheck, Zap} from 'lucide-react';
import {Area, ComposedChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {CANDIDATE_SITES, HourlyPoint, fetchHourlyAir, formatHour} from '../lib/air';
import {Guide} from './info';

function percentile(values:number[], p:number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

export function Forecast({onApplySchedule}:{onApplySchedule:(fullPowerHoursPerDay:number, label:string)=>void}) {
  const [siteId, setSiteId] = useState(CANDIDATE_SITES[6].id);
  const [points, setPoints] = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState<number|null>(null);
  const [leadHours, setLeadHours] = useState(1);
  const [ecoAirflow, setEcoAirflow] = useState(35);
  const [boostWatts, setBoostWatts] = useState(40);
  const [ecoWatts, setEcoWatts] = useState(12);
  const site = CANDIDATE_SITES.find(s => s.id === siteId)!;

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    fetchHourlyAir(site, 0, 3).then(data => {
      if (!active) return;
      const now = Date.now() - 3.6e6;
      const upcoming = data.filter(p => new Date(p.time).getTime() >= now).slice(0, 72);
      if (!upcoming.length) throw new Error('No upcoming forecast values were returned.');
      setPoints(upcoming);
      setThreshold(Math.max(1, Math.round(percentile(upcoming.map(p => p.pm25), .7))));
    }).catch(reason => {if (active) {setPoints([]); setError(reason.message)}}).finally(() => {if (active) setLoading(false)});
    return () => {active = false};
  }, [site]);

  const plan = useMemo(() => {
    if (!points.length || threshold == null) return null;
    const schedule = points.map((point, index) => {
      const window = points.slice(index, index + 1 + leadHours);
      const boost = window.some(p => p.pm25 >= threshold);
      return {...point, label:formatHour(point.time), boost, mode:boost ? 1 : 0};
    });
    const eco = ecoAirflow / 100;
    const hours = schedule.length;
    const boostHours = schedule.filter(s => s.boost).length;
    const smartKwh = (boostHours * boostWatts + (hours - boostHours) * ecoWatts) / 1000;
    const alwaysKwh = hours * boostWatts / 1000;
    // Captured mass is proportional to airflow × inlet concentration under constant efficiency.
    const smartMass = schedule.reduce((sum, s) => sum + s.pm25 * (s.boost ? 1 : eco), 0);
    const alwaysMass = schedule.reduce((sum, s) => sum + s.pm25, 0);
    const peak = schedule.reduce((max, s) => s.pm25 > max.pm25 ? s : max, schedule[0]);
    const firstBoost = schedule.find(s => s.boost);
    return {schedule, boostHours, hours, smartKwh, alwaysKwh, energySaving:1 - smartKwh / alwaysKwh, massShare:smartMass / alwaysMass, peak, firstBoost,
      fullPowerHoursPerDay:smartKwh * 1000 / boostWatts / (hours / 24)};
  }, [points, threshold, leadHours, ecoAirflow, boostWatts, ecoWatts]);

  const maxPm = points.length ? Math.max(...points.map(p => p.pm25)) : 100;

  return <section className="feature-view forecast-view">
    <header className="feature-header"><div><p className="kicker">FORECAST / ANTICIPATORY OPERATION</p><h1>Run hard before the peak, rest when the air is clean.</h1><p>A 72-hour PM2.5 forecast drives a pod operating schedule: full airflow when pollution is forecast above your threshold (and a lead time before it), eco mode otherwise.</p></div><div className="feature-status">{loading ? <><LoaderCircle className="spin" size={16}/> Loading forecast</> : error ? <span className="warn">{error}</span> : <><span className="live-dot"/> Open-Meteo hourly forecast</>}</div></header>

    <div className="site-chips">{CANDIDATE_SITES.map(s => <button key={s.id} className={s.id === siteId ? 'active' : ''} onClick={() => setSiteId(s.id)}>{s.name}</button>)}</div>

    <div className="planner-controls forecast-controls">
      <label><span>BOOST THRESHOLD</span><strong>{threshold ?? '—'} µg/m³</strong><input type="range" min="5" max={Math.max(60, Math.ceil(maxPm))} value={threshold ?? 0} onChange={e => setThreshold(Number(e.target.value))}/></label>
      <label><span>LEAD TIME</span><strong>{leadHours} h</strong><input type="range" min="0" max="4" value={leadHours} onChange={e => setLeadHours(Number(e.target.value))}/></label>
      <label><span>ECO AIRFLOW</span><strong>{ecoAirflow}%</strong><input type="range" min="0" max="80" step="5" value={ecoAirflow} onChange={e => setEcoAirflow(Number(e.target.value))}/></label>
      <label><span>BOOST POWER</span><strong>{boostWatts} W</strong><input type="range" min="10" max="150" step="2" value={boostWatts} onChange={e => setBoostWatts(Number(e.target.value))}/></label>
      <label><span>ECO POWER</span><strong>{ecoWatts} W</strong><input type="range" min="0" max={boostWatts} step="1" value={Math.min(ecoWatts, boostWatts)} onChange={e => setEcoWatts(Number(e.target.value))}/></label>
    </div>

    <Guide title="How the smart schedule works" columns={4} items={[
      {title:'Boost threshold', body:'Pods run at full airflow whenever the forecast reaches this PM2.5 level. It starts at the 70th percentile of the 72-hour forecast.'},
      {title:'Lead time and eco mode', body:'Lead time starts boosting a few hours before a peak so the air is already being cleaned when pollution arrives. Eco airflow is the reduced fan speed used the rest of the time.'},
      {title:'Energy saved', body:'Electricity saved per pod over the forecast window compared with running at full power every hour.'},
      {title:'Capture retained', body:'How much of the always-on captured mass the smart schedule still achieves, because it runs hardest when the air is dirtiest.'},
    ]}/>
    <div className="analysis-metrics">
      <div className="analysis-metric"><span>FORECAST PEAK</span><strong>{plan ? `${plan.peak.pm25.toFixed(0)} µg/m³` : '—'}</strong><small>{plan ? plan.peak.label : 'Awaiting forecast'}</small></div>
      <div className="analysis-metric"><span>NEXT BOOST STARTS</span><strong>{plan?.firstBoost ? plan.firstBoost.label : plan ? 'Not needed' : '—'}</strong><small>{plan ? `${plan.boostHours} of ${plan.hours} hours at full airflow` : ''}</small></div>
      <div className="analysis-metric"><span>ENERGY SAVED VS ALWAYS-ON</span><strong>{plan ? `${(plan.energySaving * 100).toFixed(0)}%` : '—'}</strong><small>{plan ? `${plan.smartKwh.toFixed(2)} vs ${plan.alwaysKwh.toFixed(2)} kWh per pod` : ''}</small></div>
      <div className="analysis-metric"><span>CAPTURE RETAINED</span><strong>{plan ? `${(plan.massShare * 100).toFixed(0)}%` : '—'}</strong><small>Of always-on captured mass, same media efficiency</small></div>
    </div>

    <article className="feature-panel">
      <div className="panel-heading"><div><span><CalendarClock size={15}/> {site.name.toUpperCase()} / NEXT {plan?.hours ?? 72} HOURS</span><h2>Forecast and operating schedule</h2></div>{plan && <button className="feature-button" onClick={() => onApplySchedule(plan.fullPowerHoursPerDay, `${site.name} forecast schedule`)}><Zap size={15}/> Use in Planner economics <ArrowRight size={15}/></button>}</div>
      <div className="chart-frame">{plan ? <ResponsiveContainer width="100%" height="100%"><ComposedChart data={plan.schedule} margin={{top:15,right:24,left:5,bottom:5}}>
        <defs><linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#99745c" stopOpacity={.55}/><stop offset="100%" stopColor="#99745c" stopOpacity={.08}/></linearGradient></defs>
        <CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/>
        <XAxis dataKey="label" stroke="#73806f" interval={11} minTickGap={20}/>
        <YAxis unit=" µg/m³" stroke="#73806f"/>
        <Tooltip content={({active, payload}:any) => active && payload?.length ? <div className="model-tooltip"><strong>{payload[0].payload.label}</strong><span>PM2.5 forecast: {payload[0].payload.pm25.toFixed(1)} µg/m³</span><span>Mode: {payload[0].payload.boost ? 'Boost (full airflow)' : `Eco (${ecoAirflow}% airflow)`}</span></div> : null}/>
        <Area type="monotone" dataKey="pm25" name="PM2.5 forecast" stroke="#99745c" strokeWidth={3} fill="url(#forecastFill)"/>
        {threshold != null && <ReferenceLine y={threshold} stroke="#16858c" strokeDasharray="6 4" strokeWidth={2} label={{value:'Boost threshold', position:'insideTopRight', fill:'#16858c'}}/>}
      </ComposedChart></ResponsiveContainer> : <div className="chart-empty"><CalendarClock size={28}/><strong>{loading ? 'Loading forecast…' : 'Forecast unavailable'}</strong></div>}</div>
      {plan && <div className="schedule-strip" aria-label="Operating schedule by hour">{plan.schedule.map(s => <i key={s.time} className={s.boost ? 'boost' : ''} title={`${s.label}: ${s.boost ? 'Boost' : 'Eco'}`}/>)}</div>}
      {plan && <div className="schedule-legend"><span><i className="boost"/> Boost · full airflow</span><span><i/> Eco · {ecoAirflow}% airflow</span><span>Each cell = 1 hour</span></div>}
    </article>

    <footer className="analysis-disclaimer"><strong><ShieldCheck size={16}/> ASSUMPTIONS</strong><p>Forecast from the Open-Meteo air-quality model (coarse grid; not station-calibrated). Capture retained assumes single-pass efficiency is independent of airflow, which must be verified on the chamber. Energy figures use the stated fan powers per pod. &ldquo;Use in Planner&rdquo; converts this schedule into energy-equivalent full-power hours per day.</p></footer>
  </section>;
}
