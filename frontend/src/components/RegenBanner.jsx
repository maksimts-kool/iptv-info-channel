import { useEffect, useRef, useState } from 'react';

// Presentational encoding-status banner (bottom-right). Compact: a short title,
// an optional count, and a thin progress bar — determinate for a bulk rebuild
// (real "N / total" progress), an indeterminate sweep for a single encode that
// reports no sub-progress. Handles its own enter/exit animation: it keeps
// rendering the last snapshot through the fade-out after `gen.visible` flips off.
export default function RegenBanner({ gen }) {
  const [mounted, setMounted] = useState(gen.visible);
  const [closing, setClosing] = useState(false);
  const [snap, setSnap] = useState(gen);
  const timer = useRef();

  useEffect(() => {
    if (gen.visible) {
      clearTimeout(timer.current);
      setSnap(gen);
      setClosing(false);
      setMounted(true);
      return undefined;
    }
    setClosing(true);
    timer.current = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timer.current);
  }, [gen]);

  if (!mounted) return null;

  const indet = snap.indeterminate && !snap.complete;
  const width = snap.complete ? 100 : snap.percent || 0;

  return (
    <div className={`regen-banner ${closing ? 'regen-out' : 'regen-in'}`} role="status" aria-live="polite">
      <div className="regen-head">
        <span className={`regen-dot ${snap.complete ? 'done' : ''}`} />
        <span className="regen-title">{snap.title}</span>
        {snap.count ? <span className="regen-count">{snap.count}</span> : null}
      </div>
      <div className="regen-track">
        <div
          className={`regen-fill ${snap.complete ? 'done' : ''} ${indet ? 'indet' : ''}`}
          style={indet ? undefined : { width: `${width}%` }}
        />
      </div>
    </div>
  );
}
