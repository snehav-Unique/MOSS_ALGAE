'use client';

import {useEffect, useMemo, useState} from 'react';
import {Calculator, CheckCircle2, FileText, LoaderCircle, ShieldCheck, TrendingUp} from 'lucide-react';
import {AIRFLOW_PER_UNIT, API, Air, CANDIDATE_SITES, CandidateSite, combinedStageEfficiency, fetchCurrentAir, formatInr} from '../lib/air';
import {receptorTotal, useExposure} from './exposure';
import {PlannerState} from './assistant';
import {ReportData, ReportSheet} from './report';
import {useLeafletMap} from './use-leaflet-map';
import {Guide} from './info';

const CRITERIA = ['Cost efficiency', 'Exposure', 'Feasibility', 'Equity'];
const WEIGHT_HELP = [
  'Favors cheaper areas, so the budget stretches further. Score = cheapest area cost ÷ this area’s cost.',
  'Favors dirty air near many people: PM2.5 × (1 + schools, clinics and bus stops within 500 m).',
  'Favors areas where installation is practical: space, power and permissions. A team assumption you can edit below.',
  'Favors underserved neighbourhoods, such as industrial or low-income wards. A team assumption you can edit below.',
];

// Planning assumptions per area. Editable in the table; replace with site-survey data before real use.
const SITE_ASSUMPTIONS:Record<string,{setup:number; feasibility:number; equity:number}> = {
  'peenya':{setup:4000, feasibility:.7, equity:.9},
  'yeshwanthpur':{setup:3500, feasibility:.7, equity:.6},
  'majestic':{setup:6000, feasibility:.5, equity:.7},
  'hebbal':{setup:4500, feasibility:.6, equity:.5},
  'kr-puram':{setup:3500, feasibility:.7, equity:.8},
  'whitefield':{setup:3000, feasibility:.8, equity:.4},
  'silk-board':{setup:5500, feasibility:.5, equity:.6},
  'jayanagar':{setup:2500, feasibility:.9, equity:.4},
};

type Candidate = {id:string; cost:number; scores:number[]};
type OptimizeResult = {utility:number; selected:string[]; normalized_weights:number[]; sensitivity?:Array<{criterion:number; result:{selected:string[]}}>};

function optimizeLocally(candidates:Candidate[], weights:number[], budget:number):OptimizeResult {
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const w = weights.map(value => value / total);
  let best:OptimizeResult = {utility:0, selected:[], normalized_weights:w};
  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const selected = candidates.filter((_, index) => mask & (1 << index));
    if (selected.reduce((sum, c) => sum + c.cost, 0) > budget) continue;
    const utility = selected.reduce((sum, c) => sum + c.scores.reduce((s, score, i) => s + score * w[i], 0), 0);
    if (utility > best.utility) best = {utility, selected:selected.map(c => c.id), normalized_weights:w};
  }
  return best;
}

function lifecycleLocally(capex:number, energyKwh:number, tariff:number, maintenance:number, years:number, discount:number) {
  let total = capex;
  for (let year = 1; year <= years; year++) total += (energyKwh * tariff + maintenance) / (1 + discount) ** year;
  return total;
}

