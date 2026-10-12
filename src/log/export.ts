import { SIGNAL_BY_ID, type Signal } from '../obd/signals';
import { displayUnit, toDisplay, type UnitSystem } from '../obd/units';
import { toSeries, type SampleColumns, type Series, type Session } from './types';

/**
 * Export formats. The goal is data an AI assistant (or a spreadsheet, or a
 * person) can use with no extra explanation: every file names its units and
 * says which vehicle and session it came from.
 */

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const round = (v: number, decimals: number) => Number(v.toFixed(decimals)).toString();
/** One more decimal than the dashboard shows, so averages don't lose detail. */
const precision = (s: Signal) => s.decimals + 1;

function known(series: Series[]): { series: Series; signal: Signal }[] {
  return series.flatMap((s) => {
    const signal = SIGNAL_BY_ID.get(s.signalId);
    return signal ? [{ series: s, signal }] : [];
  });
}

export function sessionTitle(session: Session): string {
  return new Date(session.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function exportFileName(session: Session, suffix: string, ext: string): string {
  const d = new Date(session.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `dipstick_${stamp}_${suffix}.${ext}`;
}

/**
 * One row per time bucket, one column per signal: the easiest shape to read
 * and to chart. A cell is the mean of that signal's readings in the bucket
 * and is left empty when there were none (nothing is interpolated).
 */
export function toWideCsv(session: Session, samples: SampleColumns, units: UnitSystem, bucketMs = 1000): string {
  const cols = known(toSeries(session, samples));
  const sums = new Map<number, { sum: number[]; n: number[] }>();
  cols.forEach(({ series }, c) => {
    for (let i = 0; i < series.t.length; i++) {
      const bucket = Math.floor(series.t[i]! / bucketMs);
      let row = sums.get(bucket);
      if (!row) sums.set(bucket, (row = { sum: cols.map(() => 0), n: cols.map(() => 0) }));
      row.sum[c]! += series.v[i]!;
      row.n[c]!++;
    }
  });
  const header = ['time_s', ...cols.map(({ signal }) => csvCell(`${signal.id} (${displayUnit(signal, units) || 'count'})`))];
  const lines = [header.join(',')];
  for (const bucket of [...sums.keys()].sort((a, b) => a - b)) {
    const row = sums.get(bucket)!;
    const cells = cols.map(({ signal }, c) =>
      row.n[c]! ? round(toDisplay(signal, row.sum[c]! / row.n[c]!, units), precision(signal)) : '',
    );
    lines.push([round((bucket * bucketMs) / 1000, 3), ...cells].join(','));
  }
  return lines.join('\n') + '\n';
}

/** Every reading exactly as taken: one row per sample, millisecond times. */
export function toLongCsv(session: Session, samples: SampleColumns, units: UnitSystem): string {
  const lines = ['time_s,signal,value,unit'];
  for (let i = 0; i < samples.t.length; i++) {
    const signal = SIGNAL_BY_ID.get(session.signalIds[samples.k[i]!] ?? '');
    if (!signal) continue;
    lines.push(
      [
        round(samples.t[i]! / 1000, 3),
        signal.id,
        round(toDisplay(signal, samples.v[i]!, units), precision(signal)),
        csvCell(displayUnit(signal, units)),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export interface SignalStats {
  signal: Signal;
  unit: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  first: number;
  last: number;
}

export function computeStats(session: Session, samples: SampleColumns, units: UnitSystem): SignalStats[] {
  return known(toSeries(session, samples)).map(({ series, signal }) => {
    const v = series.v.map((x) => toDisplay(signal, x, units));
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const x of v) {
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x;
    }
    return { signal, unit: displayUnit(signal, units), count: v.length, min, max, mean: sum / v.length, first: v[0]!, last: v[v.length - 1]! };
  });
}

function sessionHeader(session: Session) {
  return {
    app: 'Dipstick OBD2',
    recorded: new Date(session.startedAt).toISOString(),
    durationSeconds: Math.round((session.endedAt - session.startedAt) / 1000),
    demoData: session.demo,
    vehicle: session.vehicle,
    note: session.note,
    troubleCodes: session.codes && {
      checkEngineLight: session.codes.status?.mil ?? null,
      stored: session.codes.stored,
      pending: session.codes.pending,
      readinessMonitors: session.codes.status?.monitors ?? [],
    },
  };
}

/** Everything in one self-describing file. */
export function toJson(session: Session, samples: SampleColumns, units: UnitSystem): string {
  const signals = known(toSeries(session, samples)).map(({ series, signal }) => ({
    id: signal.id,
    name: signal.name,
    unit: displayUnit(signal, units),
    // [seconds since start, value] pairs
    samples: series.t.map((t, i) => [t / 1000, Number(toDisplay(signal, series.v[i]!, units).toFixed(precision(signal)))]),
  }));
  return JSON.stringify({ ...sessionHeader(session), signals }, null, 1);
}

/**
 * A short Markdown digest sized to paste straight into a chat with an AI
 * assistant: vehicle, codes, and per-signal statistics instead of raw rows.
 */
export function toSummary(session: Session, samples: SampleColumns, units: UnitSystem): string {
  const h = sessionHeader(session);
  const out: string[] = ['# OBD2 session summary', ''];
  if (session.demo) out.push('**Demo data from a simulated vehicle, not a real one.**', '');
  out.push(
    `- Recorded: ${sessionTitle(session)} (${formatDuration(session.endedAt - session.startedAt)})`,
    `- VIN: ${session.vehicle.vin ?? 'not reported'}`,
    `- Protocol: ${session.vehicle.protocolName}`,
    `- Adapter: ${session.vehicle.adapter}`,
  );
  if (session.note) out.push(`- Note: ${session.note}`);
  out.push('', '## Trouble codes', '');
  if (!h.troubleCodes) {
    out.push('Not read during this session.');
  } else {
    const c = h.troubleCodes;
    out.push(
      `- Check-engine light: ${c.checkEngineLight === null ? 'unknown' : c.checkEngineLight ? 'ON' : 'off'}`,
      `- Stored codes: ${c.stored.join(', ') || 'none'}`,
      `- Pending codes: ${c.pending.join(', ') || 'none'}`,
    );
    const incomplete = c.readinessMonitors.filter((m) => !m.complete).map((m) => m.name);
    if (c.readinessMonitors.length) out.push(`- Readiness monitors not yet complete: ${incomplete.join(', ') || 'none'}`);
  }
  out.push('', '## Live data', '', '| Signal | Unit | Min | Mean | Max | First | Last | Samples |', '|---|---|---|---|---|---|---|---|');
  for (const s of computeStats(session, samples, units)) {
    const f = (v: number) => round(v, precision(s.signal));
    out.push(`| ${s.signal.name} | ${s.unit} | ${f(s.min)} | ${f(s.mean)} | ${f(s.max)} | ${f(s.first)} | ${f(s.last)} | ${s.count} |`);
  }
  return out.join('\n') + '\n';
}
