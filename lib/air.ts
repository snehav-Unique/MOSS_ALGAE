export const API = process.env.NEXT_PUBLIC_API_URL || '';

export type Air = {pm25:number; pm10:number; no2:number; co:number; aqi:number; time:string};
export type CandidateSite = {id:string; name:string; context:string; lat:number; lng:number};
export type HourlyPoint = {time:string; pm25:number; aqi:number|null};

export const CANDIDATE_SITES:CandidateSite[] = [
  {id:'peenya',name:'Peenya',context:'Industrial district',lat:13.0296,lng:77.5199},
  {id:'yeshwanthpur',name:'Yeshwanthpur',context:'Transit + freight edge',lat:13.0285,lng:77.5409},
  {id:'majestic',name:'Majestic',context:'High-footfall interchange',lat:12.9767,lng:77.5713},
  {id:'hebbal',name:'Hebbal',context:'Flyover + bus corridor',lat:13.0358,lng:77.5970},
  {id:'kr-puram',name:'KR Puram',context:'Road + rail interchange',lat:13.0004,lng:77.6952},
  {id:'whitefield',name:'Whitefield',context:'Dense employment corridor',lat:12.9698,lng:77.7500},
  {id:'silk-board',name:'Silk Board',context:'Traffic interchange',lat:12.9177,lng:77.6233},
  {id:'jayanagar',name:'Jayanagar',context:'Commercial + residential',lat:12.9250,lng:77.5938},
];

// Shared box-model assumptions used by every view (illustrative, not calibrated).
export const AIRFLOW_PER_UNIT = 500;
export const VENTILATION_M3_H = 12000;
export const VOLUME_M3 = 250000;

// Reference limits for PM2.5 (24-hour averaging period).
export const NAAQS_PM25_24H = 60;
export const WHO_PM25_24H = 15;

export function modelLocally(initial:number, background:number, ventilation:number, cadr:number, volume:number, hours:number) {
  const loss = ventilation + cadr;
  if (!loss) return initial;
  const steady = ventilation * background / loss;
  return steady + (initial - steady) * Math.exp(-loss * hours / volume);
}

export function combinedStageEfficiency(moss:number, algae:number) {
  return 1 - (1 - moss) * (1 - algae);
}

export function modeledWithPods(pm25:number, units:number, mossEfficiency:number, algaeEfficiency:number, hours:number) {
  const cadr = AIRFLOW_PER_UNIT * combinedStageEfficiency(mossEfficiency, algaeEfficiency) * units;
  return modelLocally(pm25, pm25, VENTILATION_M3_H, cadr, VOLUME_M3, hours);
}

export async function fetchCurrentAir(point:{lat:number; lng:number}):Promise<Air> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${point.lat}&longitude=${point.lng}&current=pm2_5,pm10,nitrogen_dioxide,carbon_monoxide,us_aqi&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Air-quality service did not respond.');
  const data = await response.json();
  return {pm25:Number(data.current?.pm2_5 ?? 0), pm10:Number(data.current?.pm10 ?? 0), no2:Number(data.current?.nitrogen_dioxide ?? 0), co:Number(data.current?.carbon_monoxide ?? 0), aqi:Number(data.current?.us_aqi ?? 0), time:String(data.current?.time ?? '')};
}

export async function fetchHourlyAir(point:{lat:number; lng:number}, pastDays:number, forecastDays:number):Promise<HourlyPoint[]> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${point.lat}&longitude=${point.lng}&hourly=pm2_5,us_aqi&past_days=${pastDays}&forecast_days=${forecastDays}&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Hourly air-quality service did not respond.');
  const data = await response.json();
  const times:string[] = data.hourly?.time ?? [];
  return times.map((time, index) => ({time, pm25:Number(data.hourly.pm2_5?.[index]), aqi:data.hourly.us_aqi?.[index] == null ? null : Number(data.hourly.us_aqi[index])}))
    .filter(point => Number.isFinite(point.pm25));
}

export type SiteLive = CandidateSite & {pm25:number; aqi:number; time:string; change1h:number|null; avg24h:number|null};
export type CityLive = {sites:SiteLive[]; avg:number; change1h:number|null; series24h:number[]; modelTime:string};

/** Current PM2.5 plus the past 24 hours for every candidate area, in one Open-Meteo request. */
export async function fetchCityAir():Promise<CityLive> {
  const lat = CANDIDATE_SITES.map(s => s.lat).join(','), lng = CANDIDATE_SITES.map(s => s.lng).join(',');
  const response = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=pm2_5,us_aqi&hourly=pm2_5&past_days=1&forecast_days=1&timezone=auto`);
  if (!response.ok) throw new Error('Air-quality service did not respond.');
  const data = await response.json();
  const rows:any[] = Array.isArray(data) ? data : [data];
  const histories:number[][] = [];
  const sites = rows.map((row, index):SiteLive => {
    const times:string[] = row.hourly?.time ?? [];
    const values:number[] = (row.hourly?.pm2_5 ?? []).map(Number);
    const now = String(row.current?.time ?? '');
    let idx = times.length - 1;
    while (idx > 0 && times[idx] > now) idx--;
    const past = values.slice(Math.max(0, idx - 23), idx + 1).filter(Number.isFinite);
    histories.push(past);
    const pm25 = Number(row.current?.pm2_5);
    const previous = values[idx - 1];
    return {...CANDIDATE_SITES[index], pm25, aqi:Number(row.current?.us_aqi), time:now,
      change1h:Number.isFinite(previous) ? pm25 - previous : null, avg24h:past.length ? past.reduce((a, b) => a + b, 0) / past.length : null};
  }).filter(site => Number.isFinite(site.pm25));
  const length = Math.min(...histories.map(h => h.length));
  const series24h = Array.from({length}, (_, i) => histories.reduce((sum, h) => sum + h[h.length - length + i], 0) / histories.length);
  const avg = sites.reduce((sum, s) => sum + s.pm25, 0) / (sites.length || 1);
  const changes = sites.map(s => s.change1h).filter((c):c is number => c != null);
  return {sites, avg, change1h:changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null, series24h, modelTime:sites[0]?.time ?? ''};
}

export function pmBand(pm25:number) {
  if (pm25 <= WHO_PM25_24H) return {label:'Within WHO guideline', color:'#4f8a4b'};
  if (pm25 <= NAAQS_PM25_24H) return {label:'Above WHO, within NAAQS', color:'#c2a03a'};
  if (pm25 <= 90) return {label:'Above NAAQS', color:'#d0703c'};
  return {label:'Severe', color:'#a8352e'};
}

export function formatHour(time:string) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return date.toLocaleString([], {weekday:'short', hour:'2-digit', minute:'2-digit'});
}

export function formatInr(value:number) {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(2)} L`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}