async function postJson(path:string, body:unknown) {
  const response = await fetch(`${API}${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!response.ok) throw new Error(path);
  return response.json();
}

export function Planner({mossEfficiency, algaeEfficiency, dutyHours, setDutyHours, scheduleSource, planner, onStateChange}:{mossEfficiency:number; algaeEfficiency:number; dutyHours:number; setDutyHours:(value:number)=>void; scheduleSource:string|null; planner:PlannerState|null; onStateChange:(state:PlannerState)=>void}) {
  const [air, setAir] = useState<Record<string,Air>>({});
  const [airLoading, setAirLoading] = useState(true);
  const {data:exposure, mode:exposureMode} = useExposure();
  const [assumptions, setAssumptions] = useState(SITE_ASSUMPTIONS);
  const [budgetLakh, setBudgetLakh] = useState(10);
  const [podCost, setPodCost] = useState(4000);
  const [podsPerSite, setPodsPerSite] = useState(4);
  const [weights, setWeights] = useState([25, 35, 20, 20]);
  const [result, setResult] = useState<OptimizeResult|null>(null);
  const [solver, setSolver] = useState<'api'|'local'|null>(null);
  const [fanWatts, setFanWatts] = useState(40);
  const [tariff, setTariff] = useState(8);
  const [maintenance, setMaintenance] = useState(500);
  const [years, setYears] = useState(10);
  const [discount, setDiscount] = useState(8);
  const [lifecycleCost, setLifecycleCost] = useState<number|null>(null);
  const [showReport, setShowReport] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{lat:number; lng:number; reason:string}>>([]);
  const {node, leaflet, tileError} = useLeafletMap(CANDIDATE_SITES.map(site => [site.lat, site.lng]));

  useEffect(() => {
    let active = true;
    Promise.all(CANDIDATE_SITES.map(async site => [site.id, await fetchCurrentAir(site).catch(() => null)] as const)).then(entries => {
      if (!active) return;
      setAir(Object.fromEntries(entries.filter(([, value]) => value && Number.isFinite(value.pm25))) as Record<string,Air>);
      setAirLoading(false);
    });
    fetch(`${API}/api/suggestions`).then(r => r.ok ? r.json() : null).then(data => {if (active && data) setSuggestions(data.suggestions)}).catch(() => {});
    return () => {active = false};
  }, []);

  const candidates = useMemo(() => {
    const sites = CANDIDATE_SITES.filter(site => air[site.id]);
    const costs = sites.map(site => assumptions[site.id].setup + podsPerSite * podCost);
    const minCost = Math.min(...costs);
    const exposureRaw = sites.map(site => air[site.id].pm25 * (1 + receptorTotal(exposure?.sites[site.id])));
    const maxExposure = Math.max(...exposureRaw, 1e-9);
    return sites.map((site, index):Candidate & {site:CandidateSite} => ({
      id:site.id, site, cost:costs[index],
      scores:[minCost / costs[index], exposureRaw[index] / maxExposure, assumptions[site.id].feasibility, assumptions[site.id].equity].map(value => Math.max(0, Math.min(1, value))),
    }));
  }, [air, exposure, assumptions, podsPerSite, podCost]);

  const budget = budgetLakh * 1e5;
  useEffect(() => {
    if (!candidates.length || weights.every(w => w === 0)) {setResult(null); return}
    let active = true;
    const payload = {candidates:candidates.map(({id, cost, scores}) => ({id, cost, scores})), weights, budget};
    const timer = setTimeout(() => {
      postJson('/api/optimize', payload).then(data => {if (active) {setResult(data); setSolver('api')}}).catch(() => {
        if (!active) return;
        const base = optimizeLocally(payload.candidates, weights, budget);
        base.sensitivity = weights.map((_, i) => ({criterion:i, result:optimizeLocally(payload.candidates, weights.map((w, j) => j === i ? w * 1.2 : w), budget)}));
        setResult(base); setSolver('local');
      });
    }, 250);
    return () => {active = false; clearTimeout(timer)};
  }, [candidates, weights, budget]);

  const selected = candidates.filter(c => result?.selected.includes(c.id));
  const spent = selected.reduce((sum, c) => sum + c.cost, 0);
  const pods = selected.length * podsPerSite;
  const annualEnergyKwh = pods * fanWatts * dutyHours * 365 / 1000;
  useEffect(() => {
    if (!pods) {setLifecycleCost(null); return}
    let active = true;
    const payload = {capex:spent, annual_energy_kwh:annualEnergyKwh, tariff, annual_maintenance:pods * maintenance, years, discount:discount / 100};
    postJson('/api/economics', payload).then(data => {if (active) setLifecycleCost(Number(data.discounted_cost_inr))})
      .catch(() => {if (active) setLifecycleCost(lifecycleLocally(payload.capex, payload.annual_energy_kwh, tariff, payload.annual_maintenance, years, payload.discount))});
    return () => {active = false};
  }, [pods, spent, annualEnergyKwh, tariff, maintenance, years, discount]);

  const combinedEfficiency = combinedStageEfficiency(mossEfficiency / 100, algaeEfficiency / 100);
  const lifetimeGrams = selected.reduce((sum, c) => sum + podsPerSite * AIRFLOW_PER_UNIT * combinedEfficiency * air[c.id].pm25 * dutyHours * 365 * years / 1e6, 0);
  const receptors = selected.reduce((sum, c) => {
    const site = exposure?.sites[c.id];
    return {school:sum.school + (site?.school ?? 0), health:sum.health + (site?.health ?? 0), bus_stop:sum.bus_stop + (site?.bus_stop ?? 0)};
  }, {school:0, health:0, bus_stop:0});

  const sensitivity = (result?.sensitivity ?? []).map(({criterion, result:alt}) => {
    const added = alt.selected.filter(id => !result?.selected.includes(id));
    const removed = (result?.selected ?? []).filter(id => !alt.selected.includes(id));
    return {criterion, added, removed};
  });
  const siteName = (id:string) => CANDIDATE_SITES.find(site => site.id === id)?.name ?? id;
  const sensitivityLines = sensitivity.map(({criterion, added, removed}) => added.length || removed.length ? `${CRITERIA[criterion]} +20%: ${removed.map(siteName).join(', ') || '—'} → ${added.map(siteName).join(', ') || '—'}` : `${CRITERIA[criterion]} +20%: recommendation unchanged`);
  const costPerGram = lifecycleCost != null && lifetimeGrams > 0 ? lifecycleCost / lifetimeGrams : null;

  useEffect(() => {
    if (!candidates.length) return;
    onStateChange({
      candidates:candidates.map(c => ({id:c.id, name:c.site.name, context:c.site.context, cost:Math.round(c.cost), scores:c.scores.map(v => Number(v.toFixed(3))), pm25:air[c.id].pm25, receptors:exposure?.sites[c.id] ? {schools:exposure.sites[c.id].school, health:exposure.sites[c.id].health, bus_stops:exposure.sites[c.id].bus_stop} : null})),
      criteria_order:CRITERIA, weights, budget_inr:budget, pods_per_site:podsPerSite, cost_per_pod_inr:podCost,
      current_recommendation:{selected:selected.map(c => c.site.name), spend_inr:spent, pods, lifecycle_cost_inr:lifecycleCost, captured_kg_over_horizon:Number((lifetimeGrams / 1000).toFixed(2)), cost_per_gram_inr:costPerGram},
      economics:{fan_watts_per_pod:fanWatts, full_power_hours_per_day:Number(dutyHours.toFixed(2)), tariff_inr_per_kwh:tariff, maintenance_inr_per_pod_year:maintenance, years, discount_rate:discount / 100, duty_cycle_source:scheduleSource ?? 'manual'},
      media_efficiency:{moss:mossEfficiency / 100, algae:algaeEfficiency / 100, combined:Number(combinedEfficiency.toFixed(3))},
      score_notes:'Exposure = PM2.5 x (1 + receptors within 500 m), normalized. Feasibility, equity and setup cost are editable team assumptions. Air values are Open-Meteo modeled.',
      citizen_suggestions:suggestions.length,
    });
  }, [candidates, weights, budget, podsPerSite, podCost, result, lifecycleCost, fanWatts, dutyHours, tariff, maintenance, years, discount, scheduleSource, suggestions.length]);

  const reportData:ReportData = {
    budget, spend:spent, pods, podsPerSite, podCost, weights:CRITERIA.map((name, i) => ({name, share:result?.normalized_weights[i] ?? 0})),
    rows:selected.map(c => ({name:c.site.name, context:c.site.context, pm25:air[c.id].pm25, receptors:receptorTotal(exposure?.sites[c.id]), cost:c.cost})),
    lifecycleCost, years, dutyHours, lifetimeKg:lifetimeGrams / 1000, costPerGram, combinedEfficiency, sensitivity:sensitivityLines,
    exposureSource:exposureMode === 'live' ? 'Receptors: live OpenStreetMap' : `Receptors: OpenStreetMap snapshot ${exposure?.retrieved_at.slice(0, 10) ?? ''}`,
    airTime:Object.values(air)[0]?.time ?? '',
  };

  useEffect(() => {
    if (!leaflet) return;
    const {L, layer} = leaflet;
    layer.clearLayers();
    candidates.forEach(c => {
      const chosen = result?.selected.includes(c.id);
      const icon = L.divIcon({className:'area-anchor-shell', html:`<div class="plan-pin ${chosen ? 'chosen' : ''}"><strong>${chosen ? podsPerSite : '—'}</strong><span>${c.site.name}</span></div>`, iconSize:[120,58], iconAnchor:[60,29]});
      L.marker([c.site.lat, c.site.lng], {icon, title:`${c.site.name}: ${chosen ? 'selected' : 'not selected'}`, keyboard:true}).addTo(layer);
    });
    suggestions.forEach(s => L.circleMarker([s.lat, s.lng], {radius:6, color:'#fff', weight:1.5, fillColor:'#7a4fa3', fillOpacity:.9}).bindTooltip(`Citizen suggestion: ${s.reason.replace(/[<>&]/g, '')}`).addTo(layer));
  }, [leaflet, candidates, result, podsPerSite, suggestions]);

  const updateAssumption = (id:string, key:'setup'|'feasibility'|'equity', value:number) => {
    if (!Number.isFinite(value)) return;
    setAssumptions(current => ({...current, [id]:{...current[id], [key]:key === 'setup' ? Math.max(0, value) : Math.max(0, Math.min(1, value))}}));
  };

  return <section className="feature-view planner-view">
    <header className="feature-header"><div><p className="kicker">PLANNER / BUDGET-CONSTRAINED DEPLOYMENT</p><h1>Where should the next rupee go?</h1><p>Set a budget and what matters most. The optimizer evaluates every combination of candidate areas and returns the set with the highest weighted score that fits the budget.</p></div><div className="header-actions"><div className="feature-status">{airLoading ? <><LoaderCircle className="spin" size={16}/> Reading air data</> : <><span className="live-dot"/> Solver: {solver === 'api' ? 'FastAPI /api/optimize' : solver === 'local' ? 'in-browser fallback' : '—'}</>}</div><button className="feature-button" onClick={() => setShowReport(true)} disabled={!selected.length}><FileText size={16}/> Deployment brief (PDF)</button></div></header>
    {showReport && <ReportSheet data={reportData} planner={planner} onClose={() => setShowReport(false)}/>}

    <div className="planner-controls">
      <label><span>BUDGET</span><strong>{formatInr(budget)}</strong><input type="range" min="2" max="50" step="0.5" value={budgetLakh} onChange={e => setBudgetLakh(Number(e.target.value))}/></label>
      <label><span>COST PER POD</span><strong>{formatInr(podCost)}</strong><input type="range" min="10000" max="150000" step="5000" value={podCost} onChange={e => setPodCost(Number(e.target.value))}/></label>
      <label><span>PODS PER AREA</span><strong>{podsPerSite}</strong><input type="range" min="1" max="12" value={podsPerSite} onChange={e => setPodsPerSite(Number(e.target.value))}/></label>
      {CRITERIA.map((name, index) => <label key={name}><span>WEIGHT · {name.toUpperCase()}</span><strong>{result ? `${Math.round(result.normalized_weights[index] * 100)}%` : weights[index]}</strong><input type="range" min="0" max="100" value={weights[index]} onChange={e => setWeights(current => current.map((w, i) => i === index ? Number(e.target.value) : w))}/></label>)}
    </div>

    <Guide title="How the planner decides" columns={4} items={[
      {title:'Budget, pod cost, pods per area', body:'The optimizer never exceeds the budget. Each area costs its setup cost plus pods × cost per pod. More pods per area means stronger local cleaning but fewer areas.'},
      ...CRITERIA.map((name, i) => ({title:`${name} weight`, body:WEIGHT_HELP[i]})),
      {title:'Sensitivity', body:'Each priority is raised by 20% and the optimizer re-run. “Unchanged” everywhere means the recommendation doesn’t hinge on the exact weights.'},
      {title:'Lifecycle cost and cost per gram', body:'Upfront cost plus every future year’s electricity and maintenance, discounted to today’s rupees. Dividing by the PM2.5 mass captured gives cost per gram, for comparing options; it is not a health figure.'},
    ]}/>
    <div className="planner-grid">
      <article className="feature-panel">
        <div className="panel-heading"><div><span>OPTIMAL SET / {selected.length} OF {candidates.length} AREAS</span><h2>Recommended deployment</h2></div><p>Teal pins are selected. Badges show pods per area. Purple dots are citizen suggestions.</p></div>
        <div className="feature-map"><div ref={node} className="feature-leaflet"/>{tileError && <div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}</div>
      </article>
      <article className="feature-panel planner-summary">
        <div className="summary-kpis">
          <div><span>SPEND</span><strong>{formatInr(spent)}</strong><small>of {formatInr(budget)} · {formatInr(budget - spent)} unused</small></div>
          <div><span>PODS</span><strong>{pods}</strong><small>{selected.length} areas × {podsPerSite}</small></div>
          <div><span>RECEPTORS ≤{exposure?.radius_m ?? 500} M</span><strong>{receptors.school + receptors.health + receptors.bus_stop}</strong><small>{receptors.school} schools · {receptors.health} health · {receptors.bus_stop} bus stops</small></div>
          <div><span>WEIGHTED SCORE</span><strong>{result ? result.utility.toFixed(2) : '—'}</strong><small>Sum of normalized utilities</small></div>
        </div>
        <div className="selected-list">{selected.length ? selected.map(c => <div key={c.id}><CheckCircle2 size={18}/><strong>{c.site.name}</strong><span>{formatInr(c.cost)}</span><small>PM2.5 {air[c.id].pm25.toFixed(1)} · {receptorTotal(exposure?.sites[c.id])} receptors</small></div>) : <p className="muted">{airLoading ? 'Waiting for air data…' : 'No area fits this budget. Raise the budget or lower the cost per pod.'}</p>}</div>
        <div className="sensitivity"><span className="section-tag"><TrendingUp size={15}/> SENSITIVITY · EACH WEIGHT +20%</span>{sensitivity.map(({criterion, added, removed}) => <p key={criterion}><b>{CRITERIA[criterion]}</b>{added.length || removed.length ? <span className="shift">{removed.map(siteName).join(', ') || '—'} → {added.map(siteName).join(', ') || '—'}</span> : <span className="stable">Recommendation unchanged</span>}</p>)}</div>
      </article>
    </div>

    <article className="feature-panel economics-panel">
      <div className="panel-heading"><div><span><Calculator size={15}/> LIFECYCLE ECONOMICS / DISCOUNTED</span><h2>What it costs to run for {years} years</h2></div><p>{scheduleSource ? `Duty cycle from ${scheduleSource}` : 'Duty cycle set manually'}</p></div>
      <div className="economics-grid">
        <div className="economics-inputs">
          <label><span>FAN POWER / POD</span><input type="number" min="0" value={fanWatts} onChange={e => setFanWatts(Math.max(0, Number(e.target.value)))}/><b>W</b></label>
          <label><span>FULL-POWER HOURS / DAY</span><input type="number" min="0" max="24" step="0.1" value={Number(dutyHours.toFixed(1))} onChange={e => setDutyHours(Math.max(0, Math.min(24, Number(e.target.value))))}/><b>h</b></label>
          <label><span>TARIFF</span><input type="number" min="0" step="0.5" value={tariff} onChange={e => setTariff(Math.max(0, Number(e.target.value)))}/><b>₹/kWh</b></label>
          <label><span>MAINTENANCE / POD / YEAR</span><input type="number" min="0" step="500" value={maintenance} onChange={e => setMaintenance(Math.max(0, Number(e.target.value)))}/><b>₹</b></label>
          <label><span>HORIZON</span><input type="number" min="1" max="30" value={years} onChange={e => setYears(Math.max(1, Math.min(30, Number(e.target.value))))}/><b>years</b></label>
          <label><span>DISCOUNT RATE</span><input type="number" min="0" max="30" step="0.5" value={discount} onChange={e => setDiscount(Math.max(0, Math.min(30, Number(e.target.value))))}/><b>%</b></label>
        </div>
        <div className="economics-results">
          <div><span>LIFECYCLE COST</span><strong>{lifecycleCost != null ? formatInr(lifecycleCost) : '—'}</strong><small>Capex + discounted energy and maintenance</small></div>
          <div><span>PER POD PER YEAR</span><strong>{lifecycleCost != null && pods ? formatInr(lifecycleCost / pods / years) : '—'}</strong><small>{annualEnergyKwh.toFixed(0)} kWh/year for the network</small></div>
          <div><span>PM2.5 CAPTURED OVER HORIZON</span><strong>{pods ? `${(lifetimeGrams / 1000).toFixed(2)} kg` : '—'}</strong><small>At {(combinedEfficiency * 100).toFixed(0)}% combined efficiency, current PM2.5 held constant</small></div>
          <div><span>COST PER GRAM CAPTURED</span><strong>{costPerGram != null ? formatInr(costPerGram) : '—'}</strong><small>Mass captured, not ambient or health change</small></div>
        </div>
      </div>
    </article>

    <article className="feature-panel">
      <div className="panel-heading"><div><span>CANDIDATE SCORES / 0–1, HIGHER IS BETTER</span><h2>Inputs the optimizer sees</h2></div><p>Feasibility, equity and setup cost are editable team assumptions—replace them with survey data.</p></div>
      <div className="score-table"><div className="score-row head"><span>AREA</span><span>PM2.5</span><span>RECEPTORS</span><span>SETUP ₹</span><span>COST</span><span>EXPOSURE</span><span>FEASIBILITY</span><span>EQUITY</span></div>
        {candidates.map(c => <div className={`score-row ${result?.selected.includes(c.id) ? 'chosen' : ''}`} key={c.id}><span><strong>{c.site.name}</strong><small>{c.site.context}</small></span><span>{air[c.id].pm25.toFixed(1)}</span><span>{exposure ? receptorTotal(exposure.sites[c.id]) : '—'}</span><span><input type="number" min="0" step="5000" value={assumptions[c.id].setup} onChange={e => updateAssumption(c.id, 'setup', Number(e.target.value))} aria-label={`${c.site.name} setup cost`}/></span><span>{c.scores[0].toFixed(2)}</span><span>{c.scores[1].toFixed(2)}</span><span><input type="number" min="0" max="1" step="0.05" value={assumptions[c.id].feasibility} onChange={e => updateAssumption(c.id, 'feasibility', Number(e.target.value))} aria-label={`${c.site.name} feasibility`}/></span><span><input type="number" min="0" max="1" step="0.05" value={assumptions[c.id].equity} onChange={e => updateAssumption(c.id, 'equity', Number(e.target.value))} aria-label={`${c.site.name} equity`}/></span></div>)}
      </div>
    </article>

    <footer className="analysis-disclaimer"><strong><ShieldCheck size={16}/> METHOD</strong><p>Exposure score = current PM2.5 × (1 + OpenStreetMap receptors within {exposure?.radius_m ?? 500} m), normalized to the highest area. Receptor data: {exposureMode === 'live' ? 'live Overpass query' : exposureMode === 'snapshot' ? `bundled snapshot (${exposure?.retrieved_at.slice(0, 10)})` : 'unavailable—exposure uses PM2.5 only'}. Cost score = cheapest area cost ÷ this area cost. Captured mass assumes constant inlet concentration and the stated duty cycle. No health benefit is monetized.</p></footer>
  </section>;
}
