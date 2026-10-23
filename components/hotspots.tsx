'use client';

import {useCallback, useEffect, useState} from 'react';
import {AlertTriangle, Flame, LoaderCircle, RefreshCw, ShieldCheck} from 'lucide-react';
import {API, CANDIDATE_SITES, NAAQS_PM25_24H, WHO_PM25_24H, fetchCurrentAir, pmBand} from '../lib/air';
import {useLeafletMap} from './use-leaflet-map';
import {InfoTip} from './info';

type Station = {id:string|number; name:string; provider:string|null; reference_grade:boolean|null; lat:number; lng:number; pm25:number; measured_at:string|null; age_hours:number|null; flags:string[]; status:'hotspot'|'elevated'|'within_who'|'unverified'; source_url?:string};

const STATUS_LABEL:Record<Station['status'],string> = {hotspot:'Above NAAQS', elevated:'Above WHO', within_who:'Within WHO', unverified:'Unverified'};
const FLAG_LABEL:Record<string,string> = {stale:'Stale', outlier:'Outlier', invalid:'Invalid', modeled:'Modeled'};

function statusFor(pm25:number):Station['status'] {
  return pm25 > NAAQS_PM25_24H ? 'hotspot' : pm25 > WHO_PM25_24H ? 'elevated' : 'within_who';
}

