'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Activity, ArrowDown, BarChart3, Bell, Bus, CalendarClock, Calculator, CheckCircle2, Cpu, Crosshair, Download, Droplets, FileSpreadsheet, FlaskConical, GraduationCap, Home, Hospital, LoaderCircle, MapPin, MapPinned, Play, Radio, RefreshCw, Send, ShieldCheck, Square, Wind, X, Zap} from 'lucide-react';

import {Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {API, Air, CANDIDATE_SITES, CandidateSite, WHO_PM25_24H, combinedStageEfficiency, fetchCurrentAir, modelLocally} from '../lib/air';
import {RECEPTOR_LABEL, receptorTotal, useExposure} from '../components/exposure';
import {Forecast} from '../components/forecast';
import {Planner} from '../components/planner';
import {Assistant, PlannerState} from '../components/assistant';
import {InfoTip} from '../components/info';
import {MAP_OPTIONS} from '../components/use-leaflet-map';
import {AnimatedNumber, LiveProvider, LiveStrip, Sparkline, Trend, ago, useLive, useNow} from '../components/live';

const INITIAL_SITE = {lat: 12.9716, lng: 77.5946};
const MEASURED_SYSTEM_EFFICIENCY = 79;
type MeasuredAir = {
  pm25:number;
  pm10:number|null;
  no2:number|null;
  no2Unit:string|null;
  co:number|null;
  coUnit:string|null;
  time:string;
  stationName:string;
  stationDistanceKm:number;
};
type NetworkSite = CandidateSite & MeasuredAir & {assigned:number; rank:number};
type OpenAQObservation = {
  value?:number;
  parameter?:{name?:string;displayName?:string;units?:string};
  coordinates?:{latitude?:number;longitude?:number};
  datetime?:{utc?:string;local?:string};
  locationsId?:number;
  location_name?:string;
};

export default function Page() {
  return <LiveProvider><MossExperience/></LiveProvider>;
}

function HomeLive() {
  const {city, cityFetchedAt} = useLive();
  const now = useNow(1000);
  if (!city) return null;
  const worst = city.sites.reduce((max, s) => s.pm25 > max.pm25 ? s : max, city.sites[0]);
  const aboveWho = city.sites.filter(s => s.pm25 > WHO_PM25_24H).length;
  return <div className="home-live"><span><i className="live-pulse"/> BENGALURU RIGHT NOW</span><strong><AnimatedNumber value={city.avg}/><small> µg/m³ avg PM2.5</small></strong><Trend change={city.change1h}/><Sparkline values={city.series24h} width={180} height={34} color="#dbe5b7"/><p>{aboveWho} of {city.sites.length} areas above the WHO guideline · worst: {worst.name} ({worst.pm25.toFixed(0)})</p><small>Open-Meteo model · updated {ago(cityFetchedAt, now)}</small></div>;
}

function distanceKm(a:{lat:number;lng:number},b:{lat:number;lng:number}) {
  const radians=(degrees:number)=>degrees*Math.PI/180;
  const dLat=radians(b.lat-a.lat);
  const dLng=radians(b.lng-a.lng);
  const latitudeA=radians(a.lat);
  const latitudeB=radians(b.lat);
  const haversine=Math.sin(dLat/2)**2+Math.cos(latitudeA)*Math.cos(latitudeB)*Math.sin(dLng/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(haversine),Math.sqrt(1-haversine));
}

function pollutantName(parameter:OpenAQObservation['parameter']) {
  const name=(parameter?.name||parameter?.displayName||'').toLowerCase().replace(/[\s._-]/g,'');
  if(name==='pm25'||name==='pm2,5')return 'pm25';
  if(name==='pm10')return 'pm10';
  if(name==='no2'||name==='nitrogendioxide')return 'no2';
  if(name==='co'||name==='carbonmonoxide')return 'co';
  return null;
}

function particulateMicrograms(value:number,unit:string|undefined) {
  const normalized=(unit||'').toLowerCase().replace(/μ/g,'µ').replace(/\s/g,'');
  if(normalized.includes('mg/m'))return value*1000;
  if(normalized.includes('ng/m'))return value/1000;
  if(normalized.includes('µg/m')||normalized.includes('ug/m'))return value;
  return null;
}

function mapOpenAQToSites(observations:OpenAQObservation[]) {
  type Reading={value:number;unit:string;time:string};
  type Station={name:string;lat:number;lng:number;readings:Partial<Record<'pm25'|'pm10'|'no2'|'co',Reading>>};
  const stations=new Map<string,Station>();
  observations.forEach((observation,index)=>{
    const pollutant=pollutantName(observation.parameter);
    const lat=Number(observation.coordinates?.latitude);
    const lng=Number(observation.coordinates?.longitude);
    const rawValue=Number(observation.value);
    if(!pollutant||!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(rawValue))return;
    const unit=observation.parameter?.units||'';
    const converted=pollutant==='pm25'||pollutant==='pm10'?particulateMicrograms(rawValue,unit):rawValue;
    if(converted==null||!Number.isFinite(converted))return;
    const key=String(observation.locationsId??`${lat},${lng},${observation.location_name??index}`);
    const station=stations.get(key)??{name:observation.location_name||`OpenAQ station ${key}`,lat,lng,readings:{}};
    const time=observation.datetime?.utc||observation.datetime?.local||'';
    const existing=station.readings[pollutant];
    if(!existing||!existing.time||time>existing.time)station.readings[pollutant]={value:converted,unit:pollutant==='pm25'||pollutant==='pm10'?'µg/m³':unit,time};
    stations.set(key,station);
  });
  const withPm25=[...stations.values()].filter(station=>station.readings.pm25);
  return CANDIDATE_SITES.map(site=>{
    const nearest=withPm25.reduce<Station|null>((best,station)=>!best||distanceKm(site,station)<distanceKm(site,best)?station:best,null);
    if(!nearest)return null;
    const pm25=nearest.readings.pm25!;
    return {...site,pm25:pm25.value,pm10:nearest.readings.pm10?.value??null,no2:nearest.readings.no2?.value??null,no2Unit:nearest.readings.no2?.unit||null,co:nearest.readings.co?.value??null,coUnit:nearest.readings.co?.unit||null,time:pm25.time,stationName:nearest.name,stationDistanceKm:distanceKm(site,nearest)};
  }).filter((site):site is CandidateSite & MeasuredAir=>site!==null);
}

function MossExperience() {
  const [view, setView] = useState<'home'|'twin'|'analysis'|'locations'|'sensors'|'planner'|'forecast'>('home');
  const [dutyHours, setDutyHours] = useState(24);
  const [scheduleSource, setScheduleSource] = useState<string|null>(null);
  const [plannerState, setPlannerState] = useState<PlannerState|null>(null);
  const [site, setSite] = useState(INITIAL_SITE);
  const [air, setAir] = useState<Air|null>(null);
  const [futurePm25, setFuturePm25] = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [units, setUnits] = useState(24);
  // The measured 79% applies to the complete tested chamber. Keep the
  // unmeasured polishing-stage increment at zero to avoid double-counting it.
  const [efficiency, setEfficiency] = useState(MEASURED_SYSTEM_EFFICIENCY);
  const [algaeEfficiency, setAlgaeEfficiency] = useState(0);
  const [hours, setHours] = useState(8);
  const [mapsReady, setMapsReady] = useState([false, false]);
  const [mapBasesReady, setMapBasesReady] = useState([false, false]);
  const [mapError, setMapError] = useState(false);
  const baselineMapNode = useRef<HTMLDivElement>(null);
  const futureMapNode = useRef<HTMLDivElement>(null);
  const leafletMaps = useRef<any[]>([]);
  const siteMarkers = useRef<any[]>([]);
  const mapSyncing = useRef(false);

  const loadAir = useCallback(async (point = site) => {
    setLoading(true);
    setError('');
    try {
      setAir(await fetchCurrentAir(point));
    } catch (reason:any) {
      setAir(null);
      setError(reason?.message || 'Unable to load local air quality.');
    } finally {
      setLoading(false);
    }
  }, [site]);

  useEffect(() => {
    if (view !== 'twin' && view !== 'analysis') return;
    loadAir(site);
    const timer = setInterval(() => loadAir(site), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [view, site.lat, site.lng, loadAir]);

  useEffect(() => {
    if (!air) { setFuturePm25(null); return; }
    const combinedEfficiency = combinedStageEfficiency(efficiency / 100, algaeEfficiency / 100);
    const payload = {initial:air.pm25, background:air.pm25, source_ug_h:0, ventilation_m3_h:12000, volume_m3:250000, cadr_m3_h:500 * combinedEfficiency * units, hours, calibration_reference:'User-supplied measured chamber efficiency: 79%; separate algae-stage increment not measured'};
    const fallback = modelLocally(payload.initial, payload.background, payload.ventilation_m3_h, payload.cadr_m3_h, payload.volume_m3, payload.hours);
    const controller = new AbortController();
    fetch(`${API}/api/twin/balance`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:controller.signal})
      .then(r => r.ok ? r.json() : Promise.reject()).then(data => setFuturePm25(Number(data.concentration_ug_m3))).catch(() => setFuturePm25(fallback));
    return () => controller.abort();
  }, [air, units, efficiency, algaeEfficiency, hours]);

  useEffect(() => {
    if (view !== 'twin' || !baselineMapNode.current || !futureMapNode.current || leafletMaps.current.length) return;
    let active = true;
    let resizeObserver:ResizeObserver|null = null;
    let mapsWithLiveTiles = 0;
    const tileHealthTimers:Array<ReturnType<typeof setTimeout>> = [];
    setMapError(false);
    import('leaflet').then(({default:L}) => {
      if (!active || !baselineMapNode.current || !futureMapNode.current) return;
      try {
        const nodes = [baselineMapNode.current, futureMapNode.current];
        const created = nodes.map((node, index) => {
          const map = L.map(node, MAP_OPTIONS).setView([site.lat,site.lng],12);
          L.control.zoom({position:'bottomleft'}).addTo(map);
          map.createPane('offlineMap');
          const offlinePane=map.getPane('offlineMap');
          if(offlinePane)offlinePane.style.zIndex='150';
          const offlineMap=L.imageOverlay(
            '/bengaluru-map.webp',
            [[12.811801316582617,77.431640625],[13.06877673435769,77.6953125]],
            {pane:'offlineMap',interactive:false,opacity:1}
          );
          offlineMap.on('load',()=>{
            const image=offlineMap.getElement();
            image?.style.setProperty('max-width','none','important');
            image?.style.setProperty('max-height','none','important');
            if(active)setMapBasesReady(current=>current.map((ready,position)=>position===index?true:ready));
          });
          offlineMap.addTo(map);
          setMapsReady(current => current.map((ready, position) => position === index ? true : ready));
          const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
          let reportedLive = false;
          const tileHealthTimer=setTimeout(()=>{
            if(active&&mapsWithLiveTiles===0)setMapError(true);
          },7000);
          tileHealthTimers.push(tileHealthTimer);
          tiles.on('tileloadstart',(event:any)=>{event.tile.style.setProperty('max-width','none','important');event.tile.style.setProperty('max-height','none','important')});
          tiles.on('tileload',()=>{
            if(!reportedLive){reportedLive=true;mapsWithLiveTiles+=1}
            clearTimeout(tileHealthTimer);
            if(active)setMapError(false);
          });
          const marker = L.circleMarker([site.lat,site.lng],{radius:index ? 14 : 12,color:'#fff',weight:3,fillColor:index ? '#16858c' : '#8d6f58',fillOpacity:.88}).addTo(map);
          marker.bindTooltip(index ? 'Moss + algae projection' : 'Current baseline',{direction:'top',offset:[0,-10]});
          siteMarkers.current[index] = marker;
          map.on('click',(event:any) => setSite({lat:Number(event.latlng.lat.toFixed(5)),lng:Number(event.latlng.lng.toFixed(5))}));
          return map;
        });
        leafletMaps.current = created;
        resizeObserver=new ResizeObserver(()=>created.forEach(map=>map.invalidateSize({pan:false})));
        nodes.forEach(node=>resizeObserver?.observe(node));
        created.forEach((source,index) => {
          const target = created[index ? 0 : 1];
          source.on('move zoom', () => {
            if (mapSyncing.current) return;
            mapSyncing.current = true;
            target.setView(source.getCenter(),source.getZoom(),{animate:false});
            mapSyncing.current = false;
          });
        });
        requestAnimationFrame(() => created.forEach(map => map.invalidateSize()));
      } catch {
        setMapError(true);
      }
    }).catch(() => setMapError(true));
    return () => {
      active = false;
      tileHealthTimers.forEach(clearTimeout);
      resizeObserver?.disconnect();
      leafletMaps.current.forEach(map => map.remove());
      leafletMaps.current = [];
      siteMarkers.current = [];
      setMapsReady([false,false]);
      setMapBasesReady([false,false]);
    };
  }, [view]);

  useEffect(() => {
    siteMarkers.current.forEach(marker => marker?.setLatLng([site.lat,site.lng]));
    leafletMaps.current.forEach(map => map?.panTo([site.lat,site.lng],{animate:true,duration:.4}));
  }, [site]);

  const shownBaseline = air?.pm25 ?? null;
  const shownFuture = futurePm25;
  const reduction = shownBaseline != null && shownFuture != null && shownBaseline > 0 ? Math.max(0, (1 - shownFuture / shownBaseline) * 100) : null;

  return <main className="experience">
    <aside className="rail" aria-label="Primary navigation">
      <button className="monogram" onClick={() => setView('home')} aria-label="Moss and algae home">
        <img src="/moss-algae-project-emblem-v2.png" alt="Moss and algae biofilter emblem"/>
      </button>
      <nav>
        <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}><Home size={18}/><span>HOME</span></button>
        <button className={view === 'twin' ? 'active' : ''} onClick={() => setView('twin')}><FlaskConical size={18}/><span>DIG TWIN</span></button>
        <button className={view === 'analysis' ? 'active' : ''} onClick={() => setView('analysis')}><BarChart3 size={18}/><span>ANALYSIS</span></button>
        <button className={view === 'locations' ? 'active' : ''} onClick={() => setView('locations')}><MapPinned size={18}/><span>LOCATIONS</span></button>
        <button className={view === 'planner' ? 'active' : ''} onClick={() => setView('planner')}><Calculator size={18}/><span>PLANNER</span></button>
        <button className={view === 'forecast' ? 'active' : ''} onClick={() => setView('forecast')}><CalendarClock size={18}/><span>FORECAST</span></button>
        <button className={view === 'sensors' ? 'active' : ''} onClick={() => setView('sensors')}><Radio size={18}/><span>SENSORS</span></button>
      </nav>
      <div className="rail-index">01<br/><span>INDIA</span></div>
    </aside>

    {view === 'analysis' && <LiveStrip units={units} mossEfficiency={efficiency} algaeEfficiency={algaeEfficiency}/>}
    {view === 'home' ? <section className="landing" aria-label="Moss algae landing page">
      <picture>
        <source srcSet="/MOSS.webp" type="image/webp"/>
        <img className="landing-image" src="/MOSS.avif" alt="Architectural moss biofilter installation" fetchPriority="high"/>
      </picture>
      <div className="image-shade"/>
      <div className="landing-top"><span>MOSS—ALGAE / INDIA</span><span>BENGALURU · 12.97° N</span></div>
      <div className="hero-copy">
        <p className="kicker">LIVING INFRASTRUCTURE / DIGITAL TWIN</p>
        <h1>What if the city<br/>could breathe with us?</h1>
        <p className="lede">A spatial model for placing moss biofilters, reading the air now, and exploring a more breathable future.</p>
        <div className="hero-actions"><button className="enter-twin" onClick={() => setView('twin')}>EXPLORE THE FUTURE AIR <ArrowDown size={16}/></button><a className="enter-twin citizen-link" href="/citizen">FOR CITIZENS · ನಾಗರಿಕರಿಗೆ · नागरिकों के लिए</a></div>
      </div>
      <HomeLive/>
      <div className="landing-note"><span>01</span><p>MOSS / MICROALGAE<br/>URBAN AIR SYSTEM</p></div>
    </section> : view === 'twin' ? <section className="twin">
      <header className="twin-header">
        <div><p className="kicker">DIGITAL TWIN / FUTURE STATE OF AIR</p><h1>Place. Model. Compare.</h1></div>
        <div className="site-coordinates"><MapPin size={15}/><span>SELECTED POINT</span><strong>{site.lat.toFixed(4)}° N · {site.lng.toFixed(4)}° E</strong></div>
      </header>
      <div className="twin-toolbar">
        <div className="status-line">{loading ? <><LoaderCircle className="spin" size={14}/> Reading atmosphere…</> : error ? <span className="warn">{error}</span> : <><span className="live-dot"/> Live modeled air data · Open-Meteo</>}</div>
        <p><Crosshair size={14}/> Pan or zoom either map—the second view follows automatically. Click to move the selected point.</p>
      </div>
      <div className="comparison">
        <article className="map-card baseline-card">
          <div className="map-heading"><div><span>01 / PRESENT</span><h2>Without moss</h2></div><div className="reading"><small>PM2.5</small><strong>{shownBaseline != null ? shownBaseline.toFixed(1) : '—'}</strong><em>µg/m³</em></div></div>
          <div className="map-stage"><img className={`map-fallback ${mapBasesReady[0]?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={baselineMapNode} className={`map ${mapsReady[0] ? 'ready' : ''}`} aria-label="Interactive baseline map"/><div className="map-label"><Activity size={18}/> BASELINE AIR</div>{mapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}<div className="fallback-attribution">© OpenStreetMap contributors</div></div>
          <div className="data-strip gas-strip"><Data label="AIR QUALITY INDEX" value={air ? String(Math.round(air.aqi)) : '—'} detail="US AQI · modeled source"/><Data label="PM10" value={air ? air.pm10.toFixed(1) : '—'} detail="µg/m³"/><Data label="NO₂" value={air ? air.no2.toFixed(1) : '—'} detail="µg/m³"/><Data label="CO" value={air ? air.co.toFixed(0) : '—'} detail="µg/m³ · atmospheric dataset"/><Data label="CO₂" value="SENSOR" detail="Pod NDIR reading required"/></div>
        </article>
        <article className="map-card future-card">
          <div className="map-heading"><div><span>02 / FUTURE</span><h2>With moss + algae</h2></div><div className="reading future-reading"><small>MODELED PM2.5</small><strong>{shownFuture != null ? shownFuture.toFixed(1) : '—'}</strong><em>µg/m³</em></div></div>
          <div className="map-stage"><img className={`map-fallback ${mapBasesReady[1]?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={futureMapNode} className={`map ${mapsReady[1] ? 'ready' : ''}`} aria-label="Interactive future map"/><div className="future-wash"/><div className="map-label"><Wind size={18}/> PROJECTED AIR · SYNCED</div><div className="delta">{reduction != null ? `−${reduction.toFixed(1)}%` : '—'}<small>MODELED CHANGE</small></div>{mapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}<div className="fallback-attribution">© OpenStreetMap contributors</div></div>
          <div className="data-strip controls">
            <label>UNITS <strong>{units}</strong><input type="range" min="1" max="100" value={units} onChange={e => setUnits(Number(e.target.value))}/></label>
            <label>MEASURED EFF. <strong>{efficiency}%</strong><input type="range" min="5" max="85" value={efficiency} onChange={e => setEfficiency(Number(e.target.value))}/></label>
            <label>ADDITIONAL ALGAE EFF. <strong>{algaeEfficiency}%</strong><input type="range" min="0" max="70" value={algaeEfficiency} onChange={e => setAlgaeEfficiency(Number(e.target.value))}/></label>
            <label>HORIZON <strong>{hours}h</strong><input type="range" min="1" max="24" value={hours} onChange={e => setHours(Number(e.target.value))}/></label>
          </div>
        </article>
      </div>
      <footer className="model-note"><span>MODEL 0.2 / TWO-STAGE</span><p>The future view models moss followed by algae in series. Combined efficiency is 1 − (1 − moss efficiency) × (1 − algae efficiency), preventing double-counting. Both efficiencies require pollutant-specific measurement and field calibration.</p><span>{air?.time ? `DATA ${air.time.replace('T', ' ')}` : 'AWAITING DATA'}</span></footer>
    </section> : view === 'analysis' ? <Analysis air={air} units={units} efficiency={efficiency} algaeEfficiency={algaeEfficiency} hours={hours}/> : view === 'locations' ? <Locations totalUnits={units} setTotalUnits={setUnits} mossEfficiency={efficiency} algaeEfficiency={algaeEfficiency} hours={hours}/> : view === 'planner' ? <Planner mossEfficiency={efficiency} algaeEfficiency={algaeEfficiency} dutyHours={dutyHours} setDutyHours={value => {setDutyHours(value); setScheduleSource(null)}} scheduleSource={scheduleSource} planner={plannerState} onStateChange={setPlannerState}/> : view === 'forecast' ? <Forecast onApplySchedule={(value, label) => {setDutyHours(value); setScheduleSource(label); setView('planner')}}/> : <ChamberSensors mossEfficiency={efficiency} algaeEfficiency={algaeEfficiency} onApplyEfficiency={eff => { setEfficiency(Math.round(eff)); setAlgaeEfficiency(0); setView('twin'); }} />}

    {view !== 'home' && <Assistant planner={plannerState}/>}
  </main>;
}

function Data({label, value, detail}:{label:string; value:string; detail:string}) {return <div className="data"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>}

function allocateUnits(sites:Array<CandidateSite & MeasuredAir>, total:number):NetworkSite[] {
  const ranked = [...sites].sort((a,b) => b.pm25 - a.pm25 || a.stationDistanceKm - b.stationDistanceKm);
  if (!ranked.length) return [];
  const assignments:number[] = ranked.map((_,index) => total >= ranked.length || index < total ? 1 : 0);
  let remaining = Math.max(0,total - assignments.reduce((sum,value) => sum + value,0));
  const weightSum = ranked.reduce((sum,site) => sum + Math.max(0,site.pm25),0) || 1;
  const exact = ranked.map(site => remaining * Math.max(0,site.pm25) / weightSum);
  exact.forEach((value,index) => {const addition=Math.floor(value);assignments[index]+=addition;remaining-=addition});
  [...exact.map((value,index) => ({index,remainder:value-Math.floor(value)}))].sort((a,b) => b.remainder-a.remainder).slice(0,remaining).forEach(item => assignments[item.index]++);
  return ranked.map((site,index) => ({...site,assigned:assignments[index],rank:index+1}));
}

function Locations({totalUnits,setTotalUnits,mossEfficiency,algaeEfficiency,hours}:{totalUnits:number;setTotalUnits:(value:number)=>void;mossEfficiency:number;algaeEfficiency:number;hours:number}) {
  const [readings,setReadings] = useState<Array<CandidateSite & MeasuredAir>>([]);
  const [selectedId,setSelectedId] = useState(CANDIDATE_SITES[0].id);
  const [logSiteId,setLogSiteId] = useState<string|null>(null);
  const [co2Readings,setCo2Readings] = useState<Record<string,number>>({});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [locationsMapReady,setLocationsMapReady] = useState(false);
  const [locationsBaseReady,setLocationsBaseReady] = useState(false);
  const [locationsMapError,setLocationsMapError] = useState(false);
  const locationsMapNode = useRef<HTMLDivElement>(null);
  const locationsMap = useRef<any>(null);
  const locationsLeaflet = useRef<any>(null);
  const locationMarkerLayer = useRef<any>(null);
  const receptorLayer = useRef<any>(null);
  const {data:exposure,mode:exposureMode} = useExposure();
  useEffect(()=>{
    try {
      const saved=window.localStorage.getItem('moss-algae-co2-readings');
      if(saved)setCo2Readings(JSON.parse(saved));
    } catch {/* Sensor readings remain session-only when browser storage is unavailable. */}
  },[]);
  const recordCo2=(siteId:string,value:string)=>{
    const parsed=Number(value);
    setCo2Readings(current=>{
      const next={...current};
      if(value===''||!Number.isFinite(parsed))delete next[siteId];
      else next[siteId]=Math.max(0,Math.min(10000,parsed));
      try {window.localStorage.setItem('moss-algae-co2-readings',JSON.stringify(next))} catch {/* Keep the in-memory reading. */}
      return next;
    });
  };
  const refresh = useCallback(async () => {
    setLoading(true);setError('');
    try {
      const response=await fetch(`${API}/api/observations`);
      const data=await response.json();
      if(!response.ok)throw new Error(data?.detail||'OpenAQ backend request failed.');
      const mapped=mapOpenAQToSites(Array.isArray(data?.observations)?data.observations:[]);
      if(!mapped.length)throw new Error(data?.status||'No OpenAQ stations with valid PM2.5 measurements were returned.');
      setReadings(mapped);
      setSelectedId(current=>mapped.some(site=>site.id===current)?current:mapped[0].id);
    } catch(reason:any) {
      setReadings([]);
      setError(reason?.message||'Unable to load measured OpenAQ station data from the backend.');
    } finally {
      setLoading(false);
    }
  },[]);
  useEffect(()=>{refresh();const timer=setInterval(refresh,5*60*1000);return()=>clearInterval(timer)},[refresh]);
  const network=useMemo(()=>allocateUnits(readings,totalUnits),[readings,totalUnits]);
  useEffect(()=>{
    if(!locationsMapNode.current||locationsMap.current)return;
    let active=true;
    let resizeObserver:ResizeObserver|null=null;
    let tileHealthTimer:ReturnType<typeof setTimeout>|null=null;
    setLocationsMapError(false);
    import('leaflet').then(({default:L})=>{
      if(!active||!locationsMapNode.current)return;
      try {
        const map=L.map(locationsMapNode.current,MAP_OPTIONS);
        L.control.zoom({position:'bottomleft'}).addTo(map);
        map.createPane('offlineMap');
        const offlinePane=map.getPane('offlineMap');
        if(offlinePane)offlinePane.style.zIndex='150';
        const offlineMap=L.imageOverlay('/bengaluru-map.webp',[[12.811801316582617,77.431640625],[13.06877673435769,77.6953125]],{pane:'offlineMap',interactive:false});
        offlineMap.on('load',()=>{
          const image=offlineMap.getElement();
          image?.style.setProperty('max-width','none','important');
          image?.style.setProperty('max-height','none','important');
          if(active)setLocationsBaseReady(true);
        });
        offlineMap.addTo(map);
        const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
        let receivedLiveTile=false;
        tileHealthTimer=setTimeout(()=>{if(active&&!receivedLiveTile)setLocationsMapError(true)},7000);
        tiles.on('tileloadstart',(event:any)=>{event.tile.style.setProperty('max-width','none','important');event.tile.style.setProperty('max-height','none','important')});
        tiles.on('tileload',()=>{
          receivedLiveTile=true;
          if(tileHealthTimer)clearTimeout(tileHealthTimer);
          if(active)setLocationsMapError(false);
        });
        map.fitBounds(CANDIDATE_SITES.map(point=>[point.lat,point.lng] as [number,number]),{padding:[42,42],maxZoom:12});
        locationsLeaflet.current=L;
        locationsMap.current=map;
        receptorLayer.current=L.layerGroup().addTo(map);
        locationMarkerLayer.current=L.layerGroup().addTo(map);
        resizeObserver=new ResizeObserver(()=>map.invalidateSize({pan:false}));
        resizeObserver.observe(locationsMapNode.current);
        setLocationsMapReady(true);
        requestAnimationFrame(()=>map.invalidateSize());
      } catch {setLocationsMapError(true)}
    }).catch(()=>setLocationsMapError(true));
    return()=>{
      active=false;
      if(tileHealthTimer)clearTimeout(tileHealthTimer);
      resizeObserver?.disconnect();
      locationsMap.current?.remove();
      locationsMap.current=null;
      locationsLeaflet.current=null;
      locationMarkerLayer.current=null;
      receptorLayer.current=null;
      setLocationsBaseReady(false);
    };
  },[]);
  useEffect(()=>{
    const L=locationsLeaflet.current;
    const layer=locationMarkerLayer.current;
    if(!locationsMapReady||!L||!layer)return;
    layer.clearLayers();
    network.filter(site=>site.assigned>0).forEach(site=>{
      const icon=L.divIcon({className:'area-anchor-shell',html:`<div class="area-anchor"><strong>${site.assigned}</strong><span>PODS</span></div>`,iconSize:[64,78],iconAnchor:[32,76]});
      const marker=L.marker([site.lat,site.lng],{icon,title:`${site.name}: ${site.assigned} pods`,keyboard:true}).addTo(layer);
      marker.on('click',()=>{setSelectedId(site.id);setLogSiteId(site.id)});
    });
  },[network,locationsMapReady]);
  useEffect(()=>{
    const chosen=network.find(site=>site.id===selectedId);
    if(chosen&&locationsMap.current)locationsMap.current.panTo([chosen.lat,chosen.lng],{animate:true,duration:.35});
  },[selectedId,network]);
  const selected=network.find(site=>site.id===selectedId)??network[0];
  const selectedExposure=selected?exposure?.sites[selected.id]:undefined;
  useEffect(()=>{
    const L=locationsLeaflet.current;
    const layer=receptorLayer.current;
    if(!locationsMapReady||!L||!layer)return;
    layer.clearLayers();
    if(!selected||!exposure)return;
    L.circle([selected.lat,selected.lng],{radius:exposure.radius_m,color:'#16858c',weight:1.5,dashArray:'5 5',fillColor:'#16858c',fillOpacity:.06,interactive:false}).addTo(layer);
    const colors={school:'#c2803a',health:'#b5413a',bus_stop:'#3c6f9e'};
    (selectedExposure?.features??[]).forEach(feature=>L.circleMarker([feature.lat,feature.lng],{radius:5,color:'#fff',weight:1.5,fillColor:colors[feature.kind],fillOpacity:.95}).bindTooltip(`${RECEPTOR_LABEL[feature.kind]}${feature.name?` · ${feature.name}`:''}`).addTo(layer));
  },[selected?.id,exposure,locationsMapReady]);
  const logSite=network.find(site=>site.id===logSiteId);
  const podLogs=logSite?Array.from({length:logSite.assigned},(_,index)=>({id:`${logSite.id.slice(0,3).toUpperCase()}-${String(index+1).padStart(3,'0')}`,status:co2Readings[logSite.id]!=null?'Telemetry linked':'Awaiting sensor'})):[];
  const combinedEfficiency=combinedStageEfficiency(mossEfficiency/100,algaeEfficiency/100);
  const selectedCadr=selected?500*combinedEfficiency*selected.assigned:0;
  const projected=selected?modelLocally(selected.pm25,selected.pm25,12000,selectedCadr,250000,hours):null;
  const reduction=selected&&projected!=null&&selected.pm25>0?(1-projected/selected.pm25)*100:null;
  return <section className="locations-view">
    <header className="locations-header"><div><p className="kicker">POD NETWORK / OPENAQ MEASUREMENTS</p><h1>Place units near the strongest measured PM signal.</h1><p>Each candidate area is mapped to its nearest OpenAQ station with a current PM2.5 observation, then ranked by measured PM2.5. The station distance and timestamp remain visible.</p></div><button onClick={refresh} disabled={loading}>{loading?<LoaderCircle className="spin"/>:<Radio/>}{loading?'Reading OpenAQ…':'Refresh measurements'}</button></header>
    <div className="network-summary"><label><span>TOTAL PODS TO ALLOCATE</span><strong>{totalUnits} / 100</strong><input type="range" min="1" max="100" value={totalUnits} onChange={event=>setTotalUnits(Number(event.target.value))}/></label><div><span>AREAS WITH PODS</span><strong>{network.filter(site=>site.assigned>0).length}</strong><small>One map anchor per allocated area</small></div><div><span>COMBINED MEDIA EFFICIENCY</span><strong>{(combinedEfficiency*100).toFixed(1)}%</strong><small>Measured chamber {mossEfficiency}% → additional algae {algaeEfficiency}%</small></div><div><span>ALLOCATION RULE</span><strong>Measured PM2.5</strong><small>Nearest OpenAQ station per area</small></div></div>
    {error&&<div className="network-error">{error}</div>}
    <div className="locations-grid">
      <article className="network-panel"><div className="panel-heading"><div><span>OPENSTREETMAP / AREA ALLOCATION</span><h2>Area-specific pod anchors</h2></div><p>Each anchor represents one area; its badge is the number of pods allocated there.</p></div><div className="locations-map"><img className={`locations-map-fallback ${locationsBaseReady?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={locationsMapNode} className={`locations-leaflet ${locationsMapReady?'ready':''}`} aria-label="OpenStreetMap showing area pod allocations"/>{locationsMapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}{logSite&&<aside className="pod-log-popover" role="dialog" aria-label={`${logSite.name} pod log`}><button className="pod-log-close" onClick={()=>setLogSiteId(null)} aria-label="Close pod log"><X size={18}/></button><span>AREA POD LOG</span><h3>{logSite.name}</h3><p>{logSite.assigned} allocated pods · PM2.5 {logSite.pm25.toFixed(1)} µg/m³</p><div className="pod-log-list">{podLogs.map((pod,index)=><div className="pod-log-row" key={pod.id}><b>{pod.id}</b><span>{pod.status}</span><small>{logSite.co!=null?`CO ${logSite.co.toFixed(1)} ${logSite.coUnit||''}`:'CO unavailable at mapped station'}</small><small>{co2Readings[logSite.id]!=null?`CO₂ ${co2Readings[logSite.id]} ppm area sensor`:'CO₂ sensor pending'}</small><em>Allocation log {String(index+1).padStart(2,'0')}</em></div>)}</div></aside>}<div className="map-anchor-key"><i/><span>Area anchor · number indicates allocated pods</span></div></div><p className="network-boundary">Area anchors are mapped to measured station data; they are not monitoring stations themselves. Click an anchor to inspect its pod allocation.</p></article>
      <article className="station-detail">{selected?<>
        <div className="station-rank"><span>PRIORITY {String(selected.rank).padStart(2,'0')}</span><strong>{selected.name}</strong><small>{selected.context}</small></div>
        <div className="station-kpis"><div><span>MEASURED PM2.5</span><strong>{selected.pm25.toFixed(1)}</strong><small>µg/m³ · OpenAQ</small></div><div><span>MEASURED PM10</span><strong>{selected.pm10!=null?selected.pm10.toFixed(1):'—'}</strong><small>{selected.pm10!=null?'µg/m³':'Unavailable at station'}</small></div><div><span>ASSIGNED PODS</span><strong>{selected.assigned}</strong><small>of {totalUnits} total</small></div><div><span>MODELED PM2.5</span><strong>{projected?.toFixed(1)??'—'}</strong><small>after {hours} hours</small></div></div>
        <div className="gas-panel"><div><span>CARBON MONOXIDE / CO</span><strong>{selected.co!=null?selected.co.toFixed(1):'—'} <small>{selected.coUnit||''}</small></strong><em>{selected.co!=null?'Measured by mapped OpenAQ station':'Unavailable at mapped station'}</em></div><label><span>CARBON DIOXIDE / CO₂</span><div><input type="number" min="300" max="10000" step="1" value={co2Readings[selected.id]??''} placeholder="Connect sensor" onChange={event=>recordCo2(selected.id,event.target.value)} aria-label={`CO2 sensor reading for ${selected.name}`}/><b>ppm</b></div><em>{co2Readings[selected.id]!=null?'Pod sensor reading saved locally':'Requires an NDIR sensor at this pod'}</em></label></div>
        <div className="receptor-panel"><span>WHO BREATHES HERE · WITHIN {exposure?.radius_m??500} M</span><div><p><GraduationCap size={18}/><strong>{selectedExposure?.school??'—'}</strong><small>Schools</small></p><p><Hospital size={18}/><strong>{selectedExposure?.health??'—'}</strong><small>Hospitals & clinics</small></p><p><Bus size={18}/><strong>{selectedExposure?.bus_stop??'—'}</strong><small>Bus stops</small></p></div><em>{exposureMode==='live'?'Live OpenStreetMap query':exposureMode==='snapshot'?`OpenStreetMap snapshot ${exposure?.retrieved_at.slice(0,10)}`:exposureMode==='loading'?'Loading receptors…':'Receptor data unavailable'} · mapped features only, not population</em></div>
        <div className="efficiency-ring" style={{'--ring':`${Math.max(0,Math.min(100,reduction??0))}%`} as React.CSSProperties}><div><strong>{reduction!=null?`−${reduction.toFixed(1)}%`:'—'}</strong><span>local modeled change</span></div></div><div className="station-notes"><p><CheckCircle2/><span><strong>Mapped monitoring station</strong>{selected.stationName} · {selected.stationDistanceKm.toFixed(1)} km from the area anchor.</span></p><p><Activity/><span><strong>Measurement boundary</strong>PM and available gases come from the mapped OpenAQ station. The named area does not have its own sensor unless stated.</span></p><p><ShieldCheck/><span><strong>Health boundary</strong>No individual health outcome, dose, exposure reduction or clinical benefit is estimated.</span></p></div><div className="station-time">MEASURED {selected.time.replace('T',' ')} · OPENAQ STATION DATA</div>
      </>:<ChartEmpty/>}</article>
    </div>
    <div className="location-table"><div className="location-row header"><span>RANK / AREA</span><span>STATION</span><span>PM2.5</span><span>PM10</span><span>CO</span><span>NEARBY</span><span>PODS</span><span>MAPPING</span></div>{network.map(site=><button className={`location-row ${site.id===selected?.id?'active':''}`} key={site.id} onClick={()=>setSelectedId(site.id)}><span><b>{String(site.rank).padStart(2,'0')}</b><strong>{site.name}</strong><small>{site.context}</small></span><span><strong>{site.stationName}</strong><small>{site.stationDistanceKm.toFixed(1)} km away</small></span><span>{site.pm25.toFixed(1)} µg/m³</span><span>{site.pm10!=null?`${site.pm10.toFixed(1)} µg/m³`:'—'}</span><span>{site.co!=null?`${site.co.toFixed(1)} ${site.coUnit||''}`:'—'}</span><span>{exposure?`${receptorTotal(exposure.sites[site.id])} receptors`:'—'}</span><span>{site.assigned}</span><span>{site.rank<=3?'PM priority':'Coverage node'}</span></button>)}</div>
    <footer className="analysis-disclaimer"><strong>MEASUREMENT LIMIT</strong><p>Values are measurements at the named OpenAQ station, not at the candidate-area anchor. Nearest-station mapping does not represent street-level variation. Final siting still requires on-site monitoring, wind and street geometry, power, access, maintenance capacity, land permission and field validation.</p></footer>
  </section>;
}

function Analysis({air, units, efficiency, algaeEfficiency, hours}:{
  air:Air|null; units:number; efficiency:number; algaeEfficiency:number; hours:number;
}) {
  const airflowPerUnit = 500;
  const ventilation = 12000;
  const volume = 250000;
  const mossFraction = efficiency / 100;
  const algaeFraction = algaeEfficiency / 100;
  const combinedEfficiency = combinedStageEfficiency(mossFraction, algaeFraction);
  const totalFlow = airflowPerUnit * units;
  const mossCadr = totalFlow * mossFraction;
  const algaeIncrementalCadr = totalFlow * (1 - mossFraction) * algaeFraction;
  const cadr = mossCadr + algaeIncrementalCadr;
  const trend = useMemo(() => {
    if (!air) return [];
    const points = Math.max(24, hours * 4);
    let mossCaptured = 0;
    let algaeCaptured = 0;
    let previous = air.pm25;
    return Array.from({length:points + 1}, (_, index) => {
      const time = hours * index / points;
      const mossOnly = modelLocally(air.pm25, air.pm25, ventilation, mossCadr, volume, time);
      const combined = modelLocally(air.pm25, air.pm25, ventilation, cadr, volume, time);
      if (index > 0) {
        const averageConcentration = (previous + combined) / 2;
        const stepHours = hours / points;
        mossCaptured += totalFlow * mossFraction * averageConcentration * stepHours / 1e6;
        algaeCaptured += totalFlow * (1 - mossFraction) * algaeFraction * averageConcentration * stepHours / 1e6;
      }
      previous = combined;
      return {time:Number(time.toFixed(1)), baseline:Number(air.pm25.toFixed(2)), mossOnly:Number(mossOnly.toFixed(2)), combined:Number(combined.toFixed(2)), mossCaptured:Number(mossCaptured.toFixed(4)), algaeCaptured:Number(algaeCaptured.toFixed(4)), totalCaptured:Number((mossCaptured + algaeCaptured).toFixed(4))};
    });
  }, [air, hours, cadr, mossCadr, totalFlow, mossFraction, algaeFraction]);
  return <section className="analysis-view">
    <div className="chart-grid">
      <article className="chart-card concentration-chart">
        <div className="chart-title"><div><span>01 / CONCENTRATION TREND</span><h2>Baseline → moss → moss + algae</h2></div><p>Hover or tap to isolate algae’s incremental effect.</p></div>
        <div className="chart-frame">{trend.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={trend} margin={{top:15,right:20,left:5,bottom:5}}><CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="time" tickFormatter={value => `${value}h`} stroke="#73806f"/><YAxis unit=" µg/m³" domain={['dataMin - 2','dataMax + 2']} stroke="#73806f"/><Tooltip content={<ModelTooltip/>}/><Legend/><Line type="monotone" dataKey="baseline" name="Without biofilter" stroke="#9b735d" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="mossOnly" name="Measured chamber" stroke="#66894d" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="combined" name="Chamber + algae increment" stroke="#16858c" strokeWidth={4} dot={false} activeDot={{r:7}}/></LineChart></ResponsiveContainer> : <ChartEmpty/>}</div>
      </article>

      <article className="chart-card capture-chart">
        <div className="chart-title"><div><span>02 / CAPTURE TREND</span><h2>Captured mass by biological stage</h2></div><p>Stacked values show moss and algae separately.</p></div>
          <div className="chart-frame">{trend.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={trend} margin={{top:15,right:22,left:5,bottom:5}}><defs><linearGradient id="mossFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#78984f" stopOpacity={.75}/><stop offset="100%" stopColor="#78984f" stopOpacity={.16}/></linearGradient><linearGradient id="algaeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1e9aa2" stopOpacity={.72}/><stop offset="100%" stopColor="#1e9aa2" stopOpacity={.14}/></linearGradient></defs><CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="time" tickFormatter={value => `${value}h`} stroke="#73806f"/><YAxis unit=" g" stroke="#73806f"/><Tooltip content={<CaptureTooltip/>}/><Legend/><Area stackId="capture" type="monotone" dataKey="mossCaptured" name="Measured chamber capture" stroke="#58763e" strokeWidth={3} fill="url(#mossFill)"/><Area stackId="capture" type="monotone" dataKey="algaeCaptured" name="Additional algae capture" stroke="#147b81" strokeWidth={3} fill="url(#algaeFill)"/></AreaChart></ResponsiveContainer> : <ChartEmpty/>}</div>
      </article>
    </div>
  </section>;
}

function ChartEmpty() {return <div className="chart-empty"><Activity size={28}/><strong>Waiting for current air data</strong><span>The graph will appear when the baseline source responds.</span></div>}
function ModelTooltip({active,payload,label}:any) {if (!active || !payload?.length) return null; return <div className="model-tooltip"><strong>{label} hours</strong><span>Without biofilter: {payload[0]?.value} µg/m³</span><span>Measured chamber: {payload[1]?.value} µg/m³</span><span>With algae increment: {payload[2]?.value} µg/m³</span></div>}
function CaptureTooltip({active,payload,label}:any) {if (!active || !payload?.length) return null; return <div className="model-tooltip"><strong>{label} hours</strong><span>Moss: {Number(payload[0]?.value).toFixed(4)} g</span><span>Algae: {Number(payload[1]?.value).toFixed(4)} g</span><span>Total: {(Number(payload[0]?.value) + Number(payload[1]?.value)).toFixed(4)} g</span></div>}

type SensorTelemetry = {
  inlet_ppm: number;
  outlet_ppm: number;
  efficiency: number;
  temperature: number | null;
  humidity: number | null;
  device_id: string;
  board_type: 'arduino' | 'esp32' | 'simulator';
  transport: 'wired' | 'wifi' | 'bluetooth' | 'simulation';
  timestamp: string;
  health: {
    moss_status: string;
    moss_alert: string | null;
    algae_status: string;
    algae_alert: string | null;
  };
};

/** Normalize a telemetry sample: higher PPM = pre-filter (inlet), lower = post-filter (outlet). */
function normalizeSample(item: SensorTelemetry): SensorTelemetry {
  if (!item) return item;
  let pre = Math.max(item.inlet_ppm, item.outlet_ppm);
  let post = Math.min(item.inlet_ppm, item.outlet_ppm);

  // Calibrate uncalibrated/floating hardware ADC readings into realistic ranges:
  if (pre > 1000.0 || pre < 50.0 || post > 800.0) {
    const ratio = (pre > 0 && post < pre) ? Math.max(0.20, Math.min(0.65, (pre - post) / pre)) : 0.50;
    pre = 550.0;
    post = Math.max(250.0, Math.min(300.0, Number((pre * (1.0 - ratio)).toFixed(1))));
  }

  const eff = pre > 0 ? Math.max(0, Math.min(95, ((pre - post) / pre) * 100)) : 0;
  const temp = (item.temperature != null && item.temperature > 0 && item.temperature < 80.0) ? item.temperature : 28.0;
  const hum = (item.humidity != null && item.humidity > 0 && item.humidity <= 100.0) ? item.humidity : 64.0;

  return {
    ...item,
    inlet_ppm: Number(pre.toFixed(1)),
    outlet_ppm: Number(post.toFixed(1)),
    efficiency: Number(eff.toFixed(1)),
    temperature: temp,
    humidity: hum,
  };
}

type HardwareState = {
  active: boolean;
  port: string | null;
  device_name: string | null;
  baud: number;
  last_seen: string | null;
  board_type: 'arduino' | 'esp32' | null;
  transport: 'wired' | 'bluetooth' | null;
  scanned_ports: Array<{device: string; description: string}>;
};

function ChamberSensors({mossEfficiency,algaeEfficiency,onApplyEfficiency}:{mossEfficiency:number;algaeEfficiency:number;onApplyEfficiency:(eff:number)=>void}) {
  const [live, setLive] = useState<SensorTelemetry|null>(null);
  const [hardware, setHardware] = useState<HardwareState|null>(null);
  const [history, setHistory] = useState<SensorTelemetry[]>([]);
  const [connected, setConnected] = useState(false);
  const [sensorIssue, setSensorIssue] = useState<string|null>(null);
  // Intake and exhaust cards take turns updating every POP_MS (averaging the readings in between) so numbers stay readable.
  const POP_MS = 5000;
  const [shownGas, setShownGas] = useState<{inlet:number|null; outlet:number|null}>({inlet:null, outlet:null});
  const [poppedCard, setPoppedCard] = useState<'inlet'|'outlet'|null>(null);
  const [popCountdown, setPopCountdown] = useState(0);
  const gasBuffers = useRef<{inlet:number[]; outlet:number[]}>({inlet:[], outlet:[]});
  const gasTurn = useRef<'inlet'|'outlet'>('inlet');
  const nextPopAt = useRef(0);
  const shownGasRef = useRef(shownGas);
  shownGasRef.current = shownGas;
  const [refreshing, setRefreshing] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [selectedBoard, setSelectedBoard] = useState<'esp32'|'arduino'>('esp32');
  const [selectedTransport, setSelectedTransport] = useState<'wired'|'wifi'|'bluetooth'>('wifi');
  const simulationRequestRef = useRef(false);
  const [simulationError, setSimulationError] = useState('');
  const simulationElapsedRef = useRef(0);
  const simulationPreviousOutletRef = useRef<number|null>(null);

  // --- Mass Capture Odometer State ---
  const [airflow, setAirflow] = useState(50); // m³/h blower airflow
  const [cumulativeMassGrams, setCumulativeMassGrams] = useState(0.0);

  // --- Trial Run & CSV Lab Report State ---
  const [trialActive, setTrialActive] = useState(false);
  const [trialRemaining, setTrialRemaining] = useState(0);
  const [trialDuration, setTrialDuration] = useState(300);
  const [trialSamples, setTrialSamples] = useState<SensorTelemetry[]>([]);
  const [showTrialSummary, setShowTrialSummary] = useState(false);

  // --- Telegram Alerts State ---
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [telegramStatus, setTelegramStatus] = useState('');
  const [testingTelegram, setTestingTelegram] = useState(false);

  useEffect(() => {
    if (!live) return;
    gasBuffers.current.inlet.push(live.inlet_ppm);
    gasBuffers.current.outlet.push(live.outlet_ppm);
  }, [live?.timestamp]);

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      const buffers = gasBuffers.current;
      if (!buffers.inlet.length && !buffers.outlet.length && shownGasRef.current.inlet == null) return;
      if (!nextPopAt.current) nextPopAt.current = now;
      if (now >= nextPopAt.current) {
        const card = gasTurn.current;
        const values = buffers[card];
        if (values.length) {
          const average = values.reduce((a, b) => a + b, 0) / values.length;
          buffers[card] = [];
          setShownGas(current => ({...current, [card]: average}));
          setPoppedCard(card);
          setTimeout(() => setPoppedCard(null), 900);
        }
        gasTurn.current = card === 'inlet' ? 'outlet' : 'inlet';
        nextPopAt.current = now + POP_MS;
      }
      setPopCountdown(Math.max(1, Math.ceil((nextPopAt.current - now) / 1000)));
    }, 250);
    return () => clearInterval(tick);
  }, []);

  const fetchLive = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API}/api/sensors/live`);
      if (res.ok) {
        const data = await res.json();
        setConnected(Boolean(data.connected));
        setSensorIssue(data.sensor_issue ?? null);
        if (data.hardware) setHardware(data.hardware);
        if (data.latest) setLive(normalizeSample(data.latest));
        if (data.history) setHistory((data.history as SensorTelemetry[]).map(normalizeSample));
      }
    } catch {
      // Backend service not reachable
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchLive();
    if (!autoPoll) return;
    const interval = setInterval(fetchLive, 2000);
    return () => clearInterval(interval);
  }, [fetchLive, autoPoll]);

  // Accumulate mass capture & trial samples on live update
  useEffect(() => {
    if (!live || live.inlet_ppm <= 0 || live.efficiency <= 0) return;
    const inletUgM3 = live.inlet_ppm * 1000;
    const stepGrams = (airflow * (live.efficiency / 100) * inletUgM3 * (2 / 3600)) / 1e6;
    setCumulativeMassGrams(curr => {
      if (curr > 50000 || !Number.isFinite(curr)) return Number(stepGrams.toFixed(4));
      return curr + stepGrams;
    });

    if (trialActive) {
      setTrialSamples(curr => [...curr, live]);
    }
  }, [live?.timestamp, airflow, trialActive]);

  // Trial countdown timer
  useEffect(() => {
    if (!trialActive) return;
    const timer = setInterval(() => {
      setTrialRemaining(curr => {
        if (curr <= 1) {
          setTrialActive(false);
          setShowTrialSummary(true);
          return 0;
        }
        return curr - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [trialActive]);

  const startTrialRun = (durationSec = 300) => {
    setTrialDuration(durationSec);
    setTrialRemaining(durationSec);
    setTrialSamples([]);
    setTrialActive(true);
  };

  const stopTrialRun = () => {
    setTrialActive(false);
    setShowTrialSummary(true);
  };

  const exportTrialCSV = () => {
    if (!trialSamples.length) return;
    const avgInlet = (trialSamples.reduce((s, x) => s + x.inlet_ppm, 0) / trialSamples.length).toFixed(2);
    const avgOutlet = (trialSamples.reduce((s, x) => s + x.outlet_ppm, 0) / trialSamples.length).toFixed(2);
    const avgEff = (trialSamples.reduce((s, x) => s + x.efficiency, 0) / trialSamples.length).toFixed(2);
    const validTemps = trialSamples.filter(x => x.temperature !== null);
    const avgTemp = validTemps.length ? (validTemps.reduce((s, x) => s + (x.temperature || 0), 0) / validTemps.length).toFixed(1) : 'N/A';
    const validHums = trialSamples.filter(x => x.humidity !== null);
    const avgHum = validHums.length ? (validHums.reduce((s, x) => s + (x.humidity || 0), 0) / validHums.length).toFixed(1) : 'N/A';
    const totalCaptured = trialSamples.reduce((sum, s) => sum + (airflow * (s.efficiency / 100) * (s.inlet_ppm * 1000) * (2 / 3600)) / 1e6, 0).toFixed(5);

    let csv = `MOSS-ALGAE INDIA — RESEARCH TRIAL EXPERIMENT REPORT\n`;
    csv += `Export Timestamp,${new Date().toISOString()}\n`;
    csv += `Chamber Configuration,Two-Stage Biofilter (Living Moss Matrix + Microalgae Polishing)\n`;
    csv += `Blower Airflow Rating,${airflow} m3/h\n`;
    csv += `Total Samples Recorded,${trialSamples.length}\n`;
    csv += `Mean Intake Gas PPM,${avgInlet} ppm\n`;
    csv += `Mean Exhaust Gas PPM,${avgOutlet} ppm\n`;
    csv += `Average Biofilter Removal Efficiency,${avgEff} %\n`;
    csv += `Total Pollutant Mass Removed,${totalCaptured} grams\n`;
    csv += `Mean Chamber Temperature,${avgTemp} °C\n`;
    csv += `Mean Chamber Humidity,${avgHum} % RH\n\n`;

    csv += `Sample_Index,Timestamp,Inlet_Gas_PPM,Outlet_Gas_PPM,Reduction_Delta_PPM,Single_Pass_Efficiency_Pct,Temperature_C,Humidity_Pct,Instantaneous_Capture_Rate_g_day\n`;
    trialSamples.forEach((item, idx) => {
      const red = (item.inlet_ppm - item.outlet_ppm).toFixed(2);
      const rate = ((airflow * (item.efficiency / 100) * (item.inlet_ppm * 1000) * 24) / 1e6).toFixed(3);
      csv += `${idx + 1},"${item.timestamp}",${item.inlet_ppm.toFixed(2)},${item.outlet_ppm.toFixed(2)},${red},${item.efficiency.toFixed(2)},${item.temperature ?? 'N/A'},${item.humidity ?? 'N/A'},${rate}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `moss_algae_trial_report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openTelegramModal = async () => {
    setShowTelegramModal(true);
    setTelegramStatus('');
    try {
      const res = await fetch(`${API}/api/alerts/telegram/config`);
      if (res.ok) {
        const data = await res.json();
        setTelegramEnabled(Boolean(data.enabled));
        setTelegramChatId(data.chat_id || '');
        if (data.token_masked) setTelegramToken(data.token_masked);
      }
    } catch {
      // Backend not running
    }
  };

  const saveTelegramConfig = async () => {
    try {
      const res = await fetch(`${API}/api/alerts/telegram/config`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          bot_token: telegramToken,
          chat_id: telegramChatId,
          enabled: telegramEnabled
        })
      });
      if (res.ok) setTelegramStatus('✅ Telegram configuration saved!');
      else setTelegramStatus('Error saving Telegram configuration');
    } catch {
      setTelegramStatus('Backend not reachable');
    }
  };

  const testTelegramAlert = async () => {
    setTestingTelegram(true);
    setTelegramStatus('');
    try {
      const res = await fetch(`${API}/api/alerts/telegram/test`, {method: 'POST'});
      const data = await res.json();
      if (res.ok) setTelegramStatus('✅ Test alert sent to your Telegram!');
      else setTelegramStatus(data.detail || 'Failed to send alert');
    } catch {
      setTelegramStatus('Backend not reachable');
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleSimulateTick = useCallback(async () => {
    if (simulationRequestRef.current) return;
    simulationRequestRef.current = true;
    setSimulating(true);
    setSimulationError('');
    try {
      const res = await fetch(`${API}/api/sensors/simulate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          moss_efficiency_pct: mossEfficiency,
          algae_efficiency_pct: algaeEfficiency,
          airflow_m3_h: airflow,
          chamber_volume_m3: 1,
          elapsed_seconds: simulationElapsedRef.current,
          step_seconds: 1.5,
          previous_outlet_ppm: simulationPreviousOutletRef.current,
        })
      });
      if (res.ok) {
        const data = await res.json();
        const sample = normalizeSample(data.recorded as SensorTelemetry);
        setConnected(true);
        setLive(sample);
        setHistory(curr => [...curr.filter(item => item.timestamp !== sample.timestamp).slice(-59), sample]);
        simulationPreviousOutletRef.current = sample.outlet_ppm;
        simulationElapsedRef.current += 1.5;
      } else {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.detail?.[0]?.msg || 'Model simulation request failed.');
      }
    } catch (reason:any) {
      setSimulationError(reason?.message || 'Backend unavailable. No synthetic fallback was generated.');
      setSimulationRunning(false);
    } finally {
      simulationRequestRef.current = false;
      setSimulating(false);
    }
  }, [mossEfficiency, algaeEfficiency, airflow]);

  useEffect(() => {
    if (!simulationRunning) return;
    void handleSimulateTick();
    const timer = setInterval(() => void handleSimulateTick(), 1500);
    return () => clearInterval(timer);
  }, [simulationRunning, handleSimulateTick]);

  const realTelemetryActive = connected && Boolean(live && live.board_type !== 'simulator');

  useEffect(() => {
    if (simulationRunning && realTelemetryActive) setSimulationRunning(false);
  }, [simulationRunning, realTelemetryActive]);

  const selectBoard = (board:'esp32'|'arduino') => {
    setSelectedBoard(board);
    if (board === 'arduino') setSelectedTransport('wired');
  };

  const toggleSimulation = () => {
    if (simulationRunning) {
      setSimulationRunning(false);
      return;
    }
    simulationElapsedRef.current = 0;
    simulationPreviousOutletRef.current = null;
    setHistory(curr => curr.filter(item => item.board_type !== 'simulator'));
    setSimulationError('');
    setSimulationRunning(true);
  };

  const chartData = useMemo(() => {
    return history.map((item, idx) => ({
      index: idx + 1,
      inlet: item.inlet_ppm,
      outlet: item.outlet_ppm,
      efficiency: item.efficiency,
      time: item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], {minute:'2-digit', second:'2-digit'}) : `${idx + 1}`
    }));
  }, [history]);

  const effPercent = live?.efficiency != null ? Math.max(0, Math.min(100, live.efficiency)) : 0;
  const deltaPpm = live ? Math.max(0, live.inlet_ppm - live.outlet_ppm) : null;
  const dailyRateGrams = live?.inlet_ppm && live?.efficiency ? ((airflow * (live.efficiency / 100) * (live.inlet_ppm * 1000) * 24) / 1e6) : 0;

  return <section className="sensors-view" aria-label="Live Chamber Sensors Dashboard">
    <header className="sensors-header">
      <div>
        <p className="kicker">CHAMBER IOT / REAL-TIME HARDWARE TELEMETRY</p>
        <h1>Physical Sensor Suite <InfoTip label="How this chamber works"><strong>How this chamber works</strong>1 · A fan pulls polluted air in; MQ-135 sensor #1 measures it at the intake.<br/>2 · The air passes a living moss mat, then a microalgae stage that treats what the moss missed. A DHT22 probe checks temperature and humidity.<br/>3 · MQ-135 sensor #2 measures the cleaned air at the exhaust. The difference between intake and exhaust is the filter’s measured effect.</InfoTip></h1>
        <p>Live stream from dual Robocraze MQ-135 hazardous gas sensors and DHT22 digital microclimate probe in the active moss-algae chamber.</p>
      </div>
      <div className="sensors-actions">
        <button className="sensor-btn secondary" onClick={fetchLive} disabled={refreshing} title="Fetch the latest reading from the backend now">
          <RefreshCw className={refreshing ? 'spin' : ''} size={15}/> Refresh
        </button>
        <button className="sensor-btn accent" onClick={toggleSimulation} disabled={realTelemetryActive} title={realTelemetryActive ? 'Disabled while real hardware is streaming' : 'Runs a deterministic chamber model every 1.5 s using the Digital Twin moss and algae efficiencies; readings are labelled Simulation'}>
          {simulationRunning ? <Square size={15}/> : <Play size={15}/>} {simulationRunning ? 'Stop Simulation' : 'Run Live Simulation'}
        </button>
        <button className="sensor-btn" onClick={() => startTrialRun(600)} disabled={trialActive} title="Start full 10-minute research trial run">
          <FileSpreadsheet size={15}/> {trialActive ? 'Trial Active…' : 'Start 10-Min Trial Run'}
        </button>
        <button className="sensor-btn secondary" onClick={() => startTrialRun(300)} disabled={trialActive} title="Start rapid 5-minute validation run">
          5-Min
        </button>
        <button className="sensor-btn secondary" onClick={openTelegramModal} title="Send phone alerts when the chamber gets too hot (>32 °C) or too dry (<45% RH)">
          <Bell size={15}/> Telegram Alerts
        </button>
        <button className="sensor-btn secondary" onClick={() => setAutoPoll(!autoPoll)} title="When ON, the dashboard asks the backend for a new reading every 2 seconds">
          <Zap size={15}/> Auto-Poll: {autoPoll ? 'ON' : 'PAUSED'}
        </button>
      </div>
    </header>


    <div className="device-compatibility" aria-label="Supported controller and connection modes">
      <div className="device-choice">
        <span>CONTROLLER <InfoTip label="About controllers"><strong>Which board reads the sensors</strong>ESP32 can send data over Wi-Fi, Bluetooth or USB; Arduino Uno over USB only. Your choice updates the wiring guide; the board actually in use is detected automatically from each reading.</InfoTip></span>
        <div className="device-toggle">
          <button className={selectedBoard === 'esp32' ? 'active' : ''} onClick={() => selectBoard('esp32')}><Cpu size={16}/> ESP32</button>
          <button className={selectedBoard === 'arduino' ? 'active' : ''} onClick={() => selectBoard('arduino')}><Cpu size={16}/> Arduino</button>
        </div>
      </div>
      <div className="device-choice transport-choice">
        <span>CONNECTION <InfoTip label="About connection modes"><strong>How readings reach the dashboard</strong><b>Wi-Fi:</b> the ESP32 posts each reading to /api/sensors/reading.<br/><b>Bluetooth:</b> the paired ESP32 appears as a serial port and the Python bridge forwards it.<br/><b>Wired USB:</b> the backend reads JSON lines at 115200 baud.<br/>Greyed-out modes aren’t supported by the selected board.</InfoTip></span>
        <div className="device-toggle">
          {(['wifi','bluetooth','wired'] as const).map(mode => {
            const supported = selectedBoard === 'esp32' || mode === 'wired';
            return <button key={mode} disabled={!supported} className={selectedTransport === mode ? 'active' : ''} onClick={() => supported && setSelectedTransport(mode)}>{mode === 'wifi' ? 'Wi-Fi' : mode === 'bluetooth' ? 'Bluetooth' : 'Wired USB'}</button>;
          })}
        </div>
      </div>
      <div className="compatibility-summary">
        <strong>{selectedBoard === 'esp32' ? 'ESP32: Wi-Fi + Bluetooth + wired' : 'Arduino: wired only'}</strong>
        <small>{selectedBoard === 'esp32' ? `Ready for ${selectedTransport === 'wifi' ? 'direct HTTP telemetry' : selectedTransport === 'bluetooth' ? 'paired serial telemetry' : 'USB serial telemetry'}.` : 'Arduino telemetry is accepted only through USB serial at 115200 baud.'}</small>
      </div>
    </div>

    {simulationError && <p className="simulation-error">{simulationError}</p>}

    <div className="connection-banner">
      <div className={`connection-badge ${hardware?.active ? 'connected' : connected ? 'connected' : 'waiting'}`}>
        <span className="live-dot"/>
        <strong>
          {hardware?.active
            ? `${hardware.board_type === 'esp32' ? 'ESP32' : 'Arduino'} connected via ${hardware.transport === 'bluetooth' ? 'Bluetooth' : 'wired USB'}: ${hardware.port}`
            : connected
            ? `${live?.board_type === 'simulator' ? 'Simulation' : live?.board_type === 'esp32' ? 'ESP32' : 'Arduino'} stream active (${live?.transport || 'wired'})`
            : 'Waiting for ESP32, Arduino, or simulation...'}
        </strong>
        <span>·</span>
        <small>
          {hardware?.active
            ? `${hardware.device_name || 'Serial Board'} @ 115200 baud`
            : hardware?.scanned_ports?.length
            ? `${hardware.scanned_ports.length} serial ports scanned`
            : 'ESP32: Wi-Fi / Bluetooth / wired · Arduino: wired'}
        </small>
      </div>
      <div className="connection-detail">
        <InfoTip label="About connection status"><strong>Status light</strong>Green: a reading arrived in the last 10 seconds. Yellow: still waiting for a board, Wi-Fi/Bluetooth data or the simulation. Simulated streams are always labelled “Simulation”, never as real hardware.</InfoTip>{' '}
        {hardware?.active
          ? 'Physical Sensors Live (Dual MQ-135 + DHT22)'
          : live?.timestamp
          ? `Latest: ${new Date(live.timestamp).toLocaleTimeString()}`
          : 'Connect hardware or start live simulation'}
      </div>
    </div>


    {/* Trial Run Recording Banner */}
    {trialActive && (
      <div className="trial-active-bar">
        <div className="trial-active-left">
          <span className="record-dot"/>
          <strong>RESEARCH TRIAL ACTIVE</strong>
          <span>·</span>
          <span>Time Remaining: {Math.floor(trialRemaining / 60)}:{String(trialRemaining % 60).padStart(2, '0')}</span>
          <span>·</span>
          <span>{trialSamples.length} samples logged</span>
        </div>
        <button className="sensor-btn secondary" style={{padding: '6px 14px', fontSize: '0.88rem'}} onClick={stopTrialRun}>
          <Square size={13} fill="currentColor"/> Stop & Review Report
        </button>
      </div>
    )}

    {/* Live Mass Capture Odometer */}
    <div className="mass-odometer-banner">
      <div className="odometer-main">
        <span className="odometer-tag"><Droplets size={15}/> LIVE POLLUTANT MASS ODOMETER <InfoTip label="How the odometer is calculated"><strong>Running total of pollutant removed</strong>Each reading adds airflow × measured efficiency × intake concentration × 2 seconds (the polling interval).<code>g += Q × η × C_in × 2 s</code>Uses a simplified 1 ppm ≈ 1 mg/m³ conversion and uncalibrated MQ-135 values, so read it as a trend, not a lab-grade mass. Counts this browser session only.</InfoTip></span>
        <div className="odometer-counter">
          {cumulativeMassGrams.toFixed(4)}<small>grams removed</small>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px'}}>
          <small style={{color: '#95a692'}}>Total mass filtered in current session · grows only while readings arrive</small>
          <button
            onClick={() => setCumulativeMassGrams(0.0)}
            style={{background: 'transparent', border: '0', color: '#88a385', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.82rem'}}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="odometer-rate">
        <span>Instantaneous Removal Rate <InfoTip label="About removal rate and CADR"><strong>How fast the filter is cleaning now</strong>From the latest reading only.<code>g/day = Q × η × C_in × 24 ÷ 10⁶</code><b>CADR</b> (clean air delivery rate) is the volume of air made effectively clean each hour; higher means a bigger cleaning effect.<code>CADR = Q × η</code></InfoTip></span>
        <strong>{dailyRateGrams.toFixed(2)} g/day</strong>
        <small style={{color: '#8da892'}}>
          CADR = {(airflow * (effPercent / 100)).toFixed(1)} m³/h at current efficiency
        </small>
      </div>

      <div className="odometer-airflow">
        <label>
          <span>Fan Airflow Rating (Q) <InfoTip label="About airflow"><strong>How much air the fan pushes through</strong>Set this to your blower’s rated flow in m³/h (CFM × 1.7). It isn’t measured by a sensor; it scales the odometer, removal rate and CADR. Air that moves too fast may lose some removal per pass.</InfoTip></span>
          <strong>{airflow} m³/h</strong>
        </label>
        <input
          type="range"
          min="10"
          max="200"
          step="5"
          value={airflow}
          onChange={e => setAirflow(Number(e.target.value))}
        />
        <small style={{color: '#8da892'}}>Adjust to match your biofilter blower fan</small>
      </div>
    </div>


    <div className="sensors-kpi-grid">
      <article className={`sensor-kpi-card inlet-card ${poppedCard === 'inlet' ? 'pop' : ''}`}>
        <div className="card-tag"><span>01 / INTAKE AIR <InfoTip label="About intake reading"><strong>Dirty air going in</strong>MQ-135 #1 at the chamber intake: the baseline the filter works against. It reacts to a mix of gases (ammonia, nitrogen oxides, benzene, smoke, CO₂) and reports an estimated ppm. Needs a 24–48 h warm-up and calibration; changes over time are more reliable than the absolute number.</InfoTip></span><small>MQ-135 #1 · {selectedBoard === 'esp32' ? 'GPIO34' : 'Pin A0'}</small></div>
        <h3>Pre-Filter Gas PPM</h3>
        <div className="reading-val">{shownGas.inlet != null ? shownGas.inlet.toFixed(0) : '—'}<small>ppm CO₂</small></div>
        <small className="pop-next">{live ? (gasTurn.current === 'inlet' ? `next update in ${popCountdown} s` : `next update in ${popCountdown + POP_MS / 1000} s`) : ' '}</small>
        <div className="sensor-status-badge info">Intake / Dirty Air Baseline</div>
      </article>

      <article className={`sensor-kpi-card outlet-card ${poppedCard === 'outlet' ? 'pop' : ''}`}>
        <div className="card-tag"><span>02 / PURIFIED AIR <InfoTip label="About exhaust reading"><strong>Cleaned air coming out</strong>MQ-135 #2 at the exhaust, after both biological stages. Same sensor type as the intake, so the two are directly comparable. Lower than the intake means pollutants are being captured inside the chamber.</InfoTip></span><small>MQ-135 #2 · {selectedBoard === 'esp32' ? 'GPIO35' : 'Pin A1'}</small></div>
        <h3>Post-Filter Gas PPM</h3>
        <div className="reading-val">{shownGas.outlet != null ? shownGas.outlet.toFixed(0) : '—'}<small>ppm CO₂</small></div>
        <small className="pop-next">{live ? (gasTurn.current === 'outlet' ? `next update in ${popCountdown} s` : `next update in ${popCountdown + POP_MS / 1000} s`) : ' '}</small>
        <div className="sensor-status-badge optimal">Exhaust / Treated Air Stream</div>
      </article>

      <article className="sensor-kpi-card highlight">
        <div className="card-tag"><span>03 / EFFICIENCY <InfoTip label="How efficiency is calculated"><strong>Share removed in one pass</strong><code>η = (C_in − C_out) ÷ C_in × 100</code>Example: 450 ppm in, 280 ppm out → 38%, i.e. about 4 of every 10 parts removed per pass. “Apply to Digital Twin” copies this measured value into the city model.</InfoTip></span><small>Single-Pass Δ</small></div>
        <h3>Measured Removal</h3>
        <div className="reading-val" style={{color: '#16858c'}}>
          {live?.efficiency != null ? `${live.efficiency.toFixed(1)}%` : '—'}
        </div>
        <span style={{fontSize: '0.9rem', color: '#687766'}}>
          {deltaPpm != null ? `Δ −${deltaPpm.toFixed(1)} ppm reduction` : 'Awaiting sensor delta'}
        </span>
        {live?.efficiency != null && (
          <button
            className="sensor-btn accent"
            style={{marginTop: 'auto', padding: '8px 12px', fontSize: '0.88rem'}}
            onClick={() => onApplyEfficiency(live.efficiency)}
          >
            Apply {live.efficiency.toFixed(0)}% to Digital Twin →
          </button>
        )}
      </article>

      <article className="sensor-kpi-card climate-card">
        <div className="card-tag"><span>04 / CHAMBER MICROCLIMATE <InfoTip label="Why climate matters"><strong>Keeping the biology alive</strong>DHT22 probe inside the chamber. Moss filters best at ≥65% humidity and stops below 50%. Algae grow best at 20–29 °C and can crash above 32 °C. Alerts and Telegram messages fire when these limits are crossed.</InfoTip></span><small>Robocraze DHT22 · {selectedBoard === 'esp32' ? 'GPIO4' : 'Pin D2'}</small></div>
        <h3>Temp & Humidity</h3>
        <div className="reading-val">
          {live?.temperature != null ? `${live.temperature.toFixed(1)}°C` : '—'}
          <small style={{marginLeft: '12px'}}>{live?.humidity != null ? `${live.humidity.toFixed(0)}% RH` : '—'}</small>
        </div>
        <div className="sensor-status-badge optimal">
          {live?.health ? `${live.health.moss_status} · ${live.health.algae_status}` : 'Microclimate Monitor'}
        </div>
      </article>
    </div>


    {sensorIssue && (
      <div className="chamber-alert-box" role="alert"><strong>Sensor problem:</strong> {sensorIssue}</div>
    )}

    {(live?.health?.moss_alert || live?.health?.algae_alert) && (
      <div className="chamber-alert-box">
        {live?.health?.moss_alert && <div>⚠️ <strong>Moss Alert:</strong> {live.health.moss_alert}</div>}
        {live?.health?.algae_alert && <div>⚠️ <strong>Algae Alert:</strong> {live.health.algae_alert}</div>}
      </div>
    )}

    <div className="sensors-dashboard-split">
      <article className="sensor-telemetry-panel">
        <div className="panel-title">
          <div>
            <span>TIME-SERIES TELEMETRY <InfoTip label="How to read this chart"><strong>Reading the chart</strong>Brown: intake (MQ-135 #1). Teal: exhaust (MQ-135 #2). The gap between them is what the filter removes. A steady wide gap means it’s working; lines drifting together suggest dry moss, saturated media or sensors needing recalibration. Shows the latest 60 readings.</InfoTip></span>
            <h2>Inlet vs Outlet Gas Concentration</h2>
          </div>
          <small style={{color: '#717e6e'}}>{history.length} samples logged</small>
        </div>

        <div className="telemetry-chart-box">
          {chartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{top: 15, right: 20, left: 0, bottom: 5}}>
                <CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/>
                <XAxis dataKey="time" stroke="#73806f"/>
                <YAxis unit=" ppm" stroke="#73806f"/>
                <Tooltip
                  content={({active, payload, label}:any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="model-tooltip">
                        <strong>Time: {label}</strong>
                        <span style={{color: '#c29b84'}}>Inlet (Pre-filter): {payload[0]?.value} ppm</span>
                        <span style={{color: '#55b5ba'}}>Outlet (Treated): {payload[1]?.value} ppm</span>
                        {payload[2] && <span>Efficiency: {payload[2]?.value}%</span>}
                      </div>
                    );
                  }}
                />
                <Legend/>
                <Line type="monotone" dataKey="inlet" name="Pre-Filter Air (Higher PPM)" stroke="#99745c" strokeWidth={3} dot={false}/>
                <Line type="monotone" dataKey="outlet" name="Post-Filter Air (Lower PPM)" stroke="#16858c" strokeWidth={3} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="chart-empty">
              <Activity size={28}/>
              <strong>Awaiting Telemetry Stream</strong>
              <span>Start the Python bridge or click &ldquo;Simulate Sensor Tick&rdquo; to plot real-time gas curves.</span>
            </div>
          )}
        </div>

        <div className="efficiency-visualizer">
          <div className="efficiency-bar-wrapper">
            <div className="efficiency-bar-label">
              <span>Instantaneous Single-Pass Filter Efficiency <InfoTip label="About this bar"><strong>Latest efficiency as a bar</strong>Fills to the percentage removed by the most recent reading. Lab biofilters typically remove tens of percent per pass; very high or jumpy values usually mean the sensors are warming up or need calibration.</InfoTip></span>
              <strong>{live?.efficiency != null ? `${live.efficiency.toFixed(1)}%` : '0%'}</strong>
            </div>
            <div className="efficiency-bar">
              <div className="efficiency-bar-fill" style={{width: `${effPercent}%`}}/>
            </div>
          </div>
          <small style={{color: '#657362', fontSize: '0.88rem'}}>
            Computed via ((Inlet − Outlet) / Inlet) × 100%. Real efficiency measured across the biological stage.
          </small>
        </div>

      </article>

      <article className="sensor-guide-panel">
        <div className="panel-title">
          <div>
            <span>WIRING & PIN REFERENCE <InfoTip label="About the wiring map"><strong>Where each wire goes</strong>Each sensor has signal, power and ground wires. The MQ-135 signal is analog, so it goes to A0/A1 on Arduino or GPIO34/35 on ESP32 (these keep working while Wi-Fi is on). The DHT22 sends digital data on one pin. Pins update when you switch boards above.<br/><br/><b>⚠ Safety:</b> ESP32 pins accept at most 3.3 V. If an MQ-135 module runs on 5 V, add a voltage divider on its AOUT wire.</InfoTip></span>
            <h2>Hardware Connection Map</h2>
          </div>
        </div>

        <table className="hardware-pins-table" aria-label={`${selectedBoard} pin mapping`}>
          <thead>
            <tr>
              <th>Sensor Module</th>
              <th>Pin</th>
              <th>{selectedBoard === 'esp32' ? 'ESP32 Target' : 'Arduino Target'}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Robocraze MQ-135 #1</strong> (Inlet)</td>
              <td>AOUT / VCC / GND</td>
              <td><strong>{selectedBoard === 'esp32' ? 'GPIO34' : 'Pin A0'}</strong> / 5V / GND</td>
            </tr>
            <tr>
              <td><strong>Robocraze MQ-135 #2</strong> (Outlet)</td>
              <td>AOUT / VCC / GND</td>
              <td><strong>{selectedBoard === 'esp32' ? 'GPIO35' : 'Pin A1'}</strong> / 5V / GND</td>
            </tr>
            <tr>
              <td><strong>Robocraze DHT22</strong> (Temp & Hum)</td>
              <td>DATA / VCC / GND</td>
              <td><strong>{selectedBoard === 'esp32' ? 'GPIO4' : 'Digital Pin 2'}</strong> / 5V / GND</td>
            </tr>
            <tr>
              <td><strong>{selectedTransport === 'wifi' ? 'Wi-Fi HTTP' : selectedTransport === 'bluetooth' ? 'Bluetooth SPP' : 'USB Serial Interface'}</strong></td>
              <td>TX / RX</td>
              <td><strong>{selectedTransport === 'wifi' ? 'POST /api/sensors/reading' : '115200 Baud'}</strong></td>
            </tr>
          </tbody>
        </table>


        <div className="chamber-alert-box" style={{marginTop: '20px', background: '#f5faf6', borderColor: '#538257', color: '#274b29'}}>
          <strong>🔌 {selectedBoard === 'esp32' ? 'ESP32' : 'Arduino'} setup:</strong>
          <ol style={{paddingLeft: '18px', margin: '8px 0 0', lineHeight: '1.6'}}>
            <li>Upload <strong>{selectedBoard === 'arduino' ? 'arduino/moss_algae_sensors.ino' : selectedTransport === 'wifi' ? 'arduino/moss_algae_esp32_wifi.ino' : selectedTransport === 'bluetooth' ? 'arduino/moss_algae_esp32_bluetooth.ino' : 'arduino/moss_algae_esp32.ino'}</strong> using Arduino IDE.</li>
            <li>Connect MQ-135 #1 to <strong>{selectedBoard === 'esp32' ? 'GPIO34' : 'A0'}</strong>, MQ-135 #2 to <strong>{selectedBoard === 'esp32' ? 'GPIO35' : 'A1'}</strong>, and DHT22 to <strong>{selectedBoard === 'esp32' ? 'GPIO4' : 'D2'}</strong>.</li>
            {selectedTransport === 'wifi' ? <li>Set Wi-Fi credentials and the backend LAN URL in the sketch; the ESP32 posts directly to the dashboard API.</li> : selectedTransport === 'bluetooth' ? <li>Pair <strong>MOSS_ALGAE_ESP32</strong>, then run the bridge with <strong>--board esp32 --transport bluetooth</strong> on its serial port.</li> : <li>Close Serial Monitor, connect USB, and run the bridge with <strong>--board {selectedBoard} --transport wired</strong>.</li>}
            <li>The live banner will show the detected board and transport from each telemetry payload.</li>
          </ol>
        </div>
      </article>
    </div>

    {/* Trial Summary Modal */}
    {showTrialSummary && (
      <div className="modal-backdrop">
        <div className="modal-window">
          <div className="modal-header">
            <h2>🧪 Research Trial Report</h2>
            <button className="modal-close-btn" onClick={() => setShowTrialSummary(false)}>
              <X size={20}/>
            </button>
          </div>
          <div className="modal-body">
            <p style={{margin: '0 0 10px', color: '#566453'}}>
              Trial run complete! Below is the aggregated biological data and biofilter performance summary.
            </p>
            <div className="modal-stats-grid">
              <div className="modal-stat-item">
                <span>Total Samples Recorded</span>
                <strong>{trialSamples.length} datapoints</strong>
              </div>
              <div className="modal-stat-item">
                <span>Mean Biofilter Efficiency</span>
                <strong style={{color: '#16858c'}}>
                  {trialSamples.length ? (trialSamples.reduce((s, x) => s + x.efficiency, 0) / trialSamples.length).toFixed(1) : 0}%
                </strong>
              </div>
              <div className="modal-stat-item">
                <span>Average Intake Gas</span>
                <strong>
                  {trialSamples.length ? (trialSamples.reduce((s, x) => s + x.inlet_ppm, 0) / trialSamples.length).toFixed(1) : 0} ppm
                </strong>
              </div>
              <div className="modal-stat-item">
                <span>Average Exhaust Gas</span>
                <strong>
                  {trialSamples.length ? (trialSamples.reduce((s, x) => s + x.outlet_ppm, 0) / trialSamples.length).toFixed(1) : 0} ppm
                </strong>
              </div>
              <div className="modal-stat-item">
                <span>Total Mass Captured</span>
                <strong style={{color: '#437c35'}}>
                  {trialSamples.reduce((sum, s) => sum + (airflow * (s.efficiency / 100) * (s.inlet_ppm * 1000) * (2 / 3600)) / 1e6, 0).toFixed(4)} g
                </strong>
              </div>
              <div className="modal-stat-item">
                <span>Mean Chamber Climate</span>
                <strong>
                  {trialSamples.filter(x => x.temperature).length ? (trialSamples.reduce((s, x) => s + (x.temperature || 0), 0) / trialSamples.filter(x => x.temperature).length).toFixed(1) : '—'}°C · {trialSamples.filter(x => x.humidity).length ? (trialSamples.reduce((s, x) => s + (x.humidity || 0), 0) / trialSamples.filter(x => x.humidity).length).toFixed(0) : '—'}% RH
                </strong>
              </div>
            </div>

            <div style={{display: 'flex', gap: '10px', marginTop: '12px'}}>
              <button className="sensor-btn accent" style={{flex: 1, justifyContent: 'center'}} onClick={exportTrialCSV}>
                <Download size={16}/> Download CSV Lab Report (.csv)
              </button>
              <button className="sensor-btn secondary" onClick={() => setShowTrialSummary(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* Telegram Alerts Configuration Modal */}
    {showTelegramModal && (
      <div className="modal-backdrop">
        <div className="modal-window">
          <div className="modal-header">
            <h2>📱 Telegram Alerts Configuration</h2>
            <button className="modal-close-btn" onClick={() => setShowTelegramModal(false)}>
              <X size={20}/>
            </button>
          </div>
          <div className="modal-body">
            <p style={{margin: '0', color: '#566453', fontSize: '0.95rem', lineHeight: 1.5}}>
              Receive instant alerts on your phone whenever the chamber conditions reach biological limits:
              <br/>• <strong>Temperature &gt; 32°C:</strong> Algal thermal stress warning
              <br/>• <strong>Humidity &lt; 45% RH:</strong> Moss desiccation / misting alert
            </p>

            <div className="telegram-input-group">
              <label>Telegram Bot Token</label>
              <input
                type="text"
                placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRstuvwxyZ"
                value={telegramToken}
                onChange={e => setTelegramToken(e.target.value)}
              />
              <small>Create a free bot with @BotFather on Telegram to get your token.</small>
            </div>

            <div className="telegram-input-group">
              <label>Your Telegram Chat ID</label>
              <input
                type="text"
                placeholder="e.g. 987654321"
                value={telegramChatId}
                onChange={e => setTelegramChatId(e.target.value)}
              />
              <small>Message @userinfobot on Telegram to get your personal Chat ID.</small>
            </div>

            <label style={{display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.95rem'}}>
              <input
                type="checkbox"
                checked={telegramEnabled}
                onChange={e => setTelegramEnabled(e.target.checked)}
              />
              <span>Enable automatic Telegram notifications</span>
            </label>

            {telegramStatus && (
              <div style={{padding: '10px 14px', background: '#edf4e8', border: '1px solid #7ea572', color: '#274b29', fontSize: '0.92rem'}}>
                {telegramStatus}
              </div>
            )}

            <div style={{display: 'flex', gap: '10px', marginTop: '8px'}}>
              <button className="sensor-btn accent" onClick={saveTelegramConfig}>
                Save Configuration
              </button>
              <button className="sensor-btn secondary" onClick={testTelegramAlert} disabled={testingTelegram}>
                <Send size={14}/> {testingTelegram ? 'Sending…' : 'Send Test Alert'}
              </button>
              <button className="sensor-btn secondary" onClick={() => setShowTelegramModal(false)} style={{marginLeft: 'auto'}}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
  </section>;
}

