'use client';

import {ReactNode, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {BookOpen} from 'lucide-react';

type Placement = {left:number; top:number; width:number; above:boolean};

/** Small "i" badge; shows an explanation on hover, keyboard focus or tap. */
export function InfoTip({children, label = 'What does this mean?'}:{children:ReactNode; label?:string}) {
  // A span, not a <button>: inside a <label> a button would become the label's control and unlabel the slider.
  const badge = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<Placement|null>(null);
  const id = useId();

  const show = () => {
    const rect = badge.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    const above = rect.bottom + 240 > window.innerHeight && rect.top > 240;
    setPlace({left, width, above, top:above ? rect.top - 10 : rect.bottom + 10});
  };
  const hide = () => setPlace(null);

  useEffect(() => {
    if (!place) return;
    const onKey = (e:KeyboardEvent) => {if (e.key === 'Escape') hide()};
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    return () => {window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); window.removeEventListener('keydown', onKey)};
  }, [place]);

  return <>
    <span ref={badge} role="button" tabIndex={0} className="info-tip" aria-label={label} aria-describedby={place ? id : undefined} aria-expanded={Boolean(place)}
      onPointerEnter={e => {if (e.pointerType === 'mouse') show()}} onPointerLeave={e => {if (e.pointerType === 'mouse') hide()}}
      onFocus={show} onBlur={hide} onClick={e => {e.preventDefault(); e.stopPropagation(); place ? hide() : show()}}
      onKeyDown={e => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault(); place ? hide() : show()}}}>i</span>
    {place && createPortal(<div id={id} role="tooltip" className={`info-pop ${place.above ? 'above' : ''}`} style={{left:place.left, top:place.top, width:place.width}}>{children}</div>, document.body)}
  </>;
}

export type GuideItem = {title:string; body:ReactNode; formula?:string};

/** Always-visible "how to read this" panel placed directly under the part of the page it explains. */
export function Guide({title = 'How to read this', items, columns}:{title?:string; items:GuideItem[]; columns?:number}) {
  return <section className={`guide cols-${columns ?? Math.min(items.length, 4)}`} aria-label={title}>
    <header><BookOpen size={15}/> {title}</header>
    <div className="guide-grid">{items.map(item => <div key={item.title}>
      <strong>{item.title}</strong>
      <p>{item.body}</p>
      {item.formula && <code>{item.formula}</code>}
    </div>)}</div>
  </section>;
}

/** One-line plain-language caption under a metric or panel title. */
export function Explain({children}:{children:ReactNode}) {
  return <p className="explain">{children}</p>;
}
