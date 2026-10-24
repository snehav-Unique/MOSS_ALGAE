'use client';

import {FormEvent, useEffect, useMemo, useState} from 'react';
import {Briefcase, Clock, Crosshair, HeartPulse, LoaderCircle, MapPin, Send, Users} from 'lucide-react';
import {API, Air, CANDIDATE_SITES, HourlyPoint, NAAQS_PM25_24H, WHO_PM25_24H, fetchCurrentAir, fetchHourlyAir} from '../../lib/air';
import {useLeafletMap} from '../../components/use-leaflet-map';

type Lang = 'en'|'kn'|'hi';
type Band = 'good'|'moderate'|'poor'|'severe';
const LOCALE:Record<Lang,string> = {en:'en-IN', kn:'kn-IN', hi:'hi-IN'};

const T = {
  title:{en:'Air near you', kn:'ನಿಮ್ಮ ಸುತ್ತಲಿನ ಗಾಳಿ', hi:'आपके आस-पास की हवा'},
  subtitle:{en:'PM2.5 now, simple advice, and the best time to step out.', kn:'ಈಗಿನ PM2.5, ಸರಳ ಸಲಹೆ ಮತ್ತು ಹೊರಗೆ ಹೋಗಲು ಉತ್ತಮ ಸಮಯ.', hi:'अभी का PM2.5, आसान सलाह और बाहर निकलने का सबसे अच्छा समय।'},
  useLocation:{en:'Use my location', kn:'ನನ್ನ ಸ್ಥಳ ಬಳಸಿ', hi:'मेरी लोकेशन इस्तेमाल करें'},
  orPick:{en:'or pick an area', kn:'ಅಥವಾ ಪ್ರದೇಶ ಆಯ್ಕೆಮಾಡಿ', hi:'या इलाका चुनें'},
  myLocation:{en:'My location', kn:'ನನ್ನ ಸ್ಥಳ', hi:'मेरी लोकेशन'},
  locating:{en:'Finding you…', kn:'ನಿಮ್ಮ ಸ್ಥಳ ಹುಡುಕಲಾಗುತ್ತಿದೆ…', hi:'आपकी लोकेशन ढूंढ रहे हैं…'},
  locationDenied:{en:'Location unavailable — pick an area instead.', kn:'ಸ್ಥಳ ಲಭ್ಯವಿಲ್ಲ — ಬದಲಿಗೆ ಪ್ರದೇಶ ಆಯ್ಕೆಮಾಡಿ.', hi:'लोकेशन उपलब्ध नहीं — कोई इलाका चुनें।'},
  pm25Now:{en:'PM2.5 now', kn:'ಈಗಿನ PM2.5', hi:'अभी PM2.5'},
  modeled:{en:'Model estimate · Open-Meteo', kn:'ಮಾದರಿ ಅಂದಾಜು · Open-Meteo', hi:'मॉडल आधारित अनुमान · Open-Meteo'},
  loading:{en:'Reading the air…', kn:'ಗಾಳಿಯ ಮಾಹಿತಿ ಪಡೆಯಲಾಗುತ್ತಿದೆ…', hi:'हवा की जानकारी ली जा रही है…'},
  unavailable:{en:'Air data unavailable right now.', kn:'ಗಾಳಿಯ ಮಾಹಿತಿ ಈಗ ಲಭ್ಯವಿಲ್ಲ.', hi:'हवा की जानकारी अभी उपलब्ध नहीं।'},
  everyone:{en:'Everyone', kn:'ಎಲ್ಲರಿಗೂ', hi:'सभी के लिए'},
  sensitive:{en:'Children, elderly, asthma & heart patients', kn:'ಮಕ್ಕಳು, ಹಿರಿಯರು, ಅಸ್ತಮಾ ಮತ್ತು ಹೃದ್ರೋಗಿಗಳು', hi:'बच्चे, बुज़ुर्ग, अस्थमा व हृदय रोगी'},
  workers:{en:'Outdoor workers', kn:'ಹೊರಾಂಗಣ ಕಾರ್ಮಿಕರು', hi:'बाहर काम करने वाले'},
  bestTime:{en:'Cleanest 2 hours in the next day', kn:'ಮುಂದಿನ 24 ಗಂಟೆಗಳಲ್ಲಿ ಅತ್ಯಂತ ಸ್ವಚ್ಛ 2 ಗಂಟೆ', hi:'अगले 24 घंटों में सबसे साफ़ 2 घंटे'},
  worstTime:{en:'Most polluted hour', kn:'ಅತಿ ಹೆಚ್ಚು ಮಾಲಿನ್ಯದ ಗಂಟೆ', hi:'सबसे प्रदूषित घंटा'},
  nearestPod:{en:'Nearest proposed pod area', kn:'ಹತ್ತಿರದ ಪ್ರಸ್ತಾವಿತ ಪಾಡ್ ಪ್ರದೇಶ', hi:'निकटतम प्रस्तावित पॉड क्षेत्र'},
  kmAway:{en:'km away', kn:'ಕಿ.ಮೀ ದೂರ', hi:'किमी दूर'},
  proposalNote:{en:'Planning proposal, not an installed unit.', kn:'ಯೋಜನಾ ಪ್ರಸ್ತಾವನೆ, ಸ್ಥಾಪಿತ ಘಟಕವಲ್ಲ.', hi:'योजना प्रस्ताव, स्थापित यूनिट नहीं।'},
  suggestTitle:{en:'Suggest a pod location', kn:'ಪಾಡ್ ಸ್ಥಳ ಸೂಚಿಸಿ', hi:'पॉड के लिए जगह सुझाएं'},
  suggestHelp:{en:'We use your selected location. Tell us why this spot needs cleaner air.', kn:'ನೀವು ಆಯ್ಕೆ ಮಾಡಿದ ಸ್ಥಳವನ್ನು ಬಳಸುತ್ತೇವೆ. ಈ ಜಾಗಕ್ಕೆ ಶುದ್ಧ ಗಾಳಿ ಏಕೆ ಬೇಕು ಎಂದು ತಿಳಿಸಿ.', hi:'हम आपकी चुनी हुई जगह का उपयोग करेंगे। बताइए इस जगह को साफ़ हवा की ज़रूरत क्यों है।'},
  suggestPlaceholder:{en:'e.g. School gate next to a busy junction', kn:'ಉದಾ: ಜನನಿಬಿಡ ಜಂಕ್ಷನ್ ಪಕ್ಕದ ಶಾಲಾ ಗೇಟ್', hi:'जैसे: व्यस्त चौराहे के पास स्कूल का गेट'},
  send:{en:'Send suggestion', kn:'ಸಲಹೆ ಕಳುಹಿಸಿ', hi:'सुझाव भेजें'},
  thanks:{en:'Thank you — planners will see your suggestion on the map.', kn:'ಧನ್ಯವಾದಗಳು — ಯೋಜಕರು ನಿಮ್ಮ ಸಲಹೆಯನ್ನು ನಕ್ಷೆಯಲ್ಲಿ ನೋಡುತ್ತಾರೆ.', hi:'धन्यवाद — योजनाकार आपका सुझाव नक्शे पर देखेंगे।'},
  sendFailed:{en:'Could not send right now. Please try again.', kn:'ಈಗ ಕಳುಹಿಸಲು ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.', hi:'अभी भेजा नहीं जा सका। कृपया फिर से कोशिश करें।'},
  disclaimer:{en:'General guidance, not medical advice. Values are model estimates and can differ from street level.', kn:'ಸಾಮಾನ್ಯ ಮಾರ್ಗದರ್ಶನ, ವೈದ್ಯಕೀಯ ಸಲಹೆಯಲ್ಲ. ಮೌಲ್ಯಗಳು ಮಾದರಿ ಅಂದಾಜುಗಳು; ರಸ್ತೆ ಮಟ್ಟದಲ್ಲಿ ಬದಲಾಗಬಹುದು.', hi:'सामान्य जानकारी, चिकित्सा सलाह नहीं। मान मॉडल अनुमान हैं और सड़क स्तर पर अलग हो सकते हैं।'},
  dashboard:{en:'Planner dashboard', kn:'ಯೋಜಕರ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್', hi:'योजनाकार डैशबोर्ड'},
};

