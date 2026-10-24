'use client';

import {FormEvent, useEffect, useRef, useState} from 'react';
import {LoaderCircle, MessageCircle, Send, Sparkles, Wrench, X} from 'lucide-react';
import {API} from '../lib/air';

export type PlannerState = Record<string, unknown>;
type Turn = {role:'user'|'assistant'; text:string; tools?:string[]; engine?:string; error?:boolean};

const SUGGESTIONS = [
  'What if we only have ₹5 lakh?',
  'Why is the top area ranked first?',
  'When is the next pollution peak at Silk Board?',
  'Which areas have the most schools and hospitals nearby?',
];

const TOOL_LABEL:Record<string,string> = {
  get_planner_state:'Planner state', optimize_deployment:'Optimizer', lifecycle_cost:'Economics',
  get_city_hotspots:'Station quality', get_site_receptors:'Receptors', get_site_air:'Forecast',
};

function engineLabel(model?:string) {
  return !model ? null : model.startsWith('gemini') ? 'Gemini' : model.startsWith('claude') ? 'Claude' : model;
}

export async function askAssistant(history:Array<{role:'user'|'assistant'; text:string}>, planner:PlannerState|null) {
  const response = await fetch(`${API}/api/assistant`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({history, planner})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ?? 'The assistant service is unreachable.');
  return data as {reply:string; tool_calls:Array<{name:string}>; model:string};
}

export function Assistant({planner}:{planner:PlannerState|null}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {log.current?.scrollTo({top:log.current.scrollHeight, behavior:'smooth'})}, [turns, busy]);

  const send = async (question:string) => {
    const text = question.trim();
    if (!text || busy) return;
    const history = [...turns.filter(t => !t.error).map(({role, text}) => ({role, text})), {role:'user' as const, text}].slice(-12);
    setTurns(current => [...current, {role:'user', text}]);
    setInput(''); setBusy(true);
    try {
      const data = await askAssistant(history, planner);
      setTurns(current => [...current, {role:'assistant', text:data.reply, tools:[...new Set(data.tool_calls.map(c => c.name))], engine:data.model}]);
    } catch (error:any) {
      setTurns(current => [...current, {role:'assistant', text:error.message, error:true}]);
    } finally {setBusy(false)}
  };

  const submit = (event:FormEvent) => {event.preventDefault(); send(input)};

  if (!open) return <button className="assistant-fab" onClick={() => setOpen(true)} aria-label="Open planning assistant"><MessageCircle size={20}/><span>Ask the planner</span></button>;

  return <aside className="assistant-panel" aria-label="Planning assistant">
    <header><div><span><Sparkles size={14}/> PLANNING ASSISTANT</span><strong>Ask with live data</strong></div><button onClick={() => setOpen(false)} aria-label="Close assistant"><X size={18}/></button></header>
    <div className="assistant-log" ref={log}>
      {!turns.length && <div className="assistant-intro"><p>Answers come from the optimizer, economics model, OpenAQ, OpenStreetMap and the forecast—every number is traceable to a tool.</p>{!planner && <p className="assistant-hint">Open the Planner tab once so budget questions use your current scores.</p>}<div className="assistant-suggestions">{SUGGESTIONS.map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div></div>}
      {turns.map((turn, index) => <div key={index} className={`assistant-turn ${turn.role} ${turn.error ? 'error' : ''}`}><p>{turn.text}</p>{turn.tools?.length || turn.engine ? <small><Wrench size={12}/> {[engineLabel(turn.engine), ...(turn.tools ?? []).map(t => TOOL_LABEL[t] ?? t)].filter(Boolean).join(' · ')}</small> : null}</div>)}
      {busy && <div className="assistant-turn assistant pending"><LoaderCircle className="spin" size={16}/> Running tools…</div>}
    </div>
    <form onSubmit={submit}><input value={input} onChange={e => setInput(e.target.value)} placeholder="e.g. Compare Peenya and Whitefield" aria-label="Question" maxLength={600}/><button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Send size={16}/></button></form>
  </aside>;
}
