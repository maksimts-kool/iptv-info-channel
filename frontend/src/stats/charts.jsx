import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';

// Small hand-drawn charts for the statistics page: columns over time, a
// weekday x hour heatmap and horizontal (optionally stacked) bars. They share
// one look — thin marks with a 4px rounded data end, a 2px surface gap
// between touching fills, recessive hairline grid — and one hover layer:
// every mark has a tooltip on pointer AND keyboard focus, and every value is
// also on the page without hovering (direct labels, the legend, the table).

// Single-series marks: the admin's brand blue.
export const ACCENT = '#2563eb';
// Categorical slots, in a fixed order validated for colour-vision deficiency
// (adjacent pairs). A colour follows its channel, never its rank in a row.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'];
export const OTHER = '#c4c8d0';
// Sequential blue for magnitude, light (little) to dark (a lot).
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const EMPTY_CELL = '#f1f3f6';
const GRID = '#eceef2';

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

// One floating tooltip per page, portalled to <body> so showing it never
// shifts the page layout. `bind(content)` gives a mark its handlers;
// `hide` is for clicks that swap the marks out from under the pointer.
export function useTooltip() {
  const [tip, setTip] = useState(null);
  const hide = useCallback(() => setTip(null), []);
  const bind = useCallback((content) => ({
    onPointerMove: (e) => setTip({ x: e.clientX, y: e.clientY, content }),
    onPointerLeave: hide,
    onFocus: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top, content });
    },
    onBlur: hide,
  }), [hide]);

  // A scroll moves the page under a fixed tooltip; drop it instead.
  useEffect(() => {
    if (!tip) return undefined;
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [tip, hide]);

  let node = null;
  if (tip) {
    const below = tip.y < 140;
    const x = Math.min(Math.max(tip.x, 130), window.innerWidth - 130);
    node = createPortal(
      <div
        className="viz-tip"
        role="tooltip"
        style={{
          left: x,
          top: below ? tip.y + 18 : tip.y - 12,
          transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        }}
      >
        {tip.content}
      </div>,
      document.body,
    );
  }
  return [node, bind, hide];
}

