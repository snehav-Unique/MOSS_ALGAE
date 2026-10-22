'use client';

import {useState} from 'react';
import {LoaderCircle, Printer, Sparkles, X} from 'lucide-react';
import {formatInr} from '../lib/air';
import {PlannerState, askAssistant} from './assistant';

export type ReportData = {
  budget:number; spend:number; pods:number; podsPerSite:number; podCost:number; weights:Array<{name:string; share:number}>;
  rows:Array<{name:string; context:string; pm25:number; receptors:number; cost:number}>;
  lifecycleCost:number|null; years:number; dutyHours:number; lifetimeKg:number; costPerGram:number|null; combinedEfficiency:number;
  sensitivity:string[]; exposureSource:string; airTime:string;
};

const SUMMARY_PROMPT = 'Write a 120-word executive summary of the current Planner recommendation for a municipal official: what to deploy where, total and lifecycle cost, who is protected nearby, how robust the choice is to weight changes, and the main caveats. Use only tool results.';

export function ReportSheet({data, planner, onClose}:{data:ReportData; planner:PlannerState|null; onClose:()=>void}) {
  const [summary, setSummary] = useState<string|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generated = new Date();

  const generate = async () => {
    setLoading(true); setError('');
    try {setSummary((await askAssistant([{role:'user', text:SUMMARY_PROMPT}], planner)).reply)}
    catch (e:any) {setError(e.message)}
    finally {setLoading(false)}
  };

  return <div className="report-backdrop">
    <div className="report-toolbar no-print">
      <button className="feature-button" onClick={generate} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>}{summary ? 'Regenerate AI summary' : 'Add AI summary'}</button>
      <button className="feature-button" onClick={() => window.print()}><Printer size={15}/> Print / Save as PDF</button>
      <button className="feature-button secondary" onClick={onClose}><X size={15}/> Close</button>
      {error && <span className="warn">{error}</span>}
    </div>
    <article className="report-sheet">
      <header><span>MOSS–ALGAE INDIA · DEPLOYMENT BRIEF</span><h1>Living biofilter pods for Bengaluru</h1><p>Generated {generated.toLocaleString('en-IN')} · Air data {data.airTime.replace('T', ' ')} · {data.exposureSource}</p></header>
      {summary && <section><h2>Executive summary</h2><p className="report-summary">{summary}</p><small>Drafted by the planning assistant from tool outputs; review before circulating.</small></section>}
      <section className="report-kpis">
        <div><span>Budget</span><strong>{formatInr(data.budget)}</strong></div>
        <div><span>Recommended spend</span><strong>{formatInr(data.spend)}</strong></div>
        <div><span>Pods</span><strong>{data.pods}</strong></div>
        <div><span>{data.years}-year lifecycle cost</span><strong>{data.lifecycleCost != null ? formatInr(data.lifecycleCost) : '—'}</strong></div>
      </section>
      <section><h2>Recommended areas</h2>
        <table><thead><tr><th>Area</th><th>Context</th><th>PM2.5 (µg/m³)</th><th>Receptors ≤500 m</th><th>Cost</th></tr></thead>
          <tbody>{data.rows.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.context}</td><td>{r.pm25.toFixed(1)}</td><td>{r.receptors}</td><td>{formatInr(r.cost)}</td></tr>)}</tbody></table>
        {!data.rows.length && <p>No area fits the current budget.</p>}
      </section>
      <section className="report-two"><div><h2>Priorities used</h2><ul>{data.weights.map(w => <li key={w.name}>{w.name}: {Math.round(w.share * 100)}%</li>)}</ul><p>{data.podsPerSite} pods per area at {formatInr(data.podCost)} each plus area setup cost.</p></div>
        <div><h2>Robustness</h2><ul>{data.sensitivity.map(s => <li key={s}>{s}</li>)}</ul></div></section>
      <section><h2>Performance and cost</h2><ul>
        <li>Combined two-stage media efficiency: {(data.combinedEfficiency * 100).toFixed(0)}% (moss followed by algae, series equation).</li>
        <li>PM2.5 mass captured over {data.years} years at {data.dutyHours.toFixed(1)} full-power hours/day: {data.lifetimeKg.toFixed(2)} kg, assuming current concentrations persist.</li>
        <li>Cost per gram captured: {data.costPerGram != null ? formatInr(data.costPerGram) : '—'}.</li>
      </ul></section>
      <section className="report-limits"><h2>Evidence boundaries</h2><p>Captured mass is not an ambient air-quality or health outcome; no health benefit is monetized. Air values are modeled (Open-Meteo) unless stated; receptor counts are mapped OpenStreetMap features, not population. Feasibility, equity and setup costs are team assumptions to be replaced with site surveys. Field calibration, pressure-drop testing and permissions are required before deployment.</p></section>
    </article>
  </div>;
}