const BAND_LABEL:Record<Band,Record<Lang,string>> = {
  good:{en:'Within WHO guideline', kn:'WHO ಮಾರ್ಗಸೂಚಿಯೊಳಗೆ', hi:'WHO दिशानिर्देश के भीतर'},
  moderate:{en:'Above WHO, within India’s standard', kn:'WHO ಮಿತಿಗಿಂತ ಹೆಚ್ಚು, ಭಾರತದ ಮಾನದಂಡದೊಳಗೆ', hi:'WHO सीमा से ऊपर, भारतीय मानक के भीतर'},
  poor:{en:'Above India’s standard', kn:'ಭಾರತದ ಮಾನದಂಡಕ್ಕಿಂತ ಹೆಚ್ಚು', hi:'भारतीय मानक से ऊपर'},
  severe:{en:'Severe', kn:'ತೀವ್ರ', hi:'गंभीर'},
};

// [everyone, sensitive groups, outdoor workers]
const ADVICE:Record<Band,Record<Lang,[string,string,string]>> = {
  good:{
    en:['Good time for outdoor activity.', 'Go about your day normally.', 'No special precautions needed.'],
    kn:['ಹೊರಾಂಗಣ ಚಟುವಟಿಕೆಗೆ ಒಳ್ಳೆಯ ಸಮಯ.', 'ದಿನಚರಿಯನ್ನು ಸಾಮಾನ್ಯವಾಗಿ ಮುಂದುವರಿಸಿ.', 'ವಿಶೇಷ ಮುನ್ನೆಚ್ಚರಿಕೆ ಅಗತ್ಯವಿಲ್ಲ.'],
    hi:['बाहर की गतिविधियों के लिए अच्छा समय।', 'अपना दिन सामान्य रूप से बिताएं।', 'किसी विशेष सावधानी की ज़रूरत नहीं।'],
  },
  moderate:{
    en:['Most people can be active outdoors.', 'Take breaks during long or intense outdoor exercise.', 'Take short breaks away from heavy traffic.'],
    kn:['ಹೆಚ್ಚಿನವರು ಹೊರಾಂಗಣದಲ್ಲಿ ಚಟುವಟಿಕೆಯಿಂದಿರಬಹುದು.', 'ದೀರ್ಘ ಅಥವಾ ಕಠಿಣ ಹೊರಾಂಗಣ ವ್ಯಾಯಾಮದ ನಡುವೆ ವಿರಾಮ ತೆಗೆದುಕೊಳ್ಳಿ.', 'ಭಾರಿ ಸಂಚಾರದಿಂದ ದೂರ ಸಣ್ಣ ವಿರಾಮ ತೆಗೆದುಕೊಳ್ಳಿ.'],
    hi:['ज़्यादातर लोग बाहर सक्रिय रह सकते हैं।', 'लंबे या भारी व्यायाम के बीच आराम करें।', 'भारी ट्रैफ़िक से दूर थोड़ी-थोड़ी देर आराम करें।'],
  },
  poor:{
    en:['Reduce long or intense outdoor exertion.', 'Avoid strenuous outdoor activity; keep prescribed medicines handy.', 'A well-fitted N95 mask helps; rest away from traffic.'],
    kn:['ದೀರ್ಘ ಅಥವಾ ಕಠಿಣ ಹೊರಾಂಗಣ ಶ್ರಮ ಕಡಿಮೆ ಮಾಡಿ.', 'ಕಠಿಣ ಹೊರಾಂಗಣ ಚಟುವಟಿಕೆ ತಪ್ಪಿಸಿ; ವೈದ್ಯರು ಸೂಚಿಸಿದ ಔಷಧಿ ಕೈಯಲ್ಲಿಡಿ.', 'ಸರಿಯಾಗಿ ಹೊಂದುವ N95 ಮಾಸ್ಕ್ ಸಹಾಯಕ; ಸಂಚಾರದಿಂದ ದೂರ ವಿಶ್ರಾಂತಿ ಪಡೆಯಿರಿ.'],
    hi:['लंबी या भारी बाहरी मेहनत कम करें।', 'बाहर भारी गतिविधि से बचें; डॉक्टर की बताई दवाएं पास रखें।', 'ठीक से फिट N95 मास्क मदद करता है; ट्रैफ़िक से दूर आराम करें।'],
  },
  severe:{
    en:['Avoid outdoor exertion; keep windows closed during peak hours.', 'Stay indoors as much as possible; seek medical help if symptoms worsen.', 'Wear an N95 mask and shorten time outdoors where possible.'],
    kn:['ಹೊರಾಂಗಣ ಶ್ರಮ ತಪ್ಪಿಸಿ; ಗರಿಷ್ಠ ಸಮಯದಲ್ಲಿ ಕಿಟಕಿ ಮುಚ್ಚಿಡಿ.', 'ಸಾಧ್ಯವಾದಷ್ಟು ಒಳಗೇ ಇರಿ; ಲಕ್ಷಣಗಳು ಹೆಚ್ಚಾದರೆ ವೈದ್ಯಕೀಯ ಸಹಾಯ ಪಡೆಯಿರಿ.', 'N95 ಮಾಸ್ಕ್ ಧರಿಸಿ ಮತ್ತು ಸಾಧ್ಯವಾದಲ್ಲಿ ಹೊರಗಿರುವ ಸಮಯ ಕಡಿಮೆ ಮಾಡಿ.'],
    hi:['बाहर मेहनत से बचें; व्यस्त समय में खिड़कियां बंद रखें।', 'जितना हो सके घर के अंदर रहें; लक्षण बढ़ें तो डॉक्टर से मिलें।', 'N95 मास्क पहनें और जहां संभव हो बाहर का समय कम करें।'],
  },
};

