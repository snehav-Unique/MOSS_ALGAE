import {ReactNode} from 'react';
import {BookOpen} from 'lucide-react';

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
