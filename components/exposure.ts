'use client';

import {useEffect, useState} from 'react';
import {API} from '../lib/air';

export type Receptor = {kind:'school'|'health'|'bus_stop'; lat:number; lng:number; name:string|null};
export type SiteExposure = {school:number; health:number; bus_stop:number; features:Receptor[]};
export type ExposureData = {radius_m:number; sites:Record<string,SiteExposure>; source:string; retrieved_at:string; note:string};

export const RECEPTOR_LABEL:Record<Receptor['kind'],string> = {school:'Schools', health:'Hospitals & clinics', bus_stop:'Bus stops'};

export function receptorTotal(site?:SiteExposure) {
  return site ? site.school + site.health + site.bus_stop : 0;
}

/** Live Overpass counts through the API, falling back to the bundled OpenStreetMap snapshot. */
export function useExposure() {
  const [data, setData] = useState<ExposureData|null>(null);
  const [mode, setMode] = useState<'live'|'snapshot'|'unavailable'|'loading'>('loading');
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch(`${API}/api/exposure`);
        if (!response.ok) throw new Error();
        const live = await response.json();
        if (active) {setData(live); setMode('live')}
      } catch {
        try {
          const response = await fetch('/exposure-snapshot.json');
          if (!response.ok) throw new Error();
          const snapshot = await response.json();
          if (active) {setData(snapshot); setMode('snapshot')}
        } catch {if (active) setMode('unavailable')}
      }
    })();
    return () => {active = false};
  }, []);
  return {data, mode};
}