export function Hotspots() {
  const [stations, setStations] = useState<Station[]>([]);
  const [mode, setMode] = useState<'measured'|'modeled'|null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string|null>(null);
  const [selectedId, setSelectedId] = useState<string|number|null>(null);
  const {node, leaflet, tileError} = useLeafletMap(CANDIDATE_SITES.map(site => [site.lat, site.lng]));

  const refresh = useCallback(async () => {
    setLoading(true);
    let reason = 'Measured station network unreachable.';
    try {
      const response = await fetch(`${API}/api/hotspots`);
      const data = await response.json();
      if (response.ok && data.stations?.length) {
        setStations([...data.stations].sort((a:Station, b:Station) => b.pm25 - a.pm25));
        setMode('measured'); setNotice(''); setCheckedAt(data.checked_at); setLoading(false);
        return;
      }
      reason = data.status ?? data.detail ?? reason;
    } catch {/* Fall through to the modeled layer. */}
    const modeled = await Promise.all(CANDIDATE_SITES.map(async site => {
      const air = await fetchCurrentAir(site).catch(() => null);
      if (!air || !Number.isFinite(air.pm25)) return null;
      const age = air.time ? Math.max(0, (Date.now() - new Date(air.time).getTime()) / 3.6e6) : null;
      return {id:site.id, name:site.name, provider:'Open-Meteo (CAMS model)', reference_grade:null, lat:site.lat, lng:site.lng, pm25:air.pm25, measured_at:air.time, age_hours:age == null ? null : Number(age.toFixed(1)), flags:['modeled'], status:statusFor(air.pm25)} as Station;
    }));
    setStations(modeled.filter((s):s is Station => Boolean(s)).sort((a, b) => b.pm25 - a.pm25));
    setMode('modeled'); setNotice(reason); setCheckedAt(new Date().toISOString()); setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 600000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!leaflet) return;
    const {L, map, layer} = leaflet;
    layer.clearLayers();
    stations.forEach(station => {
      const unverified = station.status === 'unverified';
      const color = unverified ? '#8c948a' : pmBand(station.pm25).color;
      const marker = L.circleMarker([station.lat, station.lng], {radius:Math.max(9, Math.min(26, 6 + station.pm25 / 4)), color:station.id === selectedId ? '#10241b' : '#fff', weight:station.id === selectedId ? 4 : 2.5, dashArray:unverified ? '4 4' : undefined, fillColor:color, fillOpacity:unverified ? .35 : .82}).addTo(layer);
      marker.bindTooltip(`<strong>${station.name}</strong><br/>PM2.5 ${station.pm25.toFixed(1)} µg/m³ · ${STATUS_LABEL[station.status]}`, {direction:'top', offset:[0,-8]});
      marker.on('click', () => setSelectedId(station.id));
    });
    if (mode === 'measured' && stations.length) map.fitBounds(stations.map(s => [s.lat, s.lng]), {padding:[40,40], maxZoom:12});
  }, [leaflet, stations, selectedId, mode]);

  const counts = {hotspot:0, elevated:0, within_who:0, unverified:0} as Record<Station['status'],number>;
  stations.forEach(s => counts[s.status]++);
  const selected = stations.find(s => s.id === selectedId);

  return <section className="feature-view hotspots-view">
    <header className="feature-header"><div><p className="kicker">HOTSPOTS / MEASURED CITY NETWORK</p><h1>Where is the air worst right now?</h1><p>Every regulatory and low-cost PM2.5 station within 25 km of central Bengaluru, checked for freshness and outliers before it can count as a hotspot.</p></div><button className="feature-button" onClick={refresh} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>}{loading ? 'Reading stations…' : 'Refresh'}</button></header>

    {mode === 'modeled' && <div className="feature-notice"><AlertTriangle size={18}/><p><strong>Showing modeled values, not measurements.</strong> {notice} Set <code>OPENAQ_API_KEY</code> on the API service to load measured stations. Open-Meteo uses a coarse model grid, so nearby areas often share one value.</p></div>}

    <div className="hotspot-counts">
      <div className="count-hotspot"><span>ABOVE NAAQS ({NAAQS_PM25_24H} µg/m³) <InfoTip label="About hotspots"><strong>Hotspots</strong>Verified readings above India’s 24-hour PM2.5 limit of 60 µg/m³. These are the priority places for pods.</InfoTip></span><strong>{counts.hotspot}</strong></div>
      <div className="count-elevated"><span>ABOVE WHO ({WHO_PM25_24H} µg/m³) <InfoTip label="About elevated"><strong>Elevated</strong>Within India’s limit but above the stricter WHO health guideline of 15 µg/m³.</InfoTip></span><strong>{counts.elevated}</strong></div>
      <div className="count-ok"><span>WITHIN WHO <InfoTip label="About within WHO"><strong>Within WHO</strong>At or below the WHO 24-hour guideline of 15 µg/m³: the cleanest air category.</InfoTip></span><strong>{counts.within_who}</strong></div>
      <div className="count-unverified"><span>UNVERIFIED (STALE / OUTLIER) <InfoTip label="About unverified"><strong>Readings we don’t trust yet</strong>Stale: older than 3 hours. Outlier: more than 3× the network median, often a faulty or badly placed sensor. Shown dashed grey on the map; never counted as hotspots.</InfoTip></span><strong>{counts.unverified}</strong></div>
    </div>

    <div className="planner-grid">
      <article className="feature-panel">
        <div className="panel-heading"><div><span>{mode === 'measured' ? 'OPENAQ / MEASURED' : 'OPEN-METEO / MODELED'} · {stations.length} POINTS</span><h2>City PM2.5 network</h2></div><p>Circle size and color follow PM2.5. Dashed grey circles failed a quality check.</p></div>
        <div className="feature-map"><div ref={node} className="feature-leaflet"/>{tileError && <div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}<div className="map-legend">{[['#4f8a4b','≤ WHO'],['#c2a03a','≤ NAAQS'],['#d0703c','> NAAQS'],['#a8352e','> 90'],['#8c948a','Unverified']].map(([color, label]) => <span key={label}><i style={{background:color}}/>{label}</span>)}</div></div>
      </article>
      <article className="feature-panel station-list">
        <div className="panel-heading"><div><span><Flame size={15}/> RANKED BY PM2.5 <InfoTip label="About the station list"><strong>Station list</strong>Highest PM2.5 first. Reference monitors are regulatory-grade instruments; low-cost sensors are cheaper and less precise. Click a row or a map circle for details.</InfoTip></span><h2>{selected ? selected.name : 'Stations'}</h2></div></div>
        {selected && <div className="station-focus"><div><span>PM2.5</span><strong>{selected.pm25.toFixed(1)} <small>µg/m³</small></strong></div><div><span>MEASURED</span><strong>{selected.age_hours != null ? `${selected.age_hours} h ago` : '—'}</strong></div><div><span>PROVIDER</span><strong>{selected.provider ?? '—'}</strong></div><div><span>INSTRUMENT</span><strong>{selected.reference_grade == null ? 'Model' : selected.reference_grade ? 'Reference monitor' : 'Low-cost sensor'}</strong></div></div>}
        <div className="station-rows">{stations.map((station, index) => <button key={station.id} className={station.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(station.id)}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{station.name}</strong><small>{station.age_hours != null ? `${station.age_hours} h old` : 'time unknown'}{station.flags.map(flag => <em key={flag} className={`flag flag-${flag}`}>{FLAG_LABEL[flag] ?? flag}</em>)}</small></span><span className={`status status-${station.status}`}>{station.pm25.toFixed(1)}</span></button>)}{!stations.length && !loading && <p className="muted">No stations returned.</p>}</div>
      </article>
    </div>

    <footer className="analysis-disclaimer"><strong><ShieldCheck size={16}/> QUALITY RULES</strong><p>A reading is stale when older than 3 hours and an outlier when above 3× the network median (with at least 4 stations). Flagged readings are shown but never counted as hotspots. Latest hourly values are compared with 24-hour standards, so status is indicative. No values are interpolated between stations. {checkedAt ? `Checked ${new Date(checkedAt).toLocaleTimeString()}.` : ''}</p></footer>
  </section>;
}
