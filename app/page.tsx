'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Activity, ArrowDown, BarChart3, CheckCircle2, Crosshair, FlaskConical, Home, LoaderCircle, MapPin, MapPinned, Radio, ShieldCheck, Wind, X} from 'lucide-react';
import {Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
const INITIAL_SITE = {lat: 12.9716, lng: 77.5946};
type Air = {pm25:number; pm10:number; no2:number; co:number; aqi:number; time:string};
type CandidateSite = {id:string; name:string; context:string; lat:number; lng:number};
type NetworkSite = CandidateSite & Air & {assigned:number; rank:number};
const CANDIDATE_SITES:CandidateSite[] = [
  {id:'peenya',name:'Peenya',context:'Industrial district',lat:13.0296,lng:77.5199},
  {id:'yeshwanthpur',name:'Yeshwanthpur',context:'Transit + freight edge',lat:13.0285,lng:77.5409},
  {id:'majestic',name:'Majestic',context:'High-footfall interchange',lat:12.9767,lng:77.5713},
  {id:'hebbal',name:'Hebbal',context:'Flyover + bus corridor',lat:13.0358,lng:77.5970},
  {id:'kr-puram',name:'KR Puram',context:'Road + rail interchange',lat:13.0004,lng:77.6952},
  {id:'whitefield',name:'Whitefield',context:'Dense employment corridor',lat:12.9698,lng:77.7500},
  {id:'silk-board',name:'Silk Board',context:'Traffic interchange',lat:12.9177,lng:77.6233},
  {id:'jayanagar',name:'Jayanagar',context:'Commercial + residential',lat:12.9250,lng:77.5938},
];

function modelLocally(initial:number, background:number, ventilation:number, cadr:number, volume:number, hours:number) {
  const loss = ventilation + cadr;
  if (!loss) return initial;
  const steady = ventilation * background / loss;
  return steady + (initial - steady) * Math.exp(-loss * hours / volume);
}

function combinedStageEfficiency(moss:number, algae:number) {
  return 1 - (1 - moss) * (1 - algae);
}

export default function MossExperience() {
  const [view, setView] = useState<'home'|'twin'|'analysis'|'locations'>('home');
  const [site, setSite] = useState(INITIAL_SITE);
  const [air, setAir] = useState<Air|null>(null);
  const [futurePm25, setFuturePm25] = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [units, setUnits] = useState(24);
  const [efficiency, setEfficiency] = useState(42);
  const [algaeEfficiency, setAlgaeEfficiency] = useState(28);
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
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${point.lat}&longitude=${point.lng}&current=pm2_5,pm10,nitrogen_dioxide,carbon_monoxide,us_aqi&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Air-quality service did not respond.');
      const data = await response.json();
      setAir({pm25:Number(data.current?.pm2_5 ?? 0), pm10:Number(data.current?.pm10 ?? 0), no2:Number(data.current?.nitrogen_dioxide ?? 0), co:Number(data.current?.carbon_monoxide ?? 0), aqi:Number(data.current?.us_aqi ?? 0), time:String(data.current?.time ?? '')});
    } catch (reason:any) {
      setAir(null);
      setError(reason?.message || 'Unable to load local air quality.');
    } finally {
      setLoading(false);
    }
  }, [site]);

  useEffect(() => { if (view === 'twin' || view === 'analysis') loadAir(site); }, [view, site.lat, site.lng, loadAir]);

  useEffect(() => {
    if (!air) { setFuturePm25(null); return; }
    const combinedEfficiency = combinedStageEfficiency(efficiency / 100, algaeEfficiency / 100);
    const payload = {initial:air.pm25, background:air.pm25, source_ug_h:0, ventilation_m3_h:12000, volume_m3:250000, cadr_m3_h:500 * combinedEfficiency * units, hours, calibration_reference:'Illustrative two-stage moss and algae assumptions v0.2'};
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
    setMapError(false);
    import('leaflet').then(({default:L}) => {
      if (!active || !baselineMapNode.current || !futureMapNode.current) return;
      try {
        const nodes = [baselineMapNode.current, futureMapNode.current];
        const created = nodes.map((node, index) => {
          const map = L.map(node, {zoomControl:false, attributionControl:true, preferCanvas:true}).setView([site.lat,site.lng],12);
          L.control.zoom({position:'bottomleft'}).addTo(map);
          map.createPane('offlineMap');
          const offlinePane=map.getPane('offlineMap');
          if(offlinePane)offlinePane.style.zIndex='250';
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
          tiles.on('tileloadstart',(event:any)=>{event.tile.style.setProperty('max-width','none','important');event.tile.style.setProperty('max-height','none','important')});
          tiles.on('tileerror', () => active && setMapError(true));
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

  const reduction = air && futurePm25 != null && air.pm25 > 0 ? Math.max(0, (1 - futurePm25 / air.pm25) * 100) : null;

  return <main className="experience">
    <aside className="rail" aria-label="Primary navigation">
      <button className="monogram" onClick={() => setView('home')} aria-label="Moss and algae home">
        <img src="/biofilter-emblem.png" alt="Moss and algae biofilter emblem"/>
      </button>
      <nav>
        <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}><Home size={18}/><span>HOME</span></button>
        <button className={view === 'twin' ? 'active' : ''} onClick={() => setView('twin')}><FlaskConical size={18}/><span>DIG TWIN</span></button>
        <button className={view === 'analysis' ? 'active' : ''} onClick={() => setView('analysis')}><BarChart3 size={18}/><span>ANALYSIS</span></button>
        <button className={view === 'locations' ? 'active' : ''} onClick={() => setView('locations')}><MapPinned size={18}/><span>LOCATIONS</span></button>
      </nav>
      <div className="rail-index">01<br/><span>INDIA</span></div>
    </aside>

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
        <button className="enter-twin" onClick={() => setView('twin')}>EXPLORE THE FUTURE AIR <ArrowDown size={16}/></button>
      </div>
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
          <div className="map-heading"><div><span>01 / PRESENT</span><h2>Without moss</h2></div><div className="reading"><small>PM2.5</small><strong>{air ? air.pm25.toFixed(1) : '—'}</strong><em>µg/m³</em></div></div>
          <div className="map-stage"><img className={`map-fallback ${mapBasesReady[0]?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={baselineMapNode} className={`map ${mapsReady[0] ? 'ready' : ''}`} aria-label="Interactive baseline map"/><div className="map-label"><Activity size={18}/> BASELINE AIR</div>{mapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}<div className="fallback-attribution">© OpenStreetMap contributors</div></div>
          <div className="data-strip gas-strip"><Data label="AIR QUALITY INDEX" value={air ? String(Math.round(air.aqi)) : '—'} detail="US AQI · modeled source"/><Data label="PM10" value={air ? air.pm10.toFixed(1) : '—'} detail="µg/m³"/><Data label="NO₂" value={air ? air.no2.toFixed(1) : '—'} detail="µg/m³"/><Data label="CO" value={air ? air.co.toFixed(0) : '—'} detail="µg/m³ · atmospheric dataset"/><Data label="CO₂" value="SENSOR" detail="Pod NDIR reading required"/></div>
        </article>
        <article className="map-card future-card">
          <div className="map-heading"><div><span>02 / FUTURE</span><h2>With moss + algae</h2></div><div className="reading future-reading"><small>MODELED PM2.5</small><strong>{futurePm25 != null ? futurePm25.toFixed(1) : '—'}</strong><em>µg/m³</em></div></div>
          <div className="map-stage"><img className={`map-fallback ${mapBasesReady[1]?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={futureMapNode} className={`map ${mapsReady[1] ? 'ready' : ''}`} aria-label="Interactive future map"/><div className="future-wash"/><div className="map-label"><Wind size={18}/> PROJECTED AIR · SYNCED</div><div className="delta">{reduction != null ? `−${reduction.toFixed(1)}%` : '—'}<small>MODELED CHANGE</small></div>{mapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}<div className="fallback-attribution">© OpenStreetMap contributors</div></div>
          <div className="data-strip controls">
            <label>UNITS <strong>{units}</strong><input type="range" min="1" max="100" value={units} onChange={e => setUnits(Number(e.target.value))}/></label>
            <label>MOSS EFF. <strong>{efficiency}%</strong><input type="range" min="5" max="85" value={efficiency} onChange={e => setEfficiency(Number(e.target.value))}/></label>
            <label>ALGAE EFF. <strong>{algaeEfficiency}%</strong><input type="range" min="1" max="70" value={algaeEfficiency} onChange={e => setAlgaeEfficiency(Number(e.target.value))}/></label>
            <label>HORIZON <strong>{hours}h</strong><input type="range" min="1" max="24" value={hours} onChange={e => setHours(Number(e.target.value))}/></label>
          </div>
        </article>
      </div>
      <footer className="model-note"><span>MODEL 0.2 / TWO-STAGE</span><p>The future view models moss followed by algae in series. Combined efficiency is 1 − (1 − moss efficiency) × (1 − algae efficiency), preventing double-counting. Both efficiencies require pollutant-specific measurement and field calibration.</p><span>{air?.time ? `DATA ${air.time.replace('T', ' ')}` : 'AWAITING DATA'}</span></footer>
    </section> : view === 'analysis' ? <Analysis air={air} loading={loading} error={error} units={units} setUnits={setUnits} efficiency={efficiency} setEfficiency={setEfficiency} algaeEfficiency={algaeEfficiency} setAlgaeEfficiency={setAlgaeEfficiency} hours={hours} setHours={setHours}/> : <Locations totalUnits={units} setTotalUnits={setUnits} mossEfficiency={efficiency} algaeEfficiency={algaeEfficiency} hours={hours}/>}
  </main>;
}

function Data({label, value, detail}:{label:string; value:string; detail:string}) {return <div className="data"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>}

function allocateUnits(sites:Array<CandidateSite & Air>, total:number):NetworkSite[] {
  const ranked = [...sites].sort((a,b) => b.aqi - a.aqi || b.pm25 - a.pm25);
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
  const [readings,setReadings] = useState<Array<CandidateSite & Air>>([]);
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
    const results = await Promise.all(CANDIDATE_SITES.map(async site => {
      try {
        const response=await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${site.lat}&longitude=${site.lng}&current=pm2_5,pm10,nitrogen_dioxide,carbon_monoxide,us_aqi&timezone=auto`);
        if(!response.ok) return null;
        const data=await response.json();
        return {...site,pm25:Number(data.current?.pm2_5),pm10:Number(data.current?.pm10),no2:Number(data.current?.nitrogen_dioxide),co:Number(data.current?.carbon_monoxide),aqi:Number(data.current?.us_aqi),time:String(data.current?.time??'')};
      } catch {return null}
    }));
    const valid=results.filter((site):site is CandidateSite & Air => Boolean(site&&Number.isFinite(site.pm25)&&Number.isFinite(site.co)&&Number.isFinite(site.aqi)));
    setReadings(valid);setLoading(false);
    if(!valid.length)setError('No candidate air-quality readings are currently available.');
    else setSelectedId(current => valid.some(site=>site.id===current)?current:valid[0].id);
  },[]);
  useEffect(()=>{refresh()},[refresh]);
  const network=useMemo(()=>allocateUnits(readings,totalUnits),[readings,totalUnits]);
  useEffect(()=>{
    if(!locationsMapNode.current||locationsMap.current)return;
    let active=true;
    let resizeObserver:ResizeObserver|null=null;
    import('leaflet').then(({default:L})=>{
      if(!active||!locationsMapNode.current)return;
      try {
        const map=L.map(locationsMapNode.current,{zoomControl:false,attributionControl:true,preferCanvas:true});
        L.control.zoom({position:'bottomleft'}).addTo(map);
        map.createPane('offlineMap');
        const offlinePane=map.getPane('offlineMap');
        if(offlinePane)offlinePane.style.zIndex='250';
        const offlineMap=L.imageOverlay('/bengaluru-map.webp',[[12.811801316582617,77.431640625],[13.06877673435769,77.6953125]],{pane:'offlineMap',interactive:false});
        offlineMap.on('load',()=>{
          const image=offlineMap.getElement();
          image?.style.setProperty('max-width','none','important');
          image?.style.setProperty('max-height','none','important');
          if(active)setLocationsBaseReady(true);
        });
        offlineMap.addTo(map);
        const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
        tiles.on('tileloadstart',(event:any)=>{event.tile.style.setProperty('max-width','none','important');event.tile.style.setProperty('max-height','none','important')});
        tiles.on('tileerror',()=>active&&setLocationsMapError(true));
        map.fitBounds(CANDIDATE_SITES.map(point=>[point.lat,point.lng] as [number,number]),{padding:[42,42],maxZoom:12});
        locationsLeaflet.current=L;
        locationsMap.current=map;
        locationMarkerLayer.current=L.layerGroup().addTo(map);
        resizeObserver=new ResizeObserver(()=>map.invalidateSize({pan:false}));
        resizeObserver.observe(locationsMapNode.current);
        setLocationsMapReady(true);
        requestAnimationFrame(()=>map.invalidateSize());
      } catch {setLocationsMapError(true)}
    }).catch(()=>setLocationsMapError(true));
    return()=>{
      active=false;
      resizeObserver?.disconnect();
      locationsMap.current?.remove();
      locationsMap.current=null;
      locationsLeaflet.current=null;
      locationMarkerLayer.current=null;
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
  const logSite=network.find(site=>site.id===logSiteId);
  const podLogs=logSite?Array.from({length:logSite.assigned},(_,index)=>({id:`${logSite.id.slice(0,3).toUpperCase()}-${String(index+1).padStart(3,'0')}`,status:co2Readings[logSite.id]!=null?'Telemetry linked':'Awaiting sensor'})):[];
  const combinedEfficiency=combinedStageEfficiency(mossEfficiency/100,algaeEfficiency/100);
  const selectedCadr=selected?500*combinedEfficiency*selected.assigned:0;
  const projected=selected?modelLocally(selected.pm25,selected.pm25,12000,selectedCadr,250000,hours):null;
  const reduction=selected&&projected!=null&&selected.pm25>0?(1-projected/selected.pm25)*100:null;
  return <section className="locations-view">
    <header className="locations-header"><div><p className="kicker">POD NETWORK / SUGGESTED DEPLOYMENT</p><h1>Place units where the current signal is highest.</h1><p>Candidate areas are ranked by current US AQI, then PM2.5. The allocation is a planning recommendation—not a record of installed plants.</p></div><button onClick={refresh} disabled={loading}>{loading?<LoaderCircle className="spin"/>:<Radio/>}{loading?'Reading network…':'Refresh air data'}</button></header>
    <div className="network-summary"><label><span>TOTAL PODS TO ALLOCATE</span><strong>{totalUnits} / 100</strong><input type="range" min="1" max="100" value={totalUnits} onChange={event=>setTotalUnits(Number(event.target.value))}/></label><div><span>AREAS WITH PODS</span><strong>{network.filter(site=>site.assigned>0).length}</strong><small>One map anchor per allocated area</small></div><div><span>COMBINED MEDIA EFFICIENCY</span><strong>{(combinedEfficiency*100).toFixed(1)}%</strong><small>Moss {mossEfficiency}% → algae {algaeEfficiency}%</small></div><div><span>ALLOCATION RULE</span><strong>AQI priority</strong><small>Count badges update with the total</small></div></div>
    {error&&<div className="network-error">{error}</div>}
    <div className="locations-grid">
      <article className="network-panel"><div className="panel-heading"><div><span>OPENSTREETMAP / AREA ALLOCATION</span><h2>Area-specific pod anchors</h2></div><p>Each anchor represents one area; its badge is the number of pods allocated there.</p></div><div className="locations-map"><img className={`locations-map-fallback ${locationsBaseReady?'hidden':''}`} src="/bengaluru-map.webp" alt="Street map of Bengaluru"/><div ref={locationsMapNode} className={`locations-leaflet ${locationsMapReady?'ready':''}`} aria-label="OpenStreetMap showing area pod allocations"/>{locationsMapError&&<div className="map-status">Live tiles unavailable · local Bengaluru map active</div>}{logSite&&<aside className="pod-log-popover" role="dialog" aria-label={`${logSite.name} pod log`}><button className="pod-log-close" onClick={()=>setLogSiteId(null)} aria-label="Close pod log"><X size={18}/></button><span>AREA POD LOG</span><h3>{logSite.name}</h3><p>{logSite.assigned} allocated pods · area AQI {Math.round(logSite.aqi)}</p><div className="pod-log-list">{podLogs.map((pod,index)=><div className="pod-log-row" key={pod.id}><b>{pod.id}</b><span>{pod.status}</span><small>CO {logSite.co.toFixed(0)} µg/m³ area feed</small><small>{co2Readings[logSite.id]!=null?`CO₂ ${co2Readings[logSite.id]} ppm area sensor`:'CO₂ sensor pending'}</small><em>Allocation log {String(index+1).padStart(2,'0')}</em></div>)}</div></aside>}<div className="map-anchor-key"><i/><span>Area anchor · number indicates allocated pods</span></div></div><p className="network-boundary">The map intentionally uses one anchor per area. Click an anchor to inspect every pod allocated to that region; individual pods are listed in the log instead of cluttering the map.</p></article>
      <article className="station-detail">{selected?<>
        <div className="station-rank"><span>PRIORITY {String(selected.rank).padStart(2,'0')}</span><strong>{selected.name}</strong><small>{selected.context}</small></div>
        <div className="station-kpis"><div><span>CURRENT AQI</span><strong>{Math.round(selected.aqi)}</strong><small>US AQI · modeled source</small></div><div><span>ASSIGNED PODS</span><strong>{selected.assigned}</strong><small>of {totalUnits} total</small></div><div><span>PM2.5 NOW</span><strong>{selected.pm25.toFixed(1)}</strong><small>µg/m³</small></div><div><span>MODELED PM2.5</span><strong>{projected?.toFixed(1)??'—'}</strong><small>after {hours} hours</small></div></div>
        <div className="gas-panel"><div><span>CARBON MONOXIDE / CO</span><strong>{selected.co.toFixed(0)} <small>µg/m³</small></strong><em>Live atmospheric dataset</em></div><label><span>CARBON DIOXIDE / CO₂</span><div><input type="number" min="300" max="10000" step="1" value={co2Readings[selected.id]??''} placeholder="Connect sensor" onChange={event=>recordCo2(selected.id,event.target.value)} aria-label={`CO2 sensor reading for ${selected.name}`}/><b>ppm</b></div><em>{co2Readings[selected.id]!=null?'Pod sensor reading saved locally':'Requires an NDIR sensor at this pod'}</em></label></div>
        <div className="efficiency-ring" style={{'--ring':`${Math.max(0,Math.min(100,reduction??0))}%`} as React.CSSProperties}><div><strong>{reduction!=null?`−${reduction.toFixed(1)}%`:'—'}</strong><span>local modeled change</span></div></div><div className="station-notes"><p><CheckCircle2/><span><strong>Why suggested</strong>Ranked from the current AQI/PM2.5 snapshot among the listed candidate areas.</span></p><p><Activity/><span><strong>Gas telemetry</strong>CO is supplied by Open-Meteo. CO₂ is stored only when an on-site NDIR sensor reading is entered; it is never inferred from AQI.</span></p><p><ShieldCheck/><span><strong>Health boundary</strong>No individual health outcome, dose, exposure reduction or clinical benefit is estimated.</span></p></div><div className="station-time">DATA {selected.time.replace('T',' ')} · OPEN-METEO AIR QUALITY</div>
      </>:<ChartEmpty/>}</article>
    </div>
    <div className="location-table"><div className="location-row header"><span>RANK / AREA</span><span>AQI</span><span>PM2.5</span><span>CO</span><span>CO₂</span><span>PODS</span><span>MODEL ROLE</span></div>{network.map(site=><button className={`location-row ${site.id===selected?.id?'active':''}`} key={site.id} onClick={()=>setSelectedId(site.id)}><span><b>{String(site.rank).padStart(2,'0')}</b><strong>{site.name}</strong><small>{site.context}</small></span><span>{Math.round(site.aqi)}</span><span>{site.pm25.toFixed(1)} µg/m³</span><span>{site.co.toFixed(0)} µg/m³</span><span>{co2Readings[site.id]!=null?`${co2Readings[site.id]} ppm`:'Sensor needed'}</span><span>{site.assigned}</span><span>{site.rank<=3?'Priority cluster':'Coverage node'}</span></button>)}</div>
    <footer className="analysis-disclaimer"><strong>RECOMMENDATION LIMIT</strong><p>Ranking a short candidate list by a current modeled snapshot is not a deployment study. Final siting requires verified monitoring data, pedestrian exposure patterns, wind and street geometry, power, access, pressure drop, maintenance capacity, land permission and field validation.</p></footer>
  </section>;
}

function Analysis({air, loading, error, units, setUnits, efficiency, setEfficiency, algaeEfficiency, setAlgaeEfficiency, hours, setHours}:{
  air:Air|null; loading:boolean; error:string; units:number; setUnits:(value:number)=>void; efficiency:number; setEfficiency:(value:number)=>void; algaeEfficiency:number; setAlgaeEfficiency:(value:number)=>void; hours:number; setHours:(value:number)=>void;
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
  const end = trend.at(-1);
  const reduction = end && air && air.pm25 > 0 ? (1 - end.combined / air.pm25) * 100 : null;
  const algaeImprovement = end?.mossOnly ? (1 - end.combined / end.mossOnly) * 100 : null;
  const algaeMassShare = end?.totalCaptured ? end.algaeCaptured / end.totalCaptured * 100 : null;
  const scenarios = useMemo(() => {
    if (!air) return [];
    return [Math.max(1, Math.round(units / 2)), units, Math.min(100, units * 2)].map(count => {
      const scenarioCadr = airflowPerUnit * combinedEfficiency * count;
      const concentration = modelLocally(air.pm25, air.pm25, ventilation, scenarioCadr, volume, hours);
      return {units:count, concentration:Number(concentration.toFixed(2)), reduction:Number(((1 - concentration / air.pm25) * 100).toFixed(2))};
    });
  }, [air, units, combinedEfficiency, hours]);

  return <section className="analysis-view">
    <header className="analysis-header">
      <div><p className="kicker">MOSS + ALGAE / TWO-STAGE BIOFILTRATION</p><h1>Measure each stage. See the combined result.</h1><p>Compare moss alone with an algae polishing stage, then inspect the incremental concentration and particle-mass contribution without double-counting.</p></div>
      <div className="analysis-status">{loading ? <><LoaderCircle className="spin" size={18}/> Loading baseline</> : error ? <span className="warn">{error}</span> : <><span className="live-dot"/> Baseline {air?.pm25.toFixed(1) ?? '—'} µg/m³</>}</div>
    </header>

    <div className="bio-process" aria-label="Two-stage biofiltration process"><div><span>STAGE 01</span><strong>Moss matrix</strong><small>Captures a measured fraction of inlet PM2.5</small></div><i>→</i><div className="algae-stage"><span>STAGE 02</span><strong>Microalgae polishing</strong><small>Treats only the fraction remaining after moss</small></div><i>→</i><div><span>COMBINED</span><strong>{(combinedEfficiency * 100).toFixed(1)}% efficiency</strong><small>Series equation; not a sum of efficiencies</small></div></div>

    <div className="analysis-controls five" aria-label="Model assumptions">
      <label><span>MOSS UNITS</span><strong>{units}</strong><input type="range" min="1" max="100" value={units} onChange={event => setUnits(Number(event.target.value))}/></label>
      <label><span>MEASURED MOSS EFFICIENCY</span><strong>{efficiency}%</strong><input type="range" min="5" max="85" value={efficiency} onChange={event => setEfficiency(Number(event.target.value))}/></label>
      <label><span>MEASURED ALGAE EFFICIENCY</span><strong>{algaeEfficiency}%</strong><input type="range" min="1" max="70" value={algaeEfficiency} onChange={event => setAlgaeEfficiency(Number(event.target.value))}/></label>
      <label><span>ANALYSIS HORIZON</span><strong>{hours} hours</strong><input type="range" min="1" max="24" value={hours} onChange={event => setHours(Number(event.target.value))}/></label>
      <div className="assumption"><span>COMBINED CLEAN-AIR DELIVERY</span><strong>{cadr.toLocaleString(undefined,{maximumFractionDigits:0})} m³/h</strong><small>Moss {mossCadr.toFixed(0)} + algae increment {algaeIncrementalCadr.toFixed(0)} m³/h</small></div>
    </div>

    <div className="analysis-metrics">
      <AnalysisMetric label="COMBINED PM2.5 AT HORIZON" value={end ? `${end.combined.toFixed(1)} µg/m³` : 'Awaiting data'} detail="Moss followed by algae"/>
      <AnalysisMetric label="RELATIVE CONCENTRATION CHANGE" value={reduction != null ? `−${Math.max(0,reduction).toFixed(1)}%` : 'Awaiting data'} detail="Not an AQI or health-effect estimate"/>
      <AnalysisMetric label="ALGAE INCREMENT" value={algaeImprovement != null ? `−${Math.max(0,algaeImprovement).toFixed(1)}%` : 'Awaiting data'} detail="Additional change versus moss-only"/>
      <AnalysisMetric label="ALGAE MASS CONTRIBUTION" value={end ? `${end.algaeCaptured.toFixed(3)} g` : 'Awaiting data'} detail={algaeMassShare != null ? `${algaeMassShare.toFixed(1)}% of combined captured mass` : `Integrated over ${hours} hours`}/>
    </div>

    <div className="chart-grid">
      <article className="chart-card concentration-chart">
        <div className="chart-title"><div><span>01 / CONCENTRATION TREND</span><h2>Baseline → moss → moss + algae</h2></div><p>Hover or tap to isolate algae’s incremental effect.</p></div>
        <div className="chart-frame">{trend.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={trend} margin={{top:15,right:20,left:5,bottom:5}}><CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="time" tickFormatter={value => `${value}h`} stroke="#73806f"/><YAxis unit=" µg/m³" domain={['dataMin - 2','dataMax + 2']} stroke="#73806f"/><Tooltip content={<ModelTooltip/>}/><Legend/><Line type="monotone" dataKey="baseline" name="Without biofilter" stroke="#9b735d" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="mossOnly" name="Moss only" stroke="#66894d" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="combined" name="Moss + algae" stroke="#16858c" strokeWidth={4} dot={false} activeDot={{r:7}}/></LineChart></ResponsiveContainer> : <ChartEmpty/>}</div>
      </article>

      <article className="chart-card capture-chart">
        <div className="chart-title"><div><span>02 / CAPTURE TREND</span><h2>Captured mass by biological stage</h2></div><p>Stacked values show moss and algae separately.</p></div>
        <div className="chart-frame">{trend.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={trend} margin={{top:15,right:22,left:5,bottom:5}}><defs><linearGradient id="mossFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#78984f" stopOpacity={.75}/><stop offset="100%" stopColor="#78984f" stopOpacity={.16}/></linearGradient><linearGradient id="algaeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1e9aa2" stopOpacity={.72}/><stop offset="100%" stopColor="#1e9aa2" stopOpacity={.14}/></linearGradient></defs><CartesianGrid stroke="#dfe5d7" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="time" tickFormatter={value => `${value}h`} stroke="#73806f"/><YAxis unit=" g" stroke="#73806f"/><Tooltip content={<CaptureTooltip/>}/><Legend/><Area stackId="capture" type="monotone" dataKey="mossCaptured" name="Moss capture" stroke="#58763e" strokeWidth={3} fill="url(#mossFill)"/><Area stackId="capture" type="monotone" dataKey="algaeCaptured" name="Algae capture" stroke="#147b81" strokeWidth={3} fill="url(#algaeFill)"/></AreaChart></ResponsiveContainer> : <ChartEmpty/>}</div>
      </article>
    </div>

    <div className="analysis-bottom">
      <article className="scenario-card"><div className="chart-title"><div><span>03 / SCALE SENSITIVITY</span><h2>What changes when unit count changes?</h2></div></div><div className="scenario-bars">{scenarios.map((scenario,index) => <div className={index === 1 ? 'selected' : ''} key={`${scenario.units}-${index}`}><span>{scenario.units} units</span><div className="bar-track"><i style={{width:`${Math.min(100, scenario.reduction * 4)}%`}}/></div><strong>−{scenario.reduction.toFixed(1)}%</strong><small>{scenario.concentration.toFixed(1)} µg/m³</small></div>)}</div></article>
      <article className="urban-card"><span className="urban-tag">URBAN RELEVANCE</span><h2>A compact living two-stage unit</h2><div className="urban-points"><div><CheckCircle2/><p><strong>Moss pre-filtration</strong>The first stage captures a measured pollutant fraction while providing a high-surface-area biological matrix.</p></div><div><CheckCircle2/><p><strong>Algae polishing</strong>The second stage treats only what remains, making its incremental contribution measurable instead of simply adding two efficiency claims.</p></div><div><ShieldCheck/><p><strong>Evidence boundary</strong>The model covers PM2.5 mass balance. Algal CO₂ uptake, oxygen production, biomass yield and health benefit require separate measured inputs and are not claimed here.</p></div></div></article>
    </div>
    <footer className="analysis-disclaimer"><strong>INTERPRETATION</strong><p>The algae increment is the difference between the moss-only and two-stage model under identical airflow, volume and time assumptions. Real performance requires pollutant-specific tests for each medium, pressure-drop and airflow measurements, maintenance data and field calibration. Trees provide shade, cooling, habitat and stormwater services that this unit does not reproduce.</p></footer>
  </section>;
}

function AnalysisMetric({label,value,detail}:{label:string;value:string;detail:string}) {return <div className="analysis-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>}
function ChartEmpty() {return <div className="chart-empty"><Activity size={28}/><strong>Waiting for current air data</strong><span>The graph will appear when the baseline source responds.</span></div>}
function ModelTooltip({active,payload,label}:any) {if (!active || !payload?.length) return null; return <div className="model-tooltip"><strong>{label} hours</strong><span>Without biofilter: {payload[0]?.value} µg/m³</span><span>Moss only: {payload[1]?.value} µg/m³</span><span>Moss + algae: {payload[2]?.value} µg/m³</span></div>}
function CaptureTooltip({active,payload,label}:any) {if (!active || !payload?.length) return null; return <div className="model-tooltip"><strong>{label} hours</strong><span>Moss: {Number(payload[0]?.value).toFixed(4)} g</span><span>Algae: {Number(payload[1]?.value).toFixed(4)} g</span><span>Total: {(Number(payload[0]?.value) + Number(payload[1]?.value)).toFixed(4)} g</span></div>}