// Tooltip body: a title, then rows where the value leads and the label follows.
export function TipBody({ title, rows }) {
  return (
    <>
      {title ? <div className="viz-tip-title">{title}</div> : null}
      {rows.map((r) => (
        <div className="viz-tip-row" key={r.label}>
          {r.color ? <span className="viz-tip-key" style={{ background: r.color }} /> : null}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Columns over time
// ---------------------------------------------------------------------------

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Round axis steps for a duration in seconds: minutes below two hours, hours above.
function durationTicks(max) {
  const unit = max < 2 * 3600 ? 60 : 3600;
  const suffix = unit === 60 ? 'м' : 'ч';
  const top = Math.max(max / unit, 1);
  const raw = top / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) * unit;
  // Up to the first tick at or above the tallest value, so no mark overruns the axis.
  const ticks = [0];
  while (ticks[ticks.length - 1] < max || ticks.length < 2) ticks.push(ticks[ticks.length - 1] + step);
  return { ticks, label: (v) => `${Number((v / unit).toFixed(1)).toLocaleString('ru-RU')} ${suffix}` };
}

// A column per bucket (day or hour). `items`: { key, label, value, tip }.
// The tallest column carries its value; the rest are in the tooltip/table.
export function ColumnChart({
  items, height = 220, format, bind, ariaLabel,
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const max = Math.max(...items.map((d) => d.value), 0);
  const { ticks, label } = durationTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const m = {
    left: 46, right: 8, top: 30, bottom: 26,
  };
  const innerW = Math.max(width - m.left - m.right, 10);
  const innerH = height - m.top - m.bottom;
  const band = innerW / Math.max(items.length, 1);
  const barW = Math.max(Math.min(24, band * 0.68), 2);
  const y = (v) => m.top + innerH - (v / top) * innerH;
  const every = Math.max(1, Math.ceil(52 / band));
  const peak = max > 0 ? items.findIndex((d) => d.value === max) : -1;

  return (
    <div ref={ref} className="viz-columns">
      {width ? (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke={GRID} />
              <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-axis">{label(t)}</text>
            </g>
          ))}
          {items.map((d, i) => {
            const cx = m.left + band * i + band / 2;
            const h = Math.max((d.value / top) * innerH, d.value > 0 ? 1.5 : 0);
            const r = Math.min(4, h, barW / 2);
            const x0 = cx - barW / 2;
            const yb = m.top + innerH;
            const path = h > 0
              ? `M${x0},${yb} V${yb - h + r} Q${x0},${yb - h} ${x0 + r},${yb - h} H${x0 + barW - r} Q${x0 + barW},${yb - h} ${x0 + barW},${yb - h + r} V${yb} Z`
              : '';
            return (
              <g key={d.key}>
                {path ? <path d={path} fill={ACCENT} opacity={hover === null || hover === i ? 1 : 0.55} /> : null}
                {i === peak ? (
                  <text x={cx} y={yb - h - 6} textAnchor="middle" className="viz-value">{format(d.value)}</text>
                ) : null}
                {i % every === 0 ? (
                  <text x={cx} y={height - 8} textAnchor="middle" className="viz-axis">{d.label}</text>
                ) : null}
                <rect
                  x={m.left + band * i}
                  y={m.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  className="viz-hit"
                  aria-label={`${d.label}: ${format(d.value)}`}
                  {...bind(d.tip)}
                  onPointerEnter={() => setHover(i)}
                  onPointerOut={() => setHover(null)}
                />
              </g>
            );
          })}
          <line x1={m.left} x2={width - m.right} y1={m.top + innerH} y2={m.top + innerH} stroke="#d9dce2" />
        </svg>
      ) : <div style={{ height }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekday x hour heatmap
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

function rampColor(value, max) {
  if (!value || !max) return EMPTY_CELL;
  const i = Math.min(RAMP.length - 1, Math.floor((value / max) * RAMP.length));
  return RAMP[i];
}

export function Heatmap({ grid, format, bind }) {
  const max = Math.max(...grid.flat(), 0);
  const hh = (h) => String(h).padStart(2, '0');
  return (
    <div className="viz-heat-scroll">
      <div className="viz-heat" role="img" aria-label="Время просмотра по дням недели и часам">
        <div className="viz-heat-row">
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="viz-axis viz-heat-hour">{h % 3 === 0 ? hh(h) : ''}</span>
          ))}
        </div>
        {grid.map((row, d) => (
          <div key={WEEKDAYS[d]} className="viz-heat-row">
            <span className="viz-axis viz-heat-day">{WEEKDAYS[d]}</span>
            {row.map((v, h) => (
              <span
                key={`${WEEKDAYS[d]}${hh(h)}`}
                className="viz-heat-cell viz-hit"
                tabIndex={0}
                aria-label={`${WEEKDAYS_LONG[d]}, ${hh(h)}:00: ${format(v)}`}
                style={{ background: rampColor(v, max) }}
                {...bind(<TipBody title={`${WEEKDAYS_LONG[d]}, ${hh(h)}:00–${hh((h + 1) % 24)}:00`} rows={[{ label: 'просмотра', value: format(v) }]} />)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="viz-heat-legend">
        <span>меньше</span>
        {RAMP.map((c) => <span key={c} className="viz-heat-swatch" style={{ background: c }} />)}
        <span>больше</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars
// ---------------------------------------------------------------------------

// One row per item: label, bar, value at the bar's end. `segments` (optional)
// stacks the bar: [{ key, value, color, label }]. A row with `onClick` is a
// button that leads somewhere (a customer, a channel's audience).
export function BarList({
  items, format, bind, active,
}) {
  const max = Math.max(...items.map((d) => d.value), 0) || 1;
  return (
    <div className="viz-bars">
      {items.map((d) => {
        const segs = d.segments || [{ key: 'all', value: d.value, color: d.color || ACCENT }];
        const visible = segs.filter((s) => s.value > 0);
        const Row = d.onClick ? 'button' : 'div';
        return (
          <Row
            key={d.key}
            type={d.onClick ? 'button' : undefined}
            className={`viz-bar-row${d.onClick ? ' viz-bar-link' : ''}${active === d.key ? ' viz-bar-active' : ''}`}
            onClick={d.onClick}
            {...(d.tip ? bind(d.tip) : {})}
          >
            <span className="viz-bar-label">
              <span className="viz-bar-name">{d.label}</span>
              {d.sub ? <span className="viz-bar-sub">{d.sub}</span> : null}
            </span>
            <span className="viz-bar-track">
              <span className="viz-bar-fill" style={{ width: `calc((100% - 84px) * ${d.value / max})` }}>
                {visible.map((s, i) => (
                  <span
                    key={s.key}
                    className="viz-bar-seg"
                    style={{
                      flexGrow: s.value,
                      background: s.color,
                      borderRadius: i === visible.length - 1 ? '0 4px 4px 0' : 0,
                    }}
                  />
                ))}
              </span>
              <span className="viz-bar-value">{format(d.value)}</span>
            </span>
          </Row>
        );
      })}
    </div>
  );
}

// The legend for stacked bars: a swatch (the mark's shape) and the name.
export function Legend({ entries }) {
  return (
    <div className="viz-legend">
      {entries.map((e) => (
        <span key={e.key} className="viz-legend-item">
          <span className="viz-legend-swatch" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}
