import type { TroubleCodes } from '../obd/vehicle';

export interface VehicleInfo {
  vin: string | null;
  adapter: string;
  protocol: string;
  protocolName: string;
}

export interface Session {
  id: string;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number;
  /** True when recorded from the built-in demo vehicle, not a real one. */
  demo: boolean;
  vehicle: VehicleInfo;
  /** Signal ids, in the order used by sample chunks. */
  signalIds: string[];
  sampleCount: number;
  /** Most recent trouble-code read during the session, if any. */
  codes: TroubleCodes | null;
  note: string;
}

/**
 * Samples in column form. `k[i]` indexes into `Session.signalIds`. Values are
 * metric. Each signal is read at its own moment, so `t` is per sample.
 */
export interface SampleColumns {
  t: number[];
  k: number[];
  v: number[];
}

export interface Series {
  signalId: string;
  /** Milliseconds since session start. */
  t: number[];
  v: number[];
}

export function toSeries(session: Session, samples: SampleColumns): Series[] {
  const series: Series[] = session.signalIds.map((signalId) => ({ signalId, t: [], v: [] }));
  for (let i = 0; i < samples.t.length; i++) {
    const s = series[samples.k[i]!];
    if (!s) continue;
    s.t.push(samples.t[i]!);
    s.v.push(samples.v[i]!);
  }
  return series.filter((s) => s.t.length > 0);
}
