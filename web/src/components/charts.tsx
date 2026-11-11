import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Small SVG charts. One accent series (--chart-1), an optional dashed grey reference
 * series (--chart-ref), recessive grid, hover tooltip on every chart. Text uses text
 * tokens, never the series colour.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), w - 168);
  return (
    <div className="pointer-events-none absolute z-10 w-40 rounded-lg border border-line-strong bg-elev px-2.5 py-2 text-[12px] leading-[1.45] shadow-sm" style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

export const pctTick = (v: number) => `${Math.round(v * 100)}%`;
const PAD = { l: 36, r: 12, t: 10, b: 24 };

export interface Pt { label: string; y: number | null; ref?: number | null; n?: number; detail?: ReactNode }

/** Line over ordered x (dates, buckets). Domain 0..1 by default. */
export function LineChart({ data, height = 180, yFmt = pctTick, domain = [0, 1], refLabel, label, area = true }: {
  data: Pt[]; height?: number; yFmt?: (v: number) => string; domain?: [number, number]; refLabel?: string; label: string; area?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const iw = Math.max(0, w - PAD.l - PAD.r), ih = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - ((v - domain[0]) / (domain[1] - domain[0])) * ih;
  const path = (get: (p: Pt) => number | null | undefined) => {
    let d = '', open = false;
    data.forEach((p, i) => {
      const v = get(p);
      if (v == null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const line = path((p) => p.y);
  const pts = data.map((p, i) => ({ p, i })).filter(({ p }) => p.y != null);
  // Fill each contiguous run separately so gaps (days without data) stay empty.
  let areaD = '';
  if (area) {
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1)
        areaD += `M${x(run[0])},${y(domain[0])}` + run.map((i) => `L${x(i).toFixed(1)},${y(data[i].y!).toFixed(1)}`).join('') + `L${x(run[run.length - 1])},${y(domain[0])}Z`;
      run = [];
    };
    data.forEach((p, i) => (p.y == null ? flush() : run.push(i)));
    flush();
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => domain[0] + t * (domain[1] - domain[0]));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 70))));
  const h = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative select-none" role="img" aria-label={label}>
      {w > 0 && (
        <svg width={w} height={height} onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGElement).getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - PAD.l) / Math.max(1, iw)) * (data.length - 1));
            setHover(i >= 0 && i < data.length ? i : null);
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
              <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--faint)">{yFmt(t)}</text>
            </g>
          ))}
          {data.map((p, i) => (i % labelEvery === 0 || i === data.length - 1) && (
            <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="10.5" fill="var(--faint)">{p.label}</text>
          ))}
          {areaD && <path d={areaD} fill="var(--chart-1)" opacity="0.08" />}
          {data.some((p) => p.ref != null) && <path d={path((p) => p.ref)} fill="none" stroke="var(--chart-ref)" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" />}
          <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {pts.length <= 40 && pts.map(({ p, i }) => <circle key={i} cx={x(i)} cy={y(p.y!)} r={hover === i ? 4.5 : 3} fill="var(--chart-1)" stroke="var(--panel)" strokeWidth="2" />)}
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--line-strong)" />}
        </svg>
      )}
      {h && (
        <Tip x={x(hover!)} y={h.y != null ? y(h.y) : PAD.t} w={w}>
          <div className="text-muted">{h.label}</div>
          <div className="flex justify-between gap-2"><span className="flex items-center gap-1.5"><Swatch />{label}</span><span className="tabular-nums">{h.y == null ? '–' : yFmt(h.y)}</span></div>
          {h.ref != null && <div className="flex justify-between gap-2"><span className="flex items-center gap-1.5"><Swatch dashed />{refLabel}</span><span className="tabular-nums">{yFmt(h.ref)}</span></div>}
          {h.n != null && <div className="text-faint">{h.n} answers</div>}
          {h.detail}
        </Tip>
      )}
    </div>
  );
}

export function Swatch({ dashed }: { dashed?: boolean }) {
  return dashed
    ? <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: 'var(--chart-ref)' }} />
    : <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: 'var(--chart-1)' }} />;
}

export function Legend({ items }: { items: { label: string; dashed?: boolean }[] }) {
  return (
    <div className="flex gap-4 text-[12px] text-muted">
      {items.map((i) => <span key={i.label} className="flex items-center gap-1.5"><Swatch dashed={i.dashed} />{i.label}</span>)}
    </div>
  );
}

export interface Bar { label: string; value: number | null; n: number; sub?: string }

