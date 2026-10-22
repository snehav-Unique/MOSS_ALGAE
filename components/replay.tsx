'use client';

import {useEffect, useMemo, useState} from 'react';
import {History, LoaderCircle, Pause, Play, Radio} from 'lucide-react';
import {CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {HourlyPoint, fetchHourlyAir, formatHour, modeledWithPods} from '../lib/air';
import {Explain} from './info';

export type ReplayFrame = {time:string; label:string; baseline:number; withPods:number};

export function TwinReplay({site, units, mossEfficiency, algaeEfficiency, hours, onFrame}:{site:{lat:number; lng:number}; units:number; mossEfficiency:number; algaeEfficiency:number; hours:number; onFrame:(frame:ReplayFrame|null)=>void}) {
  const [history, setHistory] = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState<number|null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true); setIndex(null); setPlaying(false); onFrame(null);
    fetchHourlyAir(site, 7, 1).then(data => {if (active) setHistory(data.filter(p => new Date(p.time).getTime() <= Date.now()))})
      .catch(() => {if (active) setHistory([])}).finally(() => {if (active) setLoading(false)});
    return () => {active = false};
    // Re-fetch only when the selected point moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.lat, site.lng]);

  const frames = useMemo<ReplayFrame[]>(() => history.map(p => ({time:p.time, label:formatHour(p.time), baseline:Number(p.pm25.toFixed(1)), withPods:Number(modeledWithPods(p.pm25, units, mossEfficiency / 100, algaeEfficiency / 100, hours).toFixed(1))})), [history, units, mossEfficiency, algaeEfficiency, hours]);

  useEffect(() => {onFrame(index == null ? null : frames[index] ?? null)}, [index, frames, onFrame]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setIndex(current => {
      const next = (current ?? -1) + 1;
      if (next >= frames.length) {setPlaying(false); return frames.length - 1}
      return next;
    }), 120);
    return () => clearInterval(timer);
  }, [playing, frames.length]);

  const largest = frames.reduce<ReplayFrame|null>((best, f) => !best || f.baseline - f.withPods > best.baseline - best.withPods ? f : best, null);
  const above = frames.filter(f => f.baseline > 60).length;
  const aboveWithPods = frames.filter(f => f.withPods > 60).length;
  const current = index == null ? null : frames[index];

  return <article className="replay-panel">
    <div className="replay-head">
      <div><span><History size={15}/> TIME-LAPSE / PAST 7 DAYS</span><h2>{current ? current.label : 'Replay the week, hour by hour'}</h2></div>
      <div className="replay-actions">
        <button className="feature-button" disabled={!frames.length} onClick={() => {if (!playing && (index == null || index >= frames.length - 1)) setIndex(0); setPlaying(!playing)}}>{playing ? <Pause size={15}/> : <Play size={15}/>}{playing ? 'Pause' : 'Play week'}</button>
        <button className="feature-button secondary" disabled={index == null} onClick={() => {setPlaying(false); setIndex(null)}}><Radio size={15}/> Back to live</button>
      </div>
    </div>
    <Explain>Brown: hourly PM2.5 that actually occurred (Open-Meteo). Teal: the same hours modeled with your pods. Drag the slider or press Play; both maps above update to that hour.</Explain>
    {loading ? <div className="chart-empty replay-empty"><LoaderCircle className="spin" size={22}/><strong>Loading hourly history…</strong></div> : frames.length ? <>
      <input className="replay-slider" type="range" min="0" max={frames.length - 1} value={index ?? frames.length - 1} onChange={e => {setPlaying(false); setIndex(Number(e.target.value))}} aria-label="Replay hour"/>
      <div className="replay-body">
        <div className="replay-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={frames} margin={{top:10,right:16,left:0,bottom:0}}>
          <CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/>
          <XAxis dataKey="label" stroke="#73806f" interval={23} minTickGap={30}/>
          <YAxis unit=" µg" stroke="#73806f" width={60}/>
          <Tooltip content={({active, payload}:any) => active && payload?.length ? <div className="model-tooltip"><strong>{payload[0].payload.label}</strong><span>Without pods: {payload[0].payload.baseline} µg/m³</span><span>With pods (modeled): {payload[0].payload.withPods} µg/m³</span></div> : null}/>
          <ReferenceLine y={60} stroke="#d0703c" strokeDasharray="4 4" label={{value:'NAAQS 24 h', position:'insideTopLeft', fill:'#b8612f'}}/>
          {current && <ReferenceLine x={current.label} stroke="#10241b" strokeWidth={2}/>}
          <Line type="monotone" dataKey="baseline" name="Without pods" stroke="#9b735d" strokeWidth={2.5} dot={false} isAnimationActive={false}/>
          <Line type="monotone" dataKey="withPods" name="With pods" stroke="#16858c" strokeWidth={2.5} dot={false} isAnimationActive={false}/>
        </LineChart></ResponsiveContainer></div>
        <div className="replay-facts">
          <div><span>LARGEST MODELED DROP</span><strong>{largest ? `−${(largest.baseline - largest.withPods).toFixed(1)} µg/m³` : '—'}</strong><small>{largest?.label}</small></div>
          <div><span>HOURS ABOVE 60 µg/m³</span><strong>{above} → {aboveWithPods}</strong><small>Without → with pods, of {frames.length} hours</small></div>
        </div>
      </div>
    </> : <div className="chart-empty replay-empty"><strong>Hourly history unavailable</strong></div>}
  </article>;
}
