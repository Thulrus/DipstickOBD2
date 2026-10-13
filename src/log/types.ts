import type { ModuleScan } from '../obd/modules';
import type { VehicleScan } from '../obd/scan';
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
  /** Freeze frame, self-test results and a full snapshot, if they were read. */
  scan?: VehicleScan | null;
  /** Codes read from every module that answered (airbag, ABS...), if the user ran that scan. */
  modules?: ModuleScan | null;
  /** Codes and light status read again just before disconnecting. */
  endCodes?: TroubleCodes | null;
  /** Things the vehicle can't report that the driver noted as they happened. */
  markers?: Marker[];
  /** Typed in by the user; most vehicles don't report it. */
  odometer?: string;
  note: string;
}

export interface Marker {
  /** Milliseconds since session start. */
  t: number;
  label: string;
}

/**
 * Samples in column form. `k[i]` indexes into `Session.signalIds`. Values are
 * metric. Each signal is read at its own moment, so `t` is per sample.
 */
export interface SampleColumns {
  t: number[];
  k: number[];
  v: number[];
  /** Raw data bytes (hex) behind each value. Absent in older logs. */
  r?: string[];
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