/** Vertical bars on a 0..1 scale. Low-sample bars (n < minN) render faded. */
export function BarChart({ data, height = 160, yFmt = pctTick, label, minN = 3 }: { data: Bar[]; height?: number; yFmt?: (v: number) => string; label: string; minN?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const iw = Math.max(0, w - PAD.l - PAD.r), ih = height - PAD.t - PAD.b;
  const slot = data.length ? iw / data.length : 0;
  const bw = Math.max(4, Math.min(36, slot - 2 - slot * 0.3));
  const y = (v: number) => PAD.t + ih - v * ih;
  const h = hover !== null ? data[hover] : null;
  return (
    <div ref={ref} className="relative select-none" role="img" aria-label={label}>
      {w > 0 && (
        <svg width={w} height={height} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
              <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--faint)">{yFmt(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.l + slot * i + slot / 2;
            const v = d.value ?? 0;
            const top = y(v), bh = Math.max(d.value == null ? 0 : 2, PAD.t + ih - top);
            const r = Math.min(4, bw / 2, bh);
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={cx - slot / 2} y={PAD.t} width={slot} height={ih} fill="transparent" />
                {d.value != null && (
                  <path
                    d={`M${cx - bw / 2},${PAD.t + ih}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${PAD.t + ih}Z`}
                    fill="var(--chart-1)" opacity={d.n < minN ? 0.35 : hover === i ? 1 : 0.85}
                  />
                )}
                <text x={cx} y={height - 6} textAnchor="middle" fontSize="10.5" fill="var(--faint)">{d.label}</text>
              </g>
            );
          })}
        </svg>
      )}
      {h && (
        <Tip x={PAD.l + slot * hover! + slot / 2} y={h.value != null ? y(h.value) : PAD.t} w={w}>
          <div className="text-muted">{h.sub ?? h.label}</div>
          <div className="flex justify-between"><span>{label}</span><span className="tabular-nums">{h.value == null ? '–' : yFmt(h.value)}</span></div>
          <div className="text-faint">{h.n} answers{h.n < minN ? ' · too few to judge' : ''}</div>
        </Tip>
      )}
    </div>
  );
}

export interface Dot { x: number; y: number; n: number; label: string }

/** Speed vs accuracy: x = seconds (log scale), y = accuracy. Dot area by answers. */
export function Scatter({ data, height = 220, label }: { data: Dot[]; height?: number; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const P = { ...PAD, b: 30 };
  const iw = Math.max(0, w - P.l - P.r), ih = height - P.t - P.b;
  const xs = data.map((d) => d.x);
  const minX = Math.max(0.5, Math.min(...xs)), maxX = Math.max(minX * 2, ...xs);
  const lo = Math.log(minX * 0.75), hi = Math.log(maxX * 1.3);
  const x = (v: number) => P.l + ((Math.log(Math.max(0.5, v)) - lo) / (hi - lo || 1)) * iw;
  const y = (v: number) => P.t + ih - v * ih;
  const maxN = Math.max(1, ...data.map((d) => d.n));
  const ticks = [1, 2, 3, 5, 7, 10, 15, 20, 30, 60, 120, 300].filter((t) => Math.log(t) >= lo && Math.log(t) <= hi);
  const h = hover !== null ? data[hover] : null;
  return (
    <div ref={ref} className="relative select-none" role="img" aria-label={label}>
      {w > 0 && (
        <svg width={w} height={height} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={P.l} x2={w - P.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
              <text x={P.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--faint)">{pctTick(t)}</text>
            </g>
          ))}
          {ticks.map((t) => <text key={t} x={x(t)} y={height - 14} textAnchor="middle" fontSize="10.5" fill="var(--faint)">{t < 60 ? `${t}s` : `${t / 60}m`}</text>)}
          {data.map((d, i) => (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <circle cx={x(d.x)} cy={y(d.y)} r={14} fill="transparent" />
              <circle cx={x(d.x)} cy={y(d.y)} r={4 + 6 * Math.sqrt(d.n / maxN)} fill="var(--chart-1)" fillOpacity={hover === i ? 0.9 : 0.55} stroke="var(--panel)" strokeWidth="2" />
            </g>
          ))}
        </svg>
      )}
      {h && (
        <Tip x={x(h.x)} y={y(h.y)} w={w}>
          <div className="text-muted truncate">{h.label}</div>
          <div className="flex justify-between"><span>Accuracy</span><span className="tabular-nums">{pctTick(h.y)}</span></div>
          <div className="flex justify-between"><span>Avg time</span><span className="tabular-nums">{h.x.toFixed(1)}s</span></div>
          <div className="text-faint">{h.n} answers</div>
        </Tip>
      )}
    </div>
  );
}

/** Horizontal meter for mastery lists: thin track, accent fill, value in text ink. */
export function Meter({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`block h-1.5 rounded-full bg-elev overflow-hidden ${className}`}>
      <span className="block h-full rounded-full" style={{ width: `${Math.round(value * 100)}%`, background: 'var(--chart-1)' }} />
    </span>
  );
}
