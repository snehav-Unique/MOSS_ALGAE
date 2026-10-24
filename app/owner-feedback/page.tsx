'use client';

import {FormEvent, useMemo, useState} from 'react';
import {KeyRound, LoaderCircle, LockKeyhole, MapPin, MessageSquareText, RefreshCw} from 'lucide-react';
import {API} from '../../lib/air';

type Suggestion = {
  id:string;
  lat:number;
  lng:number;
  reason:string;
  received_at:string;
  nearest_pod?:{id:string; name:string; distance_km:number};
};

export default function OwnerFeedbackPage() {
  const [key, setKey] = useState('');
  const [records, setRecords] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = async (event?:FormEvent) => {
    event?.preventDefault();
    if (!key.trim()) return;
    setLoading(true); setError('');
    try {
      const response = await fetch(`${API}/api/suggestions`, {headers:{Authorization:`Bearer ${key.trim()}`}, cache:'no-store'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Unable to load suggestions.');
      setRecords(Array.isArray(data.suggestions) ? data.suggestions : []);
      setAuthorized(true);
    } catch (reason:any) {
      setAuthorized(false); setRecords([]); setError(reason?.message || 'Unable to load suggestions.');
    } finally {setLoading(false)}
  };

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? records.filter(item => `${item.reason} ${item.nearest_pod?.name ?? ''}`.toLowerCase().includes(query)) : records;
  }, [records, filter]);
  const podCounts = useMemo(() => records.reduce<Record<string,number>>((counts, item) => {
    const name = item.nearest_pod?.name || 'Unmapped';
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {}), [records]);
  const leadingArea = Object.entries(podCounts).sort((a, b) => b[1] - a[1])[0];

  return <main className="owner-feedback">
    <header><div><span>PRIVATE / REPOSITORY OWNERS</span><h1>Citizen pod suggestions</h1><p>Durable feedback stored in Firebase Firestore. This page is intentionally unlinked from the public website.</p></div><LockKeyhole size={34}/></header>

    {!authorized ? <form className="owner-login" onSubmit={load}>
      <KeyRound size={25}/><div><h2>Owner access</h2><p>Enter the server-configured dashboard key to view submissions.</p></div>
      <input type="password" value={key} onChange={event => setKey(event.target.value)} placeholder="Owner dashboard key" autoComplete="current-password" aria-label="Owner dashboard key"/>
      <button disabled={loading || !key.trim()}>{loading ? <LoaderCircle className="spin" size={17}/> : <LockKeyhole size={17}/>} Unlock feedback</button>
      {error && <p className="owner-error">{error}</p>}
    </form> : <>
      <section className="owner-summary">
        <div><span>TOTAL RESPONSES</span><strong>{records.length}</strong></div>
        <div><span>AREAS REPRESENTED</span><strong>{Object.keys(podCounts).length}</strong></div>
        <div><span>MOST REQUESTED POD AREA</span><strong>{leadingArea ? `${leadingArea[0]} · ${leadingArea[1]}` : '—'}</strong></div>
      </section>
      <div className="owner-toolbar"><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search feedback or pod area" aria-label="Search feedback"/><button onClick={() => load()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} Refresh</button></div>
      <section className="owner-records">
        {visible.map(item => <article key={item.id}>
          <div className="owner-record-meta"><span><MapPin size={15}/>{item.nearest_pod?.name || 'Nearest pod unavailable'}</span><time>{new Date(item.received_at).toLocaleString('en-IN')}</time></div>
          <p><MessageSquareText size={18}/><span>{item.reason}</span></p>
          <footer><span>{item.lat.toFixed(4)}° N · {item.lng.toFixed(4)}° E</span><span>{item.nearest_pod ? `${item.nearest_pod.distance_km.toFixed(1)} km from pod` : ''}</span></footer>
        </article>)}
        {!visible.length && <div className="owner-empty">{records.length ? 'No feedback matches this search.' : 'No citizen suggestions have been submitted yet.'}</div>}
      </section>
    </>}
  </main>;
}
