import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { Signal } from '../obd/signals';
import { displayUnit, toDisplay, type UnitSystem } from '../obd/units';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

interface Props {
  signal: Signal;
  /** Milliseconds since session start. */
  t: number[];
  /** Metric values. */
  v: number[];
  units: UnitSystem;
  durationMs: number;
}

/**
 * One signal over the session. Each signal gets its own chart with its own
 * y-scale; the charts share an x-range and a synced crosshair, so readings
 * line up in time without forcing unrelated units onto one axis.
 */
export function SeriesChart({ signal, t, v, units, durationMs }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const unit = displayUnit(signal, units);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const xs = t.map((ms) => ms / 1000);
    const ys = v.map((x) => toDisplay(signal, x, units));
    const decimals = Math.max(signal.decimals, 1);
    const idle = `${Math.min(...ys).toFixed(decimals)} to ${Math.max(...ys).toFixed(decimals)} ${unit}`;
    if (readout.current) readout.current.textContent = idle;

    const axis = { stroke: color('--muted'), grid: { stroke: color('--grid'), width: 1 }, ticks: { show: false }, font: '11px system-ui' };
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: 130,
        legend: { show: false },
        scales: { x: { time: false, range: [0, Math.max(durationMs / 1000, 1)] } },
        cursor: { sync: { key: 'session' }, y: false, drag: { x: false, y: false } },
        axes: [
          { ...axis, values: (_u, ticks) => ticks.map(clock) },
          { ...axis, size: 52 },
        ],
        series: [{}, { stroke: color('--series-1'), width: 2, points: { show: false } }],
        hooks: {
          setCursor: [
            (u) => {
              const i = u.cursor.idx;
              const y = i == null ? undefined : ys[i];
              if (readout.current) readout.current.textContent = y === undefined ? idle : `${y.toFixed(decimals)} ${unit} at ${clock(xs[i!]!)}`;
            },
          ],
        },
      },
      [xs, ys],
      el,
    );
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: 130 }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [signal, t, v, units, durationMs, unit]);

  return (
    <figure className="chart">
      <figcaption>
        <span>{signal.name}</span>
        <span className="readout" ref={readout} />
      </figcaption>
      <div ref={host} />
    </figure>
  );
}
