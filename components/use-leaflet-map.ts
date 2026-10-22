'use client';

import {useEffect, useRef, useState} from 'react';

const OFFLINE_BOUNDS:[[number,number],[number,number]] = [[12.811801316582617,77.431640625],[13.06877673435769,77.6953125]];

/** Leaflet map with OSM tiles over the bundled Bengaluru image; returns the map once ready. */
export function useLeafletMap(fit:Array<[number,number]>) {
  const node = useRef<HTMLDivElement>(null);
  const [leaflet, setLeaflet] = useState<{L:any; map:any; layer:any}|null>(null);
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    if (!node.current) return;
    let active = true;
    let map:any = null;
    let resizeObserver:ResizeObserver|null = null;
    let tileHealthTimer:ReturnType<typeof setTimeout>|null = null;
    import('leaflet').then(({default:L}) => {
      if (!active || !node.current) return;
      map = L.map(node.current, {zoomControl:false, attributionControl:true, preferCanvas:true});
      L.control.zoom({position:'bottomleft'}).addTo(map);
      map.createPane('offlineMap');
      const offlinePane = map.getPane('offlineMap');
      if (offlinePane) offlinePane.style.zIndex = '150';
      const offlineMap = L.imageOverlay('/bengaluru-map.webp', OFFLINE_BOUNDS, {pane:'offlineMap', interactive:false});
      offlineMap.on('load', () => {
        const image = offlineMap.getElement();
        image?.style.setProperty('max-width','none','important');
        image?.style.setProperty('max-height','none','important');
      });
      offlineMap.addTo(map);
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
      let receivedLiveTile = false;
      tileHealthTimer = setTimeout(() => {if (active && !receivedLiveTile) setTileError(true)}, 7000);
      tiles.on('tileload', () => {receivedLiveTile = true; if (active) setTileError(false)});
      map.fitBounds(fit, {padding:[42,42], maxZoom:12});
      const layer = L.layerGroup().addTo(map);
      resizeObserver = new ResizeObserver(() => map.invalidateSize({pan:false}));
      resizeObserver.observe(node.current);
      requestAnimationFrame(() => map.invalidateSize());
      setLeaflet({L, map, layer});
    }).catch(() => setTileError(true));
    return () => {
      active = false;
      if (tileHealthTimer) clearTimeout(tileHealthTimer);
      resizeObserver?.disconnect();
      map?.remove();
      setLeaflet(null);
    };
    // The map is created once per mount; later bounds changes are applied by callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {node, leaflet, tileError};
}