const BAND_COLOR:Record<Band,string> = {good:'#4f8a4b', moderate:'#b8902a', poor:'#d0703c', severe:'#a8352e'};

function bandFor(pm25:number):Band {
  return pm25 <= WHO_PM25_24H ? 'good' : pm25 <= NAAQS_PM25_24H ? 'moderate' : pm25 <= 90 ? 'poor' : 'severe';
}

function distanceKm(a:{lat:number; lng:number}, b:{lat:number; lng:number}) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export default function CitizenPage() {
  const [lang, setLang] = useState<Lang>('en');
  const [point, setPoint] = useState<{lat:number; lng:number; label:string}>({...CANDIDATE_SITES[2], label:CANDIDATE_SITES[2].name});
  const [air, setAir] = useState<Air|null>(null);
  const [hourly, setHourly] = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState<'idle'|'sending'|'ok'|'failed'>('idle');
  const t = (key:keyof typeof T) => T[key][lang];

  useEffect(() => {
    try {const saved = window.localStorage.getItem('moss-citizen-lang'); if (saved === 'kn' || saved === 'hi' || saved === 'en') setLang(saved)} catch {/* default language */}
  }, []);
  const chooseLang = (value:Lang) => {setLang(value); try {window.localStorage.setItem('moss-citizen-lang', value)} catch {/* not persisted */}};

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchCurrentAir(point).catch(() => null), fetchHourlyAir(point, 0, 2).catch(() => [])]).then(([current, hours]) => {
      if (!active) return;
      setAir(current); setHourly(hours.filter(h => new Date(h.time).getTime() >= Date.now() - 3.6e6).slice(0, 24)); setLoading(false);
    });
    return () => {active = false};
  }, [point.lat, point.lng]);

  const windows = useMemo(() => {
    if (hourly.length < 3) return null;
    let best = 0;
    for (let i = 1; i < hourly.length - 1; i++) if (hourly[i].pm25 + hourly[i + 1].pm25 < hourly[best].pm25 + hourly[best + 1].pm25) best = i;
    const worst = hourly.reduce((max, h) => h.pm25 > max.pm25 ? h : max, hourly[0]);
    return {best:hourly[best], bestEnd:hourly[best + 1], bestValue:(hourly[best].pm25 + hourly[best + 1].pm25) / 2, worst};
  }, [hourly]);

  const nearest = useMemo(() => CANDIDATE_SITES.map(site => ({site, km:distanceKm(point, site)})).sort((a, b) => a.km - b.km)[0], [point]);
  const {node:podMapNode, leaflet:podMap, tileError:podMapError} = useLeafletMap(CANDIDATE_SITES.map(site => [site.lat, site.lng]));
  useEffect(() => {
    if (!podMap || !nearest) return;
    const {L, map, layer} = podMap;
    layer.clearLayers();
    const user = L.circleMarker([point.lat, point.lng], {radius:9, color:'#fff', weight:3, fillColor:'#16858c', fillOpacity:1})
      .bindTooltip(point.label, {direction:'top'}).addTo(layer);
    const pod = L.circleMarker([nearest.site.lat, nearest.site.lng], {radius:11, color:'#fff', weight:3, fillColor:'#587448', fillOpacity:1})
      .bindTooltip(`Nearest pod: ${nearest.site.name}`, {direction:'top'}).addTo(layer);
    L.polyline([[point.lat, point.lng], [nearest.site.lat, nearest.site.lng]], {color:'#16858c', weight:3, dashArray:'7 6'}).addTo(layer);
    map.fitBounds(L.latLngBounds([user.getLatLng(), pod.getLatLng()]), {padding:[45,45], maxZoom:13});
  }, [podMap, point, nearest]);
  const time = (iso:string) => new Date(iso).toLocaleTimeString(LOCALE[lang], {hour:'numeric', minute:'2-digit'});
  const band = air ? bandFor(air.pm25) : null;

  const locate = () => {
    if (!navigator.geolocation) {setLocationError(true); return}
    setLocating(true); setLocationError(false);
    navigator.geolocation.getCurrentPosition(
      pos => {setPoint({lat:Number(pos.coords.latitude.toFixed(4)), lng:Number(pos.coords.longitude.toFixed(4)), label:t('myLocation')}); setLocating(false)},
      () => {setLocationError(true); setLocating(false)},
      {timeout:10000, maximumAge:300000},
    );
  };

  const suggest = async (event:FormEvent) => {
    event.preventDefault();
    setSent('sending');
    try {
      const response = await fetch(`${API}/api/suggestions`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({lat:point.lat, lng:point.lng, reason:reason.trim()})});
      if (!response.ok) throw new Error();
      setSent('ok'); setReason('');
    } catch {setSent('failed')}
  };

  return <main className="citizen" lang={LOCALE[lang]}>
    <header className="citizen-top">
      <a href="/" className="citizen-brand"><img src="/moss-algae-project-emblem-v2.png" alt=""/><span>MOSS–ALGAE</span></a>
      <div className="lang-toggle" role="group" aria-label="Language">{(['en','kn','hi'] as Lang[]).map(code => <button key={code} className={lang === code ? 'active' : ''} onClick={() => chooseLang(code)}>{code === 'en' ? 'EN' : code === 'kn' ? 'ಕನ್ನಡ' : 'हिंदी'}</button>)}</div>
    </header>

    <section className="citizen-hero"><h1>{t('title')}</h1><p>{t('subtitle')}</p></section>

    <section className="citizen-place">
      <button className="citizen-locate" onClick={locate} disabled={locating}>{locating ? <LoaderCircle className="spin" size={16}/> : <Crosshair size={16}/>}{locating ? t('locating') : t('useLocation')}</button>
      {locationError && <p className="citizen-warn">{t('locationDenied')}</p>}
      <small>{t('orPick')}</small>
      <div className="citizen-chips">{CANDIDATE_SITES.map(site => <button key={site.id} className={point.label === site.name ? 'active' : ''} onClick={() => setPoint({lat:site.lat, lng:site.lng, label:site.name})}>{site.name}</button>)}</div>
    </section>

    <section className="citizen-reading" style={{'--band':band ? BAND_COLOR[band] : '#8c948a'} as React.CSSProperties}>
      <span><MapPin size={15}/> {point.label}</span>
      {loading ? <p><LoaderCircle className="spin" size={18}/> {t('loading')}</p> : air && band ? <>
        <div className="citizen-value"><strong>{air.pm25.toFixed(0)}</strong><small>µg/m³ · {t('pm25Now')}</small></div>
        <div className="citizen-band">{BAND_LABEL[band][lang]}</div>
        <small>{t('modeled')} · {time(air.time)}</small>
      </> : <p>{t('unavailable')}</p>}
    </section>

    {band && <section className="citizen-advice">
      <div><Users size={20}/><span><b>{t('everyone')}</b>{ADVICE[band][lang][0]}</span></div>
      <div><HeartPulse size={20}/><span><b>{t('sensitive')}</b>{ADVICE[band][lang][1]}</span></div>
      <div><Briefcase size={20}/><span><b>{t('workers')}</b>{ADVICE[band][lang][2]}</span></div>
    </section>}

    {windows && <section className="citizen-times">
      <div><Clock size={18}/><span>{t('bestTime')}</span><strong>{time(windows.best.time)} – {time(new Date(new Date(windows.bestEnd.time).getTime() + 3.6e6).toISOString())}</strong><small>~{windows.bestValue.toFixed(0)} µg/m³</small></div>
      <div className="worst"><Clock size={18}/><span>{t('worstTime')}</span><strong>{time(windows.worst.time)}</strong><small>~{windows.worst.pm25.toFixed(0)} µg/m³</small></div>
    </section>}

    <section className="citizen-pod"><span>{t('nearestPod')}</span><strong>{nearest.site.name}</strong><small>{nearest.km.toFixed(1)} {t('kmAway')} · {t('proposalNote')}</small></section>
    <section className="citizen-pod-map" aria-label={`Map from ${point.label} to nearest proposed pod at ${nearest.site.name}`}>
      <div ref={podMapNode}/>
      {podMapError && <p>Live map tiles unavailable. The nearest-pod calculation is still active.</p>}
      <footer><span><i className="person"/> Your location</span><span><i className="pod"/> {nearest.site.name} pod</span></footer>
    </section>

    <form className="citizen-suggest" onSubmit={suggest}>
      <h2>{t('suggestTitle')}</h2><p>{t('suggestHelp')}</p>
      <textarea value={reason} onChange={e => {setReason(e.target.value); if (sent !== 'sending') setSent('idle')}} placeholder={t('suggestPlaceholder')} maxLength={280} rows={3}/>
      <button type="submit" disabled={reason.trim().length < 3 || sent === 'sending'}>{sent === 'sending' ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>} {t('send')}</button>
      {sent === 'ok' && <p className="citizen-ok">{t('thanks')}</p>}
      {sent === 'failed' && <p className="citizen-warn">{t('sendFailed')}</p>}
    </form>

    <footer className="citizen-foot"><p>{t('disclaimer')}</p><a href="/">{t('dashboard')} →</a></footer>
  </main>;
}
